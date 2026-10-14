import type { ApiRouteDeps } from "@opengeni/core";
import type {
  AccessGrant,
  SiteDataCollectionDefinitionRequest,
  SiteDataDescribeResponse,
  SiteDataFileScope,
  SiteDataImportRequest,
  SiteDataQueryRequest,
  SiteDataWriteOperation,
} from "@opengeni/contracts";
import {
  parseSiteDataPath,
  readSiteDataPath,
  SiteDataError,
  SITE_DATA_MAX_BATCH,
  type SiteDataFile,
  type SiteDataRecord,
  type SiteDataTouchedRecord,
  type SiteDataValidationReservation,
  type SiteDataWriteOp,
} from "@opengeni/db";
import { userContentSignedGetUrlOptions } from "../http/user-content";
import {
  assertSiteDataSchema,
  meterSiteData,
  publicSiteDataLimits,
  resolveSiteDataAccess,
  sha256Hex,
  prevalidateSiteDataWrite,
  siteDataFileContentType,
  siteDataFileName,
  siteDataObjectKey,
  siteDataValidationBytes,
  siteDataValidationClock,
  siteDataValidationReservationMs,
  SITE_DATA_VALIDATION_BUDGET_MS,
  SITE_DATA_VALIDATION_RESERVE_MS_PER_BYTE,
  type SiteDataAccess,
  type SiteDataDeps,
  type SiteDataSurface,
  type SiteDataValidationMeter,
} from "./service";

/** Shared Site Data operations for HTTP routes, the Site bridge and agent tools. */

export const SITE_DATA_EXPORT_MAX_RECORDS = 10_000;
export const SITE_DATA_IMPORT_MAX_RECORDS = 1_000;
/** CSV imports accept at most this many columns. */
export const SITE_DATA_IMPORT_MAX_COLUMNS = 1_000;
/** CSV exports name at most this many data columns; wider data goes in one JSON column. */
export const SITE_DATA_EXPORT_MAX_COLUMNS = 200;
/** Exports stop adding records past this many bytes and report truncation. */
export const SITE_DATA_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const FILE_URL_SECONDS = 300;

/**
 * Count an attempt before any work, in its own transaction, so failed and
 * refused attempts count too. Writes always count: viewers and Site frames
 * per person and per Site, managers in one generous window per Site. Reads
 * count only for Site frames.
 *
 * A write that will validate (`validates`: the collections whose records it
 * checks, or a schema it defines, and the bytes of JSON it will check) also
 * reserves validation time sized to those bytes, capped at the request
 * budget, on the Site's and workspace's validation windows in the same
 * transaction; it returns the reservation, for meteredWrite to settle.
 */
async function consume(
  access: SiteDataAccess,
  kind: "write" | "read",
  operations: number,
  validates?: {
    collections?: readonly string[];
    schema?: boolean;
    bytes: number;
    touched?: readonly SiteDataTouchedRecord[];
  },
): Promise<SiteDataValidationReservation> {
  if (kind === "read" && !access.caller.framed) return NOTHING_RESERVED;
  return access.store.consumeRate(
    access.caller,
    kind,
    Math.max(1, operations),
    access.limits,
    validates
      ? {
          ...(validates.collections ? { collections: validates.collections } : {}),
          ...(validates.schema !== undefined ? { schema: validates.schema } : {}),
          reserveMs: siteDataValidationReservationMs(validates.bytes),
          ...(validates.touched?.length
            ? {
                touched: validates.touched,
                reserveMsPerStoredByte: SITE_DATA_VALIDATION_RESERVE_MS_PER_BYTE,
                maxReserveMs: SITE_DATA_VALIDATION_BUDGET_MS,
              }
            : {}),
        }
      : undefined,
  );
}

const NOTHING_RESERVED: SiteDataValidationReservation = { reservedMs: 0, windowStartedAt: null };

/** The record data these operations carry to be validated. */
function* validatedData(operations: readonly unknown[]): Iterable<unknown> {
  for (const op of operations)
    if (
      op !== null &&
      typeof op === "object" &&
      ["insert", "put", "patch"].includes(String((op as { op?: unknown }).op))
    )
      yield (op as { data?: unknown }).data;
}

/** The stored records patches and increments merge into and validate whole. */
function mergedRecords(operations: readonly unknown[]): SiteDataTouchedRecord[] {
  const touched: SiteDataTouchedRecord[] = [];
  for (const op of operations) {
    if (op === null || typeof op !== "object") continue;
    const { op: kind, collection, id, key } = op as Record<string, unknown>;
    if ((kind !== "patch" && kind !== "increment") || typeof collection !== "string") continue;
    if (typeof id === "string") touched.push({ collection, id });
    else if (typeof key === "string") touched.push({ collection, key });
  }
  return touched;
}

/** Collections whose records these operations validate. */
function validatedCollections(operations: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const op of operations)
    if (
      op !== null &&
      typeof op === "object" &&
      typeof (op as { collection?: unknown }).collection === "string" &&
      ["insert", "put", "patch", "increment"].includes(String((op as { op?: unknown }).op))
    )
      names.add((op as { collection: string }).collection);
  return [...names];
}

/**
 * Settle the validation time a request reserved against what it spent,
 * whatever its outcome: refund or charge the difference on the validation
 * windows and add operations for the time spent to the caller's write
 * windows. Nothing reserved and nothing spent touches nothing. A failure to
 * settle is logged, never reported in place of the request's own result.
 */
async function settleValidation(
  access: SiteDataAccess,
  reservation: SiteDataValidationReservation,
  meter: SiteDataValidationMeter,
) {
  if (!(reservation.reservedMs > 0) && !(meter.ms > 0)) return;
  try {
    await access.store.settleValidation(
      access.caller,
      { ...reservation, spentMs: meter.ms },
      access.limits,
    );
  } catch (error) {
    console.warn("[site-data] could not settle validation time", {
      siteId: access.caller.siteId,
      reservedMs: reservation.reservedMs,
      validationMs: meter.ms,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Run a write whose validation time is metered, then settle it against the
 * reservation, including for refused and failed writes.
 */
async function meteredWrite<T>(
  access: SiteDataAccess,
  reservation: SiteDataValidationReservation,
  run: (meter: SiteDataValidationMeter) => Promise<T>,
): Promise<T> {
  const meter: SiteDataValidationMeter = { ms: 0 };
  try {
    return await run(meter);
  } finally {
    await settleValidation(access, reservation, meter);
  }
}

function logCleanupFailure(what: string, objectKey: string, error: unknown): void {
  console.warn(`[site-data] ${what} left an unreachable object`, {
    objectKey,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function describeSiteData(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
): Promise<SiteDataDescribeResponse> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  const described = await access.store.describe(access.caller);
  return { siteId, ...described, limits: publicSiteDataLimits(access.limits) };
}

export async function defineSiteDataCollection(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  name: string,
  definition: SiteDataCollectionDefinitionRequest,
) {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  const hasSchema = definition.jsonSchema !== undefined && definition.jsonSchema !== null;
  const reserved = await consume(access, "write", 1, {
    schema: hasSchema,
    bytes: hasSchema ? siteDataValidationBytes([definition.jsonSchema]) : 0,
  });
  // Only a schema is checked and metered; defining without one touches no
  // validation window.
  if (hasSchema)
    await meteredWrite(access, reserved, async (meter) => {
      const started = siteDataValidationClock.now();
      try {
        assertSiteDataSchema(definition.jsonSchema);
      } finally {
        meter.ms += Math.max(0, siteDataValidationClock.now() - started);
      }
    });
  return access.store.defineCollection(
    access.caller,
    {
      name,
      accessMode: definition.accessMode,
      ...(definition.privateRecords === undefined
        ? {}
        : { privateRecords: definition.privateRecords }),
      ...(definition.jsonSchema === undefined ? {} : { jsonSchema: definition.jsonSchema }),
      ...(definition.indexedFields ? { indexedFields: definition.indexedFields } : {}),
      ...(definition.uniqueFields ? { uniqueFields: definition.uniqueFields } : {}),
    },
    access.limits,
  );
}

export async function deleteSiteDataCollection(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  name: string,
) {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  await consume(access, "write", 1);
  return access.store.deleteCollection(access.caller, name);
}

export async function resetSiteDataCollection(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  name: string,
) {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  await consume(access, "write", 1);
  return access.store.resetCollection(access.caller, name);
}

export async function querySiteData(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  query: SiteDataQueryRequest,
  surface: SiteDataSurface = {},
) {
  const access = await resolveSiteDataAccess(deps, grant, siteId, surface);
  await consume(access, "read", 1);
  return access.store.query(access.caller, {
    collection: query.collection,
    ...(query.where ? { where: query.where } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.count ? { count: true } : {}),
    ...(query.scope ? { scope: query.scope } : {}),
  });
}

export async function getSiteDataRecord(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  request: { collection: string; id?: string | undefined; key?: string | undefined },
  surface: SiteDataSurface = {},
): Promise<SiteDataRecord | null> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, surface);
  await consume(access, "read", 1);
  return access.store.get(
    access.caller,
    request.collection,
    request.id !== undefined ? { id: request.id } : { key: request.key! },
  );
}

export async function writeSiteData(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  operations: SiteDataWriteOperation[],
  surface: SiteDataSurface = {},
) {
  const access = await resolveSiteDataAccess(deps, grant, siteId, surface);
  const reserved = await consume(access, "write", operations.length, {
    collections: validatedCollections(operations),
    bytes: siteDataValidationBytes(validatedData(operations)),
    touched: mergedRecords(operations),
  });
  return meteredWrite(access, reserved, async (meter) => {
    const options = await prevalidateSiteDataWrite(access, operations, {
      meter,
      reservedMs: reserved.reservedMs,
    });
    return access.store.write(access.caller, operations as SiteDataWriteOp[], options);
  });
}

// --- import and export -------------------------------------------------------

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF rows. */
/**
 * Parse CSV text into rows (the first is the header). Optional limits stop
 * parsing as soon as a row has too many cells or there are too many records,
 * before any record is built.
 */
export function parseSiteDataCsv(
  text: string,
  limits: { maxColumns?: number; maxRecords?: number } = {},
): string[][] {
  const maxColumns = limits.maxColumns ?? Number.POSITIVE_INFINITY;
  // One header row plus the records.
  const maxRows = (limits.maxRecords ?? Number.POSITIVE_INFINITY) + 1;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const pushField = () => {
    if (row.length >= maxColumns)
      throw new SiteDataError("validation", `The CSV has more than ${maxColumns} columns in a row`);
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    if (!row.some((value) => value !== "")) return;
    if (rows.length >= maxRows)
      throw new SiteDataError("validation", `Import at most ${maxRows - 1} records at a time`);
    rows.push(row);
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === ",") pushField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushField();
      pushRow();
      row = [];
    } else field += char;
  }
  if (quoted) throw new SiteDataError("validation", "The CSV has an unterminated quoted field");
  pushField();
  pushRow();
  return rows;
}

/**
 * Build one record from CSV cells in a single mutable null-prototype object:
 * linear in the number of cells, never copying the row per cell. Paths are
 * validated field names, so no segment can reach a prototype.
 */
function siteDataCsvRecord(paths: readonly string[][], cells: readonly string[]) {
  const define = (target: Record<string, unknown>, key: string, value: unknown) =>
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  const record = Object.create(null) as Record<string, unknown>;
  paths.forEach((segments, column) => {
    let current = record;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      const next = Object.hasOwn(current, segment) ? current[segment] : undefined;
      if (typeof next === "object" && next !== null && !Array.isArray(next))
        current = next as Record<string, unknown>;
      else {
        const child = Object.create(null) as Record<string, unknown>;
        define(current, segment, child);
        current = child;
      }
    }
    define(current, segments[segments.length - 1]!, cells[column] ?? "");
  });
  return record;
}

export function siteDataCsvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  // Spreadsheet formula injection: stored strings are untrusted. Numbers
  // (including negative ones) and other JSON values are left as they are.
  if (typeof value === "string" && /^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Turn import CSV into records: the header names dotted data paths. Column
 * and row caps apply while parsing, before any record is built, and each
 * record is built in one pass.
 */
export function siteDataCsvRecords(csv: string): Record<string, unknown>[] {
  const rows = parseSiteDataCsv(csv, {
    maxColumns: SITE_DATA_IMPORT_MAX_COLUMNS,
    maxRecords: SITE_DATA_IMPORT_MAX_RECORDS,
  });
  const [header, ...body] = rows;
  if (!header || header.length === 0)
    throw new SiteDataError("validation", "The CSV needs a header row");
  // parseSiteDataPath refuses __proto__, prototype and constructor.
  const paths = header.map((name) => {
    const segments = parseSiteDataPath(name);
    if (!segments) throw new SiteDataError("validation", `Invalid CSV column name: ${name}`);
    return segments;
  });
  return body.map((cells) => siteDataCsvRecord(paths, cells));
}

export async function importSiteData(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  collection: string,
  request: SiteDataImportRequest,
): Promise<{ imported: number }> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  // Counted before parsing: at most one record per CSV line after the header.
  const reserved = await consume(
    access,
    "write",
    request.format === "csv"
      ? Math.min(SITE_DATA_IMPORT_MAX_RECORDS, csvLineBreaks(request.csv ?? ""))
      : Math.min(SITE_DATA_IMPORT_MAX_RECORDS, request.records?.length ?? 0),
    {
      collections: [collection],
      // The text to parse and check: CSV characters or the records' JSON.
      bytes:
        request.format === "csv"
          ? (request.csv ?? "").length
          : siteDataValidationBytes(request.records ?? []),
    },
  );
  const imported = { count: 0 };
  const failed = (error: unknown): never => {
    throw siteDataImportFailure(error, imported.count);
  };
  // Everything after admission settles the reservation, including parse errors.
  return meteredWrite(access, reserved, async (meter) => {
    let records: Record<string, unknown>[];
    try {
      if (request.format === "csv") {
        records = siteDataCsvRecords(request.csv ?? "");
      } else records = request.records ?? [];
      if (records.length > SITE_DATA_IMPORT_MAX_RECORDS)
        throw new SiteDataError(
          "validation",
          `Import at most ${SITE_DATA_IMPORT_MAX_RECORDS} records at a time`,
        );
    } catch (error) {
      return failed(error);
    }
    const keySegments = request.keyField ? parseSiteDataPath(request.keyField) : null;
    if (request.keyField && !keySegments)
      throw new SiteDataError("validation", `Invalid keyField: ${request.keyField}`);
    const operations: SiteDataWriteOp[] = records.map((data, index) => {
      if (!keySegments) return { op: "insert", collection, data };
      const key = readSiteDataPath(data, keySegments);
      if ((typeof key !== "string" && typeof key !== "number") || String(key).length === 0)
        throw new SiteDataError("validation", `Record ${index + 1} has no ${request.keyField}`, {
          index,
        });
      return { op: "put", collection, key: String(key), data };
    });
    // Every record is checked against the schema before anything is written.
    const options = await prevalidateSiteDataWrite(access, operations, {
      meter,
      reservedMs: reserved.reservedMs,
    }).catch(failed);
    // Each batch is atomic; a failure reports how many records were imported.
    for (let start = 0; start < operations.length; start += SITE_DATA_MAX_BATCH) {
      await access.store
        .write(access.caller, operations.slice(start, start + SITE_DATA_MAX_BATCH), options)
        .catch(failed);
      imported.count += Math.min(SITE_DATA_MAX_BATCH, operations.length - start);
    }
    return { imported: imported.count };
  });
}

/**
 * An import's error, with how many records it had already imported. Once a
 * batch committed, sending the same import again would duplicate it, so the
 * error is no longer retryable and its message says what was imported.
 */
export function siteDataImportFailure(error: unknown, imported: number): unknown {
  if (!(error instanceof SiteDataError)) return error;
  if (imported === 0)
    return new SiteDataError(error.code, error.message, { ...error.details, imported });
  const { retryable: _retryable, ...details } = error.details;
  return new SiteDataError(
    error.code,
    `${error.message.replace(/; send it again$/, "")}. ${imported} ${imported === 1 ? "record was" : "records were"} imported before this failure; import only the rest`,
    { ...details, imported },
  );
}

/** Line breaks in CSV text: an upper bound on its records after the header. */
function csvLineBreaks(csv: string): number {
  let breaks = 0;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv.charCodeAt(index);
    // CR, or LF not preceded by CR.
    if (char === 13 || (char === 10 && csv.charCodeAt(index - 1) !== 13)) breaks += 1;
  }
  return breaks;
}

export async function exportSiteData(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  collection: string,
  format: "json" | "csv",
): Promise<{
  collection: string;
  format: "json" | "csv";
  records: number;
  truncated: boolean;
  content: string;
}> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  const records: SiteDataRecord[] = [];
  let cursor: string | null = null;
  let truncated = false;
  let bytes = 0;
  // Collected up front and capped by count and bytes; the result is one bounded string.
  pages: do {
    const page = await access.store.query(access.caller, {
      collection,
      sort: [{ field: "$createdAt", direction: "asc" }],
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const record of page.records) {
      bytes += record.sizeBytes + 256;
      if (records.length >= SITE_DATA_EXPORT_MAX_RECORDS || bytes > SITE_DATA_EXPORT_MAX_BYTES) {
        truncated = true;
        break pages;
      }
      records.push(record);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const exported = records;
  if (format === "json")
    return {
      collection,
      format,
      records: exported.length,
      truncated,
      content: JSON.stringify(
        exported.map((record) => ({
          id: record.id,
          key: record.key,
          owner: record.owner,
          version: record.version,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          data: record.data,
        })),
      ),
    };
  // Viewers can shape records, so the column set is bounded: past the cap,
  // every record's data goes into a single JSON column instead.
  const seen = new Set<string>();
  let wide = false;
  for (const record of exported) {
    for (const key of Object.keys(record.data)) {
      seen.add(key);
      if (seen.size > SITE_DATA_EXPORT_MAX_COLUMNS) {
        wide = true;
        break;
      }
    }
    if (wide) break;
  }
  const columns = wide ? [] : [...seen].sort();
  const header = [
    "$id",
    "$key",
    "$owner",
    "$createdAt",
    "$updatedAt",
    ...(wide ? ["$data"] : columns),
  ];
  const lines = [
    header.map(siteDataCsvCell).join(","),
    ...exported.map((record) =>
      [
        record.id,
        record.key,
        record.owner,
        record.createdAt,
        record.updatedAt,
        ...(wide
          ? [JSON.stringify(record.data)]
          : columns.map((column) =>
              Object.hasOwn(record.data, column) ? record.data[column] : undefined,
            )),
      ]
        .map(siteDataCsvCell)
        .join(","),
    ),
  ];
  return {
    collection,
    format,
    records: exported.length,
    truncated,
    content: `${lines.join("\r\n")}\r\n`,
  };
}

// --- files -------------------------------------------------------------------

function storage(deps: Pick<ApiRouteDeps, "objectStorage">) {
  if (!deps.objectStorage)
    throw new SiteDataError("not_found", "File storage is not configured for this deployment");
  return deps.objectStorage;
}

export async function uploadSiteDataFile(
  deps: SiteDataDeps & Pick<ApiRouteDeps, "objectStorage">,
  grant: AccessGrant,
  siteId: string,
  input: {
    name: string | null | undefined;
    contentType: string | null | undefined;
    /**
     * The file's bytes, or a reader for a request body: it is called only
     * after access, the rate window and the quota (with the declared size,
     * when known) have passed, so refused uploads are never read.
     */
    body: Uint8Array | { declaredBytes?: number | undefined; read: () => Promise<Uint8Array> };
    scope?: SiteDataFileScope | undefined;
  },
  surface: SiteDataSurface = {},
): Promise<SiteDataFile> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, surface);
  const objects = storage(deps);
  // Access, rate, then quota, before the body is read or reaches object storage.
  await consume(access, "write", 1);
  const scope = input.scope ?? "shared";
  if (scope !== "shared" && scope !== "private")
    throw new SiteDataError("validation", "scope must be shared or private");
  let bytes: Uint8Array;
  if (input.body instanceof Uint8Array) bytes = input.body;
  else {
    if (input.body.declaredBytes !== undefined)
      await access.store.checkFileQuota(access.caller, input.body.declaredBytes, access.limits);
    bytes = await input.body.read();
  }
  await access.store.checkFileQuota(access.caller, bytes.byteLength, access.limits);
  const name = siteDataFileName(input.name);
  const contentType = siteDataFileContentType(input.contentType, bytes);
  const id = crypto.randomUUID();
  const objectKey = siteDataObjectKey(grant.workspaceId, siteId, id);
  const sha256 = sha256Hex(bytes);
  await objects.putObject({ key: objectKey, contentType, body: bytes, sha256 });
  try {
    return await access.store.insertFile(
      access.caller,
      { id, name, contentType, sizeBytes: bytes.byteLength, sha256, objectKey, scope },
      {
        limits: access.limits,
        afterWrite: (tx, summary) =>
          meterSiteData(tx, grant, access.caller, access.subjectId, "upload", summary),
      },
    );
  } catch (error) {
    await objects
      .deleteObject(objectKey)
      .catch((cleanup: unknown) => logCleanupFailure("A refused upload", objectKey, cleanup));
    throw error;
  }
}

export async function listSiteDataFiles(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  options: { limit?: number; cursor?: string | null },
  surface: SiteDataSurface = {},
) {
  const access = await resolveSiteDataAccess(deps, grant, siteId, surface);
  await consume(access, "read", 1);
  return access.store.listFiles(access.caller, options);
}

export async function getSiteDataFileUrl(
  deps: SiteDataDeps & Pick<ApiRouteDeps, "objectStorage">,
  grant: AccessGrant,
  siteId: string,
  fileId: string,
  surface: SiteDataSurface = {},
  audience: "public" | "sandbox" = "public",
): Promise<{ file: SiteDataFile; url: string; expiresAt: string }> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, surface);
  await consume(access, "read", 1);
  const stored = await access.store.getFile(access.caller, fileId);
  if (!stored) throw new SiteDataError("not_found", "File not found");
  const { objectKey, ...file } = stored;
  const signed = await storage(deps).createGetUrl({
    key: objectKey,
    audience,
    expiresInSeconds: FILE_URL_SECONDS,
    ...userContentSignedGetUrlOptions(file.contentType, file.name),
  });
  return { file, url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

export async function deleteSiteDataFile(
  deps: SiteDataDeps & Pick<ApiRouteDeps, "objectStorage">,
  grant: AccessGrant,
  siteId: string,
  fileId: string,
  surface: SiteDataSurface = {},
): Promise<{ deleted: { id: string } }> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, surface);
  await consume(access, "write", 1);
  const removed = await access.store.deleteFile(access.caller, fileId);
  // The metadata row is gone; a failed object delete leaves an unreachable blob.
  await storage(deps)
    .deleteObject(removed.objectKey)
    .catch((cleanup: unknown) => logCleanupFailure("A file delete", removed.objectKey, cleanup));
  return { deleted: { id: removed.id } };
}
