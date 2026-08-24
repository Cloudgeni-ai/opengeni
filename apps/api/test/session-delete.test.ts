import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Hono } from "hono";
import {
  createDb,
  createSession,
  createWorkspace,
  getSession,
  initializeSessionStartAtomically,
  migrate,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { registerSessionRoutes } from "../src/routes/sessions";

const DELEGATION_SECRET = "session-delete-test-secret";
const explicitDatabaseUrl = process.env.OPENGENI_SESSION_DELETE_TEST_DATABASE_URL;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
let app: Hono;

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
});

function workflowClient(): SessionWorkflowClient {
  const noop = async () => {};
  return {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
}

function deps(): ApiRouteDeps {
  return {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: workflowClient(),
    githubStateSecret: "x",
    objectStorage: null,
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

async function bearer(accountId: string, workspaceId: string, permissions: string[]) {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId: "session-deleter",
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function fixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('session delete account') returning id`;
  const workspace = await createWorkspace(db, {
    accountId: account!.id,
    name: "session delete workspace",
  });
  const root = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace.id,
    initialMessage: "delete root",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId: account!.id,
    workspaceId: workspace.id,
    sessionId: root.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const child = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace.id,
    initialMessage: "delete child",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    parentSessionId: root.id,
  });
  await admin`
    update sessions
    set status = 'cancelled'
    where id in (${root.id}, ${child.id})`;
  return { accountId: account!.id, workspaceId: workspace.id, root, child };
}

beforeAll(async () => {
  if (explicitDatabaseUrl) {
    await migrate(explicitDatabaseUrl);
    admin = postgres(explicitDatabaseUrl, { max: 4 });
    client = createDb(explicitDatabaseUrl);
  } else {
    shared = await acquireSharedTestDatabase("session-delete");
    if (!shared) {
      if (requireRealDatabase) throw new Error("PostgreSQL is required for session delete tests");
      available = false;
      return;
    }
    admin = shared.admin;
    client = createDb(shared.appUrl);
  }
  db = client.db;
  app = new Hono();
  registerSessionRoutes(app, deps());
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (explicitDatabaseUrl) await admin?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("session tree deletion", () => {
  test("requires control authority and deletes a quiescent root with its descendants", async () => {
    if (!available) return;
    const value = await fixture();
    const url = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.root.id}`;

    const denied = await app.request(url, {
      method: "DELETE",
      headers: {
        authorization: await bearer(value.accountId, value.workspaceId, ["sessions:read"]),
      },
    });
    expect(denied.status).toBe(403);

    const childDelete = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.child.id}`,
      {
        method: "DELETE",
        headers: {
          authorization: await bearer(value.accountId, value.workspaceId, [
            "sessions:read",
            "sessions:control",
          ]),
        },
      },
    );
    expect(childDelete.status).toBe(409);

    const deleted = await app.request(url, {
      method: "DELETE",
      headers: {
        authorization: await bearer(value.accountId, value.workspaceId, ["sessions:control"]),
      },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deletedSessionCount: 2 });
    expect(await getSession(db, value.workspaceId, value.root.id)).toBeNull();
    expect(await getSession(db, value.workspaceId, value.child.id)).toBeNull();
  }, 180_000);

  test("background-command cancellation requires sessions:control before target lookup", async () => {
    if (!available) return;
    const value = await fixture();
    const commandId = crypto.randomUUID();
    const url = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.root.id}/background-commands/${commandId}`;

    const denied = await app.request(url, {
      method: "DELETE",
      headers: {
        authorization: await bearer(value.accountId, value.workspaceId, ["sessions:read"]),
      },
    });
    expect(denied.status).toBe(403);

    const authorizedMissing = await app.request(url, {
      method: "DELETE",
      headers: {
        authorization: await bearer(value.accountId, value.workspaceId, ["sessions:control"]),
      },
    });
    expect(authorizedMissing.status).toBe(404);
  }, 180_000);

  test("active background commands block tree deletion until terminal proof is stored", async () => {
    if (!available) return;
    const value = await fixture();
    const commandId = crypto.randomUUID();
    await admin`
      insert into session_background_commands (
        id, account_id, workspace_id, session_id, provider, state,
        control_workspace_id, enrollment_id, connection_instance_id, op_id,
        command_preview
      ) values (
        ${commandId}, ${value.accountId}, ${value.workspaceId}, ${value.root.id},
        'connected_machine', 'running', ${value.workspaceId}, ${crypto.randomUUID()},
        'session-delete-launch', 'session-delete-op', 'sleep 60'
      )`;

    const url = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.root.id}`;
    const headers = {
      authorization: await bearer(value.accountId, value.workspaceId, [
        "sessions:read",
        "sessions:control",
      ]),
    };
    const blocked = await app.request(url, { method: "DELETE", headers });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("background commands");
    expect(await getSession(db, value.workspaceId, value.root.id)).not.toBeNull();

    await admin`
      update session_background_commands set
        state = 'exited', exit_code = 0, settlement_reason = 'provider_exit',
        settled_at = now(), updated_at = now()
      where id = ${commandId}`;
    const deleted = await app.request(url, { method: "DELETE", headers });
    expect(deleted.status).toBe(200);
    expect(await getSession(db, value.workspaceId, value.root.id)).toBeNull();
  }, 180_000);

  test("refuses an active root without deleting it", async () => {
    if (!available) return;
    const value = await fixture();
    await admin`update sessions set status = 'running' where id = ${value.root.id}`;
    const response = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.root.id}`,
      {
        method: "DELETE",
        headers: {
          authorization: await bearer(value.accountId, value.workspaceId, [
            "sessions:read",
            "sessions:control",
          ]),
        },
      },
    );
    expect(response.status).toBe(409);
    expect(await getSession(db, value.workspaceId, value.root.id)).not.toBeNull();
  }, 180_000);
});
