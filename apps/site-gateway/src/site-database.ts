/**
 * `SiteDatabase`: one SQLite-backed Durable Object per Site
 * (`SITE_DB.jurisdiction("eu").idFromName(siteId)`), the optional per-Site Cloudflare storage
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
 *
 * Location (`site-db-location.ts`): the gateway calls a Site's object in the
 * EU jurisdiction (role `primary`). The first time, that object looks for the
 * Site's legacy object (plain `idFromName`, created before databases moved to
 * the EU). An empty one only records a moved marker. One that holds a
 * database is copied (`site-db-relocation.ts`): the legacy object is fenced
 * (earlier gateway releases are refused until the copy commits or is
 * released; the fence never expires), its rows are staged here, the copy is
 * built in one transaction and accepted only when its schema, FTS5 settings,
 * row counts, row digests, AUTOINCREMENT counters and migration records equal
 * the source's. Then this object becomes the database's home and the legacy
 * object is marked moved: it keeps its data, frozen, and sends any request
 * from an earlier gateway release here. Requests that arrive while the copy
 * runs wait for it (one object, one copy at a time), so no write is lost.
 * When the copy fails, nothing changes for the Site: the legacy object is
 * released and serves (relayed by this object), the reason is reported on the
 * response, and the copy is retried later with backoff. Nothing here deletes
 * a legacy object; only a reset or rebuild erases its data (`erase`), and
 * removing the objects is a separate, explicit step.
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
import { errorMessage, isRecord, sha256Hex } from "@opengeni/contracts/values";
import {
  canEmulateJurisdiction,
  primarySiteDbNamespace,
  siteDbStub,
  SITE_DB_LOCATION_HEADER,
  SITE_DB_RELOCATION_ERROR_HEADER,
  SITE_DB_ROLE_HEADER,
  SITE_DB_SITE_HEADER,
  type DurableObjectNamespaceLike,
} from "./site-db-location";
import {
  buildCopy,
  compareStates,
  copiedTables,
  isEmptyDatabase,
  readPage,
  relocationState,
  RelocationError,
  stagePage,
  type PageCursor,
  type RelocationPage,
  type RelocationState,
  userTables,
} from "./site-db-relocation";

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

// Location records (key-value storage, kept through a wipe).
const LOCATION_PREFIX = "loc:";
/** EU object: this object is the database's home. */
const HOME_KEY = "loc:home";
/** EU object: the last failed copy and when to try again. */
const FAILURE_KEY = "loc:failure";
/** EU object: the fence token a failed copy could not release yet. */
const RELEASE_KEY = "loc:release";
/** EU object: a copy in progress (left behind when the object stopped mid-copy). */
const ATTEMPT_KEY = "loc:attempt";
/**
 * Legacy object: a copy holds it; earlier gateway releases are refused until
 * the copy commits (the fence becomes `loc:moved`) or is released. It never
 * expires on its own, so no write can land here between the copy's last read
 * and its commit.
 */
const FENCE_KEY = "loc:fence";
/** Legacy object: the database moved to the EU object; this copy is frozen. */
const MOVED_KEY = "loc:moved";

const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** A legacy object still on the previous release (Cloudflare can defer its code update). */
const NOT_READY_RETRY_MS = 30_000;
/** How often a home retries marking its legacy object moved. */
const MARK_RETRY_MS = 60_000;
/**
 * The largest legacy database copied on first use. The copy runs inside a
 * request (CPU and memory bounds), so a larger one stays where it is, served
 * and reported (`x-og-site-db-relocation-error`), until it can move in parts.
 */
const RELOCATE_MAX_BYTES = 32 * 1024 * 1024;

type HomeRecord = {
  since: string;
  from: "legacy" | "none";
  token: string | null;
  legacyMarked: boolean;
  /** The frozen legacy copy was erased (the database was reset or rebuilt). */
  legacyErased?: boolean;
  /** A reset or rebuild could not erase the legacy copy yet; later requests retry. */
  erasePending?: boolean;
};
type FailureRecord = { at: string; attempts: number; retryAt: number; message: string };
type AttemptRecord = { token: string; at: string };
type FenceRecord = { token: string; site: string };
/** `erased`: nothing of the database is left here (reset, rebuilt, or never written). */
type MovedRecord = { site: string; at: string; erased?: boolean };
type BeginResult = {
  empty?: boolean;
  moved?: boolean;
  erased?: boolean;
  tooLarge?: boolean;
  bytes?: number;
};

type Home = { location: "eu" } | { location: "legacy"; reason: string };

function requestKey(bucket: number, requestId: string): string {
  return `${REQUEST_PREFIX}${String(bucket).padStart(12, "0")}:${requestId.toLowerCase()}`;
}

const utf8 = new TextEncoder();

/** UTF-8 bytes of a string, which is what a response carries. */
function utf8Length(text: string): number {
  return utf8.encode(text).byteLength;
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

/** A retryable refusal: nothing ran, so the caller may safely try again. */
function unavailable(message: string): Response {
  return Response.json(
    { error: { code: "internal", message, retryable: true, outcomeUnknown: false } },
    { status: 503 },
  );
}

/**
 * A call to the Site's other object failed after it was sent: a write may have
 * run there, so only a read is safe to call not run.
 */
function lostResponse(operation: SiteDbOperation): Response {
  const readOnly = operation === "inspect" || operation === "export";
  return Response.json(
    {
      error: {
        code: "internal",
        message: "The Site database is temporarily unavailable",
        retryable: true,
        outcomeUnknown: !readOnly,
      },
    },
    { status: 503 },
  );
}

/** The request body as an object with a request id, or null (`serve` refuses it). */
function requestBody(body: ArrayBuffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return isRecord(parsed) && typeof parsed.requestId === "string" && UUID.test(parsed.requestId)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Whether an operation erases the database (so its frozen legacy copy goes too). */
function erasesDatabase(operation: SiteDbOperation, body: Record<string, unknown> | null): boolean {
  return (
    body !== null && (operation === "reset" || (operation === "migrate" && body.rebuild === true))
  );
}

/** A response (possibly from another object) that says where it was served. */
function located(response: Response, location: "eu" | "legacy"): Response {
  const headers = new Headers(response.headers);
  headers.set(SITE_DB_LOCATION_HEADER, location);
  return new Response(response.body, { status: response.status, headers });
}

/** Bounded printable ASCII for a response header. */
function headerText(text: string): string {
  return text.replace(/[^\x20-\x7e]/gu, "?").slice(0, 300);
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
  const message = errorMessage(error);
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
  /** The copy from the legacy object in progress, which other requests wait for. */
  private relocation: Promise<Home | null> | null = null;
  /** Requests relayed to the legacy object and not answered yet. */
  private readonly relays = new Set<Promise<Response>>();
  /** When this instance may next try to mark the legacy object moved. */
  private markRetryAt = 0;
  /** When this instance may next retry erasing the legacy copy. */
  private eraseRetryAt = 0;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: { SITE_DB?: unknown; ENVIRONMENT?: string } | undefined,
  ) {
    this.sql = state.storage.sql;
    this.kv = state.storage.kv;
  }

  async fetch(request: Request): Promise<Response> {
    // Server-Timing for the API's round-trip measurement. Workers clocks
    // advance only across I/O, so this mostly shows storage waits.
    const started = Date.now();
    const response = await this.handle(request);
    const headers = new Headers(response.headers);
    headers.append("Server-Timing", `db;dur=${Date.now() - started}`);
    return new Response(response.body, { status: response.status, headers });
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/+/u, "");
    if (request.method !== "POST") return errorResponse("not_found", "Unknown operation");
    const role = request.headers.get(SITE_DB_ROLE_HEADER);
    if (path.startsWith("relocation/")) {
      // Only a Site's EU object calls these, on its legacy object.
      if (role !== "relay") return errorResponse("not_found", "Unknown operation");
      return this.relocationOperation(path.slice("relocation/".length), request);
    }
    const operation = path as SiteDbOperation;
    if (!SITE_DB_OPERATIONS.includes(operation))
      return errorResponse("not_found", "Unknown operation");
    if (role === "primary") {
      const site = request.headers.get(SITE_DB_SITE_HEADER) ?? "";
      if (!UUID.test(site)) return errorResponse("validation", "The Site id is missing");
      const body = await request.arrayBuffer();
      const erasing = erasesDatabase(operation, requestBody(body));
      let home: Home;
      try {
        // A well-formed reset needs no copy: the legacy database is erased instead.
        home = await this.home(site, erasing && operation === "reset");
      } catch (error) {
        console.error("site-gateway: Site database location check failed", error);
        return unavailable("The Site database is temporarily unavailable");
      }
      if (home.location === "legacy") return this.relayToLegacy(site, operation, body, home.reason);
      const response = await this.serve(operation, body);
      if (erasing && response.ok) {
        // The database was erased here; erase its frozen legacy copy too, so a
        // reset or rebuild never leaves the old data behind.
        // When that fails, later requests retry it (`home`); the reset stands.
        await this.eraseLegacy(site).catch((error: unknown) => {
          console.error(`site-gateway: could not erase the legacy Site database ${site}`, error);
          const record = this.kv.get<HomeRecord>(HOME_KEY);
          if (record) this.kv.put(HOME_KEY, { ...record, erasePending: true } satisfies HomeRecord);
        });
      }
      return located(response, "eu");
    }
    // A legacy object: relayed by the Site's EU object, or called by an
    // earlier gateway release that does not know about locations.
    const moved = this.kv.get<MovedRecord>(MOVED_KEY);
    if (moved) {
      // A relay here means the EU object lost its record of the move: refuse,
      // and never serve the frozen copy.
      if (role === "relay")
        return unavailable("This database moved to the EU; its earlier copy is frozen");
      return this.forwardToHome(moved.site, operation, await request.arrayBuffer());
    }
    // The EU object relays only while no copy runs, so only earlier gateway
    // releases are held off by a fence.
    if (role !== "relay" && this.kv.get<FenceRecord>(FENCE_KEY))
      return unavailable("The Site database is moving to its EU location; try again shortly");
    return located(await this.serve(operation, await request.arrayBuffer()), "legacy");
  }

  /** Run one operation on this object's own storage. */
  private async serve(operation: SiteDbOperation, bytes: ArrayBuffer): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
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

  // --- location (EU object) -------------------------------------------------

  private binding(): DurableObjectNamespaceLike {
    const binding = this.env?.SITE_DB as DurableObjectNamespaceLike | undefined;
    if (!binding) throw new Error("The SITE_DB binding is missing");
    return binding;
  }

  /** Call the Site's legacy object as its EU object. */
  private relay(site: string, path: string, body: BodyInit): Promise<Response> {
    return siteDbStub(this.binding(), site).fetch(`https://site-db.internal/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SITE_DB_ROLE_HEADER]: "relay",
        [SITE_DB_SITE_HEADER]: site,
      },
      body,
    });
  }

  /** A relocation step on the legacy object; throws on any refusal. */
  private async relocationCall<T>(site: string, step: string, payload: unknown): Promise<T> {
    const response = await this.relay(site, `relocation/${step}`, JSON.stringify(payload));
    const value = (await response.json().catch(() => null)) as
      | (T & { error?: { message?: string } })
      | null;
    if (!response.ok || value === null)
      throw new RelocationError(
        `The legacy database refused ${step} (HTTP ${response.status}): ${value?.error?.message ?? "no details"}`,
        response.status,
      );
    return value;
  }

  /** Serve from the legacy object while the database could not move yet. */
  private async relayToLegacy(
    site: string,
    operation: SiteDbOperation,
    body: ArrayBuffer,
    reason: string,
  ): Promise<Response> {
    let response: Response;
    // A copy starts only after relays in flight finish, so none lands after its read.
    const call = (async () => {
      const pendingRelease = this.kv.get<string>(RELEASE_KEY);
      if (pendingRelease) {
        // A failed copy could not release the legacy object; earlier gateway
        // releases are refused until it does.
        await this.relocationCall(site, "release", { token: pendingRelease })
          .then(() => this.kv.delete(RELEASE_KEY))
          .catch(() => null);
      }
      return this.relay(site, operation, body);
    })();
    this.relays.add(call);
    try {
      response = await call;
    } catch (error) {
      console.error("site-gateway: legacy Site database unreachable", error);
      return lostResponse(operation);
    } finally {
      this.relays.delete(call);
    }
    const relayed = located(response, "legacy");
    relayed.headers.set(SITE_DB_RELOCATION_ERROR_HEADER, headerText(reason));
    return relayed;
  }

  /**
   * Where this Site's database lives, copying a legacy database here first
   * (or, for a reset, erasing it instead). Concurrent requests wait for the
   * one copy.
   */
  private async home(site: string, resetting = false): Promise<Home> {
    for (;;) {
      if (this.relocation) {
        await this.relocation;
        continue;
      }
      const home = this.kv.get<HomeRecord>(HOME_KEY);
      if (home) {
        if (!home.legacyMarked && Date.now() >= this.markRetryAt) {
          this.markRetryAt = Date.now() + MARK_RETRY_MS;
          await this.markLegacyMoved(site, home);
        }
        if (home.erasePending && Date.now() >= this.eraseRetryAt) {
          this.eraseRetryAt = Date.now() + MARK_RETRY_MS;
          await this.eraseLegacy(site).catch((error: unknown) =>
            console.error(`site-gateway: could not erase the legacy Site database ${site}`, error),
          );
        }
        return { location: "eu" };
      }
      if (!resetting) {
        const failure = this.kv.get<FailureRecord>(FAILURE_KEY);
        if (failure && Date.now() < failure.retryAt)
          return { location: "legacy", reason: failure.message };
      }
      const relocation = (resetting ? this.abandonLegacy(site) : this.relocate(site)).finally(
        () => {
          this.relocation = null;
        },
      );
      this.relocation = relocation;
      const outcome = await relocation;
      if (outcome) return outcome;
    }
  }

  /** This object is the home of a database that is new, empty or erased (nothing to copy). */
  private homeWithoutCopy(): void {
    this.kv.put(HOME_KEY, {
      since: new Date().toISOString(),
      from: "none",
      token: null,
      legacyMarked: true,
      legacyErased: true,
    } satisfies HomeRecord);
    this.kv.delete(FAILURE_KEY);
  }

  /** A legacy object still on the previous release cannot take part yet: serve there, retry soon. */
  private notReady(error: unknown): Home | null {
    if (!(error instanceof RelocationError) || error.status !== 404) return null;
    const message = "The legacy database is still on the previous release; it moves shortly";
    const previous = this.kv.get<FailureRecord>(FAILURE_KEY);
    this.kv.put(FAILURE_KEY, {
      at: new Date().toISOString(),
      attempts: previous?.attempts ?? 0,
      retryAt: Date.now() + NOT_READY_RETRY_MS,
      message,
    } satisfies FailureRecord);
    return { location: "legacy", reason: message };
  }

  /**
   * Make this object the home of an empty database, for a reset that has not
   * moved yet: erase the legacy database (it is being reset anyway) and mark
   * it moved, instead of copying data only to delete it.
   */
  private async abandonLegacy(site: string): Promise<Home | null> {
    if (this.kv.get<AttemptRecord>(ATTEMPT_KEY)) {
      await this.wipeKeepingLocation();
      this.kv.delete(ATTEMPT_KEY);
    }
    try {
      await this.relocationCall(site, "erase", {});
    } catch (error) {
      const waiting = this.notReady(error);
      if (waiting) return waiting;
      throw error;
    }
    this.homeWithoutCopy();
    return null;
  }

  /** Erase the frozen legacy copy of a database that moved here (before a reset or rebuild). */
  private async eraseLegacy(site: string): Promise<void> {
    const home = this.kv.get<HomeRecord>(HOME_KEY);
    if (!home || home.legacyErased || home.from !== "legacy") return;
    await this.relocationCall(site, "erase", {});
    this.kv.put(HOME_KEY, {
      ...home,
      legacyMarked: true,
      legacyErased: true,
      erasePending: false,
    } satisfies HomeRecord);
  }

  /**
   * Copy the legacy database here. Returns where to serve from when the copy
   * failed (the legacy object), or null to read the new location again.
   * Throws only when neither object can serve now.
   */
  private async relocate(site: string): Promise<Home | null> {
    const stale = this.kv.get<AttemptRecord>(ATTEMPT_KEY);
    if (stale) {
      // An earlier copy stopped midway (object restarted or ran out of time):
      // release the legacy object and count it as a failed attempt.
      await this.release(site, stale.token);
      await this.wipeKeepingLocation();
      this.kv.delete(ATTEMPT_KEY);
      return this.recordFailure("An earlier copy to the EU did not finish");
    }
    await Promise.allSettled([...this.relays]);
    const token = crypto.randomUUID();
    let begun: BeginResult;
    try {
      begun = await this.relocationCall<BeginResult>(site, "begin", {
        token,
        maxBytes: RELOCATE_MAX_BYTES,
      });
    } catch (error) {
      const waiting = this.notReady(error);
      if (waiting) return waiting;
      console.error(`site-gateway: could not start moving Site database ${site}`, error);
      return this.recordFailure(
        error instanceof RelocationError
          ? error.message
          : `The legacy database is unreachable: ${errorMessage(error)}`,
      );
    }
    if (begun.moved) {
      // Erased there (a reset that stopped before this home was recorded): nothing to copy.
      if (begun.erased) {
        this.homeWithoutCopy();
        return null;
      }
      return this.recordFailure(
        "The legacy database is marked moved, but this EU database has no record of the copy; an operator must check it",
      );
    }
    if (begun.empty) {
      // The legacy object marked itself moved without storing any data.
      this.homeWithoutCopy();
      return null;
    }
    if (begun.tooLarge)
      return this.recordFailure(
        `The database (${Math.ceil((begun.bytes ?? 0) / (1024 * 1024))} MiB) is too large to move automatically; it stays where it is`,
      );
    this.kv.put(ATTEMPT_KEY, { token, at: new Date().toISOString() } satisfies AttemptRecord);
    try {
      await this.wipeKeepingLocation();
      let cursor: PageCursor | null = null;
      for (;;) {
        const page: { page: RelocationPage | null } = await this.relocationCall(site, "page", {
          token,
          cursor,
        });
        if (!page.page) break;
        stagePage(this.sql, page.page);
        cursor = page.page.next;
      }
      const source = await this.relocationCall<RelocationState>(site, "state", { token });
      this.sql.exec("PRAGMA defer_foreign_keys = ON");
      try {
        this.state.storage.transactionSync(() => buildCopy(this.sql, this.kv, source));
      } finally {
        this.sql.exec("PRAGMA defer_foreign_keys = OFF");
      }
      const difference = compareStates(source, await relocationState(this.sql, this.kv));
      if (difference) throw new RelocationError(`The copy did not match: ${difference}`);
    } catch (error) {
      console.error(`site-gateway: Site database ${site} did not move to the EU`, error);
      await this.wipeKeepingLocation();
      await this.release(site, token);
      this.kv.delete(ATTEMPT_KEY);
      return this.recordFailure(
        error instanceof RelocationError
          ? error.message
          : `The copy failed: ${errorMessage(error)}`,
      );
    }
    // The fence still holds the legacy object (it never expires), so it took
    // no write since the state was read: the copy is the database.
    const home: HomeRecord = {
      since: new Date().toISOString(),
      from: "legacy",
      token,
      legacyMarked: false,
    };
    this.kv.put(HOME_KEY, home);
    this.kv.delete(FAILURE_KEY);
    this.kv.delete(ATTEMPT_KEY);
    this.markRetryAt = Date.now() + MARK_RETRY_MS;
    await this.markLegacyMoved(site, home);
    return null;
  }

  /** Release the legacy object after a failed copy; retried on later relays when it fails. */
  private async release(site: string, token: string): Promise<void> {
    try {
      await this.relocationCall(site, "release", { token });
      this.kv.delete(RELEASE_KEY);
    } catch (error) {
      console.error(`site-gateway: could not release the legacy Site database ${site}`, error);
      this.kv.put(RELEASE_KEY, token);
    }
  }

  /** Mark the legacy object moved, so it sends earlier releases' requests here. */
  private async markLegacyMoved(site: string, home: HomeRecord): Promise<void> {
    try {
      await this.relocationCall(site, "commit", { token: home.token });
      this.kv.put(HOME_KEY, { ...home, legacyMarked: true } satisfies HomeRecord);
    } catch (error) {
      // The copy is the database now; the legacy object stays fenced, and a
      // later request tries again.
      console.error(`site-gateway: could not mark the legacy Site database ${site} moved`, error);
    }
  }

  private recordFailure(message: string): Home {
    const previous = this.kv.get<FailureRecord>(FAILURE_KEY);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (attempts - 1));
    this.kv.put(FAILURE_KEY, {
      at: new Date().toISOString(),
      attempts,
      retryAt: Date.now() + delay,
      message,
    } satisfies FailureRecord);
    return { location: "legacy", reason: message };
  }

  /** Delete everything here except the location records (a copy that did not finish). */
  private async wipeKeepingLocation(): Promise<void> {
    const kept = Array.from(
      this.kv.list({ prefix: LOCATION_PREFIX }),
      ([key, value]) => [key, value] as const,
    );
    await this.state.storage.deleteAll();
    for (const [key, value] of kept) this.kv.put(key, value);
  }

  // --- location (legacy object) ---------------------------------------------

  /** Send a request from an earlier gateway release to the database's EU home. */
  private async forwardToHome(
    site: string,
    operation: SiteDbOperation,
    body: ArrayBuffer,
  ): Promise<Response> {
    try {
      const namespace = primarySiteDbNamespace(
        this.binding(),
        canEmulateJurisdiction(this.env?.ENVIRONMENT),
      );
      const response = await siteDbStub(namespace, site).fetch(
        `https://site-db.internal/${operation}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SITE_DB_ROLE_HEADER]: "primary",
            [SITE_DB_SITE_HEADER]: site,
          },
          body,
        },
      );
      return new Response(response.body, { status: response.status, headers: response.headers });
    } catch (error) {
      console.error("site-gateway: EU Site database unreachable", error);
      return lostResponse(operation);
    }
  }

  /** The legacy object's side of a copy (see the class comment). */
  private async relocationOperation(step: string, request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      const parsed = (await request.json()) as unknown;
      if (!isRecord(parsed)) throw new Error("not an object");
      body = parsed;
    } catch {
      return errorResponse("validation", "The request body must be JSON");
    }
    const token = typeof body.token === "string" ? body.token : null;
    const site = request.headers.get(SITE_DB_SITE_HEADER) ?? "";
    try {
      switch (step) {
        case "begin": {
          if (!token || !UUID.test(site)) throw new SiteDbError("validation", "Give a token");
          const moved = this.kv.get<MovedRecord>(MOVED_KEY);
          if (moved) return Response.json({ moved: true, erased: moved.erased === true });
          if (isEmptyDatabase(this.sql, this.kv)) {
            // Nothing to copy. Store only the moved marker (no Site data), so
            // an earlier gateway release is sent to the EU object too.
            this.kv.put(MOVED_KEY, {
              site,
              at: new Date().toISOString(),
              erased: true,
            } satisfies MovedRecord);
            this.kv.delete(FENCE_KEY);
            return Response.json({ empty: true });
          }
          const bytes = this.sql.databaseSize;
          if (typeof body.maxBytes === "number" && bytes > body.maxBytes)
            return Response.json({ tooLarge: true, bytes });
          // One EU object per Site copies at a time; a newer token replaces a dead one.
          this.kv.put(FENCE_KEY, { token, site } satisfies FenceRecord);
          return Response.json({ bytes });
        }
        case "page": {
          this.holdFence(token);
          const cursor = (isRecord(body.cursor) ? body.cursor : null) as PageCursor | null;
          // An unsupported table refuses the copy (RelocationError) before any row is read.
          const tables = copiedTables(this.sql);
          return Response.json({ page: guarded(() => readPage(this.sql, tables, cursor)) });
        }
        case "state": {
          this.holdFence(token);
          return Response.json(await relocationState(this.sql, this.kv));
        }
        case "commit": {
          const fence = this.kv.get<FenceRecord>(FENCE_KEY);
          const moved = this.kv.get<MovedRecord>(MOVED_KEY);
          if (moved) return Response.json({ moved: true });
          if (!fence || fence.token !== token)
            throw new SiteDbError("conflict", "This copy does not hold the database");
          this.kv.put(MOVED_KEY, {
            site: fence.site,
            at: new Date().toISOString(),
          } satisfies MovedRecord);
          this.kv.delete(FENCE_KEY);
          return Response.json({ moved: true });
        }
        case "erase": {
          // The database was reset or rebuilt in the EU (or is being reset
          // before it moved): delete everything here, keeping only the marker
          // that sends earlier gateway releases to the EU object.
          if (!UUID.test(site)) throw new SiteDbError("validation", "The Site id is missing");
          const moved = this.kv.get<MovedRecord>(MOVED_KEY);
          await this.state.storage.deleteAll();
          this.kv.put(MOVED_KEY, {
            site: moved?.site ?? site,
            at: new Date().toISOString(),
            erased: true,
          } satisfies MovedRecord);
          return Response.json({ erased: true });
        }
        case "status": {
          // Read-only: what this legacy object holds and whether it moved.
          return Response.json(
            guarded(() => ({
              moved: this.kv.get<MovedRecord>(MOVED_KEY) ?? null,
              fenced: this.kv.get<FenceRecord>(FENCE_KEY) !== undefined,
              empty: isEmptyDatabase(this.sql, this.kv),
              tables: userTables(this.sql).map((name) => ({
                name,
                rows: Number(
                  this.sql
                    .exec(`SELECT count(*) AS n FROM ${quoteSiteSqlIdentifier(name)}`)
                    .toArray()[0]?.n ?? 0,
                ),
              })),
            })),
          );
        }
        case "release": {
          const fence = this.kv.get<FenceRecord>(FENCE_KEY);
          if (fence && fence.token === token) this.kv.delete(FENCE_KEY);
          return Response.json({ released: true });
        }
        default:
          return errorResponse("not_found", "Unknown operation");
      }
    } catch (error) {
      if (error instanceof RelocationError) return errorResponse("validation", error.message);
      const failure = toSiteDbError(error);
      return errorResponse(failure.code, failure.message);
    }
  }

  /** Refuse a step whose fence is gone or replaced (the source may have changed). */
  private holdFence(token: string | null): void {
    const fence = this.kv.get<FenceRecord>(FENCE_KEY);
    if (!fence || fence.token !== token)
      throw new SiteDbError("conflict", "The copy lost its hold on the database; start again");
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
   * reopens the replay window, and the location records.
   */
  private async wipe(): Promise<void> {
    const bucket = Math.floor(Date.now() / REQUEST_BUCKET_MS);
    const recent = [
      ...this.kv.list({
        start: requestKey(bucket - REQUEST_BUCKETS_CHECKED + 1, ""),
        end: `${REQUEST_PREFIX}~`,
      }),
      // Where the database lives is not part of it.
      ...this.kv.list({ prefix: LOCATION_PREFIX }),
    ].map(([key, value]) => [key, value] as const);
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
