import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Hono } from "hono";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createSession,
  createWorkspace,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { registerSessionRoutes } from "../src/routes/sessions";

const DELEGATION_SECRET = "session-queue-delete-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
let app: Hono;
let published = 0;
let wakes = 0;

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
});

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('queue delete account') returning id`;
  const workspace = await createWorkspace(db, {
    accountId: account!.id,
    name: "queue delete workspace",
  });
  return { accountId: account!.id, workspaceId: workspace.id };
}

function workflowClient(): SessionWorkflowClient {
  const noop = async () => {};
  return {
    signalUserMessage: noop,
    wakeSessionWorkflow: async () => {
      wakes += 1;
    },
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
}

function deps(): ApiRouteDeps {
  const bus = new MemoryEventBus();
  const publish = bus.publish.bind(bus);
  bus.publish = async (...args) => {
    published += 1;
    await publish(...args);
  };
  return {
    settings,
    db,
    bus,
    workflowClient: workflowClient(),
    githubStateSecret: "x",
    objectStorage: null,
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

async function bearer(accountId: string, workspaceId: string): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId: "queue-controller",
    permissions: ["sessions:read", "sessions:control"],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

async function deletePrompt(
  workspaceId: string,
  sessionId: string,
  authorization: string,
  turnId = "00000000-0000-4000-8000-000000000001",
  expectedTurnVersion = 1,
) {
  return app.request(
    `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/queue/${turnId}/delete`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        clientEventId: "00000000-0000-4000-8000-000000000010",
        expectedTurnVersion,
      }),
    },
  );
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-queue-delete");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[session-queue-delete] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
  app = new Hono();
  registerSessionRoutes(app, deps());
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("session queue delete lookup", () => {
  test("returns 404 without side effects for missing and cross-workspace sessions", async () => {
    if (!available) return;
    const owner = await freshWorkspace();
    const other = await freshWorkspace();
    const otherSession = await createSession(db, {
      accountId: other.accountId,
      workspaceId: other.workspaceId,
      initialMessage: "tenant-isolated queue",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    const authorization = await bearer(owner.accountId, owner.workspaceId);

    for (const sessionId of ["00000000-0000-4000-8000-000000000002", otherSession.id]) {
      const response = await deletePrompt(owner.workspaceId, sessionId, authorization);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("session not found");
    }

    expect(published).toBe(0);
    expect(wakes).toBe(0);
  });

  test("a committed Delete publishes its durable queue invalidation", async () => {
    if (!available) return;
    const owner = await freshWorkspace();
    const session = await createSession(db, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      initialMessage: "queue invalidation",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    const authorization = await bearer(owner.accountId, owner.workspaceId);
    const submitted = await app.request(
      `http://x/v1/workspaces/${owner.workspaceId}/sessions/${session.id}/events`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: { text: "delete me" },
        }),
      },
    );
    expect(submitted.status).toBe(202);
    const queued = await app.request(
      `http://x/v1/workspaces/${owner.workspaceId}/sessions/${session.id}/queue`,
      { headers: { authorization } },
    );
    expect(queued.status).toBe(200);
    const snapshot = (await queued.json()) as { items: Array<{ id: string; version: number }> };
    expect(snapshot.items).toHaveLength(1);
    published = 0;
    wakes = 0;

    const deleted = await deletePrompt(
      owner.workspaceId,
      session.id,
      authorization,
      snapshot.items[0]!.id,
      snapshot.items[0]!.version,
    );
    expect(deleted.status).toBe(200);
    expect(published).toBe(1);
    expect(wakes).toBe(0);
  });
});
