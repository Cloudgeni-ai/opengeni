import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createAppComposition } from "../src/app";
import { startSlackInteractionPump } from "../src/integrations/slack-interactions";
import { startMemorySlackPublicationPump } from "../src/memory-slack-delivery";
import { startTemporalScheduleCleanupPump } from "../src/temporal-schedule-cleanup";
import { startWorkspaceWebhookDispatchPump } from "../src/workspace-webhook-dispatch";

// Reproduces a release-lane drain: every application backend is terminated
// (`pg_terminate_backend`, SQLSTATE 57P01) repeatedly while browser requests and
// the API's background claim loops keep using the pool.

const SECRET = "database-connection-loss-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let admin: postgres.Sql;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-database-connection-loss");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 6 });
  admin = postgres(shared.adminUrl, { max: 1, prepare: false });
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function composition() {
  const noop = async () => undefined;
  return createAppComposition({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      slackSigningSecret: "database-connection-loss-slack-secret",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
  });
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "database-connection-loss-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Database connection loss",
    workspaceExternalSource: "database-connection-loss-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Database connection loss",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const headers = {
    authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      permissions: ["sessions:read", "sessions:create", "workspace:admin"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`,
    "content-type": "application/json",
  };
  return { workspaceId, headers };
}

/** Terminate every application-role backend of this test database. */
async function terminateApplicationBackends(): Promise<number> {
  const [row] = await admin<{ terminated: number }[]>`
    select count(*)::int as terminated
    from (
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and usename = 'opengeni_app'
    ) terminated
  `;
  return row?.terminated ?? 0;
}

type ErrorBody = {
  error: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    outcomeUnknown?: boolean;
    details?: { code?: string };
  };
};

describe("database connection loss", () => {
  test("terminated backends become retryable 503s and never crash the process", async () => {
    if (!available) return;
    const value = await fixture();
    const { app, routeDeps } = composition();
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onEscape);
    process.on("uncaughtException", onEscape);
    const stops: Array<() => unknown> = [
      startSlackInteractionPump(routeDeps as ApiRouteDeps, { intervalMs: 250 }),
      startMemorySlackPublicationPump(routeDeps as ApiRouteDeps, { intervalMs: 250 }),
      startWorkspaceWebhookDispatchPump({
        db: client.db,
        settings: routeDeps.settings,
        intervalMs: 250,
      }),
      startTemporalScheduleCleanupPump({
        db: client.db,
        cleanupConnectorAuthorization: async () => undefined,
        deleteSchedule: async () => undefined,
        intervalMs: 250,
      }),
    ];
    const statuses = new Map<string, number>();
    const unavailable: Array<{ method: string; body: ErrorBody }> = [];
    const load = { running: true };
    const requester = async (index: number) => {
      while (load.running) {
        const read = index % 2 === 0;
        const response = await app.request(
          `http://x/v1/workspaces/${value.workspaceId}/${read ? "new-session-draft" : "sessions"}`,
          { headers: value.headers },
        );
        statuses.set(String(response.status), (statuses.get(String(response.status)) ?? 0) + 1);
        if (response.status === 503) {
          expect(response.headers.get("retry-after")).toBe("1");
          unavailable.push({ method: "GET", body: (await response.json()) as ErrorBody });
        } else {
          await response.arrayBuffer();
        }
      }
    };
    const writer = async () => {
      while (load.running) {
        const response = await app.request(
          `http://x/v1/workspaces/${value.workspaceId}/new-session-draft`,
          {
            method: "PUT",
            headers: value.headers,
            body: JSON.stringify({ text: `draft ${crypto.randomUUID()}` }),
          },
        );
        statuses.set(`PUT ${response.status}`, (statuses.get(`PUT ${response.status}`) ?? 0) + 1);
        if (response.status === 503) {
          unavailable.push({ method: "PUT", body: (await response.json()) as ErrorBody });
        } else {
          await response.arrayBuffer();
        }
      }
    };
    try {
      const workers = [...Array.from({ length: 6 }, (_, index) => requester(index)), writer()];
      let terminated = 0;
      for (let round = 0; round < 12; round += 1) {
        await Bun.sleep(150);
        terminated += await terminateApplicationBackends();
      }
      load.running = false;
      await Promise.all(workers);
      expect(terminated).toBeGreaterThan(0);
      // Let every pump run at least one more tick against the recovered pool.
      await Bun.sleep(600);
    } finally {
      load.running = false;
      for (const stop of stops) await stop();
      process.off("unhandledRejection", onEscape);
      process.off("uncaughtException", onEscape);
    }

    expect(escaped).toEqual([]);
    expect(statuses.get("500")).toBeUndefined();
    expect(statuses.get("PUT 500")).toBeUndefined();
    expect(unavailable.length).toBeGreaterThan(0);
    for (const { method, body } of unavailable) {
      expect(body.error).toMatchObject({
        status: 503,
        code: "upstream_unavailable",
        retryable: true,
        details: { code: "DATABASE_UNAVAILABLE" },
      });
      // A read is safe to repeat; a write may have committed before the drop.
      expect(body.error.outcomeUnknown === true).toBe(method !== "GET");
    }

    // The pool recovers on its own once the server accepts connections again.
    const recovered = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/new-session-draft`,
      { headers: value.headers },
    );
    expect(recovered.status).toBe(200);
  });
});
