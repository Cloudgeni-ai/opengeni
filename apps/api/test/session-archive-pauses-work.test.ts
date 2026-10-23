import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Hono } from "hono";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  createSession,
  createSessionGoal,
  setSessionArchive,
  mutateSessionControlInTransaction,
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
  options: Record<string, unknown> = { confirmPause: true },
) {
  const response = await app.request(
    `http://x/v1/workspaces/${chat.workspaceId}/sessions/${chat.sessionId}/archive`,
    {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ archived, ...options }),
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

  test("archiving a shared chat pauses it for everyone, even when a colleague started it", async () => {
    if (!available) return;
    const chat = await freshChat();
    const archived = await archive(chat, await bearer(chat, COLLEAGUE));
    expect(archived.archived).toBe(true);
    expect(archived.effectiveControl.directState).toBe("paused");
    expect(await directState(chat.sessionId)).toBe("paused");
    expect(await pauseEvents(chat.sessionId)).toBe(1);
  });

  test("without permission to control chats, archiving only hides it", async () => {
    if (!available) return;
    const chat = await freshChat();
    await archive(chat, await bearer(chat, OWNER, ["sessions:read"]), true, {
      mode: "hide_for_me",
    });
    expect(await directState(chat.sessionId)).toBe("active");
  });

  test("idle chats pause too, including active goals", async () => {
    if (!available) return;
    const settled = await freshChat("idle");
    await archive(settled, await bearer(settled, OWNER));
    expect(await directState(settled.sessionId)).toBe("paused");

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
  const rawArchive = async (
    chat: { workspaceId: string; sessionId: string },
    authorization: string,
    body: Record<string, unknown>,
  ) =>
    await app.request(
      `http://x/v1/workspaces/${chat.workspaceId}/sessions/${chat.sessionId}/archive`,
      {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  const archivedFor = async (chat: { workspaceId: string; sessionId: string }, subject = OWNER) => {
    const [row] = await admin<
      { archived: boolean }[]
    >`select archived from session_pins where workspace_id = ${chat.workspaceId} and session_id = ${chat.sessionId} and subject_id = ${subject}`;
    return row?.archived ?? false;
  };

  test("active work requires confirmation and a rejected request does not hide or pause", async () => {
    const chat = await freshChat();
    const response = await rawArchive(chat, await bearer(chat, OWNER), { archived: true });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("session_archive_confirmation_required");
    expect(await archivedFor(chat)).toBe(false);
    expect(await directState(chat.sessionId)).toBe("active");
    expect(await pauseEvents(chat.sessionId)).toBe(0);
    expect(postCommitTasks.length).toBe(0);
  });

  test("an idle chat pauses without confirmation", async () => {
    const chat = await freshChat("idle");
    await archive(chat, await bearer(chat, OWNER), true, {});
    expect(await directState(chat.sessionId)).toBe("paused");
  });

  test("read-only default archive is denied, explicit hide changes no shared control", async () => {
    const chat = await freshChat();
    const authorization = await bearer(chat, COLLEAGUE, ["sessions:read"]);
    expect(
      (await rawArchive(chat, authorization, { archived: true, confirmPause: true })).status,
    ).toBe(403);
    expect(await archivedFor(chat, COLLEAGUE)).toBe(false);
    await archive(chat, authorization, true, { mode: "hide_for_me" });
    expect(await directState(chat.sessionId)).toBe("active");
    expect(await archivedFor(chat)).toBe(false);
  });

  test("hide can upgrade to Pause, and exact intent retry cannot re-pause after Resume", async () => {
    const chat = await freshChat();
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization, true, { mode: "hide_for_me" });
    const intent = {
      clientEventId: crypto.randomUUID(),
      mode: "pause_and_archive",
      confirmPause: true,
    };
    await archive(chat, authorization, true, intent);
    expect(await directState(chat.sessionId)).toBe("paused");
    const response = await app.request(
      `http://x/v1/workspaces/${chat.workspaceId}/sessions/${chat.sessionId}/control`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", clientEventId: crypto.randomUUID() }),
      },
    );
    expect(response.status).toBe(200);
    await flushPostCommitTasks();
    await archive(chat, authorization, true, intent);
    expect(await directState(chat.sessionId)).toBe("active");
    expect(
      (
        await rawArchive(chat, authorization, {
          archived: true,
          ...intent,
          clientEventId: crypto.randomUUID(),
          expectedVersion: 0,
        })
      ).status,
    ).toBe(409);
    expect(await directState(chat.sessionId)).toBe("active");
    await archive(chat, authorization, true, { ...intent, clientEventId: crypto.randomUUID() });
    expect(await directState(chat.sessionId)).toBe("paused");
  });

  test("stale archive revision cannot pause or hide", async () => {
    const chat = await freshChat("idle");
    expect(
      (await rawArchive(chat, await bearer(chat, OWNER), { archived: true, expectedVersion: 99 }))
        .status,
    ).toBe(409);
    expect(await archivedFor(chat)).toBe(false);
    expect(await directState(chat.sessionId)).toBe("active");
  });

  test("failure after native Pause rolls back both Pause and personal archive", async () => {
    const chat = await freshChat("idle");
    await expect(
      setSessionArchive(db, {
        ...chat,
        subjectId: OWNER,
        archived: true,
        beforeArchive: async (tx) => {
          await mutateSessionControlInTransaction(tx, {
            ...chat,
            actor: { type: "human", subjectId: OWNER },
            operationKey: crypto.randomUUID(),
            action: "pause",
          });
          throw new Error("injected archive failure");
        },
      }),
    ).rejects.toThrow("injected archive failure");
    expect(await directState(chat.sessionId)).toBe("active");
    expect(await archivedFor(chat)).toBe(false);
    expect(await pauseEvents(chat.sessionId)).toBe(0);
  });

  test("concurrent retries commit one Pause and one personal archive revision", async () => {
    const chat = await freshChat("idle");
    const authorization = await bearer(chat, OWNER);
    const body = { archived: true, expectedVersion: 0, clientEventId: crypto.randomUUID() };
    const responses = await Promise.all([
      rawArchive(chat, authorization, body),
      rawArchive(chat, authorization, body),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await flushPostCommitTasks();
    expect(await pauseEvents(chat.sessionId)).toBe(1);
    const [row] = await admin<
      { archive_version: number }[]
    >`select archive_version from session_pins where session_id = ${chat.sessionId} and subject_id = ${OWNER}`;
    expect(row?.archive_version).toBe(1);
  });

  test("a resumed descendant of a paused parent still requires archive confirmation", async () => {
    const chat = await freshChat("idle");
    const child = await createSession(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      parentSessionId: chat.sessionId,
      createdBy: { kind: "subject", subjectId: OWNER },
    });
    const authorization = await bearer(chat, OWNER);
    const control = async (id: string, action: "pause" | "resume") => {
      const response = await app.request(
        `http://x/v1/workspaces/${chat.workspaceId}/sessions/${id}/control`,
        {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ action, clientEventId: crypto.randomUUID() }),
        },
      );
      expect(response.status).toBe(200);
      await flushPostCommitTasks();
    };
    await control(chat.sessionId, "pause");
    await control(child.id, "resume");
    await initializeSessionStartAtomically(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      sessionId: child.id,
      reasoningEffortFallback: "medium",
      latencyModeFallback: "standard",
    });
    expect(await directState(chat.sessionId)).toBe("paused");
    const response = await rawArchive(chat, authorization, { archived: true });
    expect(response.status).toBe(409);
    expect(await archivedFor(chat)).toBe(false);
    await archive(chat, authorization);
    expect(await archivedFor(chat)).toBe(true);
  });

  for (const initialState of ["running", "stopping"])
    test(`a ${initialState} background command in an idle chat requires confirmation and is cancelled by Pause`, async () => {
      const chat = await freshChat("idle");
      await admin`insert into session_background_commands (account_id, workspace_id, session_id, provider, state, control_workspace_id, enrollment_id, connection_instance_id, op_id, cancel_requested_at, cancel_requested_by)
      values (${chat.accountId}, ${chat.workspaceId}, ${chat.sessionId}, 'connected_machine', ${initialState}, ${chat.workspaceId}, ${crypto.randomUUID()}, 'archive-fixture', ${crypto.randomUUID()}, ${initialState === "stopping" ? new Date() : null}, ${initialState === "stopping" ? OWNER : null})`;
      const authorization = await bearer(chat, OWNER);
      expect((await rawArchive(chat, authorization, { archived: true })).status).toBe(409);
      expect(await archivedFor(chat)).toBe(false);
      await archive(chat, authorization);
      const [command] = await admin<
        { state: string; cancel_requested_at: Date | null }[]
      >`select state, cancel_requested_at from session_background_commands where session_id = ${chat.sessionId}`;
      expect(command?.state).toBe("stopping");
      expect(command?.cancel_requested_at).not.toBeNull();
    });
});
