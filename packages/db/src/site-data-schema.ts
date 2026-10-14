import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Site Data. Foreign keys, checks, FORCE RLS and grants are owned
// by migration 0773. This leaf intentionally does not import schema.ts,
// avoiding a cycle. All access goes through site-data-postgres.ts.

export const siteDataCollections = pgTable(
  "site_data_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    name: text("name").notNull(),
    accessMode: text("access_mode")
      .$type<"shared" | "shared_read" | "per_viewer" | "append_only">()
      .notNull(),
    privateRecords: boolean("private_records").notNull().default(false),
    jsonSchema: jsonb("json_schema"),
    indexedFields: jsonb("indexed_fields").$type<string[]>().notNull().default([]),
    uniqueFields: jsonb("unique_fields").$type<string[][]>().notNull().default([]),
    recordCount: bigint("record_count", { mode: "number" }).notNull().default(0),
    recordBytes: bigint("record_bytes", { mode: "number" }).notNull().default(0),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceId: uniqueIndex("site_data_collections_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    workspaceSiteId: uniqueIndex("site_data_collections_workspace_site_id_uq").on(
      table.workspaceId,
      table.siteId,
      table.id,
    ),
    siteName: uniqueIndex("site_data_collections_site_name_uq").on(
      table.workspaceId,
      table.siteId,
      table.name,
    ),
  }),
);

export const siteDataRecords = pgTable(
  "site_data_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    collectionId: uuid("collection_id").notNull(),
    keyScope: text("key_scope").notNull().default(""),
    recordKey: text("record_key"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    ownerPrincipal: text("owner_principal").notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    version: integer("version").notNull().default(1),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceId: uniqueIndex("site_data_records_workspace_id_uq").on(table.workspaceId, table.id),
    key: uniqueIndex("site_data_records_key_uq")
      .on(table.collectionId, table.keyScope, table.recordKey)
      .where(sql`${table.recordKey} is not null`),
    created: index("site_data_records_created_idx").on(
      table.collectionId,
      table.createdAt,
      table.id,
    ),
    updated: index("site_data_records_updated_idx").on(
      table.collectionId,
      table.updatedAt,
      table.id,
    ),
    owner: index("site_data_records_owner_idx").on(
      table.collectionId,
      table.ownerPrincipal,
      table.createdAt,
      table.id,
    ),
    site: index("site_data_records_site_idx").on(table.workspaceId, table.siteId),
  }),
);

export const siteDataRecordValues = pgTable(
  "site_data_record_values",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    collectionId: uuid("collection_id").notNull(),
    recordId: uuid("record_id").notNull(),
    kind: text("kind").$type<"unique" | "index">().notNull(),
    name: text("name").notNull(),
    scope: text("scope").notNull().default(""),
    valueHash: text("value_hash"),
    valueText: text("value_text"),
    valueNum: doublePrecision("value_num"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.recordId, table.kind, table.name] }),
    workspaceRecord: index("site_data_record_values_workspace_record_idx").on(
      table.workspaceId,
      table.recordId,
    ),
  }),
);

export const siteDataFiles = pgTable(
  "site_data_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull().unique(),
    scope: text("scope").$type<"shared" | "private">().notNull(),
    ownerPrincipal: text("owner_principal").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    site: index("site_data_files_site_idx").on(
      table.workspaceId,
      table.siteId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const siteDataUsage = pgTable(
  "site_data_usage",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    collectionCount: integer("collection_count").notNull().default(0),
    recordCount: bigint("record_count", { mode: "number" }).notNull().default(0),
    recordBytes: bigint("record_bytes", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    fileBytes: bigint("file_bytes", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.siteId] }),
  }),
);

export const siteDataRateWindows = pgTable(
  "site_data_rate_windows",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    principalKey: text("principal_key").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    operations: integer("operations").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.siteId, table.principalKey] }),
  }),
);

export const siteDataValidationWindows = pgTable("site_data_validation_windows", {
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  validationMicros: bigint("validation_micros", { mode: "number" }).notNull(),
});
