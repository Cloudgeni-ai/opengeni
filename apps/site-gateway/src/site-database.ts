/**
 * `SiteDatabase`: one SQLite-backed Durable Object per Site
 * (`SITE_DB.idFromName(siteId)`), the optional per-Site Cloudflare storage
 * (docs/design/published-sites-2026-10-14.md, PR B).
 *
 * It is reachable only through the gateway's signed internal route
 * (`src/site-db.ts`), which the Opengeni API calls after it has authorized
 * the caller, applied limits and resolved named queries from Postgres. The
 * object still re-checks every statement with `compileSiteSql`, binds values
 * only as parameters, runs each call in one transaction, bounds rows and
 * response size, rolls back a read that wrote and any write that would grow
 * the database past the storage cap, and reports rows read and written plus
 * the database size so the API can meter them.
 *
 * Its own bookkeeping (request ids seen, migrations applied) lives in the
 * Durable Object's key-value storage, which workerd keeps in `_cf_KV` and
 * refuses to user SQL, so no statement or trigger can read or change it.
 */
import {
  compileSiteSql,
  isSiteSqlTableName,
  quoteSiteSqlIdentifier,
  siteSqlBindings,
  siteSqlBlobValue,
  SITE_DB_OPERATIONS,
  SITE_SQL_HARD_LIMITS,
  SITE_SQL_IDENTIFIER,
  type SiteDbErrorCode,
  type SiteDbExportRequest,
  type SiteDbExportResponse,
  type SiteDbInsertRequest,
  type SiteDbInspectRequest,
  type SiteDbInspectResponse,
  type SiteDbMeter,
  type SiteDbMigrateRequest,
  type SiteDbMigrateResponse,
  type SiteDbOperation,
  type SiteDbRunRequest,
  type SiteDbRunResponse,
  type SiteDbSchemaEntry,
  type SiteDbScriptRequest,
  type SiteSqlRow,
  type SiteSqlValue,
} from "@opengeni/contracts";

// The slice of the Durable Object SQLite API used here (workers-types is not loaded).
export type SqlStorageValue = ArrayBuffer | string | number | null;
export type SqlStorageCursor = {
  raw(): IterableIterator<SqlStorageValue[]>;
  toArray(): Record<string, SqlStorageValue>[];
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
};
export type SqlStorage = {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursor;
  readonly databaseSize: number;
};
/** The synchronous key-value API of SQLite-backed Durable Objects (`ctx.storage.kv`). */
export type SyncKvStorage = {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list<T = unknown>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Iterable<[string, T]>;
};
export type DurableObjectStateLike = {
  storage: {
    sql: SqlStorage;
    kv: SyncKvStorage;
    transactionSync<T>(closure: () => T): T;
    deleteAll(): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

/**
 * Request ids are kept in one-minute buckets (`rq:<minute>:<id>`) and checked
 * against the current and two previous minutes, longer than the 30 s the
 * signature check allows either way. Each request deletes a bounded number of
 * older ids, so the set stays small.
 */
const REQUEST_BUCKET_MS = 60_000;
const REQUEST_BUCKETS_CHECKED = 3;
const REQUEST_PRUNE_LIMIT = 256;
const REQUEST_PREFIX = "rq:";
const MIGRATION_PREFIX = "mig:";
const ROW_COUNT_CAP = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type MigrationRecord = { checksum: string; appliedAt: string; position: number };

function requestKey(bucket: number, requestId: string): string {
  return `${REQUEST_PREFIX}${String(bucket).padStart(12, "0")}:${requestId.toLowerCase()}`;
}

const utf8 = new TextEncoder();

/** UTF-8 bytes of a string, which is what a response carries. */
function utf8Length(text: string): number {
  return utf8.encode(text).byteLength;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class SiteDbError extends Error {
  constructor(
    readonly code: SiteDbErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const STATUS: Record<SiteDbErrorCode, number> = {
  validation: 422,
  sql_error: 422,
  quota_exceeded: 413,
  conflict: 409,
  replayed: 409,
  too_large: 413,
  unauthorized: 401,
  not_found: 404,
  internal: 500,
};

function errorResponse(code: SiteDbErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status: STATUS[code] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown, ceiling: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new SiteDbError("validation", `${name} must be a positive integer`);
  return Math.min(value, ceiling);
}

function isSqlValue(value: unknown): value is SiteSqlValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** JSON-safe value: blobs become `{ $base64 }`. */
function jsonValue(value: SqlStorageValue): unknown {
  return value instanceof ArrayBuffer ? siteSqlBlobValue(new Uint8Array(value)) : value;
}

/**
 * Result column names as object keys: a repeated name gets `_2`, `_3`, ...
 * (skipping names already taken), so `SELECT 1 AS a, 2 AS a` keeps both.
 */
export function uniqueColumnNames(names: readonly string[]): string[] {
  const taken = new Set(names);
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    let suffix = 2;
    while (taken.has(`${name}_${suffix}`) || used.has(`${name}_${suffix}`)) suffix += 1;
    const unique = `${name}_${suffix}`;
    used.add(unique);
    return unique;
  });
}

/** One result row; own properties only, so a column named `__proto__` is kept as data. */
function rowObject(columns: string[], values: SqlStorageValue[]): SiteSqlRow {
  const row: SiteSqlRow = {};
  columns.forEach((column, index) => {
    Object.defineProperty(row, column, {
      value: jsonValue(values[index] ?? null),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return row;
}

function sqlErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // workerd prefixes SQLite errors; keep the useful part and bound it.
  return message.replace(/^Error:\s*/u, "").slice(0, 500);
}

/** SQLite result codes that are the database's trouble, not the statement's. */
const INTERNAL_SQLITE =
  /SQLITE_(?:BUSY|LOCKED|IOERR|NOMEM|INTERNAL|CORRUPT|FULL|CANTOPEN|NOTADB|PROTOCOL|PERM)\b/u;

/**
 * A thrown failure as a SiteDbError: a unique or primary-key violation is
 * `conflict` (the row already exists); other SQLite errors in the statement,
 * including NOT NULL, CHECK, foreign-key and RAISE failures, are `sql_error`;
 * anything else (busy, I/O, corruption, a failure without a SQLite code) is
 * `internal`.
 */
function toSiteDbError(error: unknown): SiteDbError {
  if (error instanceof SiteDbError) return error;
  const message = sqlErrorMessage(error);
  if (/SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY)\b/u.test(message))
    return new SiteDbError("conflict", message);
  if (/SQLITE_[A-Z]+/u.test(message) && !INTERNAL_SQLITE.test(message))
    return new SiteDbError("sql_error", message);
  console.error("site-gateway: Site database internal error", error);
  return new SiteDbError("internal", "The Site database failed; try again");
}

/** Run `fn`, turning thrown failures into SiteDbErrors. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toSiteDbError(error);
  }
}

type CursorPosition = { t: string; r?: number; o?: number };

function encodeCursor(position: CursorPosition): string {
  return btoa(JSON.stringify(position)).replace(/=+$/u, "");
}

function decodeCursor(cursor: string): CursorPosition {
  try {
    const padded = cursor + "=".repeat((4 - (cursor.length % 4)) % 4);
    const value = JSON.parse(atob(padded)) as unknown;
    if (
      isRecord(value) &&
      typeof value.t === "string" &&
      (value.r === undefined || Number.isSafeInteger(value.r)) &&
      (value.o === undefined || Number.isSafeInteger(value.o))
    )
      return value as CursorPosition;
  } catch {
    // fall through
  }
  throw new SiteDbError("validation", "Invalid export cursor");
}

/** Run a statement to completion (a write with RETURNING must finish before commit). */
function drain(cursor: SqlStorageCursor): SqlStorageCursor {
  for (const _ of cursor.raw()) {
    // discard
  }
  return cursor;
}

export class SiteDatabase {
  private readonly sql: SqlStorage;
  private readonly kv: SyncKvStorage;

  constructor(
    private readonly state: DurableObjectStateLike,
    _env: unknown,
  ) {
    this.sql = state.storage.sql;
    this.kv = state.storage.kv;
  }

  async fetch(request: Request): Promise<Response> {
    const operation = new URL(request.url).pathname.replace(/^\/+/u, "") as SiteDbOperation;
    if (request.method !== "POST" || !SITE_DB_OPERATIONS.includes(operation))
      return errorResponse("not_found", "Unknown operation");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("validation", "The request body must be JSON");
    }
    if (!isRecord(body) || typeof body.requestId !== "string" || !UUID.test(body.requestId))
      return errorResponse("validation", "requestId must be a UUID");
    try {
      if (operation === "reset") {
        // Check for a replay before deleting; recent ids survive the wipe.
        this.rememberRequest(body.requestId);
        await this.wipe();
        return Response.json(this.meter(0, 0));
      }
      if (operation === "migrate")
        return Response.json(await this.migrate(body as SiteDbMigrateRequest));
      this.rememberRequest(body.requestId);
      switch (operation) {
        case "run":
          return Response.json(this.run(body as SiteDbRunRequest));
        case "script":
          return Response.json(this.script(body as SiteDbScriptRequest));
        case "insert":
          return Response.json(this.insert(body as SiteDbInsertRequest));
        case "export":
          return Response.json(this.export(body as SiteDbExportRequest));
        case "inspect":
          return Response.json(this.inspect(body as SiteDbInspectRequest));
      }
    } catch (error) {
      const failure = toSiteDbError(error);
      return errorResponse(failure.code, failure.message);
    }
  }

  // --- bookkeeping (key-value storage, out of reach of user SQL) ----------

  /** Refuse a request id seen in the last few minutes (the API signs each request once). */
  private rememberRequest(requestId: string): void {
    const bucket = Math.floor(Date.now() / REQUEST_BUCKET_MS);
    for (let back = 0; back < REQUEST_BUCKETS_CHECKED; back += 1)
      if (this.kv.get(requestKey(bucket - back, requestId)) !== undefined)
        throw new SiteDbError("replayed", "This request was already received");
    // Forget ids older than the buckets checked, a bounded number per request.
    // Collect first, then delete: never change keys while a list is open.
    const stale = Array.from(
      this.kv.list({
        start: REQUEST_PREFIX,
        end: requestKey(bucket - REQUEST_BUCKETS_CHECKED + 1, ""),
        limit: REQUEST_PRUNE_LIMIT,
      }),
      ([key]) => key,
    );
    for (const key of stale) this.kv.delete(key);
    this.kv.put(requestKey(bucket, requestId), 1);
  }

  /**
   * Delete the database and every record of it, keeping the request ids of
   * the buckets still checked (this request's included) so a wipe never
   * reopens the replay window.
   */
  private async wipe(): Promise<void> {
    const bucket = Math.floor(Date.now() / REQUEST_BUCKET_MS);
    const recent = Array.from(
      this.kv.list({
        start: requestKey(bucket - REQUEST_BUCKETS_CHECKED + 1, ""),
        end: `${REQUEST_PREFIX}~`,
      }),
      ([key, value]) => [key, value] as const,
    );
    await this.state.storage.deleteAll();
    for (const [key, value] of recent) this.kv.put(key, value);
  }

  private migrations(): Array<MigrationRecord & { name: string }> {
    return Array.from(
      this.kv.list<MigrationRecord>({ prefix: MIGRATION_PREFIX }),
      ([key, value]) => ({
        name: key.slice(MIGRATION_PREFIX.length),
        ...value,
      }),
    ).sort((a, b) => a.position - b.position || a.appliedAt.localeCompare(b.appliedAt));
  }

  private meter(rowsRead: number, rowsWritten: number): SiteDbMeter {
    return { rowsRead, rowsWritten, databaseBytes: this.sql.databaseSize };
  }

  /**
   * Inside a transaction: refuse (and so roll back) a change that leaves the
   * database above the cap and larger than before. A change that keeps or
   * shrinks the size is allowed even over the cap, so data can be deleted.
   */
  private checkSize(sizeBefore: number, maxDatabaseBytes: number): void {
    const size = this.sql.databaseSize;
    if (size > maxDatabaseBytes && size > sizeBefore)
      throw new SiteDbError(
        "quota_exceeded",
        `This Site's database would exceed its ${maxDatabaseBytes} byte storage limit`,
      );
  }

  private maxDatabaseBytes(value: unknown): number {
    return positiveInt(value, SITE_SQL_HARD_LIMITS.storageBytesPerSite, "maxDatabaseBytes");
  }

  // --- operations ----------------------------------------------------------

  private run(body: SiteDbRunRequest): SiteDbRunResponse {
    if (body.profile !== "named" && body.profile !== "agent")
      throw new SiteDbError("validation", "profile must be named or agent");
    if (typeof body.sql !== "string") throw new SiteDbError("validation", "Give sql");
    const params = isRecord(body.params) ? body.params : {};
    for (const value of Object.values(params))
      if (!isSqlValue(value))
        throw new SiteDbError(
          "validation",
          "Parameters must be strings, numbers, booleans or null",
        );
    const maxRows = positiveInt(body.maxRows, SITE_SQL_HARD_LIMITS.maxRowsPerCall, "maxRows");
    const maxResponseBytes = positiveInt(
      body.maxResponseBytes,
      SITE_SQL_HARD_LIMITS.maxResponseBytes,
      "maxResponseBytes",
    );
    const maxDatabaseBytes = this.maxDatabaseBytes(body.maxDatabaseBytes);
    const compiled = compileSiteSql(body.sql, body.profile);
    if (!compiled.ok) throw new SiteDbError("validation", compiled.message);
    const statement = compiled.statements[0]!;
    if (body.expect === "read" && statement.kind !== "read")
      throw new SiteDbError("validation", "This query is defined as a read");
    const bindings = siteSqlBindings(statement, params as Record<string, SiteSqlValue>);
    const read = statement.kind === "read";
    return guarded(() =>
      this.state.storage.transactionSync(() => {
        const sizeBefore = this.sql.databaseSize;
        const cursor = this.sql.exec(statement.sql, ...bindings);
        const columns = uniqueColumnNames(cursor.columnNames);
        const rows: SiteSqlRow[] = [];
        let bytes = 64;
        let truncated = false;
        for (const values of cursor.raw()) {
          // A read stops at the cap; a write (RETURNING) runs to completion
          // so it can commit, and the rows past the cap are dropped.
          if (truncated) continue;
          if (rows.length >= maxRows) {
            truncated = true;
            if (read) break;
            continue;
          }
          const row = rowObject(columns, values);
          const size = utf8Length(JSON.stringify(row)) + 1;
          if (bytes + size > maxResponseBytes) {
            truncated = true;
            if (read) break;
            continue;
          }
          rows.push(row);
          bytes += size;
        }
        const { rowsRead, rowsWritten } = cursor;
        if (body.expect === "read" && rowsWritten > 0)
          throw new SiteDbError("validation", "A read query tried to write; nothing was changed");
        if (!read) this.checkSize(sizeBefore, maxDatabaseBytes);
        return { columns, rows, truncated, ...this.meter(rowsRead, rowsWritten) };
      }),
    );
  }

  private script(body: SiteDbScriptRequest): SiteDbMeter {
    if (typeof body.sql !== "string") throw new SiteDbError("validation", "Give sql");
    const maxDatabaseBytes = this.maxDatabaseBytes(body.maxDatabaseBytes);
    const compiled = compileSiteSql(body.sql, "script");
    if (!compiled.ok) throw new SiteDbError("validation", compiled.message);
    if (compiled.paramNames.length > 0)
      throw new SiteDbError("validation", "Scripts cannot use parameters");
    return guarded(() =>
      this.state.storage.transactionSync(() => {
        const sizeBefore = this.sql.databaseSize;
        let rowsRead = 0;
        let rowsWritten = 0;
        for (const statement of compiled.statements) {
          const cursor = drain(this.sql.exec(statement.sql));
          rowsRead += cursor.rowsRead;
          rowsWritten += cursor.rowsWritten;
        }
        this.checkSize(sizeBefore, maxDatabaseBytes);
        return this.meter(rowsRead, rowsWritten);
      }),
    );
  }

  private async migrate(body: SiteDbMigrateRequest): Promise<SiteDbMigrateResponse> {
    if (!Array.isArray(body.migrations))
      throw new SiteDbError("validation", "Give the migrations in order");
    const maxDatabaseBytes = this.maxDatabaseBytes(body.maxDatabaseBytes);
    const migrations = [];
    for (const migration of body.migrations as unknown[]) {
      if (
        !isRecord(migration) ||
        typeof migration.name !== "string" ||
        migration.name.length === 0 ||
        migration.name.length > 256 ||
        typeof migration.sql !== "string" ||
        typeof migration.checksum !== "string" ||
        (migration.position !== undefined &&
          (typeof migration.position !== "number" ||
            !Number.isSafeInteger(migration.position) ||
            migration.position < 0))
      )
        throw new SiteDbError(
          "validation",
          "Each migration needs a name, sql and checksum (and an optional whole-number position)",
        );
      const compiled = compileSiteSql(migration.sql, "script");
      if (!compiled.ok)
        throw new SiteDbError("validation", `Migration ${migration.name}: ${compiled.message}`);
      if (compiled.paramNames.length > 0)
        throw new SiteDbError("validation", `Migration ${migration.name} cannot use parameters`);
      // The checksum is recomputed here, so the record always matches the SQL that ran.
      const checksum = await sha256Hex(migration.sql);
      if (checksum !== migration.checksum.toLowerCase())
        throw new SiteDbError(
          "validation",
          `Migration ${migration.name}: the checksum does not match its SQL (SHA-256 of the UTF-8 text)`,
        );
      migrations.push({
        name: migration.name,
        checksum,
        position: migration.position as number | undefined,
        statements: compiled.statements,
      });
    }
    this.rememberRequest(body.requestId);
    if (body.rebuild === true) await this.wipe();
    const applied: string[] = [];
    let rowsRead = 0;
    let rowsWritten = 0;
    let highest = this.migrations().reduce((top, entry) => Math.max(top, entry.position), -1);
    for (const migration of migrations) {
      const key = `${MIGRATION_PREFIX}${migration.name}`;
      const existing = this.kv.get<MigrationRecord>(key);
      if (existing) {
        if (existing.checksum !== migration.checksum)
          throw new SiteDbError(
            "conflict",
            `Migration ${migration.name} was applied with different SQL; rebuild the database to change it`,
          );
        continue;
      }
      const position = migration.position ?? highest + 1;
      if (position < highest)
        throw new SiteDbError(
          "conflict",
          `Migration ${migration.name} comes before migrations already applied (applied now: ${applied.join(", ") || "none"}); rebuild the database to apply it in order`,
        );
      try {
        guarded(() =>
          this.state.storage.transactionSync(() => {
            const sizeBefore = this.sql.databaseSize;
            let read = 0;
            let written = 0;
            for (const statement of migration.statements) {
              const cursor = drain(this.sql.exec(statement.sql));
              read += cursor.rowsRead;
              written += cursor.rowsWritten;
            }
            this.checkSize(sizeBefore, maxDatabaseBytes);
            // Recorded in the same transaction: applied and recorded, or neither.
            const record: MigrationRecord = {
              checksum: migration.checksum,
              appliedAt: new Date().toISOString(),
              position,
            };
            this.kv.put(key, record);
            rowsRead += read;
            rowsWritten += written;
          }),
        );
      } catch (error) {
        if (error instanceof SiteDbError && error.code === "sql_error")
          throw new SiteDbError(
            "sql_error",
            `Migration ${migration.name} failed (applied before it: ${applied.join(", ") || "none"}): ${error.message}`,
          );
        throw error;
      }
      highest = Math.max(highest, position);
      applied.push(migration.name);
    }
    return { applied, ...this.meter(rowsRead, rowsWritten) };
  }

  private insert(body: SiteDbInsertRequest): SiteDbMeter {
    if (typeof body.table !== "string" || !isSiteSqlTableName(body.table))
      throw new SiteDbError("validation", "Give a valid table name");
    if (
      !Array.isArray(body.columns) ||
      body.columns.length === 0 ||
      body.columns.length > 1_000 ||
      !body.columns.every(
        (column) => typeof column === "string" && SITE_SQL_IDENTIFIER.test(column),
      )
    )
      throw new SiteDbError("validation", "Give valid column names");
    if (!Array.isArray(body.rows) || body.rows.length > SITE_SQL_HARD_LIMITS.importRowsPerCall)
      throw new SiteDbError(
        "validation",
        `Give at most ${SITE_SQL_HARD_LIMITS.importRowsPerCall} rows per call`,
      );
    const width = body.columns.length;
    for (const row of body.rows)
      if (!Array.isArray(row) || row.length !== width || !row.every(isSqlValue))
        throw new SiteDbError("validation", "Every row needs one scalar value per column");
    const maxDatabaseBytes = this.maxDatabaseBytes(body.maxDatabaseBytes);
    const verb =
      body.onConflict === "replace"
        ? "INSERT OR REPLACE"
        : body.onConflict === "ignore"
          ? "INSERT OR IGNORE"
          : "INSERT";
    const statement = `${verb} INTO ${quoteSiteSqlIdentifier(body.table)} (${body.columns
      .map(quoteSiteSqlIdentifier)
      .join(", ")}) VALUES (${body.columns.map(() => "?").join(", ")})`;
    return guarded(() =>
      this.state.storage.transactionSync(() => {
        const sizeBefore = this.sql.databaseSize;
        let rowsRead = 0;
        let rowsWritten = 0;
        for (const row of body.rows) {
          const cursor = drain(
            this.sql.exec(
              statement,
              ...row.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value)),
            ),
          );
          rowsRead += cursor.rowsRead;
          rowsWritten += cursor.rowsWritten;
        }
        this.checkSize(sizeBefore, maxDatabaseBytes);
        return this.meter(rowsRead, rowsWritten);
      }),
    );
  }

  /** User schema objects, oldest first; Cloudflare, Opengeni and SQLite internals excluded. */
  private schema(): SiteDbSchemaEntry[] {
    return this.sql
      .exec(
        "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_og\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
      )
      .toArray()
      .map((entry) => ({
        type: entry.type as SiteDbSchemaEntry["type"],
        name: String(entry.name),
        table: String(entry.tbl),
        sql: typeof entry.sql === "string" ? entry.sql : null,
      }));
  }

  /**
   * How to page through a table: by the first of rowid, _rowid_ and oid that
   * no column shadows, or by OFFSET for WITHOUT ROWID tables and tables whose
   * columns take all three names.
   */
  private rowidAlias(table: SiteDbSchemaEntry): string | null {
    if (/\bWITHOUT\s+ROWID\b/iu.test(table.sql ?? "")) return null;
    const columns = new Set(
      this.sql
        .exec(`PRAGMA table_xinfo(${quoteSiteSqlIdentifier(table.name)})`)
        .toArray()
        .map((column) => String(column.name).toLowerCase()),
    );
    return ["rowid", "_rowid_", "oid"].find((alias) => !columns.has(alias)) ?? null;
  }

  private export(body: SiteDbExportRequest): SiteDbExportResponse {
    const maxRows = positiveInt(body.maxRows, SITE_SQL_HARD_LIMITS.maxRowsPerCall * 10, "maxRows");
    const maxBytes = positiveInt(
      body.maxBytes,
      SITE_SQL_HARD_LIMITS.exportBytesPerCall,
      "maxBytes",
    );
    const schema = this.schema();
    const tableEntries = schema.filter((entry) => entry.type === "table");
    let tables = tableEntries;
    if (body.tables !== undefined) {
      if (!Array.isArray(body.tables) || !body.tables.every((name) => typeof name === "string"))
        throw new SiteDbError("validation", "tables must be a list of names");
      const missing = body.tables.filter(
        (name) => !tableEntries.some((entry) => entry.name === name),
      );
      if (missing.length > 0)
        throw new SiteDbError("validation", `No such table: ${missing.join(", ")}`);
      tables = tableEntries.filter((entry) => body.tables!.includes(entry.name));
    }
    const position = body.cursor ? decodeCursor(body.cursor) : null;
    let start = 0;
    if (position) {
      start = tables.findIndex((entry) => entry.name === position.t);
      if (start < 0) throw new SiteDbError("validation", "Invalid export cursor");
    }
    const out: SiteDbExportResponse["tables"] = [];
    let rowsRead = 0;
    let rowCount = 0;
    // The schema travels with every page, so it counts toward the page's bytes.
    let bytes = utf8Length(JSON.stringify(schema));
    let nextCursor: string | null = null;
    return guarded(() => {
      for (let index = start; index < tables.length && nextCursor === null; index += 1) {
        const table = tables[index]!;
        const quoted = quoteSiteSqlIdentifier(table.name);
        const alias = this.rowidAlias(table);
        const resume = index === start ? position : null;
        if (resume && (alias === null ? resume.r !== undefined : resume.o !== undefined))
          throw new SiteDbError("validation", "Invalid export cursor");
        // Two query texts for rowid tables, so a resumed page seeks to its
        // rowid instead of scanning the table from the start.
        const cursor =
          alias === null
            ? this.sql.exec(`SELECT * FROM ${quoted} LIMIT -1 OFFSET ?`, resume?.o ?? 0)
            : resume?.r === undefined
              ? this.sql.exec(`SELECT ${alias}, * FROM ${quoted} ORDER BY ${alias}`)
              : this.sql.exec(
                  `SELECT ${alias}, * FROM ${quoted} WHERE ${alias} > ? ORDER BY ${alias}`,
                  resume.r,
                );
        const columns = alias === null ? cursor.columnNames : cursor.columnNames.slice(1);
        const page = { name: table.name, columns, rows: [] as unknown[][] };
        out.push(page);
        let offset = resume?.o ?? 0;
        let lastRowid = resume?.r ?? null;
        for (const values of cursor.raw()) {
          const row = (alias === null ? values : values.slice(1)).map(jsonValue);
          const size = utf8Length(JSON.stringify(row)) + 1;
          if (rowCount >= maxRows || (bytes + size > maxBytes && rowCount > 0)) {
            nextCursor = encodeCursor(
              alias === null
                ? { t: table.name, o: offset }
                : lastRowid === null
                  ? { t: table.name }
                  : { t: table.name, r: lastRowid },
            );
            break;
          }
          page.rows.push(row);
          rowCount += 1;
          bytes += size;
          offset += 1;
          if (alias !== null) lastRowid = values[0] as number;
        }
        rowsRead += cursor.rowsRead;
      }
      return {
        // The schema is small and comes with every page, so the API can finish
        // a dump (triggers last) from whichever page ends it.
        schema,
        tables: out,
        nextCursor,
        ...this.meter(rowsRead, 0),
      };
    });
  }

  private inspect(body: SiteDbInspectRequest): SiteDbInspectResponse {
    const migrationsOnly = body.migrationsOnly === true;
    return guarded(() => {
      let rowsRead = 0;
      const schema = migrationsOnly ? [] : this.schema();
      const tables = schema
        .filter((entry) => entry.type === "table" || entry.type === "view")
        .map((entry) => {
          const quoted = quoteSiteSqlIdentifier(entry.name);
          const info = this.sql.exec(`PRAGMA table_info(${quoted})`).toArray();
          let rowCount = 0;
          if (entry.type === "table") {
            const count = this.sql.exec(
              `SELECT count(*) AS n FROM (SELECT 1 FROM ${quoted} LIMIT ?)`,
              ROW_COUNT_CAP + 1,
            );
            rowCount = Number(count.toArray()[0]?.n ?? 0);
            rowsRead += count.rowsRead;
          }
          return {
            name: entry.name,
            type: entry.type as "table" | "view",
            sql: entry.sql,
            columns: info.map((column) => ({
              name: String(column.name),
              type: String(column.type ?? ""),
              notNull: Number(column.notnull) === 1,
              primaryKey: Number(column.pk) > 0,
              defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
            })),
            rowCount: Math.min(rowCount, ROW_COUNT_CAP),
            rowCountCapped: rowCount > ROW_COUNT_CAP,
          };
        });
      const migrations = this.migrations().map(({ name, checksum, appliedAt }) => ({
        name,
        checksum,
        appliedAt,
      }));
      return {
        tables,
        indexes: schema.filter((entry) => entry.type === "index" || entry.type === "trigger"),
        migrations,
        ...this.meter(rowsRead, 0),
      };
    });
  }
}
