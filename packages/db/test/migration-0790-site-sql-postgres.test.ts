// Migration 0790: Site SQL definitions. The four site_sql_* tables are
// workspace-owned, FORCE RLS and reachable by the application role only inside
// a workspace context; definitions follow their Site and are removed with the
// workspace. Also covers the store in src/site-sql.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  appendSiteSqlMigration,
  clearSiteSqlDefinitions,
  consumeSiteSqlRate,
  createDb,
  createWorkspace,
  createWorkspaceArtifact,
  deleteSiteSqlQuery,
  getSiteSqlDatabase,
  getSiteSqlQuery,
  listSiteSqlMigrations,
  listSiteSqlQueries,
  recordSiteSqlUsage,
  setSiteSqlEnabled,
  SiteSqlStoreError,
  upsertSiteSqlQuery,
  withRlsContext,
  withSiteSqlDatabaseLock,
  type Database,
  type DbClient,
  type SiteSqlScope,
} from "../src/index";
import { rawRows } from "../src/database";

const TABLES = [
  "site_sql_databases",
  "site_sql_migrations",
  "site_sql_queries",
  "site_sql_rate_windows",
];
const CHECKSUM = "b".repeat(64);

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0790-site-sql");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function site(existing?: { accountId: string; workspaceId: string }): Promise<SiteSqlScope> {
  let accountId = existing?.accountId;
  let workspaceId = existing?.workspaceId;
  if (!accountId || !workspaceId) {
    const [account] =
      await shared.admin`insert into managed_accounts (name) values ('Site SQL migration') returning id`;
    accountId = String(account!.id);
    workspaceId = (await createWorkspace(client.db, { accountId, name: "Site SQL" })).id;
  }
  const created = await createWorkspaceArtifact(client.db, {
    accountId,
    workspaceId,
    artifactId: crypto.randomUUID(),
    slug: `site-sql-${crypto.randomUUID().slice(0, 8)}`,
    title: "Site SQL",
    description: null,
    visibility: "workspace_shared",
    ownerSubjectId: null,
    contentKey: `site-sql/${crypto.randomUUID()}.html`,
    contentSha256: "a".repeat(64),
    sizeBytes: 16,
    sourceKey: null,
    sourceSha256: null,
    sourceSizeBytes: null,
    operationKey: crypto.randomUUID(),
    actorSubjectId: "user:site-sql-owner",
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
    persistContent: async () => undefined,
    discardContent: async () => undefined,
  });
  return { accountId, workspaceId, siteId: created.artifact.id };
}

async function populate(scope: SiteSqlScope) {
  await setSiteSqlEnabled(client.db, scope, true, "user:owner");
  await withSiteSqlDatabaseLock(client.db, scope, (tx) =>
    appendSiteSqlMigration(
      tx,
      scope,
      {
        name: "create_votes",
        sql: "CREATE TABLE votes (id INTEGER PRIMARY KEY)",
        checksum: CHECKSUM,
      },
      "user:owner",
    ),
  );
  await upsertSiteSqlQuery(
    client.db,
    scope,
    {
      name: "count",
      sql: "SELECT count(*) AS n FROM votes",
      mode: "read",
      params: [],
      audience: "everyone",
      description: null,
      maxRows: null,
    },
    "user:owner",
  );
  await consumeSiteSqlRate(client.db, scope, [["*", null, "Busy."]]);
}

test("site sql tables are FORCE RLS with a workspace policy", async () => {
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

test("definitions stay in their workspace and are removed with it", async () => {
  const a = await site();
  const b = await site();
  await populate(a);
  await populate(b);

  // Another tenant naming A's Site sees nothing.
  const intruder = { ...b, siteId: a.siteId };
  expect(await getSiteSqlDatabase(client.db, intruder)).toBeNull();
  expect(await listSiteSqlMigrations(client.db, intruder)).toEqual([]);
  expect(await listSiteSqlQueries(client.db, intruder)).toEqual([]);
  // RLS alone (no tenant WHERE) hides A's rows inside B's context.
  for (const table of TABLES) {
    const [row] = await withRlsContext(
      client.db,
      { accountId: b.accountId, workspaceId: b.workspaceId },
      (tx: Database) =>
        rawRows<{ count: number }>(
          tx,
          sql`select count(*)::int as count from ${sql.identifier(table)}
            where workspace_id = ${a.workspaceId}`,
        ),
    );
    expect(row!.count).toBe(0);
  }
  // Without a workspace context the application role sees nothing.
  const app = (await import("postgres")).default(shared.appUrl, { max: 1 });
  try {
    const [hidden] = await app`select count(*)::int as count from site_sql_queries`;
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
  expect((await listSiteSqlQueries(client.db, b)).map((query) => query.name)).toEqual(["count"]);
}, 30_000);

test("migrations append in order under the database lock and names are unique", async () => {
  const scope = await site();
  await expect(
    withSiteSqlDatabaseLock(client.db, scope, async () => undefined),
  ).rejects.toBeInstanceOf(SiteSqlStoreError);
  const enabled = await setSiteSqlEnabled(client.db, scope, true, "user:owner");
  expect(enabled.enabled).toBe(true);
  for (const name of ["one", "two"])
    await withSiteSqlDatabaseLock(client.db, scope, (tx) =>
      appendSiteSqlMigration(tx, scope, { name, sql: "SELECT 1", checksum: CHECKSUM }, "user:o"),
    );
  const listed = await listSiteSqlMigrations(client.db, scope);
  expect(listed.map((migration) => [migration.ordinal, migration.name])).toEqual([
    [1, "one"],
    [2, "two"],
  ]);
  let error: unknown = null;
  try {
    await withSiteSqlDatabaseLock(client.db, scope, (tx) =>
      appendSiteSqlMigration(tx, scope, { name: "one", sql: "SELECT 2", checksum: CHECKSUM }, "x"),
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SiteSqlStoreError);
  expect((error as SiteSqlStoreError).code).toBe("conflict");
  // Turning it off keeps everything.
  const disabled = await setSiteSqlEnabled(client.db, scope, false, "user:owner");
  expect(disabled.enabled).toBe(false);
  expect(disabled.migrationCount).toBe(2);
  // Clearing definitions restarts the ordinals.
  await withSiteSqlDatabaseLock(client.db, scope, (tx) =>
    clearSiteSqlDefinitions(tx, scope, "user:owner"),
  );
  expect(await listSiteSqlMigrations(client.db, scope)).toEqual([]);
  await withSiteSqlDatabaseLock(client.db, scope, (tx) =>
    appendSiteSqlMigration(tx, scope, { name: "one", sql: "SELECT 1", checksum: CHECKSUM }, "o"),
  );
  expect((await listSiteSqlMigrations(client.db, scope))[0]!.ordinal).toBe(1);
}, 30_000);

test("named queries upsert, read back and delete", async () => {
  const scope = await site();
  await setSiteSqlEnabled(client.db, scope, true, "user:owner");
  const definition = {
    name: "mine",
    sql: "SELECT * FROM votes WHERE voter = ?",
    mode: "read" as const,
    params: ["viewer"],
    audience: "signed_in" as const,
    description: "My votes",
    maxRows: 50,
  };
  const first = await upsertSiteSqlQuery(client.db, scope, definition, "user:owner");
  expect(first.created).toBe(true);
  const second = await upsertSiteSqlQuery(
    client.db,
    scope,
    { ...definition, audience: "everyone", maxRows: null },
    "user:other",
  );
  expect(second.created).toBe(false);
  expect(second.query).toMatchObject({
    name: "mine",
    params: ["viewer"],
    audience: "everyone",
    maxRows: null,
    createdBy: "user:owner",
    updatedBy: "user:other",
  });
  expect((await getSiteSqlQuery(client.db, scope, "mine"))?.description).toBe("My votes");
  expect(await deleteSiteSqlQuery(client.db, scope, "mine")).toBe(true);
  expect(await deleteSiteSqlQuery(client.db, scope, "mine")).toBe(false);
  expect(await getSiteSqlQuery(client.db, scope, "mine")).toBeNull();
}, 30_000);

test("rate windows refuse past their limit and usage rolls up per month", async () => {
  const scope = await site();
  await setSiteSqlEnabled(client.db, scope, true, "user:owner");
  await consumeSiteSqlRate(client.db, scope, [["user:a", 2, "Too many calls."]]);
  await consumeSiteSqlRate(client.db, scope, [["user:a", 2, "Too many calls."]]);
  let error: unknown = null;
  try {
    await consumeSiteSqlRate(client.db, scope, [["user:a", 2, "Too many calls."]]);
  } catch (caught) {
    error = caught;
  }
  expect((error as SiteSqlStoreError).code).toBe("rate_limited");
  // Another principal has its own window.
  await consumeSiteSqlRate(client.db, scope, [["user:b", 2, "Too many calls."]]);

  let meteredBefore = -1;
  await recordSiteSqlUsage(
    client.db,
    scope,
    { rowsRead: 5, rowsWritten: 2, databaseBytes: 8192 },
    async (_tx, change) => {
      meteredBefore = change.storageBytesBefore;
    },
  );
  expect(meteredBefore).toBe(0);
  const after = await recordSiteSqlUsage(client.db, scope, {
    rowsRead: 1,
    rowsWritten: 0,
    databaseBytes: 12288,
  });
  expect(after).toMatchObject({
    rowsReadThisMonth: 6,
    rowsWrittenThisMonth: 2,
    storageBytes: 12288,
  });
  // Counters from an earlier month restart.
  await shared.admin`update site_sql_databases set usage_month = '2000-01-01'
    where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}`;
  expect(await getSiteSqlDatabase(client.db, scope)).toMatchObject({
    rowsReadThisMonth: 0,
    rowsWrittenThisMonth: 0,
  });
  const rolled = await recordSiteSqlUsage(client.db, scope, {
    rowsRead: 3,
    rowsWritten: 1,
    databaseBytes: 12288,
  });
  expect(rolled).toMatchObject({ rowsReadThisMonth: 3, rowsWrittenThisMonth: 1 });
}, 30_000);

test("a query or migration cannot point at a Site without a database row", async () => {
  const scope = await site();
  let error: unknown = null;
  try {
    await shared.admin`insert into site_sql_queries
      (account_id, workspace_id, site_id, name, sql, mode, audience, created_by, updated_by)
      values (${scope.accountId}, ${scope.workspaceId}, ${scope.siteId}, 'q', 'SELECT 1', 'read',
        'everyone', 'x', 'x')`;
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain("site_sql_queries_database_fk");
});
