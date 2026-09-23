import type {
  KnowledgeEntryContent,
  KnowledgeEntryWriteReceipt,
  AgentLearningOverrides,
} from "@opengeni/contracts";
import {
  boolean,
  customType,
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
import { losslessCodecVersion, losslessJsonb, losslessText } from "./lossless-columns";

// SQL owns composite foreign keys, immutable history guards, tenant policies
// and lifecycle-only grants. These mappings are not an alternate write API.
export const agentLearningRevisions = pgTable(
  "agent_learning_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    originWorkspaceId: uuid("origin_workspace_id").notNull(),
    ownerKey: text("owner_key").notNull(),
    subjectId: text("subject_id"),
    contextKey: text("context_key").notNull().default("defaults"),
    version: integer("version").notNull(),
    settings: jsonb("settings").$type<AgentLearningOverrides>().notNull(),
    operationId: uuid("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    current: index("agent_learning_revisions_current_idx").on(
      t.accountId,
      t.ownerKey,
      t.contextKey,
      t.version,
    ),
    operation: uniqueIndex("agent_learning_revisions_operation_idx").on(t.accountId, t.operationId),
  }),
);

export const agentLearningSnapshots = pgTable(
  "agent_learning_snapshots",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ identity: primaryKey({ columns: [t.accountId, t.turnId] }) }),
);

export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    originWorkspaceId: uuid("origin_workspace_id").notNull(),
    scope: text("scope").$type<"organization" | "workspace" | "personal">().notNull(),
    scopeWorkspaceId: uuid("scope_workspace_id"),
    scopeSubjectId: text("scope_subject_id"),
    version: integer("version").notNull().default(0),
    publishedRevisionId: uuid("published_revision_id"),
    latestRevisionId: uuid("latest_revision_id"),
    archived: boolean("archived").notNull().default(false),
    legacyMemoryId: uuid("legacy_memory_id"),
    legacyDocumentId: uuid("legacy_document_id"),
    legacyClaimId: uuid("legacy_claim_id"),
    preparedFileId: uuid("prepared_file_id"),
    documentPreparation: jsonb("document_preparation"),
    legacyDocumentVersionId: uuid("legacy_document_version_id"),
    legacyScopeWorkspaceId: uuid("legacy_scope_workspace_id"),
    accessDocumentId: uuid("access_document_id"),
    accessFileId: uuid("access_file_id"),
    legacyScopeType: text("legacy_scope_type"),
    legacyScopeRoleKey: text("legacy_scope_role_key"),
    legacyScopeSessionId: uuid("legacy_scope_session_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scope: index("knowledge_entries_scope_idx").on(
      t.accountId,
      t.scope,
      t.scopeWorkspaceId,
      t.scopeSubjectId,
      t.id,
    ),
  }),
);

export const knowledgeReviewBatches = pgTable("knowledge_review_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  originWorkspaceId: uuid("origin_workspace_id").notNull(),
  ownerKey: text("owner_key").notNull(),
  sessionId: uuid("session_id"),
  turnId: uuid("turn_id"),
  scheduledTaskRunId: uuid("scheduled_task_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeEntryRevisions = pgTable("knowledge_entry_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  entryId: uuid("entry_id").notNull(),
  number: integer("number").notNull(),
  changeKind: text("change_kind").notNull().default("upsert"),
  body: losslessJsonb("body").$type<KnowledgeEntryContent>().notNull(),
  bodyCodecVersion: losslessCodecVersion("body_codec_version"),
  legacySnapshot: jsonb("legacy_snapshot").$type<Record<string, unknown>>(),
  preview: losslessText("preview").notNull().default(""),
  previewCodecVersion: losslessCodecVersion("preview_codec_version"),
  previousRevisionId: uuid("previous_revision_id"),
  restoredFromRevisionId: uuid("restored_from_revision_id"),
  actor: jsonb("actor").notNull(),
  createdBySessionId: uuid("created_by_session_id"),
  createdByTurnId: uuid("created_by_turn_id"),
  reviewBatchId: uuid("review_batch_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeEntryLinks = pgTable(
  "knowledge_entry_links",
  {
    accountId: uuid("account_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    targetEntryId: uuid("target_entry_id").notNull(),
    targetRevisionId: uuid("target_revision_id"),
    relation: text("relation").notNull(),
  },
  (t) => ({
    identity: primaryKey({ columns: [t.revisionId, t.ordinal] }),
    target: index("knowledge_entry_links_target_idx").on(
      t.accountId,
      t.targetEntryId,
      t.relation,
      t.revisionId,
    ),
  }),
);

export const knowledgeEntryDecisions = pgTable("knowledge_entry_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  entryId: uuid("entry_id").notNull(),
  revisionId: uuid("revision_id").notNull(),
  version: integer("version").notNull(),
  outcome: text("outcome").notNull(),
  actor: jsonb("actor").notNull(),
  policySnapshot: jsonb("policy_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeEntryOperations = pgTable(
  "knowledge_entry_operations",
  {
    accountId: uuid("account_id").notNull(),
    originWorkspaceId: uuid("origin_workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    actor: jsonb("actor").notNull(),
    requestHash: text("request_hash").notNull(),
    receipt: jsonb("receipt").$type<KnowledgeEntryWriteReceipt>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ identity: primaryKey({ columns: [t.accountId, t.operationId] }) }),
);

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
export const knowledgeEntrySearch = pgTable(
  "knowledge_entry_search",
  {
    accountId: uuid("account_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    searchVector: tsvector("search_vector").notNull(),
  },
  (t) => ({
    identity: primaryKey({ columns: [t.accountId, t.entryId, t.revisionId, t.chunkIndex] }),
  }),
);

export const knowledgeIndexJobs = pgTable("knowledge_index_jobs", {
  accountId: uuid("account_id").notNull(),
  entryId: uuid("entry_id").notNull(),
  revisionId: uuid("revision_id").primaryKey(),
  state: text("state")
    .$type<"pending" | "running" | "ready" | "obsolete">()
    .notNull()
    .default("pending"),
  model: text("model"),
  dimensions: integer("dimensions"),
  generation: integer("generation").notNull().default(0),
  completedGeneration: integer("completed_generation"),
  nextIndex: integer("next_index").notNull().default(0),
  leaseId: uuid("lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastFailure: text("last_failure"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The provider is configurable. SQL validates each row's dimensions; a model
// change builds a new generation before replacing the completed projection.
const knowledgeVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as number[],
});
export const knowledgeEntryVectors = pgTable(
  "knowledge_entry_vectors",
  {
    accountId: uuid("account_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    generation: integer("generation").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    field: text("field").$type<"title" | "content">().notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    text: losslessText("text").notNull(),
    textCodecVersion: losslessCodecVersion("text_codec_version").notNull(),
    embedding: knowledgeVector("embedding").notNull(),
  },
  (t) => ({
    identity: primaryKey({
      columns: [t.accountId, t.entryId, t.revisionId, t.generation, t.chunkIndex],
    }),
  }),
);

export const agentInstructionOperations = pgTable(
  "agent_instruction_operations",
  {
    accountId: uuid("account_id").notNull(),
    originWorkspaceId: uuid("origin_workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    requestHash: text("request_hash").notNull(),
    actor: jsonb("actor").notNull(),
    receipt: jsonb("receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ identity: primaryKey({ columns: [t.accountId, t.operationId] }) }),
);
