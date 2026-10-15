import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/**
 * Site platform usage (migration 0786): gateway requests, Site SQL rows read
 * and written, and the Site SQL plus Site Data storage level, metered per
 * workspace and month apart from model spend, plus deployment-global
 * per-month totals in eight shards and the Opengeni-wide monthly brake.
 *
 * The global tables are reached through the platform lane: a transaction
 * sets `opengeni.site_platform_lane` first (the only policy on them). They
 * hold counters and the brake state, no tenant content. Writers lock the
 * workspace row before a shard row.
 */

export type SitePlatformScope = { accountId: string; workspaceId: string };

export type SitePlatformUsageRecord = {
  periodStart: string;
  requests: number;
  sqlRowsRead: number;
  sqlRowsWritten: number;
  storageBytes: number;
  storagePeakBytes: number;
  chargedMicros: number;
  shadowMicros: number;
  chargeSeq: number;
};

export type SitePlatformTotals = {
  periodStart: string;
  requests: number;
  sqlRowsRead: number;
  sqlRowsWritten: number;
  storageBytes: number;
};

export type SitePlatformBrakeRecord = {
  periodStart: string;
  alertedAt: Date | null;
  engagedAt: Date | null;
  engagedBy: "auto" | "operator" | null;
  engagedReason: string | null;
  liftedAt: Date | null;
  liftedBy: string | null;
  liftReason: string | null;
  lastEstimateMicros: number;
};

export const SITE_PLATFORM_SHARDS = 8;

/** The shard of a workspace's global counters (stable per workspace). */
export function sitePlatformShard(workspaceId: string): number {
  let hash = 0;
  for (const char of workspaceId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % SITE_PLATFORM_SHARDS;
}

/** The first day of the UTC month of `now`, YYYY-MM-DD. */
export function sitePlatformPeriod(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

const counter = (value: unknown) => Number(value ?? 0);
const optionalDate = (value: unknown) =>
  value === null || value === undefined ? null : new Date(value as string);

type UsageRow = {
  period_start: unknown;
  requests: unknown;
  sql_rows_read: unknown;
  sql_rows_written: unknown;
  storage_bytes: unknown;
  storage_peak_bytes: unknown;
  charged_micros: unknown;
  shadow_micros: unknown;
  charge_seq: unknown;
};

const USAGE_COLUMNS = sql`period_start::text as period_start, requests, sql_rows_read,
  sql_rows_written, storage_bytes, storage_peak_bytes, charged_micros, shadow_micros, charge_seq`;

function toUsage(row: UsageRow): SitePlatformUsageRecord {
  return {
    periodStart: String(row.period_start).slice(0, 10),
    requests: counter(row.requests),
    sqlRowsRead: counter(row.sql_rows_read),
    sqlRowsWritten: counter(row.sql_rows_written),
    storageBytes: counter(row.storage_bytes),
    storagePeakBytes: counter(row.storage_peak_bytes),
    chargedMicros: counter(row.charged_micros),
    shadowMicros: counter(row.shadow_micros),
    chargeSeq: counter(row.charge_seq),
  };
}

async function enterPlatformLane(tx: Database): Promise<void> {
  await tx.execute(sql`select set_config('opengeni.site_platform_lane', 'on', true)`);
}

export type SitePlatformUsageChange = {
  requests?: number;
  sqlRowsRead?: number;
  sqlRowsWritten?: number;
  /** Recompute the workspace's storage level (after a Site SQL or Site Data write). */
  refreshStorage?: boolean;
  now?: Date;
};

/**
 * Add platform usage for the transaction's workspace (which must already run
 * in that workspace's RLS context): lock and roll the workspace row, add the
 * counters, recompute the storage level when asked, then move the global
 * shard totals and storage level by the same amounts. Returns the row after.
 */
export async function recordSitePlatformUsageInTransaction(
  tx: Database,
  scope: SitePlatformScope,
  change: SitePlatformUsageChange,
): Promise<SitePlatformUsageRecord> {
  const period = sitePlatformPeriod(change.now);
  const requests = Math.max(0, Math.trunc(change.requests ?? 0));
  const reads = Math.max(0, Math.trunc(change.sqlRowsRead ?? 0));
  const writes = Math.max(0, Math.trunc(change.sqlRowsWritten ?? 0));
  const [before] = await rawRows<UsageRow>(
    tx,
    sql`insert into site_platform_usage (workspace_id, account_id, period_start)
      values (${scope.workspaceId}, ${scope.accountId}, ${period}::date)
      on conflict (workspace_id) do update set
        requests = case when site_platform_usage.period_start < excluded.period_start
          then 0 else site_platform_usage.requests end,
        sql_rows_read = case when site_platform_usage.period_start < excluded.period_start
          then 0 else site_platform_usage.sql_rows_read end,
        sql_rows_written = case when site_platform_usage.period_start < excluded.period_start
          then 0 else site_platform_usage.sql_rows_written end,
        storage_peak_bytes = case when site_platform_usage.period_start < excluded.period_start
          then site_platform_usage.storage_bytes else site_platform_usage.storage_peak_bytes end,
        charged_micros = case when site_platform_usage.period_start < excluded.period_start
          then 0 else site_platform_usage.charged_micros end,
        shadow_micros = case when site_platform_usage.period_start < excluded.period_start
          then 0 else site_platform_usage.shadow_micros end,
        period_start = greatest(site_platform_usage.period_start, excluded.period_start)
      returning ${USAGE_COLUMNS}`,
  );
  const previousStorage = counter(before!.storage_bytes);
  let storage = previousStorage;
  if (change.refreshStorage) {
    const [level] = await rawRows<{ bytes: unknown }>(
      tx,
      sql`select
          coalesce((select sum(storage_bytes) from site_sql_usage
            where workspace_id = ${scope.workspaceId}), 0)
          + coalesce((select sum(record_bytes + file_bytes) from site_data_usage
            where workspace_id = ${scope.workspaceId}), 0) as bytes`,
    );
    storage = Math.max(0, counter(level?.bytes));
  }
  const [after] = await rawRows<UsageRow>(
    tx,
    sql`update site_platform_usage set
        requests = requests + ${requests},
        sql_rows_read = sql_rows_read + ${reads},
        sql_rows_written = sql_rows_written + ${writes},
        storage_bytes = ${storage},
        storage_peak_bytes = greatest(storage_peak_bytes, ${storage}),
        updated_at = now()
      where workspace_id = ${scope.workspaceId}
      returning ${USAGE_COLUMNS}`,
  );
  const storageDelta = storage - previousStorage;
  if (requests > 0 || reads > 0 || writes > 0 || storageDelta !== 0) {
    const shard = sitePlatformShard(scope.workspaceId);
    await enterPlatformLane(tx);
    if (requests > 0 || reads > 0 || writes > 0)
      await tx.execute(
        sql`insert into site_platform_totals (period_start, shard, requests, sql_rows_read,
            sql_rows_written)
          values (${period}::date, ${shard}, ${requests}, ${reads}, ${writes})
          on conflict (period_start, shard) do update set
            requests = site_platform_totals.requests + excluded.requests,
            sql_rows_read = site_platform_totals.sql_rows_read + excluded.sql_rows_read,
            sql_rows_written = site_platform_totals.sql_rows_written + excluded.sql_rows_written,
            updated_at = now()`,
      );
    // The workspace's own level row (no shared row is locked here).
    if (storageDelta !== 0)
      await tx.execute(
        sql`insert into site_platform_storage (workspace_id, storage_bytes)
          values (${scope.workspaceId}, ${storage})
          on conflict (workspace_id) do update set
            storage_bytes = excluded.storage_bytes,
            updated_at = now()`,
      );
  }
  return toUsage(after!);
}

/** Record platform usage for one workspace in its own transaction. */
export async function recordSitePlatformUsage(
  db: Database,
  scope: SitePlatformScope,
  change: SitePlatformUsageChange,
): Promise<SitePlatformUsageRecord> {
  return await withRlsContext(
    db,
    scope,
    async (tx) => await recordSitePlatformUsageInTransaction(tx, scope, change),
  );
}

/**
 * Count gateway requests of one report once: the usage event keyed by
 * `idempotencyKey` is inserted with the counters, and a replayed report
 * (same key) changes nothing. Returns whether the requests were counted.
 */
export async function recordSitePlatformRequests(
  db: Database,
  scope: SitePlatformScope,
  input: { siteId: string; requests: number; idempotencyKey: string; now?: Date },
): Promise<boolean> {
  const requests = Math.max(0, Math.trunc(input.requests));
  if (requests === 0) return false;
  return await withRlsContext(db, scope, async (tx) => {
    const inserted = await rawRows<{ id: string }>(
      tx,
      sql`insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
          source_resource_type, source_resource_id, idempotency_key, occurred_at)
        values (${scope.accountId}, ${scope.workspaceId}, 'site_platform.requests', ${requests},
          'request', 'site', ${input.siteId}, ${input.idempotencyKey},
          ${(input.now ?? new Date()).toISOString()}::timestamptz)
        on conflict (idempotency_key) do nothing
        returning id`,
    );
    if (inserted.length === 0) return false;
    await recordSitePlatformUsageInTransaction(tx, scope, {
      requests,
      ...(input.now ? { now: input.now } : {}),
    });
    return true;
  });
}

/** This month's platform usage of a workspace (zero counters, current storage, when unused). */
export async function readSitePlatformUsage(
  db: Database,
  scope: SitePlatformScope,
  now: Date = new Date(),
): Promise<SitePlatformUsageRecord> {
  const period = sitePlatformPeriod(now);
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<UsageRow>(
      tx,
      sql`select ${USAGE_COLUMNS} from site_platform_usage
        where workspace_id = ${scope.workspaceId}`,
    );
    const usage = row ? toUsage(row) : null;
    if (usage && usage.periodStart === period) return usage;
    const storage = usage?.storageBytes ?? 0;
    return {
      periodStart: period,
      requests: 0,
      sqlRowsRead: 0,
      sqlRowsWritten: 0,
      storageBytes: storage,
      storagePeakBytes: storage,
      chargedMicros: 0,
      shadowMicros: 0,
      chargeSeq: usage?.chargeSeq ?? 0,
    };
  });
}

/**
 * Claim a charge of this month's usage: when `billableMicros` exceeds what
 * was charged by at least `minimumMicros`, raise charged_micros to it and
 * bump the charge sequence, and run `debit` for the delta in the same
 * transaction (a failed debit rolls the claim back, so the next call retries
 * it; the sequence keys the debit, so a replay never charges twice). Returns
 * the claim, or null when there is nothing to charge. Shadow mode only
 * records shadow_micros.
 */
export async function claimSitePlatformCharge(
  db: Database,
  scope: SitePlatformScope,
  input: {
    billableMicros: number;
    minimumMicros: number;
    mode: "shadow" | "credits";
    debit?: (
      tx: Database,
      claim: { deltaMicros: number; seq: number; periodStart: string },
    ) => Promise<void>;
    now?: Date;
  },
): Promise<{ deltaMicros: number; seq: number; periodStart: string } | null> {
  const period = sitePlatformPeriod(input.now);
  const billable = Math.max(0, Math.floor(input.billableMicros));
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<UsageRow>(
      tx,
      sql`select ${USAGE_COLUMNS} from site_platform_usage
        where workspace_id = ${scope.workspaceId} for update`,
    );
    if (!row) return null;
    const usage = toUsage(row);
    if (usage.periodStart !== period) return null;
    if (input.mode === "shadow") {
      if (billable > usage.shadowMicros)
        await tx.execute(
          sql`update site_platform_usage set shadow_micros = ${billable}, updated_at = now()
            where workspace_id = ${scope.workspaceId}`,
        );
      return null;
    }
    const delta = billable - usage.chargedMicros;
    if (delta < Math.max(1, input.minimumMicros)) return null;
    const seq = usage.chargeSeq + 1;
    await tx.execute(
      sql`update site_platform_usage set charged_micros = ${billable}, charge_seq = ${seq},
          updated_at = now()
        where workspace_id = ${scope.workspaceId}`,
    );
    const claim = { deltaMicros: delta, seq, periodStart: period };
    if (input.debit) await input.debit(tx, claim);
    return claim;
  });
}

async function inPlatformLane<T>(db: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await enterPlatformLane(tx);
    return await fn(tx);
  });
}

/** Opengeni-wide totals of this month and the current storage level. */
export async function readSitePlatformTotals(
  db: Database,
  now: Date = new Date(),
): Promise<SitePlatformTotals> {
  const period = sitePlatformPeriod(now);
  return await inPlatformLane(db, async (tx) => {
    const [totals] = await rawRows<{
      requests: unknown;
      sql_rows_read: unknown;
      sql_rows_written: unknown;
    }>(
      tx,
      sql`select coalesce(sum(requests), 0) as requests,
          coalesce(sum(sql_rows_read), 0) as sql_rows_read,
          coalesce(sum(sql_rows_written), 0) as sql_rows_written
        from site_platform_totals where period_start = ${period}::date`,
    );
    const [storage] = await rawRows<{ bytes: unknown }>(
      tx,
      sql`select coalesce(sum(storage_bytes), 0) as bytes from site_platform_storage`,
    );
    return {
      periodStart: period,
      requests: counter(totals?.requests),
      sqlRowsRead: counter(totals?.sql_rows_read),
      sqlRowsWritten: counter(totals?.sql_rows_written),
      storageBytes: counter(storage?.bytes),
    };
  });
}

type BrakeRow = {
  period_start: unknown;
  alerted_at: unknown;
  engaged_at: unknown;
  engaged_by: "auto" | "operator" | null;
  engaged_reason: string | null;
  lifted_at: unknown;
  lifted_by: string | null;
  lift_reason: string | null;
  last_estimate_micros: unknown;
};

const BRAKE_COLUMNS = sql`period_start::text as period_start, alerted_at, engaged_at, engaged_by,
  engaged_reason, lifted_at, lifted_by, lift_reason, last_estimate_micros`;

function toBrake(row: BrakeRow): SitePlatformBrakeRecord {
  return {
    periodStart: String(row.period_start).slice(0, 10),
    alertedAt: optionalDate(row.alerted_at),
    engagedAt: optionalDate(row.engaged_at),
    engagedBy: row.engaged_by,
    engagedReason: row.engaged_reason,
    liftedAt: optionalDate(row.lifted_at),
    liftedBy: row.lifted_by,
    liftReason: row.lift_reason,
    lastEstimateMicros: counter(row.last_estimate_micros),
  };
}

function emptyBrake(period: string): SitePlatformBrakeRecord {
  return {
    periodStart: period,
    alertedAt: null,
    engagedAt: null,
    engagedBy: null,
    engagedReason: null,
    liftedAt: null,
    liftedBy: null,
    liftReason: null,
    lastEstimateMicros: 0,
  };
}

/** The brake state of the month of `now` (a new month starts released). */
export async function readSitePlatformBrake(
  db: Database,
  now: Date = new Date(),
): Promise<SitePlatformBrakeRecord> {
  const period = sitePlatformPeriod(now);
  return await inPlatformLane(db, async (tx) => {
    const [row] = await rawRows<BrakeRow>(
      tx,
      sql`select ${BRAKE_COLUMNS} from site_platform_brake where period_start = ${period}::date`,
    );
    return row ? toBrake(row) : emptyBrake(period);
  });
}

/**
 * Record an evaluation of this month's estimate: the first one at or past
 * the alert threshold sets alerted_at, and one at or past the limit engages
 * the brake automatically unless it is engaged already or an operator lifted
 * it this month. Returns the state after and what changed.
 */
export async function evaluateSitePlatformBrake(
  db: Database,
  input: { estimateMicros: number; alert: boolean; limit: boolean; now?: Date },
): Promise<{ brake: SitePlatformBrakeRecord; alerted: boolean; engaged: boolean }> {
  const period = sitePlatformPeriod(input.now);
  const estimate = Math.max(0, Math.floor(input.estimateMicros));
  return await inPlatformLane(db, async (tx) => {
    const [before] = await rawRows<BrakeRow>(
      tx,
      sql`insert into site_platform_brake (period_start, last_estimate_micros)
        values (${period}::date, ${estimate})
        on conflict (period_start) do update set
          last_estimate_micros = greatest(site_platform_brake.last_estimate_micros,
            excluded.last_estimate_micros),
          updated_at = now()
        returning ${BRAKE_COLUMNS}`,
    );
    const state = toBrake(before!);
    const alerted = input.alert && state.alertedAt === null;
    const engaged = input.limit && state.engagedAt === null && state.liftedAt === null;
    if (!alerted && !engaged) return { brake: state, alerted, engaged };
    const [after] = await rawRows<BrakeRow>(
      tx,
      sql`update site_platform_brake set
          alerted_at = case when ${alerted} then coalesce(alerted_at, now()) else alerted_at end,
          engaged_at = case when ${engaged} then now() else engaged_at end,
          engaged_by = case when ${engaged} then 'auto' else engaged_by end,
          engaged_reason = case when ${engaged}
            then 'The monthly Site platform limit was reached' else engaged_reason end,
          updated_at = now()
        where period_start = ${period}::date
        returning ${BRAKE_COLUMNS}`,
    );
    return { brake: toBrake(after!), alerted, engaged };
  });
}

/** Engage the brake by hand for this month (clears a lift). */
export async function engageSitePlatformBrake(
  db: Database,
  input: { reason: string; now?: Date },
): Promise<SitePlatformBrakeRecord> {
  const period = sitePlatformPeriod(input.now);
  return await inPlatformLane(db, async (tx) => {
    const [row] = await rawRows<BrakeRow>(
      tx,
      sql`insert into site_platform_brake (period_start, engaged_at, engaged_by, engaged_reason)
        values (${period}::date, now(), 'operator', ${input.reason.slice(0, 2000)})
        on conflict (period_start) do update set engaged_at = now(), engaged_by = 'operator',
          engaged_reason = excluded.engaged_reason, lifted_at = null, lifted_by = null,
          lift_reason = null, updated_at = now()
        returning ${BRAKE_COLUMNS}`,
    );
    return toBrake(row!);
  });
}

/**
 * Lift the brake for the rest of this month: it stays released, and is not
 * engaged automatically again, until the month ends or an operator engages it.
 */
export async function liftSitePlatformBrake(
  db: Database,
  input: { by: string; reason: string; now?: Date },
): Promise<SitePlatformBrakeRecord> {
  const period = sitePlatformPeriod(input.now);
  return await inPlatformLane(db, async (tx) => {
    const [row] = await rawRows<BrakeRow>(
      tx,
      sql`insert into site_platform_brake (period_start, lifted_at, lifted_by, lift_reason)
        values (${period}::date, now(), ${input.by.slice(0, 300)}, ${input.reason.slice(0, 2000)})
        on conflict (period_start) do update set engaged_at = null, engaged_by = null,
          engaged_reason = null, lifted_at = now(), lifted_by = excluded.lifted_by,
          lift_reason = excluded.lift_reason, updated_at = now()
        returning ${BRAKE_COLUMNS}`,
    );
    return toBrake(row!);
  });
}
