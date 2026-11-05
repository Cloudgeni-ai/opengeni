import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Hono } from "hono";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  createEventSource,
  createScheduledTask,
  createSession,
  createSessionGoal,
  deleteScheduledTask,
  setScheduledTaskEvents,
  createWorkspace,
  initializeSessionStartAtomically,
  migrate,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { signDelegatedAccessToken, type ScheduledTaskScheduleSpec } from "@opengeni/contracts";
import {
  stopArchivedSessionWork,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { registerSessionRoutes } from "../src/routes/sessions";

const DELEGATION_SECRET = "session-archive-action-test-secret";
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
type ScheduledArchive = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  subjectId: string;
  archivedAt: string;
  runAt: Date;
};
let scheduledArchives: ScheduledArchive[] = [];
type ScheduledRestore = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  requestedAt: string;
};
let scheduledRestores: ScheduledRestore[] = [];
const bus = new MemoryEventBus();

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
});

function deps(): ApiRouteDeps {
  const noop = async () => {};
  return {
    settings,
    db,
    bus,
    workflowClient: {
      scheduleSessionArchive: async (input: ScheduledArchive) => {
        scheduledArchives.push(input);
      },
      scheduleSessionArchiveRestore: async (input: ScheduledRestore) => {
        scheduledRestores.push(input);
      },
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
  // Both people are workspace members; either can archive the shared chat.
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

async function archiveRequest(
  chat: { workspaceId: string; sessionId: string },
  authorization: string,
  body: Record<string, unknown>,
) {
  const response = await app.request(
    `http://x/v1/workspaces/${chat.workspaceId}/sessions/${chat.sessionId}/archive`,
    {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await flushPostCommitTasks();
  return response;
}

async function archive(
  chat: { workspaceId: string; sessionId: string },
  authorization: string,
  archived = true,
) {
  const response = await archiveRequest(chat, authorization, { archived });
  expect(response.status).toBe(200);
  return (await response.json()) as { archived: boolean };
}

async function archivedAt(sessionId: string): Promise<Date | null> {
  const [row] = await admin<{ archived_at: Date | null }[]>`
    select archived_at from sessions where id = ${sessionId}`;
  return row!.archived_at;
}

/** The step a person's Archive schedules for the end of its undo window. */
async function runScheduledStep(sessionId: string) {
  const step = scheduledArchives.findLast((entry) => entry.sessionId === sessionId);
  if (!step) throw new Error("no archive step was scheduled");
  const { runAt: _runAt, ...input } = step;
  return await stopArchivedSessionWork(
    {
      db,
      bus,
      workflowClient: {
        requestSessionWorkflowWakeDispatch: async () => undefined,
        wakeSessionWorkflow: async () => undefined,
      },
      schedulePromptPostCommit: (task: () => Promise<void>) => {
        postCommitTasks.push(task);
      },
    } as never,
    input,
  );
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
    shared = await acquireSharedTestDatabase("session-archive-action");
    if (!shared) {
      if (requireRealDatabase) {
        throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
      }
      available = false;
      // eslint-disable-next-line no-console
      console.warn("[session-archive-action] docker unavailable, skipping");
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
  test("Archive takes the chat out of everyone's list and schedules storing for after Undo", async () => {
    if (!available) return;
    const chat = await freshChat();
    scheduledArchives = [];
    const archived = await archive(chat, await bearer(chat, OWNER));
    expect(archived.archived).toBe(true);
    const at = await archivedAt(chat.sessionId);
    expect(at).not.toBeNull();
    expect(scheduledArchives).toHaveLength(1);
    expect(scheduledArchives[0]).toMatchObject({ sessionId: chat.sessionId, subjectId: OWNER });
    // Storing waits until Undo is no longer accepted (the window plus grace).
    expect(scheduledArchives[0]!.runAt.getTime() - at!.getTime()).toBe(13_000);
    // Nothing stops during the undo window, so Undo can return it as it was.
    expect(await directState(chat.sessionId)).toBe("active");
    expect(await pauseEvents(chat.sessionId)).toBe(0);
  });

  test("the Archived view lists archived chats newest archive first", async () => {
    if (!available) return;
    const chat = await freshChat();
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization);
    const response = await app.request(
      `http://x/v1/workspaces/${chat.workspaceId}/sessions?view=page&projection=summary&archiveStatus=archived&sortBy=archivedAt`,
      { headers: { authorization } },
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      sortBy: string;
      archiveStatus: string;
      sessions: Array<{ id: string }>;
    };
    expect(page.sortBy).toBe("archivedAt");
    expect(page.archiveStatus).toBe("archived");
    expect(page.sessions.map((row) => row.id)).toContain(chat.sessionId);
    // Active chats have no archive date to sort by.
    const active = await app.request(
      `http://x/v1/workspaces/${chat.workspaceId}/sessions?view=page&sortBy=archivedAt`,
      { headers: { authorization } },
    );
    expect(active.status).toBe(400);
  });

  test("a colleague who can control chats archives a shared chat; without control it is refused", async () => {
    if (!available) return;
    const chat = await freshChat("idle");
    const refused = await archiveRequest(chat, await bearer(chat, COLLEAGUE, ["sessions:read"]), {
      archived: true,
      mode: "hide_for_me",
    });
    expect(refused.status).toBe(403);
    expect(await archivedAt(chat.sessionId)).toBeNull();
    expect((await archive(chat, await bearer(chat, COLLEAGUE))).archived).toBe(true);
  });

  test("Undo within the window returns the chat as it was, and the scheduled step does nothing", async () => {
    if (!available) return;
    const chat = await freshChat();
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization);
    expect((await archive(chat, authorization, false)).archived).toBe(false);
    expect(await archivedAt(chat.sessionId)).toBeNull();
    expect(await runScheduledStep(chat.sessionId)).toEqual({ pending: false });
    expect(await directState(chat.sessionId)).toBe("active");
    expect(await pauseEvents(chat.sessionId)).toBe(0);
  });

  test("Unarchive after the window brings back a chat that was not stored yet", async () => {
    if (!available) return;
    const chat = await freshChat("idle");
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization);
    await admin`update sessions set archived_at = archived_at - interval '1 minute' where id = ${chat.sessionId}`;
    scheduledRestores = [];
    const restored = await archive(chat, authorization, false);
    expect(restored.archived).toBe(false);
    expect(await archivedAt(chat.sessionId)).toBeNull();
    // Nothing was in long-term storage, so there is nothing to put back.
    expect(scheduledRestores).toHaveLength(0);
  });

  test("repeating an Archive, with older clients' fields, changes nothing", async () => {
    if (!available) return;
    const chat = await freshChat("idle");
    scheduledArchives = [];
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization);
    const first = await archivedAt(chat.sessionId);
    const again = await archiveRequest(chat, authorization, {
      archived: true,
      mode: "pause_and_archive",
      confirmPause: true,
      expectedVersion: 7,
      clientEventId: "older-client",
    });
    expect(again.status).toBe(200);
    expect(await archivedAt(chat.sessionId)).toEqual(first);
    expect(scheduledArchives).toHaveLength(1);
  });

  test("keep-live refuses Archive and says what to change", async () => {
    if (!available) return;
    const chat = await freshChat("idle");
    await admin`update sessions set keep_live = true where id = ${chat.sessionId}`;
    const response = await archiveRequest(chat, await bearer(chat, OWNER), { archived: true });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; message: string; blockers: unknown };
    expect(body.code).toBe("session_archive_blocked");
    expect(body.message).toContain("Keep this chat active");
    expect(body.blockers).toEqual([{ kind: "keep_live", sessionId: chat.sessionId }]);
    expect(await archivedAt(chat.sessionId)).toBeNull();
  });

  test("when the window ends, the chat's goal pauses and its work stops", async () => {
    if (!available) return;
    const chat = await freshChat();
    await createSessionGoal(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      sessionId: chat.sessionId,
      text: "Keep improving the report",
      createdBy: "api",
    });
    await archive(chat, await bearer(chat, OWNER));
    expect(await runScheduledStep(chat.sessionId)).toEqual({ pending: true });
    await flushPostCommitTasks();
    const [goal] = await admin<{ status: string }[]>`
      select status from session_goals where session_id = ${chat.sessionId}`;
    expect(goal!.status).toBe("paused");
    const [active] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_turns where session_id = ${chat.sessionId}
        and status in ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')`;
    expect(active!.count).toBe(0);
  });
});

describe("archiving a chat whose sub-chats are in use", () => {
  async function subChat(
    chat: { accountId: string; workspaceId: string; sessionId: string },
    title: string,
  ) {
    const session = await createSession(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      initialMessage: title,
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      parentSessionId: chat.sessionId,
      createdBy: { kind: "subject", subjectId: OWNER },
    });
    await admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set title = ${title}, title_source = 'user', status = 'idle'
        where id = ${session.id}`;
    });
    return session.id;
  }

  /** A finished turn in the sub-chat: sent by an agent, or by a person in the web app. */
  async function finishedTurn(
    chat: { accountId: string; workspaceId: string },
    sessionId: string,
    from: "agent" | "person",
  ) {
    await initializeSessionStartAtomically(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      sessionId,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    await admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update session_turns set status = 'completed', initiator_kind = 'subject',
          initiator_subject_id = ${OWNER}, source = 'user',
          surface = ${from === "agent" ? "agent" : "web"}
        where session_id = ${sessionId}`;
      await sql`update sessions set status = 'idle', active_turn_id = null where id = ${sessionId}`;
    });
  }

  test("Archive names the sub-chats in use and archives them only once they are confirmed", async () => {
    if (!available) return;
    const chat = await freshChat("idle");
    const owner = await subChat(chat, "Long-running owner");
    const working = await subChat(chat, "Worker with a goal");
    const finished = await subChat(chat, "Finished worker");
    await finishedTurn(chat, owner, "person");
    await finishedTurn(chat, finished, "agent");
    await createSessionGoal(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      sessionId: working,
      text: "Keep going",
      createdBy: "api",
    });
    const authorization = await bearer(chat, OWNER);
    scheduledArchives = [];

    const refused = await archiveRequest(chat, authorization, { archived: true });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      code: string;
      message: string;
      blockers: Array<Record<string, unknown>>;
    };
    expect(body.code).toBe("session_archive_blocked");
    expect(body.blockers).toEqual([
      {
        kind: "active_sub_chat",
        sessionId: owner,
        title: "Long-running owner",
        reason: "messaged",
      },
      { kind: "active_sub_chat", sessionId: working, title: "Worker with a goal", reason: "goal" },
    ]);
    expect(body.message).toContain("2 sub-chats are still in use");
    expect(body.message).toContain(`"Long-running owner" (${owner}`);
    expect(body.message).toContain(`"Worker with a goal" (${working}`);
    expect(body.message).toContain("confirmActiveSubChats");
    expect(body.message).not.toContain(finished);
    expect(await archivedAt(chat.sessionId)).toBeNull();
    expect(scheduledArchives).toHaveLength(0);

    // Confirming only one of them is not enough: both are named again.
    const partly = await archiveRequest(chat, authorization, {
      archived: true,
      confirmActiveSubChats: [owner],
    });
    expect(partly.status).toBe(409);
    expect(((await partly.json()) as { blockers: unknown[] }).blockers).toHaveLength(2);
    expect(await archivedAt(owner)).toBeNull();

    const confirmed = await archiveRequest(chat, authorization, {
      archived: true,
      confirmActiveSubChats: [owner, working],
    });
    expect(confirmed.status).toBe(200);
    const at = await archivedAt(chat.sessionId);
    expect(at).not.toBeNull();
    for (const id of [owner, working, finished]) expect(await archivedAt(id)).toEqual(at);
    expect(scheduledArchives).toHaveLength(1);
  });

  test("finished sub-chats an agent ran do not hold Archive back", async () => {
    if (!available) return;
    const chat = await freshChat("idle");
    const worker = await subChat(chat, "Done");
    await finishedTurn(chat, worker, "agent");
    const archived = await archive(chat, await bearer(chat, OWNER));
    expect(archived.archived).toBe(true);
    expect(await archivedAt(worker)).not.toBeNull();
  });

  test("a running sub-chat holds Archive back", async () => {
    if (!available) return;
    const chat = await freshChat("idle");
    const worker = await subChat(chat, "Still running");
    await initializeSessionStartAtomically(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      sessionId: worker,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    const response = await archiveRequest(chat, await bearer(chat, OWNER), { archived: true });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { message: string; blockers: unknown };
    expect(body.blockers).toEqual([
      { kind: "active_sub_chat", sessionId: worker, title: "Still running", reason: "running" },
    ]);
    expect(body.message).toContain("1 sub-chat is still in use");
  });
});

describe("restoring a chat whose work its Archive stopped", () => {
  async function sendMessage(
    chat: { workspaceId: string },
    sessionId: string,
    authorization: string,
    text: string,
  ) {
    const response = await app.request(
      `http://x/v1/workspaces/${chat.workspaceId}/sessions/${sessionId}/events`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: { text },
        }),
      },
    );
    await flushPostCommitTasks();
    return response;
  }

  async function sessionState(sessionId: string) {
    const [row] = await admin<{ status: string; direct_control_state: string }[]>`
      select status, direct_control_state from sessions where id = ${sessionId}`;
    return row!;
  }

  test("a chat that was busy when archived takes new messages again once restored", async () => {
    if (!available) return;
    const chat = await freshChat();
    const child = await createSession(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      initialMessage: "sub-chat",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      parentSessionId: chat.sessionId,
      createdBy: { kind: "subject", subjectId: OWNER },
    });
    await admin`update sessions set status = 'idle' where id = ${child.id}`;
    // A model this deployment serves, so new messages are admitted.
    await admin`update sessions set model = ${settings.openaiModel}
      where root_session_id = ${chat.sessionId}`;
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization);
    // The undo window ends: the chat's running work is stopped, which leaves
    // it and its sub-chat cancelled and paused.
    expect(await runScheduledStep(chat.sessionId)).toEqual({ pending: true });
    await flushPostCommitTasks();
    expect(await sessionState(chat.sessionId)).toEqual({
      status: "cancelled",
      direct_control_state: "paused",
    });
    expect((await sessionState(child.id)).status).toBe("cancelled");
    const [stopped] = await admin<{ id: string; status: string }[]>`
      select id, status from session_turns where session_id = ${chat.sessionId}`;
    expect(stopped!.status).toBe("cancelled");

    await admin`update sessions set archived_at = archived_at - interval '1 minute'
      where root_session_id = ${chat.sessionId}`;
    const restored = await archive(chat, authorization, false);
    expect(restored.archived).toBe(false);
    await flushPostCommitTasks();
    // Both are idle again; the chat is resumed, which lifts the pause on its
    // sub-chat too (sending to it below proves that).
    expect(await sessionState(chat.sessionId)).toEqual({
      status: "idle",
      direct_control_state: "active",
    });
    expect((await sessionState(child.id)).status).toBe("idle");
    // The cut-off turn stays as it ended (it reads as interrupted), and the
    // chat records that it is idle again.
    const [cutOff] = await admin<{ status: string }[]>`
      select status from session_turns where id = ${stopped!.id}`;
    expect(cutOff!.status).toBe("cancelled");
    const [latest] = await admin<{ payload: { status: string; reason: string } }[]>`
      select payload from session_events
      where session_id = ${chat.sessionId} and type = 'session.status.changed'
      order by sequence desc limit 1`;
    expect(latest!.payload).toMatchObject({ status: "idle", reason: "restored" });

    // Both take a new message, and it is admitted to run.
    for (const id of [chat.sessionId, child.id]) {
      const sent = await sendMessage(chat, id, authorization, "carry on");
      expect(sent.status).toBe(202);
      const [admitted] = await admin<{ count: number }[]>`
        select count(*)::int as count from session_turns
        where session_id = ${id} and status in ('queued', 'running')`;
      expect(admitted!.count).toBe(1);
      expect((await sessionState(id)).status).not.toBe("cancelled");
    }

    // Restoring again changes nothing.
    const again = await archiveRequest(chat, authorization, { archived: false });
    expect(again.status).toBe(200);
    const [resumes] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events
      where session_id = ${chat.sessionId} and type = 'session.control.resumed'`;
    expect(resumes!.count).toBe(1);
  });

  test("a chat cancelled before it was archived stays cancelled when restored", async () => {
    if (!available) return;
    const chat = await freshChat();
    const authorization = await bearer(chat, OWNER);
    const cancelled = await app.request(
      `http://x/v1/workspaces/${chat.workspaceId}/sessions/${chat.sessionId}/control`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", clientEventId: crypto.randomUUID() }),
      },
    );
    expect(cancelled.status).toBe(200);
    await flushPostCommitTasks();
    await archive(chat, authorization);
    await runScheduledStep(chat.sessionId);
    await flushPostCommitTasks();
    await admin`update sessions set archived_at = archived_at - interval '1 minute'
      where id = ${chat.sessionId}`;
    expect((await archive(chat, authorization, false)).archived).toBe(false);
    await flushPostCommitTasks();
    expect((await sessionState(chat.sessionId)).status).toBe("cancelled");
  });

  test("restoring while the stopped work is still settling asks to try again", async () => {
    if (!available) return;
    const chat = await freshChat();
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization);
    await runScheduledStep(chat.sessionId);
    await flushPostCommitTasks();
    // As while a running turn is still being stopped.
    const [turn] = await admin<{ id: string }[]>`
      select id from session_turns where session_id = ${chat.sessionId}`;
    await admin`update sessions set active_turn_id = ${turn!.id} where id = ${chat.sessionId}`;
    await admin`update sessions set archived_at = archived_at - interval '1 minute'
      where id = ${chat.sessionId}`;
    const busy = await archiveRequest(chat, authorization, { archived: false });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "session_archive_busy" });
    expect(await archivedAt(chat.sessionId)).not.toBeNull();
  });
});

describe("restoring an archived chat after its content was stored", () => {
  /** What the archiver leaves once a chat's content is in long-term storage. */
  async function markStored(sessionId: string, state: "archiving" | "archived" = "archived") {
    await admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set content_archive_state = ${state},
          content_archive_started_at = now(),
          content_archived_at = ${state === "archived" ? sql`now()` : null},
          content_archive = ${sql.json({ sha256: "0".repeat(64) })}
        where id = ${sessionId}`;
    });
  }

  async function archivedTree() {
    const chat = await freshChat("idle");
    const child = await createSession(db, {
      accountId: chat.accountId,
      workspaceId: chat.workspaceId,
      initialMessage: "sub-chat",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      parentSessionId: chat.sessionId,
      createdBy: { kind: "subject", subjectId: OWNER },
    });
    await admin`update sessions set status = 'idle' where id = ${child.id}`;
    const authorization = await bearer(chat, OWNER);
    await archive(chat, authorization);
    await admin`update sessions set archived_at = archived_at - interval '1 hour'
      where root_session_id = ${chat.sessionId}`;
    return { chat, childId: child.id, authorization };
  }

  test("Unarchive makes the chat live and schedules its stored content to be restored", async () => {
    if (!available) return;
    const { chat, childId, authorization } = await archivedTree();
    await markStored(chat.sessionId);
    await markStored(childId);
    scheduledRestores = [];
    const response = await archiveRequest(chat, authorization, { archived: false });
    expect(response.status).toBe(200);
    const session = (await response.json()) as {
      retention: { archive: { state: string; restoring?: true } | null };
    };
    // Still read-only until the content is back, and it says so.
    expect(session.retention.archive).toMatchObject({ state: "archived", restoring: true });
    expect(scheduledRestores).toEqual([
      expect.objectContaining({ workspaceId: chat.workspaceId, sessionId: chat.sessionId }),
    ]);
    const rows = await admin<{ id: string; content_restore_requested_at: Date | null }[]>`
      select id, content_restore_requested_at from sessions where root_session_id = ${chat.sessionId}`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.content_restore_requested_at).not.toBeNull();
  });

  test("a sub-chat is restored with its chat, and storing in progress asks to try again", async () => {
    if (!available) return;
    const { chat, childId, authorization } = await archivedTree();
    await markStored(childId);
    const viaChild = await archiveRequest(
      { workspaceId: chat.workspaceId, sessionId: childId },
      authorization,
      { archived: false },
    );
    expect(viaChild.status).toBe(409);
    expect(await viaChild.json()).toMatchObject({
      code: "session_archive_restore_root",
      rootSessionId: chat.sessionId,
    });

    await markStored(chat.sessionId, "archiving");
    const busy = await archiveRequest(chat, authorization, { archived: false });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "session_archive_busy" });
    const [child] = await admin<{ content_restore_requested_at: Date | null }[]>`
      select content_restore_requested_at from sessions where id = ${childId}`;
    expect(child!.content_restore_requested_at).toBeNull();
  });
});

describe("archiving a chat with automations", () => {
  async function waitsFixture() {
    const chat = await freshChat("idle");
    const space = { accountId: chat.accountId, workspaceId: chat.workspaceId };
    const chatIn = async (parentSessionId?: string) =>
      await createSession(db, {
        ...space,
        initialMessage: "another chat",
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        ...(parentSessionId ? { parentSessionId } : {}),
        createdBy: { kind: "subject", subjectId: OWNER },
      });
    const subChat = await chatIn(chat.sessionId);
    const otherChat = await chatIn();
    const { source } = await createEventSource(db, {
      ...space,
      createdBySubjectId: OWNER,
      kind: "webhook",
      adapter: "standard",
      name: "Deploys",
      ownerSubjectId: OWNER,
      visibility: "workspace",
      secretEncrypted: "encrypted-secret",
    });
    const automation = async (
      name: string,
      input: {
        target: string;
        schedule?: ScheduledTaskScheduleSpec;
        once?: boolean;
        owner?: string;
        visibility?: "user_private" | "workspace_shared";
      },
    ) => {
      const task = await createScheduledTask(db, {
        ...space,
        name,
        status: "active",
        schedule: input.schedule ?? { type: "manual" },
        temporalScheduleId: crypto.randomUUID(),
        runMode: "existing_session",
        overlapPolicy: "skip",
        targetSessionId: input.target,
        agentConfig: { prompt: name, resources: [], tools: [], metadata: {} },
        createdBy: { kind: "subject", subjectId: input.owner ?? OWNER },
        visibility: input.visibility ?? "workspace_shared",
        metadata: {},
      });
      if (input.once !== undefined) {
        await setScheduledTaskEvents(db, {
          ...space,
          taskId: task.id,
          triggers: [
            {
              sourceId: source.id,
              eventTypes: ["deploy.finished"],
              conditions: [],
              includeOwnEvents: false,
            },
          ],
          once: input.once,
        });
      }
      return task.id;
    };
    const hourFromNow = new Date(Date.now() + 3_600_000).toISOString();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const retired = {
      wakeOnEvent: await automation("Wake me when it deploys", {
        target: chat.sessionId,
        once: true,
      }),
      colleaguesPrivateWait: await automation("Tell me when it deploys", {
        target: chat.sessionId,
        once: true,
        owner: COLLEAGUE,
        visibility: "user_private",
      }),
      subChatWait: await automation("Sub-chat waits for the deploy", {
        target: subChat.id,
        once: true,
      }),
      wakeAtTime: await automation("Check back in an hour", {
        target: chat.sessionId,
        schedule: { type: "once", runAt: hourFromNow, timeZone: "UTC" },
      }),
    };
    const kept = {
      everyDeploy: await automation("After every deploy", {
        target: chat.sessionId,
        once: false,
      }),
      daily: await automation("Every morning", {
        target: chat.sessionId,
        schedule: { type: "calendar", hour: 9, minute: 0, timeZone: "UTC" },
      }),
      alreadyRan: await automation("Woke me already", { target: chat.sessionId, once: true }),
      pastOneTimeRun: await automation("Checked back already", {
        target: chat.sessionId,
        schedule: { type: "once", runAt: hourAgo, timeZone: "UTC" },
      }),
      otherChatWait: await automation("Another chat's wait", {
        target: otherChat.id,
        once: true,
      }),
    };
    await admin`update scheduled_task_event_settings set completed_at = now() where task_id = ${kept.alreadyRan}`;
    return { chat, retired, kept };
  }

  const liveAutomations = async (workspaceId: string) =>
    new Set(
      (
        await admin<{ id: string }[]>`
          select id from scheduled_tasks where workspace_id = ${workspaceId} and deleted_at is null`
      ).map((row) => row.id),
    );

  test("a repeating automation refuses the archive and retires nothing", async () => {
    if (!available) return;
    const { chat, retired, kept } = await waitsFixture();
    const everything = new Set([...Object.values(retired), ...Object.values(kept)]);
    const response = await archiveRequest(chat, await bearer(chat, OWNER), { archived: true });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; blockers: unknown };
    expect(body.code).toBe("session_archive_blocked");
    expect(body.blockers).toEqual([{ kind: "scheduled_task", sessionId: chat.sessionId }]);
    expect(await archivedAt(chat.sessionId)).toBeNull();
    expect(await liveAutomations(chat.workspaceId)).toEqual(everything);
  });

  test("one-time automations on the chat and its sub-chats are retired when the window ends", async () => {
    if (!available) return;
    const { chat, retired, kept } = await waitsFixture();
    for (const id of [kept.everyDeploy, kept.daily]) {
      await deleteScheduledTask(db, chat.workspaceId, id);
    }
    await archive(chat, await bearer(chat, COLLEAGUE));
    // Undo is still possible: nothing is retired yet.
    expect((await liveAutomations(chat.workspaceId)).has(retired.wakeOnEvent)).toBe(true);

    await runScheduledStep(chat.sessionId);
    // Waits still ahead and one-time runs that already happened alike.
    expect(await liveAutomations(chat.workspaceId)).toEqual(new Set([kept.otherChatWait]));
    const oneTime = [...Object.values(retired), kept.alreadyRan, kept.pastOneTimeRun];
    const tombstones = await admin<{ status: string; reusable_session_id: null }[]>`
      select status, reusable_session_id from scheduled_tasks where id in ${admin(oneTime)}`;
    expect(tombstones).toHaveLength(6);
    for (const row of tombstones) {
      expect(row).toMatchObject({ status: "paused", reusable_session_id: null });
    }
    const [outbox] = await admin<{ count: number }[]>`
      select count(*)::int as count from temporal_schedule_cleanup_outbox
      where temporal_schedule_id in (
        select temporal_schedule_id from scheduled_tasks where id in ${admin(oneTime)}
      )`;
    expect(outbox!.count).toBe(6);
  });
});
