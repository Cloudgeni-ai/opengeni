import type { CanonicalToolIdentity } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type AppStatus = "active" | "archived";
export type AppSourceRevisionStatus =
  | "uploading"
  | "verifying"
  | "ready"
  | "failed"
  | "expired"
  | "deleting"
  | "deleted";
export type AppBuildStatus =
  | "queued"
  | "running"
  | "uploading"
  | "verifying"
  | "succeeded"
  | "failed"
  | "deleting"
  | "deleted";
export type AppReleaseStatus = "ready" | "deleting" | "deleted";
export type AppPreviewStatus = "active" | "expired" | "revoked";
export type AppPublicationStatus = "active" | "retired";
export type AppLaunchStatus = "active" | "revoked";
export type AppToolCallStatus = "pending" | "succeeded" | "failed";
export type AppObjectCleanupReason =
  | "archive"
  | "workspace_delete"
  | "abandoned_source"
  | "abandoned_build";

export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").$type<AppStatus>().notNull().default("active"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    latestSourceRevisionId: uuid("latest_source_revision_id"),
    latestBuildId: uuid("latest_build_id"),
    activeReleaseId: uuid("active_release_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("apps_workspace_id_uq").on(table.workspaceId, table.id),
    workspaceSlug: uniqueIndex("apps_workspace_slug_uq").on(table.workspaceId, table.slug),
    workspaceList: index("apps_workspace_list_idx").on(table.workspaceId, table.updatedAt),
    versionPositive: check("apps_version_chk", sql`${table.version} > 0`),
  }),
);

export const appSourceRevisions = pgTable(
  "app_source_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    format: text("format").$type<"portable_tar_v1">().notNull().default("portable_tar_v1"),
    status: text("status").$type<AppSourceRevisionStatus>().notNull().default("uploading"),
    stagingObjectKey: text("staging_object_key").notNull(),
    frozenObjectKey: text("frozen_object_key").notNull(),
    frozenVersionToken: text("frozen_version_token"),
    contentSha256: text("content_sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    fileCount: integer("file_count"),
    failureCode: text("failure_code"),
    sourceSessionId: uuid("source_session_id"),
    sourceTurnId: uuid("source_turn_id"),
    sourceAttemptId: uuid("source_attempt_id"),
    sourceExecutionGeneration: integer("source_execution_generation"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => ({
    app: foreignKey({
      name: "app_source_revisions_app_fk",
      columns: [table.workspaceId, table.appId],
      foreignColumns: [apps.workspaceId, apps.id],
    }).onDelete("cascade"),
    workspaceIdentity: uniqueIndex("app_source_revisions_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    workspaceAppIdentity: uniqueIndex("app_source_revisions_workspace_app_id_uq").on(
      table.workspaceId,
      table.appId,
      table.id,
    ),
    appRevision: uniqueIndex("app_source_revisions_app_revision_uq").on(
      table.workspaceId,
      table.appId,
      table.revision,
    ),
    stagingObject: uniqueIndex("app_source_revisions_staging_object_uq").on(table.stagingObjectKey),
    frozenObject: uniqueIndex("app_source_revisions_frozen_object_uq").on(table.frozenObjectKey),
    appCreated: index("app_source_revisions_app_created_idx").on(
      table.workspaceId,
      table.appId,
      table.createdAt,
    ),
    abandonedUpload: index("app_source_revisions_abandoned_upload_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} in ('uploading', 'verifying')`),
  }),
);

export const appToolPolicyRevisions = pgTable(
  "app_tool_policy_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    catalogDigest: text("catalog_digest").notNull(),
    allowedTools: jsonb("allowed_tools").$type<CanonicalToolIdentity[]>().notNull().default([]),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    app: foreignKey({
      name: "app_tool_policy_revisions_app_fk",
      columns: [table.workspaceId, table.appId],
      foreignColumns: [apps.workspaceId, apps.id],
    }).onDelete("cascade"),
    workspaceIdentity: uniqueIndex("app_tool_policy_revisions_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    workspaceAppIdentity: uniqueIndex("app_tool_policy_revisions_workspace_app_id_uq").on(
      table.workspaceId,
      table.appId,
      table.id,
    ),
    appRevision: uniqueIndex("app_tool_policy_revisions_app_revision_uq").on(
      table.workspaceId,
      table.appId,
      table.revision,
    ),
  }),
);

export const appBuilds = pgTable(
  "app_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    sourceRevisionId: uuid("source_revision_id").notNull(),
    toolPolicyRevisionId: uuid("tool_policy_revision_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    status: text("status").$type<AppBuildStatus>().notNull().default("uploading"),
    manifestObjectKey: text("manifest_object_key").notNull(),
    manifestVersionToken: text("manifest_version_token"),
    manifestSha256: text("manifest_sha256").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    entryPath: text("entry_path").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    checks: jsonb("checks").$type<Record<string, unknown>[]>().notNull(),
    receiptDigest: text("receipt_digest"),
    failureCode: text("failure_code"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => ({
    source: foreignKey({
      name: "app_builds_source_revision_fk",
      columns: [table.workspaceId, table.appId, table.sourceRevisionId],
      foreignColumns: [
        appSourceRevisions.workspaceId,
        appSourceRevisions.appId,
        appSourceRevisions.id,
      ],
    }).onDelete("no action"),
    toolPolicy: foreignKey({
      name: "app_builds_tool_policy_revision_fk",
      columns: [table.workspaceId, table.appId, table.toolPolicyRevisionId],
      foreignColumns: [
        appToolPolicyRevisions.workspaceId,
        appToolPolicyRevisions.appId,
        appToolPolicyRevisions.id,
      ],
    }).onDelete("no action"),
    workspaceIdentity: uniqueIndex("app_builds_workspace_id_uq").on(table.workspaceId, table.id),
    workspaceAppIdentity: uniqueIndex("app_builds_workspace_app_id_uq").on(
      table.workspaceId,
      table.appId,
      table.id,
    ),
    releaseIdentity: uniqueIndex("app_builds_release_identity_uq").on(
      table.workspaceId,
      table.appId,
      table.id,
      table.sourceRevisionId,
      table.toolPolicyRevisionId,
    ),
    appRevision: uniqueIndex("app_builds_app_revision_uq").on(
      table.workspaceId,
      table.appId,
      table.revision,
    ),
    appCreated: index("app_builds_app_created_idx").on(
      table.workspaceId,
      table.appId,
      table.createdAt,
    ),
    abandonedUpload: index("app_builds_abandoned_upload_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} in ('uploading', 'verifying')`),
  }),
);

export const appBuildFiles = pgTable(
  "app_build_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    buildId: uuid("build_id").notNull(),
    path: text("path").notNull(),
    contentType: text("content_type").notNull(),
    contentSha256: text("content_sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    executable: boolean("executable").notNull().default(false),
    stagingObjectKey: text("staging_object_key").notNull(),
    frozenObjectKey: text("frozen_object_key").notNull(),
    frozenVersionToken: text("frozen_version_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
  },
  (table) => ({
    build: foreignKey({
      name: "app_build_files_build_fk",
      columns: [table.workspaceId, table.appId, table.buildId],
      foreignColumns: [appBuilds.workspaceId, appBuilds.appId, appBuilds.id],
    }).onDelete("cascade"),
    workspaceIdentity: uniqueIndex("app_build_files_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    buildPath: uniqueIndex("app_build_files_build_path_uq").on(
      table.workspaceId,
      table.appId,
      table.buildId,
      table.path,
    ),
    stagingObject: uniqueIndex("app_build_files_staging_object_uq").on(table.stagingObjectKey),
    frozenObject: uniqueIndex("app_build_files_frozen_object_uq").on(table.frozenObjectKey),
  }),
);

export const appReleases = pgTable(
  "app_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    buildId: uuid("build_id").notNull(),
    sourceRevisionId: uuid("source_revision_id").notNull(),
    toolPolicyRevisionId: uuid("tool_policy_revision_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    status: text("status").$type<AppReleaseStatus>().notNull().default("ready"),
    manifestSha256: text("manifest_sha256").notNull(),
    entryPath: text("entry_path").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    buildReceiptDigest: text("build_receipt_digest").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    build: foreignKey({
      name: "app_releases_build_fk",
      columns: [
        table.workspaceId,
        table.appId,
        table.buildId,
        table.sourceRevisionId,
        table.toolPolicyRevisionId,
      ],
      foreignColumns: [
        appBuilds.workspaceId,
        appBuilds.appId,
        appBuilds.id,
        appBuilds.sourceRevisionId,
        appBuilds.toolPolicyRevisionId,
      ],
    }).onDelete("no action"),
    workspaceIdentity: uniqueIndex("app_releases_workspace_id_uq").on(table.workspaceId, table.id),
    workspaceAppIdentity: uniqueIndex("app_releases_workspace_app_id_uq").on(
      table.workspaceId,
      table.appId,
      table.id,
    ),
    appRevision: uniqueIndex("app_releases_app_revision_uq").on(
      table.workspaceId,
      table.appId,
      table.revision,
    ),
    buildOnce: uniqueIndex("app_releases_build_uq").on(
      table.workspaceId,
      table.appId,
      table.buildId,
    ),
    appCreated: index("app_releases_app_created_idx").on(
      table.workspaceId,
      table.appId,
      table.createdAt,
    ),
  }),
);

export const appPreviews = pgTable(
  "app_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    releaseId: uuid("release_id").notNull(),
    hostname: text("hostname").notNull(),
    status: text("status").$type<AppPreviewStatus>().notNull().default("active"),
    spaFallback: boolean("spa_fallback").notNull().default(true),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    release: foreignKey({
      name: "app_previews_release_fk",
      columns: [table.workspaceId, table.appId, table.releaseId],
      foreignColumns: [appReleases.workspaceId, appReleases.appId, appReleases.id],
    }).onDelete("cascade"),
    workspaceIdentity: uniqueIndex("app_previews_workspace_id_uq").on(table.workspaceId, table.id),
    workspaceTargetIdentity: uniqueIndex("app_previews_workspace_target_id_uq").on(
      table.workspaceId,
      table.appId,
      table.releaseId,
      table.id,
    ),
    hostStatusExpiry: index("app_previews_host_status_expiry_idx").on(
      table.hostname,
      table.status,
      table.expiresAt,
    ),
    expiry: index("app_previews_expiry_idx").on(table.status, table.expiresAt),
  }),
);

export const appPublications = pgTable(
  "app_publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    releaseId: uuid("release_id").notNull(),
    previousReleaseId: uuid("previous_release_id"),
    hostname: text("hostname").notNull(),
    status: text("status").$type<AppPublicationStatus>().notNull().default("active"),
    spaFallback: boolean("spa_fallback").notNull().default(true),
    reason: text("reason").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => ({
    release: foreignKey({
      name: "app_publications_release_fk",
      columns: [table.workspaceId, table.appId, table.releaseId],
      foreignColumns: [appReleases.workspaceId, appReleases.appId, appReleases.id],
    }).onDelete("no action"),
    workspaceIdentity: uniqueIndex("app_publications_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    workspaceTargetIdentity: uniqueIndex("app_publications_workspace_target_id_uq").on(
      table.workspaceId,
      table.appId,
      table.releaseId,
      table.id,
    ),
    activeApp: uniqueIndex("app_publications_active_app_uq")
      .on(table.workspaceId, table.appId)
      .where(sql`${table.status} = 'active'`),
    activeHost: uniqueIndex("app_publications_active_host_uq")
      .on(table.hostname)
      .where(sql`${table.status} = 'active'`),
  }),
);

export const appLaunches = pgTable(
  "app_launches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    releaseId: uuid("release_id").notNull(),
    previewId: uuid("preview_id"),
    publicationId: uuid("publication_id"),
    hostname: text("hostname").notNull(),
    nonceSha256: text("nonce_sha256").notNull(),
    authorityHash: text("authority_hash"),
    authorityEpoch: text("authority_epoch"),
    authorityGeneration: text("authority_generation").notNull(),
    status: text("status").$type<AppLaunchStatus>().notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    preview: foreignKey({
      name: "app_launches_preview_fk",
      columns: [table.workspaceId, table.appId, table.releaseId, table.previewId],
      foreignColumns: [
        appPreviews.workspaceId,
        appPreviews.appId,
        appPreviews.releaseId,
        appPreviews.id,
      ],
    }).onDelete("cascade"),
    publication: foreignKey({
      name: "app_launches_publication_fk",
      columns: [table.workspaceId, table.appId, table.releaseId, table.publicationId],
      foreignColumns: [
        appPublications.workspaceId,
        appPublications.appId,
        appPublications.releaseId,
        appPublications.id,
      ],
    }).onDelete("cascade"),
    workspaceIdentity: uniqueIndex("app_launches_workspace_id_uq").on(table.workspaceId, table.id),
    workspaceReleaseIdentity: uniqueIndex("app_launches_workspace_release_id_uq").on(
      table.workspaceId,
      table.appId,
      table.releaseId,
      table.id,
    ),
    nonce: uniqueIndex("app_launches_nonce_sha256_uq").on(table.nonceSha256),
    expiry: index("app_launches_expiry_idx").on(table.status, table.expiresAt),
    targetShape: check(
      "app_launches_target_chk",
      sql`(${table.previewId} is not null and ${table.publicationId} is null)
        or (${table.previewId} is null and ${table.publicationId} is not null)`,
    ),
  }),
);

export const appToolCalls = pgTable(
  "app_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    releaseId: uuid("release_id").notNull(),
    launchId: uuid("launch_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    toolServerId: text("tool_server_id").notNull(),
    toolName: text("tool_name").notNull(),
    catalogDigest: text("catalog_digest").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status").$type<AppToolCallStatus>().notNull().default("pending"),
    output: jsonb("output").$type<unknown>(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    launch: foreignKey({
      name: "app_tool_calls_launch_fk",
      columns: [table.workspaceId, table.appId, table.releaseId, table.launchId],
      foreignColumns: [
        appLaunches.workspaceId,
        appLaunches.appId,
        appLaunches.releaseId,
        appLaunches.id,
      ],
    }).onDelete("cascade"),
    workspaceIdentity: uniqueIndex("app_tool_calls_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    launchOperation: uniqueIndex("app_tool_calls_launch_operation_uq").on(
      table.workspaceId,
      table.launchId,
      table.operationId,
    ),
    launchStarted: index("app_tool_calls_launch_started_idx").on(
      table.workspaceId,
      table.launchId,
      table.startedAt,
    ),
  }),
);

export const appLifecycleOperations = pgTable(
  "app_lifecycle_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    operationKey: text("operation_key").notNull(),
    commandKind: text("command_kind").notNull(),
    inputHash: text("input_hash").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceOperation: uniqueIndex("app_lifecycle_operations_workspace_operation_uq").on(
      table.workspaceId,
      table.operationKey,
    ),
    inputHashValid: check(
      "app_lifecycle_operations_input_hash_chk",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const appGcClaims = pgTable(
  "app_gc_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    operationKey: text("operation_key").notNull(),
    inputHash: text("input_hash").notNull(),
    leaseToken: uuid("lease_token").notNull(),
    status: text("status").$type<"claimed" | "completed" | "failed">().notNull().default("claimed"),
    objectKeys: jsonb("object_keys").$type<string[]>().notNull(),
    settlementHash: text("settlement_hash"),
    errorCode: text("error_code"),
    actorSubjectId: text("actor_subject_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    app: foreignKey({
      name: "app_gc_claims_app_fk",
      columns: [table.workspaceId, table.appId],
      foreignColumns: [apps.workspaceId, apps.id],
    }).onDelete("cascade"),
    workspaceIdentity: uniqueIndex("app_gc_claims_workspace_id_uq").on(table.workspaceId, table.id),
    workspaceAppIdentity: uniqueIndex("app_gc_claims_workspace_app_id_uq").on(
      table.workspaceId,
      table.appId,
      table.id,
    ),
    operation: uniqueIndex("app_gc_claims_workspace_operation_uq").on(
      table.workspaceId,
      table.operationKey,
    ),
  }),
);

export const appObjectTombstones = pgTable(
  "app_object_tombstones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    objectKey: text("object_key").notNull(),
    providerReceipt: text("provider_receipt"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claim: foreignKey({
      name: "app_object_tombstones_claim_fk",
      columns: [table.workspaceId, table.appId, table.claimId],
      foreignColumns: [appGcClaims.workspaceId, appGcClaims.appId, appGcClaims.id],
    }).onDelete("cascade"),
    claimObject: uniqueIndex("app_object_tombstones_claim_object_uq").on(
      table.workspaceId,
      table.claimId,
      table.objectKey,
    ),
  }),
);

/** Survives workspace/App cascades until the provider delete is acknowledged. */
export const appObjectCleanupOutbox = pgTable(
  "app_object_cleanup_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    appId: uuid("app_id").notNull(),
    objectKey: text("object_key").notNull(),
    reason: text("reason").$type<AppObjectCleanupReason>().notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    claimId: uuid("claim_id"),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    object: uniqueIndex("app_object_cleanup_outbox_object_uq").on(table.objectKey),
    due: index("app_object_cleanup_outbox_due_idx").on(
      table.nextAttemptAt,
      table.notBefore,
      table.claimUntil,
      table.id,
    ),
    reasonValid: check(
      "app_object_cleanup_outbox_reason_chk",
      sql`${table.reason} in ('archive', 'workspace_delete', 'abandoned_source', 'abandoned_build')`,
    ),
    valid: check(
      "app_object_cleanup_outbox_valid_chk",
      sql`length(${table.objectKey}) between 1 and 2048
        and ${table.attemptCount} >= 0
        and ((${table.claimId} is null and ${table.claimUntil} is null)
          or (${table.claimId} is not null and ${table.claimUntil} is not null))
        and (${table.lastError} is null or length(${table.lastError}) <= 2000)`,
    ),
  }),
);
