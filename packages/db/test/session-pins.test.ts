import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  decodeSessionListCursor,
  getSessionForSubject,
  getWorkspaceGrant,
  grantWorkspaceAccess,
  listSessionsForSubject,
  removeWorkspaceMember,
  reapExpiredSessionListSnapshots,
  sessionAuthorizationScopeFilter,
  sessionTreeStatsForSessions,
  SessionListAccessError,
  SessionListCursorError,
  SessionListCursorExpiredError,
  SessionPinAccessError,
  SessionPinVersionConflictError,
  SessionAttentionVersionConflictError,
  SessionArchiveVersionConflictError,
  setSessionArchive,
  setSessionAttention,
  setSessionPin,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type Database,
  type DbClient,
} from "../src/index";
import { sql, type SQL } from "drizzle-orm";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function freshWorkspace(
  workspaceSettings: Parameters<typeof admin.json>[0] = {},
): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('session-pins-account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name, settings)
    values (${account!.id}, 'session-pins-workspace', ${admin.json(workspaceSettings)}) returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function session(input: {
  accountId: string;
  workspaceId: string;
  message: string;
  parentSessionId?: string;
}) {
  return await createSession(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: input.message,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  });
}

/** Removal now requires an explicit administering actor (migration 0278). */
async function removeMemberAsAdmin(
  handle: Database,
  workspace: { accountId: string; workspaceId: string },
  targetSubjectId: string,
): Promise<boolean> {
  const actorSubjectId = `user:remover-${crypto.randomUUID()}`;
  await grantWorkspaceAccess(handle, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: actorSubjectId,
    permissions: ["workspace:admin"],
  });
  return await removeWorkspaceMember(handle, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    actorSubjectId,
    targetSubjectId,
  });
}

async function grantMember(
  workspace: { accountId: string; workspaceId: string },
  subjectId: string,
): Promise<void> {
  await grantWorkspaceAccess(db, {
    ...workspace,
    subjectId,
    permissions: ["sessions:read"],
  });
}

async function executeSessionActivity(workspaceId: string, statement: SQL): Promise<void> {
  await withWorkspaceSessionActivityRls(db, workspaceId, async (scoped) => {
    await scoped.execute(statement);
  });
}

async function waitForAdvisoryWait(
  connection: postgres.Sql,
  classId: number,
  objectId: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_locks
        where locktype = 'advisory'
          and classid = ${classId}
          and objid = ${objectId}
          and not granted
      ) as waiting`;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for advisory lock ${classId}/${objectId}`);
}

async function waitForDatabaseQueryWait(
  connection: postgres.Sql,
  queryFragment: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query like ${`%${queryFragment}%`}
      ) as waiting`;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for database query containing ${queryFragment}`);
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-pins");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[session-pins] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[session-pins] docker unavailable, skipping");
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

describe("session pins (real PostgreSQL + FORCE RLS)", () => {
  test("rejects an unbounded host authorization scope before issuing SQL", () => {
    expect(() =>
      sessionAuthorizationScopeFilter({
        kind: "scoped",
        rootSessionIds: Array.from({ length: 10_001 }, () => crypto.randomUUID()),
        sessionIds: [],
      }),
    ).toThrow("Session authorization scope exceeds 10000 ids per field");
  });

  test("rejects an unbounded tree-stat root set before issuing SQL", async () => {
    const rootIds = Array.from({ length: 601 }, () => crypto.randomUUID());
    await expect(
      sessionTreeStatsForSessions({} as Database, crypto.randomUUID(), rootIds),
    ).rejects.toThrow("Session tree stats projection exceeds 600 roots");
  });

  test("lists server-authoritative descendant summaries for roots and lazy child pages", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:tree-stats";
    await grantMember(workspace, subjectId);
    const root = await session({ ...workspace, message: "root" });
    const child = await session({
      ...workspace,
      message: "child",
      parentSessionId: root.id,
    });
    const grandchild = await session({
      ...workspace,
      message: "grandchild",
      parentSessionId: child.id,
    });
    await session({ ...workspace, message: "unrelated root" });
    await executeSessionActivity(
      workspace.workspaceId,
      sql`
      update sessions
      set status = case
        when id = ${child.id} then 'running'
        when id = ${grandchild.id} then 'requires_action'
        else status
      end,
      updated_at = now()
      where id in (${child.id}, ${grandchild.id})`,
    );
    // The grandchild's one open requires_action turn (the database allows a
    // single current inference turn per session) entered that state ten
    // hours ago; that moment is the descendant wait the parent surfaces.
    const waitingSince = new Date(Date.now() - 10 * 3_600_000);
    waitingSince.setMilliseconds(0);
    const waitingTurnId = crypto.randomUUID();
    await executeSessionActivity(
      workspace.workspaceId,
      sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, resources, tools, metadata,
        execution_generation, updated_at
      ) values (
        ${waitingTurnId}, ${workspace.accountId}, ${workspace.workspaceId}, ${grandchild.id},
        ${crypto.randomUUID()}, ${`wf-${waitingTurnId}`}, 'requires_action',
        2, 'waiting prompt', 'test-model',
        'medium', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 1,
        ${waitingSince.toISOString()}::timestamptz
      )`,
    );

    const roots = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      parentSessionId: null,
    });
    expect(roots.sessions.find((row) => row.id === root.id)?.treeStats).toEqual({
      directChildren: 1,
      totalDescendants: 2,
      runningDescendants: 1,
      queuedDescendants: 0,
      attentionDescendants: 1,
      pausedDescendants: 0,
      failedDescendants: 0,
      unreadDescendants: 0,
      activelyWorkingDescendants: 0,
      attentionSince: waitingSince.toISOString(),
      truncated: false,
    });
    expect(roots.sessions.some((row) => row.id === child.id)).toBe(false);
    // The root itself is not waiting, so its own field is null.
    expect(roots.sessions.find((row) => row.id === root.id)?.requiresActionSince).toBeNull();

    const children = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      parentSessionId: root.id,
    });
    expect(children.sessions.map((row) => row.id)).toEqual([child.id]);
    expect(children.sessions[0]?.treeStats).toEqual({
      directChildren: 1,
      totalDescendants: 1,
      runningDescendants: 0,
      queuedDescendants: 0,
      attentionDescendants: 1,
      pausedDescendants: 0,
      failedDescendants: 0,
      unreadDescendants: 0,
      activelyWorkingDescendants: 0,
      attentionSince: waitingSince.toISOString(),
      truncated: false,
    });

    // The waiting session's own list row carries when its turn entered
    // requires_action, and a session without such a turn reports null.
    const grandchildren = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      parentSessionId: child.id,
    });
    expect(grandchildren.sessions[0]?.requiresActionSince).toBe(waitingSince.toISOString());
    expect(children.sessions[0]?.requiresActionSince).toBeNull();
  });

  test("counts effective pauses and excludes paused descendants from active totals", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const root = await session({ ...workspace, message: "effective pause root" });
    const pausedChild = await session({
      ...workspace,
      message: "directly paused queued child",
      parentSessionId: root.id,
    });
    const inheritedGrandchild = await session({
      ...workspace,
      message: "inherited paused running grandchild",
      parentSessionId: pausedChild.id,
    });
    const resumedGreatGrandchild = await session({
      ...workspace,
      message: "resumed queued great-grandchild",
      parentSessionId: inheritedGrandchild.id,
    });
    await executeSessionActivity(
      workspace.workspaceId,
      sql`
        update sessions
        set
          status = case
            when id = ${pausedChild.id} then 'queued'
            when id = ${inheritedGrandchild.id} then 'running'
            when id = ${resumedGreatGrandchild.id} then 'queued'
            else status
          end,
          direct_control_state = case
            when id = ${pausedChild.id} then 'paused'
            else direct_control_state
          end,
          direct_pause_revision = case
            when id = ${pausedChild.id} then 10
            else direct_pause_revision
          end,
          subtree_run_override_revision = case
            when id = ${resumedGreatGrandchild.id} then 11
            else subtree_run_override_revision
          end,
          control_version = case
            when id = ${pausedChild.id} then 10
            when id = ${resumedGreatGrandchild.id} then 11
            else control_version
          end,
          updated_at = now()
        where id in (
          ${pausedChild.id},
          ${inheritedGrandchild.id},
          ${resumedGreatGrandchild.id}
        )
      `,
    );

    const directPauseStats = await withWorkspaceRls(db, workspace.workspaceId, (scoped) =>
      sessionTreeStatsForSessions(scoped, workspace.workspaceId, [root.id]),
    );
    expect(directPauseStats.get(root.id)).toMatchObject({
      totalDescendants: 3,
      runningDescendants: 0,
      queuedDescendants: 1,
      pausedDescendants: 2,
    });

    await admin`
      update workspace_inference_controls
      set revision = 20, workspace_state = 'paused', workspace_pause_revision = 20
      where workspace_id = ${workspace.workspaceId}`;
    const workspacePauseStats = await withWorkspaceRls(db, workspace.workspaceId, (scoped) =>
      sessionTreeStatsForSessions(scoped, workspace.workspaceId, [root.id]),
    );
    expect(workspacePauseStats.get(root.id)).toMatchObject({
      totalDescendants: 3,
      runningDescendants: 0,
      queuedDescendants: 0,
      pausedDescendants: 3,
    });

    await executeSessionActivity(
      workspace.workspaceId,
      sql`
        update sessions
        set subtree_run_override_revision = 21, control_version = 21, updated_at = now()
        where id = ${resumedGreatGrandchild.id}
      `,
    );
    const resumedStats = await withWorkspaceRls(db, workspace.workspaceId, (scoped) =>
      sessionTreeStatsForSessions(scoped, workspace.workspaceId, [root.id]),
    );
    expect(resumedStats.get(root.id)).toMatchObject({
      totalDescendants: 3,
      runningDescendants: 0,
      queuedDescendants: 1,
      pausedDescendants: 2,
    });
  });

  test("bounds deep, wide, and overlapping descendant summaries with explicit lower bounds", async () => {
    if (!available) return;
    const workspace = await freshWorkspace({ maxNestedAgentDepth: 64 });
    const subjectId = "user:bounded-tree-stats";
    await grantMember(workspace, subjectId);
    const deepRoot = await session({ ...workspace, message: "deep root" });
    const wideRoot = await session({ ...workspace, message: "wide root" });

    const deepIds = Array.from({ length: 40 }, () => crypto.randomUUID());
    const deepRows = deepIds.map((id, index) => ({
      id,
      parentId: index === 0 ? deepRoot.id : deepIds[index - 1]!,
      message: `deep-${index + 1}`,
    }));
    await executeSessionActivity(
      workspace.workspaceId,
      sql`
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, model,
        reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id,
        parent_session_id, temporal_workflow_id,
        tool_policy
      )
      select
        node.id, ${workspace.accountId}, ${workspace.workspaceId}, 'running', node.message,
        'test-model', 'medium', 'standard', 'none', node.id, node."parentId",
        'tree-deep-' || node.id::text,
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', node."parentId")
      from jsonb_to_recordset(${JSON.stringify(deepRows)}::jsonb)
        as node(id uuid, "parentId" uuid, message text)`,
    );

    await executeSessionActivity(
      workspace.workspaceId,
      sql`
      with nodes as (
        select gen_random_uuid() as id, ordinal
        from generate_series(1, 1005) as ordinal
      )
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, model,
        reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id,
        parent_session_id, temporal_workflow_id,
        tool_policy
      )
      select
        id, ${workspace.accountId}, ${workspace.workspaceId}, 'idle',
        'wide-' || ordinal::text, 'test-model', 'medium', 'standard', 'none', id, ${wideRoot.id},
        'tree-wide-' || id::text,
        jsonb_build_object(
          'mode', 'explicit',
          'inheritedFromSessionId', ${wideRoot.id}::uuid
        )
      from nodes`,
    );

    for (const sessionId of [deepRoot.id, deepIds[0]!, wideRoot.id]) {
      await setSessionPin(db, {
        workspaceId: workspace.workspaceId,
        subjectId,
        sessionId,
        pinned: true,
      });
    }

    const page = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
    });
    const stats = new Map(page.pinned.map((row) => [row.id, row.treeStats]));

    expect(stats.get(deepRoot.id)).toEqual({
      directChildren: 1,
      totalDescendants: 32,
      runningDescendants: 32,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      unreadDescendants: 0,
      activelyWorkingDescendants: 0,
      attentionSince: null,
      truncated: true,
    });
    expect(stats.get(deepIds[0]!)).toEqual({
      directChildren: 1,
      totalDescendants: 32,
      runningDescendants: 32,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      unreadDescendants: 0,
      activelyWorkingDescendants: 0,
      attentionSince: null,
      truncated: true,
    });
    expect(stats.get(wideRoot.id)).toEqual({
      directChildren: 1_000,
      totalDescendants: 1_000,
      runningDescendants: 0,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      unreadDescendants: 0,
      activelyWorkingDescendants: 0,
      attentionSince: null,
      truncated: true,
    });
  }, 180_000);

  test("bounds pinned roots before descendant projection and makes omission explicit", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:bounded-pinned-roots";
    const marker = `bounded-pinned-root-${crypto.randomUUID()}`;
    await grantMember(workspace, subjectId);
    await withWorkspaceSubjectSessionActivityRls(
      db,
      workspace.workspaceId,
      subjectId,
      async (scoped) => {
        await scoped.execute(sql`
          with nodes as (
            select gen_random_uuid() as id, ordinal
            from generate_series(1, 105) as ordinal
          )
          insert into sessions (
            id, account_id, workspace_id, status, initial_message, model,
            reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id,
            temporal_workflow_id, tool_policy
          )
          select
            id, ${workspace.accountId}, ${workspace.workspaceId}, 'idle',
            'pinned-root-' || ordinal::text, 'test-model', 'medium', 'standard', 'none', id,
            ${marker} || '-' || ordinal::text,
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
          from nodes`);
        await scoped.execute(sql`
          insert into session_pins (
            account_id, workspace_id, subject_id, session_id, pinned, pinned_at
          )
          select
            ${workspace.accountId}, ${workspace.workspaceId}, ${subjectId}, id, true, now()
          from sessions
          where account_id = ${workspace.accountId}
            and workspace_id = ${workspace.workspaceId}
            and temporal_workflow_id like ${`${marker}-%`}`);
      },
    );

    const page = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
    });
    expect(page.pinned).toHaveLength(100);
    expect(page.pinnedTruncated).toBe(true);
    expect(page.sessions).toEqual([]);
    expect(new Set(page.pinned.map((row) => row.id)).size).toBe(100);
  }, 60_000);

  test("does not double-count cyclic legacy parent graphs", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const root = await session({ ...workspace, message: "cycle root" });
    const child = await session({
      ...workspace,
      message: "cycle child",
      parentSessionId: root.id,
    });
    const grandchild = await session({
      ...workspace,
      message: "cycle grandchild",
      parentSessionId: child.id,
    });
    // This is a legacy graph from before 0114 made lineage snapshots immutable.
    // Model that historical write only inside one admin transaction; the named
    // production trigger is re-enabled before the transaction can commit.
    await admin.begin(async (transaction) => {
      await transaction.unsafe(
        'alter table "sessions" disable trigger "session_depth_snapshot_immutable"',
      );
      try {
        await transaction`update sessions set parent_session_id = ${grandchild.id} where id = ${root.id}`;
      } finally {
        await transaction.unsafe(
          'alter table "sessions" enable trigger "session_depth_snapshot_immutable"',
        );
      }
    });
    const stats = await withWorkspaceRls(db, workspace.workspaceId, async (scoped) =>
      sessionTreeStatsForSessions(scoped, workspace.workspaceId, [root.id]),
    );
    expect(stats.get(root.id)).toEqual({
      directChildren: 1,
      totalDescendants: 2,
      runningDescendants: 0,
      queuedDescendants: 2,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      unreadDescendants: 0,
      activelyWorkingDescendants: 0,
      attentionSince: null,
      truncated: true,
    });
  }, 60_000);

  test("reaps expired list snapshots outside request transactions", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await grantMember(workspace, "user:reaper");
    const [snapshot] = await admin<{ id: string }[]>`
      insert into session_list_snapshots (
        account_id, workspace_id, subject_id, parent_session_filter,
        ordinary_session_ids, expires_at
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, 'user:reaper', 'all',
        '{}'::uuid[], now() - interval '1 second'
      ) returning id`;
    expect(snapshot).toBeDefined();

    expect(await reapExpiredSessionListSnapshots(db, 5000)).toBeGreaterThanOrEqual(1);
    const [remaining] = await admin<{ present: boolean }[]>`
      select exists(select 1 from session_list_snapshots where id = ${snapshot!.id}) as present`;
    expect(remaining?.present).toBe(false);
  });

  test("runs as the non-superuser app role with FORCE RLS enabled", async () => {
    if (!available) return;
    const [role] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'opengeni_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [table] = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'session_pins'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const [snapshotTable] = await admin<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'session_list_snapshots'::regclass`;
    expect(snapshotTable).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const isolation = await withWorkspaceSubjectRls(
      db,
      (await freshWorkspace()).workspaceId,
      "user:isolation-check",
      async (scoped) =>
        await scoped.execute<{ transaction_isolation: string }>(sql`show transaction_isolation`),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    expect(isolation).toEqual([{ transaction_isolation: "repeatable read" }]);
  });

  test("is idempotent, monotonic across unpin/re-pin, and rejects stale versions", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const target = await session({ ...workspace, message: "pin target" });
    const subject = "user:one";
    await grantMember(workspace, subject);
    const beforeUpdatedAt = target.updatedAt;

    const absentUnpin = await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      pinned: false,
      expectedVersion: 0,
    });
    expect(absentUnpin).toMatchObject({ pinned: false, pinnedAt: null, pinVersion: 0 });
    const [absentCount] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_pins
      where workspace_id = ${workspace.workspaceId}
        and subject_id = ${subject}
        and session_id = ${target.id}`;
    expect(absentCount?.count).toBe(0);

    const first = await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      pinned: true,
    });
    expect(first).toMatchObject({ pinned: true, pinVersion: 1 });
    const staleRetry = await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      pinned: true,
      expectedVersion: 0,
    });
    expect(staleRetry).toMatchObject({ pinned: true, pinVersion: 1 });
    const retry = await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      pinned: true,
      expectedVersion: 1,
    });
    expect(retry).toMatchObject({ pinned: true, pinVersion: 1 });

    const unpinned = await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      pinned: false,
      expectedVersion: 1,
    });
    expect(unpinned).toMatchObject({ pinned: false, pinnedAt: null, pinVersion: 2 });
    const staleUnpinRetry = await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      pinned: false,
      expectedVersion: 1,
    });
    expect(staleUnpinRetry).toMatchObject({ pinned: false, pinnedAt: null, pinVersion: 2 });
    const pageAfterUnpin = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: subject,
    });
    const ordinaryProjection = pageAfterUnpin.sessions.find((row) => row.id === target.id);
    expect(ordinaryProjection).toMatchObject({
      pinned: false,
      pinnedAt: null,
      pinVersion: 2,
    });
    const repinned = await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      pinned: true,
      expectedVersion: ordinaryProjection?.pinVersion,
    });
    expect(repinned).toMatchObject({ pinned: true, pinVersion: 3 });

    await expect(
      setSessionPin(db, {
        workspaceId: workspace.workspaceId,
        subjectId: subject,
        sessionId: target.id,
        pinned: false,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({
      name: "SessionPinVersionConflictError",
      current: { pinned: true, pinnedAt: repinned?.pinnedAt ?? null, pinVersion: 3 },
    } satisfies Partial<SessionPinVersionConflictError>);

    const unchanged = await getSessionForSubject(db, workspace.workspaceId, target.id, subject);
    expect(unchanged?.updatedAt).toBe(beforeUpdatedAt);
  }, 60_000);

  test("serializes concurrent same-state retries to one monotonic revision", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await grantMember(workspace, "user:race");
    const target = await session({ ...workspace, message: "concurrent target" });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        setSessionPin(db, {
          workspaceId: workspace.workspaceId,
          subjectId: "user:race",
          sessionId: target.id,
          pinned: true,
          expectedVersion: 0,
        }),
      ),
    );
    expect(results.every((result) => result?.pinned && result.pinVersion === 1)).toBe(true);
    const [row] = await admin<{ count: number; version: number }[]>`
      select count(*)::int as count, max(version)::int as version
      from session_pins
      where workspace_id = ${workspace.workspaceId}
        and subject_id = 'user:race'
        and session_id = ${target.id}`;
    expect(row).toEqual({ count: 1, version: 1 });
  }, 60_000);

  test("isolates member pins, uses stable order, filters pins, and never duplicates normal pages", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await grantMember(workspace, "user:one");
    await grantMember(workspace, "user:two");
    const older = await session({ ...workspace, message: "ordinary older" });
    const pinnedFirst = await session({ ...workspace, message: "find pinned first" });
    const pinnedSecond = await session({ ...workspace, message: "find pinned second" });
    const newer = await session({ ...workspace, message: "ordinary newer" });
    await executeSessionActivity(
      workspace.workspaceId,
      sql`
        update sessions
        set updated_at = case id
          when ${older.id} then now() - interval '4 minutes'
          when ${pinnedFirst.id} then now() - interval '3 minutes'
          when ${pinnedSecond.id} then now() - interval '2 minutes'
          when ${newer.id} then now() - interval '1 minute'
          else updated_at
        end
        where id in (${older.id}, ${pinnedFirst.id}, ${pinnedSecond.id}, ${newer.id})
      `,
    );

    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: "user:one",
      sessionId: pinnedFirst.id,
      pinned: true,
    });
    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: "user:one",
      sessionId: pinnedSecond.id,
      pinned: true,
    });
    await admin`
      update session_pins set pinned_at = now() - interval '2 minutes'
      where workspace_id = ${workspace.workspaceId} and subject_id = 'user:one' and session_id = ${pinnedFirst.id}`;
    await admin`
      update session_pins set pinned_at = now() - interval '1 minute'
      where workspace_id = ${workspace.workspaceId} and subject_id = 'user:one' and session_id = ${pinnedSecond.id}`;

    const firstPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:one",
      limit: 1,
    });
    expect(firstPage.pinned.map((row) => row.id)).toEqual([pinnedSecond.id, pinnedFirst.id]);
    expect(firstPage.sessions.map((row) => row.id)).toEqual([newer.id]);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(new Set([...firstPage.pinned, ...firstPage.sessions].map((row) => row.id)).size).toBe(3);

    const decoded = decodeSessionListCursor(firstPage.nextCursor!);
    expect(decoded).not.toBeNull();
    const secondPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:one",
      limit: 1,
      cursor: decoded!,
    });
    expect(secondPage.sessions.map((row) => row.id)).toEqual([older.id]);
    expect(secondPage.sessions.map((row) => row.id)).not.toContain(pinnedFirst.id);
    expect(secondPage.pinned.map((row) => row.id)).toEqual([pinnedSecond.id, pinnedFirst.id]);
    expect(decodeSessionListCursor("not-a-cursor")).toBeNull();
    expect(
      decodeSessionListCursor(
        Buffer.from(
          JSON.stringify({ updatedAt: new Date().toISOString(), id: "not-a-uuid" }),
        ).toString("base64url"),
      ),
    ).toBeNull();

    const filtered = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:one",
      search: "pinned second",
    });
    expect(filtered.pinned.map((row) => row.id)).toEqual([pinnedSecond.id]);
    expect(filtered.sessions).toEqual([]);

    const otherMember = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:two",
    });
    expect(otherMember.pinned).toEqual([]);
    expect(otherMember.sessions.map((row) => row.id)).toContain(pinnedSecond.id);

    const sameWorkspaceOtherSubject = await withWorkspaceSubjectRls(
      db,
      workspace.workspaceId,
      "user:two",
      async (scoped) =>
        await scoped.execute(sql`
          select id from session_pins where subject_id = 'user:one'
          union all
          select id from session_list_snapshots where subject_id = 'user:one'`),
    );
    expect(sameWorkspaceOtherSubject).toEqual([]);
  }, 60_000);

  test("returns a complete pins-only projection without scanning or snapshotting ordinary rows", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:pins-only";
    await grantMember(workspace, subjectId);
    const pinned = await session({ ...workspace, message: "pins-only target" });
    await session({ ...workspace, message: "pins-only ordinary first" });
    await session({ ...workspace, message: "pins-only ordinary second" });
    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId,
      sessionId: pinned.id,
      pinned: true,
    });

    const page = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
      pinsOnly: true,
    });
    expect(page.pinned.map((row) => row.id)).toEqual([pinned.id]);
    expect(page.sessions).toEqual([]);
    expect(page.nextCursor).toBeNull();
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from session_list_snapshots
      where workspace_id = ${workspace.workspaceId}
        and subject_id = ${subjectId}`;
    expect(count?.count).toBe(0);
  }, 60_000);

  test("lists for non-member api_key subjects — workspace-scoped keys have no membership row", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    // Deliberately NO grantMember for this subject: a workspace-scoped API key
    // is authorized by requireAccessGrant from its api_keys row, never through
    // a workspace_memberships row. Listing must work anyway (this is the geni
    // fleet-view regression: session-list implementation's membership gate 403'd every api_key
    // principal platform-wide).
    const apiKeySubject = "api_key:00000000-0000-4000-8000-000000000001";
    const first = await session({ ...workspace, message: "api key first" });
    const second = await session({ ...workspace, message: "api key second" });
    await executeSessionActivity(
      workspace.workspaceId,
      sql`update sessions set updated_at = now() - interval '1 minute' where id = ${first.id}`,
    );

    const page = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: apiKeySubject,
      limit: 1,
    });
    expect(page.pinned).toEqual([]);
    expect(page.sessions.map((row) => row.id)).toEqual([second.id]);
    expect(page.sessions[0]!.pinned).toBe(false);
    expect(page.nextCursor).toBeTruthy();

    const decoded = decodeSessionListCursor(page.nextCursor!);
    expect(decoded).not.toBeNull();
    const continuation = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: apiKeySubject,
      limit: 1,
      cursor: decoded!,
    });
    expect(continuation.sessions.map((row) => row.id)).toEqual([first.id]);

    // People are still authorized exclusively through memberships: a user
    // subject with no membership row stays denied.
    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId: "user:never-a-member",
      }),
    ).rejects.toBeInstanceOf(SessionListAccessError);
  }, 60_000);

  test("fences later activity out of a bounded keyset traversal", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await grantMember(workspace, "user:snapshot");
    const oldest = await session({ ...workspace, message: "snapshot oldest" });
    const middle = await session({ ...workspace, message: "snapshot middle" });
    const newest = await session({ ...workspace, message: "snapshot newest" });
    await executeSessionActivity(
      workspace.workspaceId,
      sql`
        update sessions
        set updated_at = case id
          when ${oldest.id} then now() - interval '3 minutes'
          when ${middle.id} then now() - interval '2 minutes'
          when ${newest.id} then now() - interval '1 minute'
          else updated_at
        end
        where id in (${oldest.id}, ${middle.id}, ${newest.id})
      `,
    );

    const firstPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:snapshot",
      limit: 1,
    });
    expect(firstPage.sessions.map((row) => row.id)).toEqual([newest.id]);
    const cursor = decodeSessionListCursor(firstPage.nextCursor!);
    expect(cursor).toMatchObject({
      kind: "keyset",
      search: null,
      parentSessionFilter: "all",
    });

    // Activity committed after page one belongs to the next traversal. It may
    // move above this cursor, but it cannot duplicate or destabilize the
    // bounded chain already in progress.
    await executeSessionActivity(
      workspace.workspaceId,
      sql`update sessions set updated_at = now() + interval '1 minute' where id = ${middle.id}`,
    );

    const secondPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:snapshot",
      limit: 1,
      cursor: cursor!,
    });
    expect(secondPage.sessions.map((row) => row.id)).toEqual([oldest.id]);
    expect(secondPage.sessions.map((row) => row.id)).not.toContain(newest.id);
    expect(secondPage.sessions.map((row) => row.id)).not.toContain(middle.id);
    expect(secondPage.nextCursor).toBeNull();

    const refreshed = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:snapshot",
      limit: 1,
    });
    expect(refreshed.sessions.map((row) => row.id)).toEqual([middle.id]);
  }, 60_000);

  test("validates keyset cursors and continues legacy snapshots during rollout", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:cursor-errors";
    await grantMember(workspace, subjectId);
    await session({ ...workspace, message: "cursor first" });
    await session({ ...workspace, message: "cursor second" });
    const firstPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
    });
    const cursor = decodeSessionListCursor(firstPage.nextCursor!);
    expect(cursor).not.toBeNull();

    // A pre-v2 replica ignores the new fields and decodes this envelope as a
    // legacy snapshot cursor. The reserved snapshot never exists, so mixed
    // rollout traffic reaches the SDK/browser's typed 410 rebase path instead
    // of the old decoder's unrecoverable 400 path.
    const rollingEnvelope = JSON.parse(
      Buffer.from(firstPage.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(rollingEnvelope).toMatchObject({
      version: 2,
      snapshotId: "00000000-0000-4000-8000-000000000000",
      offset: 0,
    });
    const legacyReplicaCursor = {
      kind: "snapshot" as const,
      snapshotId: rollingEnvelope.snapshotId as string,
      offset: rollingEnvelope.offset as number,
      parentSessionFilter: rollingEnvelope.parentSessionFilter as string,
      search: rollingEnvelope.search as string | null,
      archiveMode: rollingEnvelope.archiveMode as "active" | "archived",
    };
    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId,
        limit: 1,
        cursor: legacyReplicaCursor,
      }),
    ).rejects.toBeInstanceOf(SessionListCursorExpiredError);

    for (const invalidSortAt of [
      "0000-01-01T00:00:00.000000Z",
      "2026-02-30T00:00:00.000000Z",
      "2026-01-01T00:00:00.000Z",
    ]) {
      expect(
        decodeSessionListCursor(
          Buffer.from(JSON.stringify({ ...rollingEnvelope, sortAt: invalidSortAt })).toString(
            "base64url",
          ),
        ),
      ).toBeNull();
    }

    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId,
        limit: 1,
        cursor: { ...cursor!, search: "different-filter" },
      }),
    ).rejects.toBeInstanceOf(SessionListCursorError);
    const sessionIds = firstPage.sessions.map((row) => row.id);
    const [legacy] = await admin<{ id: string }[]>`
      insert into session_list_snapshots (
        account_id, workspace_id, subject_id, parent_session_filter,
        ordinary_session_ids, expires_at
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, ${subjectId}, 'all',
        ${sessionIds}::uuid[], now() + interval '10 minutes'
      ) returning id`;
    const legacyCursor = {
      kind: "snapshot" as const,
      snapshotId: legacy!.id,
      offset: 0,
      parentSessionFilter: "all",
      search: null,
      archiveMode: "active" as const,
    };
    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId,
        limit: 1,
        cursor: legacyCursor,
      }),
    ).resolves.toMatchObject({ sessions: [{ id: sessionIds[0] }] });

    await admin`delete from session_list_snapshots where id = ${legacy!.id}`;
    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId,
        limit: 1,
        cursor: legacyCursor,
      }),
    ).rejects.toBeInstanceOf(SessionListCursorExpiredError);
  }, 60_000);

  test("applies host root/exact scope inside list snapshots and fills pages after revocation", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:host-session-scope";
    await grantMember(workspace, subjectId);
    const root = await session({ ...workspace, message: "authorized root" });
    const child = await session({
      ...workspace,
      message: "authorized child",
      parentSessionId: root.id,
    });
    const grandchild = await session({
      ...workspace,
      message: "authorized grandchild",
      parentSessionId: child.id,
    });
    const exact = await session({ ...workspace, message: "authorized exact" });
    const hidden = await session({ ...workspace, message: "hidden" });

    const scoped = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      authorizationScope: {
        kind: "scoped",
        rootSessionIds: [root.id],
        sessionIds: [exact.id],
      },
    });
    expect(new Set(scoped.sessions.map((row) => row.id))).toEqual(
      new Set([root.id, child.id, grandchild.id, exact.id]),
    );
    expect(scoped.sessions.map((row) => row.id)).not.toContain(hidden.id);
    const scopedById = new Map(scoped.sessions.map((row) => [row.id, row]));
    expect(scopedById.get(child.id)?.parentSessionId).toBe(root.id);
    expect(scopedById.get(root.id)?.treeStats?.totalDescendants).toBe(2);
    expect(scopedById.get(exact.id)).toMatchObject({
      parentSessionId: null,
      treeStats: {
        directChildren: 0,
        totalDescendants: 0,
        runningDescendants: 0,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 0,
        unreadDescendants: 0,
        activelyWorkingDescendants: 0,
        truncated: false,
      },
    });

    await executeSessionActivity(
      workspace.workspaceId,
      sql`
      update sessions
      set updated_at = case id
        when ${root.id} then now()
        when ${child.id} then now() - interval '1 minute'
        when ${grandchild.id} then now() - interval '2 minutes'
        when ${exact.id} then now() - interval '3 minutes'
        else now() - interval '4 minutes'
      end
      where workspace_id = ${workspace.workspaceId}`,
    );
    const first = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
      authorizationScope: { kind: "all" },
    });
    expect(first.sessions.map((row) => row.id)).toEqual([root.id]);
    const cursor = decodeSessionListCursor(first.nextCursor!);
    expect(cursor).not.toBeNull();

    // Everything between the first row and the two exact survivors is revoked.
    // The continuation must scan through those stale snapshot ids and fill the
    // page with the next currently authorized row instead of returning empty.
    const afterRevocation = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
      cursor: cursor!,
      authorizationScope: {
        kind: "scoped",
        rootSessionIds: [],
        sessionIds: [exact.id, hidden.id],
      },
    });
    expect(afterRevocation.sessions.map((row) => row.id)).toEqual([exact.id]);
    expect(afterRevocation.nextCursor).toBeTruthy();
    const finalPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
      cursor: decodeSessionListCursor(afterRevocation.nextCursor!)!,
      authorizationScope: {
        kind: "scoped",
        rootSessionIds: [],
        sessionIds: [exact.id, hidden.id],
      },
    });
    expect(finalPage.sessions.map((row) => row.id)).toEqual([hidden.id]);
    expect(finalPage.nextCursor).toBeNull();
  }, 60_000);

  test("treats percent, underscore, and backslash as literal search text", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await grantMember(workspace, "user:literals");
    const percent = await session({ ...workspace, message: "literal 100% complete" });
    const underscore = await session({ ...workspace, message: "literal under_score" });
    const backslash = await session({ ...workspace, message: String.raw`literal back\slash` });

    const matchingIds = async (search: string) =>
      (
        await listSessionsForSubject(db, workspace.workspaceId, {
          subjectId: "user:literals",
          search,
        })
      ).sessions.map((row) => row.id);
    expect(await matchingIds("100%"), "percent must not become a wildcard").toEqual([percent.id]);
    expect(await matchingIds("under_score"), "underscore must not become a wildcard").toEqual([
      underscore.id,
    ]);
    expect(await matchingIds(String.raw`back\slash`), "backslash must remain literal").toEqual([
      backslash.id,
    ]);
  }, 60_000);

  test("removing a workspace member cleans only that subject's pins and snapshots", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const foreign = await freshWorkspace();
    const subjectId = "user:removed-member";
    const retainedSubjectId = "user:retained-member";
    await grantWorkspaceAccess(db, {
      ...workspace,
      subjectId,
      permissions: ["sessions:read"],
    });
    await grantWorkspaceAccess(db, {
      ...workspace,
      subjectId: retainedSubjectId,
      permissions: ["sessions:read"],
    });
    await grantWorkspaceAccess(db, {
      ...foreign,
      subjectId,
      permissions: ["sessions:read"],
    });

    const target = await session({ ...workspace, message: "removed member pin" });
    await session({ ...workspace, message: "removed member snapshot" });
    await session({ ...workspace, message: "retained member first" });
    await session({ ...workspace, message: "retained member second" });
    await session({ ...foreign, message: "foreign member first" });
    await session({ ...foreign, message: "foreign member second" });

    const removedPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
    });
    expect(removedPage.nextCursor).toBeTruthy();
    const retainedPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: retainedSubjectId,
      limit: 1,
    });
    expect(retainedPage.nextCursor).toBeTruthy();
    const foreignPage = await listSessionsForSubject(db, foreign.workspaceId, {
      subjectId,
      limit: 1,
    });
    expect(foreignPage.nextCursor).toBeTruthy();
    // New lists are stateless keysets, but rolling deploys may still have live
    // legacy snapshot cursors. Seed one per subject/workspace to prove member
    // removal continues cleaning only the revoked subject's legacy state.
    await admin`
      insert into session_list_snapshots (
        account_id, workspace_id, subject_id, parent_session_filter,
        ordinary_session_ids, expires_at
      ) values
        (${workspace.accountId}, ${workspace.workspaceId}, ${subjectId}, 'all', '{}'::uuid[], now() + interval '10 minutes'),
        (${workspace.accountId}, ${workspace.workspaceId}, ${retainedSubjectId}, 'all', '{}'::uuid[], now() + interval '10 minutes'),
        (${foreign.accountId}, ${foreign.workspaceId}, ${subjectId}, 'all', '{}'::uuid[], now() + interval '10 minutes')`;

    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId,
      sessionId: target.id,
      pinned: true,
    });

    expect(await removeMemberAsAdmin(db, workspace, subjectId)).toBe(true);
    const [counts] = await admin<{ memberships: number; pins: number }[]>`
      select
        (select count(*)::int from workspace_memberships
          where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as memberships,
        (select count(*)::int from session_pins
          where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as pins`;
    expect(counts).toEqual({ memberships: 0, pins: 0 });

    const [snapshotCounts] = await admin<
      {
        removedWorkspace: number;
        retainedMember: number;
        foreignWorkspace: number;
        targetOrphans: number;
      }[]
    >`
      select
        (select count(*)::int from session_list_snapshots
          where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as "removedWorkspace",
        (select count(*)::int from session_list_snapshots
          where workspace_id = ${workspace.workspaceId} and subject_id = ${retainedSubjectId}) as "retainedMember",
        (select count(*)::int from session_list_snapshots
          where workspace_id = ${foreign.workspaceId} and subject_id = ${subjectId}) as "foreignWorkspace",
        (select count(*)::int
          from session_list_snapshots snapshot
          left join workspace_memberships membership
            on membership.workspace_id = snapshot.workspace_id
           and membership.subject_id = snapshot.subject_id
          where snapshot.workspace_id = ${workspace.workspaceId}
            and membership.id is null) as "targetOrphans"`;
    expect(snapshotCounts).toEqual({
      removedWorkspace: 0,
      retainedMember: 1,
      foreignWorkspace: 1,
      targetOrphans: 0,
    });
  }, 60_000);

  test("rejects stale authorized listing after removal and cleans legacy cursor state", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const staleSubject = "user:stale-list";

    await grantMember(workspace, staleSubject);

    const staleTarget = await session({ ...workspace, message: "stale list first" });
    await session({ ...workspace, message: "stale list second" });

    // The API already obtained a grant, then removal commits before the listing
    // transaction starts. The live membership check must reject the stale
    // request even though keyset cursors carry no server-side member state.
    expect(await getWorkspaceGrant(db, staleSubject, workspace.workspaceId)).not.toBeNull();
    const stalePage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: staleSubject,
      limit: 1,
    });
    expect(stalePage.nextCursor).toBeTruthy();
    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: staleSubject,
      sessionId: staleTarget.id,
      pinned: true,
    });
    await admin`
      insert into session_list_snapshots (
        account_id, workspace_id, subject_id, parent_session_filter,
        ordinary_session_ids, expires_at
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, ${staleSubject}, 'all',
        '{}'::uuid[], now() + interval '10 minutes'
      )`;
    expect(await removeMemberAsAdmin(db, workspace, staleSubject)).toBe(true);
    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId: staleSubject,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(SessionListAccessError);
    const [staleCounts] = await admin<
      { memberships: number; pins: number; snapshots: number; orphans: number }[]
    >`
      select
        (select count(*)::int from workspace_memberships
          where workspace_id = ${workspace.workspaceId} and subject_id = ${staleSubject}) as memberships,
        (select count(*)::int from session_pins
          where workspace_id = ${workspace.workspaceId} and subject_id = ${staleSubject}) as pins,
        (select count(*)::int from session_list_snapshots
          where workspace_id = ${workspace.workspaceId} and subject_id = ${staleSubject}) as snapshots,
        (select count(*)::int
          from session_list_snapshots snapshot
          left join workspace_memberships membership
            on membership.workspace_id = snapshot.workspace_id
           and membership.subject_id = snapshot.subject_id
          where snapshot.workspace_id = ${workspace.workspaceId}
            and membership.id is null) as orphans`;
    expect(staleCounts).toEqual({ memberships: 0, pins: 0, snapshots: 0, orphans: 0 });
  }, 60_000);

  test("rejects a paused authorized listing after removal wins the personal-state fence", async () => {
    if (!available || !shared) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:removal-first";
    await grantMember(workspace, subjectId);
    const target = await session({ ...workspace, message: "removal-first target" });
    await session({ ...workspace, message: "removal-first overflow" });

    const existing = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId,
      limit: 1,
    });
    expect(existing.nextCursor).toBeTruthy();
    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId,
      sessionId: target.id,
      pinned: true,
    });
    expect(await getWorkspaceGrant(db, subjectId, workspace.workspaceId)).not.toBeNull();

    const barrier = postgres(shared.adminUrl, { max: 1 });
    const removalClient = createDb(shared.appUrl, { max: 1 });
    const listingClient = createDb(shared.appUrl, { max: 1 });
    const barrierClass = 81326027;
    const removalLock = 1;
    const triggerFunction = "sessionpin_test_removal_first_barrier";
    const triggerName = "sessionpin_test_removal_first_membership_barrier";
    let removalPromise: Promise<boolean> | null = null;
    let listingPromise: Promise<Awaited<ReturnType<typeof listSessionsForSubject>>> | null = null;
    try {
      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${barrierClass}, ${removalLock});
          return old;
        end
        $$;
        create trigger ${triggerName}
          before delete on workspace_memberships
          for each row when (
            old.workspace_id = '${workspace.workspaceId}'::uuid
            and old.subject_id = '${subjectId}'
          ) execute function ${triggerFunction}();
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${removalLock})`;

      removalPromise = removeMemberAsAdmin(removalClient.db, workspace, subjectId);
      await waitForAdvisoryWait(admin, barrierClass, removalLock);

      // Start listing while removal owns the personal-state fence. The list must
      // wait on its shared counterpart before checking membership.
      listingPromise = listSessionsForSubject(listingClient.db, workspace.workspaceId, {
        subjectId,
        limit: 1,
      });
      await waitForDatabaseQueryWait(admin, "pg_advisory_xact_lock_shared");

      // The stale authorization is intentionally held while removal owns the
      // personal-state fence. Release the native barrier, wait for removal to
      // commit, then assert the waiting list observes no membership.
      await barrier`select pg_advisory_unlock(${barrierClass}, ${removalLock})`;
      expect(await removalPromise).toBe(true);
      await expect(listingPromise).rejects.toBeInstanceOf(SessionListAccessError);

      const [counts] = await admin<
        { memberships: number; pins: number; snapshots: number; orphans: number }[]
      >`
        select
          (select count(*)::int from workspace_memberships
            where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as memberships,
          (select count(*)::int from session_pins
            where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as pins,
          (select count(*)::int from session_list_snapshots
            where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as snapshots,
          (select count(*)::int
            from session_list_snapshots snapshot
            left join workspace_memberships membership
              on membership.workspace_id = snapshot.workspace_id
             and membership.subject_id = snapshot.subject_id
            where snapshot.workspace_id = ${workspace.workspaceId}
              and membership.id is null) as orphans`;
      expect(counts).toEqual({ memberships: 0, pins: 0, snapshots: 0, orphans: 0 });
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${triggerName} on workspace_memberships;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([listingPromise, removalPromise].filter(Boolean));
      await removalClient.close().catch(() => undefined);
      await listingClient.close().catch(() => undefined);
    }
  }, 60_000);

  test("forces read committed over a connection-local repeatable-read default", async () => {
    if (!available || !shared) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:explicit-read-committed";
    await grantMember(workspace, subjectId);
    await session({ ...workspace, message: "explicit isolation first" });
    await session({ ...workspace, message: "explicit isolation second" });

    const ambientClient = createDb(shared.appUrl, {
      max: 1,
      isolationLevel: "repeatable read",
    });
    try {
      // The startup parameter applies only to this postgres-js pool. The
      // direct query proves this connection inherited REPEATABLE READ. Observe
      // the transaction options at the database boundary to prove the list
      // overrides it without relying on the retired snapshot INSERT path.
      const ambient = await ambientClient.db.execute<{ default_transaction_isolation: string }>(
        sql`show default_transaction_isolation`,
      );
      expect(ambient).toEqual([{ default_transaction_isolation: "repeatable read" }]);

      const transaction = ambientClient.db.transaction.bind(ambientClient.db);
      let observedIsolation: string | undefined;
      const observingDb = new Proxy(ambientClient.db, {
        get(targetDb, property, receiver) {
          if (property === "transaction") {
            return async (...args: Parameters<typeof transaction>) => {
              observedIsolation = args[1]?.isolationLevel;
              return await transaction(...args);
            };
          }
          const value = Reflect.get(targetDb, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(targetDb) : value;
        },
      });
      const page = await listSessionsForSubject(observingDb, workspace.workspaceId, {
        subjectId,
        limit: 1,
      });
      expect(observedIsolation).toBe("read committed");
      expect(page.sessions).toHaveLength(1);
      expect(page.nextCursor).toBeTruthy();
    } finally {
      await ambientClient.close().catch(() => undefined);
    }
  }, 60_000);

  test("retries two serialization failures before returning a real list page", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:list-serialization-retry";
    await grantMember(workspace, subjectId);
    const target = await session({ ...workspace, message: "serialization retry target" });

    const transaction = db.transaction.bind(db);
    let attempts = 0;
    const retryingDb = new Proxy(db, {
      get(targetDb, property, receiver) {
        if (property === "transaction") {
          return async (...args: Parameters<typeof transaction>) => {
            attempts += 1;
            if (attempts <= 2) {
              throw Object.assign(new Error("synthetic PostgreSQL serialization failure"), {
                code: "40001",
              });
            }
            return await transaction(...args);
          };
        }
        const value = Reflect.get(targetDb, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(targetDb) : value;
      },
    });

    const page = await listSessionsForSubject(retryingDb, workspace.workspaceId, {
      subjectId,
      limit: 10,
    });

    expect(attempts).toBe(3);
    expect(page.pinned).toEqual([]);
    expect(page.sessions.map((row) => row.id)).toEqual([target.id]);
  });

  test("keeps acknowledgment and actively-working state durable and subject-specific", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const target = await session({ ...workspace, message: "attention target" });
    const subject = "user:attention-one";
    const otherSubject = "user:attention-two";
    await grantMember(workspace, subject);
    await grantMember(workspace, otherSubject);

    const forcedUnread = await setSessionAttention(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      unread: true,
      expectedVersion: 0,
    });
    expect(forcedUnread).toMatchObject({
      pinned: false,
      pinVersion: 0,
      unread: true,
      activelyWorking: false,
      attentionVersion: 1,
      archived: false,
      archiveVersion: 0,
    });
    const cleared = await setSessionAttention(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      unread: false,
      expectedVersion: 1,
    });
    expect(cleared).toMatchObject({ unread: false, attentionVersion: 2 });

    await executeSessionActivity(
      workspace.workspaceId,
      sql`update sessions set last_sequence = 5 where id = ${target.id}`,
    );

    expect(await getSessionForSubject(db, workspace.workspaceId, target.id, subject)).toMatchObject(
      { unread: true, activelyWorking: false, attentionVersion: 2 },
    );

    // The browser rendered through sequence 3, then sequence 5 arrived before
    // its acknowledgement request reached the API. Only the rendered frontier
    // is consumed; the unseen newer events remain unread.
    const partialRead = await setSessionAttention(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      unread: false,
      acknowledgedThroughSequence: 3,
      expectedVersion: 2,
    });
    expect(partialRead).toMatchObject({
      unread: true,
      activelyWorking: false,
      attentionVersion: 3,
    });

    const read = await setSessionAttention(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      unread: false,
      acknowledgedThroughSequence: 5,
      expectedVersion: 3,
    });
    expect(read).toMatchObject({ unread: false, activelyWorking: false, attentionVersion: 4 });

    const active = await setSessionAttention(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: target.id,
      activelyWorking: true,
      expectedVersion: 4,
    });
    expect(active).toMatchObject({ unread: false, activelyWorking: true, attentionVersion: 5 });

    await executeSessionActivity(
      workspace.workspaceId,
      sql`update sessions set last_sequence = 6 where id = ${target.id}`,
    );
    expect(await getSessionForSubject(db, workspace.workspaceId, target.id, subject)).toMatchObject(
      { unread: true, activelyWorking: true, attentionVersion: 5 },
    );
    expect(
      await getSessionForSubject(db, workspace.workspaceId, target.id, otherSubject),
    ).toMatchObject({ unread: true, activelyWorking: false, attentionVersion: 0 });

    await expect(
      setSessionAttention(db, {
        workspaceId: workspace.workspaceId,
        subjectId: subject,
        sessionId: target.id,
        unread: false,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(SessionAttentionVersionConflictError);
  });

  test("archives a root chat personally, hides its tree, and restores it", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const root = await session({ ...workspace, message: "archive root" });
    const child = await session({
      ...workspace,
      message: "archive child",
      parentSessionId: root.id,
    });
    const subject = "user:archive-one";
    const otherSubject = "user:archive-two";
    await grantMember(workspace, subject);
    await grantMember(workspace, otherSubject);
    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: root.id,
      pinned: true,
    });
    await setSessionAttention(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: root.id,
      activelyWorking: true,
    });

    const archived = await setSessionArchive(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: root.id,
      archived: true,
      expectedVersion: 0,
    });
    expect(archived).toMatchObject({
      archived: true,
      archiveVersion: 1,
      pinned: false,
      activelyWorking: false,
    });

    const activePage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: subject,
      limit: 20,
    });
    expect([...activePage.pinned, ...activePage.sessions].map((row) => row.id)).not.toContain(
      root.id,
    );
    const activeChildren = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: subject,
      parentSessionId: root.id,
      limit: 20,
    });
    expect(activeChildren.sessions.map((row) => row.id)).not.toContain(child.id);

    const archivedPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: subject,
      archivedOnly: true,
      parentSessionId: null,
      limit: 20,
    });
    expect(archivedPage.sessions.map((row) => row.id)).toContain(root.id);
    expect(
      (
        await listSessionsForSubject(db, workspace.workspaceId, {
          subjectId: otherSubject,
          limit: 20,
        })
      ).sessions.map((row) => row.id),
    ).toContain(root.id);

    await expect(
      setSessionArchive(db, {
        workspaceId: workspace.workspaceId,
        subjectId: subject,
        sessionId: root.id,
        archived: false,
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(SessionArchiveVersionConflictError);
    const restored = await setSessionArchive(db, {
      workspaceId: workspace.workspaceId,
      subjectId: subject,
      sessionId: root.id,
      archived: false,
      expectedVersion: 1,
    });
    expect(restored).toMatchObject({ archived: false, archiveVersion: 2 });
    expect(
      (
        await listSessionsForSubject(db, workspace.workspaceId, {
          subjectId: subject,
          limit: 20,
        })
      ).sessions.map((row) => row.id),
    ).toContain(root.id);
  });

  test("serves concurrent first pages from the same bounded revision keyset", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:concurrent-list-readers";
    await grantMember(workspace, subjectId);
    await executeSessionActivity(
      workspace.workspaceId,
      sql`
      insert into sessions (
        id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
        sandbox_backend, sandbox_group_id, tool_policy
      )
      select generated.id, ${workspace.accountId}, ${workspace.workspaceId},
        'bounded concurrent session ' || generated.ordinality,
        'test-model', 'medium', 'standard', 'none', generated.id,
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      from (
        select gen_random_uuid() as id, ordinality
        from generate_series(1, 128) with ordinality
      ) generated`,
    );

    const pages = await Promise.all(
      Array.from({ length: 16 }, () =>
        listSessionsForSubject(db, workspace.workspaceId, {
          subjectId,
          limit: 1,
        }),
      ),
    );
    const cursors = pages.map((page) => decodeSessionListCursor(page.nextCursor!));
    expect(cursors.every((cursor) => cursor !== null)).toBe(true);
    expect(cursors.every((cursor) => cursor?.kind === "keyset")).toBe(true);
    expect(new Set(cursors.map((cursor) => JSON.stringify(cursor))).size).toBe(1);
    expect(new Set(pages.map((page) => page.sessions[0]?.id)).size).toBe(1);
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from session_list_snapshots
      where workspace_id = ${workspace.workspaceId}
        and subject_id = ${subjectId}`;
    expect(count?.count).toBe(0);
  }, 60_000);

  test("paginates more than 5,000 sessions without materializing their ids", async () => {
    if (!available) return;
    const oversized = await freshWorkspace();
    const oversizedSubject = "user:oversized-list";
    await grantMember(oversized, oversizedSubject);
    await executeSessionActivity(
      oversized.workspaceId,
      sql`
      insert into sessions (
        id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
        sandbox_backend, sandbox_group_id, tool_policy
      )
      select generated.id, ${oversized.accountId}, ${oversized.workspaceId},
        'oversized session ' || generated.ordinality,
        'test-model', 'medium', 'standard', 'none', generated.id,
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      from (
        select gen_random_uuid() as id, ordinality
        from generate_series(1, 5001) with ordinality
      ) generated`,
    );
    const first = await listSessionsForSubject(db, oversized.workspaceId, {
      subjectId: oversizedSubject,
      limit: 50,
    });
    expect(first.sessions).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const cursor = decodeSessionListCursor(first.nextCursor!);
    expect(cursor?.kind).toBe("keyset");
    const second = await listSessionsForSubject(db, oversized.workspaceId, {
      subjectId: oversizedSubject,
      limit: 50,
      cursor: cursor!,
    });
    expect(second.sessions).toHaveLength(50);
    expect(new Set([...first.sessions, ...second.sessions].map((row) => row.id)).size).toBe(100);
    const [oversizedCount] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_list_snapshots
      where workspace_id = ${oversized.workspaceId} and subject_id = ${oversizedSubject}`;
    expect(oversizedCount?.count).toBe(0);
  }, 60_000);

  test("keeps independent search cursors without server-side snapshot state", async () => {
    if (!available) return;
    const quota = await freshWorkspace();
    const quotaSubject = "user:snapshot-quota";
    const retainedSubject = "user:snapshot-quota-retained";
    await grantMember(quota, quotaSubject);
    await grantMember(quota, retainedSubject);
    await executeSessionActivity(
      quota.workspaceId,
      sql`
      insert into sessions (
        id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
        sandbox_backend, sandbox_group_id, tool_policy
      )
      select generated.id, ${quota.accountId}, ${quota.workspaceId},
        'snapshot query-' || lpad(((generated.ordinality - 1) / 2)::text, 2, '0'),
        'test-model', 'medium', 'standard', 'none', generated.id,
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      from (
        select gen_random_uuid() as id, ordinality
        from generate_series(1, 68) with ordinality
      ) generated`,
    );

    const retainedPage = await listSessionsForSubject(db, quota.workspaceId, {
      subjectId: retainedSubject,
      search: "snapshot query-00",
      limit: 1,
    });
    const retainedCursor = decodeSessionListCursor(retainedPage.nextCursor!);
    expect(retainedCursor).not.toBeNull();

    const searchCursors = [];
    for (let index = 0; index < 34; index += 1) {
      const search = `snapshot query-${String(index).padStart(2, "0")}`;
      const page = await listSessionsForSubject(db, quota.workspaceId, {
        subjectId: quotaSubject,
        search,
        limit: 1,
      });
      expect(page.sessions).toHaveLength(1);
      const cursor = decodeSessionListCursor(page.nextCursor!);
      expect(cursor?.kind).toBe("keyset");
      searchCursors.push(cursor!);
    }

    // Clearing search creates another first page instead of reproducing the
    // production 429/empty-state trap.
    const cleared = await listSessionsForSubject(db, quota.workspaceId, {
      subjectId: quotaSubject,
      limit: 1,
    });
    const clearedCursor = decodeSessionListCursor(cleared.nextCursor!);
    expect(cleared.sessions).toHaveLength(1);
    expect(clearedCursor).not.toBeNull();
    const clearedContinuation = await listSessionsForSubject(db, quota.workspaceId, {
      subjectId: quotaSubject,
      cursor: clearedCursor!,
      limit: 1,
    });
    expect(clearedContinuation.sessions).toHaveLength(1);
    expect(clearedContinuation.sessions[0]!.id).not.toBe(cleared.sessions[0]!.id);

    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from session_list_snapshots
      where workspace_id = ${quota.workspaceId}`;
    expect(count?.count).toBe(0);

    // Cursors are self-contained, subject-filtered keysets. Creating many
    // searches cannot evict the oldest cursor or another subject's cursor.
    await expect(
      listSessionsForSubject(db, quota.workspaceId, {
        subjectId: quotaSubject,
        search: "snapshot query-00",
        cursor: searchCursors[0]!,
        limit: 1,
      }),
    ).resolves.toMatchObject({ sessions: [{ initialMessage: "snapshot query-00" }] });
    await expect(
      listSessionsForSubject(db, quota.workspaceId, {
        subjectId: retainedSubject,
        search: "snapshot query-00",
        cursor: retainedCursor!,
        limit: 1,
      }),
    ).resolves.toMatchObject({ sessions: [{ initialMessage: "snapshot query-00" }] });
  }, 60_000);

  test("rejects a stale pin mutation after removal wins the personal-state fence", async () => {
    if (!available || !shared) return;
    const workspace = await freshWorkspace();
    const foreign = await freshWorkspace();
    const subjectId = "user:pin-removal-first";
    const retainedSubject = "user:pin-removal-retained";
    await grantMember(workspace, subjectId);
    await grantMember(workspace, retainedSubject);
    await grantMember(foreign, subjectId);
    const target = await session({ ...workspace, message: "pin removal-first target" });
    const retainedTarget = await session({ ...workspace, message: "pin retained target" });
    const foreignTarget = await session({ ...foreign, message: "pin foreign target" });
    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: retainedSubject,
      sessionId: retainedTarget.id,
      pinned: true,
    });
    await setSessionPin(db, {
      workspaceId: foreign.workspaceId,
      subjectId,
      sessionId: foreignTarget.id,
      pinned: true,
    });

    const barrier = postgres(shared.adminUrl, { max: 1 });
    const removalClient = createDb(shared.appUrl, { max: 1 });
    const pinClient = createDb(shared.appUrl, { max: 1 });
    const barrierClass = 81326029;
    const removalLock = 1;
    const triggerFunction = "sessionpin_test_pin_removal_first_barrier";
    const triggerName = "sessionpin_test_pin_removal_first_membership_barrier";
    let removalPromise: Promise<boolean> | null = null;
    let pinPromise: Promise<Awaited<ReturnType<typeof setSessionPin>>> | null = null;
    try {
      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${barrierClass}, ${removalLock});
          return old;
        end
        $$;
        create trigger ${triggerName}
          before delete on workspace_memberships
          for each row when (
            old.workspace_id = '${workspace.workspaceId}'::uuid
            and old.subject_id = '${subjectId}'
          ) execute function ${triggerFunction}();
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${removalLock})`;

      removalPromise = removeMemberAsAdmin(removalClient.db, workspace, subjectId);
      await waitForAdvisoryWait(admin, barrierClass, removalLock);

      // The API grant is intentionally stale: the pin transaction must wait on
      // the same membership row rather than recreate a pin after removal.
      pinPromise = setSessionPin(pinClient.db, {
        workspaceId: workspace.workspaceId,
        subjectId,
        sessionId: target.id,
        pinned: true,
      });
      await waitForDatabaseQueryWait(admin, "pg_advisory_xact_lock");

      await barrier`select pg_advisory_unlock(${barrierClass}, ${removalLock})`;
      expect(await removalPromise).toBe(true);
      await expect(pinPromise).rejects.toBeInstanceOf(SessionPinAccessError);

      const [counts] = await admin<
        {
          memberships: number;
          removedPins: number;
          retainedPins: number;
          foreignPins: number;
          orphans: number;
        }[]
      >`
        select
          (select count(*)::int from workspace_memberships
            where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as memberships,
          (select count(*)::int from session_pins
            where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as "removedPins",
          (select count(*)::int from session_pins
            where workspace_id = ${workspace.workspaceId} and subject_id = ${retainedSubject}) as "retainedPins",
          (select count(*)::int from session_pins
            where workspace_id = ${foreign.workspaceId} and subject_id = ${subjectId}) as "foreignPins",
          (select count(*)::int
            from session_pins pin
            left join workspace_memberships membership
              on membership.workspace_id = pin.workspace_id
             and membership.subject_id = pin.subject_id
            where pin.workspace_id = ${workspace.workspaceId}
              and membership.id is null) as orphans`;
      expect(counts).toEqual({
        memberships: 0,
        removedPins: 0,
        retainedPins: 1,
        foreignPins: 1,
        orphans: 0,
      });
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${triggerName} on workspace_memberships;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([pinPromise, removalPromise].filter(Boolean));
      await pinClient.close().catch(() => undefined);
      await removalClient.close().catch(() => undefined);
    }
  }, 60_000);

  test("lets removal clean a pin committed while it waits on the personal-state fence", async () => {
    if (!available || !shared) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:pin-mutation-first";
    await grantMember(workspace, subjectId);
    const target = await session({ ...workspace, message: "pin mutation-first target" });

    const barrier = postgres(shared.adminUrl, { max: 1 });
    const removalClient = createDb(shared.appUrl, { max: 1 });
    const pinClient = createDb(shared.appUrl, { max: 1 });
    const barrierClass = 81326030;
    const pinInsertLock = 1;
    const triggerFunction = "sessionpin_test_pin_mutation_first_barrier";
    const triggerName = "sessionpin_test_pin_mutation_first_insert_barrier";
    let removalPromise: Promise<boolean> | null = null;
    let pinPromise: Promise<Awaited<ReturnType<typeof setSessionPin>>> | null = null;
    try {
      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${barrierClass}, ${pinInsertLock});
          return new;
        end
        $$;
        create trigger ${triggerName}
          before insert on session_pins
          for each row when (
            new.workspace_id = '${workspace.workspaceId}'::uuid
            and new.subject_id = '${subjectId}'
          ) execute function ${triggerFunction}();
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${pinInsertLock})`;

      pinPromise = setSessionPin(pinClient.db, {
        workspaceId: workspace.workspaceId,
        subjectId,
        sessionId: target.id,
        pinned: true,
      });
      await waitForAdvisoryWait(admin, barrierClass, pinInsertLock);

      // Pin mutation owns membership first; removal waits, then cleans the
      // committed pin after the insert barrier is released.
      removalPromise = removeMemberAsAdmin(removalClient.db, workspace, subjectId);
      await waitForDatabaseQueryWait(admin, "pg_advisory_xact_lock");

      await barrier`select pg_advisory_unlock(${barrierClass}, ${pinInsertLock})`;
      expect(await pinPromise).not.toBeNull();
      expect(await removalPromise).toBe(true);

      const [counts] = await admin<{ memberships: number; pins: number; orphans: number }[]>`
        select
          (select count(*)::int from workspace_memberships
            where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as memberships,
          (select count(*)::int from session_pins
            where workspace_id = ${workspace.workspaceId} and subject_id = ${subjectId}) as pins,
          (select count(*)::int
            from session_pins pin
            left join workspace_memberships membership
              on membership.workspace_id = pin.workspace_id
             and membership.subject_id = pin.subject_id
            where pin.workspace_id = ${workspace.workspaceId}
              and membership.id is null) as orphans`;
      expect(counts).toEqual({ memberships: 0, pins: 0, orphans: 0 });
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${triggerName} on session_pins;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([pinPromise, removalPromise].filter(Boolean));
      await pinClient.close().catch(() => undefined);
      await removalClient.close().catch(() => undefined);
    }
  }, 60_000);

  test("returns no cross-workspace target and cascades a deleted session's pins", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const foreign = await freshWorkspace();
    await grantMember(workspace, "user:one");
    await grantMember(foreign, "user:one");
    const target = await session({ ...workspace, message: "delete pin target" });
    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId: "user:one",
      sessionId: target.id,
      pinned: true,
    });
    expect(
      await setSessionPin(db, {
        workspaceId: foreign.workspaceId,
        subjectId: "user:one",
        sessionId: target.id,
        pinned: true,
      }),
    ).toBeNull();
    let malformedError: unknown;
    try {
      await admin`
        insert into session_pins
          (account_id, workspace_id, subject_id, session_id, pinned, pinned_at)
        values
          (${foreign.accountId}, ${workspace.workspaceId}, 'malformed:account', ${target.id}, true, now())`;
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toBeDefined();
    await admin`delete from sessions where id = ${target.id}`;
    const pins = await admin<{ count: number }[]>`
      select count(*)::int as count from session_pins where session_id = ${target.id}`;
    expect(pins[0]!.count).toBe(0);
    const invisible = await withWorkspaceRls(
      db,
      foreign.workspaceId,
      async (scoped) =>
        await scoped.execute(
          sql`select id from session_pins where workspace_id = ${workspace.workspaceId}`,
        ),
    );
    expect(invisible).toEqual([]);
    expect(await getSessionForSubject(db, workspace.workspaceId, target.id, "user:one")).toBeNull();
  }, 60_000);
});
