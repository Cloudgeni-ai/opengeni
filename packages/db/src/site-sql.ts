import { sql } from "drizzle-orm";
import { SITE_SQL_HARD_LIMITS } from "@opengeni/contracts";
import { rawRows, withRlsContext, type Database } from "./database";

/**
 * Site SQL definitions in Postgres (migration 0783): whether the owner turned
 * a Site's Cloudflare database on, its ordered migrations, its named queries,
 * its usage counters (site_sql_usage, apart from the database row so Site
 * page calls never wait on a migration's lock) and its call windows. The rows
 * themselves live in the Site's Durable Object; everything here is what
 * rebuilds it.
 */

export type SiteSqlScope = { accountId: string; workspaceId: string; siteId: string };

export type SiteSqlStoreErrorCode = "not_found" | "conflict" | "rate_limited" | "quota_exceeded";

export class SiteSqlStoreError extends Error {
  constructor(
    readonly code: SiteSqlStoreErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SiteSqlStoreError";
  }
}

export type SiteSqlDatabase = {
  siteId: string;
  enabled: boolean;
  storageBytes: number;
  /** First day of the month the row counters are for (YYYY-MM-01). */
  usageMonth: string;
  rowsReadThisMonth: number;
  rowsWrittenThisMonth: number;
  migrationCount: number;
  rebuiltAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SiteSqlStoredMigration = {
  ordinal: number;
  name: string;
  sql: string;
  checksum: string;
  createdBy: string;
  createdAt: Date;
};

export type SiteSqlStoredQuery = {
  name: string;
  sql: string;
  mode: "read" | "write";
  params: string[];
  audience: "everyone" | "signed_in" | "managers";
  description: string | null;
  maxRows: number | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type DatabaseRow = {
  site_id: string;
  enabled: boolean;
  storage_bytes: string | number;
  usage_month: string | Date | null;
  rows_read_month: string | number;
  rows_written_month: string | number;
  current_month: string | Date;
  migration_count: number;
  rebuilt_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const date = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const day = (value: Date | string) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

function toDatabase(row: DatabaseRow): SiteSqlDatabase {
  // Counters from an earlier month read as zero until the next write resets them.
  const current = row.usage_month !== null && day(row.usage_month) === day(row.current_month);
  return {
    siteId: row.site_id,
    enabled: row.enabled,
    storageBytes: Number(row.storage_bytes),
    usageMonth: day(row.current_month),
    rowsReadThisMonth: current ? Number(row.rows_read_month) : 0,
    rowsWrittenThisMonth: current ? Number(row.rows_written_month) : 0,
    migrationCount: row.migration_count,
    rebuiltAt: row.rebuilt_at === null ? null : date(row.rebuilt_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

type MigrationRow = {
  ordinal: number;
  name: string;
  sql: string;
  checksum: string;
  created_by: string;
  created_at: Date | string;
};

const toMigration = (row: MigrationRow): SiteSqlStoredMigration => ({
  ordinal: row.ordinal,
  name: row.name,
  sql: row.sql,
  checksum: row.checksum,
  createdBy: row.created_by,
  createdAt: date(row.created_at),
});

type QueryRow = {
  name: string;
  sql: string;
  mode: "read" | "write";
  params: string[];
  audience: SiteSqlStoredQuery["audience"];
  description: string | null;
  max_rows: number | null;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const toQuery = (row: QueryRow): SiteSqlStoredQuery => ({
  name: row.name,
  sql: row.sql,
  mode: row.mode,
  params: Array.isArray(row.params) ? row.params : [],
  audience: row.audience,
  description: row.description,
  maxRows: row.max_rows,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: date(row.created_at),
  updatedAt: date(row.updated_at),
});

const scoped = <T>(db: Database, scope: SiteSqlScope, fn: (tx: Database) => Promise<T>) =>
  withRlsContext(db, { accountId: scope.accountId, workspaceId: scope.workspaceId }, fn);

// `for no key update` keeps usage inserts (whose foreign key takes a key-share
// lock on this row) from waiting on a migration that holds it.
const selectDatabase = (scope: SiteSqlScope, lock: boolean) =>
  sql`select d.site_id, d.enabled, d.migration_count, d.rebuilt_at, d.created_at, d.updated_at,
      coalesce(u.storage_bytes, 0) as storage_bytes, u.usage_month,
      coalesce(u.rows_read_month, 0) as rows_read_month,
      coalesce(u.rows_written_month, 0) as rows_written_month,
      (date_trunc('month', now()))::date as current_month
    from site_sql_databases d
    left join site_sql_usage u on u.workspace_id = d.workspace_id and u.site_id = d.site_id
    where d.workspace_id = ${scope.workspaceId} and d.site_id = ${scope.siteId}
    ${lock ? sql`for no key update of d` : sql``}`;

export async function getSiteSqlDatabase(
  db: Database,
  scope: SiteSqlScope,
): Promise<SiteSqlDatabase | null> {
  return scoped(db, scope, async (tx) => {
    const [row] = await rawRows<DatabaseRow>(tx, selectDatabase(scope, false));
    return row ? toDatabase(row) : null;
  });
}

/** Turn a Site's database on or off; the definitions and data are kept either way. */
export async function setSiteSqlEnabled(
  db: Database,
  scope: SiteSqlScope,
  enabled: boolean,
  actor: string,
): Promise<SiteSqlDatabase> {
  return scoped(db, scope, async (tx) => {
    await rawRows(
      tx,
      sql`insert into site_sql_databases
          (account_id, workspace_id, site_id, enabled, created_by, updated_by)
        values (${scope.accountId}, ${scope.workspaceId}, ${scope.siteId}, ${enabled}, ${actor}, ${actor})
        on conflict (workspace_id, site_id) do update set
          enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()
        returning site_id`,
    );
    await rawRows(
      tx,
      sql`insert into site_sql_usage (account_id, workspace_id, site_id)
        values (${scope.accountId}, ${scope.workspaceId}, ${scope.siteId})
        on conflict (workspace_id, site_id) do nothing
        returning site_id`,
    );
    const [row] = await rawRows<DatabaseRow>(tx, selectDatabase(scope, false));
    return toDatabase(row!);
  });
}

/** The ids of a workspace's Sites that ever turned Site SQL on. */
export async function listSiteSqlSiteIds(
  db: Database,
  scope: { accountId: string; workspaceId: string },
): Promise<string[]> {
  return withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{ site_id: string }>(
      tx,
      sql`select site_id from site_sql_databases where workspace_id = ${scope.workspaceId}
        order by site_id`,
    );
    return rows.map((row) => row.site_id);
  });
}

/**
 * Run `fn` holding the Site's database row lock, so migrations, rebuilds and
 * resets of one Site never interleave. The row must exist (Site SQL turned on
 * at least once). Site page calls never take this lock.
 */
export async function withSiteSqlDatabaseLock<T>(
  db: Database,
  scope: SiteSqlScope,
  fn: (tx: Database, database: SiteSqlDatabase) => Promise<T>,
): Promise<T> {
  return scoped(db, scope, async (tx) => {
    const [row] = await rawRows<DatabaseRow>(tx, selectDatabase(scope, true));
    if (!row) throw new SiteSqlStoreError("not_found", "Site SQL is not set up for this Site");
    return fn(tx, toDatabase(row));
  });
}

export async function listSiteSqlMigrations(
  db: Database,
  scope: SiteSqlScope,
): Promise<SiteSqlStoredMigration[]> {
  return scoped(db, scope, async (tx) => {
    const rows = await rawRows<MigrationRow>(
      tx,
      sql`select ordinal, name, sql, checksum, created_by, created_at from site_sql_migrations
        where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}
        order by ordinal`,
    );
    return rows.map(toMigration);
  });
}

/** UTF-8 bytes of SQL a Site's migrations hold together. */
export async function siteSqlMigrationBytes(tx: Database, scope: SiteSqlScope): Promise<number> {
  const [row] = await rawRows<{ bytes: string | number }>(
    tx,
    sql`select coalesce(sum(octet_length(sql)), 0) as bytes from site_sql_migrations
      where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}`,
  );
  return Number(row?.bytes ?? 0);
}

/** The error for a migration that would pass a Site's migration SQL cap. */
export function siteSqlMigrationQuotaError(): SiteSqlStoreError {
  const limit = SITE_SQL_HARD_LIMITS.migrationBytesPerSite;
  return new SiteSqlStoreError(
    "quota_exceeded",
    `A Site's migrations hold at most ${limit / (1024 * 1024)} MiB of SQL together; load data with site_sql_import instead of a migration, or reset with schema "drop" and start from one consolidated migration`,
    { quota: "migration_bytes_per_site", limit },
  );
}

/**
 * Append a migration under the database row lock `tx` holds (from
 * withSiteSqlDatabaseLock). A name already used is a conflict; SQL past the
 * Site's migration cap (SITE_SQL_HARD_LIMITS.migrationBytesPerSite) is
 * quota_exceeded.
 */
export async function appendSiteSqlMigration(
  tx: Database,
  scope: SiteSqlScope,
  migration: { name: string; sql: string; checksum: string },
  actor: string,
): Promise<SiteSqlStoredMigration> {
  const [existing] = await rawRows<{ ordinal: number }>(
    tx,
    sql`select ordinal from site_sql_migrations
      where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId} and name = ${migration.name}`,
  );
  if (existing)
    throw new SiteSqlStoreError("conflict", `A migration named ${migration.name} already exists`, {
      reason: "migration_exists",
    });
  if (
    (await siteSqlMigrationBytes(tx, scope)) + Buffer.byteLength(migration.sql, "utf8") >
    SITE_SQL_HARD_LIMITS.migrationBytesPerSite
  )
    throw siteSqlMigrationQuotaError();
  const [counter] = await rawRows<{ migration_count: number }>(
    tx,
    sql`update site_sql_databases set migration_count = migration_count + 1, updated_by = ${actor}, updated_at = now()
      where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}
      returning migration_count`,
  );
  if (!counter) throw new SiteSqlStoreError("not_found", "Site SQL is not set up for this Site");
  const [row] = await rawRows<MigrationRow>(
    tx,
    sql`insert into site_sql_migrations
        (account_id, workspace_id, site_id, ordinal, name, sql, checksum, created_by)
      values (${scope.accountId}, ${scope.workspaceId}, ${scope.siteId}, ${counter.migration_count},
        ${migration.name}, ${migration.sql}, ${migration.checksum}, ${actor})
      returning ordinal, name, sql, checksum, created_by, created_at`,
  );
  return toMigration(row!);
}

/**
 * Forget every migration and named query (a reset that drops the schema),
 * under the database row lock `tx` holds. Ordinals start again at 1.
 */
export async function clearSiteSqlDefinitions(
  tx: Database,
  scope: SiteSqlScope,
  actor: string,
): Promise<void> {
  await rawRows(
    tx,
    sql`delete from site_sql_migrations
      where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId} returning ordinal`,
  );
  await rawRows(
    tx,
    sql`delete from site_sql_queries
      where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId} returning name`,
  );
  await rawRows(
    tx,
    sql`update site_sql_databases set migration_count = 0, updated_by = ${actor}, updated_at = now()
      where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId} returning site_id`,
  );
}

/**
 * Record that the Durable Object was rebuilt from Postgres, under the row
 * lock: its size, which is also the new storage high-water mark.
 */
export async function markSiteSqlRebuilt(
  tx: Database,
  scope: SiteSqlScope,
  storageBytes: number,
): Promise<void> {
  const bytes = Math.max(0, Math.floor(storageBytes));
  await rawRows(
    tx,
    sql`update site_sql_databases set rebuilt_at = now(), updated_at = now()
      where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId} returning site_id`,
  );
  await rawRows(
    tx,
    sql`insert into site_sql_usage (account_id, workspace_id, site_id, storage_bytes, storage_peak_bytes)
      values (${scope.accountId}, ${scope.workspaceId}, ${scope.siteId}, ${bytes}, ${bytes})
      on conflict (workspace_id, site_id) do update set
        storage_bytes = excluded.storage_bytes, storage_peak_bytes = excluded.storage_peak_bytes,
        updated_at = now()
      returning site_id`,
  );
}

export async function listSiteSqlQueries(
  db: Database,
  scope: SiteSqlScope,
): Promise<SiteSqlStoredQuery[]> {
  return scoped(db, scope, async (tx) => {
    const rows = await rawRows<QueryRow>(
      tx,
      sql`select * from site_sql_queries
        where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}
        order by name`,
    );
    return rows.map(toQuery);
  });
}

export async function getSiteSqlQuery(
  db: Database,
  scope: SiteSqlScope,
  name: string,
): Promise<SiteSqlStoredQuery | null> {
  return scoped(db, scope, async (tx) => {
    const [row] = await rawRows<QueryRow>(
      tx,
      sql`select * from site_sql_queries
        where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId} and name = ${name}`,
    );
    return row ? toQuery(row) : null;
  });
}

/** Create or replace a named query. Returns whether it was created. */
export async function upsertSiteSqlQuery(
  db: Database,
  scope: SiteSqlScope,
  query: {
    name: string;
    sql: string;
    mode: "read" | "write";
    params: string[];
    audience: SiteSqlStoredQuery["audience"];
    description: string | null;
    maxRows: number | null;
  },
  actor: string,
): Promise<{ query: SiteSqlStoredQuery; created: boolean }> {
  return scoped(db, scope, async (tx) => {
    const [row] = await rawRows<QueryRow & { created: boolean }>(
      tx,
      sql`insert into site_sql_queries
          (account_id, workspace_id, site_id, name, sql, mode, params, audience, description,
           max_rows, created_by, updated_by)
        values (${scope.accountId}, ${scope.workspaceId}, ${scope.siteId}, ${query.name}, ${query.sql},
          ${query.mode}, ${JSON.stringify(query.params)}::jsonb, ${query.audience}, ${query.description},
          ${query.maxRows}, ${actor}, ${actor})
        on conflict (workspace_id, site_id, name) do update set
          sql = excluded.sql, mode = excluded.mode, params = excluded.params,
          audience = excluded.audience, description = excluded.description,
          max_rows = excluded.max_rows, updated_by = excluded.updated_by, updated_at = now()
        returning *, (xmax = 0) as created`,
    );
    return { query: toQuery(row!), created: row!.created === true };
  });
}

export async function deleteSiteSqlQuery(
  db: Database,
  scope: SiteSqlScope,
  name: string,
): Promise<boolean> {
  return scoped(db, scope, async (tx) => {
    const rows = await rawRows<{ name: string }>(
      tx,
      sql`delete from site_sql_queries
        where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId} and name = ${name}
        returning name`,
    );
    return rows.length > 0;
  });
}

/**
 * Count one call against fixed one-minute windows, each `[principal key,
 * limit, message]`; a null limit only counts. Counted in its own transaction
 * after the request is checked and before the database call, so calls the
 * monthly caps or the database refuse still count. Throws rate_limited when
 * a window is over its limit.
 */
export async function consumeSiteSqlRate(
  db: Database,
  scope: SiteSqlScope,
  windows: ReadonlyArray<readonly [string, number | null, string]>,
): Promise<void> {
  await scoped(db, scope, async (tx) => {
    for (const [principal, limit, message] of windows) {
      const [row] = await rawRows<{ operations: number }>(
        tx,
        sql`insert into site_sql_rate_windows
            (account_id, workspace_id, site_id, principal_key, window_started_at, operations)
          values (${scope.accountId}, ${scope.workspaceId}, ${scope.siteId}, ${principal.slice(0, 300)},
            date_trunc('minute', now()), 1)
          on conflict (workspace_id, site_id, principal_key) do update set
            operations = case
              when site_sql_rate_windows.window_started_at = excluded.window_started_at
              then least(site_sql_rate_windows.operations + 1, 1000000000)
              else 1 end,
            window_started_at = excluded.window_started_at
          returning operations`,
      );
      if (limit !== null && (row?.operations ?? 0) > limit)
        throw new SiteSqlStoreError("rate_limited", `${message} Try again in a minute.`, {
          limit,
          window: "minute",
          retryable: true,
        });
    }
  });
}

/** What one Durable Object call did, as it reported it. */
export type SiteSqlUsageDelta = {
  rowsRead: number;
  rowsWritten: number;
  /** The database size after the call. */
  databaseBytes: number;
};

/**
 * Record one Durable Object call's usage: store the database size and, for
 * Site page calls (`countTowardCaps`, the default), add its rows to this
 * month's counters the monthly caps read, rolling them over when the month
 * changed. Storage growth is measured past the high-water mark, so calls
 * completing out of order never count the same bytes twice. `meter` runs in
 * the same transaction (usage events). Takes only the Site's usage row lock.
 * Returns the updated database, or null when Site SQL was never turned on.
 */
export async function recordSiteSqlUsage(
  db: Database,
  scope: SiteSqlScope,
  delta: SiteSqlUsageDelta,
  options: {
    countTowardCaps?: boolean;
    meter?: (tx: Database, change: { storageGrowthBytes: number }) => Promise<void>;
  } = {},
): Promise<SiteSqlDatabase | null> {
  const counted = options.countTowardCaps ?? true;
  const rowsRead = counted ? Math.max(0, Math.floor(delta.rowsRead)) : 0;
  const rowsWritten = counted ? Math.max(0, Math.floor(delta.rowsWritten)) : 0;
  const bytes = Math.max(0, Math.floor(delta.databaseBytes));
  return scoped(db, scope, async (tx) => {
    const [before] = await rawRows<{ storage_peak_bytes: string | number }>(
      tx,
      sql`select storage_peak_bytes from site_sql_usage
        where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId} for update`,
    );
    if (!before) return null;
    await rawRows(
      tx,
      counted
        ? sql`update site_sql_usage set
            rows_read_month = case when usage_month = (date_trunc('month', now()))::date
              then least(rows_read_month + ${rowsRead}, 9000000000000000000) else ${rowsRead} end,
            rows_written_month = case when usage_month = (date_trunc('month', now()))::date
              then least(rows_written_month + ${rowsWritten}, 9000000000000000000) else ${rowsWritten} end,
            usage_month = (date_trunc('month', now()))::date,
            storage_bytes = ${bytes}, storage_peak_bytes = greatest(storage_peak_bytes, ${bytes}),
            updated_at = now()
          where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}
          returning site_id`
        : sql`update site_sql_usage set
            storage_bytes = ${bytes}, storage_peak_bytes = greatest(storage_peak_bytes, ${bytes}),
            updated_at = now()
          where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}
          returning site_id`,
    );
    if (options.meter)
      await options.meter(tx, {
        storageGrowthBytes: Math.max(0, bytes - Number(before.storage_peak_bytes)),
      });
    const [row] = await rawRows<DatabaseRow>(tx, selectDatabase(scope, false));
    return row ? toDatabase(row) : null;
  });
}
