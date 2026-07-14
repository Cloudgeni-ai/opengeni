import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Hono } from "hono";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createDb, createSession, type Database, type DbClient } from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { registerSessionRoutes } from "../src/routes/sessions";

const DELEGATION_SECRET = "session-queue-cancel-test-secret";
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
    insert into managed_accounts (name) values ('queue cancel account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'queue cancel workspace') returning id`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function workflowClient(): SessionWorkflowClient {
  const noop = async () => {};
  return {
    signalUserMessage: noop,
    wakeSessionWorkflow: async () => {
      wakes += 1;
    },
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
    permissions: ["sessions:control"],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

async function cancel(workspaceId: string, sessionId: string, authorization: string) {
  return app.request(
    `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/queue/00000000-0000-4000-8000-000000000001/cancel`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ expectedQueueVersion: 0, expectedItemVersion: 1 }),
    },
  );
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-queue-cancel");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[session-queue-cancel] docker unavailable, skipping");
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

describe("session queue cancellation lookup", () => {
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
      const response = await cancel(owner.workspaceId, sessionId, authorization);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("session not found");
    }

    expect(published).toBe(0);
    expect(wakes).toBe(0);
  });
});
