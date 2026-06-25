import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, customType } from "drizzle-orm/pg-core";

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
  // White-label agent persona template override. NULL means the deployment
  // default (OPENGENI_AGENT_INSTRUCTIONS_TEMPLATE / DEFAULT_AGENT_INSTRUCTIONS).
  agentInstructions: text("agent_instructions"),
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

export const workspaceEnvironments = pgTable("workspace_environments", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceName: uniqueIndex("workspace_environments_workspace_name_idx").on(table.workspaceId, table.name),
  workspaceCreated: index("workspace_environments_workspace_created_idx").on(table.workspaceId, table.createdAt),
}));

export const workspaceEnvironmentVariables = pgTable("workspace_environment_variables", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  environmentId: uuid("environment_id").notNull().references(() => workspaceEnvironments.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Format: v1:<base64 iv>:<base64 ciphertext||gcm-tag>. Never returned by any API.
  valueEncrypted: text("value_encrypted").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  environmentName: uniqueIndex("workspace_environment_variables_env_name_idx").on(table.workspaceId, table.environmentId, table.name),
  environment: index("workspace_environment_variables_workspace_env_idx").on(table.workspaceId, table.environmentId),
}));

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  initialMessage: text("initial_message").notNull(),
  title: text("title"),
  titleSource: text("title_source"),
  resources: jsonb("resources").$type<unknown[]>().notNull().default([]),
  tools: jsonb("tools").$type<unknown[]>().notNull().default([]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  model: text("model").notNull(),
  sandboxBackend: text("sandbox_backend").notNull(),
  // The OS this session's box runs. Defaults to 'linux' (today's only OS, so
  // every existing + new row is a behavior-preserving no-op). CHECK-constrained
  // to the SandboxOs enum (linux|macos|windows) in migration 0018.
  sandboxOs: text("sandbox_os").notNull().default("linux"),
  // The shared-sandbox group this session's box belongs to. Defaults to the
  // session's OWN id (a singleton group: group === session — today's 1:1
  // behavior). When spawned shared via session_create, set to the PARENT's
  // sandboxGroupId so both run in ONE box. Immutable once set. NOT an FK (the
  // value is this row's id or an ancestor session's id in the same workspace;
  // the live lease row, not a sandbox_groups table, materializes the group).
  // The app generates the uuid and uses it for both id and sandbox_group_id in
  // one insert — it cannot SQL-default to id (id is defaultRandom()).
  sandboxGroupId: uuid("sandbox_group_id").notNull(),
  environmentId: uuid("environment_id").references(() => workspaceEnvironments.id, { onDelete: "set null" }),
  // Non-default first-party MCP token permissions (manager-style sessions);
  // null means the fixed worker default set in @opengeni/runtime.
  firstPartyMcpPermissions: jsonb("first_party_mcp_permissions").$type<string[]>(),
  // The manager session that spawned this one via session_create. Set only
  // when the creating grant carried a worker-signed sessionId claim (a session
  // spawning a worker); null for direct API creates and scheduled-task runs.
  // When set, this worker's terminal-for-now transitions wake the parent so a
  // manager can orchestrate workers without busy-polling. Self-referencing FK,
  // ON DELETE SET NULL so deleting a manager never cascades into its workers.
  parentSessionId: uuid("parent_session_id"),
  // Workspace-scoped CREATE idempotency key. NULL means the create carried no
  // key (each such create is independent). When set, the partial unique index
  // below collapses concurrent/retried creates with the same key in the same
  // workspace to a single session row — the dedup that closes the
  // double-submit/double-dispatch stuck-queued bug.
  createIdempotencyKey: text("create_idempotency_key"),
  temporalWorkflowId: text("temporal_workflow_id"),
  activeTurnId: uuid("active_turn_id"),
  // Actual input tokens reported for the last model call of the most recent
  // turn. The pre-turn client-side compaction trigger reads this as its budget
  // signal (char/4 estimate is the same-turn fallback). Null until a turn with
  // usage has completed.
  lastInputTokens: integer("last_input_tokens"),
  // Operator /compact request flag (client-side compaction path). The API sets
  // it true; the worker honors it BEFORE the next turn's model call by forcing
  // a compaction, then clears it. A durable flag (not a transient signal) so
  // the trigger survives a worker restart and converges before the next turn.
  compactRequested: boolean("compact_requested").notNull().default(false),
  lastSequence: integer("last_sequence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreated: index("sessions_workspace_created_idx").on(table.workspaceId, table.createdAt),
  environment: index("sessions_environment_idx").on(table.workspaceId, table.environmentId),
  parent: index("sessions_parent_idx").on(table.workspaceId, table.parentSessionId),
  // Routing index: resolve session_id -> sandbox_group_id at every lease entry
  // point and enumerate all sessions in a group for attribution/disclosure.
  sandboxGroup: index("sessions_sandbox_group_idx").on(table.workspaceId, table.sandboxGroupId),
  // Partial unique index: one session per (workspace, create_idempotency_key)
  // when a key is present. Concurrent creates racing on the same key see a
  // unique violation on all but one; the domain layer catches it and returns
  // the winning row instead of erroring.
  createIdempotency: uniqueIndex("sessions_workspace_create_idempotency_idx").on(table.workspaceId, table.createIdempotencyKey).where(sql`${table.createIdempotencyKey} is not null`),
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
  // Per-turn OS override. NULL = inherit the session's sandbox_os. CHECK-
  // constrained to the SandboxOs enum (or NULL) in migration 0018.
  sandboxOs: text("sandbox_os"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  queue: index("session_turns_workspace_queue_idx").on(table.workspaceId, table.sessionId, table.status, table.position),
}));

export const sessionGoals = pgTable("session_goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"), // active | paused | completed
  text: text("text").notNull(),
  successCriteria: text("success_criteria"),
  evidence: text("evidence"), // set by goal_complete
  rationale: text("rationale"), // set by goal_pause
  pausedReason: text("paused_reason"), // agent | user_interrupt | api | no_progress | max_auto_continuations | limits
  createdBy: text("created_by").notNull().default("api"), // api | agent | scheduled_task
  version: integer("version").notNull().default(1), // bumped on every set/update; progress signal
  autoContinuations: integer("auto_continuations").notNull().default(0),
  noProgressStreak: integer("no_progress_streak").notNull().default(0),
  maxAutoContinuations: integer("max_auto_continuations"), // per-goal override; a configured settings cap (if any) remains the hard ceiling
  lastContinuationTurnId: uuid("last_continuation_turn_id"),
  versionAtLastContinuation: integer("version_at_last_continuation"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceSession: uniqueIndex("session_goals_workspace_session_idx").on(table.workspaceId, table.sessionId),
  status: index("session_goals_workspace_status_idx").on(table.workspaceId, table.status),
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

// Conversation truth: ordered, verbatim SDK input items (issue #35). The
// model-facing memory store — unredacted and replay-ready. session_events
// remains the redacted human/audit timeline.
export const sessionHistoryItems = pgTable("session_history_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  turnId: uuid("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),
  // Numeric (not integer) so the synthetic compaction-summary row can be
  // inserted at a FRACTIONAL position (boundaryPosition - 0.5) that sorts ahead
  // of the kept tail without colliding with — and thus overwriting — the real
  // prefix row at boundaryPosition - 1. Normally-appended rows keep whole-number
  // positions; only the summary uses the half-step. `mode: "number"` maps the
  // postgres.js string back to a JS number so every reader stays numeric.
  position: numeric("position", { mode: "number" }).notNull(),
  item: jsonb("item").$type<Record<string, unknown>>().notNull(),
  // Live-row flag for client-side context compaction. The read path selects
  // only active rows; a compaction supersedes the summarized prefix (sets this
  // false — never deletes, so the full transcript stays as an audit trail) and
  // inserts ONE synthetic active summary row at the boundary. Defaults true so
  // every existing and normally-appended row is live.
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  positionIdx: uniqueIndex("session_history_items_position_idx").on(table.workspaceId, table.sessionId, table.position),
}));

// Sandbox recovery descriptor, decoupled from the RunState blob: the small
// versioned envelope (provider handle / snapshot ref / manifest) needed to
// reattach, restore, or rebuild the session's sandbox on its next turn.
export const sandboxSessionEnvelopes = pgTable("sandbox_session_envelopes", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  envelope: jsonb("envelope").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionIdx: uniqueIndex("sandbox_session_envelopes_session_idx").on(table.workspaceId, table.sessionId),
}));

// The 4 liveness states of the singleton lease. Exported so the query layer and
// the stateless resume-by-id path share one source of truth for the domain.
export const sandboxLeaseLivenessValues = ["cold", "warming", "warm", "draining"] as const;

// One row per GROUP: the SOLE enforcer of the strict-singleton-box invariant.
// uniqueIndex(workspaceId, sandboxGroupId) + SELECT…FOR UPDATE + cold->warming
// CAS + integer lease_epoch fence. Re-keyed to sandboxGroupId from the start
// (addendum B.2) so today's 1:1 world (sandboxGroupId == session id, set in
// 0018) is a behavior-preserving no-op. Mirrors the account/workspace FK chain
// of sandboxSessionEnvelopes; sandboxGroupId is a BARE uuid (NOT an FK — the
// value is a session id or an ancestor's, and an FK would let a founder's
// deletion cascade-kill a box still in use by a spawned session).
export const sandboxLeases = pgTable("sandbox_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sandboxGroupId: uuid("sandbox_group_id").notNull(),

  liveness: text("liveness", { enum: sandboxLeaseLivenessValues }).notNull().default("cold"),
  refcount: integer("refcount").notNull().default(0),
  turnHolders: integer("turn_holders").notNull().default(0),
  viewerHolders: integer("viewer_holders").notNull().default(0),

  instanceId: text("instance_id"),
  backend: text("backend").notNull(),
  os: text("os").notNull().default("linux"),
  dataPlaneUrl: text("data_plane_url"),
  // The REAL PTY terminal (ttyd pty-ws) rides a SEPARATE provider tunnel (7681)
  // from the desktop noVNC (6080), so its resolved URL is cached independently.
  // Recorded under the epoch fence by recordLeaseTerminalDataPlaneUrl; reset to
  // null on every box re-key (warm-commit / fail / drain), symmetric with
  // data_plane_url.
  terminalDataPlaneUrl: text("terminal_data_plane_url"),

  // integer (NOT bigint): the lease-epoch spike proved a raw int8 read returns a
  // JS STRING from postgres-js, breaking the strict epoch-fence comparison (it
  // was always-true → every turn fenced); int4 returns a JS number, the fix.
  // Epochs never approach 2^31, so the narrower type loses nothing.
  leaseEpoch: integer("lease_epoch").notNull().default(0),

  // The group box-envelope (the "envelope split" Critical): the small recovery
  // descriptor to resume()-by-id the group's box without a per-session join.
  resumeBackendId: text("resume_backend_id"),
  resumeState: jsonb("resume_state").$type<Record<string, unknown>>(),

  // Warm-time billing cursor: last_meter_at = accrual cursor; last_meter_tick =
  // idempotency tick (warm_seconds accrued idempotent on
  // (sandbox_group_id, lease_epoch, last_meter_tick) in P2.1).
  lastMeterAt: timestamp("last_meter_at", { withTimezone: true }),
  lastMeterTick: integer("last_meter_tick").notNull().default(0),

  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  groupIdx: uniqueIndex("sandbox_leases_group_idx").on(table.workspaceId, table.sandboxGroupId),
  reaperIdx: index("sandbox_leases_reaper_idx").on(table.expiresAt)
    .where(sql`${table.liveness} in ('warming','warm','draining')`),
}));

// N rows per group: one per live holder. Makes release idempotent
// (delete-my-row, never blind decrement) and lets the reaper recompute refcount.
export const sandboxLeaseHolders = pgTable("sandbox_lease_holders", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  leaseId: uuid("lease_id").notNull().references(() => sandboxLeases.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["turn", "viewer"] }).notNull(),
  holderId: text("holder_id").notNull(),
  // The attributing session within the (possibly shared) group.
  subjectId: uuid("subject_id"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  holderIdx: uniqueIndex("sandbox_lease_holders_holder_idx").on(table.leaseId, table.kind, table.holderId),
  staleIdx: index("sandbox_lease_holders_stale_idx").on(table.kind, table.lastHeartbeatAt),
  leaseIdx: index("sandbox_lease_holders_lease_idx").on(table.leaseId),
}));

// The recording lifecycle states (P4.3). Exported so the activity + the query
// layer share one source of truth for the §3.1 state machine.
export const sessionRecordingStateValues = ["recording", "finalizing", "available", "failed"] as const;
export const sessionRecordingModeValues = ["manual", "on-turn", "on-verify"] as const;
export const sessionRecordingCodecValues = ["h264-mp4", "vp9-webm"] as const;

// One row per recording — the durable index for the "agent films itself proving
// the fix" loop. ffmpeg x11grab of the SAME :0 humans watch, finalized by
// reading the bytes off the box and PUTting them to @opengeni/storage in the
// process that holds the resumed-by-id handle (never a Temporal payload, F10).
// Mirrors the account/workspace/session FK chain of sandboxSessionEnvelopes;
// turnId is ON DELETE SET NULL (a deleted turn must not kill the artifact row).
export const sessionRecordings = pgTable("session_recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  turnId: uuid("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),

  state: text("state", { enum: sessionRecordingStateValues }).notNull(),
  mode: text("mode", { enum: sessionRecordingModeValues }).notNull(),
  codec: text("codec", { enum: sessionRecordingCodecValues }).notNull(),

  storageKey: text("storage_key"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  durationSeconds: numeric("duration_seconds").$type<number>(),

  width: integer("width").notNull(),
  height: integer("height").notNull(),

  reason: text("reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
}, (table) => ({
  sessionIdx: index("session_recordings_session_idx").on(table.workspaceId, table.sessionId, table.createdAt),
}));

// Channel-A interactive PTY sessions (P4.4 / modules/08-channel-a.md §3.1). The
// ONLY new persistent state Channel A needs — FS/Git reads are stateless point
// queries; an interactive PTY is a live in-box process keyed by the SDK's numeric
// exec-session id (writeStdin({sessionId})). We map our UUID ptyId <-> that id,
// the owning workspace/session, the lease_epoch that fences it to the box it was
// opened on (a box re-key strands the PTY -> reaped with reason owner_gone), and
// a last_input_at heartbeat so the reaper can kill idle/orphaned PTYs. Mirrors
// the account/workspace/session FK chain of sandboxSessionEnvelopes.
export const sandboxPtySessions = pgTable("sandbox_pty_sessions", {
  id: uuid("id").primaryKey().defaultRandom(), // == ptyId on the wire
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  // The SDK numeric exec-session id used by writeStdin({ sessionId }). Null until
  // the open exec yields a still-running process (a fast-exiting shell has none).
  execSessionId: integer("exec_session_id"),
  leaseEpoch: integer("lease_epoch").notNull(), // fenced to the box that opened it
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  shell: text("shell").notNull(),
  cwd: text("cwd").notNull(),
  status: text("status").notNull().default("open"), // 'open' | 'closed'
  // The viewer grant/subject that opened it (free-text — access subjects are not
  // always UUIDs, M5; so a text column, never a uuid NOT NULL).
  openedBy: text("opened_by").notNull(),
  lastInputAt: timestamp("last_input_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (table) => ({
  openIdx: index("sandbox_pty_sessions_session_idx")
    .on(table.workspaceId, table.sessionId)
    .where(sql`${table.status} = 'open'`),
}));

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
  environmentId: uuid("environment_id").references(() => workspaceEnvironments.id, { onDelete: "restrict" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  temporalScheduleId: uniqueIndex("scheduled_tasks_workspace_temporal_schedule_id_idx").on(table.workspaceId, table.temporalScheduleId),
  status: index("scheduled_tasks_workspace_status_idx").on(table.workspaceId, table.status),
  environment: index("scheduled_tasks_environment_idx").on(table.workspaceId, table.environmentId),
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

export const workspacePacks = pgTable("workspace_packs", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  packId: text("pack_id").notNull(),
  manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspacePack: uniqueIndex("workspace_packs_workspace_pack_idx").on(table.workspaceId, table.packId),
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
