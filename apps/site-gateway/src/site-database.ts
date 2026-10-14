/**
 * `SiteDatabase`: one SQLite-backed Durable Object per Site
 * (`SITE_DB.idFromName(siteId)`), the optional per-Site Cloudflare storage
 * (docs/design/published-sites-2026-10-14.md, PR B).
 *
 * It is reachable only through the gateway's signed internal route
 * (`src/site-db.ts`), which the OpenGeni API calls after it has authorized
 * the caller, applied limits and resolved named queries from Postgres. The
 * object still re-checks every statement with `compileSiteSql`, binds values
 * only as parameters, runs each call in one transaction, bounds rows and
 * response size, rolls back a read that wrote and any write that would
 * exceed the storage cap, and reports rows read and written plus the database
 * size so the API can meter them.
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
export type DurableObjectStateLike = {
  storage: {
    sql: SqlStorage;
    transactionSync<T>(closure: () => T): T;
    deleteAll(): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

/** Requests older than this are refused by the signature check; ids are kept a little longer. */
const REQUEST_ID_RETENTION_MS = 120_000;
const ROW_COUNT_CAP = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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

function rowObject(columns: string[], values: SqlStorageValue[]): SiteSqlRow {
  const row: SiteSqlRow = {};
  columns.forEach((column, index) => {
    row[column] = jsonValue(values[index] ?? null);
  });
  return row;
}

function sqlErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // workerd prefixes SQLite errors; keep the useful part and bound it.
  return message.replace(/^Error:\s*/u, "").slice(0, 500);
}

/** Run `fn`, turning SQLite failures into `sql_error`. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SiteDbError) throw error;
    throw new SiteDbError("sql_error", sqlErrorMessage(error));
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

export class SiteDatabase {
  private readonly sql: SqlStorage;
  private bookkeeping = false;

  constructor(
    private readonly state: DurableObjectStateLike,
    _env: unknown,
  ) {
    this.sql = state.storage.sql;
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
        // Check for a replay before deleting, then keep the id across the wipe.
        this.rememberRequest(body.requestId);
        await this.state.storage.deleteAll();
        this.bookkeeping = false;
        this.rememberRequest(body.requestId);
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
          return Response.json(this.inspect());
      }
    } catch (error) {
      if (error instanceof SiteDbError) return errorResponse(error.code, error.message);
      return errorResponse("sql_error", sqlErrorMessage(error));
    }
  }

  // --- bookkeeping ---------------------------------------------------------

  private ensureBookkeeping(): void {
    if (this.bookkeeping) return;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS _og_requests (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS _og_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, position INTEGER NOT NULL)",
    );
    this.bookkeeping = true;
  }

  /** Refuse a request id seen within the retention window (the API signs each request once). */
  private rememberRequest(requestId: string): void {
    this.ensureBookkeeping();
    const now = Date.now();
    this.sql.exec("DELETE FROM _og_requests WHERE at < ?", now - REQUEST_ID_RETENTION_MS);
    const seen = this.sql.exec("SELECT 1 FROM _og_requests WHERE id = ?", requestId).toArray();
    if (seen.length > 0) throw new SiteDbError("replayed", "This request was already received");
    this.sql.exec("INSERT INTO _og_requests (id, at) VALUES (?, ?)", requestId, now);
  }

  private meter(rowsRead: number, rowsWritten: number): SiteDbMeter {
    return { rowsRead, rowsWritten, databaseBytes: this.sql.databaseSize };
  }

  /** Inside a transaction: refuse (and so roll back) growth past the cap. */
  private checkSize(rowsWritten: number, maxDatabaseBytes: number): void {
    if (rowsWritten > 0 && this.sql.databaseSize > maxDatabaseBytes)
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
    return guarded(() =>
      this.state.storage.transactionSync(() => {
        const cursor = this.sql.exec(statement.sql, ...bindings);
        const columns = cursor.columnNames;
        const rows: SiteSqlRow[] = [];
        let bytes = 64;
        let truncated = false;
        for (const values of cursor.raw()) {
          if (rows.length >= maxRows) {
            truncated = true;
            break;
          }
          const row = rowObject(columns, values);
          const size = JSON.stringify(row).length + 1;
          if (bytes + size > maxResponseBytes) {
            truncated = true;
            break;
          }
          rows.push(row);
          bytes += size;
        }
        const { rowsRead, rowsWritten } = cursor;
        if (body.expect === "read" && rowsWritten > 0)
          throw new SiteDbError("validation", "A read query tried to write; nothing was changed");
        this.checkSize(rowsWritten, maxDatabaseBytes);
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
        let rowsRead = 0;
        let rowsWritten = 0;
        for (const statement of compiled.statements) {
          const cursor = this.sql.exec(statement.sql);
          rowsRead += cursor.rowsRead;
          rowsWritten += cursor.rowsWritten;
        }
        this.checkSize(Math.max(rowsWritten, 1), maxDatabaseBytes);
        return this.meter(rowsRead, rowsWritten);
      }),
    );
  }

  private async migrate(body: SiteDbMigrateRequest): Promise<SiteDbMigrateResponse> {
    if (!Array.isArray(body.migrations))
      throw new SiteDbError("validation", "Give the migrations in order");
    const maxDatabaseBytes = this.maxDatabaseBytes(body.maxDatabaseBytes);
    const migrations = body.migrations.map((migration) => {
      if (
        !isRecord(migration) ||
        typeof migration.name !== "string" ||
        typeof migration.sql !== "string" ||
        typeof migration.checksum !== "string"
      )
        throw new SiteDbError("validation", "Each migration needs a name, sql and checksum");
      const compiled = compileSiteSql(migration.sql, "script");
      if (!compiled.ok)
        throw new SiteDbError("validation", `Migration ${migration.name}: ${compiled.message}`);
      if (compiled.paramNames.length > 0)
        throw new SiteDbError("validation", `Migration ${migration.name} cannot use parameters`);
      return {
        name: migration.name,
        checksum: migration.checksum,
        statements: compiled.statements,
      };
    });
    this.rememberRequest(body.requestId);
    if (body.rebuild === true) {
      await this.state.storage.deleteAll();
      this.bookkeeping = false;
      this.rememberRequest(body.requestId);
    }
    const applied: string[] = [];
    let rowsRead = 0;
    let rowsWritten = 0;
    for (const [position, migration] of migrations.entries()) {
      const existing = this.sql
        .exec("SELECT checksum FROM _og_migrations WHERE name = ?", migration.name)
        .toArray()[0];
      if (existing) {
        if (existing.checksum !== migration.checksum)
          throw new SiteDbError(
            "conflict",
            `Migration ${migration.name} was applied with different SQL; rebuild the database to change it`,
          );
        continue;
      }
      try {
        guarded(() =>
          this.state.storage.transactionSync(() => {
            let written = 0;
            for (const statement of migration.statements) {
              const cursor = this.sql.exec(statement.sql);
              rowsRead += cursor.rowsRead;
              written += cursor.rowsWritten;
            }
            this.checkSize(Math.max(written, 1), maxDatabaseBytes);
            this.sql.exec(
              "INSERT INTO _og_migrations (name, checksum, applied_at, position) VALUES (?, ?, ?, ?)",
              migration.name,
              migration.checksum,
              new Date().toISOString(),
              position,
            );
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
        let rowsRead = 0;
        let rowsWritten = 0;
        for (const row of body.rows) {
          const cursor = this.sql.exec(
            statement,
            ...row.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value)),
          );
          rowsRead += cursor.rowsRead;
          rowsWritten += cursor.rowsWritten;
        }
        this.checkSize(rowsWritten, maxDatabaseBytes);
        return this.meter(rowsRead, rowsWritten);
      }),
    );
  }

  /** User schema objects, oldest first; bookkeeping, Cloudflare and SQLite internals excluded. */
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
    let bytes = 0;
    let nextCursor: string | null = null;
    return guarded(() => {
      for (let index = start; index < tables.length && nextCursor === null; index += 1) {
        const table = tables[index]!;
        const quoted = quoteSiteSqlIdentifier(table.name);
        const withoutRowid = /\bWITHOUT\s+ROWID\b/iu.test(table.sql ?? "");
        const resume = index === start ? position : null;
        const cursor = withoutRowid
          ? this.sql.exec(`SELECT * FROM ${quoted} LIMIT -1 OFFSET ?`, resume?.o ?? 0)
          : this.sql.exec(
              `SELECT rowid, * FROM ${quoted} WHERE rowid > ? ORDER BY rowid`,
              resume?.r ?? Number.MIN_SAFE_INTEGER,
            );
        const columns = withoutRowid ? cursor.columnNames : cursor.columnNames.slice(1);
        const page = { name: table.name, columns, rows: [] as unknown[][] };
        out.push(page);
        let offset = resume?.o ?? 0;
        let lastRowid = resume?.r ?? Number.MIN_SAFE_INTEGER;
        for (const values of cursor.raw()) {
          const rowid = withoutRowid ? null : (values[0] as number);
          const row = (withoutRowid ? values : values.slice(1)).map(jsonValue);
          const size = JSON.stringify(row).length + 1;
          if (rowCount >= maxRows || (bytes + size > maxBytes && rowCount > 0)) {
            nextCursor = encodeCursor(
              withoutRowid ? { t: table.name, o: offset } : { t: table.name, r: lastRowid },
            );
            break;
          }
          page.rows.push(row);
          rowCount += 1;
          bytes += size;
          offset += 1;
          if (rowid !== null) lastRowid = rowid;
        }
        rowsRead += cursor.rowsRead;
      }
      return {
        schema: position ? [] : schema,
        tables: out,
        nextCursor,
        ...this.meter(rowsRead, 0),
      };
    });
  }

  private inspect(): SiteDbInspectResponse {
    return guarded(() => {
      let rowsRead = 0;
      const schema = this.schema();
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
      this.ensureBookkeeping();
      const migrations = this.sql
        .exec("SELECT name, checksum, applied_at FROM _og_migrations ORDER BY position, applied_at")
        .toArray()
        .map((row) => ({
          name: String(row.name),
          checksum: String(row.checksum),
          appliedAt: String(row.applied_at),
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
