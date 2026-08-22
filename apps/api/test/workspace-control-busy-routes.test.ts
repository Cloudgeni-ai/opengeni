import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createApp } from "../src/app";

const SECRET = "workspace-control-busy-route-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let admin: postgres.Sql;
let priorLockTimeoutEnv: string | undefined;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-workspace-control-busy");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  admin = postgres(shared.adminUrl, { max: 2, prepare: false });
  // Keep the request-scoped control-prefix budget short so the bounded wait
  // expires quickly; the production default is 20 s.
  priorLockTimeoutEnv = process.env.OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS;
  process.env.OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS = "300";
}, 180_000);

afterAll(async () => {
  if (priorLockTimeoutEnv === undefined) {
    delete process.env.OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS;
  } else {
    process.env.OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS = priorLockTimeoutEnv;
  }
  await admin?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

function app() {
  const noop = async () => undefined;
  return createApp({
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
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
    accountExternalSource: "workspace-control-busy-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Workspace control busy",
    workspaceExternalSource: "workspace-control-busy-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Workspace control busy",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "busy route fixture",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const headers = {
    authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      permissions: ["sessions:read", "sessions:control"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`,
    "content-type": "application/json",
  };
  return { workspaceId, session, headers };
}

/** Hold the control row exclusively from an independent superuser backend. */
async function holdControlRow(workspaceId: string) {
  const reserved = await admin.reserve();
  await reserved`begin`;
  await reserved`select 1 from workspace_inference_controls where workspace_id = ${workspaceId} for update`;
  return async () => {
    await reserved`rollback`;
    reserved.release();
  };
}

async function expectBusyEnvelope(response: Response) {
  expect(response.status).toBe(503);
  const body = (await response.json()) as {
    error: {
      status: number;
      code: string;
      message: string;
      retryable: boolean;
      outcomeUnknown?: boolean;
      details?: { code?: string; lockTimeoutMs?: number };
    };
  };
  expect(body.error).toMatchObject({
    status: 503,
    code: "upstream_unavailable",
    retryable: true,
    details: { code: "WORKSPACE_CONTROL_BUSY", lockTimeoutMs: 300 },
  });
  expect(body.error.outcomeUnknown).not.toBe(true);
  expect(body.error.message).toContain("busy");
}

describe("workspace control busy HTTP mapping", () => {
  test("POST /events user.message renders the retryable 503 envelope", async () => {
    if (!available) return;
    const value = await fixture();
    const release = await holdControlRow(value.workspaceId);
    try {
      const started = Date.now();
      const response = await app().request(
        `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.session.id}/events`,
        {
          method: "POST",
          headers: value.headers,
          body: JSON.stringify({
            type: "user.message",
            clientEventId: crypto.randomUUID(),
            payload: { text: "blocked send", resources: [] },
          }),
        },
      );
      await expectBusyEnvelope(response);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await release();
    }
    // The same request succeeds once the prefix is free: nothing was applied
    // by the refused attempt, so the retry is an ordinary Send.
    const retried = await app().request(
      `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.session.id}/events`,
      {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: { text: "retried send", resources: [] },
        }),
      },
    );
    expect(retried.status).toBe(202);
  });

  test("POST /steer renders the retryable 503 envelope", async () => {
    if (!available) return;
    const value = await fixture();
    const release = await holdControlRow(value.workspaceId);
    try {
      const response = await app().request(
        `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.session.id}/steer`,
        {
          method: "POST",
          headers: value.headers,
          body: JSON.stringify({ text: "blocked steer", clientEventId: crypto.randomUUID() }),
        },
      );
      await expectBusyEnvelope(response);
    } finally {
      await release();
    }
  });

  test("POST /control renders the retryable 503 envelope", async () => {
    if (!available) return;
    const value = await fixture();
    const release = await holdControlRow(value.workspaceId);
    try {
      const response = await app().request(
        `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.session.id}/control`,
        {
          method: "POST",
          headers: value.headers,
          body: JSON.stringify({ action: "pause", clientEventId: crypto.randomUUID() }),
        },
      );
      await expectBusyEnvelope(response);
    } finally {
      await release();
    }
  });
});
