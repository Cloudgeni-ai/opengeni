import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  decodeSessionListCursor,
  getSessionForSubject,
  grantWorkspaceAccess,
  listSessionsForSubject,
  removeWorkspaceMember,
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
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function session(input: { accountId: string; workspaceId: string; message: string }) {
  return await createSession(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: input.message,
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "none",
  });
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
});

describe("session pins (real PostgreSQL + FORCE RLS)", () => {
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

  test("keeps a session that moves above the cursor in its snapshot continuation", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
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

  test("treats percent, underscore, and backslash as literal search text", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
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

  test("removing a workspace member atomically cleans that subject's pins", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:removed-member";
    await grantWorkspaceAccess(db, {
      ...workspace,
      subjectId,
      permissions: ["sessions:read"],
    });
    const target = await session({ ...workspace, message: "removed member pin" });
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
  }, 60_000);

  test("returns no cross-workspace target and cascades a deleted session's pins", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const foreign = await freshWorkspace();
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
