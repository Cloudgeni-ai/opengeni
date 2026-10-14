import { sql, type SQL } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import {
  isPlainJsonObject,
  parseSiteDataPath,
  readSiteDataPath,
  siteDataMayCreate,
  siteDataModifyReach,
  siteDataReadReach,
  siteDataScopedPerViewer,
  writeSiteDataPath,
  SITE_DATA_ACCESS_MODES,
  SITE_DATA_COLLECTION_NAME,
  SITE_DATA_DEFAULT_PAGE,
  SITE_DATA_MAX_BATCH,
  SITE_DATA_MAX_FILTERS,
  SITE_DATA_MAX_FILTER_STRING,
  SITE_DATA_MAX_IN_VALUES,
  SITE_DATA_MAX_INDEXED_FIELDS,
  SITE_DATA_MAX_JSON_SCHEMA_BYTES,
  SITE_DATA_MAX_KEY_LENGTH,
  SITE_DATA_MAX_PAGE,
  SITE_DATA_MAX_SORT_KEYS,
  SITE_DATA_MAX_UNIQUE_SET_FIELDS,
  SITE_DATA_MAX_UNIQUE_SETS,
  SITE_DATA_RECORD_OVERHEAD_BYTES,
  type SiteDataAccessMode,
  type SiteDataRole,
} from "./site-data-policy";

export * from "./site-data-policy";

// ---------------------------------------------------------------------------
// Types shared by every Site Data backend.
// ---------------------------------------------------------------------------

export type SiteDataErrorCode =
  | "validation"
  | "conflict"
  | "not_found"
  | "forbidden"
  | "quota_exceeded"
  | "rate_limited";

export class SiteDataError extends Error {
  constructor(
    readonly code: SiteDataErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SiteDataError";
  }
}

export type SiteDataScope = { accountId: string; workspaceId: string; siteId: string };

/**
 * Who is calling. `principal` owns records (the person, or the person an agent
 * acts for); `actor` is recorded as the writer. `framed` marks requests from
 * Site HTML: they are always viewers and never manage collections.
 */
export type SiteDataCaller = SiteDataScope & {
  role: SiteDataRole;
  principal: string;
  actor: string;
  framed: boolean;
};

/** Each started 5 ms of schema validation counts one more write operation. */
export const SITE_DATA_VALIDATION_MS_PER_OPERATION = 5;

/** What a write's admission needs to know to reserve validation time. */
export type SiteDataValidationAdmission = {
  /** Collections whose records the request validates. */
  collections?: readonly string[];
  /** Whether the request compiles a schema itself (defining a collection with one). */
  schema?: boolean;
  /** Validation time to reserve: the request's budget. */
  reserveMs: number;
};

export type SiteDataLimits = {
  recordBytesPerSite: number;
  maxRecordBytes: number;
  maxCollectionsPerSite: number;
  fileBytesPerSite: number;
  maxFileBytes: number;
  workspaceBytes: number;
  maxRecordsPerCollection: number;
  viewerWritesPerMinute: number;
  siteWritesPerMinute: number;
  viewerReadsPerMinute: number;
  /** Write operations per minute by all of a Site's managers (API and agent tools). */
  managerWritesPerMinute: number;
  /** Schema-validation milliseconds per minute for one Site. */
  siteValidationMsPerMinute: number;
  /** Schema-validation milliseconds per minute across all of a workspace's Sites. */
  workspaceValidationMsPerMinute: number;
};

export type SiteDataCollectionDefinition = {
  name: string;
  accessMode: SiteDataAccessMode;
  privateRecords?: boolean;
  jsonSchema?: Record<string, unknown> | null;
  indexedFields?: string[];
  uniqueFields?: string[][];
};

export type SiteDataCollection = {
  id: string;
  name: string;
  accessMode: SiteDataAccessMode;
  privateRecords: boolean;
  jsonSchema: Record<string, unknown> | null;
  indexedFields: string[];
  uniqueFields: string[][];
  recordCount: number;
  recordBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type SiteDataRecord = {
  id: string;
  key: string | null;
  data: Record<string, unknown>;
  owner: string;
  createdBy: string;
  updatedBy: string;
  version: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type SiteDataUsage = {
  collectionCount: number;
  recordCount: number;
  recordBytes: number;
  fileCount: number;
  fileBytes: number;
  workspaceBytes: number;
};

export type SiteDataFilterOp =
  | "eq"
  | "ne"
  | "in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "exists";
export type SiteDataFilter = { field: string; op: SiteDataFilterOp; value?: unknown | undefined };
export type SiteDataSort = { field: string; direction?: "asc" | "desc" | undefined };
export type SiteDataQuery = {
  collection: string;
  where?: SiteDataFilter[];
  sort?: SiteDataSort[];
  limit?: number;
  cursor?: string | null;
  count?: boolean;
  /** `own` limits reads to the caller's records; `all` is everything the caller may read. */
  scope?: "own" | "all";
};
export type SiteDataQueryResult = {
  records: SiteDataRecord[];
  nextCursor: string | null;
  count?: number;
};

export type SiteDataRecordRef = { id?: string; key?: string };
export type SiteDataWriteOp =
  | { op: "insert"; collection: string; key?: string; data: Record<string, unknown> }
  | {
      op: "put";
      collection: string;
      key: string;
      data: Record<string, unknown>;
      expectedVersion?: number;
    }
  | ({
      op: "patch";
      collection: string;
      data: Record<string, unknown>;
      expectedVersion?: number;
    } & SiteDataRecordRef)
  | ({ op: "delete"; collection: string; expectedVersion?: number } & SiteDataRecordRef)
  | ({ op: "increment"; collection: string; field: string; by?: number } & SiteDataRecordRef);

export type SiteDataWriteResultItem =
  | { op: "insert" | "put" | "patch" | "increment"; record: SiteDataRecord }
  | { op: "delete"; deleted: { id: string } };

export type SiteDataWriteSummary = {
  operations: number;
  bytesWritten: number;
  recordDelta: number;
  byteDelta: number;
};

export type SiteDataWriteOptions = {
  limits: SiteDataLimits;
  /** JSON Schema validation, supplied by the service layer. */
  validate?: (schema: Record<string, unknown>, data: Record<string, unknown>) => string | null;
  /** Usage metering inside the same transaction. */
  afterWrite?: (tx: Database, summary: SiteDataWriteSummary) => Promise<void>;
};

export type SiteDataFileScope = "shared" | "private";
export type SiteDataFile = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  scope: SiteDataFileScope;
  owner: string;
  createdBy: string;
  createdAt: string;
};
export type SiteDataStoredFile = SiteDataFile & { objectKey: string };

export type SiteDataSite = {
  id: string;
  title: string;
  status: "active" | "archived";
  visibility: "workspace_shared" | "user_private";
  ownerSubjectId: string | null;
  createdBySubjectId: string | null;
};

/**
 * Backend-neutral Site Data store. Postgres implements it today; another
 * backend implements the same contract. Authorization (role and principal) is
 * resolved by the caller; the store enforces the per-collection matrix,
 * quotas, uniqueness and write windows.
 */
export interface SiteDataStore {
  describe(scope: SiteDataScope): Promise<{
    collections: SiteDataCollection[];
    usage: SiteDataUsage;
  }>;
  getCollection(scope: SiteDataScope, name: string): Promise<SiteDataCollection | null>;
  defineCollection(
    caller: SiteDataCaller,
    definition: SiteDataCollectionDefinition,
    limits: SiteDataLimits,
  ): Promise<{ collection: SiteDataCollection; created: boolean }>;
  deleteCollection(caller: SiteDataCaller, name: string): Promise<{ deletedRecords: number }>;
  resetCollection(caller: SiteDataCaller, name: string): Promise<{ deletedRecords: number }>;
  query(caller: SiteDataCaller, query: SiteDataQuery): Promise<SiteDataQueryResult>;
  get(
    caller: SiteDataCaller,
    collection: string,
    ref: SiteDataRecordRef,
  ): Promise<SiteDataRecord | null>;
  write(
    caller: SiteDataCaller,
    ops: SiteDataWriteOp[],
    options: SiteDataWriteOptions,
  ): Promise<{ results: SiteDataWriteResultItem[]; summary: SiteDataWriteSummary }>;
  listFiles(
    caller: SiteDataCaller,
    options?: { limit?: number; cursor?: string | null },
  ): Promise<{ files: SiteDataFile[]; nextCursor: string | null }>;
  getFile(caller: SiteDataCaller, fileId: string): Promise<SiteDataStoredFile | null>;
  /** Check file quotas before any bytes are stored; insertFile checks again under the lock. */
  checkFileQuota(caller: SiteDataCaller, sizeBytes: number, limits: SiteDataLimits): Promise<void>;
  insertFile(
    caller: SiteDataCaller,
    file: Omit<SiteDataStoredFile, "owner" | "createdBy" | "createdAt">,
    options: Pick<SiteDataWriteOptions, "limits" | "afterWrite">,
  ): Promise<SiteDataFile>;
  /**
   * Count an attempt against the caller's and the Site's one-minute window in
   * its own committed transaction, before any work: failed attempts count too.
   *
   * A write that will validate records (it touches a collection with a
   * schema, or defines one with a schema) also reserves `reserveMs` of
   * validation time against the Site's and the workspace's validation
   * windows in the same transaction, and is refused when either cannot take
   * it. Other writes touch no validation window.
   */
  consumeRate(
    caller: SiteDataCaller,
    kind: "write" | "read",
    operations: number,
    limits: SiteDataLimits,
    validation?: SiteDataValidationAdmission,
  ): Promise<{ reservedMs: number }>;
  /**
   * Settle a write's validation time, whatever its outcome: replace the
   * reservation with the time spent on the Site's and workspace's validation
   * windows, and add one operation per started 5 ms spent (from 1 ms) to the
   * caller's write windows. Never refused: the work is done. Does nothing
   * when nothing was reserved or spent.
   */
  settleValidation(
    caller: SiteDataCaller,
    time: { reservedMs: number; spentMs: number },
    limits: SiteDataLimits,
  ): Promise<void>;
  deleteFile(caller: SiteDataCaller, fileId: string): Promise<SiteDataStoredFile>;
}

// ---------------------------------------------------------------------------
// Postgres implementation.
// ---------------------------------------------------------------------------

type CollectionRow = {
  id: string;
  name: string;
  access_mode: SiteDataAccessMode;
  private_records: boolean;
  json_schema: Record<string, unknown> | null;
  indexed_fields: string[];
  unique_fields: string[][];
  created_at: string | Date;
  updated_at: string | Date;
  record_count?: string | number | null;
  record_bytes?: string | number | null;
};

type RecordRow = {
  id: string;
  record_key: string | null;
  data: Record<string, unknown>;
  owner_principal: string;
  created_by: string;
  updated_by: string;
  version: number;
  size_bytes: number;
  created_at: string | Date;
  updated_at: string | Date;
  key_scope?: string;
  cursor_values?: unknown[];
};

type FileRow = {
  id: string;
  name: string;
  content_type: string;
  size_bytes: string | number;
  sha256: string;
  object_key: string;
  scope: SiteDataFileScope;
  owner_principal: string;
  created_by: string;
  created_at: string | Date;
};

type UsageRow = {
  collection_count: number;
  record_count: string | number;
  record_bytes: string | number;
  file_count: number;
  file_bytes: string | number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function num(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toCollection(row: CollectionRow): SiteDataCollection {
  return {
    id: row.id,
    name: row.name,
    accessMode: row.access_mode,
    privateRecords: row.private_records,
    jsonSchema: row.json_schema ?? null,
    indexedFields: Array.isArray(row.indexed_fields) ? row.indexed_fields : [],
    uniqueFields: Array.isArray(row.unique_fields) ? row.unique_fields : [],
    recordCount: num(row.record_count),
    recordBytes: num(row.record_bytes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toRecord(row: RecordRow): SiteDataRecord {
  return {
    id: row.id,
    key: row.record_key,
    data: row.data,
    owner: row.owner_principal,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    version: row.version,
    sizeBytes: row.size_bytes,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toFile(row: FileRow): SiteDataStoredFile {
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: num(row.size_bytes),
    sha256: row.sha256,
    objectKey: row.object_key,
    scope: row.scope,
    owner: row.owner_principal,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

export function publicSiteDataFile(file: SiteDataStoredFile): SiteDataFile {
  const { objectKey: _objectKey, ...rest } = file;
  return rest;
}

function recordBytes(data: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

/** A Postgres text[] literal; every element is quoted so `null` stays a name. */
function pathLiteral(segments: readonly string[]): string {
  return `{${segments.map((segment) => `"${segment.replace(/["\\]/gu, "\\$&")}"`).join(",")}}`;
}

/** Storage charged against quotas for a record of this JSON size. */
export function siteDataChargedBytes(sizeBytes: number): number {
  return sizeBytes + SITE_DATA_RECORD_OVERHEAD_BYTES;
}

function databaseErrorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

function validationError(message: string, details: Record<string, unknown> = {}): SiteDataError {
  return new SiteDataError("validation", message, details);
}

/** Validate and normalize a collection definition. */
export function normalizeSiteDataCollectionDefinition(
  definition: SiteDataCollectionDefinition,
): Required<SiteDataCollectionDefinition> {
  if (!SITE_DATA_COLLECTION_NAME.test(definition.name ?? ""))
    throw validationError(
      "Collection names start with a letter and use letters, digits, - or _ (up to 64)",
    );
  if (!SITE_DATA_ACCESS_MODES.includes(definition.accessMode))
    throw validationError(`Access mode must be one of ${SITE_DATA_ACCESS_MODES.join(", ")}`);
  const privateRecords = definition.privateRecords === true;
  if (privateRecords && definition.accessMode !== "per_viewer")
    throw validationError("Only per_viewer collections can keep records private");
  const jsonSchema = definition.jsonSchema ?? null;
  if (jsonSchema !== null) {
    if (!isPlainJsonObject(jsonSchema)) throw validationError("jsonSchema must be an object");
    if (Buffer.byteLength(JSON.stringify(jsonSchema), "utf8") > SITE_DATA_MAX_JSON_SCHEMA_BYTES)
      throw validationError("jsonSchema is larger than 64 KB");
  }
  const indexedFields = [...new Set(definition.indexedFields ?? [])];
  if (indexedFields.length > SITE_DATA_MAX_INDEXED_FIELDS)
    throw validationError(`At most ${SITE_DATA_MAX_INDEXED_FIELDS} indexed fields`);
  for (const field of indexedFields)
    if (!parseSiteDataPath(field)) throw validationError(`Invalid indexed field: ${field}`);
  const uniqueFields = (definition.uniqueFields ?? []).map((set) => [...new Set(set)]);
  if (uniqueFields.length > SITE_DATA_MAX_UNIQUE_SETS)
    throw validationError(`At most ${SITE_DATA_MAX_UNIQUE_SETS} unique field sets`);
  for (const set of uniqueFields) {
    if (set.length === 0 || set.length > SITE_DATA_MAX_UNIQUE_SET_FIELDS)
      throw validationError(
        `Each unique field set has 1 to ${SITE_DATA_MAX_UNIQUE_SET_FIELDS} fields`,
      );
    for (const field of set)
      if (!parseSiteDataPath(field)) throw validationError(`Invalid unique field: ${field}`);
  }
  return {
    name: definition.name,
    accessMode: definition.accessMode,
    privateRecords,
    jsonSchema,
    indexedFields,
    uniqueFields,
  };
}

// --- query building --------------------------------------------------------

type SortKey = {
  field: string;
  direction: "asc" | "desc";
  expr: SQL;
  cursor: (value: unknown) => SQL;
};

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)?$/u;

function cursorTimestamp(value: unknown): SQL {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value))
    throw validationError("Invalid cursor for this query");
  return sql`${value}::timestamptz`;
}

const SYSTEM_SORTS: Readonly<Record<string, { expr: SQL; cast: (value: unknown) => SQL }>> =
  Object.freeze(
    Object.assign(
      Object.create(null) as Record<string, { expr: SQL; cast: (value: unknown) => SQL }>,
      {
        $createdAt: { expr: sql`r.created_at`, cast: cursorTimestamp },
        $updatedAt: { expr: sql`r.updated_at`, cast: cursorTimestamp },
        $key: {
          expr: sql`(coalesce(r.record_key, '') collate "C")`,
          cast: (value: unknown) => {
            if (typeof value !== "string") throw validationError("Invalid cursor for this query");
            return sql`(${value}::text collate "C")`;
          },
        },
        $version: {
          expr: sql`r.version`,
          cast: (value: unknown) => {
            if (
              typeof value !== "number" ||
              !Number.isInteger(value) ||
              value < 0 ||
              value > 2 ** 31
            )
              throw validationError("Invalid cursor for this query");
            return sql`${value}::integer`;
          },
        },
      },
    ),
  );

function sortKey(sort: SiteDataSort): SortKey {
  const direction = sort.direction === "desc" ? "desc" : "asc";
  if (typeof sort.field !== "string") throw validationError("Each sort needs a field");
  const system = Object.hasOwn(SYSTEM_SORTS, sort.field) ? SYSTEM_SORTS[sort.field] : undefined;
  if (system) return { field: sort.field, direction, expr: system.expr, cursor: system.cast };
  if (sort.field.startsWith("$")) throw validationError(`Cannot sort by ${sort.field}`);
  const segments = parseSiteDataPath(sort.field);
  if (!segments) throw validationError(`Invalid sort field: ${sort.field}`);
  return {
    field: sort.field,
    direction,
    expr: sql`coalesce(r.data #> ${pathLiteral(segments)}::text[], 'null'::jsonb)`,
    cursor: (value) => sql`${JSON.stringify(value ?? null)}::jsonb`,
  };
}

function encodeCursor(signature: string, values: unknown[], id: string): string {
  return Buffer.from(JSON.stringify({ s: signature, v: values, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, signature: string): { v: unknown[]; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      s?: unknown;
      v?: unknown;
      id?: unknown;
    };
    if (
      parsed.s === signature &&
      Array.isArray(parsed.v) &&
      typeof parsed.id === "string" &&
      UUID.test(parsed.id)
    )
      return { v: parsed.v, id: parsed.id };
  } catch {
    // fall through
  }
  throw validationError("Invalid cursor for this query");
}

function compare(op: "gt" | "gte" | "lt" | "lte"): SQL {
  return sql.raw(op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=");
}

function requireScalar(filter: SiteDataFilter): string | number {
  if (typeof filter.value === "number" && Number.isFinite(filter.value)) return filter.value;
  if (typeof filter.value === "string") return filter.value;
  throw validationError(`${filter.op} on ${filter.field} needs a number or string`);
}

/** Bound what a filter may carry: short strings, short lists, small JSON values. */
function assertFilterValue(filter: SiteDataFilter): void {
  const check = (value: unknown) => {
    if (typeof value === "string" && value.length > SITE_DATA_MAX_FILTER_STRING)
      throw validationError(
        `Filter values on ${filter.field} are at most ${SITE_DATA_MAX_FILTER_STRING} characters`,
      );
    if (
      value !== null &&
      typeof value === "object" &&
      JSON.stringify(value).length > SITE_DATA_MAX_FILTER_STRING
    )
      throw validationError(
        `Filter values on ${filter.field} are at most ${SITE_DATA_MAX_FILTER_STRING} characters of JSON`,
      );
  };
  if (Array.isArray(filter.value) && filter.op === "in") {
    if (filter.value.length > SITE_DATA_MAX_IN_VALUES)
      throw validationError(
        `in on ${filter.field} needs an array of at most ${SITE_DATA_MAX_IN_VALUES}`,
      );
    for (const item of filter.value) check(item);
    return;
  }
  check(filter.value);
}

function systemFilter(caller: SiteDataCaller, filter: SiteDataFilter): SQL {
  const field = filter.field;
  const op = filter.op;
  const list = (cast: (value: unknown) => SQL): SQL => {
    if (!Array.isArray(filter.value) || filter.value.length > SITE_DATA_MAX_IN_VALUES)
      throw validationError(`in on ${field} needs an array of at most ${SITE_DATA_MAX_IN_VALUES}`);
    if (filter.value.length === 0) return sql`false`;
    return sql.join(
      filter.value.map((value) => cast(value)),
      sql`, `,
    );
  };
  if (field === "$id") {
    const cast = (value: unknown) => {
      if (typeof value !== "string" || !UUID.test(value))
        throw validationError("$id filters need record ids");
      return sql`${value}::uuid`;
    };
    if (op === "eq") return sql`r.id = ${cast(filter.value)}`;
    if (op === "ne") return sql`r.id <> ${cast(filter.value)}`;
    if (op === "in")
      return Array.isArray(filter.value) && filter.value.length === 0
        ? sql`false`
        : sql`r.id in (${list(cast)})`;
    throw validationError(`$id supports eq, ne and in`);
  }
  if (field === "$owner") {
    const cast = (value: unknown) => {
      if (typeof value !== "string") throw validationError("$owner filters need principals");
      return sql`${value === "me" ? caller.principal : value}::text`;
    };
    if (op === "eq") return sql`r.owner_principal = ${cast(filter.value)}`;
    if (op === "ne") return sql`r.owner_principal <> ${cast(filter.value)}`;
    if (op === "in")
      return Array.isArray(filter.value) && filter.value.length === 0
        ? sql`false`
        : sql`r.owner_principal in (${list(cast)})`;
    throw validationError(`$owner supports eq, ne and in`);
  }
  if (field === "$key") {
    if (op === "exists")
      return filter.value === false ? sql`r.record_key is null` : sql`r.record_key is not null`;
    const cast = (value: unknown) => {
      if (typeof value !== "string") throw validationError("$key filters need strings");
      return sql`${value}::text`;
    };
    if (op === "eq") return sql`r.record_key = ${cast(filter.value)}`;
    if (op === "ne") return sql`r.record_key is distinct from ${cast(filter.value)}`;
    if (op === "in")
      return Array.isArray(filter.value) && filter.value.length === 0
        ? sql`false`
        : sql`r.record_key in (${list(cast)})`;
    if (op === "contains")
      return sql`strpos(lower(coalesce(r.record_key, '')), lower(${cast(filter.value)})) > 0`;
    return sql`(r.record_key collate "C") ${compare(op)} (${cast(filter.value)} collate "C")`;
  }
  if (field === "$createdAt" || field === "$updatedAt" || field === "$version") {
    const column =
      field === "$createdAt"
        ? sql`r.created_at`
        : field === "$updatedAt"
          ? sql`r.updated_at`
          : sql`r.version`;
    const cast = (value: unknown) => {
      if (field === "$version") {
        if (typeof value !== "number" || !Number.isInteger(value))
          throw validationError("$version filters need integers");
        return sql`${value}::integer`;
      }
      if (typeof value !== "string" || !ISO_TIMESTAMP.test(value))
        throw validationError(`${field} filters need ISO timestamps`);
      return sql`${value}::timestamptz`;
    };
    if (op === "eq") return sql`${column} = ${cast(filter.value)}`;
    if (op === "ne") return sql`${column} <> ${cast(filter.value)}`;
    if (op === "in")
      return Array.isArray(filter.value) && filter.value.length === 0
        ? sql`false`
        : sql`${column} in (${list(cast)})`;
    if (op === "gt" || op === "gte" || op === "lt" || op === "lte")
      return sql`${column} ${compare(op)} ${cast(filter.value)}`;
    throw validationError(`${field} supports eq, ne, in, gt, gte, lt and lte`);
  }
  throw validationError(`Unknown system field: ${field}`);
}

function dataFilter(collection: SiteDataCollection, filter: SiteDataFilter): SQL {
  const segments = parseSiteDataPath(filter.field);
  if (!segments) throw validationError(`Invalid field: ${filter.field}`);
  const path = pathLiteral(segments);
  const value = sql`(r.data #> ${path}::text[])`;
  const json = (input: unknown) => {
    if (input === undefined) throw validationError(`${filter.op} on ${filter.field} needs a value`);
    return sql`${JSON.stringify(input)}::jsonb`;
  };
  const containment = (input: unknown): SQL | null => {
    if (input === null || typeof input === "object") return null;
    let nested: unknown = input;
    for (const segment of [...segments].reverse()) nested = { [segment]: nested };
    return sql`r.data @> ${JSON.stringify(nested)}::jsonb`;
  };
  const indexed = collection.indexedFields.includes(filter.field);
  switch (filter.op) {
    case "eq": {
      if (filter.value === null) return sql`(${value} is null or ${value} = 'null'::jsonb)`;
      const prefilter = containment(filter.value);
      return prefilter
        ? sql`(${prefilter} and ${value} = ${json(filter.value)})`
        : sql`${value} = ${json(filter.value)}`;
    }
    case "ne":
      return sql`${value} is distinct from ${json(filter.value)}`;
    case "in": {
      if (!Array.isArray(filter.value) || filter.value.length > SITE_DATA_MAX_IN_VALUES)
        throw validationError(
          `in on ${filter.field} needs an array of at most ${SITE_DATA_MAX_IN_VALUES}`,
        );
      if (filter.value.length === 0) return sql`false`;
      return sql`${value} in (${sql.join(
        filter.value.map((item) => json(item)),
        sql`, `,
      )})`;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const scalar = requireScalar(filter);
      if (typeof scalar === "number") {
        const exact = sql`(case when jsonb_typeof(${value}) = 'number' then (${value} #>> '{}')::numeric end) ${compare(filter.op)} ${scalar}::numeric`;
        return indexed
          ? sql`(exists (select 1 from site_data_record_values v where v.record_id = r.id
              and v.kind = 'index' and v.collection_id = r.collection_id and v.name = ${filter.field}
              and v.value_num ${compare(filter.op)} ${scalar}::double precision) and ${exact})`
          : exact;
      }
      return sql`((case when jsonb_typeof(${value}) = 'string' then ${value} #>> '{}' end) collate "C") ${compare(filter.op)} (${scalar}::text collate "C")`;
    }
    case "contains": {
      if (filter.value === undefined)
        throw validationError(`contains on ${filter.field} needs a value`);
      const element = sql`${value} @> jsonb_build_array(${json(filter.value)})`;
      if (typeof filter.value === "string")
        return sql`((jsonb_typeof(${value}) = 'array' and ${element})
          or (jsonb_typeof(${value}) = 'string' and strpos(lower(${value} #>> '{}'), lower(${filter.value}::text)) > 0))`;
      return sql`(jsonb_typeof(${value}) = 'array' and ${element})`;
    }
    case "exists":
      return filter.value === false ? sql`${value} is null` : sql`${value} is not null`;
    default:
      throw validationError(`Unknown filter operator: ${String((filter as SiteDataFilter).op)}`);
  }
}

// --- the store -------------------------------------------------------------

export function createPostgresSiteDataStore(db: Database): SiteDataStore {
  const scoped = <T>(scope: SiteDataScope, fn: (tx: Database) => Promise<T>) =>
    withRlsContext(db, { accountId: scope.accountId, workspaceId: scope.workspaceId }, fn);

  // Collections carry their own record count and charged bytes, maintained
  // in the write transaction, so no read ever counts a collection.
  const loadCollections = async (tx: Database, scope: SiteDataScope) => {
    const rows = await rawRows<CollectionRow>(
      tx,
      sql`select c.* from site_data_collections c
        where c.workspace_id = ${scope.workspaceId} and c.site_id = ${scope.siteId}
        order by c.name`,
    );
    return rows.map(toCollection);
  };

  const loadCollection = async (tx: Database, scope: SiteDataScope, name: string) => {
    const rows = await rawRows<CollectionRow>(
      tx,
      sql`select c.* from site_data_collections c
        where c.workspace_id = ${scope.workspaceId} and c.site_id = ${scope.siteId} and c.name = ${name}`,
    );
    return rows[0] ? toCollection(rows[0]) : null;
  };

  const requireCollection = async (tx: Database, scope: SiteDataScope, name: string) => {
    if (typeof name !== "string" || !SITE_DATA_COLLECTION_NAME.test(name))
      throw new SiteDataError("not_found", `Collection ${String(name)} does not exist`);
    const collection = await loadCollection(tx, scope, name);
    if (!collection) throw new SiteDataError("not_found", `Collection ${name} does not exist`);
    return collection;
  };

  /**
   * The write windows a caller counts against: managers share one generous
   * window per Site, apart from viewers and Site frames, who count per person
   * and per Site.
   */
  const writeWindows = (
    caller: SiteDataCaller,
    limits: SiteDataLimits,
  ): Array<[string, number, string]> =>
    caller.role === "manager" && !caller.framed
      ? [["manager:*", limits.managerWritesPerMinute, "This Site's managers are writing too fast."]]
      : [
          [caller.principal, limits.viewerWritesPerMinute, "Too many writes."],
          ["*", limits.siteWritesPerMinute, "This Site is receiving too many writes."],
        ];

  /** Add operations to one fixed one-minute window and return its total. */
  const countRateWindow = async (
    tx: Database,
    caller: SiteDataCaller,
    principal: string,
    operations: number,
  ) => {
    const [row] = await rawRows<{ operations: number }>(
      tx,
      sql`insert into site_data_rate_windows
          (account_id, workspace_id, site_id, principal_key, window_started_at, operations)
        values (${caller.accountId}, ${caller.workspaceId}, ${caller.siteId}, ${principal},
          date_trunc('minute', now()), ${operations})
        on conflict (workspace_id, site_id, principal_key) do update set
          operations = case
            when site_data_rate_windows.window_started_at = excluded.window_started_at
            then least(site_data_rate_windows.operations + excluded.operations, 1000000000)
            else excluded.operations end,
          window_started_at = excluded.window_started_at
        returning operations`,
    );
    return row?.operations ?? 0;
  };

  /** Whether any of these collections has a JSON Schema. */
  const touchesSchema = async (tx: Database, caller: SiteDataCaller, names: readonly string[]) => {
    const valid = [...new Set(names)].filter((name) => SITE_DATA_COLLECTION_NAME.test(name));
    if (valid.length === 0) return false;
    const [row] = await rawRows<{ found: boolean }>(
      tx,
      sql`select exists (
          select 1 from site_data_collections
          where workspace_id = ${caller.workspaceId} and site_id = ${caller.siteId}
            and name in (${sql.join(
              valid.map((name) => sql`${name}`),
              sql`, `,
            )})
            and json_schema is not null
        ) as found`,
    );
    return row?.found === true;
  };

  /**
   * Add (or, with a negative amount, refund) validation time on the Site's
   * and the workspace's current one-minute windows and return both totals. A
   * window from an earlier minute starts over; totals never go below zero.
   */
  const addValidationTime = async (
    tx: Database,
    caller: SiteDataCaller,
    micros: number,
  ): Promise<[number, number]> => {
    const [site] = await rawRows<{ validation_micros: string | number }>(
      tx,
      sql`insert into site_data_validation_windows
          (account_id, workspace_id, site_id, window_started_at, validation_micros)
        values (${caller.accountId}, ${caller.workspaceId}, ${caller.siteId},
          date_trunc('minute', now()), greatest(0, ${micros}::bigint))
        on conflict (workspace_id, site_id) do update set
          validation_micros = case
            when site_data_validation_windows.window_started_at = excluded.window_started_at
            then least(greatest(0, site_data_validation_windows.validation_micros + ${micros}::bigint),
              1000000000000000)
            else excluded.validation_micros end,
          window_started_at = excluded.window_started_at
        returning validation_micros`,
    );
    const [workspace] = await rawRows<{ validation_micros: string | number }>(
      tx,
      sql`insert into site_data_workspace_validation_windows
          (account_id, workspace_id, window_started_at, validation_micros)
        values (${caller.accountId}, ${caller.workspaceId},
          date_trunc('minute', now()), greatest(0, ${micros}::bigint))
        on conflict (workspace_id) do update set
          validation_micros = case
            when site_data_workspace_validation_windows.window_started_at = excluded.window_started_at
            then least(
              greatest(0, site_data_workspace_validation_windows.validation_micros + ${micros}::bigint),
              1000000000000000)
            else excluded.validation_micros end,
          window_started_at = excluded.window_started_at
        returning validation_micros`,
    );
    return [num(site?.validation_micros), num(workspace?.validation_micros)];
  };

  /** Serialize every write to one Site's data and return its totals. */
  const lockUsage = async (tx: Database, scope: SiteDataScope) => {
    await tx.execute(
      sql`insert into site_data_usage (account_id, workspace_id, site_id)
        values (${scope.accountId}, ${scope.workspaceId}, ${scope.siteId})
        on conflict (workspace_id, site_id) do nothing`,
    );
    const [row] = await rawRows<UsageRow>(
      tx,
      sql`select collection_count, record_count, record_bytes, file_count, file_bytes
        from site_data_usage where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}
        for update`,
    );
    if (!row) throw new SiteDataError("not_found", "Site not found");
    return {
      collectionCount: row.collection_count,
      recordCount: num(row.record_count),
      recordBytes: num(row.record_bytes),
      fileCount: row.file_count,
      fileBytes: num(row.file_bytes),
    };
  };

  /**
   * Viewers write only to an active Site. Checked inside the write
   * transaction, holding the Site row, so archiving cannot race a write.
   */
  const assertWritableSite = async (tx: Database, caller: SiteDataCaller) => {
    if (caller.role === "manager" && !caller.framed) return;
    const [row] = await rawRows<{ status: string }>(
      tx,
      sql`select status from workspace_artifacts
        where workspace_id = ${caller.workspaceId} and id = ${caller.siteId}
        for share`,
    );
    if (!row) throw new SiteDataError("not_found", "Site not found");
    if (row.status !== "active") throw new SiteDataError("forbidden", "This Site is archived");
  };

  const workspaceBytes = async (tx: Database, scope: SiteDataScope) => {
    const [row] = await rawRows<{ total: string | number | null }>(
      tx,
      sql`select coalesce(sum(record_bytes + file_bytes), 0) as total
        from site_data_usage where workspace_id = ${scope.workspaceId}`,
    );
    return num(row?.total);
  };

  const applyUsage = async (
    tx: Database,
    scope: SiteDataScope,
    delta: Partial<
      Record<"collections" | "records" | "recordBytes" | "files" | "fileBytes", number>
    >,
  ) => {
    await tx.execute(
      sql`update site_data_usage set
          collection_count = greatest(0, collection_count + ${delta.collections ?? 0}),
          record_count = greatest(0, record_count + ${delta.records ?? 0}),
          record_bytes = greatest(0, record_bytes + ${delta.recordBytes ?? 0}),
          file_count = greatest(0, file_count + ${delta.files ?? 0}),
          file_bytes = greatest(0, file_bytes + ${delta.fileBytes ?? 0}),
          updated_at = now()
        where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}`,
    );
  };

  const fileQuota = async (
    tx: Database,
    caller: SiteDataCaller,
    usage: { fileBytes: number },
    sizeBytes: number,
    limits: SiteDataLimits,
  ) => {
    if (sizeBytes > limits.maxFileBytes)
      throw new SiteDataError(
        "quota_exceeded",
        `A file can be at most ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB`,
        { quota: "file_bytes", limit: limits.maxFileBytes },
      );
    if (usage.fileBytes + sizeBytes > limits.fileBytesPerSite)
      throw new SiteDataError("quota_exceeded", "This Site's file storage is full", {
        quota: "site_file_bytes",
        limit: limits.fileBytesPerSite,
      });
    if ((await workspaceBytes(tx, caller)) + sizeBytes > limits.workspaceBytes)
      throw new SiteDataError("quota_exceeded", "This workspace's Site data is full", {
        quota: "workspace_bytes",
        limit: limits.workspaceBytes,
      });
  };

  const deleteValues = async (tx: Database, caller: SiteDataScope, recordId: string) => {
    await tx.execute(
      sql`delete from site_data_record_values where workspace_id = ${caller.workspaceId} and record_id = ${recordId}`,
    );
  };

  /**
   * Derive unique-set hashes and indexed values from the stored records in
   * one set-based statement, for one record or a whole collection. The unique
   * index decides conflicts atomically; the first conflicting set is returned.
   */
  const syncValues = async (
    tx: Database,
    caller: SiteDataScope,
    collection: SiteDataCollection,
    records: SQL,
  ): Promise<string | null> => {
    const owner = siteDataScopedPerViewer(collection.accessMode)
      ? sql`r.owner_principal`
      : sql`''::text`;
    const value = (field: string) =>
      sql`(r.data #> ${pathLiteral(parseSiteDataPath(field) ?? [])}::text[])`;
    const candidates: SQL[] = [];
    for (const set of collection.uniqueFields) {
      const values = set.map(value);
      candidates.push(sql`select r.account_id, r.workspace_id, r.collection_id, r.id as record_id,
          'unique'::text as kind, ${set.join("+")}::text as name, ${owner} as scope,
          encode(sha256(convert_to(jsonb_build_array(${sql.join(values, sql`, `)})::text, 'UTF8')), 'hex') as value_hash,
          null::text as value_text, null::double precision as value_num
        from site_data_records r
        where ${records} and ${sql.join(
          values.map((item) => sql`coalesce(${item}, 'null'::jsonb) <> 'null'::jsonb`),
          sql` and `,
        )}`);
    }
    for (const field of collection.indexedFields) {
      const item = value(field);
      candidates.push(sql`select r.account_id, r.workspace_id, r.collection_id, r.id as record_id,
          'index'::text as kind, ${field}::text as name, ''::text as scope, null::text as value_hash,
          case when jsonb_typeof(${item}) = 'string' then ${item} #>> '{}' end as value_text,
          case when jsonb_typeof(${item}) = 'number' then (${item} #>> '{}')::double precision end as value_num
        from site_data_records r
        where ${records} and (jsonb_typeof(${item}) = 'number'
          or (jsonb_typeof(${item}) = 'string' and char_length(${item} #>> '{}') <= 256))`);
    }
    if (candidates.length === 0) return null;
    const [conflict] = await rawRows<{ name: string }>(
      tx,
      sql`with candidates as materialized (${sql.join(candidates, sql` union all `)}),
        inserted as (
          insert into site_data_record_values
            (account_id, workspace_id, collection_id, record_id, kind, name, scope, value_hash, value_text, value_num)
          select * from candidates
          on conflict (collection_id, name, scope, value_hash) where kind = 'unique' do nothing
          returning record_id, kind, name
        )
        select c.name from candidates c
        where c.kind = 'unique' and not exists (
          select 1 from inserted i where i.record_id = c.record_id and i.kind = 'unique' and i.name = c.name)
        limit 1`,
    );
    return conflict?.name ?? null;
  };

  const uniqueConflict = (name: string, message: string, details: Record<string, unknown> = {}) =>
    new SiteDataError("conflict", message.replace("%s", name.split("+").join(" + ")), {
      reason: "unique",
      fields: name.split("+"),
      ...details,
    });

  const findRecord = async (
    tx: Database,
    caller: SiteDataCaller,
    collection: SiteDataCollection,
    ref: SiteDataRecordRef,
    lock: boolean,
  ): Promise<RecordRow | null> => {
    if (ref.id !== undefined) {
      if (typeof ref.id !== "string" || !UUID.test(ref.id)) return null;
      const rows = await rawRows<RecordRow>(
        tx,
        sql`select * from site_data_records
          where workspace_id = ${caller.workspaceId} and collection_id = ${collection.id} and id = ${ref.id}
          ${lock ? sql`for update` : sql``}`,
      );
      return rows[0] ?? null;
    }
    if (typeof ref.key !== "string") throw validationError("Give a record id or key");
    const scope = siteDataScopedPerViewer(collection.accessMode) ? caller.principal : "";
    const rows = await rawRows<RecordRow>(
      tx,
      sql`select * from site_data_records
        where workspace_id = ${caller.workspaceId} and collection_id = ${collection.id}
          and key_scope = ${scope} and record_key = ${ref.key}
        ${lock ? sql`for update` : sql``}`,
    );
    return rows[0] ?? null;
  };

  const readable = (caller: SiteDataCaller, collection: SiteDataCollection, row: RecordRow) =>
    siteDataReadReach(collection, caller.role) === "all" ||
    row.owner_principal === caller.principal;

  /** Turn a malformed cursor's value errors into validation, never a 500. */
  const withCursorErrors = async <T>(hasCursor: boolean, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (hasCursor && databaseErrorCode(error).startsWith("22"))
        throw validationError("Invalid cursor for this query");
      throw error;
    }
  };

  const store: SiteDataStore = {
    async describe(scope) {
      return scoped(scope, async (tx) => {
        const collections = await loadCollections(tx, scope);
        const [usage] = await rawRows<UsageRow>(
          tx,
          sql`select collection_count, record_count, record_bytes, file_count, file_bytes
            from site_data_usage where workspace_id = ${scope.workspaceId} and site_id = ${scope.siteId}`,
        );
        return {
          collections,
          usage: {
            collectionCount: collections.length,
            recordCount: num(usage?.record_count),
            recordBytes: num(usage?.record_bytes),
            fileCount: usage?.file_count ?? 0,
            fileBytes: num(usage?.file_bytes),
            workspaceBytes: await workspaceBytes(tx, scope),
          },
        };
      });
    },

    async getCollection(scope, name) {
      if (!SITE_DATA_COLLECTION_NAME.test(name)) return null;
      return scoped(scope, (tx) => loadCollection(tx, scope, name));
    },

    async consumeRate(caller, kind, operations, limits, validation) {
      const windows: Array<[string, number, string]> =
        kind === "read"
          ? [[`read:${caller.principal}`, limits.viewerReadsPerMinute, "Too many requests."]]
          : writeWindows(caller, limits);
      // Committed on its own, before any work, so failed attempts count too.
      return scoped(caller, async (tx) => {
        for (const [principal, limit, message] of windows) {
          const total = await countRateWindow(tx, caller, principal, operations);
          if (total > limit)
            throw new SiteDataError("rate_limited", `${message} Try again in a minute.`, {
              retryAfterSeconds: 60,
            });
        }
        if (kind !== "write" || !validation || !(validation.reserveMs > 0))
          return { reservedMs: 0 };
        if (!validation.schema && !(await touchesSchema(tx, caller, validation.collections ?? [])))
          return { reservedMs: 0 };
        const micros = Math.ceil(validation.reserveMs * 1000);
        const [site, workspace] = await addValidationTime(tx, caller, micros);
        if (site > limits.siteValidationMsPerMinute * 1000)
          throw new SiteDataError(
            "rate_limited",
            "This Site has used its schema-checking time for this minute. Try again in a minute.",
            { retryAfterSeconds: 60, quota: "site_validation_time" },
          );
        if (workspace > limits.workspaceValidationMsPerMinute * 1000)
          throw new SiteDataError(
            "rate_limited",
            "This workspace's Sites have used their schema-checking time for this minute. Try again in a minute.",
            { retryAfterSeconds: 60, quota: "workspace_validation_time" },
          );
        return { reservedMs: validation.reserveMs };
      });
    },

    async settleValidation(caller, time, limits) {
      const reserved = Math.max(0, time.reservedMs);
      const spent = Math.max(0, time.spentMs);
      if (reserved === 0 && spent === 0) return;
      const extra = spent < 1 ? 0 : Math.ceil(spent / SITE_DATA_VALIDATION_MS_PER_OPERATION);
      const delta = Math.ceil(spent * 1000) - Math.ceil(reserved * 1000);
      await scoped(caller, async (tx) => {
        if (extra > 0)
          for (const [principal] of writeWindows(caller, limits))
            await countRateWindow(tx, caller, principal, extra);
        await addValidationTime(tx, caller, delta);
      });
    },

    async defineCollection(caller, input, limits) {
      if (caller.role !== "manager" || caller.framed)
        throw new SiteDataError("forbidden", "Only the Site's managers can define collections");
      const definition = normalizeSiteDataCollectionDefinition(input);
      return scoped(caller, async (tx) => {
        const usage = await lockUsage(tx, caller);
        const existing = await loadCollection(tx, caller, definition.name);
        if (!existing) {
          if (usage.collectionCount >= limits.maxCollectionsPerSite)
            throw new SiteDataError(
              "quota_exceeded",
              `A Site can have at most ${limits.maxCollectionsPerSite} collections`,
              { quota: "collections", limit: limits.maxCollectionsPerSite },
            );
          const [row] = await rawRows<CollectionRow>(
            tx,
            sql`insert into site_data_collections
                (account_id, workspace_id, site_id, name, access_mode, private_records, json_schema,
                 indexed_fields, unique_fields, created_by, updated_by)
              values (${caller.accountId}, ${caller.workspaceId}, ${caller.siteId}, ${definition.name},
                ${definition.accessMode}, ${definition.privateRecords},
                ${definition.jsonSchema === null ? null : JSON.stringify(definition.jsonSchema)}::jsonb,
                ${JSON.stringify(definition.indexedFields)}::jsonb,
                ${JSON.stringify(definition.uniqueFields)}::jsonb, ${caller.actor}, ${caller.actor})
              returning *`,
          );
          await applyUsage(tx, caller, { collections: 1 });
          return { collection: toCollection(row!), created: true };
        }
        if (
          existing.recordCount > 0 &&
          (existing.accessMode !== definition.accessMode ||
            existing.privateRecords !== definition.privateRecords)
        )
          throw new SiteDataError(
            "conflict",
            "Change who can read and write a collection only while it is empty",
            { reason: "access_mode_locked" },
          );
        const [row] = await rawRows<CollectionRow>(
          tx,
          sql`update site_data_collections set
              access_mode = ${definition.accessMode},
              private_records = ${definition.privateRecords},
              json_schema = ${definition.jsonSchema === null ? null : JSON.stringify(definition.jsonSchema)}::jsonb,
              indexed_fields = ${JSON.stringify(definition.indexedFields)}::jsonb,
              unique_fields = ${JSON.stringify(definition.uniqueFields)}::jsonb,
              updated_by = ${caller.actor},
              updated_at = now()
            where workspace_id = ${caller.workspaceId} and id = ${existing.id}
            returning *`,
        );
        const updated = toCollection(row!);
        const valuesChanged =
          JSON.stringify(existing.indexedFields) !== JSON.stringify(updated.indexedFields) ||
          JSON.stringify(existing.uniqueFields) !== JSON.stringify(updated.uniqueFields);
        if (valuesChanged && existing.recordCount > 0) {
          // Re-derive every record's values in set-based statements.
          await tx.execute(
            sql`delete from site_data_record_values where workspace_id = ${caller.workspaceId} and collection_id = ${existing.id}`,
          );
          const conflict = await syncValues(
            tx,
            caller,
            updated,
            sql`r.workspace_id = ${caller.workspaceId} and r.collection_id = ${existing.id}`,
          );
          if (conflict)
            throw uniqueConflict(conflict, "Existing records repeat %s, so it cannot be unique");
        }
        return { collection: updated, created: false };
      });
    },

    async deleteCollection(caller, name) {
      if (caller.role !== "manager" || caller.framed)
        throw new SiteDataError("forbidden", "Only the Site's managers can delete collections");
      return scoped(caller, async (tx) => {
        await lockUsage(tx, caller);
        const collection = await requireCollection(tx, caller, name);
        await tx.execute(
          sql`delete from site_data_collections where workspace_id = ${caller.workspaceId} and id = ${collection.id}`,
        );
        await applyUsage(tx, caller, {
          collections: -1,
          records: -collection.recordCount,
          recordBytes: -collection.recordBytes,
        });
        return { deletedRecords: collection.recordCount };
      });
    },

    async resetCollection(caller, name) {
      if (caller.role !== "manager" || caller.framed)
        throw new SiteDataError("forbidden", "Only the Site's managers can clear collections");
      return scoped(caller, async (tx) => {
        await lockUsage(tx, caller);
        const collection = await requireCollection(tx, caller, name);
        await tx.execute(
          sql`delete from site_data_records where workspace_id = ${caller.workspaceId} and collection_id = ${collection.id}`,
        );
        await tx.execute(
          sql`update site_data_collections set record_count = 0, record_bytes = 0
            where workspace_id = ${caller.workspaceId} and id = ${collection.id}`,
        );
        await applyUsage(tx, caller, {
          records: -collection.recordCount,
          recordBytes: -collection.recordBytes,
        });
        return { deletedRecords: collection.recordCount };
      });
    },

    async query(caller, query) {
      return scoped(caller, async (tx) => {
        const collection = await requireCollection(tx, caller, query.collection);
        const reach = siteDataReadReach(collection, caller.role);
        const scope =
          query.scope ??
          (caller.framed && siteDataScopedPerViewer(collection.accessMode) ? "own" : "all");
        const own = reach === "own" || scope === "own";
        const where = query.where ?? [];
        if (!Array.isArray(where) || where.length > SITE_DATA_MAX_FILTERS)
          throw validationError(`Use at most ${SITE_DATA_MAX_FILTERS} filters`);
        const conditions: SQL[] = [
          sql`r.workspace_id = ${caller.workspaceId}`,
          sql`r.collection_id = ${collection.id}`,
          ...(own ? [sql`r.owner_principal = ${caller.principal}`] : []),
          ...where.map((filter) => {
            if (!filter || typeof filter.field !== "string")
              throw validationError("Each filter needs a field and an op");
            assertFilterValue(filter);
            return filter.field.startsWith("$")
              ? systemFilter(caller, filter)
              : dataFilter(collection, filter);
          }),
        ];
        const sorts = query.sort?.length
          ? query.sort
          : [{ field: "$createdAt", direction: "desc" as const }];
        if (!Array.isArray(sorts) || sorts.length > SITE_DATA_MAX_SORT_KEYS)
          throw validationError(`Sort by at most ${SITE_DATA_MAX_SORT_KEYS} fields`);
        const keys = sorts.filter((sort) => sort.field !== "$id").map(sortKey);
        const lastDirection =
          keys.at(-1)?.direction ?? (sorts[0]?.direction === "desc" ? "desc" : "asc");
        const signature = JSON.stringify([
          ...keys.map((key) => [key.field, key.direction]),
          lastDirection,
        ]);
        const limit = Math.min(
          Math.max(
            1,
            Math.trunc(Number(query.limit ?? SITE_DATA_DEFAULT_PAGE)) || SITE_DATA_DEFAULT_PAGE,
          ),
          SITE_DATA_MAX_PAGE,
        );
        const filtered = sql.join(conditions, sql` and `);
        const paging: SQL[] = [];
        if (query.cursor) {
          const cursor = decodeCursor(query.cursor, signature);
          if (cursor.v.length !== keys.length)
            throw validationError("Invalid cursor for this query");
          const all = [
            ...keys.map((key, index) => ({
              expr: key.expr,
              direction: key.direction,
              value: key.cursor(cursor.v[index]),
            })),
            { expr: sql`r.id`, direction: lastDirection, value: sql`${cursor.id}::uuid` },
          ];
          const branches = all.map((key, index) =>
            sql.join(
              [
                ...all.slice(0, index).map((prior) => sql`${prior.expr} = ${prior.value}`),
                sql`${key.expr} ${sql.raw(key.direction === "desc" ? "<" : ">")} ${key.value}`,
              ],
              sql` and `,
            ),
          );
          paging.push(
            sql`(${sql.join(
              branches.map((branch) => sql`(${branch})`),
              sql` or `,
            )})`,
          );
        }
        const order = sql.join(
          [
            ...keys.map((key) => sql`${key.expr} ${sql.raw(key.direction)}`),
            sql`r.id ${sql.raw(lastDirection)}`,
          ],
          sql`, `,
        );
        const cursorValues = keys.length
          ? sql`jsonb_build_array(${sql.join(
              keys.map((key) => sql`to_jsonb(${key.expr})`),
              sql`, `,
            )})`
          : sql`'[]'::jsonb`;
        const rows = await withCursorErrors(Boolean(query.cursor), () =>
          rawRows<RecordRow>(
            tx,
            sql`select r.*, ${cursorValues} as cursor_values from site_data_records r
              where ${filtered} ${paging.length ? sql`and ${paging[0]}` : sql``}
              order by ${order}
              limit ${limit + 1}`,
          ),
        );
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const result: SiteDataQueryResult = {
          records: page.map(toRecord),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor(signature, (last.cursor_values ?? []) as unknown[], last.id)
              : null,
        };
        if (query.count) {
          // An unfiltered count of everything readable uses the maintained counter.
          if (where.length === 0 && !own) result.count = collection.recordCount;
          else {
            const [counted] = await rawRows<{ count: string | number }>(
              tx,
              sql`select count(*) as count from site_data_records r where ${filtered}`,
            );
            result.count = num(counted?.count);
          }
        }
        return result;
      });
    },

    async get(caller, name, ref) {
      return scoped(caller, async (tx) => {
        const collection = await requireCollection(tx, caller, name);
        const row = await findRecord(tx, caller, collection, ref, false);
        return row && readable(caller, collection, row) ? toRecord(row) : null;
      });
    },

    async write(caller, ops, options) {
      if (!Array.isArray(ops) || ops.length === 0)
        throw validationError("Give at least one operation");
      if (ops.length > SITE_DATA_MAX_BATCH)
        throw validationError(`A batch has at most ${SITE_DATA_MAX_BATCH} operations`);
      return scoped(caller, async (tx) => {
        const usage = await lockUsage(tx, caller);
        await assertWritableSite(tx, caller);
        const collections = new Map<string, SiteDataCollection>();
        const collectionFor = async (name: string) => {
          const cached = collections.get(name);
          if (cached) return cached;
          const loaded = await requireCollection(tx, caller, name);
          collections.set(name, loaded);
          return loaded;
        };
        const summary: SiteDataWriteSummary = {
          operations: ops.length,
          bytesWritten: 0,
          recordDelta: 0,
          byteDelta: 0,
        };
        const perCollection = new Map<string, { records: number; bytes: number }>();
        const account = (collection: SiteDataCollection, records: number, bytes: number) => {
          const current = perCollection.get(collection.id) ?? { records: 0, bytes: 0 };
          current.records += records;
          current.bytes += bytes;
          perCollection.set(collection.id, current);
          summary.recordDelta += records;
          summary.byteDelta += bytes;
        };
        const results: SiteDataWriteResultItem[] = [];

        const prepare = (collection: SiteDataCollection, data: unknown, index: number) => {
          if (!isPlainJsonObject(data))
            throw validationError("Record data must be a JSON object", { index });
          const size = recordBytes(data);
          if (size > options.limits.maxRecordBytes)
            throw new SiteDataError(
              "quota_exceeded",
              `A record can be at most ${Math.floor(options.limits.maxRecordBytes / 1024)} KB`,
              { quota: "record_bytes", limit: options.limits.maxRecordBytes, index },
            );
          if (collection.jsonSchema && options.validate) {
            const problem = options.validate(collection.jsonSchema, data);
            if (problem)
              throw validationError(`Record does not match the collection schema: ${problem}`, {
                index,
              });
          }
          return size;
        };
        const storeValues = async (
          collection: SiteDataCollection,
          recordId: string,
          replacing: boolean,
          index: number,
        ) => {
          if (collection.uniqueFields.length === 0 && collection.indexedFields.length === 0) return;
          if (replacing) await deleteValues(tx, caller, recordId);
          const conflict = await syncValues(
            tx,
            caller,
            collection,
            sql`r.workspace_id = ${caller.workspaceId} and r.id = ${recordId}`,
          );
          if (conflict)
            throw uniqueConflict(conflict, "Another record already has this %s", { index });
        };
        const insertRecord = async (
          collection: SiteDataCollection,
          key: string | null,
          data: Record<string, unknown>,
          index: number,
        ) => {
          if (!siteDataMayCreate(collection, caller.role))
            throw new SiteDataError(
              "forbidden",
              `Only the Site's managers can add to ${collection.name}`,
              { index },
            );
          const size = prepare(collection, data, index);
          const keyScope = siteDataScopedPerViewer(collection.accessMode) ? caller.principal : "";
          if (key !== null) {
            const existing = await findRecord(tx, caller, collection, { key }, false);
            if (existing)
              throw new SiteDataError("conflict", `A record with key ${key} already exists`, {
                reason: "key_exists",
                index,
              });
          }
          const [row] = await rawRows<RecordRow>(
            tx,
            sql`insert into site_data_records
                (account_id, workspace_id, site_id, collection_id, key_scope, record_key, data,
                 owner_principal, created_by, updated_by, size_bytes)
              values (${caller.accountId}, ${caller.workspaceId}, ${caller.siteId}, ${collection.id},
                ${keyScope}, ${key}, ${JSON.stringify(data)}::jsonb, ${caller.principal},
                ${caller.actor}, ${caller.actor}, ${size})
              returning *`,
          );
          await storeValues(collection, row!.id, false, index);
          summary.bytesWritten += size;
          account(collection, 1, siteDataChargedBytes(size));
          return toRecord(row!);
        };
        const targetFor = async (
          collection: SiteDataCollection,
          ref: SiteDataRecordRef,
          index: number,
        ) => {
          const row = await findRecord(tx, caller, collection, ref, true);
          if (!row || !readable(caller, collection, row)) return null;
          const modify = siteDataModifyReach(collection, caller.role);
          if (modify === "none" || (modify === "own" && row.owner_principal !== caller.principal))
            throw new SiteDataError(
              "forbidden",
              `You cannot change records in ${collection.name}`,
              {
                index,
              },
            );
          return row;
        };
        const checkVersion = (
          row: RecordRow | null,
          expected: number | undefined,
          index: number,
        ) => {
          if (expected === undefined) return;
          if (!Number.isInteger(expected) || expected < 0)
            throw validationError("expectedVersion must be a non-negative integer", { index });
          const actual = row?.version ?? 0;
          if (actual !== expected)
            throw new SiteDataError(
              "conflict",
              expected === 0 ? "The record already exists" : "The record changed since you read it",
              { reason: "version", expectedVersion: expected, currentVersion: actual, index },
            );
        };
        const replaceRecord = async (
          collection: SiteDataCollection,
          row: RecordRow,
          data: Record<string, unknown>,
          index: number,
        ) => {
          const size = prepare(collection, data, index);
          const [updated] = await rawRows<RecordRow>(
            tx,
            sql`update site_data_records set data = ${JSON.stringify(data)}::jsonb,
                size_bytes = ${size}, version = version + 1, updated_by = ${caller.actor}, updated_at = now()
              where workspace_id = ${caller.workspaceId} and id = ${row.id}
              returning *`,
          );
          await storeValues(collection, row.id, true, index);
          summary.bytesWritten += size;
          account(collection, 0, size - row.size_bytes);
          return toRecord(updated!);
        };
        const keyOf = (key: unknown, index: number): string | null => {
          if (key === undefined || key === null) return null;
          if (typeof key !== "string" || key.length === 0 || key.length > SITE_DATA_MAX_KEY_LENGTH)
            throw validationError(`Record keys are 1 to ${SITE_DATA_MAX_KEY_LENGTH} characters`, {
              index,
            });
          return key;
        };
        const refOf = (op: SiteDataRecordRef, index: number): SiteDataRecordRef => {
          if (op.id !== undefined) return { id: op.id };
          if (op.key !== undefined) return { key: keyOf(op.key, index)! };
          throw validationError("Give a record id or key", { index });
        };

        for (const [index, op] of ops.entries()) {
          if (!op || typeof op !== "object") throw validationError("Invalid operation", { index });
          const collection = await collectionFor(op.collection);
          switch (op.op) {
            case "insert": {
              results.push({
                op: "insert",
                record: await insertRecord(collection, keyOf(op.key, index), op.data, index),
              });
              break;
            }
            case "put": {
              const key = keyOf(op.key, index);
              if (key === null) throw validationError("put needs a key", { index });
              const row = await findRecord(tx, caller, collection, { key }, true);
              const visible = row && readable(caller, collection, row) ? row : null;
              if (row && !visible)
                throw new SiteDataError("conflict", `A record with key ${key} already exists`, {
                  reason: "key_exists",
                  index,
                });
              checkVersion(visible, op.expectedVersion, index);
              if (visible) {
                const target = await targetFor(collection, { id: visible.id }, index);
                results.push({
                  op: "put",
                  record: await replaceRecord(collection, target!, op.data, index),
                });
              } else {
                results.push({
                  op: "put",
                  record: await insertRecord(collection, key, op.data, index),
                });
              }
              break;
            }
            case "patch": {
              const row = await targetFor(collection, refOf(op, index), index);
              if (!row) throw new SiteDataError("not_found", "Record not found", { index });
              checkVersion(row, op.expectedVersion, index);
              if (!isPlainJsonObject(op.data))
                throw validationError("Patch data must be a JSON object", { index });
              results.push({
                op: "patch",
                record: await replaceRecord(collection, row, { ...row.data, ...op.data }, index),
              });
              break;
            }
            case "delete": {
              const row = await targetFor(collection, refOf(op, index), index);
              if (!row) throw new SiteDataError("not_found", "Record not found", { index });
              checkVersion(row, op.expectedVersion, index);
              await tx.execute(
                sql`delete from site_data_records where workspace_id = ${caller.workspaceId} and id = ${row.id}`,
              );
              account(collection, -1, -siteDataChargedBytes(row.size_bytes));
              results.push({ op: "delete", deleted: { id: row.id } });
              break;
            }
            case "increment": {
              const segments = parseSiteDataPath(op.field);
              if (!segments) throw validationError(`Invalid field: ${String(op.field)}`, { index });
              const by = op.by ?? 1;
              if (typeof by !== "number" || !Number.isFinite(by))
                throw validationError("increment needs a finite number", { index });
              const ref = refOf(op, index);
              const row = await targetFor(collection, ref, index);
              if (!row) {
                if (ref.key === undefined)
                  throw new SiteDataError("not_found", "Record not found", { index });
                results.push({
                  op: "increment",
                  record: await insertRecord(
                    collection,
                    ref.key,
                    writeSiteDataPath({}, segments, by),
                    index,
                  ),
                });
                break;
              }
              const current = readSiteDataPath(row.data, segments);
              if (current !== undefined && current !== null && typeof current !== "number")
                throw validationError(`${op.field} is not a number`, { index });
              results.push({
                op: "increment",
                record: await replaceRecord(
                  collection,
                  row,
                  writeSiteDataPath(row.data, segments, (current ?? 0) + by),
                  index,
                ),
              });
              break;
            }
            default:
              throw validationError(`Unknown operation: ${String((op as { op?: unknown }).op)}`, {
                index,
              });
          }
        }
        for (const collection of collections.values()) {
          const delta = perCollection.get(collection.id);
          if (!delta) continue;
          if (
            delta.records > 0 &&
            collection.recordCount + delta.records > options.limits.maxRecordsPerCollection
          )
            throw new SiteDataError(
              "quota_exceeded",
              `A collection can have at most ${options.limits.maxRecordsPerCollection} records`,
              {
                quota: "collection_records",
                limit: options.limits.maxRecordsPerCollection,
                collection: collection.name,
              },
            );
          await tx.execute(
            sql`update site_data_collections set
                record_count = greatest(0, record_count + ${delta.records}),
                record_bytes = greatest(0, record_bytes + ${delta.bytes})
              where workspace_id = ${caller.workspaceId} and id = ${collection.id}`,
          );
        }
        if (summary.byteDelta > 0) {
          if (usage.recordBytes + summary.byteDelta > options.limits.recordBytesPerSite)
            throw new SiteDataError(
              "quota_exceeded",
              "This Site's records are full. Delete records to make room.",
              { quota: "site_record_bytes", limit: options.limits.recordBytesPerSite },
            );
          if (
            (await workspaceBytes(tx, caller)) + summary.byteDelta >
            options.limits.workspaceBytes
          )
            throw new SiteDataError(
              "quota_exceeded",
              "This workspace's Site data is full. Delete records or files to make room.",
              { quota: "workspace_bytes", limit: options.limits.workspaceBytes },
            );
        }
        await applyUsage(tx, caller, {
          records: summary.recordDelta,
          recordBytes: summary.byteDelta,
        });
        await options.afterWrite?.(tx, summary);
        return { results, summary };
      });
    },

    async listFiles(caller, options = {}) {
      return scoped(caller, async (tx) => {
        const limit = Math.min(
          Math.max(1, Math.trunc(options.limit ?? 100) || 100),
          SITE_DATA_MAX_PAGE,
        );
        let after: SQL | null = null;
        if (options.cursor) {
          const decoded = decodeCursor(options.cursor, "files");
          after = sql`(f.created_at, f.id) < (${cursorTimestamp(decoded.v[0])}, ${decoded.id}::uuid)`;
        }
        const rows = await withCursorErrors(Boolean(after), () =>
          rawRows<FileRow & { cursor_at: string }>(
            tx,
            sql`select f.*, to_jsonb(f.created_at) #>> '{}' as cursor_at from site_data_files f
              where f.workspace_id = ${caller.workspaceId} and f.site_id = ${caller.siteId}
                ${caller.role === "manager" ? sql`` : sql`and (f.scope = 'shared' or f.owner_principal = ${caller.principal})`}
                ${after ? sql`and ${after}` : sql``}
              order by f.created_at desc, f.id desc
              limit ${limit + 1}`,
          ),
        );
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          files: page.map((row) => publicSiteDataFile(toFile(row))),
          nextCursor:
            rows.length > limit && last ? encodeCursor("files", [last.cursor_at], last.id) : null,
        };
      });
    },

    async getFile(caller, fileId) {
      if (!UUID.test(fileId)) return null;
      return scoped(caller, async (tx) => {
        const [row] = await rawRows<FileRow>(
          tx,
          sql`select * from site_data_files
            where workspace_id = ${caller.workspaceId} and site_id = ${caller.siteId} and id = ${fileId}`,
        );
        if (!row) return null;
        if (
          caller.role !== "manager" &&
          row.scope === "private" &&
          row.owner_principal !== caller.principal
        )
          return null;
        return toFile(row);
      });
    },

    async checkFileQuota(caller, sizeBytes, limits) {
      await scoped(caller, async (tx) => {
        const [row] = await rawRows<UsageRow>(
          tx,
          sql`select collection_count, record_count, record_bytes, file_count, file_bytes
            from site_data_usage where workspace_id = ${caller.workspaceId} and site_id = ${caller.siteId}`,
        );
        await fileQuota(tx, caller, { fileBytes: num(row?.file_bytes) }, sizeBytes, limits);
      });
    },

    async insertFile(caller, file, options) {
      return scoped(caller, async (tx) => {
        const usage = await lockUsage(tx, caller);
        await assertWritableSite(tx, caller);
        await fileQuota(tx, caller, usage, file.sizeBytes, options.limits);
        const [row] = await rawRows<FileRow>(
          tx,
          sql`insert into site_data_files
              (id, account_id, workspace_id, site_id, name, content_type, size_bytes, sha256, object_key,
               scope, owner_principal, created_by)
            values (${file.id}, ${caller.accountId}, ${caller.workspaceId}, ${caller.siteId}, ${file.name},
              ${file.contentType}, ${file.sizeBytes}, ${file.sha256}, ${file.objectKey}, ${file.scope},
              ${caller.principal}, ${caller.actor})
            returning *`,
        );
        await applyUsage(tx, caller, { files: 1, fileBytes: file.sizeBytes });
        await options.afterWrite?.(tx, {
          operations: 1,
          bytesWritten: file.sizeBytes,
          recordDelta: 0,
          byteDelta: file.sizeBytes,
        });
        return publicSiteDataFile(toFile(row!));
      });
    },

    async deleteFile(caller, fileId) {
      if (!UUID.test(fileId)) throw new SiteDataError("not_found", "File not found");
      return scoped(caller, async (tx) => {
        await lockUsage(tx, caller);
        await assertWritableSite(tx, caller);
        const [row] = await rawRows<FileRow>(
          tx,
          sql`select * from site_data_files
            where workspace_id = ${caller.workspaceId} and site_id = ${caller.siteId} and id = ${fileId}
            for update`,
        );
        const visible =
          row &&
          (caller.role === "manager" ||
            row.scope === "shared" ||
            row.owner_principal === caller.principal);
        if (!row || !visible) throw new SiteDataError("not_found", "File not found");
        if (caller.role !== "manager" && row.owner_principal !== caller.principal)
          throw new SiteDataError(
            "forbidden",
            "Only the uploader or the Site's managers can delete this file",
          );
        await tx.execute(
          sql`delete from site_data_files where workspace_id = ${caller.workspaceId} and id = ${fileId}`,
        );
        await applyUsage(tx, caller, { files: -1, fileBytes: -num(row.size_bytes) });
        return toFile(row);
      });
    },
  };
  return store;
}

/**
 * The Site as a Site Data caller sees it: visible to the viewer by audience
 * (workspace Sites, or their own Only me Sites), or null.
 */
export async function getSiteDataSite(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  viewer: { subjectId: string | null },
  siteId: string,
): Promise<SiteDataSite | null> {
  if (!UUID.test(siteId)) return null;
  return withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{
      id: string;
      title: string;
      status: "active" | "archived";
      visibility: "workspace_shared" | "user_private";
      owner_subject_id: string | null;
      created_by_subject_id: string | null;
    }>(
      tx,
      sql`select id, title, status, visibility, owner_subject_id, created_by_subject_id from workspace_artifacts
        where workspace_id = ${scope.workspaceId} and id = ${siteId}
          and (visibility = 'workspace_shared'
            ${viewer.subjectId === null ? sql`` : sql`or owner_subject_id = ${viewer.subjectId}`})`,
    );
    return row
      ? {
          id: row.id,
          title: row.title,
          status: row.status,
          visibility: row.visibility,
          ownerSubjectId: row.owner_subject_id,
          createdBySubjectId: row.created_by_subject_id,
        }
      : null;
  });
}

/** What Site Data needs to know about the session an agent acts in. */
export type SiteDataAgentSession = {
  /**
   * Distinct Site origins on the session, its spawning ancestors and its
   * root session (read directly, so a lineage too deep to walk still finds it).
   */
  originSiteIds: string[];
  /** Whether the current turn or a spawning ancestor turn arrived from a Site page. */
  siteTurn: boolean;
  /** The scheduled task whose run created this exact session, if any. */
  scheduledTaskId: string | null;
  /**
   * False when the lineage could not be read in full: the session or an
   * ancestor is missing, or the walk stopped at its depth cap with a parent
   * still above. Callers must then fail closed.
   */
  complete: boolean;
};

/** Spawning ancestors the lineage walk reads before it reports itself incomplete. */
export const SITE_DATA_AGENT_LINEAGE_MAX_DEPTH = 32;

/**
 * Walk an agent's session up its spawning lineage (parent session and the
 * exact parent turn), collecting Site origins and Site-surface turns, and
 * find the scheduled task that created the session (from the server-written
 * run row, never from session metadata a caller could set).
 */
export async function getSiteDataAgentSession(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  sessionId: string,
  turnId: string | null,
): Promise<SiteDataAgentSession> {
  const unknown: SiteDataAgentSession = {
    originSiteIds: [],
    siteTurn: false,
    scheduledTaskId: null,
    complete: false,
  };
  if (!UUID.test(sessionId)) return unknown;
  const turn = turnId && UUID.test(turnId) ? turnId : null;
  return withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{
      depth: number;
      found: boolean;
      parent_session_id: string | null;
      origin_site_id: string | null;
      turn_surface: string | null;
    }>(
      tx,
      sql`with recursive chain(session_id, turn_id, depth) as (
            select ${sessionId}::uuid, ${turn}::uuid, 0
            union all
            select s.parent_session_id, s.parent_turn_id, chain.depth + 1
              from chain
              join sessions s on s.workspace_id = ${scope.workspaceId} and s.id = chain.session_id
             where s.parent_session_id is not null
               and chain.depth < ${SITE_DATA_AGENT_LINEAGE_MAX_DEPTH}
          )
          select chain.depth, s.id is not null as found, s.parent_session_id,
                 s.metadata->'_opengeniSiteOrigin'->>'siteId' as origin_site_id,
                 t.surface as turn_surface
            from chain
            left join sessions s on s.workspace_id = ${scope.workspaceId} and s.id = chain.session_id
            left join session_turns t on t.workspace_id = ${scope.workspaceId}
              and t.session_id = chain.session_id and t.id = chain.turn_id
           order by chain.depth`,
    );
    if (!rows[0]?.found) return unknown;
    const deepest = rows[rows.length - 1]!;
    const complete = rows.every((row) => row.found) && deepest.parent_session_id === null;
    const [root] = await rawRows<{ origin_site_id: string | null }>(
      tx,
      sql`select r.metadata->'_opengeniSiteOrigin'->>'siteId' as origin_site_id
            from sessions s
            join sessions r on r.workspace_id = s.workspace_id and r.id = s.root_session_id
           where s.workspace_id = ${scope.workspaceId} and s.id = ${sessionId}`,
    );
    const [run] = await rawRows<{ task_id: string }>(
      tx,
      sql`select task_id from scheduled_task_runs
           where workspace_id = ${scope.workspaceId} and session_id = ${sessionId}
           limit 1`,
    );
    return {
      originSiteIds: [
        ...new Set(
          [...rows, ...(root ? [root] : [])].flatMap((row) =>
            row.origin_site_id ? [row.origin_site_id] : [],
          ),
        ),
      ],
      siteTurn: rows.some((row) => row.turn_surface === "site"),
      scheduledTaskId: run?.task_id ?? null,
      complete,
    };
  });
}

export const SITE_DATA_MAX_BATCH_OPERATIONS = SITE_DATA_MAX_BATCH;
