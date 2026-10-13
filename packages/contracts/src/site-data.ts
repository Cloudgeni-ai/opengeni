import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Site Data (OPE-800): persistent JSON collections and files that belong to a
 * published Site. Shared by the HTTP API, first-party agent tools and the SDK.
 */

export const SiteDataAccessMode = /* @__PURE__ */ defineSchema(() =>
  z
    .enum(["shared", "shared_read", "per_viewer", "append_only"])
    .describe(
      "shared: viewers read and write every record. shared_read: viewers read, only managers write. per_viewer: each viewer reads and writes only their own records. append_only: viewers add records and read only their own.",
    ),
);
export type SiteDataAccessMode = z.infer<typeof SiteDataAccessMode>;

const CollectionName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .describe("Collection name: a letter, then letters, digits, - or _ (up to 64).");
const FieldPath = z
  .string()
  .min(1)
  .max(300)
  .describe(
    "A data field as a dotted path (up to 4 levels), or a system field: $id, $key, $owner, $createdAt, $updatedAt, $version.",
  );
const RecordKey = z.string().min(1).max(256).describe("Your own stable record key.");
const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const RecordData = z
  .record(z.string(), z.unknown())
  .describe("The record's JSON object (at most 256 KB by default).");

export const SiteDataFilter = /* @__PURE__ */ defineSchema(() =>
  z.object({
    field: FieldPath,
    op: z
      .enum(["eq", "ne", "in", "gt", "gte", "lt", "lte", "contains", "exists"])
      .describe(
        "contains matches an array element or a case-insensitive substring; exists takes true or false.",
      ),
    value: z
      .union([Scalar, z.array(Scalar).max(100)])
      .optional()
      .describe("The value to compare with; an array for in. $owner accepts me."),
  }),
);
export type SiteDataFilter = z.infer<typeof SiteDataFilter>;

export const SiteDataSort = /* @__PURE__ */ defineSchema(() =>
  z.object({
    field: FieldPath,
    direction: z.enum(["asc", "desc"]).optional().describe("Defaults to asc."),
  }),
);
export type SiteDataSort = z.infer<typeof SiteDataSort>;

export const SiteDataQueryRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    collection: CollectionName,
    where: z.array(SiteDataFilter).max(20).optional().describe("All filters must match."),
    sort: z
      .array(SiteDataSort)
      .max(2)
      .optional()
      .describe("Up to two sort keys. Defaults to newest first."),
    limit: z.number().int().min(1).max(200).optional().describe("Page size, 50 by default."),
    cursor: z.string().max(4096).nullable().optional().describe("nextCursor from the last page."),
    count: z.boolean().optional().describe("Also return the total number of matches."),
    scope: z
      .enum(["own", "all"])
      .optional()
      .describe("own returns only the caller's records; all returns every readable record."),
  }),
);
export type SiteDataQueryRequest = z.infer<typeof SiteDataQueryRequest>;

export const SiteDataGetRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      collection: CollectionName,
      id: z.string().uuid().optional().describe("Record id."),
      key: RecordKey.optional(),
    })
    .refine((value) => (value.id === undefined) !== (value.key === undefined), {
      message: "Give exactly one of id or key",
    }),
);
export type SiteDataGetRequest = z.infer<typeof SiteDataGetRequest>;

const RecordRef = {
  id: z.string().uuid().optional().describe("Record id; give id or key."),
  key: RecordKey.optional(),
};
const ExpectedVersion = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Fail with a conflict unless the record has this version (0: must not exist).");

export const SiteDataWriteOperation = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("op", [
    z.object({
      op: z.literal("insert"),
      collection: CollectionName,
      key: RecordKey.optional(),
      data: RecordData,
    }),
    z.object({
      op: z.literal("put").describe("Create or replace the record with this key."),
      collection: CollectionName,
      key: RecordKey,
      data: RecordData,
      expectedVersion: ExpectedVersion,
    }),
    z.object({
      op: z.literal("patch").describe("Shallow-merge data into the record."),
      collection: CollectionName,
      ...RecordRef,
      data: RecordData,
      expectedVersion: ExpectedVersion,
    }),
    z.object({
      op: z.literal("delete"),
      collection: CollectionName,
      ...RecordRef,
      expectedVersion: ExpectedVersion,
    }),
    z.object({
      op: z.literal("increment").describe("Atomically add to a numeric field."),
      collection: CollectionName,
      ...RecordRef,
      field: FieldPath,
      by: z.number().optional().describe("Amount to add, 1 by default."),
    }),
  ]),
);
export type SiteDataWriteOperation = z.infer<typeof SiteDataWriteOperation>;

export const SiteDataWriteRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operations: z
      .array(SiteDataWriteOperation)
      .min(1)
      .max(100)
      .describe("Up to 100 operations, applied together or not at all."),
  }),
);
export type SiteDataWriteRequest = z.infer<typeof SiteDataWriteRequest>;

export const SiteDataCollectionDefinitionRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    accessMode: SiteDataAccessMode,
    privateRecords: z
      .boolean()
      .optional()
      .describe("per_viewer only: keep records private even from the Site's managers."),
    jsonSchema: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe("Optional JSON Schema every written record must match."),
    indexedFields: z
      .array(z.string().min(1).max(300).describe("Dotted data path."))
      .max(10)
      .optional()
      .describe("Fields to index for faster numeric range filters."),
    uniqueFields: z
      .array(
        z
          .array(z.string().min(1).max(300).describe("Dotted data path."))
          .min(1)
          .max(4)
          .describe("A set of fields whose combined value must be unique."),
      )
      .max(5)
      .optional()
      .describe("Unique field sets. Per-viewer collections enforce them per viewer."),
  }),
);
export type SiteDataCollectionDefinitionRequest = z.infer<
  typeof SiteDataCollectionDefinitionRequest
>;

export const SiteDataConfirmRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ confirm: z.literal(true).describe("Must be true.") }),
);

export const SiteDataImportRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      format: z.enum(["json", "csv"]),
      records: z
        .array(RecordData)
        .max(1000)
        .optional()
        .describe("JSON format: the records to import."),
      csv: z
        .string()
        .max(2 * 1024 * 1024)
        .optional()
        .describe("CSV format: a header row, then one record per row. Values import as text."),
      keyField: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe("Use this field as each record's key, so re-importing replaces records."),
    })
    .refine((value) => (value.format === "json" ? !!value.records : value.csv !== undefined), {
      message: "Give records for json or csv for csv",
    }),
);
export type SiteDataImportRequest = z.infer<typeof SiteDataImportRequest>;

export const SiteDataFileScope = /* @__PURE__ */ defineSchema(() =>
  z
    .enum(["shared", "private"])
    .describe("shared: every viewer can open it. private: only the uploader and managers."),
);
export type SiteDataFileScope = z.infer<typeof SiteDataFileScope>;

export const SiteDataErrorCode = /* @__PURE__ */ defineSchema(() =>
  z.enum(["validation", "conflict", "not_found", "forbidden", "quota_exceeded", "rate_limited"]),
);
export type SiteDataErrorCode = z.infer<typeof SiteDataErrorCode>;

/** HTTP status for each Site Data error code. */
export const SITE_DATA_ERROR_STATUS: Record<SiteDataErrorCode, number> = {
  validation: 422,
  conflict: 409,
  not_found: 404,
  forbidden: 403,
  quota_exceeded: 413,
  rate_limited: 429,
};

export type SiteDataRecordResponse = {
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

export type SiteDataCollectionResponse = {
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

export type SiteDataLimitsResponse = {
  recordBytesPerSite: number;
  maxRecordBytes: number;
  maxCollectionsPerSite: number;
  fileBytesPerSite: number;
  maxFileBytes: number;
  workspaceBytes: number;
};

export type SiteDataDescribeResponse = {
  siteId: string;
  collections: SiteDataCollectionResponse[];
  usage: {
    collectionCount: number;
    recordCount: number;
    recordBytes: number;
    fileCount: number;
    fileBytes: number;
    workspaceBytes: number;
  };
  limits: SiteDataLimitsResponse;
};

export type SiteDataFileResponse = {
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
