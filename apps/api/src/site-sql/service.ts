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
  type SiteSqlDescribeResponse,
  type SiteSqlErrorCode,
  type SiteSqlExportFormat,
  type SiteSqlImportRequest,
  type SiteSqlImportResponse,
  type SiteSqlInspectResponse,
  type SiteSqlLimits,
  type SiteSqlMigrateResponse,
  type SiteSqlMigrationResponse,
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
  markSiteSqlRebuilt,
  recordSiteSqlUsage,
  recordUsageEvent,
  setSiteSqlEnabled,
  SiteDataError,
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
  type SiteDbFetch,
  type SiteSqlGatewayConfig,
} from "./gateway";
import {
  siteSqlCsvLine,
  siteSqlImportRows,
  siteSqlInsertStatements,
  siteSqlRowObjects,
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
/** Exports stop adding rows past this many bytes and report truncation. */
export const SITE_SQL_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
/** Rows per export page the API asks the Durable Object for. */
const EXPORT_PAGE_ROWS = 1_000;
/** Most JSON bytes one insert call carries (the gateway accepts 8 MiB). */
const IMPORT_CHUNK_BYTES = 2 * 1024 * 1024;
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
  gateway: SiteSqlGatewayConfig | null;
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
    guest: (access.caller as { guest?: boolean }).guest === true,
  };
}

function unavailable(): SiteSqlError {
  return new SiteSqlError("unavailable", "Site SQL is not available on this deployment");
}

function requireGateway(resolved: Resolved): SiteSqlGatewayConfig {
  if (!resolved.gateway) throw unavailable();
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

async function limitsFor(deps: SiteSqlDeps, scope: SiteSqlScope): Promise<SiteSqlLimits> {
  return siteSqlLimits(deps.settings, await siteSqlProfileKind(deps, scope));
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

/**
 * Usage metering in `usage_only` mode (docs/credit-boundaries-rollout.md): the
 * workspace pays for viewer-triggered usage; events are recorded with the
 * Site's counters and never debit credits until a reviewed rate is enabled.
 */
async function meter(
  deps: SiteSqlDeps,
  resolved: Resolved,
  usage: SiteDbMeter,
): Promise<SiteSqlDatabase | null> {
  const usageId = crypto.randomUUID();
  const common = {
    accountId: resolved.scope.accountId,
    workspaceId: resolved.scope.workspaceId,
    subjectId: resolved.access.subjectId,
    sourceResourceType: "site",
    sourceResourceId: resolved.scope.siteId,
  };
  return recordSiteSqlUsage(deps.db, resolved.scope, usage, async (tx: Database, change) => {
    const events: Array<[string, number, string]> = [
      ["site_sql.rows_read", usage.rowsRead, "row"],
      ["site_sql.rows_written", usage.rowsWritten, "row"],
      [
        "site_sql.storage_growth_bytes",
        Math.max(0, usage.databaseBytes - change.storageBytesBefore),
        "byte",
      ],
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
  });
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
      available: resolved.gateway !== null,
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

/**
 * Add a migration: checked, applied in the Durable Object together with any
 * earlier migration it is missing, then recorded in Postgres, all under the
 * Site's database lock.
 */
export async function migrateSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: { name: string; sql: string },
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
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);
    const checksum = siteSqlChecksum(request.sql);
    const actor = resolved.access.caller.actor;
    const { migration, response } = await withSiteSqlDatabaseLock(
      deps.db,
      resolved.scope,
      async (tx) => {
        const existing = await listSiteSqlMigrations(tx, resolved.scope);
        if (existing.some((entry) => entry.name === request.name))
          throw new SiteSqlError("conflict", `A migration named ${request.name} already exists`);
        const response = await callSiteDb<SiteDbMigrateResponse>(
          gateway,
          siteId,
          "migrate",
          {
            migrations: [
              ...existing.map(({ name, sql, checksum: sum }) => ({ name, sql, checksum: sum })),
              { name: request.name, sql: request.sql, checksum },
            ],
            maxDatabaseBytes: limits.storageBytesPerSite,
          },
          siteSqlTransport.fetch,
        );
        const migration = await appendSiteSqlMigration(
          tx,
          resolved.scope,
          { name: request.name, sql: request.sql, checksum },
          actor,
        );
        return { migration, response };
      },
    );
    await meter(deps, resolved, response);
    return { migration: publicMigration(migration), applied: response.applied };
  });
}

/**
 * Reset the Site's database. `schema: "keep"` (default) empties it and applies
 * every migration again (a rebuild from Postgres); `schema: "drop"` deletes
 * the database and forgets every migration and named query.
 */
export async function resetSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: { schema?: "keep" | "drop" | undefined },
): Promise<SiteSqlResetResponse> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const gateway = requireGateway(resolved);
    await requireDatabase(deps, resolved, { enabled: false });
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);
    const drop = request.schema === "drop";
    const actor = resolved.access.caller.actor;
    const response = await withSiteSqlDatabaseLock(deps.db, resolved.scope, async (tx) => {
      if (drop) {
        const reset = await callSiteDb<SiteDbMeter>(
          gateway,
          siteId,
          "reset",
          {},
          siteSqlTransport.fetch,
        );
        await clearSiteSqlDefinitions(tx, resolved.scope, actor);
        await markSiteSqlRebuilt(tx, resolved.scope, reset.databaseBytes);
        return { ...reset, applied: [] as string[] };
      }
      const migrations = await listSiteSqlMigrations(tx, resolved.scope);
      const rebuilt = await callSiteDb<SiteDbMigrateResponse>(
        gateway,
        siteId,
        "migrate",
        {
          migrations: migrations.map(({ name, sql, checksum }) => ({ name, sql, checksum })),
          rebuild: true,
          maxDatabaseBytes: limits.storageBytesPerSite,
        },
        siteSqlTransport.fetch,
      );
      await markSiteSqlRebuilt(tx, resolved.scope, rebuilt.databaseBytes);
      return rebuilt;
    });
    await meter(deps, resolved, response);
    return { applied: response.applied, droppedSchema: drop };
  });
}

/** The Durable Object's tables, columns, row counts and applied migrations. */
export async function inspectSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
): Promise<SiteSqlInspectResponse> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const gateway = requireGateway(resolved);
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
    await meter(deps, resolved, inspected);
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
 * who may run it (guests only `everyone`; `managers` never from a Site page).
 */
export async function runSiteSqlQuery(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  name: string,
  params: Readonly<Record<string, SiteSqlValue>>,
  surface: SiteDataSurface = {},
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
    const manager = caller.role === "manager" && !caller.framed;
    if (query.audience === "managers" && !manager)
      throw new SiteSqlError("forbidden", "Only the Site's managers can run this query");
    if (query.audience === "signed_in" && resolved.guest)
      throw new SiteSqlError("forbidden", "Sign in to use this", { reason: "sign_in_required" });
    const limits = await limitsFor(deps, resolved.scope);
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
    await meter(deps, resolved, response);
    return runResponse(response);
  });
}

/**
 * One statement from a manager's agent or the console: `read` refuses writes
 * (rolled back in the Durable Object), `write` allows them. Schema changes
 * go through migrations so the database can be rebuilt.
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
    const database = await requireDatabase(deps, resolved, { enabled: true });
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
    checkMonthly(database, limits, { read: true, write: mode === "write" });
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
    await meter(deps, resolved, response);
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
};

/**
 * Export the Site's data so it can always leave Cloudflare: `sql` (schema and
 * INSERT statements), `csv` (one table) or `json` (schema and rows per table).
 * Exports work while Site SQL is off and past the monthly row caps (they are
 * still metered), and stop at 16 MB, reporting truncation.
 */
export async function exportSiteSql(
  deps: SiteSqlDeps,
  authority: SiteSqlAuthority,
  siteId: string,
  request: { format: SiteSqlExportFormat; table?: string | undefined },
): Promise<SiteSqlExport> {
  return guarded(async () => {
    const resolved = await resolve(deps, authority, siteId, { management: true });
    const gateway = requireGateway(resolved);
    await requireDatabase(deps, resolved, { enabled: false });
    if (request.format === "csv" && !request.table)
      throw new SiteSqlError("validation", "A CSV export needs a table");
    if (request.table !== undefined && !isSiteSqlTableName(request.table))
      throw new SiteSqlError("validation", `Invalid table name: ${request.table}`);
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);

    const lines: string[] = [];
    const json: {
      siteId: string;
      exportedAt: string;
      schema: string[];
      tables: Record<string, { columns: string[]; rows: Array<Record<string, unknown>> }>;
    } = { siteId, exportedAt: new Date().toISOString(), schema: [], tables: {} };
    let bytes = 0;
    let truncated = false;
    let cursor: string | null = null;
    let first = true;
    const usage: SiteDbMeter = { rowsRead: 0, rowsWritten: 0, databaseBytes: 0 };
    do {
      const page: SiteDbExportResponse = await callSiteDb<SiteDbExportResponse>(
        gateway,
        siteId,
        "export",
        {
          ...(request.table ? { tables: [request.table] } : {}),
          cursor,
          maxRows: EXPORT_PAGE_ROWS,
          maxBytes: SITE_SQL_HARD_LIMITS.exportBytesPerCall,
        },
        siteSqlTransport.fetch,
      );
      usage.rowsRead += page.rowsRead;
      usage.databaseBytes = page.databaseBytes;
      if (first) {
        first = false;
        if (request.table && !page.schema.some((entry) => entry.name === request.table))
          throw new SiteSqlError("not_found", `No table named ${request.table}`);
        const schema = siteSqlSchemaStatements(page.schema);
        if (request.format === "sql") {
          lines.push(
            `-- Opengeni Site SQL export of Site ${siteId}, ${json.exportedAt}`,
            "-- Schema",
            ...schema,
            "-- Data",
          );
        } else if (request.format === "json") json.schema = schema;
      }
      for (const table of page.tables) {
        if (request.format === "sql") {
          for (const statement of siteSqlInsertStatements(table)) {
            bytes += statement.length + 1;
            lines.push(statement);
          }
        } else if (request.format === "csv") {
          if (lines.length === 0) lines.push(siteSqlCsvLine(table.columns));
          for (const row of table.rows) {
            const line = siteSqlCsvLine(row);
            bytes += line.length + 1;
            lines.push(line);
          }
        } else {
          const entry = (json.tables[table.name] ??= { columns: table.columns, rows: [] });
          for (const row of siteSqlRowObjects(table)) {
            bytes += JSON.stringify(row).length + 1;
            entry.rows.push(row);
          }
        }
      }
      cursor = page.nextCursor;
      if (cursor && bytes >= SITE_SQL_EXPORT_MAX_BYTES) {
        truncated = true;
        break;
      }
    } while (cursor);
    await meter(deps, resolved, usage);
    if (request.format === "csv" && lines.length === 0) {
      // An empty table still exports its header.
      const inspected = await callSiteDb<SiteDbInspectResponse>(
        gateway,
        siteId,
        "inspect",
        {},
        siteSqlTransport.fetch,
      );
      const table = inspected.tables.find((entry) => entry.name === request.table);
      if (table) lines.push(siteSqlCsvLine(table.columns.map((column) => column.name)));
    }
    const base = request.table ?? `site-${siteId}`;
    if (request.format === "json")
      return {
        content: JSON.stringify({ ...json, truncated }),
        contentType: "application/json",
        filename: `${base}.json`,
        truncated,
      };
    return {
      content: `${lines.join("\n")}\n`,
      contentType: request.format === "csv" ? "text/csv; charset=utf-8" : "application/sql",
      filename: `${base}.${request.format}`,
      truncated,
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

/**
 * Import data. `sql`: schema statements become a migration (recorded in
 * Postgres, so a rebuild keeps them) and the rest run together; `csv` and
 * `json` insert rows into an existing table (a CSV header names the columns;
 * an empty cell is NULL). Rows are inserted in batches: when a batch fails,
 * earlier batches stay and `imported` says how many rows landed.
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
    const schema = compiled.statements.filter((statement) => statement.kind === "schema");
    const data = compiled.statements.filter((statement) => statement.kind !== "schema");
    let migration: string | null = null;
    if (schema.length > 0) {
      migration = importMigrationName();
      await migrateSiteSql(deps, authority, siteId, {
        name: migration,
        sql: `${schema.map((statement) => statement.sql).join(";\n")};`,
      });
    }
    if (data.length === 0) return { imported: 0, migration, rowsWritten: 0 };
    return guarded(async () => {
      const gateway = requireGateway(resolved);
      const database = await requireDatabase(deps, resolved, { enabled: true });
      const limits = await limitsFor(deps, resolved.scope);
      await consume(deps, resolved, limits);
      checkMonthly(database, limits, { read: false, write: true });
      const response = await callSiteDb<SiteDbMeter>(
        gateway,
        siteId,
        "script",
        {
          sql: `${data.map((statement) => statement.sql).join(";\n")};`,
          maxDatabaseBytes: limits.storageBytesPerSite,
        },
        siteSqlTransport.fetch,
      );
      await meter(deps, resolved, response);
      return { imported: data.length, migration, rowsWritten: response.rowsWritten };
    });
  }
  return guarded(async () => {
    const gateway = requireGateway(resolved);
    const database = await requireDatabase(deps, resolved, { enabled: true });
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
    if (rows.length === 0) return { imported: 0, migration: null, rowsWritten: 0 };
    const limits = await limitsFor(deps, resolved.scope);
    await consume(deps, resolved, limits);
    checkMonthly(database, limits, { read: false, write: true });
    let imported = 0;
    let rowsWritten = 0;
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
      imported += chunk.length;
      rowsWritten += response.rowsWritten;
      await meter(deps, resolved, response);
    }
    return { imported, migration: null, rowsWritten };
  });
}
