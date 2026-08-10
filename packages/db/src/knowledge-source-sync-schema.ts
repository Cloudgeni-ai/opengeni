import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const knowledgeSourceSyncStates = pgTable(
  "knowledge_source_sync_states",
  {
    sourceId: uuid("source_id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    scheduledTaskId: uuid("scheduled_task_id").notNull(),
    sourceSyncGeneration: bigint("source_sync_generation", { mode: "number" }).notNull(),
    sourceLifecycleGeneration: bigint("source_lifecycle_generation", { mode: "number" }).notNull(),
    sourceConfigGeneration: bigint("source_config_generation", { mode: "number" }).notNull(),
    controlWorkspaceId: uuid("control_workspace_id").notNull(),
    providerCoordinationKey: text("provider_coordination_key").notNull(),
    connectionId: uuid("connection_id").notNull(),
    connectionVersion: bigint("connection_version", { mode: "number" }).notNull(),
    connectionProviderDomain: text("connection_provider_domain").notNull(),
    connectionKind: text("connection_kind").notNull(),
    connectionOwnerSubjectId: text("connection_owner_subject_id").notNull(),
    initiatingSubjectId: text("initiating_subject_id").notNull(),
    destination: jsonb("destination").$type<Record<string, unknown>>().notNull(),
    executionCheckpoint: jsonb("execution_checkpoint").$type<Record<string, unknown>>(),
    executionCheckpointGeneration: bigint("execution_checkpoint_generation", {
      mode: "number",
    })
      .notNull()
      .default(0),
    activeScanGeneration: bigint("active_scan_generation", { mode: "number" }).notNull().default(0),
    providerCursor: jsonb("provider_cursor").$type<Record<string, unknown>>(),
    wakeRevision: bigint("wake_revision", { mode: "number" }).notNull().default(0),
    pendingWakeCount: integer("pending_wake_count").notNull().default(0),
    leaseId: uuid("lease_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    bufferedWake: boolean("buffered_wake").notNull().default(false),
    bufferedScheduledTaskRunId: uuid("buffered_scheduled_task_run_id"),
    reconnectRequired: boolean("reconnect_required").notNull().default(false),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    lastSummary: jsonb("last_summary").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    task: uniqueIndex("knowledge_source_sync_states_task_uq").on(table.scheduledTaskId),
    due: index("knowledge_source_sync_states_due_idx").on(
      table.workspaceId,
      table.bufferedWake,
      table.leaseUntil,
      table.updatedAt,
    ),
  }),
);

export const knowledgeSourceSyncObjectObservations = pgTable(
  "knowledge_source_sync_object_observations",
  {
    sourceId: uuid("source_id").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    scheduledTaskRunId: uuid("scheduled_task_run_id"),
    scanGeneration: bigint("scan_generation", { mode: "number" }).notNull(),
    providerRevision: text("provider_revision"),
    metadataHash: text("metadata_hash"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: uniqueIndex("knowledge_source_sync_object_observations_identity_uq").on(
      table.sourceId,
      table.externalObjectId,
    ),
    scan: index("knowledge_source_sync_object_observations_scan_idx").on(
      table.workspaceId,
      table.sourceId,
      table.scanGeneration,
    ),
  }),
);

export const knowledgeSourceSyncItemOutcomes = pgTable(
  "knowledge_source_sync_item_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    scheduledTaskRunId: uuid("scheduled_task_run_id").notNull(),
    knowledgeSyncRunId: uuid("knowledge_sync_run_id"),
    sourceId: uuid("source_id").notNull(),
    sourceConfigGeneration: bigint("source_config_generation", { mode: "number" }).notNull(),
    sourceLifecycleGeneration: bigint("source_lifecycle_generation", { mode: "number" }).notNull(),
    externalObjectId: text("external_object_id").notNull(),
    providerRevision: text("provider_revision"),
    metadataHash: text("metadata_hash"),
    aclEligibility: text("acl_eligibility").notNull().default("pending"),
    aclEvidence: jsonb("acl_evidence").$type<Record<string, unknown>>(),
    indexObligationId: uuid("index_obligation_id"),
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code"),
    detail: text("detail"),
    contentSha256: text("content_sha256"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: uniqueIndex("knowledge_source_sync_item_outcomes_identity_uq").on(
      table.scheduledTaskRunId,
      table.externalObjectId,
    ),
    run: index("knowledge_source_sync_item_outcomes_run_idx").on(
      table.workspaceId,
      table.scheduledTaskRunId,
      table.createdAt,
    ),
  }),
);

export const knowledgeSourceSyncWakes = pgTable(
  "knowledge_source_sync_wakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    scheduledTaskId: uuid("scheduled_task_id").notNull(),
    scheduledTaskRunId: uuid("scheduled_task_run_id").notNull(),
    cause: text("cause").notNull(),
    producerKey: text("producer_key").notNull(),
    sourceConfigGeneration: bigint("source_config_generation", { mode: "number" }).notNull(),
    sourceLifecycleGeneration: bigint("source_lifecycle_generation", { mode: "number" }).notNull(),
    coalesced: boolean("coalesced").notNull().default(false),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    run: uniqueIndex("knowledge_source_sync_wakes_run_uq").on(table.scheduledTaskRunId),
    pending: index("knowledge_source_sync_wakes_pending_idx").on(
      table.workspaceId,
      table.sourceId,
      table.completedAt,
      table.createdAt,
    ),
  }),
);

export const knowledgeSourceSyncIndexObligations = pgTable(
  "knowledge_source_sync_index_obligations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    scheduledTaskRunId: uuid("scheduled_task_run_id"),
    sourceId: uuid("source_id").notNull(),
    sourceSyncGeneration: bigint("source_sync_generation", { mode: "number" }).notNull(),
    initiatingSubjectId: text("initiating_subject_id").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    knowledgeSourceObjectId: uuid("knowledge_source_object_id").notNull(),
    knowledgeDocumentVersionId: uuid("knowledge_document_version_id").notNull(),
    documentId: uuid("document_id").notNull(),
    sourceConfigGeneration: bigint("source_config_generation", { mode: "number" }).notNull(),
    sourceLifecycleGeneration: bigint("source_lifecycle_generation", { mode: "number" }).notNull(),
    objectLifecycleGeneration: bigint("object_lifecycle_generation", { mode: "number" }).notNull(),
    objectVersionGeneration: bigint("object_version_generation", { mode: "number" }).notNull(),
    citationLocator: jsonb("citation_locator").$type<Record<string, unknown>>().notNull(),
    aclEligibility: text("acl_eligibility").notNull().default("pending"),
    status: text("status").notNull().default("pending"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    version: uniqueIndex("knowledge_source_sync_index_obligations_version_uq").on(
      table.knowledgeDocumentVersionId,
    ),
    pending: index("knowledge_source_sync_index_obligations_pending_idx").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
  }),
);
