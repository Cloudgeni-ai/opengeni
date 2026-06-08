import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, customType } from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(3072)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
});

export const managedAccounts = pgTable("managed_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  externalSource: text("external_source"),
  externalId: text("external_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  external: uniqueIndex("managed_accounts_external_idx").on(table.externalSource, table.externalId),
}));

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug"),
  externalSource: text("external_source"),
  externalId: text("external_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  account: index("workspaces_account_idx").on(table.accountId),
  accountSlug: uniqueIndex("workspaces_account_slug_idx").on(table.accountId, table.slug).where(sql`${table.slug} is not null`),
  external: uniqueIndex("workspaces_external_idx").on(table.externalSource, table.externalId),
}));

export const workspaceMemberships = pgTable("workspace_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  subjectId: text("subject_id").notNull(),
  subjectLabel: text("subject_label"),
  role: text("role").notNull().default("member"),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  subjectWorkspace: uniqueIndex("workspace_memberships_subject_workspace_idx").on(table.subjectId, table.workspaceId),
  subject: index("workspace_memberships_subject_idx").on(table.subjectId),
  account: index("workspace_memberships_account_idx").on(table.accountId),
}));

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  prefix: index("api_keys_prefix_idx").on(table.prefix),
  hash: uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
  account: index("api_keys_account_idx").on(table.accountId),
  workspace: index("api_keys_workspace_idx").on(table.workspaceId),
}));

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  initialMessage: text("initial_message").notNull(),
  resources: jsonb("resources").$type<unknown[]>().notNull().default([]),
  tools: jsonb("tools").$type<unknown[]>().notNull().default([]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  model: text("model").notNull(),
  sandboxBackend: text("sandbox_backend").notNull(),
  temporalWorkflowId: text("temporal_workflow_id"),
  activeTurnId: uuid("active_turn_id"),
  lastSequence: integer("last_sequence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreated: index("sessions_workspace_created_idx").on(table.workspaceId, table.createdAt),
}));

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending_upload"),
  filename: text("filename").notNull(),
  safeFilename: text("safe_filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256"),
  bucket: text("bucket").notNull(),
  objectKey: text("object_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreated: index("files_workspace_created_idx").on(table.workspaceId, table.createdAt),
  objectKey: uniqueIndex("files_object_key_idx").on(table.objectKey),
  status: index("files_status_idx").on(table.status),
}));

export const fileUploads = pgTable("file_uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspace: index("file_uploads_workspace_idx").on(table.workspaceId),
  fileId: index("file_uploads_file_id_idx").on(table.fileId),
  status: index("file_uploads_status_idx").on(table.status),
}));

export const documentBases = pgTable("document_bases", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreated: index("document_bases_workspace_created_idx").on(table.workspaceId, table.createdAt),
}));

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  baseId: uuid("base_id").notNull().references(() => documentBases.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("queued"),
  title: text("title").notNull(),
  parser: text("parser").notNull().default("liteparse"),
  chunkCount: integer("chunk_count").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  baseFile: uniqueIndex("documents_workspace_base_file_idx").on(table.workspaceId, table.baseId, table.fileId),
  baseStatus: index("documents_workspace_base_status_idx").on(table.workspaceId, table.baseId, table.status),
}));

export const documentChunks = pgTable("document_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  baseId: uuid("base_id").notNull().references(() => documentBases.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "restrict" }),
  chunkIndex: integer("chunk_index").notNull(),
  text: text("text").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  embedding: vector("embedding").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  documentIndex: uniqueIndex("document_chunks_workspace_document_index_idx").on(table.workspaceId, table.documentId, table.chunkIndex),
  base: index("document_chunks_workspace_base_idx").on(table.workspaceId, table.baseId),
}));

export const sessionTurns = pgTable("session_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  triggerEventId: uuid("trigger_event_id").notNull(),
  temporalWorkflowId: text("temporal_workflow_id").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull().default("user"),
  position: integer("position").notNull(),
  prompt: text("prompt").notNull(),
  resources: jsonb("resources").$type<unknown[]>().notNull().default([]),
  tools: jsonb("tools").$type<unknown[]>().notNull().default([]),
  model: text("model").notNull(),
  reasoningEffort: text("reasoning_effort").notNull(),
  sandboxBackend: text("sandbox_backend").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  queue: index("session_turns_workspace_queue_idx").on(table.workspaceId, table.sessionId, table.status, table.position),
}));

export const sessionEvents = pgTable("session_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  turnId: uuid("turn_id"),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<unknown>().notNull().default({}),
  clientEventId: text("client_event_id"),
  producerId: text("producer_id"),
  producerSeq: integer("producer_seq"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionSequence: uniqueIndex("session_events_workspace_session_sequence_idx").on(table.workspaceId, table.sessionId, table.sequence),
  clientEvent: uniqueIndex("session_events_workspace_client_event_idx").on(table.workspaceId, table.sessionId, table.clientEventId).where(sql`${table.clientEventId} is not null`),
  producer: uniqueIndex("session_events_workspace_producer_idx").on(table.workspaceId, table.sessionId, table.producerId, table.producerSeq).where(sql`${table.producerId} is not null and ${table.producerSeq} is not null`),
  sessionCreated: index("session_events_workspace_session_created_idx").on(table.workspaceId, table.sessionId, table.createdAt),
}));

export const agentRunStates = pgTable("agent_run_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  turnId: uuid("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),
  stateVersion: integer("state_version").notNull(),
  serializedRunState: text("serialized_run_state").notNull(),
  pendingApprovals: jsonb("pending_approvals").$type<unknown[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scheduledTasks = pgTable("scheduled_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  schedule: jsonb("schedule").$type<unknown>().notNull(),
  temporalScheduleId: text("temporal_schedule_id").notNull(),
  runMode: text("run_mode").notNull().default("new_session_per_run"),
  overlapPolicy: text("overlap_policy").notNull().default("allow_concurrent"),
  agentConfig: jsonb("agent_config").$type<unknown>().notNull(),
  reusableSessionId: uuid("reusable_session_id").references(() => sessions.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  temporalScheduleId: uniqueIndex("scheduled_tasks_workspace_temporal_schedule_id_idx").on(table.workspaceId, table.temporalScheduleId),
  status: index("scheduled_tasks_workspace_status_idx").on(table.workspaceId, table.status),
}));

export const scheduledTaskRuns = pgTable("scheduled_task_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => scheduledTasks.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  triggerType: text("trigger_type").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  triggerEventId: uuid("trigger_event_id"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  taskCreated: index("scheduled_task_runs_workspace_task_created_idx").on(table.workspaceId, table.taskId, table.createdAt),
  session: index("scheduled_task_runs_workspace_session_idx").on(table.workspaceId, table.sessionId),
}));

export const githubInstallations = pgTable("github_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  installationId: integer("installation_id").notNull(),
  accountLogin: text("account_login"),
  accountType: text("account_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceInstallation: uniqueIndex("github_installations_workspace_installation_idx").on(table.workspaceId, table.installationId),
  installation: index("github_installations_installation_idx").on(table.installationId),
  workspace: index("github_installations_workspace_idx").on(table.workspaceId),
}));

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  subjectId: text("subject_id"),
  eventType: text("event_type").notNull(),
  quantity: bigint("quantity", { mode: "number" }).notNull(),
  unit: text("unit").notNull(),
  sourceResourceType: text("source_resource_type"),
  sourceResourceId: text("source_resource_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  exportedToBillingAt: timestamp("exported_to_billing_at", { withTimezone: true }),
  billingProviderEventId: text("billing_provider_event_id"),
}, (table) => ({
  idempotency: uniqueIndex("usage_events_idempotency_idx").on(table.idempotencyKey),
  workspaceMetric: index("usage_events_workspace_metric_idx").on(table.workspaceId, table.eventType, table.occurredAt),
  accountMetric: index("usage_events_account_metric_idx").on(table.accountId, table.eventType, table.occurredAt),
}));

export const creditLedgerEntries = pgTable("credit_ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  type: text("type").notNull(),
  amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("usd"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idempotency: uniqueIndex("credit_ledger_entries_idempotency_idx").on(table.idempotencyKey),
  accountCreated: index("credit_ledger_entries_account_created_idx").on(table.accountId, table.createdAt),
}));

export const billingCustomers = pgTable("billing_customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("stripe"),
  providerCustomerId: text("provider_customer_id").notNull(),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  accountProvider: uniqueIndex("billing_customers_account_provider_idx").on(table.accountId, table.provider),
  providerCustomer: uniqueIndex("billing_customers_provider_customer_idx").on(table.provider, table.providerCustomerId),
}));

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  livemode: text("livemode").notNull().default("false"),
  payload: jsonb("payload").$type<unknown>().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").references(() => managedAccounts.id, { onDelete: "set null" }),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  subjectId: text("subject_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  accountCreated: index("audit_events_account_created_idx").on(table.accountId, table.occurredAt),
  workspaceCreated: index("audit_events_workspace_created_idx").on(table.workspaceId, table.occurredAt),
}));

export const packInstallations = pgTable("pack_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  packId: text("pack_id").notNull(),
  status: text("status").notNull().default("active"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspacePack: uniqueIndex("pack_installations_workspace_pack_idx").on(table.workspaceId, table.packId),
  status: index("pack_installations_workspace_status_idx").on(table.workspaceId, table.status),
}));

export const capabilityCatalogItems = pgTable("capability_catalog_items", {
  id: text("id").notNull(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  source: text("source").notNull().default("manual"),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("custom"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  homepageUrl: text("homepage_url"),
  endpointUrl: text("endpoint_url"),
  installUrl: text("install_url"),
  authModel: text("auth_model"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCapability: uniqueIndex("capability_catalog_items_workspace_capability_idx").on(table.workspaceId, table.id),
  kind: index("capability_catalog_items_workspace_kind_idx").on(table.workspaceId, table.kind),
  category: index("capability_catalog_items_workspace_category_idx").on(table.workspaceId, table.category),
  source: index("capability_catalog_items_workspace_source_idx").on(table.workspaceId, table.source),
}));

export const capabilityInstallations = pgTable("capability_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  capabilityId: text("capability_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("active"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCapability: uniqueIndex("capability_installations_workspace_capability_idx").on(table.workspaceId, table.capabilityId),
  kind: index("capability_installations_workspace_kind_idx").on(table.workspaceId, table.kind),
  status: index("capability_installations_workspace_status_idx").on(table.workspaceId, table.status),
}));

export const socialConnections = pgTable("social_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  accountHandle: text("account_handle").notNull(),
  accountName: text("account_name"),
  externalAccountId: text("external_account_id"),
  status: text("status").notNull().default("connected"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  credentialRef: text("credential_ref"),
  tokenMetadata: jsonb("token_metadata").$type<Record<string, unknown>>().notNull().default({}),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceProviderHandle: uniqueIndex("social_connections_workspace_provider_handle_idx").on(table.workspaceId, table.provider, table.accountHandle),
  providerStatus: index("social_connections_workspace_provider_status_idx").on(table.workspaceId, table.provider, table.status),
}));

export const socialPosts = pgTable("social_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => socialConnections.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  externalPostId: text("external_post_id"),
  url: text("url"),
  authorHandle: text("author_handle"),
  text: text("text").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  connectionExternalPost: uniqueIndex("social_posts_workspace_connection_external_post_idx").on(table.workspaceId, table.connectionId, table.externalPostId),
  connectionPublished: index("social_posts_workspace_connection_published_idx").on(table.workspaceId, table.connectionId, table.publishedAt),
  providerPublished: index("social_posts_workspace_provider_published_idx").on(table.workspaceId, table.provider, table.publishedAt),
}));
