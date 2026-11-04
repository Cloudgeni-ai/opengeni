import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  grantWorkspaceAccess,
  listSessionEntriesForSubject,
  listSessionsForSubject,
  SessionListCursorError,
  sessionLatestTurnsForSessions,
  requestSessionArchive,
  withSessionRlsActorContext,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type Workspace = { accountId: string; workspaceId: string };

async function ownerWorkspace(): Promise<{ workspace: Workspace; owner: string }> {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Session id list owner",
  });
  const grant = access.workspaceGrants.find(
    (item) => item.workspaceId === access.defaultWorkspaceId,
  )!;
  return {
    workspace: { accountId: grant.accountId, workspaceId: grant.workspaceId },
    owner: grant.subjectId,
  };
}

async function session(workspace: Workspace, message: string, privateOwner?: string) {
  const create = () =>
    createSession(db, {
      ...workspace,
      initialMessage: message,
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      ...(privateOwner
        ? {
            visibility: "user_private" as const,
            subjectId: privateOwner,
            createdBy: { kind: "subject" as const, subjectId: privateOwner },
          }
        : {}),
    });
  return privateOwner ? withSessionRlsActorContext({ subjectId: privateOwner }, create) : create();
}

async function turn(
  workspace: Workspace,
  sessionId: string,
  input: {
    status: string;
    position: number;
    startedAt?: string;
    finishedAt?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await admin`
    insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, execution_generation, position, prompt, model, reasoning_effort, latency_mode,
      sandbox_backend, source, started_at, finished_at
    ) values (
      ${id}, ${workspace.accountId}, ${workspace.workspaceId}, ${sessionId},
      ${crypto.randomUUID()}, ${`ids-${id}`}, ${input.status}, 1, ${input.position},
      'synthetic prompt', 'test-model', 'medium', 'standard', 'none', 'user',
      ${input.startedAt ?? null}, ${input.finishedAt ?? null}
    )`;
  return id;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-list-session-ids");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[session-list-session-ids] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("session list sessionIds selection (real PostgreSQL + FORCE RLS)", () => {
  test("narrows the viewer's own list and never widens it", async () => {
    if (!available) return;
    const { workspace, owner } = await ownerWorkspace();
    const viewer = `user:ids-viewer-${crypto.randomUUID()}`;
    await grantWorkspaceAccess(db, {
      ...workspace,
      subjectId: viewer,
      permissions: ["sessions:read"],
    });
    const shared1 = await session(workspace, "deploy fix for the gateway");
    const shared2 = await session(workspace, "cost review");
    const unselected = await session(workspace, "deploy fix elsewhere");
    const ownersPrivate = await session(workspace, "deploy fix in private", owner);
    const selected = [shared1.id, shared2.id, ownersPrivate.id, crypto.randomUUID()];

    const forViewer = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: viewer,
      limit: 50,
      materializeSnapshot: true,
      sessionIds: selected,
    });
    expect(forViewer.sessionIdsApplied).toBe(true);
    expect(new Set(forViewer.sessions.map((row) => row.id))).toEqual(
      new Set([shared1.id, shared2.id]),
    );

    const forOwner = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 50,
      materializeSnapshot: true,
      sessionIds: selected,
    });
    expect(new Set(forOwner.sessions.map((row) => row.id))).toEqual(
      new Set([shared1.id, shared2.id, ownersPrivate.id]),
    );
    expect(forOwner.sessions.some((row) => row.id === unselected.id)).toBe(false);

    // Search and other filters still apply within the selection.
    const searched = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 50,
      materializeSnapshot: true,
      search: "deploy",
      sessionIds: selected,
    });
    expect(new Set(searched.sessions.map((row) => row.id))).toEqual(
      new Set([shared1.id, ownersPrivate.id]),
    );

    // Pins obey the selection like ordinary rows; archived rows need archiveStatus.
    await requestSessionArchive(db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId: shared2.id,
      subjectId: owner,
    });
    const active = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 50,
      sessionIds: [shared2.id],
    });
    expect(active.sessions).toEqual([]);
    const all = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 50,
      archiveStatus: "all",
      sessionIds: [shared2.id],
    });
    expect(all.sessions.map((row) => row.id)).toEqual([shared2.id]);

    const none = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 50,
      sessionIds: [],
    });
    expect(none.sessions).toEqual([]);
    await expect(
      listSessionEntriesForSubject(db, workspace.workspaceId, {
        subjectId: owner,
        sessionIds: Array.from({ length: 201 }, () => crypto.randomUUID()),
      }),
    ).rejects.toBeInstanceOf(SessionListCursorError);

    const full = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 50,
      sessionIds: [shared1.id],
    });
    expect(full.sessionIdsApplied).toBe(true);
    expect(full.sessions.map((row) => row.id)).toEqual([shared1.id]);
  });

  test("binds continuation cursors to the selection", async () => {
    if (!available) return;
    const { workspace, owner } = await ownerWorkspace();
    const rows = [];
    for (let index = 0; index < 3; index += 1)
      rows.push(await session(workspace, `paged ${index}`));
    const selection = rows.map((row) => row.id);
    const first = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 2,
      materializeSnapshot: true,
      sessionIds: selection,
    });
    expect(first.sessions).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const { decodeSessionListCursor } = await import("../src/index");
    const cursor = decodeSessionListCursor(first.nextCursor!)!;
    const second = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 2,
      materializeSnapshot: true,
      cursor,
      sessionIds: [...selection].reverse(),
    });
    expect(new Set([...first.sessions, ...second.sessions].map((row) => row.id))).toEqual(
      new Set(selection),
    );
    await expect(
      listSessionEntriesForSubject(db, workspace.workspaceId, {
        subjectId: owner,
        limit: 2,
        materializeSnapshot: true,
        cursor,
        sessionIds: selection.slice(0, 2),
      }),
    ).rejects.toThrow();
  });

  test("summary rows carry the active turn and the latest turn in execution order", async () => {
    if (!available) return;
    const { workspace, owner } = await ownerWorkspace();
    const finishedOnly = await session(workspace, "finished");
    const running = await session(workspace, "running");
    const queuedBehind = await session(workspace, "queued behind running");
    const noTurns = await session(workspace, "no turns");

    await turn(workspace, finishedOnly.id, {
      status: "completed",
      position: 1,
      startedAt: "2026-10-01T10:00:00Z",
      finishedAt: "2026-10-01T10:05:00Z",
    });
    const lastFailed = await turn(workspace, finishedOnly.id, {
      status: "failed",
      position: 2,
      startedAt: "2026-10-01T11:00:00Z",
      finishedAt: "2026-10-01T11:01:00Z",
    });
    await turn(workspace, running.id, {
      status: "completed",
      position: 1,
      startedAt: "2026-10-01T10:00:00Z",
      finishedAt: "2026-10-01T10:05:00Z",
    });
    const current = await turn(workspace, running.id, {
      status: "running",
      position: 2,
      startedAt: "2026-10-01T12:00:00Z",
    });
    await admin`update sessions set active_turn_id = ${current} where id = ${running.id}`;
    await turn(workspace, queuedBehind.id, {
      status: "running",
      position: 1,
      startedAt: "2026-10-01T12:00:00Z",
    });
    await turn(workspace, queuedBehind.id, { status: "queued", position: 2 });
    const tail = await turn(workspace, queuedBehind.id, { status: "queued", position: 3 });

    const page = await listSessionEntriesForSubject(db, workspace.workspaceId, {
      subjectId: owner,
      limit: 50,
      sessionIds: [finishedOnly.id, running.id, queuedBehind.id, noTurns.id],
    });
    const byId = new Map(page.sessions.map((row) => [row.id, row]));
    expect(byId.get(finishedOnly.id)?.latestTurn).toEqual({
      id: lastFailed,
      status: "failed",
      startedAt: "2026-10-01T11:00:00.000Z",
      finishedAt: "2026-10-01T11:01:00.000Z",
    });
    expect(byId.get(running.id)?.latestTurn).toMatchObject({ id: current, status: "running" });
    expect(byId.get(running.id)?.activeTurnId).toBe(current);
    expect(byId.get(queuedBehind.id)?.latestTurn).toEqual({
      id: tail,
      status: "queued",
      startedAt: null,
      finishedAt: null,
    });
    expect(byId.get(noTurns.id)?.latestTurn).toBeNull();
    expect(byId.get(noTurns.id)?.activeTurnId).toBeNull();

    const direct = await sessionLatestTurnsForSessions(db, workspace.workspaceId, []);
    expect(direct.size).toBe(0);
  });
});
