import type { SiteCapabilityManifest } from "@opengeni/contracts/sites";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const workspaceSites = pgTable(
  "workspace_sites",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    currentReleaseId: uuid("current_release_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceArtifact: uniqueIndex("workspace_sites_workspace_artifact_uq").on(
      table.workspaceId,
      table.artifactId,
    ),
    workspaceId: uniqueIndex("workspace_sites_scope_uq").on(
      table.id,
      table.workspaceId,
      table.accountId,
    ),
    list: index("workspace_sites_list_idx").on(table.workspaceId, table.updatedAt, table.id),
    status: check("workspace_sites_status_chk", sql`${table.status} in ('active', 'archived')`),
  }),
);

export const workspaceSiteReleases = pgTable(
  "workspace_site_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    artifactVersionId: uuid("artifact_version_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifest: jsonb("manifest").$type<SiteCapabilityManifest>().notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    siteRevision: uniqueIndex("workspace_site_releases_revision_uq").on(
      table.siteId,
      table.revision,
    ),
    siteOperation: uniqueIndex("workspace_site_releases_operation_uq").on(
      table.siteId,
      table.operationId,
    ),
    timeline: index("workspace_site_releases_timeline_idx").on(
      table.workspaceId,
      table.siteId,
      table.createdAt,
    ),
    hashes: check(
      "workspace_site_releases_hashes_chk",
      sql`${table.requestHash} ~ '^sha256:[0-9a-f]{64}$' and ${table.manifestHash} ~ '^sha256:[0-9a-f]{64}$' and jsonb_typeof(${table.manifest}) = 'object'`,
    ),
  }),
);

export const workspaceSiteEvents = pgTable(
  "workspace_site_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    releaseId: uuid("release_id"),
    operationId: uuid("operation_id").notNull(),
    type: text("type")
      .$type<"published" | "rolled_back" | "archived" | "runtime_session_started">()
      .notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("workspace_site_events_operation_uq").on(
      table.siteId,
      table.operationId,
    ),
    timeline: index("workspace_site_events_timeline_idx").on(
      table.workspaceId,
      table.siteId,
      table.createdAt,
    ),
    values: check(
      "workspace_site_events_values_chk",
      sql`${table.type} in ('published','rolled_back','archived','runtime_session_started') and jsonb_typeof(${table.facts}) = 'object'`,
    ),
  }),
);

export const workspaceSiteRuntimeSessions = pgTable(
  "workspace_site_runtime_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    releaseId: uuid("release_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    session: uniqueIndex("workspace_site_runtime_sessions_session_uq").on(table.sessionId),
    operation: uniqueIndex("workspace_site_runtime_sessions_operation_uq").on(
      table.siteId,
      table.operationId,
    ),
    timeline: index("workspace_site_runtime_sessions_timeline_idx").on(
      table.workspaceId,
      table.siteId,
      table.createdAt,
    ),
    requestHash: check(
      "workspace_site_runtime_sessions_hash_chk",
      sql`${table.requestHash} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);
