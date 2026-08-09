import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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

// Tenant/workspace and cross-table foreign keys, FORCE-RLS policies, immutable
// history guards, and deferred sequence/causal validation live in migration
// 0184. This leaf intentionally does not import schema.ts, avoiding a cycle.

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export type EditableArtifactCausalFrontierRow = Array<{
  replicaId: string;
  counter: number;
}>;

export type EditableArtifactOutboxEventRow = Record<string, unknown>;
export type EditableArtifactIdempotencyResultRow = Record<string, unknown>;

function scopeColumns() {
  return {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
  };
}

const stableIdSql = (column: unknown) => sql`${column} ~ '^[0-9a-f]{32}$' and ${column} !~ '^0+$'`;
const replicaIdSql = (column: unknown) => sql`${column} ~ '^[0-9a-f]{16}$' and ${column} !~ '^0+$'`;
const sha256Sql = (column: unknown) => sql`${column} ~ '^sha256:[0-9a-f]{64}$'`;

/** Local monotonic fence for workspace-scoped artifact creation policy. */
export const editableArtifactScopeAuthorizationHeads = pgTable(
  "editable_artifact_scope_authorization_heads",
  {
    ...scopeColumns(),
    createRevision: bigint("create_revision", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_scope_authorization_heads_pk",
      columns: [table.accountId, table.workspaceId],
    }),
    revisionValid: check(
      "editable_artifact_scope_authorization_heads_revision_chk",
      sql`${table.createRevision} between 1 and 9007199254740991`,
    ),
  }),
);

/**
 * One-use live admission capabilities. The bearer token is never persisted;
 * only its digest is stored, and production access is through owner-defined
 * atomic routines rather than direct table grants.
 */
export const editableArtifactLiveTickets = pgTable(
  "editable_artifact_live_tickets",
  {
    tokenDigest: text("token_digest").primaryKey(),
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    modality: text("modality", {
      enum: ["spreadsheet", "presentation", "document"],
    }).notNull(),
    actorKind: text("actor_kind", { enum: ["human", "agent", "service"] }).notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    replicaId: text("replica_id").notNull(),
    agentSessionId: text("agent_session_id"),
    agentTurnId: text("agent_turn_id"),
    agentAttemptId: text("agent_attempt_id"),
    agentGeneration: integer("agent_generation"),
    serviceName: text("service_name"),
    allowEdit: boolean("allow_edit").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiry: index("editable_artifact_live_tickets_expiry_idx").on(
      table.expiresAt,
      table.tokenDigest,
    ),
    digestValid: check("editable_artifact_live_tickets_digest_chk", sha256Sql(table.tokenDigest)),
    identityValid: check(
      "editable_artifact_live_tickets_identity_chk",
      sql`${stableIdSql(table.artifactId)} and ${replicaIdSql(table.replicaId)}`,
    ),
  }),
);

export const editableArtifacts = pgTable(
  "editable_artifacts",
  {
    ...scopeColumns(),
    id: text("id").notNull(),
    modality: text("modality", {
      enum: ["spreadsheet", "presentation", "document"],
    }).notNull(),
    title: text("title").notNull(),
    lifecycleState: text("lifecycle_state", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    authorizationRevision: bigint("authorization_revision", { mode: "number" }).notNull(),
    headSequence: bigint("head_sequence", { mode: "number" }).notNull().default(0),
    causalFrontier: jsonb("causal_frontier").$type<EditableArtifactCausalFrontierRow>(),
    stateHash: text("state_hash").notNull(),
    currentSnapshotId: text("current_snapshot_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifacts_pk",
      columns: [table.accountId, table.workspaceId, table.id],
    }),
    workspaceTimeline: index("editable_artifacts_workspace_timeline_idx").on(
      table.workspaceId,
      table.lifecycleState,
      table.updatedAt.desc(),
      table.id,
    ),
    identityValid: check("editable_artifacts_identity_chk", stableIdSql(table.id)),
    authorizationRevisionValid: check(
      "editable_artifacts_authorization_revision_chk",
      sql`${table.authorizationRevision} between 1 and 9007199254740991`,
    ),
    headValid: check(
      "editable_artifacts_head_chk",
      sql`${table.headSequence} between 0 and 9007199254740991`,
    ),
    stateHashValid: check("editable_artifacts_state_hash_chk", sha256Sql(table.stateHash)),
    modalityStateValid: check(
      "editable_artifacts_modality_state_chk",
      sql`(${table.modality} = 'spreadsheet' and jsonb_typeof(${table.causalFrontier}) = 'array')
        or (${table.modality} in ('document', 'presentation') and ${table.causalFrontier} is null)`,
    ),
  }),
);

export const editableArtifactTransactions = pgTable(
  "editable_artifact_transactions",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    modality: text("modality", {
      enum: ["spreadsheet", "presentation", "document"],
    }).notNull(),
    id: text("id").notNull(),
    clientTransactionId: text("client_transaction_id").notNull(),
    previousLocalTransactionId: text("previous_local_transaction_id"),
    requestHash: text("request_hash").notNull(),
    intentHash: text("intent_hash").notNull(),
    intentEnvelopeVersion: integer("intent_envelope_version").notNull(),
    intentProtocolVersion: integer("intent_protocol_version").notNull(),
    commandProtocolVersion: integer("command_protocol_version").notNull(),
    intentByteSize: integer("intent_byte_size").notNull(),
    intentBytes: bytea("intent_bytes").notNull(),
    parentHeadSequence: bigint("parent_head_sequence", { mode: "number" }).notNull(),
    sequenceStart: bigint("sequence_start", { mode: "number" }).notNull(),
    sequenceEnd: bigint("sequence_end", { mode: "number" }).notNull(),
    priorStateHash: text("prior_state_hash").notNull(),
    causalBase: jsonb("causal_base").$type<EditableArtifactCausalFrontierRow>(),
    resolvedCausalBase: jsonb("resolved_causal_base").$type<EditableArtifactCausalFrontierRow>(),
    resultingCausalFrontier: jsonb(
      "resulting_causal_frontier",
    ).$type<EditableArtifactCausalFrontierRow>(),
    selectiveUndoTargets: jsonb("selective_undo_targets").$type<string[]>(),
    stateHash: text("state_hash").notNull(),
    operationCount: integer("operation_count"),
    operationIds: jsonb("operation_ids").$type<string[]>(),
    actorKind: text("actor_kind", { enum: ["human", "agent", "service"] }).notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    actorKey: text("actor_key").notNull(),
    actorKeyDigest: bytea("actor_key_digest").generatedAlwaysAs(
      sql`opengeni_private.editable_artifact_text_sha256(actor_key)`,
    ),
    replicaId: text("replica_id").notNull(),
    replicaCounter: bigint("replica_counter", { mode: "number" }).notNull(),
    agentSessionId: text("agent_session_id"),
    agentTurnId: text("agent_turn_id"),
    agentAttemptId: text("agent_attempt_id"),
    agentGeneration: integer("agent_generation"),
    serviceName: text("service_name"),
    kernelVersion: text("kernel_version").notNull(),
    modelSchemaVersion: integer("model_schema_version").notNull(),
    operationProtocolVersion: integer("operation_protocol_version"),
    commitProtocolVersion: integer("commit_protocol_version"),
    priorNativeRevision: bigint("prior_native_revision", { mode: "number" }),
    nativeRevision: bigint("native_revision", { mode: "number" }),
    commandCount: integer("command_count"),
    nativeReceiptByteSize: integer("native_receipt_byte_size"),
    nativeReceiptHash: text("native_receipt_hash"),
    nativeReceiptBytes: bytea("native_receipt_bytes"),
    committedTransactionByteSize: integer("committed_transaction_byte_size").notNull(),
    committedTransactionHash: text("committed_transaction_hash").notNull(),
    committedTransactionBytes: bytea("committed_transaction_bytes").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_transactions_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.id],
    }),
    actorClientTransaction: uniqueIndex("editable_artifact_transactions_actor_client_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.actorKeyDigest,
      table.clientTransactionId,
    ),
    predecessorIdentity: uniqueIndex("editable_artifact_transactions_predecessor_identity_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.actorKeyDigest,
      table.replicaId,
      table.clientTransactionId,
    ),
    exactReceiptAuthority: uniqueIndex(
      "editable_artifact_transactions_exact_receipt_authority_uq",
    ).on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.id,
      table.actorKeyDigest,
      table.clientTransactionId,
      table.requestHash,
    ),
    replicaCounter: uniqueIndex("editable_artifact_transactions_replica_counter_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.replicaId,
      table.replicaCounter,
    ),
    sequence: uniqueIndex("editable_artifact_transactions_sequence_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.sequenceStart,
      table.sequenceEnd,
    ),
    replay: index("editable_artifact_transactions_replay_idx").on(
      table.workspaceId,
      table.artifactId,
      table.sequenceStart,
    ),
    idValid: check("editable_artifact_transactions_id_chk", stableIdSql(table.id)),
    replicaValid: check(
      "editable_artifact_transactions_replica_chk",
      replicaIdSql(table.replicaId),
    ),
    hashValid: check(
      "editable_artifact_transactions_hash_chk",
      sql`${sha256Sql(table.requestHash)} and ${sha256Sql(table.intentHash)}
        and ${table.intentHash} = ${table.requestHash}
        and ${table.intentEnvelopeVersion} = 1
        and ${table.intentProtocolVersion} = 1
        and ${table.commandProtocolVersion} > 0
        and ${table.intentByteSize} between 8 and 5242880
        and octet_length(${table.intentBytes}) = ${table.intentByteSize}
        and substring(${table.intentBytes} from 1 for 8) = convert_to('OGATX001', 'UTF8')
        and ${table.intentHash} = 'sha256:' || encode(sha256(${table.intentBytes}), 'hex')
        and ${sha256Sql(table.priorStateHash)}
        and ${sha256Sql(table.stateHash)}
        and ${sha256Sql(table.committedTransactionHash)}
        and ${table.parentHeadSequence} between 0 and 9007199254740991
        and ${table.sequenceStart} = ${table.parentHeadSequence} + 1
        and ${table.committedTransactionByteSize} between 1 and 8388608
        and octet_length(${table.committedTransactionBytes}) = ${table.committedTransactionByteSize}
        and ${table.committedTransactionHash} =
          'sha256:' || encode(sha256(${table.committedTransactionBytes}), 'hex')
        and (
          (${table.modality} = 'spreadsheet'
            and ${table.operationCount} between 1 and 4096
            and ${table.sequenceEnd} = ${table.sequenceStart} + ${table.operationCount} - 1
            and jsonb_typeof(${table.causalBase}) = 'array'
            and jsonb_typeof(${table.resolvedCausalBase}) = 'array'
            and jsonb_typeof(${table.resultingCausalFrontier}) = 'array'
            and jsonb_typeof(${table.selectiveUndoTargets}) = 'array'
            and jsonb_typeof(${table.operationIds}) = 'array'
            and jsonb_array_length(${table.operationIds}) = ${table.operationCount}
            and ${table.operationProtocolVersion} = 1
            and ${table.commitProtocolVersion} is null
            and ${table.priorNativeRevision} is null
            and ${table.nativeRevision} is null
            and ${table.commandCount} is null
            and ${table.nativeReceiptByteSize} is null
            and ${table.nativeReceiptHash} is null
            and ${table.nativeReceiptBytes} is null
            and substring(${table.committedTransactionBytes} from 1 for 8) = convert_to('OGACO001', 'UTF8'))
          or
          (${table.modality} in ('document', 'presentation')
            and ${table.sequenceEnd} = ${table.sequenceStart}
            and ${table.causalBase} is null
            and ${table.resolvedCausalBase} is null
            and ${table.resultingCausalFrontier} is null
            and ${table.selectiveUndoTargets} is null
            and ${table.operationCount} is null
            and ${table.operationIds} is null
            and ${table.operationProtocolVersion} is null
            and ${table.commitProtocolVersion} = 1
            and ${table.priorNativeRevision} between 0 and 9007199254740991
            and ((${table.modality} = 'document' and (
              (${table.nativeRevision} = ${table.priorNativeRevision}
                and ${table.stateHash} = ${table.priorStateHash})
              or (${table.nativeRevision} = ${table.priorNativeRevision} + 1
                and ${table.stateHash} <> ${table.priorStateHash})
            )) or (${table.modality} = 'presentation'
              and ${table.nativeRevision} = ${table.priorNativeRevision} + 1
              and ${table.stateHash} <> ${table.priorStateHash}))
            and ${table.commandCount} between 1 and 4096
            and ${table.nativeReceiptByteSize} between 1 and 524288
            and octet_length(${table.nativeReceiptBytes}) = ${table.nativeReceiptByteSize}
            and ${sha256Sql(table.nativeReceiptHash)}
            and ${table.nativeReceiptHash} = 'sha256:' || encode(sha256(${table.nativeReceiptBytes}), 'hex')
            and substring(${table.committedTransactionBytes} from 1 for 8) = convert_to('OGAST001', 'UTF8')
            and get_byte(${table.committedTransactionBytes}, 12) =
              case ${table.modality} when 'document' then 1 else 2 end
            and get_byte(${table.committedTransactionBytes}, 13) = 0
            and get_byte(${table.committedTransactionBytes}, 14) = 0
            and get_byte(${table.committedTransactionBytes}, 15) = 0
            and substring(${table.nativeReceiptBytes} from 1 for 8) = convert_to(
              case ${table.modality} when 'document' then 'OGADR001' else 'OGAPR001' end,
              'UTF8'
            ))
        )`,
    ),
  }),
);

export const editableArtifactOperations = pgTable(
  "editable_artifact_operations",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    transactionId: text("transaction_id").notNull(),
    operationId: text("operation_id").notNull(),
    operationIndex: integer("operation_index").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    dotReplicaId: text("dot_replica_id").notNull(),
    dotCounter: bigint("dot_counter", { mode: "number" }).notNull(),
    actorKey: text("actor_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_operations_pk",
      columns: [
        table.accountId,
        table.workspaceId,
        table.artifactId,
        table.transactionId,
        table.operationIndex,
      ],
    }),
    operationLookup: uniqueIndex("editable_artifact_operations_operation_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.operationId,
    ),
    replay: uniqueIndex("editable_artifact_operations_sequence_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.sequence,
    ),
    dotOperation: uniqueIndex("editable_artifact_operations_dot_operation_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.dotReplicaId,
      table.dotCounter,
      table.operationIndex,
    ),
    idsValid: check(
      "editable_artifact_operations_ids_chk",
      sql`${stableIdSql(table.transactionId)} and ${stableIdSql(table.operationId)}`,
    ),
    dotValid: check(
      "editable_artifact_operations_dot_chk",
      sql`${replicaIdSql(table.dotReplicaId)} and ${table.dotCounter} > 0`,
    ),
    positionValid: check(
      "editable_artifact_operations_position_chk",
      sql`${table.operationIndex} between 0 and 4095
        and ${table.sequence} between 1 and 9007199254740991`,
    ),
  }),
);

export const editableArtifactIdempotencyReceipts = pgTable(
  "editable_artifact_idempotency_receipts",
  {
    ...scopeColumns(),
    id: text("id").notNull(),
    artifactId: text("artifact_id").notNull(),
    operationKind: text("operation_kind", {
      enum: ["create", "import", "edit", "snapshot", "version", "materialize"],
    }).notNull(),
    authorityKey: text("authority_key").notNull(),
    authorityKeyDigest: bytea("authority_key_digest").generatedAlwaysAs(
      sql`opengeni_private.editable_artifact_text_sha256(authority_key)`,
    ),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    resourceType: text("resource_type", {
      enum: ["artifact", "transaction", "snapshot", "artifact_version", "materialization_job"],
    }).notNull(),
    resourceId: text("resource_id").notNull(),
    serverTransactionId: text("server_transaction_id"),
    result: jsonb("result").$type<EditableArtifactIdempotencyResultRow>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_idempotency_receipts_pk",
      columns: [table.accountId, table.workspaceId, table.id],
    }),
    creationRequest: uniqueIndex("editable_artifact_idempotency_receipts_creation_request_uq")
      .on(
        table.accountId,
        table.workspaceId,
        table.operationKind,
        table.authorityKeyDigest,
        table.idempotencyKey,
      )
      .where(sql`${table.operationKind} in ('create', 'import')`),
    artifactRequest: uniqueIndex("editable_artifact_idempotency_receipts_artifact_request_uq")
      .on(
        table.accountId,
        table.workspaceId,
        table.artifactId,
        table.operationKind,
        table.authorityKeyDigest,
        table.idempotencyKey,
      )
      .where(sql`${table.operationKind} in ('edit', 'snapshot', 'version', 'materialize')`),
    origin: uniqueIndex("editable_artifact_idempotency_receipts_origin_uq")
      .on(table.accountId, table.workspaceId, table.artifactId)
      .where(
        sql`${table.operationKind} in ('create', 'import') and ${table.resourceType} = 'artifact'`,
      ),
    artifactTransaction: index("editable_artifact_idempotency_receipts_transaction_idx").on(
      table.workspaceId,
      table.artifactId,
      table.serverTransactionId,
    ),
    valid: check(
      "editable_artifact_idempotency_receipts_valid_chk",
      sql`${stableIdSql(table.id)} and ${sha256Sql(table.requestHash)}`,
    ),
  }),
);

export const editableArtifactUndoClaims = pgTable(
  "editable_artifact_undo_claims",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    targetOperationId: text("target_operation_id").notNull(),
    claimingTransactionId: text("claiming_transaction_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_undo_claims_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.targetOperationId],
    }),
    transaction: index("editable_artifact_undo_claims_transaction_idx").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.claimingTransactionId,
      table.targetOperationId,
    ),
    valid: check(
      "editable_artifact_undo_claims_ids_chk",
      sql`${stableIdSql(table.targetOperationId)} and ${stableIdSql(table.claimingTransactionId)}`,
    ),
  }),
);

export const editableArtifactSequenceCheckpoints = pgTable(
  "editable_artifact_sequence_checkpoints",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    modality: text("modality", {
      enum: ["spreadsheet", "presentation", "document"],
    }).notNull(),
    headSequence: bigint("head_sequence", { mode: "number" }).notNull(),
    transactionId: text("transaction_id"),
    causalFrontier: jsonb("causal_frontier").$type<EditableArtifactCausalFrontierRow>(),
    nativeRevision: bigint("native_revision", { mode: "number" }),
    stateHash: text("state_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_sequence_checkpoints_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.headSequence],
    }),
    transaction: uniqueIndex("editable_artifact_sequence_checkpoints_transaction_uq")
      .on(table.accountId, table.workspaceId, table.artifactId, table.transactionId)
      .where(sql`${table.transactionId} is not null`),
    hashValid: check(
      "editable_artifact_sequence_checkpoints_hash_chk",
      sql`${sha256Sql(table.stateHash)} and (
        (${table.modality} = 'spreadsheet' and jsonb_typeof(${table.causalFrontier}) = 'array'
          and ${table.nativeRevision} is null)
        or (${table.modality} in ('document', 'presentation') and ${table.causalFrontier} is null
          and ${table.nativeRevision} between 0 and 9007199254740991)
      )`,
    ),
  }),
);

export const editableArtifactBlobRefs = pgTable(
  "editable_artifact_blob_refs",
  {
    ...scopeColumns(),
    id: text("id").notNull(),
    artifactId: text("artifact_id").notNull(),
    kind: text("kind", {
      enum: ["snapshot", "original_import", "media", "loss_envelope", "materialization"],
    }).notNull(),
    objectReference: text("object_reference").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    mimeType: text("mime_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_blob_refs_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.id],
    }),
    content: uniqueIndex("editable_artifact_blob_refs_content_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.kind,
      table.contentHash,
    ),
    exactFacts: uniqueIndex("editable_artifact_blob_refs_exact_facts_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.id,
      table.byteSize,
      table.contentHash,
      table.mimeType,
    ),
    hashValid: check("editable_artifact_blob_refs_hash_chk", sha256Sql(table.contentHash)),
  }),
);

export const editableArtifactSnapshots = pgTable(
  "editable_artifact_snapshots",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    modality: text("modality", {
      enum: ["spreadsheet", "presentation", "document"],
    }).notNull(),
    id: text("id").notNull(),
    blobRefId: text("blob_ref_id").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    mimeType: text("mime_type")
      .notNull()
      .default("application/vnd.opengeni.editable-artifact-snapshot"),
    coveredHeadSequence: bigint("covered_head_sequence", { mode: "number" }).notNull(),
    coveredCausalFrontier:
      jsonb("covered_causal_frontier").$type<EditableArtifactCausalFrontierRow>(),
    stateHash: text("state_hash").notNull(),
    modelSchemaVersion: integer("model_schema_version").notNull(),
    operationProtocolVersion: integer("operation_protocol_version"),
    kernelVersion: text("kernel_version").notNull(),
    crdtStateVersion: integer("crdt_state_version"),
    nativeRevision: bigint("native_revision", { mode: "number" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_snapshots_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.id],
    }),
    content: uniqueIndex("editable_artifact_snapshots_content_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.contentHash,
      table.coveredHeadSequence,
    ),
    sourceManifest: uniqueIndex("editable_artifact_snapshots_source_manifest_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.id,
      table.coveredHeadSequence,
      table.stateHash,
    ),
    coverage: index("editable_artifact_snapshots_coverage_idx").on(
      table.workspaceId,
      table.artifactId,
      table.coveredHeadSequence.desc(),
    ),
    valid: check(
      "editable_artifact_snapshots_valid_chk",
      sql`${stableIdSql(table.id)} and ${sha256Sql(table.contentHash)} and ${sha256Sql(table.stateHash)}
        and (
          (${table.modality} = 'spreadsheet'
            and jsonb_typeof(${table.coveredCausalFrontier}) = 'array'
            and ${table.operationProtocolVersion} = 1
            and ${table.crdtStateVersion} > 0
            and ${table.nativeRevision} is null)
          or (${table.modality} in ('document', 'presentation')
            and ${table.coveredCausalFrontier} is null
            and ${table.operationProtocolVersion} is null
            and ${table.crdtStateVersion} is null
            and ${table.nativeRevision} between 0 and 9007199254740991)
        )`,
    ),
  }),
);

export const editableArtifactVersions = pgTable(
  "editable_artifact_versions",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    id: text("id").notNull(),
    snapshotId: text("snapshot_id"),
    headSequence: bigint("head_sequence", { mode: "number" }).notNull(),
    causalFrontier: jsonb("causal_frontier").$type<EditableArtifactCausalFrontierRow>(),
    nativeRevision: bigint("native_revision", { mode: "number" }),
    stateHash: text("state_hash").notNull(),
    name: text("name").notNull(),
    pinned: boolean("pinned").notNull().default(true),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_versions_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.id],
    }),
    timeline: index("editable_artifact_versions_timeline_idx").on(
      table.workspaceId,
      table.artifactId,
      table.createdAt.desc(),
      table.id,
    ),
    valid: check(
      "editable_artifact_versions_valid_chk",
      sql`${stableIdSql(table.id)} and ${sha256Sql(table.stateHash)}
        and ((${table.causalFrontier} is not null and ${table.nativeRevision} is null)
          or (${table.causalFrontier} is null
            and ${table.nativeRevision} between 0 and 9007199254740991))`,
    ),
  }),
);

export const editableArtifactMaterializationJobs = pgTable(
  "editable_artifact_materialization_jobs",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    id: text("id").notNull(),
    versionId: text("version_id"),
    inputSnapshotId: text("input_snapshot_id").notNull(),
    targetHeadSequence: bigint("target_head_sequence", { mode: "number" }).notNull(),
    stateHash: text("state_hash").notNull(),
    format: text("format", { enum: ["xlsx", "pptx", "docx", "pdf", "png", "webp"] }).notNull(),
    normalizedOptions: text("normalized_options").notNull(),
    optionsHash: text("options_hash").generatedAlwaysAs(
      sql`'sha256:' || encode(
        opengeni_private.editable_artifact_text_sha256(normalized_options), 'hex'
      )`,
    ),
    codecId: text("codec_id").notNull(),
    codecVersion: text("codec_version").notNull(),
    kernelVersion: text("kernel_version").notNull(),
    fontRegistryHash: text("font_registry_hash").notNull(),
    policyHash: text("policy_hash").notNull(),
    state: text("state", { enum: ["pending", "running", "succeeded", "failed"] })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    settledByOwner: text("settled_by_owner"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_materialization_jobs_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.id],
    }),
    cache: uniqueIndex("editable_artifact_materialization_jobs_cache_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.inputSnapshotId,
      table.stateHash,
      table.format,
      table.optionsHash,
      table.codecId,
      table.codecVersion,
      table.kernelVersion,
      table.fontRegistryHash,
      table.policyHash,
    ),
    claim: index("editable_artifact_materialization_jobs_claim_idx")
      .on(
        sql`coalesce(${table.leaseExpiresAt}, ${table.createdAt})`,
        table.createdAt,
        table.accountId,
        table.workspaceId,
        table.artifactId,
        table.id,
      )
      .where(sql`${table.state} in ('pending', 'running')`),
    valid: check(
      "editable_artifact_materialization_jobs_valid_chk",
      sql`${stableIdSql(table.id)} and ${sha256Sql(table.stateHash)}
        and ${sha256Sql(table.optionsHash)} and ${sha256Sql(table.fontRegistryHash)}
        and ${sha256Sql(table.policyHash)} and ${stableIdSql(table.inputSnapshotId)}`,
    ),
  }),
);

export const editableArtifactMaterializationResults = pgTable(
  "editable_artifact_materialization_results",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    id: text("id").notNull(),
    jobId: text("job_id").notNull(),
    blobRefId: text("blob_ref_id").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    mimeType: text("mime_type").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_materialization_results_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.id],
    }),
    job: uniqueIndex("editable_artifact_materialization_results_job_uq").on(
      table.accountId,
      table.workspaceId,
      table.artifactId,
      table.jobId,
    ),
    valid: check(
      "editable_artifact_materialization_results_valid_chk",
      sql`${stableIdSql(table.id)} and ${sha256Sql(table.contentHash)}`,
    ),
  }),
);

export const editableArtifactLiveOutbox = pgTable(
  "editable_artifact_live_outbox",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    id: text("id").notNull(),
    transactionId: text("transaction_id"),
    snapshotId: text("snapshot_id"),
    eventKind: text("event_kind", {
      enum: ["transaction_committed", "snapshot_published"],
    }).notNull(),
    event: jsonb("event").$type<EditableArtifactOutboxEventRow>().notNull(),
    state: text("state", {
      enum: ["pending", "publishing", "published", "dead_lettered"],
    })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_live_outbox_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.id],
    }),
    globalId: uniqueIndex("editable_artifact_live_outbox_id_uq").on(table.id),
    transaction: uniqueIndex("editable_artifact_live_outbox_transaction_uq")
      .on(table.accountId, table.workspaceId, table.artifactId, table.transactionId)
      .where(sql`${table.eventKind} = 'transaction_committed'`),
    snapshot: uniqueIndex("editable_artifact_live_outbox_snapshot_uq")
      .on(table.accountId, table.workspaceId, table.artifactId, table.snapshotId)
      .where(sql`${table.eventKind} = 'snapshot_published'`),
    pendingClaim: index("editable_artifact_live_outbox_pending_claim_idx")
      .on(table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`${table.state} = 'pending'`),
    publishingClaim: index("editable_artifact_live_outbox_publishing_claim_idx")
      .on(table.leaseExpiresAt, table.createdAt, table.id)
      .where(sql`${table.state} = 'publishing'`),
    valid: check("editable_artifact_live_outbox_id_chk", stableIdSql(table.id)),
  }),
);

export const editableArtifactReplicaLeases = pgTable(
  "editable_artifact_replica_leases",
  {
    ...scopeColumns(),
    artifactId: text("artifact_id").notNull(),
    modality: text("modality", {
      enum: ["spreadsheet", "presentation", "document"],
    }).notNull(),
    replicaId: text("replica_id").notNull(),
    actorKey: text("actor_key").notNull(),
    appliedHeadSequence: bigint("applied_head_sequence", { mode: "number" }).notNull(),
    causalFrontier: jsonb("causal_frontier").$type<EditableArtifactCausalFrontierRow>(),
    nativeRevision: bigint("native_revision", { mode: "number" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "editable_artifact_replica_leases_pk",
      columns: [table.accountId, table.workspaceId, table.artifactId, table.replicaId],
    }),
    expiry: index("editable_artifact_replica_leases_expiry_idx")
      .on(table.leaseExpiresAt, table.replicaId)
      .where(sql`${table.revokedAt} is null`),
    replicaValid: check(
      "editable_artifact_replica_leases_replica_chk",
      sql`${replicaIdSql(table.replicaId)} and (
        (${table.modality} = 'spreadsheet'
          and jsonb_typeof(${table.causalFrontier}) = 'array'
          and ${table.nativeRevision} is null)
        or (${table.modality} in ('document', 'presentation')
          and ${table.causalFrontier} is null
          and ${table.nativeRevision} between 0 and 9007199254740991)
      )`,
    ),
  }),
);
