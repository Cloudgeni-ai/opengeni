import { createHash } from "node:crypto";
import {
  compileSiteSql,
  isSiteSqlPrincipalParam,
  isSiteSqlTableName,
  SITE_SQL_HARD_LIMITS,
  SITE_SQL_IDENTIFIER,
  SITE_SQL_NAME,
  type SiteDbExportResponse,
  type SiteDbInspectResponse,
  type SiteDbMeter,
  type SiteDbMigrateResponse,
  type SiteDbRunResponse,
  type SiteDbSchemaEntry,
  type SiteSqlDescribeResponse,
  type SiteSqlErrorCode,
  type SiteSqlExportFormat,
  type SiteSqlImportRequest,
  type SiteSqlImportResponse,
  type SiteSqlInspectResponse,
  type SiteSqlLimits,
  type SiteSqlMigrateResponse,
  type SiteSqlMigrationResponse,
  type SiteSqlQueryAudience,
  type SiteSqlQueryDefinitionRequest,
  type SiteSqlQueryResponse,
  type SiteSqlResetResponse,
  type SiteSqlRunResponse,
  type SiteSqlValue,
  type SiteLimitProfileKind,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  appendSiteSqlMigration,
  clearSiteSqlDefinitions,
  consumeSiteSqlRate,
  deleteSiteSqlQuery,
  getSiteSqlDatabase,
  getSiteSqlQuery,
  getSitePublication,
  getWorkspaceSiteLimitProfile,
  listSiteSqlMigrations,
  listSiteSqlQueries,
  listSiteSqlSiteIds,
  markSiteSqlRebuilt,
  recordSiteSqlUsage,
  recordUsageEvent,
  setSiteSqlEnabled,
  SiteDataError,
  siteSqlMigrationBytes,
  siteSqlMigrationQuotaError,
  SiteSqlStoreError,
  upsertSiteSqlQuery,
  withSiteSqlDatabaseLock,
  type Database,
  type SiteSqlDatabase,
  type SiteSqlScope,
  type SiteSqlStoredMigration,
  type SiteSqlStoredQuery,
} from "@opengeni/db";
import { parseSiteDataCsv } from "../site-data/operations";
import { sourceSiteLimitProfile } from "../site-publishing/limits";
import {
  resolveSiteDataAccess,
  type SiteDataAccess,
  type SiteDataSurface,
} from "../site-data/service";
import {
  callSiteDb,
  SiteDbCallError,
  siteSqlGatewayConfig,
  siteSqlOffered,
  type SiteDbFetch,
  type SiteSqlGatewayConfig,
} from "./gateway";
import {
  siteSqlCsvLine,
  siteSqlImportRows,
  siteSqlInsertStatements,
  siteSqlRowObjects,
  siteSqlSchemaEntries,
  siteSqlSchemaStatements,
} from "./format";

/**
 * Site SQL: optional per-Site Cloudflare storage. One SQLite Durable Object
 * per Site holds the rows; Postgres holds whether the owner turned it on, the
 * ordered migrations and the named queries (so the database can always be
 * rebuilt), usage counters and call windows. Every surface (Site pages through
 * the workspace API or site-runtime, the console and first-party agent tools)
 * goes through here: it resolves the caller with Site Data's rules (a Site
 * frame is always a viewer; managers manage), checks audiences, binds the
 * viewer's principal into `:viewer` parameters, applies limits, meters usage
 * in `usage_only` mode, and only then calls the gateway, which re-checks every
 * statement in the Durable Object.
 */

export type SiteSqlDeps = Pick<ApiRouteDeps, "db" | "settings">;

/** Who is calling: whatever Site Data accepts (an access grant, or a published Site viewer). */
export type SiteSqlAuthority = Parameters<typeof resolveSiteDataAccess>[1];

export class SiteSqlError extends Error {
  constructor(
    readonly code: SiteSqlErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SiteSqlError";
  }
}

/** The transport to the gateway; tests replace `fetch`. */
export const siteSqlTransport: { fetch: SiteDbFetch } = {
  fetch: (input, init) => fetch(input, init),
};

/** Calls per minute all of a Site's managers may make together (console and agents). */
export const SITE_SQL_MANAGER_CALLS_PER_MINUTE = 600;
/** One export response stops adding rows past this many bytes and returns a next cursor. */
export const SITE_SQL_EXPORT_MAX_BYTES = SITE_SQL_HARD_LIMITS.exportBytesPerResponse;
/** Rows per export page the API asks the Durable Object for. */
const EXPORT_PAGE_ROWS = 1_000;
/** Most JSON bytes one insert call carries (the gateway accepts 8 MiB). */
const IMPORT_CHUNK_BYTES = 2 * 1024 * 1024;
/** Most characters and statements of one data script call of a SQL import. */
const IMPORT_SCRIPT_CHARS = 1_000_000;
const IMPORT_SCRIPT_STATEMENTS = 1_000;
/** Most JSON bytes of migrations one migrate call carries (the gateway accepts 8 MiB). */
const MIGRATE_CALL_BYTES = 4 * 1024 * 1024;
/** CSV imports accept at most this many columns. */
const IMPORT_MAX_COLUMNS = 1_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const DB_CODES: Record<string, SiteSqlErrorCode> = {
  validation: "validation",
  sql_error: "sql_error",
  quota_exceeded: "quota_exceeded",
  conflict: "conflict",
  too_large: "validation",
};

/** Typed errors from every layer as SiteSqlError. */
export function toSiteSqlError(error: unknown): unknown {
  if (error instanceof SiteSqlError) return error;
  if (error instanceof SiteDataError)
    return new SiteSqlError(
      error.code === "quota_exceeded" ? "quota_exceeded" : error.code,
      error.message,
      error.details,
    );
  if (error instanceof SiteSqlStoreError)
    return new SiteSqlError(error.code, error.message, error.details);
  if (error instanceof SiteDbCallError) {
    if (error.code === "replayed")
      return new SiteSqlError("unavailable", "The Site database saw this request already", {
        retryable: true,
      });
    const code = DB_CODES[error.code] ?? "unavailable";
    return new SiteSqlError(code, error.message, {
      ...(code === "unavailable" ? { retryable: !error.outcomeUnknown } : {}),
      ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
    });
  }
  return error;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toSiteSqlError(error);
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export type SiteSqlLimitSettings = Pick<
  SiteSqlDeps["settings"],
  | "sitesSqlFreeStorageBytes"
  | "sitesSqlFreeRowsReadPerMonth"
  | "sitesSqlFreeRowsWrittenPerMonth"
  | "sitesSqlFreeCallsPerMinutePerViewer"
  | "sitesSqlFreeCallsPerMinutePerSite"
  | "sitesSqlMaxRowsPerCall"
  | "sitesSqlMaxResponseBytes"
  | "sitesCreditsLimitMultiplier"
>;

/** The limit profile kinds of published Sites (docs/published-sites.md). */
export type SiteSqlProfileKind = SiteLimitProfileKind;

/** Flood brakes that hold under every profile, including unlimited. */
export const SITE_SQL_FLOOD_BRAKES = Object.freeze({
  callsPerMinutePerViewer: 600,
  callsPerMinutePerSite: 6_000,
});

/**
 * Site SQL limits for a limit profile: free and custom use the free settings
 * (custom overrides carry no SQL fields yet), credits multiplies the storage,
 * monthly row and per-viewer caps, and unlimited removes the monthly caps but
 * keeps the hard storage ceiling and the flood brakes. Rows per call and
 * response size are the same everywhere.
 */
export function siteSqlLimits(
  settings: SiteSqlLimitSettings,
  kind: SiteSqlProfileKind = "free",
): SiteSqlLimits {
  const brake = (value: number, ceiling: number) => Math.min(value, ceiling);
  const common = {
    maxRowsPerCall: brake(settings.sitesSqlMaxRowsPerCall, SITE_SQL_HARD_LIMITS.maxRowsPerCall),
    maxResponseBytes: brake(
      settings.sitesSqlMaxResponseBytes,
      SITE_SQL_HARD_LIMITS.maxResponseBytes,
    ),
  };
  const free: SiteSqlLimits = {
    storageBytesPerSite: brake(
      settings.sitesSqlFreeStorageBytes,
      SITE_SQL_HARD_LIMITS.storageBytesPerSite,
    ),
    rowsReadPerSitePerMonth: settings.sitesSqlFreeRowsReadPerMonth,
    rowsWrittenPerSitePerMonth: settings.sitesSqlFreeRowsWrittenPerMonth,
    callsPerMinutePerViewer: brake(
      settings.sitesSqlFreeCallsPerMinutePerViewer,
      SITE_SQL_FLOOD_BRAKES.callsPerMinutePerViewer,
    ),
    callsPerMinutePerSite: brake(
      settings.sitesSqlFreeCallsPerMinutePerSite,
      SITE_SQL_FLOOD_BRAKES.callsPerMinutePerSite,
    ),
    ...common,
  };
  if (kind === "credits") {
    const factor = settings.sitesCreditsLimitMultiplier;
    return {
      ...free,
      storageBytesPerSite: brake(
        settings.sitesSqlFreeStorageBytes * factor,
        SITE_SQL_HARD_LIMITS.storageBytesPerSite,
      ),
      rowsReadPerSitePerMonth: settings.sitesSqlFreeRowsReadPerMonth * factor,
      rowsWrittenPerSitePerMonth: settings.sitesSqlFreeRowsWrittenPerMonth * factor,
      callsPerMinutePerViewer: brake(
        settings.sitesSqlFreeCallsPerMinutePerViewer * factor,
        SITE_SQL_FLOOD_BRAKES.callsPerMinutePerViewer,
      ),
      callsPerMinutePerSite: brake(
        settings.sitesSqlFreeCallsPerMinutePerSite * factor,
        SITE_SQL_FLOOD_BRAKES.callsPerMinutePerSite,
      ),
    };
  }
  if (kind === "unlimited")
    return {
      ...free,
      storageBytesPerSite: SITE_SQL_HARD_LIMITS.storageBytesPerSite,
      rowsReadPerSitePerMonth: null,
      rowsWrittenPerSitePerMonth: null,
      callsPerMinutePerViewer: SITE_SQL_FLOOD_BRAKES.callsPerMinutePerViewer,
      callsPerMinutePerSite: SITE_SQL_FLOOD_BRAKES.callsPerMinutePerSite,
    };
  return free;
}

/**
 * The limit profile in force for a Site, the same one published Sites use:
 * the Site's own profile, else the workspace default, else free. Sites that
 * were never published have no profile of their own.
 */
export async function siteSqlProfileKind(
  deps: Pick<SiteSqlDeps, "db">,
  scope: SiteSqlScope,
): Promise<SiteSqlProfileKind> {
  const publishing = { accountId: scope.accountId, workspaceId: scope.workspaceId };
  const publication = await getSitePublication(deps.db, publishing, scope.siteId);
  const site = publication?.limitProfile ?? null;
  const workspace = site ? null : await getWorkspaceSiteLimitProfile(deps.db, publishing);
  return sourceSiteLimitProfile(site, workspace).kind;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

type Resolved = {
  access: SiteDataAccess;
  scope: SiteSqlScope;
  /** The gateway, when its origin and secret are configured (reaching existing databases). */
  gateway: SiteSqlGatewayConfig | null;
  /** Whether this deployment offers Site SQL (the flag and the gateway). */
  offered: boolean;
  guest: boolean;
};

async function resolve(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  surface: SiteDataSurface,
): Promise<Resolved> {
  const access = await resolveSiteDataAccess(deps, authority, siteId, surface);
  return {
    access,
    scope: {
      accountId: access.caller.accountId,
      workspaceId: access.caller.workspaceId,
      siteId,
    },
    gateway: siteSqlGatewayConfig(deps.settings),
    offered: siteSqlOffered(deps.settings),
    guest: (access.caller as { guest?: boolean }).guest === true,
  };
}

function unavailable(): SiteSqlError {
  return new SiteSqlError("unavailable", "Site SQL is not available on this deployment");
}

/**
 * The gateway for an operation. `offered` (turning on, migrating, rebuilding,
 * importing and running SQL) needs Site SQL offered; `configured` (export,
 * inspect, dropping the data) only needs the gateway, so data can always
 * leave even after the flag is turned off.
 */
function requireGateway(
  resolved: Resolved,
  need: "offered" | "configured" = "offered",
): SiteSqlGatewayConfig {
  if (!resolved.gateway || (need === "offered" && !resolved.offered)) throw unavailable();
  return resolved.gateway;
}

/** The Site's database row; `enabled` requires the owner to have turned it on. */
async function requireDatabase(
  deps: SiteSqlDeps,
  resolved: Resolved,
  options: { enabled: boolean },
): Promise<SiteSqlDatabase> {
  const database = await getSiteSqlDatabase(deps.db, resolved.scope);
  if (!database || (options.enabled && !database.enabled))
    throw new SiteSqlError(
      "disabled",
      database
        ? "Site SQL is turned off for this Site"
        : "Site SQL is not turned on for this Site; turn it on first",
    );
  return database;
}

async function limitsFor(
  deps: SiteSqlDeps,
  scope: SiteSqlScope,
  kind?: SiteSqlProfileKind,
): Promise<SiteSqlLimits> {
  return siteSqlLimits(deps.settings, kind ?? (await siteSqlProfileKind(deps, scope)));
}

/** Count a call against the caller's windows before any work. */
async function consume(deps: SiteSqlDeps, resolved: Resolved, limits: SiteSqlLimits) {
  const { caller } = resolved.access;
  const windows: Array<readonly [string, number | null, string]> =
    caller.role === "manager" && !caller.framed
      ? [
          [
            "manager:*",
            SITE_SQL_MANAGER_CALLS_PER_MINUTE,
            "This Site's managers are calling too fast.",
          ],
        ]
      : [
          [caller.principal, limits.callsPerMinutePerViewer, "Too many database calls."],
          ["*", limits.callsPerMinutePerSite, "This Site is receiving too many database calls."],
        ];
  await consumeSiteSqlRate(deps.db, resolved.scope, windows);
}

function checkMonthly(
  database: SiteSqlDatabase,
  limits: SiteSqlLimits,
  needs: { read: boolean; write: boolean },
) {
  if (
    needs.read &&
    limits.rowsReadPerSitePerMonth !== null &&
    database.rowsReadThisMonth >= limits.rowsReadPerSitePerMonth
  )
    throw new SiteSqlError("quota_exceeded", "This Site has read all the rows it may this month", {
      quota: "rows_read_per_month",
      limit: limits.rowsReadPerSitePerMonth,
    });
  if (
    needs.write &&
    limits.rowsWrittenPerSitePerMonth !== null &&
    database.rowsWrittenThisMonth >= limits.rowsWrittenPerSitePerMonth
  )
    throw new SiteSqlError(
      "quota_exceeded",
      "This Site has written all the rows it may this month",
      { quota: "rows_written_per_month", limit: limits.rowsWrittenPerSitePerMonth },
    );
}

/** What the Durable Object calls of one operation did together. */
type Usage = SiteDbMeter & { calls: number };

function newUsage(): Usage {
  return { rowsRead: 0, rowsWritten: 0, databaseBytes: 0, calls: 0 };
}

function addUsage(usage: Usage, call: SiteDbMeter): void {
  usage.rowsRead += call.rowsRead;
  usage.rowsWritten += call.rowsWritten;
  usage.databaseBytes = call.databaseBytes;
  usage.calls += 1;
}

/**
 * Usage metering in `usage_only` mode (docs/credit-boundaries-rollout.md): the
 * workspace pays for viewer-triggered usage; events are recorded with the
 * Site's usage row and never debit credits until a reviewed rate is enabled.
 * Only Site page calls (`countTowardCaps`) add to the monthly counters the
 * caps read; management (export, inspect, migrations, resets, imports and
 * ad hoc statements) is recorded as events only. Metering runs after the
 * Durable Object answered, so a failure here is logged and never turns a
 * call that happened into an error.
 */
async function meter(
  deps: SiteSqlDeps,
  resolved: Resolved,
  usage: Usage,
  options: { countTowardCaps: boolean },
): Promise<void> {
  if (usage.calls === 0) return;
  const usageId = crypto.randomUUID();
  const common = {
    accountId: resolved.scope.accountId,
    workspaceId: resolved.scope.workspaceId,
    subjectId: resolved.access.subjectId,
    sourceResourceType: "site",
    sourceResourceId: resolved.scope.siteId,
  };
  try {
    await recordSiteSqlUsage(deps.db, resolved.scope, usage, {
      countTowardCaps: options.countTowardCaps,
      meter: async (tx: Database, change) => {
        const events: Array<[string, number, string]> = [
          ["site_sql.rows_read", usage.rowsRead, "row"],
          ["site_sql.rows_written", usage.rowsWritten, "row"],
          ["site_sql.storage_growth_bytes", change.storageGrowthBytes, "byte"],
        ];
        for (const [eventType, quantity, unit] of events)
          if (quantity > 0)
            await recordUsageEvent(tx, {
              ...common,
              eventType,
              quantity,
              unit,
              idempotencyKey: `${eventType}:${usageId}`,
            });
      },
    });
  } catch (error) {
    console.warn("[site-sql] could not meter usage", {
      workspaceId: resolved.scope.workspaceId,
      siteId: resolved.scope.siteId,
      rowsRead: usage.rowsRead,
      rowsWritten: usage.rowsWritten,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Why a caller may not run a named query of this audience, or null. Managers
 * (outside a Site frame) run every query; `managers` admits nobody else;
 * `signed_in` needs a person (not a guest, and not a service key, agent or
 * schedule acting on its own); `everyone` admits all.
 */
export function siteSqlAudienceRefusal(
  audience: SiteSqlQueryAudience,
  caller: { manager: boolean; guest: boolean; person: boolean },
): SiteSqlError | null {
  if (caller.manager) return null;
  if (audience === "managers")
    return new SiteSqlError("forbidden", "Only the Site's managers can run this query");
  if (audience === "signed_in" && (caller.guest || !caller.person))
    return new SiteSqlError("forbidden", "Sign in to use this", { reason: "sign_in_required" });
  return null;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function publicQuery(query: SiteSqlStoredQuery): SiteSqlQueryResponse {
  return {
    name: query.name,
    sql: query.sql,
    mode: query.mode,
    params: query.params,
    audience: query.audience,
    description: query.description,
    maxRows: query.maxRows,
    createdAt: query.createdAt.toISOString(),
    updatedAt: query.updatedAt.toISOString(),
  };
}

function publicMigration(migration: SiteSqlStoredMigration): SiteSqlMigrationResponse {
  return {
    ordinal: migration.ordinal,
    name: migration.name,
    sql: migration.sql,
    checksum: migration.checksum,
    createdAt: migration.createdAt.toISOString(),
  };
}

export function siteSqlChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function compileOrThrow(sql: string, profile: "named" | "agent" | "script") {
  const compiled = compileSiteSql(sql, profile);
  if (!compiled.ok)
    throw new SiteSqlError("validation", compiled.message, { problem: compiled.problem });
  return compiled;
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

export async function describeSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
): Promise<SiteSqlDescribeResponse> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const [database, migrations, queries, limits] = await Promise.all([
      getSiteSqlDatabase(deps.db, resolved.scope),
      listSiteSqlMigrations(deps.db, resolved.scope),
      listSiteSqlQueries(deps.db, resolved.scope),
      limitsFor(deps, resolved.scope),
    ]);
    return {
      siteId,
      available: resolved.offered,
      enabled: database?.enabled ?? false,
      migrations: migrations.map(publicMigration),
      queries: queries.map(publicQuery),
      usage: {
        storageBytes: database?.storageBytes ?? 0,
        rowsReadThisMonth: database?.rowsReadThisMonth ?? 0,
        rowsWrittenThisMonth: database?.rowsWrittenThisMonth ?? 0,
      },
      limits,
    };
  });
}

/** Turn Site SQL on or off for one Site. Turning it off keeps the data and definitions. */
export async function setSiteSqlSettings(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: { enabled: boolean },
): Promise<SiteSqlDescribeResponse> {
  await guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    if (request.enabled) requireGateway(resolved);
    await setSiteSqlEnabled(deps.db, resolved.scope, request.enabled, resolved.access.caller.actor);
  });
  return describeSiteSql(deps, authority, siteId);
}

/** Create, replace or delete (`request` null) a named query. */
export async function defineSiteSqlQuery(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  name: string,
  request: SiteSqlQueryDefinitionRequest | null,
): Promise<{ query: SiteSqlQueryResponse | null; created: boolean; deleted: boolean }> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    if (!SITE_SQL_NAME.test(name))
      throw new SiteSqlError(
        "validation",
        "A query name is a letter, then letters, digits, - or _",
      );
    await requireDatabase(deps, resolved, { enabled: false });
    if (request === null) {
      const deleted = await deleteSiteSqlQuery(deps.db, resolved.scope, name);
      if (!deleted) throw new SiteSqlError("not_found", `No query named ${name}`);
      return { query: null, created: false, deleted: true };
    }
    const compiled = compileOrThrow(request.sql, "named");
    const statement = compiled.statements[0]!;
    const stored = await upsertSiteSqlQuery(
      deps.db,
      resolved.scope,
      {
        name,
        sql: request.sql,
        mode: statement.kind === "write" ? "write" : "read",
        params: compiled.paramNames,
        audience: request.audience ?? "signed_in",
        description: request.description ?? null,
        maxRows: request.maxRows ?? null,
      },
      resolved.access.caller.actor,
    );
    return { query: publicQuery(stored.query), created: stored.created, deleted: false };
  });
}

type MigrationEntry = { name: string; sql: string; checksum: string; position: number };

function migrationEntry(migration: SiteSqlStoredMigration): MigrationEntry {
  return {
    name: migration.name,
    sql: migration.sql,
    checksum: migration.checksum,
    position: migration.ordinal,
  };
}

/** Split migrations into calls of at most MIGRATE_CALL_BYTES of JSON each. */
function migrationBatches(entries: readonly MigrationEntry[]): MigrationEntry[][] {
  const batches: MigrationEntry[][] = [];
  let current: MigrationEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (size > MIGRATE_CALL_BYTES)
      throw new SiteSqlError(
        "validation",
        `Migration ${entry.name} is too large to apply in one call; split it into smaller migrations`,
        { migration: entry.name, limit: MIGRATE_CALL_BYTES },
      );
    if (current.length > 0 && bytes + size > MIGRATE_CALL_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Apply migrations in the Durable Object in bounded calls, in order.
 * `rebuild` empties the database on the first call only (later calls add the
 * rest), and still makes one call when there is nothing to apply.
 */
async function applyMigrations(
  gateway: SiteSqlGatewayConfig,
  siteId: string,
  entries: readonly MigrationEntry[],
  options: { rebuild: boolean; maxDatabaseBytes: number },
  usage: Usage,
): Promise<string[]> {
  const batches = migrationBatches(entries);
  if (batches.length === 0 && options.rebuild) batches.push([]);
  const applied: string[] = [];
  for (const [index, batch] of batches.entries()) {
    const response = await callSiteDb<SiteDbMigrateResponse>(
      gateway,
      siteId,
      "migrate",
      {
        migrations: batch,
        ...(options.rebuild && index === 0 ? { rebuild: true } : {}),
        maxDatabaseBytes: options.maxDatabaseBytes,
      },
      siteSqlTransport.fetch,
    );
    addUsage(usage, response);
    applied.push(...response.applied);
  }
  return applied;
}

/**
 * Add a migration: checked against the Site's migration SQL cap, applied in
 * the Durable Object together with any earlier migration it is missing (only
 * those are sent, in bounded calls), then recorded in Postgres, all under the
 * Site's database lock.
 */
export async function migrateSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: { name: string; sql: string },
  options: { profileKind?: SiteSqlProfileKind } = {},
): Promise<SiteSqlMigrateResponse> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const gateway = requireGateway(resolved);
    await requireDatabase(deps, resolved, { enabled: true });
    if (!SITE_SQL_NAME.test(request.name))
      throw new SiteSqlError(
        "validation",
        "A migration name is a letter, then letters, digits, - or _",
      );
    const compiled = compileOrThrow(request.sql, "script");
    if (compiled.paramNames.length > 0)
      throw new SiteSqlError("validation", "Migrations cannot use :parameters");
    const limits = await limitsFor(deps, resolved.scope, options.profileKind);
    await consume(deps, resolved, limits);
    const checksum = siteSqlChecksum(request.sql);
    const actor = resolved.access.caller.actor;
    const usage = newUsage();
    try {
      const { migration, applied } = await withSiteSqlDatabaseLock(
        deps.db,
        resolved.scope,
        async (tx, locked) => {
          const existing = await listSiteSqlMigrations(tx, resolved.scope);
          if (existing.some((entry) => entry.name === request.name))
            throw new SiteSqlError("conflict", `A migration named ${request.name} already exists`);
          if (
            (await siteSqlMigrationBytes(tx, resolved.scope)) +
              Buffer.byteLength(request.sql, "utf8") >
            SITE_SQL_HARD_LIMITS.migrationBytesPerSite
          )
            throw siteSqlMigrationQuotaError();
          const inspected = await callSiteDb<SiteDbInspectResponse>(
            gateway,
            siteId,
            "inspect",
            { migrationsOnly: true },
            siteSqlTransport.fetch,
          );
          addUsage(usage, inspected);
          const inDatabase = new Map(
            inspected.migrations.map((entry) => [entry.name, entry.checksum]),
          );
          const pending = existing
            .filter((entry) => inDatabase.get(entry.name) !== entry.checksum)
            .map(migrationEntry);
          pending.push({
            name: request.name,
            sql: request.sql,
            checksum,
            position: locked.migrationCount + 1,
          });
          const appliedNow = await applyMigrations(
            gateway,
            siteId,
            pending,
            { rebuild: false, maxDatabaseBytes: limits.storageBytesPerSite },
            usage,
          );
          const appended = await appendSiteSqlMigration(
            tx,
            resolved.scope,
            { name: request.name, sql: request.sql, checksum },
            actor,
          );
          return { migration: appended, applied: appliedNow };
        },
      );
      return { migration: publicMigration(migration), applied };
    } finally {
      await meter(deps, resolved, usage, { countTowardCaps: false });
    }
  });
}

/**
 * Reset the Site's database. `schema: "keep"` (default) empties it and applies
 * every migration again in bounded calls (a rebuild from Postgres); `schema:
 * "drop"` deletes the database and forgets every migration and named query,
 * and works whenever the gateway is configured.
 */
export async function resetSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: { schema?: "keep" | "drop" | undefined },
): Promise<SiteSqlResetResponse> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const drop = request.schema === "drop";
    const gateway = requireGateway(resolved, drop ? "configured" : "offered");
    await requireDatabase(deps, resolved, { enabled: false });
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);
    const actor = resolved.access.caller.actor;
    const usage = newUsage();
    try {
      const applied = await withSiteSqlDatabaseLock(deps.db, resolved.scope, async (tx) => {
        if (drop) {
          const reset = await callSiteDb<SiteDbMeter>(
            gateway,
            siteId,
            "reset",
            {},
            siteSqlTransport.fetch,
          );
          addUsage(usage, reset);
          await clearSiteSqlDefinitions(tx, resolved.scope, actor);
          await markSiteSqlRebuilt(tx, resolved.scope, reset.databaseBytes);
          return [] as string[];
        }
        const migrations = await listSiteSqlMigrations(tx, resolved.scope);
        const rebuilt = await applyMigrations(
          gateway,
          siteId,
          migrations.map(migrationEntry),
          { rebuild: true, maxDatabaseBytes: limits.storageBytesPerSite },
          usage,
        );
        await markSiteSqlRebuilt(tx, resolved.scope, usage.databaseBytes);
        return rebuilt;
      });
      return { applied, droppedSchema: drop };
    } finally {
      await meter(deps, resolved, usage, { countTowardCaps: false });
    }
  });
}

/**
 * The Durable Object's tables, columns, row counts and applied migrations.
 * Works whenever the gateway is configured.
 */
export async function inspectSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
): Promise<SiteSqlInspectResponse> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const gateway = requireGateway(resolved, "configured");
    await requireDatabase(deps, resolved, { enabled: false });
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);
    const inspected = await callSiteDb<SiteDbInspectResponse>(
      gateway,
      siteId,
      "inspect",
      {},
      siteSqlTransport.fetch,
    );
    const usage = newUsage();
    addUsage(usage, inspected);
    await meter(deps, resolved, usage, { countTowardCaps: false });
    const applied = new Set(inspected.migrations.map((migration) => migration.name));
    const migrations = await listSiteSqlMigrations(deps.db, resolved.scope);
    const { rowsRead: _read, rowsWritten: _written, ...rest } = inspected;
    return {
      ...rest,
      pendingMigrations: migrations
        .filter((migration) => !applied.has(migration.name))
        .map((migration) => migration.name),
    };
  });
}

// ---------------------------------------------------------------------------
// Running SQL
// ---------------------------------------------------------------------------

/** The values Opengeni binds for `:viewer`, `:viewer_kind` and `:viewer_signed_in`. */
export function siteSqlPrincipalParams(
  access: Pick<SiteDataAccess, "caller" | "subjectId">,
  guest: boolean,
): Record<string, SiteSqlValue> {
  const principal = access.caller.principal;
  const kind = principal.includes(":") ? principal.slice(0, principal.indexOf(":")) : principal;
  return {
    viewer: principal,
    viewer_kind: kind,
    viewer_signed_in: !guest && access.subjectId !== null ? 1 : 0,
  };
}

/** Check caller parameters against a statement's names and add the principal ones. */
function bindParams(
  names: readonly string[],
  given: Readonly<Record<string, SiteSqlValue>>,
  principal: Record<string, SiteSqlValue>,
  options: { requireAll: boolean },
): Record<string, SiteSqlValue> {
  const known = new Set(names);
  for (const key of Object.keys(given)) {
    if (isSiteSqlPrincipalParam(key))
      throw new SiteSqlError(
        "validation",
        `:${key} is set by Opengeni from the signed-in viewer; do not send it`,
        { param: key },
      );
    if (!known.has(key))
      throw new SiteSqlError("validation", `This query has no parameter :${key}`, { param: key });
  }
  const bound: Record<string, SiteSqlValue> = {};
  for (const name of names) {
    if (isSiteSqlPrincipalParam(name)) {
      if (!Object.hasOwn(principal, name))
        throw new SiteSqlError("validation", `:${name} is reserved for Opengeni`, { param: name });
      bound[name] = principal[name]!;
    } else if (Object.hasOwn(given, name)) bound[name] = given[name]!;
    else if (options.requireAll)
      throw new SiteSqlError("validation", `Missing parameter :${name}`, { param: name });
    else bound[name] = null;
  }
  return bound;
}

function runResponse(response: SiteDbRunResponse): SiteSqlRunResponse {
  return {
    columns: response.columns,
    rows: response.rows,
    truncated: response.truncated,
    rowsRead: response.rowsRead,
    rowsWritten: response.rowsWritten,
  };
}

/**
 * Run a named query: what Site pages call with `site.sql.run(name, params)`.
 * Site frames and published viewers are viewers; the query's audience decides
 * who may run it (siteSqlAudienceRefusal). These calls count toward the
 * Site's monthly caps. `profileKind` skips reading the limit profile again
 * when the caller has it; `beforeWrite` runs for write queries before the
 * call is counted (the published runtime applies its guest write limit).
 */
export async function runSiteSqlQuery(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  name: string,
  params: Readonly<Record<string, SiteSqlValue>>,
  surface: SiteDataSurface = {},
  options: {
    profileKind?: SiteSqlProfileKind;
    beforeWrite?: () => Promise<void>;
  } = {},
): Promise<SiteSqlRunResponse> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { ...surface, management: false });
    const gateway = requireGateway(resolved);
    const database = await requireDatabase(deps, resolved, { enabled: true });
    const query = SITE_SQL_NAME.test(name)
      ? await getSiteSqlQuery(deps.db, resolved.scope, name)
      : null;
    if (!query) throw new SiteSqlError("not_found", `No query named ${name}`);
    const { caller } = resolved.access;
    const refusal = siteSqlAudienceRefusal(query.audience, {
      manager: caller.role === "manager" && !caller.framed,
      guest: resolved.guest,
      person: !resolved.guest && resolved.access.subjectId !== null,
    });
    if (refusal) throw refusal;
    if (query.mode === "write" && options.beforeWrite) await options.beforeWrite();
    const limits = await limitsFor(deps, resolved.scope, options.profileKind);
    await consume(deps, resolved, limits);
    checkMonthly(database, limits, { read: true, write: query.mode === "write" });
    const bound = bindParams(
      query.params,
      params,
      siteSqlPrincipalParams(resolved.access, resolved.guest),
      { requireAll: true },
    );
    const maxRows = Math.min(query.maxRows ?? limits.maxRowsPerCall, limits.maxRowsPerCall);
    const response = await callSiteDb<SiteDbRunResponse>(
      gateway,
      siteId,
      "run",
      {
        sql: query.sql,
        profile: "named",
        params: bound,
        expect: query.mode,
        maxRows,
        maxResponseBytes: limits.maxResponseBytes,
        maxDatabaseBytes: limits.storageBytesPerSite,
      },
      siteSqlTransport.fetch,
    );
    const usage = newUsage();
    addUsage(usage, response);
    await meter(deps, resolved, usage, { countTowardCaps: true });
    return runResponse(response);
  });
}

/**
 * One statement from a manager's agent or the console: `read` refuses writes
 * (rolled back in the Durable Object), `write` allows them. Schema changes
 * go through migrations so the database can be rebuilt. Management calls
 * are metered but do not count toward (or stop at) the monthly caps of the
 * Site's pages; the managers' call rate and the storage cap bound them.
 */
export async function runSiteSqlStatement(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: {
    sql: string;
    params?: Record<string, SiteSqlValue> | undefined;
    maxRows?: number | undefined;
  },
  mode: "read" | "write",
): Promise<SiteSqlRunResponse> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const gateway = requireGateway(resolved);
    await requireDatabase(deps, resolved, { enabled: true });
    const compiled = compileOrThrow(request.sql, "agent");
    const statement = compiled.statements[0]!;
    if (statement.kind === "schema")
      throw new SiteSqlError(
        "validation",
        "Change the schema with a migration (site_sql_migrate) so the database can be rebuilt",
        { problem: "statement_not_allowed" },
      );
    if (mode === "read" && statement.kind === "write")
      throw new SiteSqlError("validation", "This statement writes; use site_sql_execute", {
        problem: "statement_not_allowed",
      });
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);
    const bound = bindParams(
      compiled.paramNames,
      request.params ?? {},
      siteSqlPrincipalParams(resolved.access, false),
      { requireAll: true },
    );
    const response = await callSiteDb<SiteDbRunResponse>(
      gateway,
      siteId,
      "run",
      {
        sql: request.sql,
        profile: "agent",
        params: bound,
        expect: mode,
        maxRows: Math.min(request.maxRows ?? limits.maxRowsPerCall, limits.maxRowsPerCall),
        maxResponseBytes: limits.maxResponseBytes,
        maxDatabaseBytes: limits.storageBytesPerSite,
      },
      siteSqlTransport.fetch,
    );
    const usage = newUsage();
    addUsage(usage, response);
    await meter(deps, resolved, usage, { countTowardCaps: false });
    return runResponse(response);
  });
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

export type SiteSqlExport = {
  content: string;
  contentType: string;
  filename: string;
  truncated: boolean;
  /** Pass back as `cursor` for the next piece; null when this piece ends the export. */
  nextCursor: string | null;
};

const TRIGGER = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/iu;

/**
 * Export the Site's data so it can always leave Cloudflare: `sql` (schema and
 * INSERT statements), `csv` (one table) or `json` (schema and rows per table).
 * SQL and JSON keep every value; CSV turns values into text. Exports work
 * whenever the gateway is configured, while Site SQL is off and past the
 * monthly row caps (they are metered as management). One response holds at
 * most `maxBytes` (16 MiB at most); a larger export comes in pieces: pass
 * `nextCursor` back as `cursor` and append the pieces in order. Only the
 * first piece has the header (SQL schema, CSV header row, JSON schema) and
 * only the last SQL piece has the triggers, so the pieces together re-import
 * as one dump.
 */
export async function exportSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: {
    format: SiteSqlExportFormat;
    table?: string | undefined;
    cursor?: string | null | undefined;
    maxBytes?: number | undefined;
  },
): Promise<SiteSqlExport> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const gateway = requireGateway(resolved, "configured");
    await requireDatabase(deps, resolved, { enabled: false });
    if (request.format === "csv" && !request.table)
      throw new SiteSqlError("validation", "A CSV export needs a table");
    if (request.table !== undefined && !isSiteSqlTableName(request.table))
      throw new SiteSqlError("validation", `Invalid table name: ${request.table}`);
    const maxBytes = Math.max(
      1,
      Math.min(request.maxBytes ?? SITE_SQL_EXPORT_MAX_BYTES, SITE_SQL_EXPORT_MAX_BYTES),
    );
    const resumed = typeof request.cursor === "string" && request.cursor !== "";
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);

    const lines: string[] = [];
    let bytes = 0;
    const push = (line: string) => {
      lines.push(line);
      bytes += Buffer.byteLength(line, "utf8") + 1;
    };
    const json: {
      siteId: string;
      exportedAt: string;
      schema: string[];
      tables: Record<string, { columns: string[]; rows: Array<Record<string, unknown>> }>;
    } = { siteId, exportedAt: new Date().toISOString(), schema: [], tables: {} };
    let cursor: string | null = resumed ? (request.cursor as string) : null;
    let nextCursor: string | null = null;
    let first = true;
    let csvHeader = resumed;
    let schema: SiteDbSchemaEntry[] = [];
    const usage = newUsage();
    try {
      do {
        const page: SiteDbExportResponse = await callSiteDb<SiteDbExportResponse>(
          gateway,
          siteId,
          "export",
          {
            ...(request.table ? { tables: [request.table] } : {}),
            cursor,
            maxRows: EXPORT_PAGE_ROWS,
            maxBytes: Math.min(
              SITE_SQL_HARD_LIMITS.exportBytesPerCall,
              Math.max(1, maxBytes - bytes),
            ),
          },
          siteSqlTransport.fetch,
        );
        addUsage(usage, page);
        if (first) {
          first = false;
          if (request.table && !page.schema.some((entry) => entry.name === request.table))
            throw new SiteSqlError("not_found", `No table named ${request.table}`);
          schema = siteSqlSchemaEntries(page.schema, request.table);
          if (!resumed) {
            if (request.format === "sql") {
              push(`-- Opengeni Site SQL export of Site ${siteId}, ${json.exportedAt}`);
              push("-- Schema");
              for (const statement of siteSqlSchemaStatements(
                schema.filter((entry) => entry.type !== "trigger"),
              ))
                push(statement);
              push("-- Data");
            } else if (request.format === "json") json.schema = siteSqlSchemaStatements(schema);
          }
        }
        for (const table of page.tables) {
          if (request.format === "sql") {
            for (const statement of siteSqlInsertStatements(table)) push(statement);
          } else if (request.format === "csv") {
            if (!csvHeader) {
              push(siteSqlCsvLine(table.columns));
              csvHeader = true;
            }
            for (const row of table.rows) push(siteSqlCsvLine(row));
          } else {
            const entry = (json.tables[table.name] ??= { columns: table.columns, rows: [] });
            for (const row of siteSqlRowObjects(table)) {
              bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
              entry.rows.push(row);
            }
          }
        }
        cursor = page.nextCursor;
        if (cursor && bytes >= maxBytes) {
          nextCursor = cursor;
          break;
        }
      } while (cursor);
      if (request.format === "sql" && nextCursor === null) {
        const triggers = siteSqlSchemaStatements(
          schema.filter((entry) => entry.type === "trigger"),
        );
        if (triggers.length > 0) {
          push("-- Triggers (after the data, so they do not fire on imported rows)");
          for (const statement of triggers) push(statement);
        }
      }
      if (request.format === "csv" && !csvHeader) {
        // An empty table still exports its header.
        const inspected = await callSiteDb<SiteDbInspectResponse>(
          gateway,
          siteId,
          "inspect",
          {},
          siteSqlTransport.fetch,
        );
        addUsage(usage, inspected);
        const table = inspected.tables.find((entry) => entry.name === request.table);
        if (table) push(siteSqlCsvLine(table.columns.map((column) => column.name)));
      }
    } finally {
      await meter(deps, resolved, usage, { countTowardCaps: false });
    }
    const truncated = nextCursor !== null;
    const base = request.table ?? `site-${siteId}`;
    if (request.format === "json")
      return {
        content: JSON.stringify({ ...json, truncated, nextCursor }),
        contentType: "application/json",
        filename: `${base}.json`,
        truncated,
        nextCursor,
      };
    return {
      content: lines.length > 0 ? `${lines.join("\n")}\n` : "",
      contentType: request.format === "csv" ? "text/csv; charset=utf-8" : "application/sql",
      filename: `${base}.${request.format}`,
      truncated,
      nextCursor,
    };
  });
}

function importMigrationName(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  return `import_${stamp}_${crypto.randomUUID().slice(0, 4)}`;
}

function chunkRows(rows: SiteSqlValue[][]): SiteSqlValue[][][] {
  const chunks: SiteSqlValue[][][] = [];
  let current: SiteSqlValue[][] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (current.length > 0 && bytes + size > IMPORT_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Split statements into script calls of bounded size and count. */
function chunkStatements(statements: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const statement of statements) {
    const size = statement.length + 2;
    if (
      current.length > 0 &&
      (current.length >= IMPORT_SCRIPT_STATEMENTS || chars + size > IMPORT_SCRIPT_CHARS)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(statement);
    chars += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Import data. `sql`: schema statements (tables, views, indexes) become a
 * migration recorded in Postgres (so a rebuild keeps them), the data
 * statements run in batches, then triggers become a second migration (so
 * they do not fire on imported rows); `csv` and `json` insert rows into an
 * existing table (a CSV header names the columns; an empty cell is NULL).
 * Batches that ran stay when a later one fails; the error says how much
 * landed and which migration was recorded. A dump larger than one call
 * imports piece by piece, in order (the first piece holds the schema, the
 * last the triggers). Imports are metered as management.
 */
export async function importSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: SiteSqlImportRequest,
): Promise<SiteSqlImportResponse> {
  const resolved = await guarded(() => resolve(deps, authority, siteId, { management: true }));
  if (request.format === "sql") {
    const compiled = await guarded(async () => {
      requireGateway(resolved);
      const result = compileOrThrow(request.sql ?? "", "script");
      if (result.paramNames.length > 0)
        throw new SiteSqlError("validation", "SQL imports cannot use :parameters");
      return result;
    });
    const schema = compiled.statements.filter(
      (statement) => statement.kind === "schema" && !TRIGGER.test(statement.sql),
    );
    const triggers = compiled.statements.filter(
      (statement) => statement.kind === "schema" && TRIGGER.test(statement.sql),
    );
    const data = compiled.statements.filter((statement) => statement.kind !== "schema");
    const base = importMigrationName();
    const migrations: string[] = [];
    let migration: string | null = null;
    if (schema.length > 0) {
      migration = base;
      await migrateSiteSql(deps, authority, siteId, {
        name: migration,
        sql: `${schema.map((statement) => statement.sql).join(";\n")};`,
      });
      migrations.push(migration);
    }
    let imported = 0;
    let rowsWritten = 0;
    const partial = (error: unknown) => {
      const typed = toSiteSqlError(error);
      if (!(typed instanceof SiteSqlError) || (imported === 0 && migrations.length === 0))
        return typed;
      const recorded =
        migrations.length > 0
          ? ` Migration ${migrations.join(" and ")} stays recorded and applied; do not import the schema again.`
          : "";
      return new SiteSqlError(
        typed.code,
        `${typed.message} (${imported} data statements were imported before this.${recorded})`,
        { ...typed.details, imported, migration, migrations: [...migrations] },
      );
    };
    if (data.length > 0) {
      const usage = newUsage();
      try {
        const gateway = requireGateway(resolved);
        await requireDatabase(deps, resolved, { enabled: true });
        const limits = await limitsFor(deps, resolved.scope);
        await consume(deps, resolved, limits);
        for (const chunk of chunkStatements(data.map((statement) => statement.sql))) {
          const response = await callSiteDb<SiteDbMeter>(
            gateway,
            siteId,
            "script",
            { sql: `${chunk.join(";\n")};`, maxDatabaseBytes: limits.storageBytesPerSite },
            siteSqlTransport.fetch,
          );
          addUsage(usage, response);
          imported += chunk.length;
          rowsWritten += response.rowsWritten;
        }
      } catch (error) {
        throw partial(error);
      } finally {
        await meter(deps, resolved, usage, { countTowardCaps: false });
      }
    }
    if (triggers.length > 0) {
      const name = `${base}_triggers`;
      try {
        await migrateSiteSql(deps, authority, siteId, {
          name,
          sql: `${triggers.map((statement) => statement.sql).join(";\n")};`,
        });
      } catch (error) {
        throw partial(error);
      }
      migrations.push(name);
    }
    return { imported, migration, migrations, rowsWritten };
  }
  return guarded(async () => {
    const gateway = requireGateway(resolved);
    await requireDatabase(deps, resolved, { enabled: true });
    const table = request.table ?? "";
    if (!isSiteSqlTableName(table))
      throw new SiteSqlError("validation", `Invalid table name: ${table}`);
    let columns: string[];
    let rows: SiteSqlValue[][];
    if (request.format === "csv") {
      let parsed: string[][];
      try {
        parsed = parseSiteDataCsv(request.csv ?? "", {
          maxColumns: IMPORT_MAX_COLUMNS,
          maxRecords: SITE_SQL_HARD_LIMITS.importRowsPerCall,
        });
      } catch (error) {
        if (error instanceof SiteDataError) throw new SiteSqlError("validation", error.message);
        throw error;
      }
      const [header, ...body] = parsed;
      if (!header || header.length === 0)
        throw new SiteSqlError("validation", "The CSV needs a header row of column names");
      columns = header.map((name) => name.trim());
      rows = body.map((cells) => columns.map((_, index) => cells[index] || null));
    } else {
      const shaped = siteSqlImportRows(request.rows ?? []);
      columns = shaped.columns;
      rows = shaped.values;
    }
    if (columns.length === 0) throw new SiteSqlError("validation", "Give at least one column");
    for (const column of columns)
      if (!SITE_SQL_IDENTIFIER.test(column))
        throw new SiteSqlError("validation", `Invalid column name: ${column}`);
    if (new Set(columns).size !== columns.length)
      throw new SiteSqlError("validation", "A column is named twice");
    if (rows.length === 0) return { imported: 0, migration: null, migrations: [], rowsWritten: 0 };
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);
    let imported = 0;
    let rowsWritten = 0;
    const usage = newUsage();
    try {
      for (const chunk of chunkRows(rows)) {
        let response: SiteDbMeter;
        try {
          response = await callSiteDb<SiteDbMeter>(
            gateway,
            siteId,
            "insert",
            {
              table,
              columns,
              rows: chunk,
              onConflict: request.onConflict ?? "fail",
              maxDatabaseBytes: limits.storageBytesPerSite,
            },
            siteSqlTransport.fetch,
          );
        } catch (error) {
          const typed = toSiteSqlError(error);
          if (typed instanceof SiteSqlError && imported > 0)
            throw new SiteSqlError(typed.code, typed.message, { ...typed.details, imported });
          throw typed;
        }
        addUsage(usage, response);
        imported += chunk.length;
        rowsWritten += response.rowsWritten;
      }
    } finally {
      await meter(deps, resolved, usage, { countTowardCaps: false });
    }
    return { imported, migration: null, migrations: [], rowsWritten };
  });
}

/**
 * The Sites of a workspace that have a Site SQL database, read before the
 * workspace is deleted (its Postgres rows cascade with it; the Durable
 * Objects do not). Empty when no gateway is configured or the read fails.
 */
export async function siteSqlSitesOfWorkspace(
  deps: Pick<ApiRouteDeps, "db"> & { settings?: SiteSqlDeps["settings"] | undefined },
  scope: { accountId: string; workspaceId: string },
): Promise<string[]> {
  if (!deps.settings || !siteSqlGatewayConfig(deps.settings)) return [];
  try {
    return await listSiteSqlSiteIds(deps.db, scope);
  } catch (error) {
    console.warn("[site-sql] could not list a workspace's Site databases before deleting it", {
      workspaceId: scope.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Drop the data of Site databases whose workspace was deleted, best effort:
 * failures are logged (the data stays in its Durable Object until a later
 * sweep; see docs/site-data.md).
 */
export async function dropSiteSqlDatabases(
  deps: { settings?: SiteSqlDeps["settings"] | undefined },
  siteIds: readonly string[],
): Promise<void> {
  const gateway = deps.settings ? siteSqlGatewayConfig(deps.settings) : null;
  if (!gateway) return;
  for (const siteId of siteIds) {
    try {
      await callSiteDb<SiteDbMeter>(gateway, siteId, "reset", {}, siteSqlTransport.fetch);
    } catch (error) {
      console.warn("[site-sql] could not drop a deleted workspace's Site database", {
        siteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
