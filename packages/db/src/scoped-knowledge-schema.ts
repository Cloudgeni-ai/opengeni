import { sql } from "drizzle-orm";
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

// Cross-row/composite foreign keys, immutable-history triggers, lifecycle
// functions, and FORCE-RLS policies live in migration 0154. This schema leaf is
// deliberately cycle-free so the repository module can use typed table names
// without making the main schema declaration harder to navigate.

function tenantScopeColumns() {
  return {
    accountId: uuid("account_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeWorkspaceId: uuid("scope_workspace_id"),
    scopeSubjectId: text("scope_subject_id"),
    scopeKey: text("scope_key").notNull(),
  };
}

function actorColumns() {
  return {
    actorKind: text("actor_kind").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id"),
  };
}

export const knowledgeOperationReceipts = pgTable(
  "knowledge_operation_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    operationKind: text("operation_kind").notNull(),
    operationNamespace: text("operation_namespace").notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    resultId: uuid("result_id").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("knowledge_operation_receipts_operation_uq").on(
      table.accountId,
      table.operationKind,
      table.operationNamespace,
      table.operationId,
    ),
    result: index("knowledge_operation_receipts_result_idx").on(
      table.operationKind,
      table.resultId,
    ),
  }),
);

export const knowledgeProviders = pgTable(
  "knowledge_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    providerKey: text("provider_key").notNull(),
    externalTenantId: text("external_tenant_id").notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }).notNull().default(1),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalIdentity: uniqueIndex("knowledge_providers_external_identity_uq").on(
      table.accountId,
      table.providerKey,
      table.externalTenantId,
    ),
    operation: uniqueIndex("knowledge_providers_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    scopeIdentity: uniqueIndex("knowledge_providers_scope_identity_uq").on(
      table.accountId,
      table.id,
      table.scopeKey,
    ),
    scopeLifecycle: index("knowledge_providers_scope_lifecycle_idx").on(
      table.accountId,
      table.scopeKey,
      table.lifecycleState,
    ),
  }),
);

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    providerId: uuid("provider_id").notNull(),
    externalSourceId: text("external_source_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceUri: text("source_uri"),
    currentAclGeneration: bigint("current_acl_generation", { mode: "number" }),
    syncGeneration: bigint("sync_generation", { mode: "number" }).notNull().default(0),
    syncCursor: text("sync_cursor"),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }).notNull().default(1),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalIdentity: uniqueIndex("knowledge_sources_external_identity_uq").on(
      table.providerId,
      table.externalSourceId,
    ),
    operation: uniqueIndex("knowledge_sources_operation_uq").on(table.accountId, table.operationId),
    scopeIdentity: uniqueIndex("knowledge_sources_scope_identity_uq").on(
      table.accountId,
      table.id,
      table.scopeKey,
    ),
    currentAcl: uniqueIndex("knowledge_sources_current_acl_identity_uq").on(
      table.accountId,
      table.id,
      table.currentAclGeneration,
    ),
    provider: index("knowledge_sources_provider_idx").on(table.providerId, table.externalSourceId),
  }),
);

export const knowledgeSourceAclVersions = pgTable(
  "knowledge_source_acl_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    sourceId: uuid("source_id").notNull(),
    sourceScopeKey: text("source_scope_key").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    aclVersion: text("acl_version"),
    aclHash: text("acl_hash").notNull(),
    agentAccess: boolean("agent_access").notNull().default(true),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceGeneration: uniqueIndex("knowledge_source_acl_versions_source_generation_uq").on(
      table.accountId,
      table.sourceId,
      table.generation,
    ),
    sourceOperation: uniqueIndex("knowledge_source_acl_versions_source_operation_uq").on(
      table.sourceId,
      table.operationId,
    ),
    sourceTimeline: index("knowledge_source_acl_versions_source_timeline_idx").on(
      table.sourceId,
      table.generation,
    ),
  }),
);

export const knowledgeSyncRuns = pgTable(
  "knowledge_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    sourceId: uuid("source_id").notNull(),
    inputSyncGeneration: bigint("input_sync_generation", { mode: "number" }).notNull(),
    inputLifecycleGeneration: bigint("input_lifecycle_generation", { mode: "number" }).notNull(),
    inputCursor: text("input_cursor"),
    inputHash: text("input_hash").notNull(),
    operationId: text("operation_id").notNull(),
    state: text("state").notNull().default("started"),
    outputCursor: text("output_cursor"),
    watermark: timestamp("watermark", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    errorCode: text("error_code"),
    completionHash: text("completion_hash"),
    ...actorColumns(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    sourceOperation: uniqueIndex("knowledge_sync_runs_source_operation_uq").on(
      table.sourceId,
      table.operationId,
    ),
    sourceState: index("knowledge_sync_runs_source_state_idx").on(
      table.sourceId,
      table.state,
      table.startedAt,
    ),
  }),
);

export const knowledgeSourceObjects = pgTable(
  "knowledge_source_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    sourceId: uuid("source_id").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    documentId: uuid("document_id"),
    lifecycleState: text("lifecycle_state").notNull().default("active"),
    lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }).notNull().default(1),
    versionGeneration: bigint("version_generation", { mode: "number" }).notNull().default(0),
    currentVersionId: uuid("current_version_id"),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalIdentity: uniqueIndex("knowledge_source_objects_external_identity_uq").on(
      table.sourceId,
      table.externalObjectId,
    ),
    sourceOperation: uniqueIndex("knowledge_source_objects_source_operation_uq").on(
      table.sourceId,
      table.operationId,
    ),
    scopeIdentity: uniqueIndex("knowledge_source_objects_scope_identity_uq").on(
      table.accountId,
      table.id,
      table.scopeKey,
    ),
    sourceIdentity: uniqueIndex("knowledge_source_objects_source_identity_uq").on(
      table.accountId,
      table.id,
      table.sourceId,
      table.scopeKey,
    ),
    currentVersion: uniqueIndex("knowledge_source_objects_current_version_identity_uq").on(
      table.accountId,
      table.id,
      table.currentVersionId,
    ),
  }),
);

export const knowledgeDocumentVersions = pgTable(
  "knowledge_document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    sourceId: uuid("source_id").notNull(),
    objectId: uuid("object_id").notNull(),
    versionGeneration: bigint("version_generation", { mode: "number" }).notNull(),
    externalVersionId: text("external_version_id").notNull(),
    contentSha256: text("content_sha256").notNull(),
    ingestionKey: text("ingestion_key").notNull(),
    sourceCursor: text("source_cursor"),
    sourceMetadata: jsonb("source_metadata").$type<Record<string, unknown>>().notNull().default({}),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    aclVersionId: uuid("acl_version_id").notNull(),
    aclGeneration: bigint("acl_generation", { mode: "number" }).notNull(),
    documentId: uuid("document_id"),
    fileId: uuid("file_id"),
    locationMetadata: jsonb("location_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    objectGeneration: uniqueIndex("knowledge_document_versions_object_generation_uq").on(
      table.accountId,
      table.objectId,
      table.versionGeneration,
    ),
    objectExternalVersion: uniqueIndex("knowledge_document_versions_object_external_version_uq").on(
      table.objectId,
      table.externalVersionId,
    ),
    objectIngestion: uniqueIndex("knowledge_document_versions_object_ingestion_uq").on(
      table.objectId,
      table.ingestionKey,
    ),
    objectOperation: uniqueIndex("knowledge_document_versions_object_operation_uq").on(
      table.objectId,
      table.operationId,
    ),
    objectIdentity: uniqueIndex("knowledge_document_versions_object_identity_uq").on(
      table.accountId,
      table.objectId,
      table.id,
    ),
    scopeIdentity: uniqueIndex("knowledge_document_versions_scope_identity_uq").on(
      table.accountId,
      table.id,
      table.scopeKey,
    ),
  }),
);

export const knowledgeLifecycleEvents = pgTable(
  "knowledge_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    targetKind: text("target_kind").notNull(),
    providerId: uuid("provider_id"),
    sourceId: uuid("source_id"),
    objectId: uuid("object_id"),
    eventType: text("event_type").notNull(),
    oldState: text("old_state").notNull(),
    newState: text("new_state").notNull(),
    oldGeneration: bigint("old_generation", { mode: "number" }).notNull(),
    newGeneration: bigint("new_generation", { mode: "number" }).notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    reasonCode: text("reason_code").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetTimeline: index("knowledge_lifecycle_events_target_timeline_idx").on(
      table.targetKind,
      table.providerId,
      table.sourceId,
      table.objectId,
      table.createdAt,
    ),
  }),
);

export const knowledgeEntities = pgTable(
  "knowledge_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    entityType: text("entity_type").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    displayName: text("display_name").notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    naturalIdentity: uniqueIndex("knowledge_entities_natural_identity_uq").on(
      table.accountId,
      table.scopeKey,
      table.entityType,
      table.normalizedKey,
    ),
    operation: uniqueIndex("knowledge_entities_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    scopeIdentity: uniqueIndex("knowledge_entities_scope_identity_uq").on(
      table.accountId,
      table.id,
      table.scopeKey,
    ),
  }),
);

export const knowledgeEntityAliases = pgTable(
  "knowledge_entity_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    entityId: uuid("entity_id").notNull(),
    entityType: text("entity_type").notNull(),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    naturalIdentity: uniqueIndex("knowledge_entity_aliases_natural_identity_uq").on(
      table.accountId,
      table.scopeKey,
      table.entityType,
      table.normalizedAlias,
    ),
    operation: uniqueIndex("knowledge_entity_aliases_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    entity: index("knowledge_entity_aliases_entity_idx").on(table.entityId, table.createdAt),
  }),
);

export const knowledgeFacts = pgTable(
  "knowledge_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    subjectEntityId: uuid("subject_entity_id").notNull(),
    predicateKey: text("predicate_key").notNull(),
    objectKind: text("object_kind").notNull(),
    objectEntityId: uuid("object_entity_id"),
    objectValue: jsonb("object_value").$type<unknown>(),
    objectHash: text("object_hash").notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    naturalIdentity: uniqueIndex("knowledge_facts_natural_identity_uq").on(
      table.accountId,
      table.scopeKey,
      table.subjectEntityId,
      table.predicateKey,
      table.objectHash,
    ),
    operation: uniqueIndex("knowledge_facts_operation_uq").on(table.accountId, table.operationId),
    scopeIdentity: uniqueIndex("knowledge_facts_scope_identity_uq").on(
      table.accountId,
      table.id,
      table.scopeKey,
    ),
  }),
);

export const knowledgeClaims = pgTable(
  "knowledge_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    factId: uuid("fact_id").notNull(),
    origin: text("origin").notNull(),
    confidenceBps: integer("confidence_bps").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    extractionMethod: text("extraction_method").notNull(),
    extractionMetadata: jsonb("extraction_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    modelProvider: text("model_provider"),
    modelName: text("model_name"),
    modelVersion: text("model_version"),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("knowledge_claims_operation_uq").on(table.accountId, table.operationId),
    scopeIdentity: uniqueIndex("knowledge_claims_scope_identity_uq").on(
      table.accountId,
      table.id,
      table.scopeKey,
    ),
    factTimeline: index("knowledge_claims_fact_timeline_idx").on(
      table.factId,
      table.effectiveAt,
      table.createdAt,
    ),
  }),
);

export const knowledgeClaimRelations = pgTable(
  "knowledge_claim_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    relationType: text("relation_type").notNull(),
    fromClaimId: uuid("from_claim_id").notNull(),
    toClaimId: uuid("to_claim_id").notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    naturalIdentity: uniqueIndex("knowledge_claim_relations_natural_identity_uq").on(
      table.relationType,
      table.fromClaimId,
      table.toClaimId,
    ),
    operation: uniqueIndex("knowledge_claim_relations_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
  }),
);

export const knowledgeClaimEvidence = pgTable(
  "knowledge_claim_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    claimId: uuid("claim_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    polarity: text("polarity").notNull(),
    documentChunkId: uuid("document_chunk_id"),
    chunkIndex: integer("chunk_index"),
    locator: text("locator"),
    quoteHash: text("quote_hash"),
    contentHash: text("content_hash").notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    naturalIdentity: uniqueIndex("knowledge_claim_evidence_natural_identity_uq").on(
      table.claimId,
      table.documentVersionId,
      table.polarity,
      sql`coalesce(${table.documentChunkId}::text, '')`,
      sql`coalesce(${table.locator}, '')`,
    ),
    operation: uniqueIndex("knowledge_claim_evidence_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    claimPolarity: index("knowledge_claim_evidence_claim_polarity_idx").on(
      table.claimId,
      table.polarity,
      table.createdAt,
    ),
  }),
);

export const knowledgeClaimReviews = pgTable(
  "knowledge_claim_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    claimId: uuid("claim_id").notNull(),
    reviewRevision: bigint("review_revision", { mode: "number" })
      .notNull()
      .default(sql`nextval('knowledge_claim_review_revision_seq')`),
    state: text("state").notNull(),
    reason: text("reason").notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimRevision: uniqueIndex("knowledge_claim_reviews_claim_revision_uq").on(
      table.claimId,
      table.reviewRevision,
    ),
    operation: uniqueIndex("knowledge_claim_reviews_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    claimTimeline: index("knowledge_claim_reviews_claim_timeline_idx").on(
      table.claimId,
      table.reviewRevision,
    ),
  }),
);

export const knowledgeChangeProposals = pgTable(
  "knowledge_change_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantScopeColumns(),
    targetKind: text("target_kind").notNull(),
    targetScope: text("target_scope").notNull(),
    targetKey: text("target_key"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    claimId: uuid("claim_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    status: text("status").notNull().default("proposed"),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    ...actorColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("knowledge_change_proposals_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    claimTimeline: index("knowledge_change_proposals_claim_timeline_idx").on(
      table.claimId,
      table.createdAt,
    ),
  }),
);
