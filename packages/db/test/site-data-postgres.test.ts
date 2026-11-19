// Migration 0776: Site Data. The eight site_data_* tables are workspace-owned,
// FORCE RLS and reachable by the application role only inside a workspace
// context; data follows its Site and is removed with the workspace.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  createDb,
  createPostgresSiteDataStore,
  createWorkspace,
  createWorkspaceArtifact,
  SiteDataError,
  withRlsContext,
  type Database,
  type DbClient,
  type SiteDataCaller,
  type SiteDataLimits,
} from "../src/index";
import { rawRows } from "../src/database";

const TABLES = [
  "site_data_changes",
  "site_data_collections",
  "site_data_files",
  "site_data_insert_keys",
  "site_data_rate_windows",
  "site_data_record_values",
  "site_data_records",
  "site_data_usage",
  "site_data_validation_windows",
  "site_data_workspace_validation_windows",
];
const limits: SiteDataLimits = {
  recordBytesPerSite: 1_000_000,
  maxRecordBytes: 10_000,
  maxCollectionsPerSite: 5,
  fileBytesPerSite: 1_000_000,
  maxFileBytes: 100_000,
  workspaceBytes: 10_000_000,
  maxRecordsPerCollection: 1_000,
  viewerWritesPerMinute: 1_000,
  siteWritesPerMinute: 1_000,
  viewerReadsPerMinute: 1_000,
  managerWritesPerMinute: 1_000,
  siteValidationMsPerMinute: 5_000,
  workspaceValidationMsPerMinute: 20_000,
};

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0776-site-data");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function site(existing?: { accountId: string; workspaceId: string }) {
  let accountId = existing?.accountId;
  let workspaceId = existing?.workspaceId;
  if (!accountId || !workspaceId) {
    const [account] =
      await shared.admin`insert into managed_accounts (name) values ('Site data migration') returning id`;
    accountId = String(account!.id);
    workspaceId = (await createWorkspace(client.db, { accountId, name: "Site data" })).id;
  }
  const workspace = { id: workspaceId };
  const created = await createWorkspaceArtifact(client.db, {
    accountId,
    workspaceId: workspace.id,
    artifactId: crypto.randomUUID(),
    slug: `site-data-${crypto.randomUUID().slice(0, 8)}`,
    title: "Site data",
    description: null,
    visibility: "workspace_shared",
    ownerSubjectId: null,
    contentKey: `site-data/${crypto.randomUUID()}.html`,
    contentSha256: "a".repeat(64),
    sizeBytes: 16,
    sourceKey: null,
    sourceSha256: null,
    sourceSizeBytes: null,
    operationKey: crypto.randomUUID(),
    actorSubjectId: "user:site-data-owner",
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
    persistContent: async () => undefined,
    discardContent: async () => undefined,
  });
  const caller: SiteDataCaller = {
    accountId,
    workspaceId: workspace.id,
    siteId: created.artifact.id,
    role: "manager",
    principal: "user:site-data-owner",
    actor: "user:site-data-owner",
    framed: false,
  };
  return { accountId, workspaceId: workspace.id, caller };
}

test("site data tables are FORCE RLS with a workspace policy", async () => {
  const rows = await shared.admin<
    Array<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>
  >`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
    from pg_class c
    where c.relname = any(${TABLES}) and c.relkind = 'r'
    order by c.relname`;
  expect(rows.map((row) => row.relname)).toEqual(TABLES);
  for (const row of rows) {
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
    expect(row.policies).toBeGreaterThan(0);
  }
});

test("records stay in their workspace and are removed with it", async () => {
  const store = createPostgresSiteDataStore(client.db);
  const a = await site();
  const b = await site();
  await store.defineCollection(a.caller, { name: "notes", accessMode: "shared" }, limits);
  await store.write(
    a.caller,
    [{ op: "insert", collection: "notes", key: "one", data: { text: "a" } }],
    { limits },
  );

  // The other tenant cannot reach the Site even by naming it.
  const intruder = { ...b.caller, siteId: a.caller.siteId };
  await expect(store.query(intruder, { collection: "notes" })).rejects.toBeInstanceOf(
    SiteDataError,
  );
  // Without a workspace context the application role sees nothing.
  const [unscoped] = await shared.admin`
    select count(*)::int as count from site_data_records where workspace_id = ${a.workspaceId}`;
  expect(unscoped!.count).toBe(1);
  const app = (await import("postgres")).default(shared.appUrl, { max: 1 });
  try {
    const [hidden] = await app`select count(*)::int as count from site_data_records`;
    expect(hidden!.count).toBe(0);
  } finally {
    await app.end();
  }

  await shared.admin`delete from workspaces where id = ${a.workspaceId}`;
  for (const table of TABLES) {
    const [left] = await shared.admin.unsafe(
      `select count(*)::int as count from ${table} where workspace_id = $1`,
      [a.workspaceId],
    );
    expect(left!.count).toBe(0);
  }
});

test("RLS alone hides another workspace's rows inside a mismatched tenant context", async () => {
  const store = createPostgresSiteDataStore(client.db);
  const a = await site();
  const b = await site();
  await store.defineCollection(a.caller, { name: "notes", accessMode: "shared" }, limits);
  const written = await store.write(
    a.caller,
    [{ op: "insert", collection: "notes", key: "one", data: { text: "a" } }],
    { limits },
  );
  const recordId = (written.results[0] as { record: { id: string } }).record.id;
  const asB = <T>(fn: (tx: Database) => Promise<T>) =>
    withRlsContext(client.db, { accountId: b.accountId, workspaceId: b.workspaceId }, fn);

  // No WHERE on tenant columns: only the policy keeps A's rows out of B's context.
  for (const table of TABLES) {
    const [row] = await asB((tx) =>
      rawRows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from ${sql.identifier(table)}
          where workspace_id = ${a.workspaceId}`,
      ),
    );
    expect(row!.count).toBe(0);
  }
  const [byId] = await asB((tx) =>
    rawRows<{ count: number }>(
      tx,
      sql`select count(*)::int as count from site_data_records where id = ${recordId}`,
    ),
  );
  expect(byId!.count).toBe(0);
  // Writes into A's workspace from B's context are rejected or touch nothing.
  const [updated] = await asB((tx) =>
    rawRows<{ count: number }>(
      tx,
      sql`with changed as (update site_data_records set data = '{}'::jsonb where id = ${recordId} returning 1)
        select count(*)::int as count from changed`,
    ),
  );
  expect(updated!.count).toBe(0);
  await expect(
    asB((tx) =>
      tx.execute(
        sql`insert into site_data_usage (account_id, workspace_id, site_id)
          values (${a.accountId}, ${a.workspaceId}, ${a.caller.siteId})
          on conflict do nothing`,
      ),
    ),
  ).rejects.toThrow();
  // The same statements in A's own context see the row.
  const [own] = await withRlsContext(
    client.db,
    { accountId: a.accountId, workspaceId: a.workspaceId },
    (tx) =>
      rawRows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from site_data_records where id = ${recordId}`,
      ),
  );
  expect(own!.count).toBe(1);
});

test("a record cannot point at another Site than its collection's", async () => {
  const store = createPostgresSiteDataStore(client.db);
  const a = await site();
  const other = await site({ accountId: a.accountId, workspaceId: a.workspaceId });
  await store.defineCollection(a.caller, { name: "notes", accessMode: "shared" }, limits);
  await store.write(
    a.caller,
    [{ op: "insert", collection: "notes", key: "one", data: { text: "a" } }],
    { limits },
  );
  let error: unknown = null;
  try {
    await shared.admin`update site_data_records set site_id = ${other.caller.siteId}
      where workspace_id = ${a.workspaceId}`;
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain("site_data_records_collection_fk");
  const [index] = await shared.admin`
    select indexdef from pg_indexes where indexname = 'site_data_record_values_workspace_record_idx'`;
  expect(String(index!.indexdef)).toContain("(workspace_id, record_id)");
});

test("change numbers count every write; the outbox and listener run only while watched", async () => {
  const heard: { seq: number; kind: string; collections: string[] }[] = [];
  const store = createPostgresSiteDataStore(client.db, {
    onChange: (change) =>
      heard.push({ seq: change.seq, kind: change.kind, collections: change.collections }),
  });
  const a = await site();
  await store.defineCollection(a.caller, { name: "notes", accessMode: "shared" }, limits);
  const seqOf = async () => {
    const [row] = await shared.admin`
      select change_seq::int as seq from site_data_usage where site_id = ${a.caller.siteId}`;
    return row!.seq as number;
  };
  const outbox = async () =>
    await shared.admin`
      select change_seq::int as seq, kind, collections, op_counts, record_ids, actor_kind
      from site_data_changes where site_id = ${a.caller.siteId} order by change_seq`;
  // Nobody watching: the number moves, nothing else is written or heard.
  const before = await seqOf();
  await store.write(a.caller, [{ op: "insert", collection: "notes", data: { text: "a" } }], {
    limits,
  });
  expect(await seqOf()).toBe(before + 1);
  expect(await outbox()).toHaveLength(0);
  expect(heard).toHaveLength(0);

  const watched = await store.watch(a.caller, 900);
  expect(watched.seq).toBe(before + 1);
  expect(watched.collections).toEqual(["notes", "$files"]);
  expect(watched.ttlSeconds).toBeGreaterThan(890);
  // A second watch soon after does not extend (nor shorten) the lease.
  expect((await store.watch(a.caller, 900)).ttlSeconds).toBeGreaterThan(890);

  const written = await store.write(
    a.caller,
    [
      { op: "insert", collection: "notes", data: { text: "b" } },
      { op: "insert", collection: "notes", data: { text: "c" } },
    ],
    { limits },
  );
  const rows = await outbox();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    seq: before + 2,
    kind: "write",
    collections: ["notes"],
    op_counts: { insert: 2 },
    actor_kind: "user",
  });
  expect([...(rows[0]!.record_ids as string[])].sort()).toEqual(
    written.results.map((result) => (result.op === "insert" ? result.record.id : "")).sort(),
  );
  expect(heard).toEqual([{ seq: before + 2, kind: "write", collections: ["notes"] }]);

  // A failed write takes no number and tells no one.
  await expect(
    store.write(
      a.caller,
      [{ op: "patch", collection: "notes", id: crypto.randomUUID(), data: { text: "x" } }],
      { limits },
    ),
  ).rejects.toBeInstanceOf(SiteDataError);
  expect(await seqOf()).toBe(before + 2);
  expect(heard).toHaveLength(1);
});

test("an insert with an idempotency key returns the original record when retried", async () => {
  const store = createPostgresSiteDataStore(client.db);
  const a = await site();
  await store.defineCollection(a.caller, { name: "orders", accessMode: "shared" }, limits);
  const insert = (text: string, caller = a.caller) =>
    store.write(
      caller,
      [{ op: "insert", collection: "orders", data: { text }, idempotencyKey: "order-1" }],
      { limits },
    );
  const first = await insert("first");
  const again = await insert("second");
  const original = first.results[0]!;
  const replay = again.results[0]!;
  if (original.op !== "insert" || replay.op !== "insert") throw new Error("unexpected result");
  expect(replay.replayed).toBe(true);
  expect(replay.record.id).toBe(original.record.id);
  expect(replay.record.data).toEqual({ text: "first" });
  expect((await store.query(a.caller, { collection: "orders" })).records).toHaveLength(1);
  // Another principal's key is its own.
  const other = await insert("other", {
    ...a.caller,
    principal: "user:someone-else",
    actor: "user:someone-else",
  });
  const otherResult = other.results[0]!;
  expect(otherResult.op === "insert" && otherResult.replayed).toBeFalsy();
  // Deleting the record frees the key.
  await store.write(a.caller, [{ op: "delete", collection: "orders", id: original.record.id }], {
    limits,
  });
  const fresh = (await insert("fresh")).results[0]!;
  expect(fresh.op === "insert" && fresh.replayed).toBeFalsy();
});

test("$now filters compare with the database's clock", async () => {
  const store = createPostgresSiteDataStore(client.db);
  const a = await site();
  await store.defineCollection(a.caller, { name: "jobs", accessMode: "shared" }, limits);
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  await store.write(
    a.caller,
    [
      { op: "insert", collection: "jobs", key: "lapsed", data: { leaseUntil: iso(-3_600_000) } },
      { op: "insert", collection: "jobs", key: "held", data: { leaseUntil: iso(3_600_000) } },
    ],
    { limits },
  );
  const keys = async (where: { field: string; op: "lt" | "gt" | "gte"; value: string }[]) =>
    (await store.query(a.caller, { collection: "jobs", where })).records
      .map((record) => record.key)
      .sort();
  expect(await keys([{ field: "leaseUntil", op: "lt", value: "$now" }])).toEqual(["lapsed"]);
  expect(await keys([{ field: "leaseUntil", op: "gt", value: "$now+30m" }])).toEqual(["held"]);
  expect(await keys([{ field: "leaseUntil", op: "lt", value: "$now+2h" }])).toEqual([
    "held",
    "lapsed",
  ]);
  expect(await keys([{ field: "$createdAt", op: "gte", value: "$now-1h" }])).toEqual([
    "held",
    "lapsed",
  ]);
});
