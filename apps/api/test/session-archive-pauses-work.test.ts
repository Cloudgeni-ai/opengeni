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
  createSessionGoal,
  createWorkspace,
  initializeSessionStartAtomically,
  migrate,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { registerSessionRoutes } from "../src/routes/sessions";

const DELEGATION_SECRET = "session-archive-pause-test-secret";
const explicitDatabaseUrl = process.env.OPENGENI_SESSION_CONTROL_TEST_DATABASE_URL;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const OWNER = "chat-owner";
const COLLEAGUE = "chat-colleague";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
let app: Hono;
let postCommitTasks: Array<() => Promise<void>> = [];

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
});

function deps(): ApiRouteDeps {
  const noop = async () => {};
  return {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "x",
    objectStorage: null,
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}) as never,
    schedulePromptPostCommit: (task: () => Promise<void>) => {
      postCommitTasks.push(task);
    },
  } as unknown as ApiRouteDeps;
}

async function flushPostCommitTasks(): Promise<void> {
  const tasks = postCommitTasks;
  postCommitTasks = [];
  await Promise.all(tasks.map(async (task) => await task()));
}

async function freshChat(
  status?: "idle",
): Promise<{ workspaceId: string; accountId: string; sessionId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('archive pause account') returning id`;
  const workspace = await createWorkspace(db, {
    accountId: account!.id,
    name: "archive pause workspace",
  });
  const session = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace.id,
    initialMessage: "keep working on this",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: OWNER },
  });
  if (status) await admin`update sessions set status = ${status} where id = ${session.id}`;
  // Creation reserves an idle shell (#4330); a chat with work has its first turn admitted.
  else
    await initializeSessionStartAtomically(db, {
      accountId: account!.id,
      workspaceId: workspace.id,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
  // Archive is personal per-member state, so both people are workspace members.
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id) values
      (${account!.id}, ${workspace.id}, ${OWNER}),
      (${account!.id}, ${workspace.id}, ${COLLEAGUE})`;
  return { workspaceId: workspace.id, accountId: account!.id, sessionId: session.id };
}

async function bearer(
  chat: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: string[] = ["sessions:read", "sessions:control"],
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: chat.accountId,
    workspaceId: chat.workspaceId,
    subjectId,
    permissions: permissions as never,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

async function archive(
  chat: { workspaceId: string; sessionId: string },
  authorization: string,
  archived = true,
) {
  const response = await app.request(
    `http://x/v1/workspaces/${chat.workspaceId}/sessions/${chat.sessionId}/archive`,
    {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    },
  );
  expect(response.status).toBe(200);
  await flushPostCommitTasks();
  return (await response.json()) as {
    archived: boolean;
    effectiveControl: { state: string; directState: string };
  };
}

async function directState(sessionId: string): Promise<string> {
  const [row] = await admin<{ direct_control_state: string }[]>`
    select direct_control_state from sessions where id = ${sessionId}`;
  return row!.direct_control_state;
}

async function pauseEvents(sessionId: string): Promise<number> {
  const [row] = await admin<{ count: number }[]>`
    select count(*)::int as count from session_events
    where session_id = ${sessionId} and type = 'session.control.paused'`;
  return row!.count;
}

beforeAll(async () => {
  if (explicitDatabaseUrl) {
    await migrate(explicitDatabaseUrl);
    admin = postgres(explicitDatabaseUrl, { max: 4 });
    client = createDb(explicitDatabaseUrl);
  } else {
    shared = await acquireSharedTestDatabase("session-archive-pause");
    if (!shared) {
      if (requireRealDatabase) {
        throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
      }
      available = false;
      // eslint-disable-next-line no-console
      console.warn("[session-archive-pause] docker unavailable, skipping");
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
  await flushPostCommitTasks();
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  if (explicitDatabaseUrl) await admin?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("archiving a chat", () => {
  test("archiving your own chat that still has work pauses it, and Resume brings it back", async () => {
    if (!available) return;
    const chat = await freshChat();
    const authorization = await bearer(chat, OWNER);

    const archived = await archive(chat, authorization);
    expect(archived.archived).toBe(true);
    expect(archived.effectiveControl).toMatchObject({ state: "paused", directState: "paused" });
    expect(await directState(chat.sessionId)).toBe("paused");

    // Unarchiving does not resume on its own; Resume is the same as after Pause.
    expect((await archive(chat, authorization, false)).effectiveControl.directState).toBe("paused");
    const resumed = await app.request(
      `http://x/v1/workspaces/${chat.workspaceId}/sessions/${chat.sessionId}/control`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", clientEventId: crypto.randomUUID() }),
      },
    );
    expect(resumed.status).toBe(200);
    expect(await directState(chat.sessionId)).toBe("active");
  });

  test("a retried archive pauses only once", async () => {
    if (!available) return;
    const chat = await freshChat();
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization);
    await archive(chat, authorization);
    expect(await pauseEvents(chat.sessionId)).toBe(1);
  });

  test("archiving a chat someone else started only hides it for you", async () => {
    if (!available) return;
    const chat = await freshChat();
    const archived = await archive(chat, await bearer(chat, COLLEAGUE));
    expect(archived.archived).toBe(true);
    expect(archived.effectiveControl.directState).toBe("active");
    expect(await directState(chat.sessionId)).toBe("active");
    expect(await pauseEvents(chat.sessionId)).toBe(0);
  });

  test("without permission to control chats, archiving only hides it", async () => {
    if (!available) return;
    const chat = await freshChat();
    await archive(chat, await bearer(chat, OWNER, ["sessions:read"]));
    expect(await directState(chat.sessionId)).toBe("active");
  });

  test("a settled chat is not paused, but an idle chat with an active goal is", async () => {
    if (!available) return;
    const settled = await freshChat("idle");
    await archive(settled, await bearer(settled, OWNER));
    expect(await directState(settled.sessionId)).toBe("active");

    const pursuing = await freshChat("idle");
    await createSessionGoal(db, {
      accountId: pursuing.accountId,
      workspaceId: pursuing.workspaceId,
      sessionId: pursuing.sessionId,
      text: "Keep improving the report",
      createdBy: "api",
    });
    await archive(pursuing, await bearer(pursuing, OWNER));
    expect(await directState(pursuing.sessionId)).toBe("paused");
  });
});
