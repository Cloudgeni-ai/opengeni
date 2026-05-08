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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  baseFile: uniqueIndex("documents_base_file_idx").on(table.baseId, table.fileId),
  baseStatus: index("documents_base_status_idx").on(table.baseId, table.status),
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
