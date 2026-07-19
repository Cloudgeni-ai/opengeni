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
  SessionListAccessError,
  SessionListCursorError,
  SessionListCursorExpiredError,
  SessionPinAccessError,
  SessionPinVersionConflictError,
  setSessionPin,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type Database,
  type DbClient,
} from "../src/index";
import { sql } from "drizzle-orm";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('session-pins-account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'session-pins-workspace') returning id`;
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
    sandboxBackend: "none",
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
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

async function waitForAdvisoryWaitCount(
  connection: postgres.Sql,
  classId: number,
  objectId: number,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ waiting: number }[]>`
      select count(*)::int as waiting
      from pg_locks
      where locktype = 'advisory'
        and classid = ${classId}
        and objid = ${objectId}
        and not granted`;
    if ((row?.waiting ?? 0) >= minimum) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${minimum} advisory locks on ${classId}/${objectId}`);
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
    await admin`
      update sessions
      set status = case
        when id = ${child.id} then 'running'
        when id = ${grandchild.id} then 'requires_action'
        else status
      end
      where id in (${child.id}, ${grandchild.id})`;

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
    });
    expect(roots.sessions.some((row) => row.id === child.id)).toBe(false);

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
    });
  });

  test("reaps expired list snapshots outside request transactions", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await grantMember(workspace, "user:reaper");
    await session({ ...workspace, message: "one" });
    await session({ ...workspace, message: "two" });
    const page = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:reaper",
      limit: 1,
    });
    const cursor = decodeSessionListCursor(page.nextCursor!);
    expect(cursor).not.toBeNull();
    await admin`
      update session_list_snapshots
      set expires_at = now() - interval '1 second'
      where id = ${cursor!.snapshotId}`;

    expect(await reapExpiredSessionListSnapshots(db, 5000)).toBeGreaterThanOrEqual(1);
    const [remaining] = await admin<{ present: boolean }[]>`
      select exists(select 1 from session_list_snapshots where id = ${cursor!.snapshotId}) as present`;
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
    await admin`
      update sessions set updated_at = now() - interval '4 minutes' where id = ${older.id}`;
    await admin`
      update sessions set updated_at = now() - interval '3 minutes' where id = ${pinnedFirst.id}`;
    await admin`
      update sessions set updated_at = now() - interval '2 minutes' where id = ${pinnedSecond.id}`;
    await admin`
      update sessions set updated_at = now() - interval '1 minute' where id = ${newer.id}`;

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

  test("lists for non-member api_key subjects — workspace-scoped keys have no membership row", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    // Deliberately NO grantMember for this subject: a workspace-scoped API key
    // is authorized by requireAccessGrant from its api_keys row, never through
    // a workspace_memberships row. Listing must work anyway (this is the geni
    // fleet-view regression: OPE-26's membership gate 403'd every api_key
    // principal platform-wide).
    const apiKeySubject = "api_key:00000000-0000-4000-8000-000000000001";
    const first = await session({ ...workspace, message: "api key first" });
    const second = await session({ ...workspace, message: "api key second" });
    await admin`
      update sessions set updated_at = now() - interval '1 minute' where id = ${first.id}`;

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

  test("keeps a session that moves above the cursor in its snapshot continuation", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await grantMember(workspace, "user:snapshot");
    const oldest = await session({ ...workspace, message: "snapshot oldest" });
    const middle = await session({ ...workspace, message: "snapshot middle" });
    const newest = await session({ ...workspace, message: "snapshot newest" });
    await admin`
      update sessions
      set updated_at = now() - interval '3 minutes'
      where id = ${oldest.id}`;
    await admin`
      update sessions
      set updated_at = now() - interval '2 minutes'
      where id = ${middle.id}`;
    await admin`
      update sessions
      set updated_at = now() - interval '1 minute'
      where id = ${newest.id}`;

    const firstPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:snapshot",
      limit: 1,
    });
    expect(firstPage.sessions.map((row) => row.id)).toEqual([newest.id]);
    const cursor = decodeSessionListCursor(firstPage.nextCursor!);
    expect(cursor).toMatchObject({ offset: 1, search: null, parentSessionFilter: "all" });

    // This is the race the old updated_at cursor could lose: the row was below
    // page one, then became newer than page one's tail before page two.
    await admin`
      update sessions set updated_at = now() + interval '1 minute' where id = ${middle.id}`;

    const secondPage = await listSessionsForSubject(db, workspace.workspaceId, {
      subjectId: "user:snapshot",
      limit: 1,
      cursor: cursor!,
    });
    expect(secondPage.sessions.map((row) => row.id)).toEqual([middle.id]);
    expect(secondPage.sessions.map((row) => row.id)).not.toContain(newest.id);
    expect(secondPage.nextCursor).toBeTruthy();
  }, 60_000);

  test("distinguishes invalid cursor semantics from missing or expired snapshots", async () => {
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

    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId,
        limit: 1,
        cursor: { ...cursor!, search: "different-filter" },
      }),
    ).rejects.toBeInstanceOf(SessionListCursorError);
    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId,
        limit: 1,
        cursor: { ...cursor!, offset: Number.MAX_SAFE_INTEGER },
      }),
    ).rejects.toBeInstanceOf(SessionListCursorError);

    await admin`delete from session_list_snapshots where id = ${cursor!.snapshotId}`;
    await expect(
      listSessionsForSubject(db, workspace.workspaceId, {
        subjectId,
        limit: 1,
        cursor: cursor!,
      }),
    ).rejects.toBeInstanceOf(SessionListCursorExpiredError);
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

    await setSessionPin(db, {
      workspaceId: workspace.workspaceId,
      subjectId,
      sessionId: target.id,
      pinned: true,
    });

    expect(await removeWorkspaceMember(db, workspace.workspaceId, subjectId)).toBe(true);
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

  test("serializes stale authorized listing and removal in both lock orderings", async () => {
    if (!available || !shared) return;
    const workspace = await freshWorkspace();
    const foreign = await freshWorkspace();
    const staleSubject = "user:stale-list";
    const lockedSubject = "user:locked-list";
    const retainedSubject = "user:retained-list";

    await grantMember(workspace, staleSubject);
    await grantMember(workspace, lockedSubject);
    await grantMember(workspace, retainedSubject);
    await grantMember(foreign, lockedSubject);

    const staleTarget = await session({ ...workspace, message: "stale list first" });
    await session({ ...workspace, message: "stale list second" });
    await session({ ...workspace, message: "locked list first" });
    const lockedTarget = await session({ ...workspace, message: "locked list second" });
    await session({ ...workspace, message: "locked list third" });
    await session({ ...workspace, message: "retained list first" });
    await session({ ...workspace, message: "retained list second" });
    await session({ ...foreign, message: "foreign list first" });
    await session({ ...foreign, message: "foreign list second" });

    // Ordering A: the API already obtained a grant, then removal commits before
    // the listing transaction starts. The live membership check must reject
    // before expiry cleanup or snapshot insertion.
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
    expect(await removeWorkspaceMember(db, workspace.workspaceId, staleSubject)).toBe(true);
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

    const barrier = postgres(shared.adminUrl, { max: 1 });
    const barrierClass = 81326026;
    const listingLock = 1;
    const removalLock = 2;
    const triggerFunction = "ope26_test_lock_barrier";
    const snapshotTrigger = "ope26_test_snapshot_lock_barrier";
    const membershipTrigger = "ope26_test_membership_lock_barrier";
    const listingClient = createDb(shared.appUrl, { max: 1 });
    const removalClient = createDb(shared.appUrl, { max: 1 });
    let listingPromise: Promise<Awaited<ReturnType<typeof listSessionsForSubject>>> | null = null;
    let removalPromise: Promise<boolean> | null = null;
    try {
      // Ordering B uses a native database barrier: the snapshot INSERT trigger
      // blocks after the listing has locked membership; the DELETE trigger then
      // blocks after removal has waited, cleaned the snapshot, and locked the
      // membership row for deletion.
      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          if tg_argv[0] = 'snapshot' then
            perform pg_advisory_xact_lock(${barrierClass}, ${listingLock});
          else
            perform pg_advisory_xact_lock(${barrierClass}, ${removalLock});
          end if;
          return case when tg_op = 'DELETE' then old else new end;
        end
        $$;
        create trigger ${snapshotTrigger}
          before insert on session_list_snapshots
          for each row execute function ${triggerFunction}('snapshot');
        create trigger ${membershipTrigger}
          before delete on workspace_memberships
          for each row when (
            old.workspace_id = '${workspace.workspaceId}'::uuid
            and old.subject_id = '${lockedSubject}'
          ) execute function ${triggerFunction}('membership');
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${listingLock})`;
      await barrier`select pg_advisory_lock(${barrierClass}, ${removalLock})`;

      await setSessionPin(db, {
        workspaceId: workspace.workspaceId,
        subjectId: lockedSubject,
        sessionId: lockedTarget.id,
        pinned: true,
      });

      listingPromise = listSessionsForSubject(listingClient.db, workspace.workspaceId, {
        subjectId: lockedSubject,
        limit: 1,
      });
      await waitForAdvisoryWait(admin, barrierClass, listingLock);

      let removalSettled = false;
      removalPromise = removeWorkspaceMember(
        removalClient.db,
        workspace.workspaceId,
        lockedSubject,
      ).then((removed) => {
        removalSettled = true;
        return removed;
      });

      await barrier`select pg_advisory_unlock(${barrierClass}, ${listingLock})`;
      const listed = await listingPromise;
      expect(listed.nextCursor).toBeTruthy();
      await waitForAdvisoryWait(admin, barrierClass, removalLock);
      expect(removalSettled).toBe(false);

      await barrier`select pg_advisory_unlock(${barrierClass}, ${removalLock})`;
      expect(await removalPromise).toBe(true);

      const retained = await listSessionsForSubject(db, workspace.workspaceId, {
        subjectId: retainedSubject,
        limit: 1,
      });
      const foreignPage = await listSessionsForSubject(db, foreign.workspaceId, {
        subjectId: lockedSubject,
        limit: 1,
      });
      expect(retained.nextCursor).toBeTruthy();
      expect(foreignPage.nextCursor).toBeTruthy();

      const [counts] = await admin<
        {
          removedMemberships: number;
          removedPins: number;
          removedSnapshots: number;
          retainedSnapshots: number;
          foreignSnapshots: number;
          targetOrphans: number;
        }[]
      >`
        select
          (select count(*)::int from workspace_memberships
            where workspace_id = ${workspace.workspaceId} and subject_id = ${lockedSubject}) as "removedMemberships",
          (select count(*)::int from session_pins
            where workspace_id = ${workspace.workspaceId} and subject_id = ${lockedSubject}) as "removedPins",
          (select count(*)::int from session_list_snapshots
            where workspace_id = ${workspace.workspaceId} and subject_id = ${lockedSubject}) as "removedSnapshots",
          (select count(*)::int from session_list_snapshots
            where workspace_id = ${workspace.workspaceId} and subject_id = ${retainedSubject}) as "retainedSnapshots",
          (select count(*)::int from session_list_snapshots
            where workspace_id = ${foreign.workspaceId} and subject_id = ${lockedSubject}) as "foreignSnapshots",
          (select count(*)::int
            from session_list_snapshots snapshot
            left join workspace_memberships membership
              on membership.workspace_id = snapshot.workspace_id
             and membership.subject_id = snapshot.subject_id
            where snapshot.workspace_id = ${workspace.workspaceId}
              and membership.id is null) as "targetOrphans"`;
      expect(counts).toEqual({
        removedMemberships: 0,
        removedPins: 0,
        removedSnapshots: 0,
        retainedSnapshots: 1,
        foreignSnapshots: 1,
        targetOrphans: 0,
      });
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${snapshotTrigger} on session_list_snapshots;
        drop trigger if exists ${membershipTrigger} on workspace_memberships;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([listingPromise, removalPromise].filter(Boolean));
      await listingClient.close().catch(() => undefined);
      await removalClient.close().catch(() => undefined);
    }
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
    const triggerFunction = "ope26_test_removal_first_barrier";
    const triggerName = "ope26_test_removal_first_membership_barrier";
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

      removalPromise = removeWorkspaceMember(removalClient.db, workspace.workspaceId, subjectId);
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

    const triggerFunction = "ope26_test_read_committed_guard";
    const triggerName = "ope26_test_read_committed_snapshot_guard";
    let ambientClient: DbClient | null = null;
    const failures: unknown[] = [];
    try {
      await admin.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          if current_setting('transaction_isolation') <> 'read committed' then
            raise exception 'session listing isolation must be read committed, got %',
              current_setting('transaction_isolation');
          end if;
          return new;
        end
        $$;
        create trigger ${triggerName}
          before insert on session_list_snapshots
          for each row when (
            new.workspace_id = '${workspace.workspaceId}'::uuid
            and new.subject_id = '${subjectId}'
          ) execute function ${triggerFunction}();
      `);
      // The startup parameter applies only to this postgres-js pool. The
      // direct query proves this connection inherited REPEATABLE READ; the
      // snapshot trigger then proves listSessionsForSubject overrides it
      // inside the real transaction without mutating a shared role default.
      ambientClient = createDb(shared.appUrl, {
        max: 1,
        isolationLevel: "repeatable read",
      });
      const ambient = await ambientClient.db.execute<{ default_transaction_isolation: string }>(
        sql`show default_transaction_isolation`,
      );
      expect(ambient).toEqual([{ default_transaction_isolation: "repeatable read" }]);

      const page = await listSessionsForSubject(ambientClient.db, workspace.workspaceId, {
        subjectId,
        limit: 1,
      });
      expect(page.sessions).toHaveLength(1);
      expect(page.nextCursor).toBeTruthy();
    } catch (error) {
      failures.push(error);
    } finally {
      await ambientClient?.close().catch(() => undefined);
      const cleanup = await Promise.allSettled([
        admin.unsafe(`
          drop trigger if exists ${triggerName} on session_list_snapshots;
          drop function if exists ${triggerFunction}();
        `),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "read-committed isolation test or cleanup failed");
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

  test("allows concurrent list readers through the shared personal-state fence", async () => {
    if (!available || !shared) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:concurrent-list-readers";
    await grantMember(workspace, subjectId);
    await session({ ...workspace, message: "concurrent list first" });
    await session({ ...workspace, message: "concurrent list second" });

    const barrier = postgres(shared.adminUrl, { max: 1 });
    const firstClient = createDb(shared.appUrl, { max: 1 });
    const secondClient = createDb(shared.appUrl, { max: 1 });
    const barrierClass = 81326032;
    const snapshotLock = 1;
    const triggerFunction = "ope26_test_concurrent_list_barrier";
    const triggerName = "ope26_test_concurrent_list_snapshot_barrier";
    let firstListing: Promise<Awaited<ReturnType<typeof listSessionsForSubject>>> | null = null;
    let secondListing: Promise<Awaited<ReturnType<typeof listSessionsForSubject>>> | null = null;
    try {
      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${barrierClass}, ${snapshotLock});
          return new;
        end
        $$;
        create trigger ${triggerName}
          before insert on session_list_snapshots
          for each row when (
            new.workspace_id = '${workspace.workspaceId}'::uuid
            and new.subject_id = '${subjectId}'
          ) execute function ${triggerFunction}();
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${snapshotLock})`;

      firstListing = listSessionsForSubject(firstClient.db, workspace.workspaceId, {
        subjectId,
        limit: 1,
      });
      await waitForAdvisoryWaitCount(barrier, barrierClass, snapshotLock, 1);

      secondListing = listSessionsForSubject(secondClient.db, workspace.workspaceId, {
        subjectId,
        limit: 1,
      });
      // Both transactions must pass the compatible personal-state fence and
      // reach the snapshot barrier. A membership row lock made the second reader
      // wait on the first reader's tuple instead, then abort with 40001.
      await waitForAdvisoryWaitCount(barrier, barrierClass, snapshotLock, 2);

      await barrier`select pg_advisory_unlock(${barrierClass}, ${snapshotLock})`;
      const [first, second] = await Promise.all([firstListing, secondListing]);
      expect(first.nextCursor).toBeTruthy();
      expect(second.nextCursor).toBeTruthy();
      expect(first.sessions.map((row) => row.id)).toEqual(second.sessions.map((row) => row.id));
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${triggerName} on session_list_snapshots;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([firstListing, secondListing].filter(Boolean));
      await firstClient.close().catch(() => undefined);
      await secondClient.close().catch(() => undefined);
    }
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
    const triggerFunction = "ope26_test_pin_removal_first_barrier";
    const triggerName = "ope26_test_pin_removal_first_membership_barrier";
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

      removalPromise = removeWorkspaceMember(removalClient.db, workspace.workspaceId, subjectId);
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
    const triggerFunction = "ope26_test_pin_mutation_first_barrier";
    const triggerName = "ope26_test_pin_mutation_first_insert_barrier";
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
      removalPromise = removeWorkspaceMember(removalClient.db, workspace.workspaceId, subjectId);
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
