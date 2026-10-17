import { withLegacySessionActivityRlsContext } from "./fixtures/legacy-session-activity";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { eq, sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionDiscoverySummaries,
  listSessionsForSubject,
  decodeSessionListCursor,
  withRlsContext,
  withSessionActivityRlsContext,
  type Database,
} from "../src/index";
import {
  withRestoredSessionActivityRlsContext,
  withSessionActivitySavepoint,
} from "../src/database";
import {
  decodeActivityXid,
  encodeActivityXid,
  isActivityXidToken,
} from "../src/session-activity-xid";
import { readInsightsResponseCacheFence } from "../src/insights-unified";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-activity-xid");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 300_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const id = crypto.randomUUID(),
    subjectId = `subject-${id}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Activity xid",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Activity xid",
    subjectId,
  });
  return { ...access.workspaceGrants[0]!, subjectId };
}
type Scope = Awaited<ReturnType<typeof fixture>>;
async function session(scope: Scope, title = "Activity xid test") {
  return createSession(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId!,
    initialMessage: title,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
}
async function state(id: string) {
  const [row] = await shared.admin`select activity_xid::text xid, activity_revision::text revision,
    activity_revision_pending_xid::text pending, updated_at from sessions where id=${id}`;
  return row!;
}
async function touch(db: Database, id: string) {
  await db.update(schema.sessions).set({ updatedAt: new Date() }).where(eq(schema.sessions.id, id));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function monitor(
  scope: Scope,
  updatedAfter?: string,
  limit = 100,
  cursor?: Parameters<typeof listSessionDiscoverySummaries>[2]["cursor"],
) {
  return listSessionDiscoverySummaries(client.db, scope.workspaceId!, {
    limit,
    orderBy: "updatedAt",
    includeLastMessage: false,
    includeWorkDiscovery: false,
    ...(updatedAfter === undefined ? {} : { updatedAfter }),
    ...(cursor ? { cursor } : {}),
  });
}

describe("transaction-ID session activity and rolling gate compatibility", () => {
  test("expanded schema preserves the runtime posture accepted by rolling replicas", async () => {
    await assertRuntimeDatabasePosture(client.db, {
      rlsStrategy: "force",
      expectedRole: "opengeni_app",
    });
  }, 60_000);
  test("relevance keeps committed matches visible behind an older xid and freezes its allocation ceiling", async () => {
    const scope = await fixture(),
      a = await session(scope);
    const written = deferred(),
      release = deferred();
    const older = withSessionActivityRlsContext(client.db, scope, async (tx) => {
      await tx
        .update(schema.sessions)
        .set({ title: "xidsearch", titleSource: "user", updatedAt: new Date() })
        .where(eq(schema.sessions.id, a.id));
      written.resolve();
      await release.promise;
    });
    const named = async () => {
      const row = await session(scope);
      await withSessionActivityRlsContext(client.db, scope, (tx) =>
        tx
          .update(schema.sessions)
          .set({ title: "xidsearch", titleSource: "user", updatedAt: new Date() })
          .where(eq(schema.sessions.id, row.id)),
      );
      return row;
    };
    let first!: Awaited<ReturnType<typeof listSessionDiscoverySummaries>>;
    let b!: Awaited<ReturnType<typeof session>>, c!: Awaited<ReturnType<typeof session>>;
    try {
      await written.promise;
      b = await named();
      c = await named();
      first = await listSessionDiscoverySummaries(client.db, scope.workspaceId!, {
        limit: 1,
        query: "xidsearch",
      });
      expect(first.total).toBe(2);
      expect(first.sessions[0]!.id).toBe(c.id);
      expect(first.nextCursor).not.toBeNull();
    } finally {
      release.resolve();
      await older;
    }
    const newer = await named();
    const next = await listSessionDiscoverySummaries(client.db, scope.workspaceId!, {
      limit: 10,
      query: "xidsearch",
      cursor: first.nextCursor!,
    });
    expect(next.snapshotRevision).toBe(first.snapshotRevision);
    expect(new Set(next.sessions.map((row) => row.id))).toEqual(new Set([a.id, b.id]));
    expect(next.sessions.some((row) => row.id === newer.id)).toBe(false);
  }, 30_000);

  test("removing the gate preserves the tenant-context commit proof", async () => {
    const scope = await fixture(),
      other = await fixture(),
      a = await session(scope),
      before = await state(a.id);
    await expect(
      withSessionActivityRlsContext(client.db, scope, async (tx) => {
        await touch(tx, a.id);
        await tx.execute(sql`select set_config('opengeni.workspace_id',${other.workspaceId},true)`);
      }),
    ).rejects.toThrow("RLS context not applied");
    expect((await state(a.id)).xid).toBe(before.xid);
  });

  test("a deferred failure rolls back the row stamp together with the transaction", async () => {
    const scope = await fixture(),
      a = await session(scope),
      before = await state(a.id);
    await expect(
      withSessionActivityRlsContext(client.db, scope, async (tx) => {
        await tx.execute(sql`set constraints all deferred`);
        await touch(tx, a.id);
        await tx
          .update(schema.sessions)
          .set({ parentSessionId: crypto.randomUUID() })
          .where(eq(schema.sessions.id, a.id));
      }),
    ).rejects.toThrow();
    expect((await state(a.id)).xid).toBe(before.xid);
  });

  test("stamps inserts and semantic updates once, without advancing the workspace counter", async () => {
    const scope = await fixture(),
      row = await session(scope);
    const before = await state(row.id);
    expect(BigInt(before.xid)).toBeGreaterThan(0n);
    expect(before.pending).toBeNull();
    await withSessionActivityRlsContext(client.db, scope, async (tx) => {
      await touch(tx, row.id);
      const [xid] = (await tx.execute(sql`select pg_current_xact_id()::text xid`)) as unknown as {
        xid: string;
      }[];
      const [stamped] = await tx
        .select({ xid: schema.sessions.activityXid })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, row.id));
      expect(stamped!.xid).toBe(xid!.xid);
    });
    const after = await state(row.id);
    expect(BigInt(after.xid)).toBeGreaterThan(BigInt(before.xid));
    expect(after.revision).toBe(before.revision);
    expect(after.pending).toBeNull();
    const [counter] =
      await shared.admin`select revision::text from workspace_session_activity_revisions where workspace_id=${scope.workspaceId}`;
    expect(counter!.revision).toBe("0");
  });

  test("different sessions in one workspace commit concurrently, without a counter-row lock", async () => {
    const scope = await fixture(),
      a = await session(scope),
      b = await session(scope);
    const written = deferred(),
      release = deferred();
    const first = withSessionActivityRlsContext(client.db, scope, async (tx) => {
      await touch(tx, a.id);
      written.resolve();
      await release.promise;
    });
    try {
      await written.promise;
      await withSessionActivityRlsContext(client.db, scope, async (tx) => {
        await tx.execute(sql`set local statement_timeout='2s'`);
        await touch(tx, b.id);
      });
      // The second transaction has COMMITTED while the first remains open.
      expect((await state(b.id)).pending).toBeNull();
      const [locks] = await shared.admin`select count(*)::int count from pg_locks
        where database=(select oid from pg_database where datname=current_database())
          and relation='workspace_session_activity_revisions'::regclass and mode='RowExclusiveLock'`;
      expect(locks!.count).toBe(0);
    } finally {
      release.resolve();
      await first;
    }
  }, 30_000);

  test("xmin polling delivers a lower xid that commits after a higher xid, with at-least-once replay", async () => {
    const scope = await fixture(),
      a = await session(scope),
      b = await session(scope);
    const baseline = await monitor(scope);
    const written = deferred(),
      release = deferred();
    let lowXid = "0";
    const first = withSessionActivityRlsContext(client.db, scope, async (tx) => {
      await touch(tx, a.id);
      const [r] = await tx
        .select({ xid: schema.sessions.activityXid })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, a.id));
      lowXid = r!.xid;
      written.resolve();
      await release.promise;
    });
    let through = "0";
    try {
      await written.promise;
      await withSessionActivityRlsContext(client.db, scope, (tx) => touch(tx, b.id));
      expect(BigInt((await state(b.id)).xid)).toBeGreaterThan(BigInt(lowXid));
      const page = await monitor(scope, baseline.updatedThrough!);
      expect(page.sessions.some((r) => r.id === b.id)).toBe(true);
      through = page.updatedThrough!;
      expect(BigInt(decodeActivityXid(through))).toBeLessThanOrEqual(BigInt(lowXid));
    } finally {
      release.resolve();
      await first;
    }
    const next = await monitor(scope, through);
    expect(next.sessions.some((r) => r.id === a.id)).toBe(true);
    expect(next.sessions.some((r) => r.id === b.id)).toBe(true);
  }, 30_000);

  test("continuation pages retain the first watermark even after an interleaved commit", async () => {
    const scope = await fixture();
    const a = await session(scope),
      b = await session(scope),
      c = await session(scope);
    const written = deferred(),
      release = deferred();
    const first = withSessionActivityRlsContext(client.db, scope, async (tx) => {
      await touch(tx, a.id);
      written.resolve();
      await release.promise;
    });
    let page: Awaited<ReturnType<typeof monitor>>;
    try {
      await written.promise;
      page = await monitor(scope, "0", 1);
      expect(page.nextCursor).not.toBeNull();
    } finally {
      release.resolve();
      await first;
    }
    const second = await monitor(scope, "0", 1, page!.nextCursor!);
    expect(second.updatedThrough).toBe(page!.updatedThrough);
    const next = await monitor(scope, page!.updatedThrough!);
    expect(next.sessions.some((r) => r.id === a.id)).toBe(true);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  }, 30_000);

  test("legacy revision tokens and cursors restart rather than silently missing new-pod writes", async () => {
    const scope = await fixture(),
      a = await session(scope),
      b = await session(scope);
    const page = await monitor(scope, "9223372036854775807", 1);
    expect(page.total).toBe(2);
    expect(isActivityXidToken(page.updatedThrough!)).toBe(true);
    const old = { ...page.nextCursor!, snapshotRevision: "999999", sortRevision: "999998" };
    const restarted = await monitor(scope, "9223372036854775807", 10, old);
    expect(new Set(restarted.sessions.map((r) => r.id))).toEqual(new Set([a.id, b.id]));
  });

  test("plain keysets do not repeat unchanged rows when a later activity moves above the cursor", async () => {
    const scope = await fixture();
    const a = await session(scope),
      b = await session(scope),
      c = await session(scope);
    const page = await monitor(scope, undefined, 1);
    expect(page.nextCursor).not.toBeNull();
    await withSessionActivityRlsContext(client.db, scope, (tx) => touch(tx, a.id));
    const second = await monitor(scope, undefined, 10, page.nextCursor!);
    expect(second.sessions.some((r) => r.id === page.sessions[0]!.id)).toBe(false);
    expect(second.sessions.some((r) => r.id === b.id)).toBe(true);
    expect(second.sessions.some((r) => r.id === a.id)).toBe(false);
    expect(page.sessions[0]!.id).toBe(c.id);
  });

  test("subject list keysets restart legacy cursors and preserve unchanged pagination", async () => {
    const scope = await fixture();
    await session(scope);
    await session(scope);
    await session(scope);
    const page = await listSessionsForSubject(client.db, scope.workspaceId!, {
      subjectId: scope.subjectId,
      limit: 1,
    });
    expect(page.nextCursor).not.toBeNull();
    const cursor = decodeSessionListCursor(page.nextCursor!)!;
    expect(cursor.kind).toBe("keyset");
    const next = await listSessionsForSubject(client.db, scope.workspaceId!, {
      subjectId: scope.subjectId,
      limit: 10,
      cursor,
    });
    expect(next.sessions.some((r) => r.id === page.sessions[0]!.id)).toBe(false);
    if (cursor.kind !== "keyset") throw Error("Expected keyset");
    const restarted = await listSessionsForSubject(client.db, scope.workspaceId!, {
      subjectId: scope.subjectId,
      limit: 10,
      cursor: { ...cursor, snapshotRevision: "100" },
    });
    expect(restarted.sessions).toHaveLength(3);
  });

  test("the old gate path can still mark, finalize and commit after expansion", async () => {
    const scope = await fixture(),
      a = await session(scope);
    const before = await state(a.id);
    await withLegacySessionActivityRlsContext(client.db, scope, (tx) => touch(tx, a.id));
    const after = await state(a.id);
    expect(after.pending).toBeNull();
    expect(after.revision).toBe("1");
    expect(BigInt(after.xid)).toBeGreaterThan(BigInt(before.xid));
  });

  test("rollbacks and savepoints preserve atomic activity and raw writes do not restamp", async () => {
    const scope = await fixture(),
      a = await session(scope),
      before = await state(a.id);
    await expect(
      withSessionActivityRlsContext(client.db, scope, async (tx) => {
        await touch(tx, a.id);
        throw Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await state(a.id)).xid).toBe(before.xid);
    await withSessionActivityRlsContext(client.db, scope, async (tx) => {
      await tx.update(schema.sessions).set({ lastSequence: 0 }).where(eq(schema.sessions.id, a.id));
      await expect(
        withSessionActivitySavepoint(tx, async (nested) => {
          await touch(nested, a.id);
          throw Error("savepoint");
        }),
      ).rejects.toThrow("savepoint");
    });
    expect((await state(a.id)).xid).toBe(before.xid);
  });

  test("sequential caller-owned workspace scopes no longer require a gate", async () => {
    const a = await fixture(),
      b = await fixture(),
      sa = await session(a),
      sb = await session(b);
    await client.db.transaction(async (tx) => {
      await withRestoredSessionActivityRlsContext(tx as unknown as Database, a, (scope) =>
        touch(scope, sa.id),
      );
      await withRestoredSessionActivityRlsContext(tx as unknown as Database, b, (scope) =>
        touch(scope, sb.id),
      );
    });
    expect((await state(sa.id)).xid).toBe((await state(sb.id)).xid);
  });

  test("Insights cache invalidation changes on new-code activity without a counter bump", async () => {
    const scope = await fixture(),
      a = await session(scope);
    const before = await readInsightsResponseCacheFence(client.db, scope);
    expect(before).not.toBeNull();
    await withSessionActivityRlsContext(client.db, scope, (tx) => touch(tx, a.id));
    const after = await readInsightsResponseCacheFence(client.db, scope);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  test("xid tokens preserve unsigned 64-bit precision and legacy tokens replay", () => {
    expect(decodeActivityXid(encodeActivityXid("18446744073709551615"))).toBe(
      "18446744073709551615",
    );
    expect(decodeActivityXid("9223372036854775807")).toBe("0");
  });
});
