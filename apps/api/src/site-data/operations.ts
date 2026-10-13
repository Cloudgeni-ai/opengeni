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
  type SiteDataWriteOp,
} from "@opengeni/db";
import { userContentSignedGetUrlOptions } from "../http/user-content";
import {
  assertSiteDataSchema,
  meterSiteData,
  publicSiteDataLimits,
  resolveSiteDataAccess,
  sha256Hex,
  siteDataFileContentType,
  siteDataFileName,
  siteDataObjectKey,
  type SiteDataDeps,
  type SiteDataSurface,
} from "./service";

/** Shared Site Data operations for HTTP routes, the Site bridge and agent tools. */

export const SITE_DATA_EXPORT_MAX_RECORDS = 10_000;
export const SITE_DATA_IMPORT_MAX_RECORDS = 1_000;
const FILE_URL_SECONDS = 300;

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
  assertSiteDataSchema(definition.jsonSchema);
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
  return access.store.deleteCollection(access.caller, name);
}

export async function resetSiteDataCollection(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  name: string,
) {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
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
  return access.store.write(access.caller, operations as SiteDataWriteOp[], access.writeOptions);
}

// --- import and export -------------------------------------------------------

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF rows. */
export function parseSiteDataCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
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
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new SiteDataError("validation", "The CSV has an unterminated quoted field");
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  // Spreadsheet formula injection: stored records are untrusted.
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function importSiteData(
  deps: SiteDataDeps,
  grant: AccessGrant,
  siteId: string,
  collection: string,
  request: SiteDataImportRequest,
): Promise<{ imported: number }> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  let records: Record<string, unknown>[];
  if (request.format === "csv") {
    const rows = parseSiteDataCsv(request.csv ?? "");
    const [header, ...body] = rows;
    if (!header || header.length === 0)
      throw new SiteDataError("validation", "The CSV needs a header row");
    for (const name of header)
      if (!parseSiteDataPath(name))
        throw new SiteDataError("validation", `Invalid CSV column name: ${name}`);
    records = body.map((cells) => {
      let record: Record<string, unknown> = {};
      header.forEach((name, column) => {
        const segments = parseSiteDataPath(name)!;
        let target = record;
        segments.forEach((segment, depth) => {
          if (depth === segments.length - 1) target[segment] = cells[column] ?? "";
          else {
            const next = target[segment];
            target[segment] = typeof next === "object" && next !== null ? next : {};
            target = target[segment] as Record<string, unknown>;
          }
        });
      });
      return record;
    });
  } else records = request.records ?? [];
  if (records.length > SITE_DATA_IMPORT_MAX_RECORDS)
    throw new SiteDataError(
      "validation",
      `Import at most ${SITE_DATA_IMPORT_MAX_RECORDS} records at a time`,
    );
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
  let imported = 0;
  // Each batch is atomic; a failure reports how many records were imported.
  for (let start = 0; start < operations.length; start += SITE_DATA_MAX_BATCH) {
    try {
      await access.store.write(
        access.caller,
        operations.slice(start, start + SITE_DATA_MAX_BATCH),
        access.writeOptions,
      );
    } catch (error) {
      if (error instanceof SiteDataError)
        throw new SiteDataError(error.code, error.message, { ...error.details, imported });
      throw error;
    }
    imported += Math.min(SITE_DATA_MAX_BATCH, operations.length - start);
  }
  return { imported };
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
  do {
    const page = await access.store.query(access.caller, {
      collection,
      sort: [{ field: "$createdAt", direction: "asc" }],
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    records.push(...page.records);
    cursor = page.nextCursor;
    if (records.length >= SITE_DATA_EXPORT_MAX_RECORDS && cursor) {
      truncated = true;
      break;
    }
  } while (cursor);
  const exported = records.slice(0, SITE_DATA_EXPORT_MAX_RECORDS);
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
  const columns = [...new Set(exported.flatMap((record) => Object.keys(record.data)))].sort();
  const header = ["$id", "$key", "$owner", "$createdAt", "$updatedAt", ...columns];
  const lines = [
    header.map(csvCell).join(","),
    ...exported.map((record) =>
      [
        record.id,
        record.key,
        record.owner,
        record.createdAt,
        record.updatedAt,
        ...columns.map((column) => record.data[column]),
      ]
        .map(csvCell)
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
    bytes: Uint8Array;
    scope?: SiteDataFileScope | undefined;
  },
  surface: SiteDataSurface = {},
): Promise<SiteDataFile> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, surface);
  const objects = storage(deps);
  if (input.bytes.byteLength > access.limits.maxFileBytes)
    throw new SiteDataError(
      "quota_exceeded",
      `A file can be at most ${Math.floor(access.limits.maxFileBytes / (1024 * 1024))} MB`,
      { quota: "file_bytes", limit: access.limits.maxFileBytes },
    );
  const name = siteDataFileName(input.name);
  const contentType = siteDataFileContentType(input.contentType, input.bytes);
  const scope = input.scope ?? "shared";
  if (scope !== "shared" && scope !== "private")
    throw new SiteDataError("validation", "scope must be shared or private");
  const id = crypto.randomUUID();
  const objectKey = siteDataObjectKey(grant.workspaceId, siteId, id);
  const sha256 = sha256Hex(input.bytes);
  await objects.putObject({ key: objectKey, contentType, body: input.bytes, sha256 });
  try {
    return await access.store.insertFile(
      access.caller,
      { id, name, contentType, sizeBytes: input.bytes.byteLength, sha256, objectKey, scope },
      {
        limits: access.limits,
        rateLimit: access.writeOptions.rateLimit,
        afterWrite: (tx, summary) =>
          meterSiteData(tx, grant, access.caller, access.subjectId, "upload", summary),
      },
    );
  } catch (error) {
    await objects.deleteObject(objectKey).catch(() => undefined);
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
  const removed = await access.store.deleteFile(access.caller, fileId);
  // The metadata row is gone; a failed object delete leaves an unreachable blob.
  await storage(deps)
    .deleteObject(removed.objectKey)
    .catch(() => undefined);
  return { deleted: { id: removed.id } };
}
