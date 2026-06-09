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

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
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
});

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  objectKey: uniqueIndex("files_object_key_idx").on(table.objectKey),
  status: index("files_status_idx").on(table.status),
}));

export const fileUploads = pgTable("file_uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  fileId: index("file_uploads_file_id_idx").on(table.fileId),
  status: index("file_uploads_status_idx").on(table.status),
}));

export const documentBases = pgTable("document_bases", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  baseId: uuid("base_id").notNull().references(() => documentBases.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("queued"),
  title: text("title").notNull(),
  parser: text("parser").notNull().default("liteparse"),
  chunkCount: integer("chunk_count").notNull().default(0),
  error: text("error"),
  sourceKind: text("source_kind").notNull().default("manual_upload"),
  sourceUri: text("source_uri"),
  sourceExternalId: text("source_external_id"),
  sourceTitle: text("source_title"),
  sourceAuthor: text("source_author"),
  sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  sourceVersion: text("source_version"),
  aclTags: jsonb("acl_tags").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  baseFile: uniqueIndex("documents_base_file_idx").on(table.baseId, table.fileId),
  baseStatus: index("documents_base_status_idx").on(table.baseId, table.status),
  sourceKind: index("documents_source_kind_idx").on(table.sourceKind),
  sourceExternalId: index("documents_source_external_id_idx").on(table.sourceExternalId),
}));

export const documentChunks = pgTable("document_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  documentIndex: uniqueIndex("document_chunks_document_index_idx").on(table.documentId, table.chunkIndex),
  base: index("document_chunks_base_idx").on(table.baseId),
}));

export const knowledgeMemories = pgTable("knowledge_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("proposed"),
  kind: text("kind").notNull().default("semantic"),
  scope: text("scope").notNull().default("workspace"),
  text: text("text").notNull(),
  sourceRefs: jsonb("source_refs").$type<unknown[]>().notNull().default([]),
  confidence: integer("confidence").notNull().default(50),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdBySessionId: uuid("created_by_session_id").references(() => sessions.id, { onDelete: "set null" }),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  status: index("knowledge_memories_status_idx").on(table.status),
  kind: index("knowledge_memories_kind_idx").on(table.kind),
  scope: index("knowledge_memories_scope_idx").on(table.scope),
  createdBySession: index("knowledge_memories_created_by_session_idx").on(table.createdBySessionId),
}));

export const sessionTurns = pgTable("session_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  queue: index("session_turns_queue_idx").on(table.sessionId, table.status, table.position),
}));

export const sessionEvents = pgTable("session_events", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  sessionSequence: uniqueIndex("session_events_session_sequence_idx").on(table.sessionId, table.sequence),
  clientEvent: uniqueIndex("session_events_client_event_idx").on(table.sessionId, table.clientEventId).where(sql`${table.clientEventId} is not null`),
  producer: uniqueIndex("session_events_producer_idx").on(table.sessionId, table.producerId, table.producerSeq).where(sql`${table.producerId} is not null and ${table.producerSeq} is not null`),
  sessionCreated: index("session_events_session_created_idx").on(table.sessionId, table.createdAt),
}));

export const agentRunStates = pgTable("agent_run_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  turnId: uuid("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),
  stateVersion: integer("state_version").notNull(),
  serializedRunState: text("serialized_run_state").notNull(),
  pendingApprovals: jsonb("pending_approvals").$type<unknown[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scheduledTasks = pgTable("scheduled_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  temporalScheduleId: uniqueIndex("scheduled_tasks_temporal_schedule_id_idx").on(table.temporalScheduleId),
  status: index("scheduled_tasks_status_idx").on(table.status),
}));

export const scheduledTaskRuns = pgTable("scheduled_task_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  taskCreated: index("scheduled_task_runs_task_created_idx").on(table.taskId, table.createdAt),
  session: index("scheduled_task_runs_session_idx").on(table.sessionId),
}));

export const packInstallations = pgTable("pack_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  packId: text("pack_id").notNull(),
  status: text("status").notNull().default("active"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  packId: uniqueIndex("pack_installations_pack_id_idx").on(table.packId),
  status: index("pack_installations_status_idx").on(table.status),
}));

export const capabilityCatalogItems = pgTable("capability_catalog_items", {
  id: text("id").primaryKey(),
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
  kind: index("capability_catalog_items_kind_idx").on(table.kind),
  category: index("capability_catalog_items_category_idx").on(table.category),
  source: index("capability_catalog_items_source_idx").on(table.source),
}));

export const capabilityInstallations = pgTable("capability_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  capabilityId: text("capability_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("active"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  capabilityId: uniqueIndex("capability_installations_capability_id_idx").on(table.capabilityId),
  kind: index("capability_installations_kind_idx").on(table.kind),
  status: index("capability_installations_status_idx").on(table.status),
}));

export const socialConnections = pgTable("social_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  providerHandle: uniqueIndex("social_connections_provider_handle_idx").on(table.provider, table.accountHandle),
  providerStatus: index("social_connections_provider_status_idx").on(table.provider, table.status),
}));

export const socialPosts = pgTable("social_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  connectionExternalPost: uniqueIndex("social_posts_connection_external_post_idx").on(table.connectionId, table.externalPostId),
  connectionPublished: index("social_posts_connection_published_idx").on(table.connectionId, table.publishedAt),
  providerPublished: index("social_posts_provider_published_idx").on(table.provider, table.publishedAt),
}));
