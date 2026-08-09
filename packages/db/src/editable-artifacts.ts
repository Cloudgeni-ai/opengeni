import { createHash } from "node:crypto";
import {
  COMMITTED_TRANSACTION_PROTOCOL_VERSION,
  MAX_COMMITTED_TRANSACTION_BYTES,
  MAX_COMMITTED_TRANSACTION_OPERATIONS,
  decodeCommittedTransactionSummary,
} from "@opengeni/contracts/editable-artifact-committed-transaction";
import {
  EDITABLE_ARTIFACT_NATIVE_RECEIPT_MAX_BYTES,
  EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
  decodeEditableArtifactSerializedCommit,
} from "@opengeni/contracts/editable-artifact-serialized-commit";
import {
  EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
} from "@opengeni/contracts/editable-artifacts";
import { sql } from "drizzle-orm";

import { rawRows, type Database, withRlsContext } from "./database";

/**
 * Persistence DTOs intentionally live below @opengeni/core. Core already
 * depends on @opengeni/db, so importing its nominal types here would create a
 * publish-time package cycle. These shapes mirror the editable-artifact domain
 * port exactly; core owns the one-way typed adapter.
 */
export type PersistedEditableArtifactScope = Readonly<{
  accountId: string;
  workspaceId: string;
}>;

export type PersistedEditableArtifactActor =
  | Readonly<{ kind: "human"; subjectId: string; replicaId: string }>
  | Readonly<{
      kind: "agent";
      subjectId: string;
      replicaId: string;
      sessionId: string;
      turnId: string;
      attemptId: string;
      generation: number;
    }>
  | Readonly<{
      kind: "service";
      subjectId: string;
      replicaId: string;
      service: string;
    }>;

export type PersistedEditableArtifactLiveTicketActor = PersistedEditableArtifactActor;

export type PersistedEditableArtifactLiveTicketRecord = Readonly<{
  tokenDigest: string;
  scope: PersistedEditableArtifactScope;
  artifactId: string;
  modality: "spreadsheet" | "presentation" | "document";
  actor: PersistedEditableArtifactLiveTicketActor;
  allowEdit: boolean;
  protocolVersion: number;
  issuedAt: string;
  expiresAt: string;
}>;

export type PersistedEditableArtifactCausalEntry = Readonly<{
  replicaId: string;
  counter: number;
}>;

export type PersistedEditableArtifactCausalFrontier =
  readonly PersistedEditableArtifactCausalEntry[];

type PersistedEditableArtifactCommon = Readonly<{
  scope: PersistedEditableArtifactScope;
  id: string;
  title: string;
  lifecycle: "active" | "archived";
  authorizationRevision: number;
  headSequence: number;
  stateHash: string;
  currentSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type PersistedEditableArtifact =
  | (PersistedEditableArtifactCommon &
      Readonly<{
        modality: "spreadsheet";
        causalFrontier: PersistedEditableArtifactCausalFrontier;
      }>)
  | (PersistedEditableArtifactCommon & Readonly<{ modality: "document" | "presentation" }>);

export type PersistedEditableArtifactCreationReceipt = Readonly<{
  receiptId: string;
  scope: PersistedEditableArtifactScope;
  artifactId: string;
  operationKind: "create" | "import";
  authorityKey: string;
  idempotencyKey: string;
  requestHash: string;
  genesisSnapshotId: string;
  createdAt: string;
}>;

export type CreatePersistedEditableArtifactResult = Readonly<{
  artifact: PersistedEditableArtifact;
  genesisSnapshot: PersistedEditableArtifactSnapshotMetadata;
  creationReceipt: PersistedEditableArtifactCreationReceipt;
  replayed: boolean;
}>;

export type CreatePersistedEditableArtifactStoreResult =
  | Readonly<{ kind: "result"; value: CreatePersistedEditableArtifactResult }>
  | Readonly<{ kind: "authorization_stale" }>;

export type ReadPersistedEditableArtifactAtAuthorizationRevisionResult =
  | Readonly<{ kind: "result"; artifact: PersistedEditableArtifact | null }>
  | Readonly<{ kind: "authorization_stale" }>;

export type PersistedEditableArtifactOperationRecord = Readonly<{
  scope: PersistedEditableArtifactScope;
  artifactId: string;
  serverTransactionId: string;
  sequence: number;
  actorKey: string;
  createdAt: string;
  operationId: string;
  dot: PersistedEditableArtifactCausalEntry;
}>;

type PersistedEditableArtifactCommittedTransactionCommon = Readonly<{
  scope: PersistedEditableArtifactScope;
  artifactId: string;
  modality: PersistedEditableArtifact["modality"];
  serverTransactionId: string;
  requestHash: string;
  sequenceStart: number;
  sequenceEnd: number;
  priorStateHash: string;
  stateHash: string;
  modelSchemaVersion: number;
  kernelVersion: string;
  committedTransactionBytes: Uint8Array;
  committedAt: string;
}>;

export type PersistedEditableArtifactCommittedTransactionRecord =
  | (PersistedEditableArtifactCommittedTransactionCommon &
      Readonly<{
        modality: "spreadsheet";
        dot: PersistedEditableArtifactCausalEntry;
        resolvedCausalBase: PersistedEditableArtifactCausalFrontier;
        resultingCausalFrontier: PersistedEditableArtifactCausalFrontier;
        operationIds: readonly string[];
        operationProtocolVersion: number;
      }>)
  | (PersistedEditableArtifactCommittedTransactionCommon &
      Readonly<{
        modality: "document" | "presentation";
        commitProtocolVersion: number;
        priorNativeRevision: number;
        nativeRevision: number;
        commandCount: number;
        nativeReceiptBytes: Uint8Array;
      }>);

type PersistedEditableArtifactReceiptCommon = Readonly<{
  receiptId: string;
  scope: PersistedEditableArtifactScope;
  artifactId: string;
  modality: PersistedEditableArtifact["modality"];
  serverTransactionId: string;
  clientTransactionId: string;
  replicaId: string;
  replicaCounter: number;
  previousLocalTransactionId: string | null;
  intentBytes: Uint8Array;
  requestHash: string;
  actorKey: string;
  sequenceStart: number;
  sequenceEnd: number;
  priorStateHash: string;
  stateHash: string;
  intentEnvelopeVersion: number;
  intentProtocolVersion: number;
  commandProtocolVersion: number;
  kernelVersion: string;
  modelSchemaVersion: number;
  committedAt: string;
}>;

export type PersistedEditableArtifactReceipt =
  | (PersistedEditableArtifactReceiptCommon &
      Readonly<{
        modality: "spreadsheet";
        causalBase: PersistedEditableArtifactCausalFrontier;
        resolvedCausalBase: PersistedEditableArtifactCausalFrontier;
        resultingCausalFrontier: PersistedEditableArtifactCausalFrontier;
        operationCount: number;
        selectiveUndoOperationIds: readonly string[];
        operationProtocolVersion: number;
      }>)
  | (PersistedEditableArtifactReceiptCommon &
      Readonly<{
        modality: "document" | "presentation";
        commitProtocolVersion: number;
        priorNativeRevision: number;
        nativeRevision: number;
        commandCount: number;
      }>);

type PersistedEditableArtifactSnapshotMetadataCommon = Readonly<{
  scope: PersistedEditableArtifactScope;
  artifactId: string;
  modality: PersistedEditableArtifact["modality"];
  snapshotId: string;
  blobReference: string;
  byteSize: number;
  contentHash: string;
  mimeType: "application/vnd.opengeni.editable-artifact-snapshot";
  coveredHeadSequence: number;
  stateHash: string;
  modelSchemaVersion: number;
  kernelVersion: string;
  verifiedAt: string;
  publishedAt: string;
}>;

export type PersistedEditableArtifactSnapshotMetadata =
  | (PersistedEditableArtifactSnapshotMetadataCommon &
      Readonly<{
        modality: "spreadsheet";
        coveredCausalFrontier: PersistedEditableArtifactCausalFrontier;
        operationProtocolVersion: number;
        crdtStateVersion: number;
      }>)
  | (PersistedEditableArtifactSnapshotMetadataCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
      }>);

export type PersistedEditableArtifactSequenceCheckpoint =
  | Readonly<{
      modality: "spreadsheet";
      headSequence: number;
      causalFrontier: PersistedEditableArtifactCausalFrontier;
      stateHash: string;
    }>
  | Readonly<{
      modality: "document" | "presentation";
      headSequence: number;
      nativeRevision: number;
      stateHash: string;
    }>;

type PersistedEditableArtifactTransactionEventCommon = Readonly<{
  kind: "transaction_committed";
  schemaVersion: 1;
  scope: PersistedEditableArtifactScope;
  artifactId: string;
  serverTransactionId: string;
  sequenceStart: number;
  sequenceEnd: number;
  stateHash: string;
  committedAt: string;
}>;

type PersistedEditableArtifactSnapshotEventCommon = Readonly<{
  kind: "snapshot_published";
  schemaVersion: 1;
  scope: PersistedEditableArtifactScope;
  artifactId: string;
  snapshotId: string;
  coveredHeadSequence: number;
  stateHash: string;
  publishedAt: string;
}>;

export type PersistedEditableArtifactLiveEvent =
  | (PersistedEditableArtifactTransactionEventCommon &
      Readonly<{
        modality: "spreadsheet";
        operationProtocolVersion: number;
      }>)
  | (PersistedEditableArtifactTransactionEventCommon &
      Readonly<{
        modality: "document" | "presentation";
        commitProtocolVersion: number;
      }>)
  | (PersistedEditableArtifactSnapshotEventCommon &
      Readonly<{
        modality: "spreadsheet";
        operationProtocolVersion: number;
      }>)
  | (PersistedEditableArtifactSnapshotEventCommon &
      Readonly<{ modality: "document" | "presentation" }>);

export type PersistedEditableArtifactLiveOutboxRecord = Readonly<{
  outboxId: string;
  event: PersistedEditableArtifactLiveEvent;
  state: "pending" | "publishing" | "published" | "dead_lettered";
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  publishedAt: string | null;
  deadLetteredAt: string | null;
  createdAt: string;
}>;

type PersistedEditableArtifactLiveBoundaryCommon = Readonly<{
  modality: PersistedEditableArtifact["modality"];
  headSequence: number;
  stateHash: string;
  minimumReplaySequence: number;
}>;

export type PersistedEditableArtifactLiveHead =
  | (PersistedEditableArtifactLiveBoundaryCommon &
      Readonly<{
        modality: "spreadsheet";
        causalFrontier: PersistedEditableArtifactCausalFrontier;
      }>)
  | (PersistedEditableArtifactLiveBoundaryCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
      }>);

export type PersistedEditableArtifactLiveResume =
  | Readonly<{
      modality?: "spreadsheet";
      localCursor: number | null;
      localStateHash: string | null;
      localCausalFrontier: PersistedEditableArtifactCausalFrontier;
      requireSnapshot: boolean;
    }>
  | Readonly<{
      modality: "document" | "presentation";
      localCursor: number | null;
      localStateHash: string | null;
      localNativeRevision: number | null;
      requireSnapshot: boolean;
    }>;

export type PersistedEditableArtifactLiveSnapshot =
  | Readonly<{
      modality: "spreadsheet";
      artifactId: string;
      sequence: number;
      stateHash: string;
      causalFrontier: PersistedEditableArtifactCausalFrontier;
      digest: string;
      operationProtocolVersion: number;
      kernelVersion: string;
      modelSchemaVersion: number;
      bytes: Uint8Array;
    }>
  | Readonly<{
      modality: "document" | "presentation";
      artifactId: string;
      sequence: number;
      stateHash: string;
      nativeRevision: number;
      digest: string;
      kernelVersion: string;
      modelSchemaVersion: number;
      bytes: Uint8Array;
    }>;

export type PersistedEditableArtifactLiveCommittedTransaction =
  | Readonly<{
      modality: "spreadsheet";
      artifactId: string;
      transactionId: string;
      requestHash: string;
      startSequence: number;
      endSequence: number;
      priorStateHash: string;
      stateHash: string;
      causalFrontier: PersistedEditableArtifactCausalFrontier;
      operationProtocolVersion: number;
      committedTransactionBytes: Uint8Array;
    }>
  | Readonly<{
      modality: "document" | "presentation";
      artifactId: string;
      transactionId: string;
      requestHash: string;
      startSequence: number;
      endSequence: number;
      priorStateHash: string;
      stateHash: string;
      priorNativeRevision: number;
      nativeRevision: number;
      commitProtocolVersion: number;
      committedTransactionBytes: Uint8Array;
    }>;

export type PersistedEditableArtifactLiveBootstrap = PersistedEditableArtifactLiveHead &
  Readonly<{
    resumeAccepted: boolean;
    resumeSequence: number;
    resumeStateHash: string;
    snapshot: PersistedEditableArtifactLiveSnapshot | null;
  }>;

export interface PersistedEditableArtifactSnapshotBytesPort {
  readSnapshotBytes(snapshot: PersistedEditableArtifactSnapshotMetadata): Promise<Uint8Array>;
}

export type PersistedEditableArtifactKernelState =
  | Readonly<{
      modality: "spreadsheet";
      artifact: Extract<PersistedEditableArtifact, { modality: "spreadsheet" }>;
      snapshot: Extract<
        PersistedEditableArtifactSnapshotMetadata,
        { modality: "spreadsheet" }
      > | null;
      tailTransactionCount: number;
      tailByteSize: number;
      committedTransactionTail: readonly Extract<
        PersistedEditableArtifactCommittedTransactionRecord,
        { modality: "spreadsheet" }
      >[];
    }>
  | Readonly<{
      modality: "document" | "presentation";
      artifact: Extract<PersistedEditableArtifact, { modality: "document" | "presentation" }>;
      snapshot: Extract<
        PersistedEditableArtifactSnapshotMetadata,
        { modality: "document" | "presentation" }
      > | null;
      tailTransactionCount: number;
      tailByteSize: number;
      baseNativeRevision: number;
      committedTransactionTail: readonly Extract<
        PersistedEditableArtifactCommittedTransactionRecord,
        { modality: "document" | "presentation" }
      >[];
    }>;

export type CommitPersistedEditableArtifactTransaction = Readonly<{
  expectedHeadSequence: number;
  serverTransactionId: string;
  receipt: PersistedEditableArtifactReceipt;
  committedTransaction: PersistedEditableArtifactCommittedTransactionRecord;
  operations: readonly PersistedEditableArtifactOperationRecord[];
  outbox: PersistedEditableArtifactLiveOutboxRecord;
}>;

export type ReadPersistedEditableArtifactTransactionBasisRequest = Readonly<{
  actorKey: string;
  clientTransactionId: string;
  previousLocalTransactionId: string | null;
  selectiveUndoOperationIds: readonly string[];
}>;

export type PersistedEditableArtifactTransactionUndoBasis = Readonly<{
  operationId: string;
  operation: PersistedEditableArtifactOperationRecord | null;
  claimedBy: string | null;
}>;

export type PersistedEditableArtifactTransactionBasis =
  | Readonly<{
      kind: "existing";
      receipt: PersistedEditableArtifactReceipt;
    }>
  | Readonly<{
      kind: "basis";
      artifact: PersistedEditableArtifact;
      predecessor: PersistedEditableArtifactReceipt | null;
      undoTargets: readonly PersistedEditableArtifactTransactionUndoBasis[];
      kernelState: PersistedEditableArtifactKernelState;
    }>;

export type ExpectedPersistedEditableArtifactPredecessor = Readonly<{
  receiptId: string;
  serverTransactionId: string;
  actorKey: string;
  clientTransactionId: string;
  replicaId: string;
  replicaCounter: number;
}>;

export type TryCommitPersistedEditableArtifactTransactionRequest =
  CommitPersistedEditableArtifactTransaction &
    Readonly<{
      scope: PersistedEditableArtifactScope;
      artifactId: string;
      expectedLifecycle: "active";
      expectedAuthorizationRevision: number;
      authorizationActor: PersistedEditableArtifactActor;
      actorKey: string;
      clientTransactionId: string;
      requestHash: string;
      expectedPredecessor: ExpectedPersistedEditableArtifactPredecessor | null;
      expectedUnclaimedUndoTargets: readonly string[];
    }>;

export type TryCommitPersistedEditableArtifactTransactionResult =
  | Readonly<{ kind: "committed"; receipt: PersistedEditableArtifactReceipt }>
  | Readonly<{ kind: "replayed"; receipt: PersistedEditableArtifactReceipt }>
  | Readonly<{ kind: "stale" }>;

export type CommitPersistedEditableArtifactSnapshot = Readonly<{
  expectedCurrentSnapshotId: string | null;
  expectedAuthorizationRevision: number;
  authorizationActor: PersistedEditableArtifactActor;
  authorizationPermission?: "manage" | "read" | "edit";
  snapshot: PersistedEditableArtifactSnapshotMetadata;
  outbox: PersistedEditableArtifactLiveOutboxRecord;
}>;

export type CommitPersistedEditableArtifactSnapshotResult =
  | Readonly<{ kind: "committed" }>
  | Readonly<{ kind: "authorization_stale" }>;

interface PersistedEditableArtifactUnitOfWork {
  artifact(): PersistedEditableArtifact;
  findReceipt(
    actorKey: string,
    clientTransactionId: string,
  ): Promise<PersistedEditableArtifactReceipt | null>;
  findOperation(operationId: string): Promise<PersistedEditableArtifactOperationRecord | null>;
  findUndoClaim(operationId: string): Promise<string | null>;
  kernelState(): Promise<PersistedEditableArtifactKernelState>;
  checkpoint(headSequence: number): Promise<PersistedEditableArtifactSequenceCheckpoint | null>;
  findSnapshot(snapshotId: string): Promise<PersistedEditableArtifactSnapshotMetadata | null>;
  commitAppliedTransaction(input: CommitPersistedEditableArtifactTransaction): Promise<void>;
  commitSnapshot(
    input: CommitPersistedEditableArtifactSnapshot,
  ): Promise<CommitPersistedEditableArtifactSnapshotResult>;
}

export interface PersistedEditableArtifactSnapshotPublicationUnitOfWork {
  artifact(): PersistedEditableArtifact;
  checkpoint(headSequence: number): Promise<PersistedEditableArtifactSequenceCheckpoint | null>;
  findSnapshot(snapshotId: string): Promise<PersistedEditableArtifactSnapshotMetadata | null>;
  commitSnapshot(
    input: CommitPersistedEditableArtifactSnapshot,
  ): Promise<CommitPersistedEditableArtifactSnapshotResult>;
}

export type ClaimPersistedEditableArtifactLiveOutboxRequest = Readonly<{
  owner: string;
  leaseDurationMs: number;
  limit: number;
}>;

export type PersistedEditableArtifactOutboxRetryErrorCode =
  | "broker_unavailable"
  | "broker_backpressure"
  | "publish_timeout";

export type PersistedEditableArtifactOutboxDeadLetterErrorCode = "invalid_hint" | "oversized_hint";

export type AdvancePersistedEditableArtifactAuthorizationRevisionResult = Readonly<{
  applied: boolean;
  authorizationRevision: number;
}>;

export type PersistedEditableArtifactScopeAuthorizationHead = Readonly<{
  scope: PersistedEditableArtifactScope;
  createRevision: number;
}>;

export class EditableArtifactPersistenceError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "corrupt_history"
      | "history_limit"
      | "outbox_lease_conflict"
      | "transient",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EditableArtifactPersistenceError";
  }
}

export const EDITABLE_ARTIFACT_INTENT_MAX_BYTES = 5 * 1024 * 1024;
export const EDITABLE_ARTIFACT_KERNEL_TAIL_MAX_TRANSACTIONS = 100_000;
export const EDITABLE_ARTIFACT_KERNEL_TAIL_MAX_BYTES = 64 * 1024 * 1024;
const EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES = 64 * 1024 * 1024;

type ArtifactRow = {
  account_id: string;
  workspace_id: string;
  id: string;
  modality: string;
  title: string;
  lifecycle_state: string;
  authorization_revision: string | number | bigint;
  head_sequence: string | number | bigint;
  causal_frontier: unknown | null;
  state_hash: string;
  current_snapshot_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type TransactionRow = {
  account_id: string;
  workspace_id: string;
  artifact_id: string;
  modality: string;
  id: string;
  receipt_id: string | null;
  client_transaction_id: string;
  replica_id: string;
  replica_counter: string | number | bigint;
  previous_local_transaction_id: string | null;
  intent_bytes: Uint8Array;
  request_hash: string;
  actor_key: string;
  sequence_start: string | number | bigint;
  sequence_end: string | number | bigint;
  prior_state_hash: string;
  causal_base: unknown | null;
  resolved_causal_base: unknown | null;
  resulting_causal_frontier: unknown | null;
  state_hash: string;
  operation_count: number | null;
  operation_ids: unknown | null;
  selective_undo_targets: unknown | null;
  intent_envelope_version: number;
  intent_protocol_version: number;
  command_protocol_version: number;
  kernel_version: string;
  model_schema_version: number;
  operation_protocol_version: number | null;
  commit_protocol_version: number | null;
  prior_native_revision: string | number | bigint | null;
  native_revision: string | number | bigint | null;
  command_count: number | null;
  native_receipt_byte_size: number | null;
  native_receipt_hash: string | null;
  native_receipt_bytes: Uint8Array | null;
  committed_transaction_byte_size: string | number | bigint;
  committed_transaction_hash: string;
  committed_transaction_bytes: Uint8Array;
  committed_at: Date | string;
};

type CommittedTransactionRow = {
  account_id: string;
  workspace_id: string;
  artifact_id: string;
  modality: string;
  id: string;
  request_hash: string;
  sequence_start: string | number | bigint;
  sequence_end: string | number | bigint;
  prior_state_hash: string;
  state_hash: string;
  replica_id: string;
  replica_counter: string | number | bigint;
  resolved_causal_base: unknown | null;
  resulting_causal_frontier: unknown | null;
  operation_count: number | null;
  operation_ids: unknown | null;
  operation_protocol_version: number | null;
  commit_protocol_version: number | null;
  prior_native_revision: string | number | bigint | null;
  native_revision: string | number | bigint | null;
  command_count: number | null;
  native_receipt_byte_size: number | null;
  native_receipt_hash: string | null;
  native_receipt_bytes: Uint8Array | null;
  model_schema_version: number;
  kernel_version: string;
  committed_transaction_byte_size: string | number | bigint;
  committed_transaction_hash: string;
  committed_transaction_bytes: Uint8Array;
  committed_at: Date | string;
};

type CreationReceiptRow = {
  id: string;
  operation_kind: string;
  authority_key: string;
  idempotency_key: string;
  request_hash: string;
  resource_type: string;
  resource_id: string;
  result: unknown;
  created_at: Date | string;
};

type OperationRow = {
  account_id: string;
  workspace_id: string;
  artifact_id: string;
  transaction_id: string;
  operation_id: string;
  operation_index: number;
  sequence: string | number | bigint;
  dot_replica_id: string;
  dot_counter: string | number | bigint;
  actor_key: string;
  created_at: Date | string;
};

type SnapshotRow = {
  account_id: string;
  workspace_id: string;
  artifact_id: string;
  modality: string;
  id: string;
  blob_reference: string;
  blob_byte_size: string | number | bigint;
  blob_content_hash: string;
  blob_mime_type: string;
  byte_size: string | number | bigint;
  content_hash: string;
  mime_type: string;
  covered_head_sequence: string | number | bigint;
  covered_causal_frontier: unknown | null;
  state_hash: string;
  model_schema_version: number;
  operation_protocol_version: number | null;
  kernel_version: string;
  crdt_state_version: number | null;
  native_revision: string | number | bigint | null;
  verified_at: Date | string;
  published_at: Date | string;
};

type OutboxRow = {
  outbox_id: string;
  event: unknown;
  state: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  next_attempt_at: Date | string;
  last_error_code: string | null;
  published_at: Date | string | null;
  dead_lettered_at: Date | string | null;
  created_at: Date | string;
};

type LiveTicketRow = {
  token_digest: string;
  account_id: string;
  workspace_id: string;
  artifact_id: string;
  modality: string;
  actor_kind: string;
  actor_subject_id: string;
  replica_id: string;
  agent_session_id: string | null;
  agent_turn_id: string | null;
  agent_attempt_id: string | null;
  agent_generation: number | null;
  service_name: string | null;
  allow_edit: boolean;
  protocol_version: number;
  issued_at: Date | string;
  expires_at: Date | string;
};

/**
 * Shared PostgreSQL implementation of the live ticket atomic-take port.
 * Direct table access is intentionally unnecessary: all three operations use
 * hardened owner-defined routines installed by migration 0185.
 */
export class PostgresEditableArtifactLiveTicketStore {
  constructor(private readonly db: Database) {}

  async put(recordInput: PersistedEditableArtifactLiveTicketRecord): Promise<void> {
    const record = validateLiveTicketRecord(recordInput);
    const actor = record.actor;
    try {
      await withRlsContext(this.db, record.scope, async (tx) => {
        await rawRows<{ stored: null }>(
          tx,
          sql`select opengeni_private.put_editable_artifact_live_ticket(
            ${record.tokenDigest}, ${record.scope.accountId}::uuid,
            ${record.scope.workspaceId}::uuid, ${record.artifactId}, ${record.modality},
            ${actor.kind}, ${actor.subjectId}, ${actor.replicaId},
            ${actor.kind === "agent" ? actor.sessionId : null},
            ${actor.kind === "agent" ? actor.turnId : null},
            ${actor.kind === "agent" ? actor.attemptId : null},
            ${actor.kind === "agent" ? actor.generation : null},
            ${actor.kind === "service" ? actor.service : null},
            ${record.allowEdit}, ${record.protocolVersion}, ${record.issuedAt}::timestamptz,
            ${record.expiresAt}::timestamptz, current_schema()
          ) as stored`,
        );
      });
    } catch (error) {
      if (errorCode(error) === "23505") {
        throw new Error("Live ticket digest collision", { cause: error });
      }
      throw error;
    }
  }

  async consume(
    tokenDigestInput: string,
  ): Promise<PersistedEditableArtifactLiveTicketRecord | null> {
    const tokenDigest = validateHash(tokenDigestInput, "live ticket digest");
    const rows = await rawRows<LiveTicketRow>(
      this.db,
      sql`select * from opengeni_private.consume_editable_artifact_live_ticket(
        ${tokenDigest}, current_schema()
      )`,
    );
    if (rows.length > 1) throw corrupt("Live ticket consume returned multiple records");
    return rows[0] ? liveTicketFromRow(rows[0]) : null;
  }

  async cleanupExpired(limitInput = 1_000): Promise<number> {
    const limit = validateInteger(limitInput, "live ticket cleanup limit", 1, 10_000);
    const rows = await rawRows<{ removed: number | string | bigint }>(
      this.db,
      sql`select opengeni_private.cleanup_expired_editable_artifact_live_tickets(
        ${limit}, current_schema()
      ) as removed`,
    );
    return safeInteger(rows[0]?.removed ?? null, "live ticket cleanup count", 0);
  }
}

/**
 * PostgreSQL authority adapter. Kernel inputs are copied from a detached,
 * repeatable-read basis; only the final write CAS and narrow snapshot metadata
 * publication hold the artifact row lock. Tenant RLS is set and verified in
 * every scoped transaction.
 */
export class PostgresEditableArtifactStore {
  constructor(private readonly db: Database) {}

  async findArtifactCreation(
    scopeInput: PersistedEditableArtifactScope,
    operationKindInput: "create" | "import",
    authorityKeyInput: string,
    idempotencyKeyInput: string,
  ): Promise<CreatePersistedEditableArtifactResult | null> {
    const scope = validateScope(scopeInput);
    const operationKind = validateOriginOperation(operationKindInput);
    const authorityKey = validateActorKey(authorityKeyInput).key;
    const idempotencyKey = validateClientTransactionId(idempotencyKeyInput);
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const rows = await rawRows<CreationReceiptRow>(
          tx,
          sql`select id, operation_kind, authority_key, idempotency_key, request_hash,
            resource_type, resource_id, result, created_at
          from editable_artifact_idempotency_receipts
          where account_id = ${scope.accountId}::uuid
            and workspace_id = ${scope.workspaceId}::uuid
            and operation_kind = ${operationKind}
            and authority_key_digest = sha256(convert_to(${authorityKey}, 'UTF8'))
            and authority_key = ${authorityKey}
            and idempotency_key = ${idempotencyKey}
          limit 1`,
        );
        const row = rows[0];
        if (!row) return null;
        const creationReceipt = creationReceiptFromRow(scope, row);
        const artifactRow = await loadArtifactRow(tx, scope, creationReceipt.artifactId, false);
        if (!artifactRow) throw corrupt("Artifact creation receipt points at a missing artifact");
        const artifact = artifactFromRow(artifactRow);
        if (artifact.currentSnapshotId !== creationReceipt.genesisSnapshotId) {
          throw corrupt("Artifact creation receipt disagrees with the genesis snapshot pointer");
        }
        const genesisSnapshot = await loadSnapshotMetadata(
          tx,
          scope,
          artifact.id,
          creationReceipt.genesisSnapshotId,
        );
        if (!genesisSnapshot) {
          throw corrupt("Artifact creation receipt points at a missing genesis snapshot");
        }
        return Object.freeze({
          artifact,
          genesisSnapshot,
          creationReceipt,
          replayed: true,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async createArtifact(input: {
    scope: PersistedEditableArtifactScope;
    artifactId: string;
    authorizationActor: PersistedEditableArtifactActor;
    receiptId: string;
    authorityKey: string;
    idempotencyKey: string;
    requestHash: string;
    operationKind: "create" | "import";
    modality: PersistedEditableArtifact["modality"];
    title: string;
    expectedScopeAuthorizationRevision: number;
    initialArtifactAuthorizationRevision: number;
    createdBySubjectId: string;
    genesisSnapshot: PersistedEditableArtifactSnapshotMetadata;
    originalImport?: Readonly<{
      fileId: string;
      blobRefId: string;
      blobReference: string;
      byteSize: number;
      contentHash: string;
      mimeType: string;
    }>;
    outbox: PersistedEditableArtifactLiveOutboxRecord;
  }): Promise<CreatePersistedEditableArtifactStoreResult> {
    const scope = validateScope(input.scope);
    const artifactId = validateStableId(input.artifactId, "artifact id");
    const authorizationActor = validateLiveTicketActor(input.authorizationActor);
    const receiptId = validateStableId(input.receiptId, "creation receipt id");
    const authorityKey = validateActorKey(input.authorityKey).key;
    if (persistedEditableArtifactActorKey(authorizationActor) !== authorityKey) {
      throw new TypeError("Artifact creation authority does not match its actor key");
    }
    const idempotencyKey = validateClientTransactionId(input.idempotencyKey);
    const requestHash = validateHash(input.requestHash, "creation request hash");
    const operationKind = validateOriginOperation(input.operationKind);
    if ((operationKind === "import") !== Boolean(input.originalImport)) {
      throw new TypeError("Artifact import source does not match its origin operation");
    }
    const expectedScopeAuthorizationRevision = validateInteger(
      input.expectedScopeAuthorizationRevision,
      "expected scope create authorization revision",
      1,
    );
    const initialArtifactAuthorizationRevision = validateInteger(
      input.initialArtifactAuthorizationRevision,
      "initial artifact authorization revision",
      1,
    );
    const title = input.title;
    validateTitle(title);
    const createdBySubjectId = validateIdentity(input.createdBySubjectId, "creator subject id");
    if (!["spreadsheet", "presentation", "document"].includes(input.modality)) {
      throw new TypeError("Unsupported editable artifact modality");
    }
    const modality = input.modality;
    const genesisSnapshot = ownSnapshotMetadata(input.genesisSnapshot);
    const originalImport = input.originalImport
      ? validateOriginalImport(input.originalImport, modality)
      : null;
    const outbox = cloneOutbox(input.outbox);
    const createdAtIso = genesisSnapshot.publishedAt;
    const commonCandidateArtifact = {
      scope,
      id: artifactId,
      title,
      lifecycle: "active" as const,
      authorizationRevision: initialArtifactAuthorizationRevision,
      headSequence: 0,
      stateHash: genesisSnapshot.stateHash,
      currentSnapshotId: null,
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
    } as const;
    const candidateArtifact: PersistedEditableArtifact =
      modality === "spreadsheet"
        ? Object.freeze({
            ...commonCandidateArtifact,
            modality,
            causalFrontier:
              genesisSnapshot.modality === "spreadsheet"
                ? genesisSnapshot.coveredCausalFrontier
                : Object.freeze([]),
          })
        : Object.freeze({ ...commonCandidateArtifact, modality });
    validateGenesisCreation(candidateArtifact, genesisSnapshot, outbox, operationKind);
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(
            ${`editable-artifact:${operationKind}:${scope.accountId}:${scope.workspaceId}:${authorityKey}:${idempotencyKey}`},
            0
          ))`,
        );
        const authorization = await transactionallyAuthorizeEditableArtifactActor(tx, {
          scope,
          artifactId,
          actor: authorizationActor,
          permission: operationKind,
        });
        if (!authorization.allowed) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        const prior = await rawRows<CreationReceiptRow>(
          tx,
          sql`
          select id, operation_kind, authority_key, idempotency_key, request_hash,
            resource_type, resource_id, result, created_at
          from editable_artifact_idempotency_receipts
          where account_id = ${scope.accountId}::uuid
            and workspace_id = ${scope.workspaceId}::uuid
            and operation_kind = ${operationKind}
            and authority_key_digest = sha256(convert_to(${authorityKey}, 'UTF8'))
            and authority_key = ${authorityKey}
            and idempotency_key = ${idempotencyKey}
          limit 1`,
        );
        if (prior[0]) {
          if (validateHash(prior[0].request_hash, "stored creation request hash") !== requestHash) {
            throw conflict("Artifact create idempotency key was reused with a different request");
          }
          if (prior[0].resource_type !== "artifact") {
            throw corrupt("Artifact creation receipt points at an invalid resource type");
          }
          const priorArtifactId = validateStableId(
            prior[0].resource_id,
            "created artifact resource id",
          );
          const replayRow = await loadArtifactRow(tx, scope, priorArtifactId, false);
          if (!replayRow) throw corrupt("Artifact creation receipt points at a missing artifact");
          const replayArtifact = artifactFromRow(replayRow);
          const creationReceipt = creationReceiptFromRow(scope, prior[0]);
          if (creationReceipt.artifactId !== priorArtifactId) {
            throw corrupt("Artifact creation receipt result disagrees with its resource");
          }
          if (replayArtifact.currentSnapshotId !== creationReceipt.genesisSnapshotId) {
            throw corrupt("Artifact creation receipt disagrees with the genesis snapshot pointer");
          }
          const replaySnapshot = await loadSnapshotMetadata(
            tx,
            scope,
            priorArtifactId,
            creationReceipt.genesisSnapshotId,
          );
          if (!replaySnapshot) {
            throw corrupt("Artifact creation receipt points at a missing genesis snapshot");
          }
          return Object.freeze({
            kind: "result" as const,
            value: Object.freeze({
              artifact: replayArtifact,
              genesisSnapshot: replaySnapshot,
              creationReceipt,
              replayed: true,
            }),
          });
        }
        if (authorization.revision !== expectedScopeAuthorizationRevision) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        const [authorizationHead] = await rawRows<{
          create_revision: string | number | bigint;
        }>(
          tx,
          sql`select opengeni_private.ensure_editable_artifact_scope_authorization_head(
            ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, current_schema()
          ) as create_revision`,
        );
        if (
          !authorizationHead ||
          safeInteger(
            authorizationHead.create_revision,
            "scope create authorization revision",
            1,
          ) !== expectedScopeAuthorizationRevision
        ) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        try {
          await tx.execute(sql`
            insert into editable_artifacts (
              account_id, workspace_id, id, modality, title, lifecycle_state,
              authorization_revision, head_sequence, causal_frontier, state_hash,
              current_snapshot_id, created_by_subject_id, created_at, updated_at
            ) values (
              ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${artifactId},
              ${modality}, ${title}, 'active', ${initialArtifactAuthorizationRevision},
              0, ${
                modality === "spreadsheet"
                  ? json(
                      genesisSnapshot.modality === "spreadsheet"
                        ? genesisSnapshot.coveredCausalFrontier
                        : [],
                    )
                  : sql`null`
              }::jsonb,
              ${genesisSnapshot.stateHash}, ${genesisSnapshot.snapshotId},
              ${createdBySubjectId}, ${createdAtIso}, ${createdAtIso}
            )`);
          await tx.execute(sql`
            insert into editable_artifact_sequence_checkpoints (
              account_id, workspace_id, artifact_id, head_sequence,
              modality, causal_frontier, native_revision, state_hash,
              transaction_id, created_at
            ) values (
              ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${artifactId},
              0, ${modality},
              ${
                modality === "spreadsheet"
                  ? json(
                      genesisSnapshot.modality === "spreadsheet"
                        ? genesisSnapshot.coveredCausalFrontier
                        : [],
                    )
                  : sql`null`
              }::jsonb,
              ${genesisSnapshot.modality === "spreadsheet" ? null : genesisSnapshot.nativeRevision},
              ${genesisSnapshot.stateHash}, null, ${createdAtIso}
            )`);
          await insertSnapshotBlobReference(tx, genesisSnapshot);
          if (originalImport) {
            await insertOriginalImportBlobReference(
              tx,
              scope,
              artifactId,
              originalImport,
              createdAtIso,
            );
          }
          await insertSnapshotMetadata(tx, genesisSnapshot);
          const receiptResult = Object.freeze({
            schemaVersion: 1,
            artifactId,
            genesisSnapshotId: genesisSnapshot.snapshotId,
          });
          await tx.execute(sql`
            insert into editable_artifact_idempotency_receipts (
              account_id, workspace_id, id, artifact_id, operation_kind,
              authority_key, idempotency_key, request_hash, resource_type,
              resource_id, server_transaction_id, result, created_at
            ) values (
              ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${receiptId},
              ${artifactId}, ${operationKind}, ${authorityKey}, ${idempotencyKey},
              ${requestHash}, 'artifact', ${artifactId}, null,
              ${json(receiptResult)}::jsonb, ${createdAtIso}
            )`);
          await insertLiveOutbox(tx, candidateArtifact, outbox);
        } catch (error) {
          throw mapPersistenceError(error, "Editable artifact creation failed");
        }
        const row = await loadArtifactRow(tx, scope, artifactId, false);
        if (!row)
          throw new EditableArtifactPersistenceError(
            "corrupt_history",
            "Created artifact vanished",
          );
        const artifact = artifactFromRow(row);
        return Object.freeze({
          kind: "result" as const,
          value: Object.freeze({
            artifact,
            genesisSnapshot,
            creationReceipt: Object.freeze({
              receiptId,
              scope,
              artifactId,
              operationKind,
              authorityKey,
              idempotencyKey,
              requestHash,
              genesisSnapshotId: genesisSnapshot.snapshotId,
              createdAt: createdAtIso,
            }),
            replayed: false,
          }),
        });
      },
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  async ensureScopeCreateAuthorizationHead(
    scopeInput: PersistedEditableArtifactScope,
  ): Promise<PersistedEditableArtifactScopeAuthorizationHead> {
    const scope = validateScope(scopeInput);
    return await withRlsContext(this.db, scope, async (tx) => {
      const rows = await rawRows<{ create_revision: string | number | bigint }>(
        tx,
        sql`select opengeni_private.ensure_editable_artifact_scope_authorization_head(
          ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, current_schema()
        ) as create_revision`,
      );
      if (!rows[0]) throw corrupt("Scope create authorization head was not materialized");
      return Object.freeze({
        scope,
        createRevision: safeInteger(
          rows[0].create_revision,
          "scope create authorization revision",
          1,
        ),
      });
    });
  }

  async advanceScopeCreateAuthorizationRevision(
    scopeInput: PersistedEditableArtifactScope,
    expectedRevisionInput: number,
    nextRevisionInput: number,
  ): Promise<AdvancePersistedEditableArtifactAuthorizationRevisionResult> {
    const scope = validateScope(scopeInput);
    const expectedRevision = validateInteger(
      expectedRevisionInput,
      "expected scope create authorization revision",
      1,
    );
    const nextRevision = validateInteger(
      nextRevisionInput,
      "next scope create authorization revision",
      1,
    );
    if (nextRevision <= expectedRevision) {
      throw new TypeError("Next scope create authorization revision must advance");
    }
    return await withRlsContext(this.db, scope, async (tx) => {
      const rows = await rawRows<{
        applied: boolean;
        authorization_revision: string | number | bigint;
      }>(
        tx,
        sql`select *
        from opengeni_private.advance_editable_artifact_scope_authorization_revision(
          ${scope.accountId}::uuid,
          ${scope.workspaceId}::uuid,
          ${expectedRevision},
          ${nextRevision},
          current_schema()
        )`,
      );
      if (!rows[0]) throw corrupt("Scope create authorization head advance returned no result");
      return Object.freeze({
        applied: rows[0].applied === true,
        authorizationRevision: safeInteger(
          rows[0].authorization_revision,
          "scope create authorization revision",
          1,
        ),
      });
    });
  }

  async getArtifact(
    scopeInput: PersistedEditableArtifactScope,
    artifactIdInput: string,
  ): Promise<PersistedEditableArtifact | null> {
    const scope = validateScope(scopeInput);
    const artifactId = validateStableId(artifactIdInput, "artifact id");
    return await withRlsContext(this.db, scope, async (tx) => {
      const row = await loadArtifactRow(tx, scope, artifactId, false);
      return row ? artifactFromRow(row) : null;
    });
  }

  async readArtifactAtAuthorizationRevision(
    scopeInput: PersistedEditableArtifactScope,
    artifactIdInput: string,
    expectedAuthorizationRevisionInput: number,
  ): Promise<ReadPersistedEditableArtifactAtAuthorizationRevisionResult> {
    const scope = validateScope(scopeInput);
    const artifactId = validateStableId(artifactIdInput, "artifact id");
    const expectedAuthorizationRevision = validateInteger(
      expectedAuthorizationRevisionInput,
      "expected artifact authorization revision",
      1,
    );
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        // One MVCC read is the fence: absence and a revision mismatch are kept
        // distinct without a check-then-read race.
        const row = await loadArtifactRow(tx, scope, artifactId, false);
        if (!row) return Object.freeze({ kind: "result" as const, artifact: null });
        const artifact = artifactFromRow(row);
        if (artifact.authorizationRevision !== expectedAuthorizationRevision) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        return Object.freeze({ kind: "result" as const, artifact });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async advanceAuthorizationRevision(
    scopeInput: PersistedEditableArtifactScope,
    artifactIdInput: string,
    expectedRevisionInput: number,
    nextRevisionInput: number,
  ): Promise<AdvancePersistedEditableArtifactAuthorizationRevisionResult> {
    const scope = validateScope(scopeInput);
    const artifactId = validateStableId(artifactIdInput, "artifact id");
    const expectedRevision = validateInteger(
      expectedRevisionInput,
      "expected authorization revision",
      0,
    );
    const nextRevision = validateInteger(nextRevisionInput, "next authorization revision", 1);
    if (nextRevision <= expectedRevision) {
      throw new TypeError("Next authorization revision must advance the expected revision");
    }
    return await withRlsContext(this.db, scope, async (tx) => {
      const rows = await rawRows<{
        applied: boolean;
        authorization_revision: string | number | bigint | null;
      }>(
        tx,
        sql`select *
        from opengeni_private.advance_editable_artifact_authorization_revision(
          ${scope.accountId}::uuid,
          ${scope.workspaceId}::uuid,
          ${artifactId},
          ${expectedRevision},
          ${nextRevision},
          current_schema()
        )`,
      );
      const row = rows[0];
      if (!row || row.authorization_revision === null) {
        throw new EditableArtifactPersistenceError(
          "not_found",
          "Editable artifact was not found in the requested tenant scope",
        );
      }
      return Object.freeze({
        applied: row.applied === true,
        authorizationRevision: safeInteger(
          row.authorization_revision,
          "artifact authorization revision",
        ),
      });
    });
  }

  async readTransactionBasis(
    scopeInput: PersistedEditableArtifactScope,
    artifactIdInput: string,
    request: ReadPersistedEditableArtifactTransactionBasisRequest,
  ): Promise<PersistedEditableArtifactTransactionBasis> {
    const scope = validateScope(scopeInput);
    const artifactId = validateStableId(artifactIdInput, "artifact id");
    const actorKey = validateActorKey(request.actorKey).key;
    const clientTransactionId = validateClientTransactionId(request.clientTransactionId);
    const previousLocalTransactionId =
      request.previousLocalTransactionId === null
        ? null
        : validateClientTransactionId(request.previousLocalTransactionId);
    const selectiveUndoOperationIds = parseStableIdArray(
      request.selectiveUndoOperationIds,
      "undo targets",
      10_000,
    );
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const row = await loadArtifactRow(tx, scope, artifactId, false);
        if (!row) {
          throw new EditableArtifactPersistenceError(
            "not_found",
            "Editable artifact was not found in the requested tenant scope",
          );
        }
        const unitOfWork = new PostgresEditableArtifactUnitOfWork(tx, artifactFromRow(row));
        const priorReceipt = await unitOfWork.findReceipt(actorKey, clientTransactionId);
        if (priorReceipt) {
          return Object.freeze({ kind: "existing" as const, receipt: priorReceipt });
        }
        const predecessor = previousLocalTransactionId
          ? await unitOfWork.findReceipt(actorKey, previousLocalTransactionId)
          : null;
        const undoTargets = await loadUndoBasis(tx, scope, artifactId, selectiveUndoOperationIds);
        const kernelState = await unitOfWork.kernelState();
        return Object.freeze({
          kind: "basis" as const,
          artifact: unitOfWork.artifact(),
          predecessor,
          undoTargets,
          kernelState,
        });
      },
      // Every basis member must describe one MVCC snapshot, but no row lock may
      // survive the read. The pure kernel can safely run after this resolves.
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async readSnapshotCompactionBasis(
    scopeInput: PersistedEditableArtifactScope,
    artifactIdInput: string,
    expectedAuthorizationRevisionInput: number,
  ): Promise<
    | Readonly<{ kind: "basis"; state: PersistedEditableArtifactKernelState }>
    | Readonly<{ kind: "authorization_stale" }>
  > {
    const scope = validateScope(scopeInput);
    const artifactId = validateStableId(artifactIdInput, "artifact id");
    const expectedAuthorizationRevision = validateInteger(
      expectedAuthorizationRevisionInput,
      "expected compaction authorization revision",
      1,
    );
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const row = await loadArtifactRow(tx, scope, artifactId, false);
        if (!row) {
          throw new EditableArtifactPersistenceError(
            "not_found",
            "Editable artifact was not found in the requested tenant scope",
          );
        }
        const artifact = artifactFromRow(row);
        if (artifact.authorizationRevision !== expectedAuthorizationRevision) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        const unitOfWork = new PostgresEditableArtifactUnitOfWork(tx, artifact);
        return Object.freeze({ kind: "basis" as const, state: await unitOfWork.kernelState() });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async tryCommitAppliedTransaction(
    request: TryCommitPersistedEditableArtifactTransactionRequest,
  ): Promise<TryCommitPersistedEditableArtifactTransactionResult> {
    const scope = validateScope(request.scope);
    const artifactId = validateStableId(request.artifactId, "artifact id");
    if (request.expectedLifecycle !== "active") {
      throw new TypeError("Optimistic artifact commit requires the active lifecycle");
    }
    const actorKey = validateActorKey(request.actorKey).key;
    const clientTransactionId = validateClientTransactionId(request.clientTransactionId);
    const requestHash = validateHash(request.requestHash, "request hash");
    const authorizationActor = validateLiveTicketActor(request.authorizationActor);
    if (persistedEditableArtifactActorKey(authorizationActor) !== actorKey) {
      throw new TypeError("Artifact commit authority does not match its actor key");
    }
    const expectedAuthorizationRevision = validateInteger(
      request.expectedAuthorizationRevision,
      "expected authorization revision",
      0,
    );
    const expectedUndoTargets = parseStableIdArray(
      request.expectedUnclaimedUndoTargets,
      "expected unclaimed undo targets",
      10_000,
    );
    const expectedPredecessor = validateExpectedPredecessor(request.expectedPredecessor);
    if (
      request.receipt.scope.accountId !== scope.accountId ||
      request.receipt.scope.workspaceId !== scope.workspaceId ||
      request.receipt.artifactId !== artifactId ||
      request.receipt.actorKey !== actorKey ||
      request.receipt.clientTransactionId !== clientTransactionId ||
      request.receipt.requestHash !== requestHash ||
      (request.receipt.modality === "spreadsheet"
        ? !sameStringArray(request.receipt.selectiveUndoOperationIds, expectedUndoTargets)
        : expectedUndoTargets.length !== 0) ||
      (expectedPredecessor === null) !== (request.receipt.previousLocalTransactionId === null) ||
      (expectedPredecessor !== null &&
        request.receipt.previousLocalTransactionId !== expectedPredecessor.clientTransactionId)
    ) {
      throw new TypeError("Optimistic commit preconditions do not match its durable receipt");
    }
    if (expectedPredecessor && expectedPredecessor.actorKey !== actorKey) {
      throw new TypeError("Optimistic predecessor authority does not match the durable receipt");
    }
    // Own every mutable byte buffer and nested collection before the first
    // await. The caller may retain its candidate while this transaction waits;
    // later mutation must never change what was validated or persisted.
    const candidate: TryCommitPersistedEditableArtifactTransactionRequest = Object.freeze({
      ...request,
      scope,
      artifactId,
      actorKey,
      clientTransactionId,
      requestHash,
      expectedAuthorizationRevision,
      authorizationActor,
      expectedPredecessor,
      expectedUnclaimedUndoTargets: expectedUndoTargets,
      receipt: cloneReceipt(request.receipt),
      operations: Object.freeze(request.operations.map(cloneOperation)),
      committedTransaction: cloneCommittedTransaction(request.committedTransaction),
      outbox: cloneOutbox(request.outbox),
    });
    validateOwnedCommitCandidate(candidate);

    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const row = await loadArtifactRow(tx, scope, artifactId, true);
        if (!row) {
          throw new EditableArtifactPersistenceError(
            "not_found",
            "Editable artifact was not found in the requested tenant scope",
          );
        }

        const authorization = await transactionallyAuthorizeEditableArtifactActor(tx, {
          scope,
          artifactId,
          actor: authorizationActor,
          permission: "edit",
        });
        if (!authorization.allowed) {
          return Object.freeze({ kind: "stale" as const });
        }

        // Another candidate may have committed while this transaction waited
        // for the aggregate lock. Recheck idempotency before judging the head.
        const priorAfterLock = await loadReceipt(
          tx,
          scope,
          artifactId,
          actorKey,
          clientTransactionId,
        );
        if (priorAfterLock) {
          return replayResult(priorAfterLock);
        }

        const artifact = artifactFromRow(row);
        if (
          authorization.revision !== candidate.expectedAuthorizationRevision ||
          artifact.lifecycle !== candidate.expectedLifecycle ||
          artifact.authorizationRevision !== candidate.expectedAuthorizationRevision ||
          artifact.headSequence !== candidate.expectedHeadSequence
        ) {
          return Object.freeze({ kind: "stale" as const });
        }

        const unitOfWork = new PostgresEditableArtifactUnitOfWork(tx, artifact);
        if (expectedPredecessor) {
          const predecessor = await unitOfWork.findReceipt(
            expectedPredecessor.actorKey,
            expectedPredecessor.clientTransactionId,
          );
          if (!predecessorMatches(predecessor, expectedPredecessor)) {
            return Object.freeze({ kind: "stale" as const });
          }
        }
        if (
          expectedUndoTargets.length > 0 &&
          (await anyUndoTargetClaimed(tx, scope, artifactId, expectedUndoTargets))
        ) {
          return Object.freeze({ kind: "stale" as const });
        }

        await unitOfWork.commitAppliedTransaction(candidate);
        return Object.freeze({
          kind: "committed" as const,
          receipt: cloneReceipt(candidate.receipt),
        });
      },
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  async withSnapshotPublicationLock<T>(
    scopeInput: PersistedEditableArtifactScope,
    artifactIdInput: string,
    callback: (unitOfWork: PersistedEditableArtifactSnapshotPublicationUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const scope = validateScope(scopeInput);
    const artifactId = validateStableId(artifactIdInput, "artifact id");
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const row = await loadArtifactRow(tx, scope, artifactId, true);
        if (!row) {
          throw new EditableArtifactPersistenceError(
            "not_found",
            "Editable artifact was not found in the requested tenant scope",
          );
        }
        const unitOfWork = new PostgresEditableArtifactUnitOfWork(tx, artifactFromRow(row));
        let open = true;
        const assertOpen = (): void => {
          if (!open) throw conflict("Snapshot publication transaction is already closed");
        };
        const snapshotUnitOfWork: PersistedEditableArtifactSnapshotPublicationUnitOfWork =
          Object.freeze({
            artifact: () => {
              assertOpen();
              return unitOfWork.artifact();
            },
            checkpoint: (headSequence: number) => {
              assertOpen();
              return unitOfWork.checkpoint(headSequence);
            },
            findSnapshot: (snapshotId: string) => {
              assertOpen();
              return unitOfWork.findSnapshot(snapshotId);
            },
            commitSnapshot: (input: CommitPersistedEditableArtifactSnapshot) => {
              assertOpen();
              return unitOfWork.commitSnapshot(input);
            },
          });
        try {
          return await callback(snapshotUnitOfWork);
        } finally {
          open = false;
        }
      },
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  async claimLiveOutbox(
    request: ClaimPersistedEditableArtifactLiveOutboxRequest,
  ): Promise<readonly PersistedEditableArtifactLiveOutboxRecord[]> {
    const owner = validateLeaseOwner(request.owner);
    const leaseDurationMs = validateInteger(
      request.leaseDurationMs,
      "lease duration",
      1,
      86_400_000,
    );
    const limit = validateInteger(request.limit, "claim limit", 1, 1_000);
    const rows = await rawRows<OutboxRow>(
      this.db,
      sql`select * from opengeni_private.claim_editable_artifact_live_outbox(
        ${owner}, ${leaseDurationMs}, ${limit}, current_schema()
      )`,
    );
    return Object.freeze(rows.map(outboxFromRow));
  }

  async markLiveOutboxPublished(input: {
    outboxId: string;
    owner: string;
    attemptCount: number;
  }): Promise<void> {
    const outboxId = validateStableId(input.outboxId, "outbox id");
    const owner = validateLeaseOwner(input.owner);
    const attemptCount = validateInteger(
      input.attemptCount,
      "outbox fencing attempt",
      1,
      1_000_000,
    );
    const rows = await rawRows<{ applied: boolean }>(
      this.db,
      sql`select opengeni_private.mark_editable_artifact_live_outbox_published(
        ${outboxId}, ${owner}, ${attemptCount}, current_schema()
      ) as applied`,
    );
    if (rows[0]?.applied !== true) throw outboxLeaseConflict();
  }

  async renewLiveOutbox(input: {
    outboxId: string;
    owner: string;
    attemptCount: number;
    leaseDurationMs: number;
  }): Promise<void> {
    const outboxId = validateStableId(input.outboxId, "outbox id");
    const owner = validateLeaseOwner(input.owner);
    const attemptCount = validateInteger(
      input.attemptCount,
      "outbox fencing attempt",
      1,
      1_000_000,
    );
    const leaseDurationMs = validateInteger(input.leaseDurationMs, "lease duration", 1, 86_400_000);
    const rows = await rawRows<{ applied: boolean }>(
      this.db,
      sql`select opengeni_private.renew_editable_artifact_live_outbox(
        ${outboxId}, ${owner}, ${attemptCount}, ${leaseDurationMs}, current_schema()
      ) as applied`,
    );
    if (rows[0]?.applied !== true) throw outboxLeaseConflict();
  }

  async retryLiveOutbox(input: {
    outboxId: string;
    owner: string;
    attemptCount: number;
    retryDelayMs: number;
    errorCode: PersistedEditableArtifactOutboxRetryErrorCode;
  }): Promise<void> {
    const outboxId = validateStableId(input.outboxId, "outbox id");
    const owner = validateLeaseOwner(input.owner);
    const attemptCount = validateInteger(
      input.attemptCount,
      "outbox fencing attempt",
      1,
      1_000_000,
    );
    const retryDelayMs = validateInteger(input.retryDelayMs, "outbox retry delay", 1, 86_400_000);
    const validatedErrorCode = validateOutboxRetryErrorCode(input.errorCode);
    const rows = await rawRows<{ applied: boolean }>(
      this.db,
      sql`select opengeni_private.retry_editable_artifact_live_outbox(
        ${outboxId}, ${owner}, ${attemptCount}, ${retryDelayMs}, ${validatedErrorCode}, current_schema()
      ) as applied`,
    );
    if (rows[0]?.applied !== true) throw outboxLeaseConflict();
  }

  async deadLetterLiveOutbox(input: {
    outboxId: string;
    owner: string;
    attemptCount: number;
    errorCode: PersistedEditableArtifactOutboxDeadLetterErrorCode;
  }): Promise<void> {
    const outboxId = validateStableId(input.outboxId, "outbox id");
    const owner = validateLeaseOwner(input.owner);
    const attemptCount = validateInteger(
      input.attemptCount,
      "outbox fencing attempt",
      1,
      1_000_000,
    );
    const validatedErrorCode = validateOutboxDeadLetterErrorCode(input.errorCode);
    const rows = await rawRows<{ applied: boolean }>(
      this.db,
      sql`select opengeni_private.dead_letter_editable_artifact_live_outbox(
        ${outboxId}, ${owner}, ${attemptCount}, ${validatedErrorCode}, current_schema()
      ) as applied`,
    );
    if (rows[0]?.applied !== true) throw outboxLeaseConflict();
  }

  async releaseLiveOutbox(input: {
    outboxId: string;
    owner: string;
    attemptCount: number;
  }): Promise<void> {
    const outboxId = validateStableId(input.outboxId, "outbox id");
    const owner = validateLeaseOwner(input.owner);
    const attemptCount = validateInteger(
      input.attemptCount,
      "outbox fencing attempt",
      1,
      1_000_000,
    );
    const rows = await rawRows<{ applied: boolean }>(
      this.db,
      sql`select opengeni_private.release_editable_artifact_live_outbox(
        ${outboxId}, ${owner}, ${attemptCount}, current_schema()
      ) as applied`,
    );
    if (rows[0]?.applied !== true) throw outboxLeaseConflict();
  }
}

export type PostgresEditableArtifactLiveReadStoreOptions = Readonly<{
  snapshotBytes: PersistedEditableArtifactSnapshotBytesPort;
  replicaLeaseTtlMs?: number;
}>;

/**
 * Durable OGALV read/ACK adapter. PostgreSQL selects the immutable modality
 * before any canonical transaction bytes are decoded; object storage supplies
 * only bytes for already-authoritative snapshot metadata.
 */
export class PostgresEditableArtifactLiveReadStore {
  private readonly replicaLeaseTtlMs: number;

  constructor(
    private readonly db: Database,
    private readonly options: PostgresEditableArtifactLiveReadStoreOptions,
  ) {
    this.replicaLeaseTtlMs = validateInteger(
      options.replicaLeaseTtlMs ?? 5 * 60_000,
      "replica lease ttl",
      1_000,
      86_400_000,
    );
  }

  async readBootstrap(input: {
    scope: PersistedEditableArtifactScope;
    artifactId: string;
    resume: PersistedEditableArtifactLiveResume;
    protocolVersion: number;
  }): Promise<PersistedEditableArtifactLiveBootstrap> {
    const scope = validateScope(input.scope);
    const artifactId = validateStableId(input.artifactId, "artifact id");
    validateInteger(input.protocolVersion, "live protocol version", 1);
    const resume = validateLiveResume(input.resume);
    const authority = await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const current = await loadLiveAuthority(tx, scope, artifactId);
        if (resume.modality !== current.artifact.modality) {
          throw new TypeError("Live resume modality differs from its durable artifact");
        }
        let resumeCheckpoint: PersistedEditableArtifactSequenceCheckpoint | null = null;
        if (
          !resume.requireSnapshot &&
          resume.localCursor !== null &&
          resume.localStateHash !== null &&
          resume.localCursor + 1 >= current.minimumReplaySequence &&
          resume.localCursor <= current.artifact.headSequence
        ) {
          resumeCheckpoint = await loadCheckpoint(tx, scope, artifactId, resume.localCursor);
        }
        const resumeAccepted =
          resumeCheckpoint !== null &&
          resumeCheckpoint.modality === resume.modality &&
          resumeCheckpoint.stateHash === resume.localStateHash &&
          (resume.modality === "spreadsheet"
            ? resumeCheckpoint.modality === "spreadsheet" &&
              sameFrontier(resumeCheckpoint.causalFrontier, resume.localCausalFrontier)
            : resumeCheckpoint.modality !== "spreadsheet" &&
              resumeCheckpoint.nativeRevision === resume.localNativeRevision);
        return Object.freeze({ current, resumeAccepted });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    const snapshot = authority.resumeAccepted
      ? null
      : await this.readVerifiedSnapshotBytes(authority.current.snapshot);
    const resumeSequence = authority.resumeAccepted
      ? resume.localCursor!
      : authority.current.snapshot.coveredHeadSequence;
    const resumeStateHash = authority.resumeAccepted
      ? resume.localStateHash!
      : authority.current.snapshot.stateHash;
    return Object.freeze({
      ...liveHeadFromAuthority(authority.current),
      resumeAccepted: authority.resumeAccepted,
      resumeSequence,
      resumeStateHash,
      snapshot,
    });
  }

  async readHead(
    scopeInput: PersistedEditableArtifactScope,
    artifactIdInput: string,
  ): Promise<PersistedEditableArtifactLiveHead> {
    const scope = validateScope(scopeInput);
    const artifactId = validateStableId(artifactIdInput, "artifact id");
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => liveHeadFromAuthority(await loadLiveAuthority(tx, scope, artifactId)),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async readTransactions(input: {
    scope: PersistedEditableArtifactScope;
    artifactId: string;
    after: number;
    through: number;
    maxCount: number;
    maxBytes: number;
  }): Promise<
    Readonly<{
      transactions: readonly PersistedEditableArtifactLiveCommittedTransaction[];
      headSequence: number;
      minimumReplaySequence: number;
    }>
  > {
    const scope = validateScope(input.scope);
    const artifactId = validateStableId(input.artifactId, "artifact id");
    const after = validateInteger(input.after, "live replay cursor", 0);
    const through = validateInteger(input.through, "live replay target", after);
    const maxCount = validateInteger(input.maxCount, "live replay count", 1, 10_000);
    const maxBytes = validateInteger(
      input.maxBytes,
      "live replay bytes",
      1,
      EDITABLE_ARTIFACT_KERNEL_TAIL_MAX_BYTES,
    );
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const authority = await loadLiveAuthority(tx, scope, artifactId);
        if (through > authority.artifact.headSequence) {
          throw corrupt("Live replay target is beyond the durable head");
        }
        const rows = await loadCommittedTransactionRows(
          tx,
          scope,
          artifactId,
          after,
          through,
          maxCount,
        );
        const transactions: PersistedEditableArtifactLiveCommittedTransaction[] = [];
        let byteSize = 0;
        for (const row of rows) {
          const committed = committedTransactionFromRow(row, authority.artifact.modality);
          const nextSize = byteSize + committed.committedTransactionBytes.byteLength;
          if (nextSize > maxBytes) break;
          transactions.push(liveTransactionFromCommitted(committed));
          byteSize = nextSize;
        }
        return Object.freeze({
          transactions: Object.freeze(transactions),
          headSequence: authority.artifact.headSequence,
          minimumReplaySequence: authority.minimumReplaySequence,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async readCommittedTransaction(input: {
    scope: PersistedEditableArtifactScope;
    artifactId: string;
    transactionId: string;
  }): Promise<PersistedEditableArtifactLiveCommittedTransaction | null> {
    const scope = validateScope(input.scope);
    const artifactId = validateStableId(input.artifactId, "artifact id");
    const transactionId = validateStableId(input.transactionId, "transaction id");
    return await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const artifactRow = await loadArtifactRow(tx, scope, artifactId, false);
        if (!artifactRow) return null;
        const artifact = artifactFromRow(artifactRow);
        const rows = await loadCommittedTransactionRowsById(tx, scope, artifactId, transactionId);
        return rows[0]
          ? liveTransactionFromCommitted(committedTransactionFromRow(rows[0], artifact.modality))
          : null;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async acknowledgeReplica(input: {
    scope: PersistedEditableArtifactScope;
    artifactId: string;
    replicaId: string;
    actorKey: string;
    streamEpoch: string;
    sequence: number;
    stateHash: string;
  }): Promise<void> {
    const scope = validateScope(input.scope);
    const artifactId = validateStableId(input.artifactId, "artifact id");
    const replicaId = validateReplicaId(input.replicaId);
    const actorKey = validateActorKey(input.actorKey).key;
    validateBoundedText(input.streamEpoch, "stream epoch", 512);
    const sequence = validateInteger(input.sequence, "applied sequence", 0);
    const stateHash = validateHash(input.stateHash, "applied state hash");
    await withRlsContext(
      this.db,
      scope,
      async (tx) => {
        const artifactRow = await loadArtifactRow(tx, scope, artifactId, false);
        if (!artifactRow) {
          throw new EditableArtifactPersistenceError(
            "not_found",
            "Editable artifact was not found in the requested tenant scope",
          );
        }
        const artifact = artifactFromRow(artifactRow);
        const checkpoint = await loadCheckpoint(tx, scope, artifactId, sequence);
        if (
          !checkpoint ||
          checkpoint.modality !== artifact.modality ||
          checkpoint.stateHash !== stateHash
        ) {
          throw corrupt("Replica ACK differs from its durable checkpoint");
        }
        const frontierSql =
          checkpoint.modality === "spreadsheet"
            ? sql`${json(checkpoint.causalFrontier)}::jsonb`
            : sql`null`;
        const nativeRevision =
          checkpoint.modality === "spreadsheet" ? null : checkpoint.nativeRevision;
        const applied = await rawRows<{ applied_head_sequence: string | number | bigint }>(
          tx,
          sql`
          insert into editable_artifact_replica_leases (
            account_id, workspace_id, artifact_id, modality, replica_id, actor_key,
            applied_head_sequence, causal_frontier, native_revision,
            lease_expires_at, last_seen_at, revoked_at
          ) values (
            ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${artifactId},
            ${artifact.modality}, ${replicaId}, ${actorKey}, ${sequence},
            ${frontierSql}, ${nativeRevision},
            clock_timestamp() + (${this.replicaLeaseTtlMs} * interval '1 millisecond'),
            clock_timestamp(), null
          )
          on conflict (account_id, workspace_id, artifact_id, replica_id)
          do update set
            applied_head_sequence = excluded.applied_head_sequence,
            causal_frontier = excluded.causal_frontier,
            native_revision = excluded.native_revision,
            lease_expires_at = excluded.lease_expires_at,
            last_seen_at = excluded.last_seen_at
          where editable_artifact_replica_leases.revoked_at is null
            and editable_artifact_replica_leases.actor_key = excluded.actor_key
            and editable_artifact_replica_leases.applied_head_sequence <=
              excluded.applied_head_sequence
          returning applied_head_sequence
        `,
        );
        if (applied.length !== 1) {
          throw conflict("Replica ACK did not advance its durable lease");
        }
      },
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  private async readVerifiedSnapshotBytes(
    snapshot: PersistedEditableArtifactSnapshotMetadata,
  ): Promise<PersistedEditableArtifactLiveSnapshot> {
    const bytes = await this.options.snapshotBytes.readSnapshotBytes(snapshot);
    if (!(bytes instanceof Uint8Array)) {
      throw corrupt("Snapshot byte reader returned a non-binary value");
    }
    if (bytes.byteLength !== snapshot.byteSize) {
      throw corrupt("Snapshot bytes differ from durable byte size");
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== snapshot.contentHash) {
      throw corrupt("Snapshot bytes differ from durable content hash");
    }
    const owned = bytes.slice();
    const common = {
      artifactId: snapshot.artifactId,
      sequence: snapshot.coveredHeadSequence,
      stateHash: snapshot.stateHash,
      digest: snapshot.contentHash,
      kernelVersion: snapshot.kernelVersion,
      modelSchemaVersion: snapshot.modelSchemaVersion,
      bytes: owned,
    } as const;
    return snapshot.modality === "spreadsheet"
      ? Object.freeze({
          ...common,
          modality: snapshot.modality,
          causalFrontier: snapshot.coveredCausalFrontier,
          operationProtocolVersion: snapshot.operationProtocolVersion,
        })
      : Object.freeze({
          ...common,
          modality: snapshot.modality,
          nativeRevision: snapshot.nativeRevision,
        });
  }
}

class PostgresEditableArtifactUnitOfWork implements PersistedEditableArtifactUnitOfWork {
  private committed = false;

  constructor(
    private readonly tx: Database,
    private currentArtifact: PersistedEditableArtifact,
  ) {}

  artifact(): PersistedEditableArtifact {
    return cloneArtifact(this.currentArtifact);
  }

  async findReceipt(
    actorKeyInput: string,
    clientTransactionIdInput: string,
  ): Promise<PersistedEditableArtifactReceipt | null> {
    const actorKey = validateActorKey(actorKeyInput).key;
    const clientTransactionId = validateClientTransactionId(clientTransactionIdInput);
    return await loadReceipt(
      this.tx,
      this.currentArtifact.scope,
      this.currentArtifact.id,
      actorKey,
      clientTransactionId,
    );
  }

  async findOperation(
    operationIdInput: string,
  ): Promise<PersistedEditableArtifactOperationRecord | null> {
    const operationId = validateStableId(operationIdInput, "operation id");
    const rows = await rawRows<OperationRow>(
      this.tx,
      sql`select account_id, workspace_id, artifact_id, transaction_id,
        operation_id, operation_index, sequence, dot_replica_id, dot_counter,
        actor_key, created_at
      from editable_artifact_operations
      where account_id = ${this.currentArtifact.scope.accountId}::uuid
        and workspace_id = ${this.currentArtifact.scope.workspaceId}::uuid
        and artifact_id = ${this.currentArtifact.id}
        and operation_id = ${operationId}
      limit 1`,
    );
    return rows[0] ? operationFromRow(rows[0]) : null;
  }

  async findUndoClaim(operationIdInput: string): Promise<string | null> {
    const operationId = validateStableId(operationIdInput, "operation id");
    const rows = await rawRows<{ claiming_transaction_id: string }>(
      this.tx,
      sql`
      select claiming_transaction_id
      from editable_artifact_undo_claims
      where account_id = ${this.currentArtifact.scope.accountId}::uuid
        and workspace_id = ${this.currentArtifact.scope.workspaceId}::uuid
        and artifact_id = ${this.currentArtifact.id}
        and target_operation_id = ${operationId}
      limit 1`,
    );
    return rows[0]
      ? validateStableId(rows[0].claiming_transaction_id, "claiming transaction id")
      : null;
  }

  async kernelState(): Promise<PersistedEditableArtifactKernelState> {
    const snapshot = this.currentArtifact.currentSnapshotId
      ? await this.findSnapshot(this.currentArtifact.currentSnapshotId)
      : null;
    if (this.currentArtifact.currentSnapshotId && !snapshot) {
      throw corrupt("Artifact current snapshot pointer has no immutable snapshot");
    }
    if (snapshot && snapshot.modality !== this.currentArtifact.modality) {
      throw corrupt("Artifact current snapshot modality differs from its durable artifact");
    }
    const coveredSequence = snapshot?.coveredHeadSequence ?? 0;
    const expectedSequenceSpan = this.currentArtifact.headSequence - coveredSequence;
    if (expectedSequenceSpan < 0) throw corrupt("Snapshot coverage is beyond artifact head");
    const [tailFacts] = await rawRows<{
      transaction_count: string | number | bigint;
      operation_count: string | number | bigint;
      byte_size: string | number | bigint;
    }>(
      this.tx,
      sql`select
        count(*) as transaction_count,
        coalesce(sum(operation_count), 0) as operation_count,
        coalesce(sum(committed_transaction_byte_size), 0) as byte_size
      from editable_artifact_transactions
      where account_id = ${this.currentArtifact.scope.accountId}::uuid
        and workspace_id = ${this.currentArtifact.scope.workspaceId}::uuid
        and artifact_id = ${this.currentArtifact.id}
        and sequence_start > ${coveredSequence}`,
    );
    const storedTransactionCount = safeInteger(
      tailFacts?.transaction_count ?? 0,
      "stored committed transaction tail count",
    );
    const storedOperationCount = safeInteger(
      tailFacts?.operation_count ?? 0,
      "stored committed transaction operation count",
    );
    const storedByteSize = safeInteger(
      tailFacts?.byte_size ?? 0,
      "stored committed transaction tail bytes",
    );
    if (
      (this.currentArtifact.modality === "spreadsheet" &&
        storedOperationCount !== expectedSequenceSpan) ||
      (this.currentArtifact.modality !== "spreadsheet" &&
        (storedOperationCount !== 0 || storedTransactionCount !== expectedSequenceSpan))
    ) {
      throw corrupt("Committed transaction tail does not match the authoritative head");
    }
    if (storedTransactionCount > EDITABLE_ARTIFACT_KERNEL_TAIL_MAX_TRANSACTIONS) {
      throw new EditableArtifactPersistenceError(
        "history_limit",
        "Artifact committed transaction tail exceeds its replay count limit; publish a snapshot",
      );
    }
    if (storedByteSize > EDITABLE_ARTIFACT_KERNEL_TAIL_MAX_BYTES) {
      throw new EditableArtifactPersistenceError(
        "history_limit",
        "Artifact committed transaction tail exceeds its byte replay limit; publish a snapshot",
      );
    }
    const rows = await rawRows<CommittedTransactionRow>(
      this.tx,
      sql`select account_id, workspace_id, artifact_id, id, request_hash,
        modality, sequence_start, sequence_end, prior_state_hash, state_hash,
        replica_id, replica_counter, resolved_causal_base, resulting_causal_frontier,
        operation_count, operation_ids, operation_protocol_version, model_schema_version,
        commit_protocol_version, prior_native_revision, native_revision, command_count,
        native_receipt_byte_size, native_receipt_hash, native_receipt_bytes,
        kernel_version, committed_transaction_byte_size, committed_transaction_hash,
        committed_transaction_bytes, committed_at
      from editable_artifact_transactions
      where account_id = ${this.currentArtifact.scope.accountId}::uuid
        and workspace_id = ${this.currentArtifact.scope.workspaceId}::uuid
        and artifact_id = ${this.currentArtifact.id}
        and sequence_start > ${coveredSequence}
      order by sequence_start
      limit ${EDITABLE_ARTIFACT_KERNEL_TAIL_MAX_TRANSACTIONS + 1}`,
    );
    if (rows.length !== storedTransactionCount) {
      throw corrupt("Committed transaction tail changed during its repeatable read");
    }
    const committedTransactionTail = rows.map((row) =>
      committedTransactionFromRow(row, this.currentArtifact.modality),
    );
    let expectedSequence = coveredSequence + 1;
    let reconstructedBytes = 0;
    for (const transaction of committedTransactionTail) {
      if (transaction.sequenceStart !== expectedSequence) {
        throw corrupt("Committed transaction history contains a sequence gap");
      }
      expectedSequence = transaction.sequenceEnd + 1;
      reconstructedBytes += transaction.committedTransactionBytes.byteLength;
    }
    if (expectedSequence !== this.currentArtifact.headSequence + 1) {
      throw corrupt("Committed transaction history does not end at the artifact head");
    }
    if (reconstructedBytes !== storedByteSize) {
      throw corrupt("Committed transaction tail byte preflight disagrees with reconstruction");
    }
    if (this.currentArtifact.modality === "spreadsheet") {
      if (snapshot?.modality !== undefined && snapshot.modality !== "spreadsheet") {
        throw corrupt("Spreadsheet artifact has a serialized snapshot");
      }
      if (committedTransactionTail.some((entry) => entry.modality !== "spreadsheet")) {
        throw corrupt("Spreadsheet artifact has a serialized transaction tail");
      }
      return Object.freeze({
        modality: "spreadsheet" as const,
        artifact: cloneArtifact(this.currentArtifact),
        snapshot: (snapshot ?? null) as Extract<
          PersistedEditableArtifactSnapshotMetadata,
          { modality: "spreadsheet" }
        > | null,
        tailTransactionCount: storedTransactionCount,
        tailByteSize: storedByteSize,
        committedTransactionTail: Object.freeze(
          committedTransactionTail as Extract<
            PersistedEditableArtifactCommittedTransactionRecord,
            { modality: "spreadsheet" }
          >[],
        ),
      });
    }
    if (
      snapshot?.modality === "spreadsheet" ||
      committedTransactionTail.some((entry) => entry.modality !== this.currentArtifact.modality)
    ) {
      throw corrupt("Serialized artifact history contains a cross-modality record");
    }
    return Object.freeze({
      modality: this.currentArtifact.modality,
      artifact: cloneArtifact(this.currentArtifact),
      snapshot: (snapshot ?? null) as Extract<
        PersistedEditableArtifactSnapshotMetadata,
        { modality: "document" | "presentation" }
      > | null,
      tailTransactionCount: storedTransactionCount,
      tailByteSize: storedByteSize,
      baseNativeRevision: snapshot?.nativeRevision ?? 0,
      committedTransactionTail: Object.freeze(
        committedTransactionTail as Extract<
          PersistedEditableArtifactCommittedTransactionRecord,
          { modality: "document" | "presentation" }
        >[],
      ),
    });
  }

  async checkpoint(
    headSequenceInput: number,
  ): Promise<PersistedEditableArtifactSequenceCheckpoint | null> {
    const headSequence = validateInteger(
      headSequenceInput,
      "checkpoint sequence",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const rows = await rawRows<{
      head_sequence: string | number | bigint;
      modality: string;
      causal_frontier: unknown | null;
      native_revision: string | number | bigint | null;
      state_hash: string;
    }>(
      this.tx,
      sql`
      select head_sequence, modality, causal_frontier, native_revision, state_hash
      from editable_artifact_sequence_checkpoints
      where account_id = ${this.currentArtifact.scope.accountId}::uuid
        and workspace_id = ${this.currentArtifact.scope.workspaceId}::uuid
        and artifact_id = ${this.currentArtifact.id}
        and head_sequence = ${headSequence}
      limit 1`,
    );
    if (!rows[0]) return null;
    const row = rows[0];
    if (row.modality !== this.currentArtifact.modality) {
      throw corrupt("Checkpoint modality differs from its durable artifact");
    }
    const common = {
      modality: row.modality,
      headSequence: safeInteger(row.head_sequence, "checkpoint sequence"),
      stateHash: validateHash(row.state_hash, "checkpoint state hash"),
    } as const;
    return row.modality === "spreadsheet"
      ? Object.freeze({
          ...common,
          modality: "spreadsheet" as const,
          causalFrontier: parseFrontier(row.causal_frontier),
        })
      : Object.freeze({
          ...common,
          modality: serializedModality(row.modality, "checkpoint modality"),
          nativeRevision: safeInteger(row.native_revision, "checkpoint native revision"),
        });
  }

  async findSnapshot(
    snapshotIdInput: string,
  ): Promise<PersistedEditableArtifactSnapshotMetadata | null> {
    const snapshotId = validateStableId(snapshotIdInput, "snapshot id");
    return await loadSnapshotMetadata(
      this.tx,
      this.currentArtifact.scope,
      this.currentArtifact.id,
      snapshotId,
    );
  }

  async commitAppliedTransaction(input: CommitPersistedEditableArtifactTransaction): Promise<void> {
    this.assertUncommitted();
    const intentBytes = validateAppliedCommit(this.currentArtifact, input);
    const receipt = input.receipt;
    const committedTransaction = input.committedTransaction;
    if (committedTransaction.modality !== receipt.modality) {
      throw new TypeError("Committed transaction modality differs from its receipt");
    }
    const authority = validateActorKey(receipt.actorKey);
    const replicaId = receipt.replicaId;
    if (
      receipt.modality === "spreadsheet" &&
      input.operations.some((operation) => operation.dot.replicaId !== replicaId)
    ) {
      throw new TypeError("One transaction may advance exactly one replica namespace");
    }
    if (receipt.previousLocalTransactionId === null) {
      if (receipt.replicaCounter !== 1) {
        throw new TypeError("A replica's first transaction must reserve counter one");
      }
      if (
        receipt.modality === "spreadsheet" &&
        !sameFrontier(receipt.resolvedCausalBase, receipt.causalBase)
      ) {
        throw new TypeError("First replica transaction must not invent a resolved predecessor");
      }
    } else {
      const predecessor = await this.findReceipt(
        receipt.actorKey,
        receipt.previousLocalTransactionId,
      );
      if (
        !predecessor ||
        predecessor.replicaId !== receipt.replicaId ||
        predecessor.replicaCounter + 1 !== receipt.replicaCounter
      ) {
        throw conflict("Previous local transaction does not match the replica counter chain");
      }
      if (predecessor.modality !== receipt.modality) {
        throw conflict("Previous local transaction belongs to another artifact modality");
      }
      if (receipt.modality === "spreadsheet") {
        if (predecessor.modality !== "spreadsheet") {
          throw conflict("Spreadsheet predecessor belongs to another modality");
        }
        const expectedResolvedBase = mergeFrontiers(
          receipt.causalBase,
          predecessor.resolvedCausalBase,
          [
            {
              replicaId: predecessor.replicaId,
              counter: predecessor.replicaCounter,
            },
          ],
        );
        if (!sameFrontier(receipt.resolvedCausalBase, expectedResolvedBase)) {
          throw new TypeError("Resolved causal base does not exactly include its predecessor dot");
        }
      }
    }
    validateTransactionOutbox(input.outbox, receipt);
    const causalBase =
      receipt.modality === "spreadsheet" ? parseFrontier(receipt.causalBase) : null;
    const resolvedCausalBase =
      receipt.modality === "spreadsheet" ? parseFrontier(receipt.resolvedCausalBase) : null;
    const resultingCausalFrontier =
      receipt.modality === "spreadsheet" ? parseFrontier(receipt.resultingCausalFrontier) : null;
    const selectiveUndoOperationIds =
      receipt.modality === "spreadsheet"
        ? parseStableIdArray(receipt.selectiveUndoOperationIds, "undo targets", 10_000)
        : null;
    const causalBaseSql = causalBase === null ? sql`null` : sql`${json(causalBase)}::jsonb`;
    const resolvedCausalBaseSql =
      resolvedCausalBase === null ? sql`null` : sql`${json(resolvedCausalBase)}::jsonb`;
    const resultingCausalFrontierSql =
      resultingCausalFrontier === null ? sql`null` : sql`${json(resultingCausalFrontier)}::jsonb`;
    const operationIdsSql =
      committedTransaction.modality === "spreadsheet"
        ? sql`${json(committedTransaction.operationIds)}::jsonb`
        : sql`null`;
    const selectiveUndoSql =
      selectiveUndoOperationIds === null
        ? sql`null`
        : sql`${json(selectiveUndoOperationIds)}::jsonb`;
    let persistedUpdatedAt = receipt.committedAt;
    try {
      await this.tx.execute(sql`
        insert into editable_artifact_transactions (
          account_id, workspace_id, artifact_id, id, modality, parent_head_sequence,
          client_transaction_id, request_hash, sequence_start, sequence_end,
          prior_state_hash,
          intent_hash, intent_byte_size, intent_bytes,
          replica_counter, previous_local_transaction_id,
          causal_base, resolved_causal_base, resulting_causal_frontier,
          state_hash, operation_count, operation_ids,
          selective_undo_targets, intent_envelope_version, intent_protocol_version,
          command_protocol_version,
          actor_kind, actor_subject_id, actor_key,
          replica_id, agent_session_id, agent_turn_id, agent_attempt_id,
          agent_generation, service_name, kernel_version, model_schema_version,
          operation_protocol_version, commit_protocol_version,
          prior_native_revision, native_revision, command_count,
          native_receipt_byte_size, native_receipt_hash, native_receipt_bytes,
          committed_transaction_byte_size,
          committed_transaction_hash, committed_transaction_bytes, committed_at
        ) values (
          ${receipt.scope.accountId}::uuid, ${receipt.scope.workspaceId}::uuid,
          ${receipt.artifactId}, ${input.serverTransactionId}, ${receipt.modality},
          ${input.expectedHeadSequence},
          ${receipt.clientTransactionId}, ${receipt.requestHash}, ${receipt.sequenceStart},
          ${receipt.sequenceEnd}, ${receipt.priorStateHash}, ${receipt.requestHash},
          ${intentBytes.byteLength},
          ${intentBytes}, ${receipt.replicaCounter},
          ${receipt.previousLocalTransactionId}, ${causalBaseSql},
          ${resolvedCausalBaseSql},
          ${resultingCausalFrontierSql}, ${receipt.stateHash},
          ${receipt.modality === "spreadsheet" ? receipt.operationCount : null},
          ${operationIdsSql}, ${selectiveUndoSql},
          ${receipt.intentEnvelopeVersion}, ${receipt.intentProtocolVersion},
          ${receipt.commandProtocolVersion},
          ${authority.kind}, ${authority.subjectId}, ${authority.key}, ${replicaId},
          ${authority.kind === "agent" ? authority.sessionId : null},
          ${authority.kind === "agent" ? authority.turnId : null},
          ${authority.kind === "agent" ? authority.attemptId : null},
          ${authority.kind === "agent" ? authority.generation : null},
          ${authority.kind === "service" ? authority.service : null},
          ${receipt.kernelVersion}, ${receipt.modelSchemaVersion},
          ${receipt.modality === "spreadsheet" ? receipt.operationProtocolVersion : null},
          ${receipt.modality === "spreadsheet" ? null : receipt.commitProtocolVersion},
          ${receipt.modality === "spreadsheet" ? null : receipt.priorNativeRevision},
          ${receipt.modality === "spreadsheet" ? null : receipt.nativeRevision},
          ${receipt.modality === "spreadsheet" ? null : receipt.commandCount},
          ${
            committedTransaction.modality === "spreadsheet"
              ? null
              : committedTransaction.nativeReceiptBytes.byteLength
          },
          ${
            committedTransaction.modality === "spreadsheet"
              ? null
              : `sha256:${createHash("sha256")
                  .update(committedTransaction.nativeReceiptBytes)
                  .digest("hex")}`
          },
          ${
            committedTransaction.modality === "spreadsheet"
              ? null
              : committedTransaction.nativeReceiptBytes
          },
          ${committedTransaction.committedTransactionBytes.byteLength},
          ${`sha256:${createHash("sha256")
            .update(committedTransaction.committedTransactionBytes)
            .digest("hex")}`},
          ${committedTransaction.committedTransactionBytes}, ${receipt.committedAt}
        )`);
      await this.tx.execute(sql`
        insert into editable_artifact_idempotency_receipts (
          account_id, workspace_id, id, artifact_id, operation_kind,
          authority_key, idempotency_key, request_hash, resource_type,
          resource_id, server_transaction_id, result, created_at
        ) values (
          ${receipt.scope.accountId}::uuid, ${receipt.scope.workspaceId}::uuid,
          ${receipt.receiptId}, ${receipt.artifactId}, 'edit', ${receipt.actorKey},
          ${receipt.clientTransactionId}, ${receipt.requestHash}, 'transaction',
          ${receipt.serverTransactionId}, ${receipt.serverTransactionId},
          '{"schemaVersion":1}'::jsonb,
          ${receipt.committedAt}
        )`);
      if (receipt.modality === "spreadsheet") {
        await this.insertOperations(input.operations);
        await this.insertUndoClaims(receipt);
      }
      await this.tx.execute(sql`
        insert into editable_artifact_sequence_checkpoints (
          account_id, workspace_id, artifact_id, head_sequence,
          modality, causal_frontier, native_revision, state_hash,
          transaction_id, created_at
        ) values (
          ${receipt.scope.accountId}::uuid, ${receipt.scope.workspaceId}::uuid,
          ${receipt.artifactId}, ${receipt.sequenceEnd}, ${receipt.modality},
          ${resultingCausalFrontierSql},
          ${receipt.modality === "spreadsheet" ? null : receipt.nativeRevision},
          ${receipt.stateHash},
          ${receipt.serverTransactionId}, ${receipt.committedAt}
        )`);
      await this.insertOutbox(input.outbox);
      const updated = await rawRows<{ id: string; updated_at: Date | string }>(
        this.tx,
        sql`
        update editable_artifacts
        set head_sequence = ${receipt.sequenceEnd},
            causal_frontier = ${resultingCausalFrontierSql},
            state_hash = ${receipt.stateHash},
            updated_at = greatest(updated_at, ${receipt.committedAt}::timestamptz)
        where account_id = ${receipt.scope.accountId}::uuid
          and workspace_id = ${receipt.scope.workspaceId}::uuid
          and id = ${receipt.artifactId}
          and head_sequence = ${input.expectedHeadSequence}
        returning id, updated_at`,
      );
      if (updated.length !== 1) throw conflict("Artifact head changed during locked commit");
      persistedUpdatedAt = iso(updated[0]!.updated_at, "artifact update time");
    } catch (error) {
      throw mapPersistenceError(error, "Editable artifact transaction commit failed");
    }
    this.currentArtifact =
      receipt.modality === "spreadsheet" && this.currentArtifact.modality === "spreadsheet"
        ? Object.freeze({
            ...this.currentArtifact,
            headSequence: receipt.sequenceEnd,
            causalFrontier: cloneFrontier(receipt.resultingCausalFrontier),
            stateHash: receipt.stateHash,
            updatedAt: persistedUpdatedAt,
          })
        : Object.freeze({
            ...this.currentArtifact,
            headSequence: receipt.sequenceEnd,
            stateHash: receipt.stateHash,
            updatedAt: persistedUpdatedAt,
          });
    this.committed = true;
  }

  async commitSnapshot(
    input: CommitPersistedEditableArtifactSnapshot,
  ): Promise<CommitPersistedEditableArtifactSnapshotResult> {
    this.assertUncommitted();
    const candidate = ownSnapshotCommit(input);
    validateSnapshotCommit(this.currentArtifact, candidate);
    const snapshot = candidate.snapshot;
    const checkpoint = await this.checkpoint(snapshot.coveredHeadSequence);
    if (
      !checkpoint ||
      checkpoint.modality !== snapshot.modality ||
      checkpoint.stateHash !== snapshot.stateHash ||
      (checkpoint.modality === "spreadsheet" && snapshot.modality === "spreadsheet"
        ? !sameFrontier(checkpoint.causalFrontier, snapshot.coveredCausalFrontier)
        : checkpoint.modality !== "spreadsheet" && snapshot.modality !== "spreadsheet"
          ? checkpoint.nativeRevision !== snapshot.nativeRevision
          : true)
    ) {
      throw conflict("Snapshot does not match an authoritative transaction boundary");
    }
    if (this.currentArtifact.currentSnapshotId) {
      const current = await this.findSnapshot(this.currentArtifact.currentSnapshotId);
      if (!current) throw corrupt("Current snapshot pointer has no immutable metadata");
      if (current.modality !== snapshot.modality) {
        throw corrupt("Current and candidate snapshots have different modalities");
      }
      if (snapshot.coveredHeadSequence <= current.coveredHeadSequence) {
        throw conflict("Snapshot publication must advance authoritative coverage");
      }
    }
    validateSnapshotOutbox(candidate.outbox, snapshot);
    const authorization = await transactionallyAuthorizeEditableArtifactActor(this.tx, {
      scope: this.currentArtifact.scope,
      artifactId: this.currentArtifact.id,
      actor: candidate.authorizationActor,
      permission: candidate.authorizationPermission ?? "manage",
    });
    if (
      !authorization.allowed ||
      authorization.revision !== candidate.expectedAuthorizationRevision
    ) {
      return Object.freeze({ kind: "authorization_stale" as const });
    }
    let persistedUpdatedAt = snapshot.publishedAt;
    try {
      const blobRefId = await this.ensureSnapshotBlobReference(snapshot);
      await insertSnapshotMetadata(this.tx, snapshot, blobRefId);
      await this.insertOutbox(candidate.outbox);
      const expectedSnapshot = candidate.expectedCurrentSnapshotId;
      const updated = await rawRows<{ id: string; updated_at: Date | string }>(
        this.tx,
        sql`
        update editable_artifacts
        set current_snapshot_id = ${snapshot.snapshotId},
            updated_at = greatest(updated_at, ${snapshot.publishedAt}::timestamptz)
        where account_id = ${snapshot.scope.accountId}::uuid
          and workspace_id = ${snapshot.scope.workspaceId}::uuid
          and id = ${snapshot.artifactId}
          and authorization_revision = ${candidate.expectedAuthorizationRevision}
          and ${
            expectedSnapshot === null
              ? sql`current_snapshot_id is null`
              : sql`current_snapshot_id = ${expectedSnapshot}`
          }
        returning id, updated_at`,
      );
      if (updated.length !== 1) throw conflict("Current snapshot changed during locked commit");
      persistedUpdatedAt = iso(updated[0]!.updated_at, "artifact update time");
    } catch (error) {
      throw mapPersistenceError(error, "Editable artifact snapshot commit failed");
    }
    this.currentArtifact = Object.freeze({
      ...this.currentArtifact,
      currentSnapshotId: snapshot.snapshotId,
      updatedAt: persistedUpdatedAt,
    });
    this.committed = true;
    return Object.freeze({ kind: "committed" as const });
  }

  private async insertOperations(
    operations: readonly PersistedEditableArtifactOperationRecord[],
  ): Promise<void> {
    for (let offset = 0; offset < operations.length; offset += 1_000) {
      const values = sql.join(
        operations.slice(offset, offset + 1_000).map((operation, chunkIndex) => {
          const operationIndex = offset + chunkIndex;
          return sql`(
            ${operation.scope.accountId}::uuid, ${operation.scope.workspaceId}::uuid,
            ${operation.artifactId}, ${operation.serverTransactionId},
            ${operation.operationId}, ${operationIndex}, ${operation.sequence},
            ${operation.dot.replicaId}, ${operation.dot.counter},
            ${operation.actorKey}, ${operation.createdAt}
          )`;
        }),
        sql`, `,
      );
      await this.tx.execute(sql`
        insert into editable_artifact_operations (
          account_id, workspace_id, artifact_id, transaction_id,
          operation_id, operation_index, sequence, dot_replica_id,
          dot_counter, actor_key, created_at
        ) values ${values}`);
    }
  }

  private async insertUndoClaims(
    receipt: Extract<PersistedEditableArtifactReceipt, { modality: "spreadsheet" }>,
  ): Promise<void> {
    for (let offset = 0; offset < receipt.selectiveUndoOperationIds.length; offset += 2_000) {
      const values = sql.join(
        receipt.selectiveUndoOperationIds.slice(offset, offset + 2_000).map(
          (target) => sql`(
            ${receipt.scope.accountId}::uuid, ${receipt.scope.workspaceId}::uuid,
            ${receipt.artifactId}, ${target}, ${receipt.serverTransactionId},
            ${receipt.committedAt}
          )`,
        ),
        sql`, `,
      );
      await this.tx.execute(sql`
        insert into editable_artifact_undo_claims (
          account_id, workspace_id, artifact_id, target_operation_id,
          claiming_transaction_id, created_at
        ) values ${values}`);
    }
  }

  private async insertOutbox(record: PersistedEditableArtifactLiveOutboxRecord): Promise<void> {
    await insertLiveOutbox(this.tx, this.currentArtifact, record);
  }

  private async ensureSnapshotBlobReference(
    snapshot: PersistedEditableArtifactSnapshotMetadata,
  ): Promise<string> {
    const rows = await rawRows<{
      id: string;
      object_reference: string;
      byte_size: string | number | bigint;
      mime_type: string;
    }>(
      this.tx,
      sql`
      select id, object_reference, byte_size, mime_type
      from editable_artifact_blob_refs
      where account_id = ${snapshot.scope.accountId}::uuid
        and workspace_id = ${snapshot.scope.workspaceId}::uuid
        and artifact_id = ${snapshot.artifactId}
        and kind = 'snapshot'
        and content_hash = ${snapshot.contentHash}
      limit 1`,
    );
    const existing = rows[0];
    if (existing) {
      if (
        existing.object_reference !== snapshot.blobReference ||
        safeInteger(existing.byte_size, "snapshot blob byte size", 1) !== snapshot.byteSize ||
        existing.mime_type !== snapshot.mimeType
      ) {
        throw conflict("Snapshot content hash is already bound to different blob facts");
      }
      return validateStableId(existing.id, "snapshot blob reference id");
    }
    await this.tx.execute(sql`
      insert into editable_artifact_blob_refs (
        account_id, workspace_id, artifact_id, id, kind, object_reference,
        byte_size, content_hash, mime_type, created_at
      ) values (
        ${snapshot.scope.accountId}::uuid, ${snapshot.scope.workspaceId}::uuid,
        ${snapshot.artifactId}, ${snapshot.snapshotId}, 'snapshot',
        ${snapshot.blobReference}, ${snapshot.byteSize}, ${snapshot.contentHash},
        ${snapshot.mimeType}, ${snapshot.publishedAt}
      )`);
    return snapshot.snapshotId;
  }

  private assertUncommitted(): void {
    if (this.committed) throw conflict("Artifact unit of work may commit exactly once");
  }
}

async function loadArtifactRow(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  forUpdate: boolean,
): Promise<ArtifactRow | null> {
  const rows = await rawRows<ArtifactRow>(
    db,
    sql`
    select account_id, workspace_id, id, modality, title, lifecycle_state,
      authorization_revision, head_sequence, causal_frontier, state_hash, current_snapshot_id,
      created_at, updated_at
    from editable_artifacts
    where account_id = ${scope.accountId}::uuid
      and workspace_id = ${scope.workspaceId}::uuid
      and id = ${artifactId}
    ${forUpdate ? sql`for update` : sql``}
    limit 1`,
  );
  return rows[0] ?? null;
}

async function loadSnapshotMetadata(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  snapshotId: string,
): Promise<PersistedEditableArtifactSnapshotMetadata | null> {
  const rows = await rawRows<SnapshotRow>(
    db,
    sql`
    select s.account_id, s.workspace_id, s.artifact_id, s.id,
      s.modality,
      b.object_reference as blob_reference, b.byte_size as blob_byte_size,
      b.content_hash as blob_content_hash, b.mime_type as blob_mime_type,
      s.byte_size, s.content_hash, s.mime_type, s.covered_head_sequence,
      s.covered_causal_frontier, s.state_hash, s.model_schema_version,
      s.operation_protocol_version, s.kernel_version, s.crdt_state_version,
      s.native_revision,
      s.verified_at, s.published_at
    from editable_artifact_snapshots s
    join editable_artifact_blob_refs b
      on b.account_id = s.account_id
     and b.workspace_id = s.workspace_id
     and b.artifact_id = s.artifact_id
     and b.id = s.blob_ref_id
    where s.account_id = ${scope.accountId}::uuid
      and s.workspace_id = ${scope.workspaceId}::uuid
      and s.artifact_id = ${artifactId}
      and s.id = ${snapshotId}
    limit 1`,
  );
  return rows[0] ? snapshotFromRow(rows[0]) : null;
}

type NormalizedPersistedEditableArtifactLiveResume =
  | Readonly<{
      modality: "spreadsheet";
      localCursor: number | null;
      localStateHash: string | null;
      localCausalFrontier: PersistedEditableArtifactCausalFrontier;
      requireSnapshot: boolean;
    }>
  | Readonly<{
      modality: "document" | "presentation";
      localCursor: number | null;
      localStateHash: string | null;
      localNativeRevision: number | null;
      requireSnapshot: boolean;
    }>;

type PersistedEditableArtifactLiveAuthority = Readonly<{
  artifact: PersistedEditableArtifact;
  checkpoint: PersistedEditableArtifactSequenceCheckpoint;
  snapshot: PersistedEditableArtifactSnapshotMetadata;
  minimumReplaySequence: number;
}>;

function validateLiveResume(
  input: PersistedEditableArtifactLiveResume,
): NormalizedPersistedEditableArtifactLiveResume {
  if (!isPlainRecord(input)) throw new TypeError("Editable artifact live resume is invalid");
  const modality = input.modality ?? "spreadsheet";
  if (modality !== "spreadsheet" && modality !== "document" && modality !== "presentation") {
    throw new TypeError("Editable artifact live resume modality is invalid");
  }
  const localCursor =
    input.localCursor === null ? null : validateInteger(input.localCursor, "live resume cursor", 0);
  const localStateHash =
    input.localStateHash === null
      ? null
      : validateHash(input.localStateHash, "live resume state hash");
  if ((localCursor === null) !== (localStateHash === null)) {
    throw new TypeError("Live resume cursor and state hash must both be null or present");
  }
  if (typeof input.requireSnapshot !== "boolean") {
    throw new TypeError("Live resume snapshot requirement must be boolean");
  }
  if (modality === "spreadsheet") {
    if (!("localCausalFrontier" in input)) {
      throw new TypeError("Spreadsheet live resume requires a causal frontier");
    }
    return Object.freeze({
      modality,
      localCursor,
      localStateHash,
      localCausalFrontier: parseFrontier(input.localCausalFrontier),
      requireSnapshot: input.requireSnapshot,
    });
  }
  if (!("localNativeRevision" in input)) {
    throw new TypeError("Serialized live resume requires a native revision");
  }
  const localNativeRevision =
    input.localNativeRevision === null
      ? null
      : validateInteger(input.localNativeRevision, "live resume native revision", 0);
  if ((localCursor === null) !== (localNativeRevision === null)) {
    throw new TypeError("Live resume cursor and native revision must both be null or present");
  }
  return Object.freeze({
    modality,
    localCursor,
    localStateHash,
    localNativeRevision,
    requireSnapshot: input.requireSnapshot,
  });
}

async function loadCheckpoint(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  headSequence: number,
): Promise<PersistedEditableArtifactSequenceCheckpoint | null> {
  const rows = await rawRows<{
    head_sequence: string | number | bigint;
    modality: string;
    causal_frontier: unknown | null;
    native_revision: string | number | bigint | null;
    state_hash: string;
  }>(
    db,
    sql`
    select head_sequence, modality, causal_frontier, native_revision, state_hash
    from editable_artifact_sequence_checkpoints
    where account_id = ${scope.accountId}::uuid
      and workspace_id = ${scope.workspaceId}::uuid
      and artifact_id = ${artifactId}
      and head_sequence = ${headSequence}
    limit 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const modality = artifactModality(row.modality, "checkpoint modality");
  const common = {
    headSequence: safeInteger(row.head_sequence, "checkpoint sequence"),
    stateHash: validateHash(row.state_hash, "checkpoint state hash"),
  } as const;
  if (modality === "spreadsheet") {
    if (row.native_revision !== null) {
      throw corrupt("Spreadsheet checkpoint contains a native revision");
    }
    return Object.freeze({
      ...common,
      modality,
      causalFrontier: parseFrontier(row.causal_frontier),
    });
  }
  if (row.causal_frontier !== null) {
    throw corrupt("Serialized checkpoint contains a causal frontier");
  }
  return Object.freeze({
    ...common,
    modality,
    nativeRevision: safeInteger(row.native_revision, "checkpoint native revision"),
  });
}

async function loadLiveAuthority(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
): Promise<PersistedEditableArtifactLiveAuthority> {
  const artifactRow = await loadArtifactRow(db, scope, artifactId, false);
  if (!artifactRow) {
    throw new EditableArtifactPersistenceError(
      "not_found",
      "Editable artifact was not found in the requested tenant scope",
    );
  }
  const artifact = artifactFromRow(artifactRow);
  if (artifact.currentSnapshotId === null) {
    throw corrupt("Live artifact has no authoritative snapshot");
  }
  const [checkpoint, snapshot] = await Promise.all([
    loadCheckpoint(db, scope, artifactId, artifact.headSequence),
    loadSnapshotMetadata(db, scope, artifactId, artifact.currentSnapshotId),
  ]);
  if (!checkpoint) throw corrupt("Artifact head has no durable checkpoint");
  if (!snapshot) throw corrupt("Artifact snapshot pointer has no immutable snapshot");
  if (
    checkpoint.modality !== artifact.modality ||
    checkpoint.headSequence !== artifact.headSequence ||
    checkpoint.stateHash !== artifact.stateHash ||
    snapshot.modality !== artifact.modality
  ) {
    throw corrupt("Live authority projections disagree with the durable artifact");
  }
  if (
    artifact.modality === "spreadsheet" &&
    (checkpoint.modality !== "spreadsheet" ||
      snapshot.modality !== "spreadsheet" ||
      !sameFrontier(checkpoint.causalFrontier, artifact.causalFrontier))
  ) {
    throw corrupt("Spreadsheet live head differs from its durable causal authority");
  }
  const snapshotCheckpoint =
    snapshot.coveredHeadSequence === checkpoint.headSequence
      ? checkpoint
      : await loadCheckpoint(db, scope, artifactId, snapshot.coveredHeadSequence);
  if (
    !snapshotCheckpoint ||
    snapshotCheckpoint.modality !== snapshot.modality ||
    snapshotCheckpoint.headSequence !== snapshot.coveredHeadSequence ||
    snapshotCheckpoint.stateHash !== snapshot.stateHash ||
    (snapshot.modality === "spreadsheet"
      ? snapshotCheckpoint.modality !== "spreadsheet" ||
        !sameFrontier(snapshotCheckpoint.causalFrontier, snapshot.coveredCausalFrontier)
      : snapshotCheckpoint.modality === "spreadsheet" ||
        snapshotCheckpoint.nativeRevision !== snapshot.nativeRevision)
  ) {
    throw corrupt("Current snapshot differs from its durable checkpoint");
  }
  const minimumReplaySequence = snapshot.coveredHeadSequence + 1;
  if (minimumReplaySequence > artifact.headSequence + 1) {
    throw corrupt("Current snapshot coverage is beyond the durable head");
  }
  return Object.freeze({ artifact, checkpoint, snapshot, minimumReplaySequence });
}

function liveHeadFromAuthority(
  authority: PersistedEditableArtifactLiveAuthority,
): PersistedEditableArtifactLiveHead {
  const common = {
    headSequence: authority.artifact.headSequence,
    stateHash: authority.artifact.stateHash,
    minimumReplaySequence: authority.minimumReplaySequence,
  } as const;
  return authority.checkpoint.modality === "spreadsheet"
    ? Object.freeze({
        ...common,
        modality: authority.checkpoint.modality,
        causalFrontier: authority.checkpoint.causalFrontier,
      })
    : Object.freeze({
        ...common,
        modality: authority.checkpoint.modality,
        nativeRevision: authority.checkpoint.nativeRevision,
      });
}

const committedTransactionColumns = sql`
  account_id, workspace_id, artifact_id, id, request_hash,
  modality, sequence_start, sequence_end, prior_state_hash, state_hash,
  replica_id, replica_counter, resolved_causal_base, resulting_causal_frontier,
  operation_count, operation_ids, operation_protocol_version, model_schema_version,
  commit_protocol_version, prior_native_revision, native_revision, command_count,
  native_receipt_byte_size, native_receipt_hash, native_receipt_bytes,
  kernel_version, committed_transaction_byte_size, committed_transaction_hash,
  committed_transaction_bytes, committed_at`;

async function loadCommittedTransactionRows(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  after: number,
  through: number,
  maxCount: number,
): Promise<readonly CommittedTransactionRow[]> {
  return await rawRows<CommittedTransactionRow>(
    db,
    sql`select ${committedTransactionColumns}
      from editable_artifact_transactions
      where account_id = ${scope.accountId}::uuid
        and workspace_id = ${scope.workspaceId}::uuid
        and artifact_id = ${artifactId}
        and sequence_start > ${after}
        and sequence_end <= ${through}
      order by sequence_start
      limit ${maxCount}`,
  );
}

async function loadCommittedTransactionRowsById(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  transactionId: string,
): Promise<readonly CommittedTransactionRow[]> {
  return await rawRows<CommittedTransactionRow>(
    db,
    sql`select ${committedTransactionColumns}
      from editable_artifact_transactions
      where account_id = ${scope.accountId}::uuid
        and workspace_id = ${scope.workspaceId}::uuid
        and artifact_id = ${artifactId}
        and id = ${transactionId}
      limit 1`,
  );
}

function liveTransactionFromCommitted(
  transaction: PersistedEditableArtifactCommittedTransactionRecord,
): PersistedEditableArtifactLiveCommittedTransaction {
  const common = {
    artifactId: transaction.artifactId,
    transactionId: transaction.serverTransactionId,
    requestHash: transaction.requestHash,
    startSequence: transaction.sequenceStart,
    endSequence: transaction.sequenceEnd,
    priorStateHash: transaction.priorStateHash,
    stateHash: transaction.stateHash,
    committedTransactionBytes: transaction.committedTransactionBytes.slice(),
  } as const;
  return transaction.modality === "spreadsheet"
    ? Object.freeze({
        ...common,
        modality: transaction.modality,
        causalFrontier: transaction.resultingCausalFrontier,
        operationProtocolVersion: transaction.operationProtocolVersion,
      })
    : Object.freeze({
        ...common,
        modality: transaction.modality,
        priorNativeRevision: transaction.priorNativeRevision,
        nativeRevision: transaction.nativeRevision,
        commitProtocolVersion: transaction.commitProtocolVersion,
      });
}

async function insertSnapshotBlobReference(
  db: Database,
  snapshot: PersistedEditableArtifactSnapshotMetadata,
): Promise<void> {
  await db.execute(sql`
    insert into editable_artifact_blob_refs (
      account_id, workspace_id, artifact_id, id, kind, object_reference,
      byte_size, content_hash, mime_type, created_at
    ) values (
      ${snapshot.scope.accountId}::uuid, ${snapshot.scope.workspaceId}::uuid,
      ${snapshot.artifactId}, ${snapshot.snapshotId}, 'snapshot',
      ${snapshot.blobReference}, ${snapshot.byteSize}, ${snapshot.contentHash},
      ${snapshot.mimeType}, ${snapshot.publishedAt}
    )`);
}

async function insertOriginalImportBlobReference(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  source: Readonly<{
    fileId: string;
    blobRefId: string;
    blobReference: string;
    byteSize: number;
    contentHash: string;
    mimeType: string;
  }>,
  createdAt: string,
): Promise<void> {
  await db.execute(sql`
    insert into editable_artifact_blob_refs (
      account_id, workspace_id, artifact_id, id, kind, object_reference,
      byte_size, content_hash, mime_type, source_file_id, created_at
    ) values (
      ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${artifactId},
      ${source.blobRefId}, 'original_import', ${source.blobReference},
      ${source.byteSize}, ${source.contentHash}, ${source.mimeType},
      ${source.fileId}::uuid, ${createdAt}
    )`);
}

async function insertSnapshotMetadata(
  db: Database,
  snapshot: PersistedEditableArtifactSnapshotMetadata,
  blobRefId = snapshot.snapshotId,
): Promise<void> {
  const coveredCausalFrontierSql =
    snapshot.modality === "spreadsheet"
      ? sql`${json(snapshot.coveredCausalFrontier)}::jsonb`
      : sql`null`;
  await db.execute(sql`
    insert into editable_artifact_snapshots (
      account_id, workspace_id, artifact_id, id, modality, blob_ref_id, byte_size,
      content_hash, mime_type, covered_head_sequence, covered_causal_frontier,
      state_hash, model_schema_version, operation_protocol_version,
      kernel_version, crdt_state_version, native_revision, verified_at, published_at
    ) values (
      ${snapshot.scope.accountId}::uuid, ${snapshot.scope.workspaceId}::uuid,
      ${snapshot.artifactId}, ${snapshot.snapshotId}, ${snapshot.modality}, ${blobRefId},
      ${snapshot.byteSize}, ${snapshot.contentHash}, ${snapshot.mimeType},
      ${snapshot.coveredHeadSequence}, ${coveredCausalFrontierSql}, ${snapshot.stateHash},
      ${snapshot.modelSchemaVersion},
      ${snapshot.modality === "spreadsheet" ? snapshot.operationProtocolVersion : null},
      ${snapshot.kernelVersion},
      ${snapshot.modality === "spreadsheet" ? snapshot.crdtStateVersion : null},
      ${snapshot.modality === "spreadsheet" ? null : snapshot.nativeRevision},
      ${snapshot.verifiedAt}, ${snapshot.publishedAt}
    )`);
}

async function insertLiveOutbox(
  db: Database,
  artifact: PersistedEditableArtifact,
  record: PersistedEditableArtifactLiveOutboxRecord,
): Promise<void> {
  validateOutboxRecord(record, artifact);
  const event = parseLiveEvent(record.event);
  await db.execute(sql`
    insert into editable_artifact_live_outbox (
      account_id, workspace_id, artifact_id, id, transaction_id, snapshot_id,
      event_kind, event, state, attempt_count, lease_owner, lease_expires_at,
      next_attempt_at, last_error_code, published_at, dead_lettered_at, created_at
    ) values (
      ${artifact.scope.accountId}::uuid, ${artifact.scope.workspaceId}::uuid,
      ${artifact.id}, ${record.outboxId},
      ${event.kind === "transaction_committed" ? event.serverTransactionId : null},
      ${event.kind === "snapshot_published" ? event.snapshotId : null},
      ${event.kind}, ${json(event)}::jsonb, ${record.state}, ${record.attemptCount},
      ${record.leaseOwner}, ${record.leaseExpiresAt}, ${record.nextAttemptAt},
      ${record.lastErrorCode}, ${record.publishedAt}, ${record.deadLetteredAt},
      ${record.createdAt}
    )`);
}

async function loadReceipt(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  actorKey: string,
  clientTransactionId: string,
): Promise<PersistedEditableArtifactReceipt | null> {
  const rows = await rawRows<TransactionRow>(
    db,
    sql`
    select
      t.account_id, t.workspace_id, t.artifact_id, t.id,
      t.modality, r.id as receipt_id, t.client_transaction_id, t.replica_id,
      t.replica_counter, t.previous_local_transaction_id, t.intent_bytes,
      r.request_hash, t.actor_key,
      t.sequence_start, t.sequence_end, t.prior_state_hash, t.causal_base,
      t.resolved_causal_base, t.resulting_causal_frontier,
      t.state_hash, t.operation_count, t.operation_ids,
      t.selective_undo_targets, t.intent_envelope_version,
      t.intent_protocol_version, t.command_protocol_version,
      t.kernel_version, t.model_schema_version,
      t.operation_protocol_version, t.commit_protocol_version,
      t.prior_native_revision, t.native_revision, t.command_count,
      t.native_receipt_byte_size, t.native_receipt_hash, t.native_receipt_bytes,
      t.committed_transaction_byte_size, t.committed_transaction_hash,
      t.committed_transaction_bytes, t.committed_at
    from editable_artifact_idempotency_receipts r
    join editable_artifact_transactions t
      on t.account_id = r.account_id
     and t.workspace_id = r.workspace_id
     and t.artifact_id = r.artifact_id
     and t.id = r.server_transaction_id
     and t.actor_key_digest = r.authority_key_digest
     and t.actor_key = r.authority_key
     and t.client_transaction_id = r.idempotency_key
     and t.request_hash = r.request_hash
    where r.account_id = ${scope.accountId}::uuid
      and r.workspace_id = ${scope.workspaceId}::uuid
      and r.artifact_id = ${artifactId}
      and r.operation_kind = 'edit'
      and r.authority_key_digest = sha256(convert_to(${actorKey}, 'UTF8'))
      and r.authority_key = ${actorKey}
      and r.idempotency_key = ${clientTransactionId}
    limit 1`,
  );
  return rows[0] ? receiptFromRow(rows[0]) : null;
}

async function loadUndoBasis(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  operationIds: readonly string[],
): Promise<readonly PersistedEditableArtifactTransactionUndoBasis[]> {
  if (operationIds.length === 0) return Object.freeze([]);
  const operationRows: OperationRow[] = [];
  const claimByOperationId = new Map<string, string>();
  for (let offset = 0; offset < operationIds.length; offset += 1_000) {
    const chunk = operationIds.slice(offset, offset + 1_000);
    const identifiers = sql.join(
      chunk.map((operationId) => sql`${operationId}`),
      sql`, `,
    );
    operationRows.push(
      ...(await rawRows<OperationRow>(
        db,
        sql`
        select account_id, workspace_id, artifact_id, transaction_id,
          operation_id, operation_index, sequence, dot_replica_id,
          dot_counter, actor_key, created_at
        from editable_artifact_operations
        where account_id = ${scope.accountId}::uuid
          and workspace_id = ${scope.workspaceId}::uuid
          and artifact_id = ${artifactId}
          and operation_id in (${identifiers})
        order by sequence`,
      )),
    );
    const claims = await rawRows<{
      target_operation_id: string;
      claiming_transaction_id: string;
    }>(
      db,
      sql`
      select target_operation_id, claiming_transaction_id
      from editable_artifact_undo_claims
      where account_id = ${scope.accountId}::uuid
        and workspace_id = ${scope.workspaceId}::uuid
        and artifact_id = ${artifactId}
        and target_operation_id in (${identifiers})`,
    );
    for (const claim of claims) {
      claimByOperationId.set(
        validateStableId(claim.target_operation_id, "undo target operation id"),
        validateStableId(claim.claiming_transaction_id, "claiming transaction id"),
      );
    }
  }
  const operationById = new Map(
    operationRows.map(operationFromRow).map((operation) => [operation.operationId, operation]),
  );
  return Object.freeze(
    operationIds.map((operationId) =>
      Object.freeze({
        operationId,
        operation: operationById.get(operationId) ?? null,
        claimedBy: claimByOperationId.get(operationId) ?? null,
      }),
    ),
  );
}

async function anyUndoTargetClaimed(
  db: Database,
  scope: PersistedEditableArtifactScope,
  artifactId: string,
  operationIds: readonly string[],
): Promise<boolean> {
  for (let offset = 0; offset < operationIds.length; offset += 2_000) {
    const identifiers = sql.join(
      operationIds.slice(offset, offset + 2_000).map((operationId) => sql`${operationId}`),
      sql`, `,
    );
    const rows = await rawRows<{ claimed: boolean }>(
      db,
      sql`select exists (
        select 1
        from editable_artifact_undo_claims
        where account_id = ${scope.accountId}::uuid
          and workspace_id = ${scope.workspaceId}::uuid
          and artifact_id = ${artifactId}
          and target_operation_id in (${identifiers})
      ) as claimed`,
    );
    if (rows[0]?.claimed === true) return true;
  }
  return false;
}

function operationFromRow(row: OperationRow): PersistedEditableArtifactOperationRecord {
  const operationIndex = validateInteger(
    row.operation_index,
    "operation index",
    0,
    MAX_COMMITTED_TRANSACTION_OPERATIONS - 1,
  );
  const sequence = safeInteger(row.sequence, "operation sequence", 1);
  if (sequence <= operationIndex) {
    throw corrupt("Operation index is outside its authoritative sequence interval");
  }
  return Object.freeze({
    scope: validateScope({ accountId: row.account_id, workspaceId: row.workspace_id }),
    artifactId: validateStableId(row.artifact_id, "artifact id"),
    serverTransactionId: validateStableId(row.transaction_id, "transaction id"),
    sequence,
    actorKey: validateActorKey(row.actor_key).key,
    createdAt: iso(row.created_at, "operation creation time"),
    operationId: validateStableId(row.operation_id, "operation id"),
    dot: Object.freeze({
      replicaId: validateReplicaId(row.dot_replica_id),
      counter: safeInteger(row.dot_counter, "operation causal counter", 1),
    }),
  });
}

function committedTransactionFromRow(
  row: CommittedTransactionRow,
  durableModality: PersistedEditableArtifact["modality"],
): PersistedEditableArtifactCommittedTransactionRecord {
  if (row.modality !== durableModality) {
    throw corrupt("Stored transaction modality differs from its durable artifact");
  }
  const bytes = Uint8Array.from(row.committed_transaction_bytes);
  const declaredByteSize = validateInteger(
    row.committed_transaction_byte_size,
    "committed transaction byte size",
    1,
    MAX_COMMITTED_TRANSACTION_BYTES,
  );
  if (bytes.byteLength !== declaredByteSize) {
    throw corrupt("Canonical committed transaction size does not match its stored bytes");
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== validateHash(row.committed_transaction_hash, "committed transaction hash")) {
    throw corrupt("Canonical committed transaction digest verification failed");
  }

  const sequenceStart = safeInteger(row.sequence_start, "transaction start sequence", 1);
  const sequenceEnd = safeInteger(row.sequence_end, "transaction end sequence", sequenceStart);
  const priorStateHash = validateHash(row.prior_state_hash, "transaction prior state hash");
  const stateHash = validateHash(row.state_hash, "transaction state hash");
  const common = {
    scope: validateScope({ accountId: row.account_id, workspaceId: row.workspace_id }),
    artifactId: validateStableId(row.artifact_id, "artifact id"),
    serverTransactionId: validateStableId(row.id, "transaction id"),
    requestHash: validateHash(row.request_hash, "transaction request hash"),
    sequenceStart,
    sequenceEnd,
    priorStateHash,
    stateHash,
    modelSchemaVersion: validateInteger(row.model_schema_version, "model schema version", 1),
    kernelVersion: validateBoundedText(
      row.kernel_version,
      "kernel version",
      EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
    ),
    committedTransactionBytes: bytes,
    committedAt: iso(row.committed_at, "transaction commit time"),
  } as const;

  if (durableModality === "spreadsheet") {
    let summary: ReturnType<typeof decodeCommittedTransactionSummary>;
    try {
      summary = decodeCommittedTransactionSummary(bytes);
    } catch (error) {
      throw new EditableArtifactPersistenceError(
        "corrupt_history",
        "Stored canonical committed transaction is not a valid OGACO001 envelope",
        { cause: error },
      );
    }
    const operationCount = validateInteger(
      row.operation_count,
      "committed transaction operation count",
      1,
      MAX_COMMITTED_TRANSACTION_OPERATIONS,
    );
    const operationIds = parseStableIdArray(
      row.operation_ids,
      "committed transaction operation ids",
      MAX_COMMITTED_TRANSACTION_OPERATIONS,
    );
    const resolvedCausalBase = parseFrontier(row.resolved_causal_base);
    const resultingCausalFrontier = parseFrontier(row.resulting_causal_frontier);
    const dot = Object.freeze({
      replicaId: validateReplicaId(row.replica_id),
      counter: safeInteger(row.replica_counter, "transaction causal counter", 1),
    });
    const operationProtocolVersion = validateInteger(
      row.operation_protocol_version,
      "transaction operation protocol version",
      COMMITTED_TRANSACTION_PROTOCOL_VERSION,
      COMMITTED_TRANSACTION_PROTOCOL_VERSION,
    );
    if (
      sequenceEnd - sequenceStart + 1 !== operationCount ||
      operationIds.length !== operationCount ||
      summary.operationIds.length !== operationCount ||
      summary.transactionId !== row.id ||
      summary.dot.replicaId !== dot.replicaId ||
      summary.dot.counter !== dot.counter ||
      summary.priorStateHash !== priorStateHash ||
      summary.stateHash !== stateHash ||
      summary.operationProtocolVersion !== operationProtocolVersion ||
      !sameStringArray(summary.operationIds, operationIds) ||
      !sameFrontier(summary.resolvedCausalBase, resolvedCausalBase) ||
      !sameFrontier(summary.resultingCausalFrontier, resultingCausalFrontier)
    ) {
      throw corrupt("Canonical committed transaction disagrees with its durable projection");
    }
    assertSerializedColumnsAbsent(row);
    return Object.freeze({
      ...common,
      modality: "spreadsheet" as const,
      dot,
      resolvedCausalBase,
      resultingCausalFrontier,
      operationIds,
      operationProtocolVersion,
    });
  }

  const modality = serializedModality(durableModality, "transaction modality");
  if (
    row.operation_count !== null ||
    row.operation_ids !== null ||
    row.operation_protocol_version !== null ||
    row.resolved_causal_base !== null ||
    row.resulting_causal_frontier !== null
  ) {
    throw corrupt("Serialized transaction contains spreadsheet projection fields");
  }
  const nativeReceiptBytes = readNativeReceiptBytes(row);
  let summary: ReturnType<typeof decodeEditableArtifactSerializedCommit>;
  try {
    summary = decodeEditableArtifactSerializedCommit(bytes, modality);
  } catch (error) {
    throw new EditableArtifactPersistenceError(
      "corrupt_history",
      "Stored canonical committed transaction is not a valid OGAST001 envelope",
      { cause: error },
    );
  }
  const commitProtocolVersion = validateInteger(
    row.commit_protocol_version,
    "serialized commit protocol version",
    EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
    EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
  );
  const priorNativeRevision = safeInteger(
    row.prior_native_revision,
    "serialized prior native revision",
  );
  const nativeRevision = safeInteger(row.native_revision, "serialized native revision");
  const commandCount = validateInteger(
    row.command_count,
    "serialized command count",
    1,
    MAX_COMMITTED_TRANSACTION_OPERATIONS,
  );
  if (
    sequenceStart !== sequenceEnd ||
    summary.commitProtocolVersion !== commitProtocolVersion ||
    summary.transactionId !== row.id ||
    summary.parentHeadSequence !== sequenceStart - 1 ||
    summary.resultHeadSequence !== sequenceEnd ||
    summary.priorNativeRevision !== priorNativeRevision ||
    summary.nativeReceipt.revision !== nativeRevision ||
    summary.nativeReceipt.commandCount !== commandCount ||
    summary.priorStateHash !== priorStateHash ||
    summary.stateHash !== stateHash ||
    summary.requestHash !== common.requestHash ||
    !equalByteArrays(summary.nativeReceiptBytes, nativeReceiptBytes)
  ) {
    throw corrupt("Canonical serialized commit disagrees with its durable projection");
  }
  return Object.freeze({
    ...common,
    modality,
    commitProtocolVersion,
    priorNativeRevision,
    nativeRevision,
    commandCount,
    nativeReceiptBytes,
  });
}

function artifactFromRow(row: ArtifactRow): PersistedEditableArtifact {
  if (!["spreadsheet", "presentation", "document"].includes(row.modality)) {
    throw corrupt("Stored artifact modality is invalid");
  }
  if (!["active", "archived"].includes(row.lifecycle_state)) {
    throw corrupt("Stored artifact lifecycle is invalid");
  }
  validateTitle(row.title);
  const common = {
    scope: validateScope({ accountId: row.account_id, workspaceId: row.workspace_id }),
    id: validateStableId(row.id, "artifact id"),
    title: row.title,
    lifecycle: row.lifecycle_state as PersistedEditableArtifact["lifecycle"],
    authorizationRevision: safeInteger(
      row.authorization_revision,
      "artifact authorization revision",
    ),
    headSequence: safeInteger(row.head_sequence, "artifact head sequence"),
    stateHash: validateHash(row.state_hash, "artifact state hash"),
    currentSnapshotId: row.current_snapshot_id
      ? validateStableId(row.current_snapshot_id, "current snapshot id")
      : null,
    createdAt: iso(row.created_at, "artifact creation time"),
    updatedAt: iso(row.updated_at, "artifact update time"),
  } as const;
  if (row.modality === "spreadsheet") {
    return Object.freeze({
      ...common,
      modality: "spreadsheet" as const,
      causalFrontier: parseFrontier(row.causal_frontier),
    });
  }
  if (row.causal_frontier !== null) {
    throw corrupt("Serialized artifact contains a spreadsheet causal frontier");
  }
  return Object.freeze({
    ...common,
    modality: serializedModality(row.modality, "artifact modality"),
  });
}

function receiptFromRow(row: TransactionRow): PersistedEditableArtifactReceipt {
  const modality = artifactModality(row.modality, "receipt modality");
  const committed = committedTransactionFromRow(row, modality);
  const sequenceStart = safeInteger(row.sequence_start, "receipt start sequence", 1);
  const sequenceEnd = safeInteger(row.sequence_end, "receipt end sequence", sequenceStart);
  const common = {
    receiptId: validateStableId(row.receipt_id, "receipt id"),
    scope: validateScope({ accountId: row.account_id, workspaceId: row.workspace_id }),
    artifactId: validateStableId(row.artifact_id, "artifact id"),
    modality,
    serverTransactionId: validateStableId(row.id, "transaction id"),
    clientTransactionId: validateClientTransactionId(row.client_transaction_id),
    replicaId: validateReplicaId(row.replica_id),
    replicaCounter: safeInteger(row.replica_counter, "receipt replica counter", 1),
    previousLocalTransactionId: row.previous_local_transaction_id
      ? validateClientTransactionId(row.previous_local_transaction_id)
      : null,
    intentBytes: validateCanonicalIntentBytes(row.intent_bytes, row.request_hash),
    requestHash: validateHash(row.request_hash, "request hash"),
    actorKey: validateActorKey(row.actor_key).key,
    sequenceStart,
    sequenceEnd,
    priorStateHash: validateHash(row.prior_state_hash, "transaction prior state hash"),
    stateHash: validateHash(row.state_hash, "transaction state hash"),
    intentEnvelopeVersion: validateInteger(
      row.intent_envelope_version,
      "intent envelope version",
      1,
    ),
    intentProtocolVersion: validateIntentProtocolVersion(row.intent_protocol_version),
    commandProtocolVersion: validateInteger(
      row.command_protocol_version,
      "command protocol version",
      1,
    ),
    kernelVersion: validateBoundedText(
      row.kernel_version,
      "kernel version",
      EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
    ),
    modelSchemaVersion: validateInteger(row.model_schema_version, "model schema version", 1),
    committedAt: iso(row.committed_at, "transaction commit time"),
  } as const;
  if (
    committed.sequenceStart !== sequenceStart ||
    committed.sequenceEnd !== sequenceEnd ||
    committed.requestHash !== common.requestHash ||
    committed.priorStateHash !== common.priorStateHash ||
    committed.stateHash !== common.stateHash
  ) {
    throw corrupt("Receipt differs from its canonical committed transaction");
  }
  if (modality === "spreadsheet") {
    if (committed.modality !== "spreadsheet") {
      throw corrupt("Spreadsheet receipt resolves to a serialized commit");
    }
    const operationCount = validateInteger(
      row.operation_count,
      "operation count",
      1,
      MAX_COMMITTED_TRANSACTION_OPERATIONS,
    );
    if (sequenceEnd - sequenceStart + 1 !== operationCount) {
      throw corrupt("Receipt operation interval does not match operation count");
    }
    return Object.freeze({
      ...common,
      modality: "spreadsheet" as const,
      causalBase: parseFrontier(row.causal_base),
      resolvedCausalBase: parseFrontier(row.resolved_causal_base),
      resultingCausalFrontier: parseFrontier(row.resulting_causal_frontier),
      operationCount,
      selectiveUndoOperationIds: parseStableIdArray(
        row.selective_undo_targets,
        "undo targets",
        10_000,
      ),
      operationProtocolVersion: committed.operationProtocolVersion,
    });
  }
  if (
    committed.modality === "spreadsheet" ||
    row.causal_base !== null ||
    row.selective_undo_targets !== null
  ) {
    throw corrupt("Serialized receipt contains spreadsheet projection fields");
  }
  return Object.freeze({
    ...common,
    modality,
    commitProtocolVersion: committed.commitProtocolVersion,
    priorNativeRevision: committed.priorNativeRevision,
    nativeRevision: committed.nativeRevision,
    commandCount: committed.commandCount,
  });
}

function creationReceiptFromRow(
  scopeInput: PersistedEditableArtifactScope,
  row: CreationReceiptRow,
): PersistedEditableArtifactCreationReceipt {
  const scope = validateScope(scopeInput);
  if (row.resource_type !== "artifact") {
    throw corrupt("Artifact creation receipt has an invalid resource type");
  }
  if (!isPlainRecord(row.result)) {
    throw corrupt("Artifact creation receipt result is invalid");
  }
  assertExactKeys(
    row.result,
    ["artifactId", "genesisSnapshotId", "schemaVersion"],
    "artifact creation receipt result",
  );
  if (row.result.schemaVersion !== 1) {
    throw corrupt("Artifact creation receipt schema version is invalid");
  }
  const artifactId = validateStableId(row.resource_id, "created artifact resource id");
  if (validateStableId(row.result.artifactId, "creation result artifact id") !== artifactId) {
    throw corrupt("Artifact creation receipt result disagrees with its resource");
  }
  return Object.freeze({
    receiptId: validateStableId(row.id, "creation receipt id"),
    scope,
    artifactId,
    operationKind: validateOriginOperation(row.operation_kind),
    authorityKey: validateActorKey(row.authority_key).key,
    idempotencyKey: validateClientTransactionId(row.idempotency_key),
    requestHash: validateHash(row.request_hash, "creation request hash"),
    genesisSnapshotId: validateStableId(
      row.result.genesisSnapshotId,
      "creation genesis snapshot id",
    ),
    createdAt: iso(row.created_at, "creation receipt time"),
  });
}

function snapshotFromRow(row: SnapshotRow): PersistedEditableArtifactSnapshotMetadata {
  const modality = artifactModality(row.modality, "snapshot modality");
  if (row.mime_type !== "application/vnd.opengeni.editable-artifact-snapshot") {
    throw corrupt("Snapshot MIME type is invalid");
  }
  if (
    safeInteger(row.blob_byte_size, "snapshot blob byte size", 1) !==
      safeInteger(row.byte_size, "snapshot byte size", 1) ||
    validateHash(row.blob_content_hash, "snapshot blob content hash") !==
      validateHash(row.content_hash, "snapshot content hash") ||
    row.blob_mime_type !== row.mime_type
  ) {
    throw corrupt("Snapshot metadata disagrees with its immutable blob reference");
  }
  const common = {
    scope: validateScope({ accountId: row.account_id, workspaceId: row.workspace_id }),
    artifactId: validateStableId(row.artifact_id, "artifact id"),
    modality,
    snapshotId: validateStableId(row.id, "snapshot id"),
    blobReference: validateBoundedText(row.blob_reference, "snapshot blob reference", 1024),
    byteSize: safeInteger(row.byte_size, "snapshot byte size", 1),
    contentHash: validateHash(row.content_hash, "snapshot content hash"),
    mimeType: row.mime_type,
    coveredHeadSequence: safeInteger(row.covered_head_sequence, "snapshot coverage"),
    stateHash: validateHash(row.state_hash, "snapshot state hash"),
    modelSchemaVersion: validateInteger(row.model_schema_version, "model schema version", 1),
    kernelVersion: validateBoundedText(
      row.kernel_version,
      "kernel version",
      EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
    ),
    verifiedAt: iso(row.verified_at, "snapshot verification time"),
    publishedAt: iso(row.published_at, "snapshot publication time"),
  } as const;
  if (modality === "spreadsheet") {
    if (row.native_revision !== null) {
      throw corrupt("Spreadsheet snapshot contains a native revision");
    }
    return Object.freeze({
      ...common,
      modality: "spreadsheet" as const,
      coveredCausalFrontier: parseFrontier(row.covered_causal_frontier),
      operationProtocolVersion: validateInteger(
        row.operation_protocol_version,
        "operation protocol version",
        1,
      ),
      crdtStateVersion: validateInteger(row.crdt_state_version, "CRDT state version", 1),
    });
  }
  if (
    row.covered_causal_frontier !== null ||
    row.operation_protocol_version !== null ||
    row.crdt_state_version !== null
  ) {
    throw corrupt("Serialized snapshot contains spreadsheet projection fields");
  }
  return Object.freeze({
    ...common,
    modality,
    nativeRevision: safeInteger(row.native_revision, "snapshot native revision"),
  });
}

function outboxFromRow(row: OutboxRow): PersistedEditableArtifactLiveOutboxRecord {
  const event = parseLiveEvent(row.event);
  if (!["pending", "publishing", "published", "dead_lettered"].includes(row.state)) {
    throw corrupt("Live outbox state is invalid");
  }
  const leaseOwner = row.lease_owner === null ? null : validateLeaseOwner(row.lease_owner);
  const leaseExpiresAt = row.lease_expires_at
    ? iso(row.lease_expires_at, "outbox lease expiry")
    : null;
  const publishedAt = row.published_at ? iso(row.published_at, "outbox publication time") : null;
  const deadLetteredAt = row.dead_lettered_at
    ? iso(row.dead_lettered_at, "outbox dead-letter time")
    : null;
  const nextAttemptAt = iso(row.next_attempt_at, "outbox next-attempt time");
  const lastErrorCode =
    row.last_error_code === null ? null : validateOutboxStoredErrorCode(row.last_error_code);
  if (
    (row.state === "pending" &&
      (leaseOwner !== null ||
        leaseExpiresAt !== null ||
        publishedAt !== null ||
        deadLetteredAt !== null ||
        (lastErrorCode !== null && !isOutboxRetryErrorCode(lastErrorCode)))) ||
    (row.state === "publishing" &&
      (leaseOwner === null ||
        leaseExpiresAt === null ||
        publishedAt !== null ||
        deadLetteredAt !== null ||
        (lastErrorCode !== null && !isOutboxRetryErrorCode(lastErrorCode)))) ||
    (row.state === "published" &&
      (leaseOwner !== null ||
        leaseExpiresAt !== null ||
        publishedAt === null ||
        deadLetteredAt !== null ||
        lastErrorCode !== null)) ||
    (row.state === "dead_lettered" &&
      (leaseOwner !== null ||
        leaseExpiresAt !== null ||
        publishedAt !== null ||
        deadLetteredAt === null ||
        lastErrorCode === null ||
        !isOutboxStoredDeadLetterErrorCode(lastErrorCode)))
  ) {
    throw corrupt("Live outbox state and lease facts are inconsistent");
  }
  return Object.freeze({
    outboxId: validateStableId(row.outbox_id, "outbox id"),
    event,
    state: row.state as PersistedEditableArtifactLiveOutboxRecord["state"],
    attemptCount: validateInteger(row.attempt_count, "outbox attempt count", 0, 1_000_000),
    leaseOwner,
    leaseExpiresAt,
    nextAttemptAt,
    lastErrorCode,
    publishedAt,
    deadLetteredAt,
    createdAt: iso(row.created_at, "outbox creation time"),
  });
}

function parseLiveEvent(value: unknown): PersistedEditableArtifactLiveEvent {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string") {
    throw corrupt("Live outbox event envelope is invalid");
  }
  const scope = validateScope(value.scope as PersistedEditableArtifactScope);
  const artifactId = validateStableId(value.artifactId, "event artifact id");
  const modality = artifactModality(value.modality, "event modality");
  if (value.kind === "transaction_committed") {
    assertExactKeys(
      value,
      [
        "artifactId",
        ...(modality === "spreadsheet" ? [] : ["commitProtocolVersion"]),
        "committedAt",
        "kind",
        "modality",
        ...(modality === "spreadsheet" ? ["operationProtocolVersion"] : []),
        "schemaVersion",
        "scope",
        "sequenceEnd",
        "sequenceStart",
        "serverTransactionId",
        "stateHash",
      ],
      "transaction outbox event",
    );
    const sequenceStart = validateInteger(value.sequenceStart, "event start sequence", 1);
    const sequenceEnd = validateInteger(value.sequenceEnd, "event end sequence", sequenceStart);
    const common = {
      kind: value.kind,
      schemaVersion: 1,
      scope,
      artifactId,
      modality,
      serverTransactionId: validateStableId(value.serverTransactionId, "event transaction id"),
      sequenceStart,
      sequenceEnd,
      stateHash: validateHash(value.stateHash, "event state hash"),
      committedAt: canonicalIsoString(value.committedAt, "event commit time"),
    } as const;
    return modality === "spreadsheet"
      ? Object.freeze({
          ...common,
          modality: "spreadsheet" as const,
          operationProtocolVersion: validateInteger(
            value.operationProtocolVersion,
            "event operation protocol",
            1,
          ),
        })
      : Object.freeze({
          ...common,
          modality,
          commitProtocolVersion: validateInteger(
            value.commitProtocolVersion,
            "event commit protocol",
            EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
            EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
          ),
        });
  }
  if (value.kind === "snapshot_published") {
    assertExactKeys(
      value,
      [
        "artifactId",
        "coveredHeadSequence",
        "kind",
        "modality",
        ...(modality === "spreadsheet" ? ["operationProtocolVersion"] : []),
        "publishedAt",
        "schemaVersion",
        "scope",
        "snapshotId",
        "stateHash",
      ],
      "snapshot outbox event",
    );
    const common = {
      kind: value.kind,
      schemaVersion: 1,
      scope,
      artifactId,
      modality,
      snapshotId: validateStableId(value.snapshotId, "event snapshot id"),
      coveredHeadSequence: validateInteger(value.coveredHeadSequence, "event snapshot coverage", 0),
      stateHash: validateHash(value.stateHash, "event state hash"),
      publishedAt: canonicalIsoString(value.publishedAt, "event publication time"),
    } as const;
    return modality === "spreadsheet"
      ? Object.freeze({
          ...common,
          modality: "spreadsheet" as const,
          operationProtocolVersion: validateInteger(
            value.operationProtocolVersion,
            "event operation protocol",
            1,
          ),
        })
      : Object.freeze({ ...common, modality });
  }
  throw corrupt("Live outbox event kind is invalid");
}

function validateAppliedCommit(
  artifact: PersistedEditableArtifact,
  input: CommitPersistedEditableArtifactTransaction,
): Uint8Array {
  if (input.expectedHeadSequence !== artifact.headSequence) throw conflict("Artifact head changed");
  if (artifact.lifecycle !== "active") throw conflict("Archived artifacts cannot accept edits");
  const receipt = input.receipt;
  const intentBytes = validateReceipt(receipt, artifact);
  validateStableId(input.serverTransactionId, "transaction id");
  if (
    receipt.modality !== artifact.modality ||
    input.committedTransaction.modality !== artifact.modality ||
    receipt.serverTransactionId !== input.serverTransactionId ||
    receipt.priorStateHash !== artifact.stateHash ||
    receipt.sequenceStart !== artifact.headSequence + 1
  ) {
    throw new TypeError("Committed transaction does not extend its durable artifact head");
  }
  if (receipt.modality !== "spreadsheet") {
    if (input.operations.length !== 0 || receipt.sequenceEnd !== receipt.sequenceStart) {
      throw new TypeError("Serialized commit must advance one head without CRDT operations");
    }
    validateCommittedTransactionProjection(input.committedTransaction, receipt, input.operations);
    validateOutboxRecord(input.outbox, artifact);
    return intentBytes;
  }
  if (artifact.modality !== "spreadsheet") {
    throw new TypeError("Spreadsheet receipt cannot commit to a serialized artifact");
  }
  if (
    input.operations.length !== receipt.operationCount ||
    receipt.sequenceEnd !== artifact.headSequence + input.operations.length
  ) {
    throw new TypeError("Committed operation interval does not match its receipt");
  }
  const priorReplicaCounter = causalCounter(artifact.causalFrontier, receipt.replicaId);
  if (receipt.replicaCounter !== priorReplicaCounter + 1) {
    throw new TypeError("Receipt does not immediately advance its authoritative replica counter");
  }
  if (
    !frontierDominates(receipt.resolvedCausalBase, receipt.causalBase) ||
    !frontierDominates(artifact.causalFrontier, receipt.resolvedCausalBase)
  ) {
    throw new TypeError("Receipt resolved causal base is inconsistent with authoritative history");
  }
  const expectedResult = mergeFrontier(artifact.causalFrontier, {
    replicaId: receipt.replicaId,
    counter: receipt.replicaCounter,
  });
  if (!sameFrontier(expectedResult, receipt.resultingCausalFrontier)) {
    throw new TypeError("Receipt resulting frontier does not exactly match its transaction dot");
  }
  for (let index = 0; index < input.operations.length; index += 1) {
    const operation = input.operations[index]!;
    if (
      operation.scope.accountId !== artifact.scope.accountId ||
      operation.scope.workspaceId !== artifact.scope.workspaceId ||
      operation.artifactId !== artifact.id ||
      operation.serverTransactionId !== input.serverTransactionId ||
      operation.sequence !== receipt.sequenceStart + index ||
      operation.actorKey !== receipt.actorKey
    ) {
      throw new TypeError("Committed operation is not bound to its authoritative interval");
    }
    validateStableId(operation.operationId, "operation id");
    validateReplicaId(operation.dot.replicaId);
    validateInteger(operation.dot.counter, "operation causal counter", 1);
    if (
      operation.dot.replicaId !== receipt.replicaId ||
      operation.dot.counter !== receipt.replicaCounter
    ) {
      throw new TypeError("Operation dot must equal its atomic transaction dot");
    }
    if (
      canonicalIsoString(operation.createdAt, "operation creation time") !== receipt.committedAt
    ) {
      throw new TypeError("Operation creation time must equal its transaction commit time");
    }
  }
  validateCommittedTransactionProjection(input.committedTransaction, receipt, input.operations);
  validateOutboxRecord(input.outbox, artifact);
  return intentBytes;
}

function validateOwnedCommitCandidate(
  input: TryCommitPersistedEditableArtifactTransactionRequest,
): void {
  if (
    input.receipt.scope.accountId !== input.scope.accountId ||
    input.receipt.scope.workspaceId !== input.scope.workspaceId ||
    input.receipt.artifactId !== input.artifactId ||
    input.receipt.serverTransactionId !== input.serverTransactionId ||
    input.receipt.requestHash !== input.requestHash
  ) {
    throw new TypeError("Optimistic commit identity does not match its durable receipt");
  }
  validateCommittedTransactionProjection(
    input.committedTransaction,
    input.receipt,
    input.operations,
  );
}

function validateCommittedTransactionProjection(
  transaction: PersistedEditableArtifactCommittedTransactionRecord,
  receipt: PersistedEditableArtifactReceipt,
  operations: readonly PersistedEditableArtifactOperationRecord[],
): void {
  if (
    transaction.modality !== receipt.modality ||
    transaction.scope.accountId !== receipt.scope.accountId ||
    transaction.scope.workspaceId !== receipt.scope.workspaceId ||
    transaction.artifactId !== receipt.artifactId ||
    transaction.serverTransactionId !== receipt.serverTransactionId ||
    transaction.requestHash !== receipt.requestHash ||
    transaction.sequenceStart !== receipt.sequenceStart ||
    transaction.sequenceEnd !== receipt.sequenceEnd ||
    transaction.priorStateHash !== receipt.priorStateHash ||
    transaction.stateHash !== receipt.stateHash ||
    transaction.modelSchemaVersion !== receipt.modelSchemaVersion ||
    transaction.kernelVersion !== receipt.kernelVersion ||
    transaction.committedAt !== receipt.committedAt
  ) {
    throw new TypeError("Canonical committed transaction disagrees with its receipt projection");
  }
  validateStableId(transaction.serverTransactionId, "committed transaction id");
  validateHash(transaction.requestHash, "committed transaction request hash");
  validateHash(transaction.priorStateHash, "committed transaction prior state hash");
  validateHash(transaction.stateHash, "committed transaction state hash");
  validateInteger(transaction.modelSchemaVersion, "committed transaction model schema version", 1);
  validateBoundedText(
    transaction.kernelVersion,
    "committed transaction kernel version",
    EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
  );
  canonicalIsoString(transaction.committedAt, "committed transaction commit time");
  if (
    !(transaction.committedTransactionBytes instanceof Uint8Array) ||
    transaction.committedTransactionBytes.byteLength < 1 ||
    transaction.committedTransactionBytes.byteLength > MAX_COMMITTED_TRANSACTION_BYTES
  ) {
    throw new TypeError("Canonical committed transaction bytes are invalid or oversized");
  }
  if (transaction.modality === "spreadsheet" && receipt.modality === "spreadsheet") {
    if (
      transaction.dot.replicaId !== receipt.replicaId ||
      transaction.dot.counter !== receipt.replicaCounter ||
      !sameFrontier(transaction.resolvedCausalBase, receipt.resolvedCausalBase) ||
      !sameFrontier(transaction.resultingCausalFrontier, receipt.resultingCausalFrontier) ||
      transaction.operationProtocolVersion !== receipt.operationProtocolVersion ||
      transaction.operationIds.length !== operations.length ||
      transaction.operationIds.some(
        (operationId, index) => operationId !== operations[index]?.operationId,
      )
    ) {
      throw new TypeError("Canonical spreadsheet commit disagrees with its receipt projection");
    }
    validateReplicaId(transaction.dot.replicaId);
    validateInteger(transaction.dot.counter, "committed transaction causal counter", 1);
    const resolvedCausalBase = parseFrontier(transaction.resolvedCausalBase);
    const resultingCausalFrontier = parseFrontier(transaction.resultingCausalFrontier);
    const operationIds = parseStableIdArray(
      transaction.operationIds,
      "committed transaction operation ids",
      MAX_COMMITTED_TRANSACTION_OPERATIONS,
    );
    validateInteger(
      transaction.operationProtocolVersion,
      "committed transaction operation protocol version",
      COMMITTED_TRANSACTION_PROTOCOL_VERSION,
      COMMITTED_TRANSACTION_PROTOCOL_VERSION,
    );
    let summary: ReturnType<typeof decodeCommittedTransactionSummary>;
    try {
      summary = decodeCommittedTransactionSummary(transaction.committedTransactionBytes);
    } catch (error) {
      throw new TypeError("Canonical committed transaction is not a valid OGACO001 envelope", {
        cause: error,
      });
    }
    if (
      summary.transactionId !== transaction.serverTransactionId ||
      summary.dot.replicaId !== transaction.dot.replicaId ||
      summary.dot.counter !== transaction.dot.counter ||
      summary.priorStateHash !== transaction.priorStateHash ||
      summary.stateHash !== transaction.stateHash ||
      summary.operationProtocolVersion !== transaction.operationProtocolVersion ||
      !sameStringArray(summary.operationIds, operationIds) ||
      !sameFrontier(summary.resolvedCausalBase, resolvedCausalBase) ||
      !sameFrontier(summary.resultingCausalFrontier, resultingCausalFrontier)
    ) {
      throw new TypeError("Canonical OGACO001 bytes disagree with their durable projection");
    }
    return;
  }
  if (transaction.modality === "spreadsheet" || receipt.modality === "spreadsheet") {
    throw new TypeError("Committed transaction and receipt modalities disagree");
  }
  if (
    operations.length !== 0 ||
    transaction.sequenceStart !== transaction.sequenceEnd ||
    transaction.commitProtocolVersion !== receipt.commitProtocolVersion ||
    transaction.priorNativeRevision !== receipt.priorNativeRevision ||
    transaction.nativeRevision !== receipt.nativeRevision ||
    transaction.commandCount !== receipt.commandCount
  ) {
    throw new TypeError("Canonical serialized commit disagrees with its receipt projection");
  }
  validateInteger(
    transaction.commitProtocolVersion,
    "serialized commit protocol version",
    EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
    EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
  );
  validateInteger(transaction.priorNativeRevision, "serialized prior native revision", 0);
  validateInteger(transaction.nativeRevision, "serialized native revision", 0);
  validateInteger(
    transaction.commandCount,
    "serialized command count",
    1,
    MAX_COMMITTED_TRANSACTION_OPERATIONS,
  );
  if (
    !(transaction.nativeReceiptBytes instanceof Uint8Array) ||
    transaction.nativeReceiptBytes.byteLength < 1 ||
    transaction.nativeReceiptBytes.byteLength > EDITABLE_ARTIFACT_NATIVE_RECEIPT_MAX_BYTES
  ) {
    throw new TypeError("Serialized native receipt bytes are invalid or oversized");
  }
  let summary: ReturnType<typeof decodeEditableArtifactSerializedCommit>;
  try {
    summary = decodeEditableArtifactSerializedCommit(
      transaction.committedTransactionBytes,
      transaction.modality,
    );
  } catch (error) {
    throw new TypeError("Canonical committed transaction is not a valid OGAST001 envelope", {
      cause: error,
    });
  }
  if (
    summary.transactionId !== transaction.serverTransactionId ||
    summary.parentHeadSequence !== transaction.sequenceStart - 1 ||
    summary.resultHeadSequence !== transaction.sequenceEnd ||
    summary.priorNativeRevision !== transaction.priorNativeRevision ||
    summary.priorStateHash !== transaction.priorStateHash ||
    summary.stateHash !== transaction.stateHash ||
    summary.requestHash !== transaction.requestHash ||
    summary.nativeReceipt.revision !== transaction.nativeRevision ||
    summary.nativeReceipt.commandCount !== transaction.commandCount ||
    !equalByteArrays(summary.intentBytes, receipt.intentBytes) ||
    !equalByteArrays(summary.nativeReceiptBytes, transaction.nativeReceiptBytes)
  ) {
    throw new TypeError("Canonical OGAST001 bytes disagree with their durable projection");
  }
}

function validateReceipt(
  receipt: PersistedEditableArtifactReceipt,
  artifact: PersistedEditableArtifact,
): Uint8Array {
  validateStableId(receipt.receiptId, "receipt id");
  validateStableId(receipt.serverTransactionId, "transaction id");
  if (
    receipt.scope.accountId !== artifact.scope.accountId ||
    receipt.scope.workspaceId !== artifact.scope.workspaceId ||
    receipt.artifactId !== artifact.id ||
    receipt.modality !== artifact.modality
  )
    throw new TypeError("Receipt tenant identity does not match locked artifact");
  validateClientTransactionId(receipt.clientTransactionId);
  validateReplicaId(receipt.replicaId);
  validateInteger(receipt.replicaCounter, "receipt replica counter", 1);
  if (receipt.previousLocalTransactionId !== null) {
    validateClientTransactionId(receipt.previousLocalTransactionId);
    if (receipt.previousLocalTransactionId === receipt.clientTransactionId) {
      throw new TypeError("A transaction cannot name itself as its predecessor");
    }
  }
  const intentBytes = validateCanonicalIntentBytes(receipt.intentBytes, receipt.requestHash);
  validateHash(receipt.requestHash, "request hash");
  validateActorKey(receipt.actorKey);
  validateInteger(receipt.sequenceStart, "receipt start sequence", 1);
  validateInteger(receipt.sequenceEnd, "receipt end sequence", receipt.sequenceStart);
  validateHash(receipt.priorStateHash, "receipt prior state hash");
  validateHash(receipt.stateHash, "receipt state hash");
  validateInteger(receipt.intentEnvelopeVersion, "intent envelope version", 1, 1);
  validateIntentProtocolVersion(receipt.intentProtocolVersion);
  validateInteger(receipt.commandProtocolVersion, "command protocol version", 1);
  validateBoundedText(
    receipt.kernelVersion,
    "kernel version",
    EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
  );
  validateInteger(receipt.modelSchemaVersion, "model schema version", 1);
  canonicalIsoString(receipt.committedAt, "receipt commit time");
  if (receipt.modality === "spreadsheet") {
    validateInteger(
      receipt.operationCount,
      "receipt operation count",
      1,
      MAX_COMMITTED_TRANSACTION_OPERATIONS,
    );
    if (receipt.sequenceEnd - receipt.sequenceStart + 1 !== receipt.operationCount) {
      throw new TypeError("Receipt interval does not match operation count");
    }
    parseFrontier(receipt.causalBase);
    parseFrontier(receipt.resolvedCausalBase);
    parseFrontier(receipt.resultingCausalFrontier);
    parseStableIdArray(receipt.selectiveUndoOperationIds, "undo targets", 10_000);
    validateInteger(receipt.operationProtocolVersion, "operation protocol version", 1);
  } else {
    if (receipt.sequenceEnd !== receipt.sequenceStart) {
      throw new TypeError("Serialized receipt must advance the durable head exactly once");
    }
    validateInteger(
      receipt.commitProtocolVersion,
      "serialized commit protocol version",
      EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
      EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
    );
    validateInteger(receipt.priorNativeRevision, "serialized prior native revision", 0);
    validateInteger(receipt.nativeRevision, "serialized native revision", 0);
    validateInteger(
      receipt.commandCount,
      "serialized command count",
      1,
      MAX_COMMITTED_TRANSACTION_OPERATIONS,
    );
  }
  return intentBytes;
}

function ownSnapshotCommit(
  input: CommitPersistedEditableArtifactSnapshot,
): CommitPersistedEditableArtifactSnapshot {
  const expectedCurrentSnapshotId =
    input.expectedCurrentSnapshotId === null
      ? null
      : validateStableId(input.expectedCurrentSnapshotId, "expected current snapshot id");
  const snapshot = ownSnapshotMetadata(input.snapshot);
  return Object.freeze({
    expectedCurrentSnapshotId,
    expectedAuthorizationRevision: validateInteger(
      input.expectedAuthorizationRevision,
      "expected snapshot authorization revision",
      0,
    ),
    authorizationActor: validateLiveTicketActor(input.authorizationActor),
    authorizationPermission: snapshotAuthorizationPermission(
      input.authorizationPermission ?? "manage",
    ),
    snapshot,
    outbox: cloneOutbox(input.outbox),
  });
}

function ownSnapshotMetadata(
  snapshot: PersistedEditableArtifactSnapshotMetadata,
): PersistedEditableArtifactSnapshotMetadata {
  return snapshot.modality === "spreadsheet"
    ? Object.freeze({
        ...snapshot,
        scope: validateScope(snapshot.scope),
        coveredCausalFrontier: parseFrontier(snapshot.coveredCausalFrontier),
      })
    : Object.freeze({
        ...snapshot,
        scope: validateScope(snapshot.scope),
        modality: serializedModality(snapshot.modality, "snapshot modality"),
        nativeRevision: validateInteger(snapshot.nativeRevision, "snapshot native revision", 0),
      });
}

function validateSnapshotCommit(
  artifact: PersistedEditableArtifact,
  input: Omit<CommitPersistedEditableArtifactSnapshot, "authorizationActor">,
): void {
  if (input.expectedAuthorizationRevision !== artifact.authorizationRevision) {
    throw conflict("Artifact authorization changed before snapshot publication");
  }
  if (input.expectedCurrentSnapshotId !== artifact.currentSnapshotId) {
    throw conflict("Current snapshot changed");
  }
  const snapshot = input.snapshot;
  if (
    snapshot.scope.accountId !== artifact.scope.accountId ||
    snapshot.scope.workspaceId !== artifact.scope.workspaceId ||
    snapshot.artifactId !== artifact.id ||
    snapshot.modality !== artifact.modality
  )
    throw new TypeError("Snapshot tenant identity does not match locked artifact");
  validateStableId(snapshot.snapshotId, "snapshot id");
  validateBoundedText(snapshot.blobReference, "snapshot blob reference", 1024);
  validateInteger(
    snapshot.byteSize,
    "snapshot byte size",
    1,
    EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
  );
  validateHash(snapshot.contentHash, "snapshot content hash");
  if (snapshot.mimeType !== "application/vnd.opengeni.editable-artifact-snapshot") {
    throw new TypeError("Snapshot MIME type is invalid");
  }
  validateInteger(snapshot.coveredHeadSequence, "snapshot coverage", 0, artifact.headSequence);
  validateHash(snapshot.stateHash, "snapshot state hash");
  validateInteger(snapshot.modelSchemaVersion, "model schema version", 1);
  validateBoundedText(
    snapshot.kernelVersion,
    "kernel version",
    EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
  );
  if (snapshot.modality === "spreadsheet") {
    parseFrontier(snapshot.coveredCausalFrontier);
    validateInteger(snapshot.operationProtocolVersion, "operation protocol version", 1);
    validateInteger(snapshot.crdtStateVersion, "CRDT state version", 1);
  } else {
    validateInteger(snapshot.nativeRevision, "snapshot native revision", 0);
  }
  canonicalIsoString(snapshot.verifiedAt, "snapshot verification time");
  canonicalIsoString(snapshot.publishedAt, "snapshot publication time");
  if (snapshot.verifiedAt > snapshot.publishedAt) {
    throw new TypeError("Snapshot verification time cannot follow publication time");
  }
  validateOutboxRecord(input.outbox, artifact);
}

function snapshotAuthorizationPermission(value: unknown): "manage" | "read" | "edit" {
  if (value !== "manage" && value !== "read" && value !== "edit") {
    throw new TypeError("Snapshot authorization permission is invalid");
  }
  return value;
}

function validateGenesisCreation(
  artifact: PersistedEditableArtifact,
  snapshot: PersistedEditableArtifactSnapshotMetadata,
  outbox: PersistedEditableArtifactLiveOutboxRecord,
  operationKind: "create" | "import",
): void {
  validateSnapshotCommit(artifact, {
    expectedCurrentSnapshotId: null,
    expectedAuthorizationRevision: artifact.authorizationRevision,
    snapshot,
    outbox,
  });
  if (
    snapshot.coveredHeadSequence !== 0 ||
    (operationKind === "create" &&
      (snapshot.modality === "spreadsheet"
        ? snapshot.coveredCausalFrontier.length !== 0
        : snapshot.nativeRevision !== 0)) ||
    snapshot.stateHash !== artifact.stateHash ||
    snapshot.publishedAt !== artifact.createdAt
  ) {
    throw new TypeError("Genesis snapshot must exactly define the sequence-zero artifact state");
  }
  validateSnapshotOutbox(outbox, snapshot);
}

function validateExpectedPredecessor(
  value: ExpectedPersistedEditableArtifactPredecessor | null,
): ExpectedPersistedEditableArtifactPredecessor | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) throw new TypeError("Expected predecessor is invalid");
  assertExactKeys(
    value,
    [
      "actorKey",
      "clientTransactionId",
      "receiptId",
      "replicaCounter",
      "replicaId",
      "serverTransactionId",
    ],
    "expected predecessor",
  );
  return Object.freeze({
    receiptId: validateStableId(value.receiptId, "predecessor receipt id"),
    serverTransactionId: validateStableId(value.serverTransactionId, "predecessor transaction id"),
    actorKey: validateActorKey(value.actorKey as string).key,
    clientTransactionId: validateClientTransactionId(value.clientTransactionId),
    replicaId: validateReplicaId(value.replicaId),
    replicaCounter: validateInteger(value.replicaCounter, "predecessor replica counter", 1),
  });
}

function predecessorMatches(
  actual: PersistedEditableArtifactReceipt | null,
  expected: ExpectedPersistedEditableArtifactPredecessor,
): boolean {
  return (
    actual !== null &&
    actual.receiptId === expected.receiptId &&
    actual.serverTransactionId === expected.serverTransactionId &&
    actual.actorKey === expected.actorKey &&
    actual.clientTransactionId === expected.clientTransactionId &&
    actual.replicaId === expected.replicaId &&
    actual.replicaCounter === expected.replicaCounter
  );
}

function replayResult(
  receipt: PersistedEditableArtifactReceipt,
): TryCommitPersistedEditableArtifactTransactionResult {
  return Object.freeze({ kind: "replayed", receipt: cloneReceipt(receipt) });
}

function validateOutboxRecord(
  record: PersistedEditableArtifactLiveOutboxRecord,
  artifact: PersistedEditableArtifact,
): void {
  validateStableId(record.outboxId, "outbox id");
  if (
    record.event.scope.accountId !== artifact.scope.accountId ||
    record.event.scope.workspaceId !== artifact.scope.workspaceId ||
    record.event.artifactId !== artifact.id ||
    record.event.modality !== artifact.modality
  )
    throw new TypeError("Outbox event tenant identity does not match locked artifact");
  parseLiveEvent(record.event);
  if (
    record.state !== "pending" ||
    record.attemptCount !== 0 ||
    record.leaseOwner !== null ||
    record.leaseExpiresAt !== null ||
    record.nextAttemptAt !== record.createdAt ||
    record.lastErrorCode !== null ||
    record.publishedAt !== null ||
    record.deadLetteredAt !== null
  ) {
    throw new TypeError("New outbox record must be pending and unleased");
  }
  canonicalIsoString(record.createdAt, "outbox creation time");
}

function validateTransactionOutbox(
  record: PersistedEditableArtifactLiveOutboxRecord,
  receipt: PersistedEditableArtifactReceipt,
): void {
  if (record.event.kind !== "transaction_committed") {
    throw new TypeError("Transaction commit requires a transaction outbox event");
  }
  const event = parseLiveEvent(record.event);
  if (
    event.kind !== "transaction_committed" ||
    event.modality !== receipt.modality ||
    event.serverTransactionId !== receipt.serverTransactionId ||
    event.sequenceStart !== receipt.sequenceStart ||
    event.sequenceEnd !== receipt.sequenceEnd ||
    event.stateHash !== receipt.stateHash ||
    (event.modality === "spreadsheet" && receipt.modality === "spreadsheet"
      ? event.operationProtocolVersion !== receipt.operationProtocolVersion
      : event.modality !== "spreadsheet" && receipt.modality !== "spreadsheet"
        ? event.commitProtocolVersion !== receipt.commitProtocolVersion
        : true) ||
    event.committedAt !== receipt.committedAt ||
    record.createdAt !== receipt.committedAt
  ) {
    throw new TypeError("Transaction outbox event does not exactly describe its durable commit");
  }
}

function validateSnapshotOutbox(
  record: PersistedEditableArtifactLiveOutboxRecord,
  snapshot: PersistedEditableArtifactSnapshotMetadata,
): void {
  if (record.event.kind !== "snapshot_published") {
    throw new TypeError("Snapshot publication requires a snapshot outbox event");
  }
  const event = parseLiveEvent(record.event);
  if (
    event.kind !== "snapshot_published" ||
    event.modality !== snapshot.modality ||
    event.snapshotId !== snapshot.snapshotId ||
    event.coveredHeadSequence !== snapshot.coveredHeadSequence ||
    event.stateHash !== snapshot.stateHash ||
    (event.modality === "spreadsheet" &&
      snapshot.modality === "spreadsheet" &&
      event.operationProtocolVersion !== snapshot.operationProtocolVersion) ||
    event.publishedAt !== snapshot.publishedAt ||
    record.createdAt !== snapshot.publishedAt
  ) {
    throw new TypeError("Snapshot outbox event does not exactly describe its durable publication");
  }
}

type ParsedActor =
  | { kind: "human"; subjectId: string; key: string }
  | {
      kind: "agent";
      subjectId: string;
      sessionId: string;
      turnId: string;
      attemptId: string;
      generation: number;
      key: string;
    }
  | { kind: "service"; subjectId: string; service: string; key: string };

function validateActorKey(input: string): ParsedActor {
  validateBoundedText(input, "actor key", 8192);
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new TypeError("Actor key must be canonical JSON");
  }
  if (!Array.isArray(value)) throw new TypeError("Actor key must be a JSON tuple");
  let actor: ParsedActor;
  if (value[0] === "human" && value.length === 2) {
    actor = {
      kind: "human",
      subjectId: validateIdentity(value[1], "actor subject id"),
      key: input,
    };
  } else if (value[0] === "agent" && value.length === 6) {
    actor = {
      kind: "agent",
      subjectId: validateIdentity(value[1], "actor subject id"),
      sessionId: validateIdentity(value[2], "agent session id"),
      turnId: validateIdentity(value[3], "agent turn id"),
      attemptId: validateIdentity(value[4], "agent attempt id"),
      generation: validateInteger(value[5], "agent generation", 0),
      key: input,
    };
  } else if (value[0] === "service" && value.length === 3) {
    actor = {
      kind: "service",
      subjectId: validateIdentity(value[1], "actor subject id"),
      service: validateIdentity(value[2], "service name"),
      key: input,
    };
  } else {
    throw new TypeError("Actor key tuple has an unsupported authority shape");
  }
  if (JSON.stringify(value) !== input)
    throw new TypeError("Actor key must use canonical JSON encoding");
  return actor;
}

function parseFrontier(input: unknown): PersistedEditableArtifactCausalFrontier {
  if (!Array.isArray(input) || input.length > 65_536)
    throw corrupt("Causal frontier is invalid or oversized");
  const seen = new Set<string>();
  const output = input.map((raw) => {
    if (!isPlainRecord(raw)) throw corrupt("Causal frontier entry is invalid");
    const keys = Object.keys(raw).sort();
    if (keys.length !== 2 || keys[0] !== "counter" || keys[1] !== "replicaId") {
      throw corrupt("Causal frontier entry contains unknown fields");
    }
    const replicaId = validateReplicaId(raw.replicaId);
    if (seen.has(replicaId)) throw corrupt("Causal frontier contains duplicate replicas");
    seen.add(replicaId);
    return Object.freeze({ replicaId, counter: validateInteger(raw.counter, "causal counter", 1) });
  });
  output.sort((left, right) =>
    left.replicaId < right.replicaId ? -1 : left.replicaId > right.replicaId ? 1 : 0,
  );
  for (let index = 0; index < output.length; index += 1) {
    const raw = input[index] as Record<string, unknown>;
    if (raw.replicaId !== output[index]!.replicaId)
      throw corrupt("Causal frontier is not canonically sorted");
  }
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 1024 * 1024) {
    throw corrupt("Causal frontier exceeds 1 MiB");
  }
  return Object.freeze(output);
}

function parseStableIdArray(input: unknown, label: string, max: number): readonly string[] {
  if (!Array.isArray(input) || input.length > max)
    throw corrupt(`${label} is invalid or oversized`);
  const values = input.map((value) => validateStableId(value, label));
  if (new Set(values).size !== values.length) throw corrupt(`${label} contains duplicates`);
  return Object.freeze(values);
}

function validateScope(scope: PersistedEditableArtifactScope): PersistedEditableArtifactScope {
  if (!isPlainRecord(scope)) throw new TypeError("Editable artifact scope is invalid");
  assertExactKeys(scope, ["accountId", "workspaceId"], "editable artifact scope");
  return Object.freeze({
    accountId: validateIdentity(scope.accountId, "account id"),
    workspaceId: validateIdentity(scope.workspaceId, "workspace id"),
  });
}

function validateLiveTicketRecord(
  input: PersistedEditableArtifactLiveTicketRecord,
): PersistedEditableArtifactLiveTicketRecord {
  if (!isPlainRecord(input)) throw new TypeError("Live ticket record is invalid");
  assertExactKeys(
    input,
    [
      "actor",
      "allowEdit",
      "artifactId",
      "expiresAt",
      "issuedAt",
      "modality",
      "protocolVersion",
      "scope",
      "tokenDigest",
    ],
    "live ticket record",
  );
  const issuedAt = canonicalIsoString(input.issuedAt, "live ticket issuedAt");
  const expiresAt = canonicalIsoString(input.expiresAt, "live ticket expiresAt");
  const durationMs = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (durationMs < 1_000 || durationMs > 60_000) {
    throw new TypeError("Live ticket lifetime must be 1-60 seconds");
  }
  const modality = validateLiveTicketModality(input.modality);
  return Object.freeze({
    tokenDigest: validateHash(input.tokenDigest, "live ticket digest"),
    scope: validateScope(input.scope),
    artifactId: validateStableId(input.artifactId, "artifact id"),
    modality,
    actor: validateLiveTicketActor(input.actor),
    allowEdit: validateBoolean(input.allowEdit, "live ticket allowEdit"),
    protocolVersion: validateInteger(input.protocolVersion, "live protocol version", 1),
    issuedAt,
    expiresAt,
  });
}

function validateLiveTicketActor(
  input: PersistedEditableArtifactLiveTicketActor,
): PersistedEditableArtifactLiveTicketActor {
  if (!isPlainRecord(input)) throw new TypeError("Live ticket actor is invalid");
  const common = {
    subjectId: validateIdentity(input.subjectId, "actor subject id"),
    replicaId: validateReplicaId(input.replicaId),
  };
  if (input.kind === "human") {
    assertExactKeys(input, ["kind", "replicaId", "subjectId"], "human live ticket actor");
    return Object.freeze({ kind: "human" as const, ...common });
  }
  if (input.kind === "agent") {
    assertExactKeys(
      input,
      ["attemptId", "generation", "kind", "replicaId", "sessionId", "subjectId", "turnId"],
      "agent live ticket actor",
    );
    return Object.freeze({
      kind: "agent" as const,
      ...common,
      sessionId: validateIdentity(input.sessionId, "agent session id"),
      turnId: validateIdentity(input.turnId, "agent turn id"),
      attemptId: validateIdentity(input.attemptId, "agent attempt id"),
      generation: validateInteger(input.generation, "agent generation", 0, 2_147_483_647),
    });
  }
  if (input.kind === "service") {
    assertExactKeys(
      input,
      ["kind", "replicaId", "service", "subjectId"],
      "service live ticket actor",
    );
    return Object.freeze({
      kind: "service" as const,
      ...common,
      service: validateIdentity(input.service, "service name"),
    });
  }
  throw new TypeError("Live ticket actor kind is invalid");
}

function persistedEditableArtifactActorKey(actor: PersistedEditableArtifactActor): string {
  switch (actor.kind) {
    case "human":
      return JSON.stringify([actor.kind, actor.subjectId]);
    case "agent":
      return JSON.stringify([
        actor.kind,
        actor.subjectId,
        actor.sessionId,
        actor.turnId,
        actor.attemptId,
        actor.generation,
      ]);
    case "service":
      return JSON.stringify([actor.kind, actor.subjectId, actor.service]);
  }
}

async function transactionallyAuthorizeEditableArtifactActor(
  tx: Database,
  input: Readonly<{
    scope: PersistedEditableArtifactScope;
    artifactId: string;
    actor: PersistedEditableArtifactActor;
    permission: "create" | "import" | "read" | "edit" | "manage";
  }>,
): Promise<Readonly<{ allowed: boolean; revision: number }>> {
  const actor = input.actor;
  const rows = await rawRows<{
    allowed: boolean;
    authorization_revision: string | number | bigint;
  }>(
    tx,
    sql`select * from opengeni_private.authorize_editable_artifact_actor(
      ${input.scope.accountId}::uuid,
      ${input.scope.workspaceId}::uuid,
      ${input.artifactId},
      ${actor.kind},
      ${actor.subjectId},
      ${actor.kind === "agent" ? actor.sessionId : null},
      ${actor.kind === "agent" ? actor.turnId : null},
      ${actor.kind === "agent" ? actor.attemptId : null},
      ${actor.kind === "agent" ? actor.generation : null},
      ${actor.kind === "service" ? actor.service : null},
      ${input.permission},
      current_schema()
    )`,
  );
  const row = rows[0];
  if (rows.length !== 1 || !row) {
    throw corrupt("Editable artifact authorization returned no exact decision");
  }
  return Object.freeze({
    allowed: row.allowed === true,
    revision: safeInteger(row.authorization_revision, "authorization revision", 1),
  });
}

function validateLiveTicketModality(
  input: unknown,
): PersistedEditableArtifactLiveTicketRecord["modality"] {
  if (input !== "spreadsheet" && input !== "presentation" && input !== "document") {
    throw new TypeError("Live ticket modality is invalid");
  }
  return input;
}

function liveTicketFromRow(row: LiveTicketRow): PersistedEditableArtifactLiveTicketRecord {
  let actor: PersistedEditableArtifactLiveTicketActor;
  if (row.actor_kind === "human") {
    if (
      row.agent_session_id !== null ||
      row.agent_turn_id !== null ||
      row.agent_attempt_id !== null ||
      row.agent_generation !== null ||
      row.service_name !== null
    ) {
      throw corrupt("Human live ticket has non-human authority fields");
    }
    actor = { kind: "human", subjectId: row.actor_subject_id, replicaId: row.replica_id };
  } else if (row.actor_kind === "agent") {
    if (
      row.agent_session_id === null ||
      row.agent_turn_id === null ||
      row.agent_attempt_id === null ||
      row.agent_generation === null ||
      row.service_name !== null
    ) {
      throw corrupt("Agent live ticket authority fields are incomplete");
    }
    actor = {
      kind: "agent",
      subjectId: row.actor_subject_id,
      replicaId: row.replica_id,
      sessionId: row.agent_session_id,
      turnId: row.agent_turn_id,
      attemptId: row.agent_attempt_id,
      generation: row.agent_generation,
    };
  } else if (row.actor_kind === "service") {
    if (
      row.agent_session_id !== null ||
      row.agent_turn_id !== null ||
      row.agent_attempt_id !== null ||
      row.agent_generation !== null ||
      row.service_name === null
    ) {
      throw corrupt("Service live ticket authority fields are incomplete");
    }
    actor = {
      kind: "service",
      subjectId: row.actor_subject_id,
      replicaId: row.replica_id,
      service: row.service_name,
    };
  } else {
    throw corrupt("Live ticket actor kind is invalid");
  }
  try {
    return validateLiveTicketRecord({
      tokenDigest: row.token_digest,
      scope: { accountId: row.account_id, workspaceId: row.workspace_id },
      artifactId: row.artifact_id,
      modality: validateLiveTicketModality(row.modality),
      actor,
      allowEdit: row.allow_edit,
      protocolVersion: row.protocol_version,
      issuedAt: iso(row.issued_at, "live ticket issuedAt"),
      expiresAt: iso(row.expires_at, "live ticket expiresAt"),
    });
  } catch (error) {
    throw corrupt(
      `Live ticket record is corrupt: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function validateStableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value) || /^0+$/.test(value)) {
    throw new TypeError(`${label} must be fixed-width lowercase nonzero hexadecimal text`);
  }
  return value;
}

function validateOriginOperation(value: unknown): "create" | "import" {
  if (value !== "create" && value !== "import") {
    throw new TypeError("Editable artifact origin operation is invalid");
  }
  return value;
}

function validateOriginalImport(
  input: Readonly<{
    fileId: string;
    blobRefId: string;
    blobReference: string;
    byteSize: number;
    contentHash: string;
    mimeType: string;
  }>,
  modality: PersistedEditableArtifact["modality"],
): Readonly<{
  fileId: string;
  blobRefId: string;
  blobReference: string;
  byteSize: number;
  contentHash: string;
  mimeType: string;
}> {
  if (
    typeof input.fileId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.fileId,
    )
  ) {
    throw new TypeError("Original import file id must be a canonical UUID");
  }
  const expectedMimeType =
    modality === "spreadsheet"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : modality === "document"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (input.mimeType !== expectedMimeType) {
    throw new TypeError("Original import MIME type does not match artifact modality");
  }
  return Object.freeze({
    fileId: input.fileId,
    blobRefId: validateStableId(input.blobRefId, "original import blob id"),
    blobReference: validateBoundedText(
      input.blobReference,
      "original import blob reference",
      1024,
    ),
    byteSize: validateInteger(
      input.byteSize,
      "original import byte size",
      1,
      EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES,
    ),
    contentHash: validateHash(input.contentHash, "original import content hash"),
    mimeType: expectedMimeType,
  });
}

function validateReplicaId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/.test(value) || /^0+$/.test(value)) {
    throw new TypeError("Replica id must be fixed-width lowercase nonzero hexadecimal text");
  }
  return value;
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function validateHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
  return value;
}

function validateCanonicalIntentBytes(value: unknown, requestHashInput: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Canonical transaction intent must be a Uint8Array");
  }
  const bytes = value.slice();
  if (bytes.byteLength < 8 || bytes.byteLength > EDITABLE_ARTIFACT_INTENT_MAX_BYTES) {
    throw new TypeError("Canonical transaction intent must contain 8 bytes through 5 MiB");
  }
  const magic = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 8));
  if (magic !== "OGATX001") {
    throw new TypeError("Canonical transaction intent has an unsupported protocol magic");
  }
  const requestHash = validateHash(requestHashInput, "request hash");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== requestHash) {
    throw new TypeError("Canonical transaction intent digest does not match request hash");
  }
  return bytes;
}

function validateIntentProtocolVersion(value: unknown): 1 {
  if (value !== 1) throw new TypeError("Intent protocol version must be 1 for OGATX001");
  return 1;
}

function validateClientTransactionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new TypeError("Client transaction id is invalid");
  }
  return value;
}

function validateIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} must contain 1-256 non-padding characters`);
  }
  return value;
}

function validateLeaseOwner(value: unknown): string {
  return validateIdentity(value, "outbox lease owner");
}

function validateOutboxRetryErrorCode(
  value: unknown,
): PersistedEditableArtifactOutboxRetryErrorCode {
  if (
    value !== "broker_unavailable" &&
    value !== "broker_backpressure" &&
    value !== "publish_timeout"
  ) {
    throw new TypeError("Outbox retry error code is invalid");
  }
  return value;
}

function validateOutboxDeadLetterErrorCode(
  value: unknown,
): PersistedEditableArtifactOutboxDeadLetterErrorCode {
  if (value !== "invalid_hint" && value !== "oversized_hint") {
    throw new TypeError("Outbox dead-letter error code is invalid");
  }
  return value;
}

function validateOutboxStoredErrorCode(
  value: unknown,
):
  | PersistedEditableArtifactOutboxRetryErrorCode
  | PersistedEditableArtifactOutboxDeadLetterErrorCode
  | "attempts_exhausted" {
  if (isOutboxRetryErrorCode(value) || isOutboxStoredDeadLetterErrorCode(value)) return value;
  throw corrupt("Outbox error code is invalid");
}

function isOutboxRetryErrorCode(
  value: unknown,
): value is PersistedEditableArtifactOutboxRetryErrorCode {
  return (
    value === "broker_unavailable" || value === "broker_backpressure" || value === "publish_timeout"
  );
}

function isOutboxStoredDeadLetterErrorCode(
  value: unknown,
): value is PersistedEditableArtifactOutboxDeadLetterErrorCode | "attempts_exhausted" {
  return value === "invalid_hint" || value === "oversized_hint" || value === "attempts_exhausted";
}

function validateBoundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() !== value)
    throw new TypeError(`${label} is invalid`);
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 1 || bytes > maxBytes) throw new TypeError(`${label} exceeds its byte limit`);
  return value;
}

function validateTitle(value: string): void {
  validateBoundedText(value, "artifact title", 512);
}

function artifactModality(value: unknown, label: string): PersistedEditableArtifact["modality"] {
  if (value !== "spreadsheet" && value !== "document" && value !== "presentation") {
    throw corrupt(`${label} is invalid`);
  }
  return value;
}

function serializedModality(value: unknown, label: string): "document" | "presentation" {
  if (value !== "document" && value !== "presentation") {
    throw corrupt(`${label} is not a serialized modality`);
  }
  return value;
}

function equalByteArrays(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertSerializedColumnsAbsent(row: CommittedTransactionRow): void {
  if (
    row.commit_protocol_version !== null ||
    row.prior_native_revision !== null ||
    row.native_revision !== null ||
    row.command_count !== null ||
    row.native_receipt_byte_size !== null ||
    row.native_receipt_hash !== null ||
    row.native_receipt_bytes !== null
  ) {
    throw corrupt("Spreadsheet transaction contains serialized projection fields");
  }
}

function readNativeReceiptBytes(row: CommittedTransactionRow): Uint8Array {
  if (!(row.native_receipt_bytes instanceof Uint8Array)) {
    throw corrupt("Serialized native receipt bytes are missing");
  }
  const bytes = Uint8Array.from(row.native_receipt_bytes);
  const byteSize = validateInteger(
    row.native_receipt_byte_size,
    "serialized native receipt byte size",
    1,
    EDITABLE_ARTIFACT_NATIVE_RECEIPT_MAX_BYTES,
  );
  if (bytes.byteLength !== byteSize) {
    throw corrupt("Serialized native receipt size disagrees with its bytes");
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== validateHash(row.native_receipt_hash, "serialized native receipt hash")) {
    throw corrupt("Serialized native receipt digest verification failed");
  }
  return bytes;
}

function validateInteger(
  value: unknown,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be a safe integer from ${min} through ${max}`);
  }
  return value;
}

function safeInteger(value: string | number | bigint | null, label: string, min = 0): number {
  if (value === null) throw corrupt(`${label} is missing`);
  const number = typeof value === "number" ? value : Number(value);
  return validateInteger(number, label, min);
}

function validateDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new TypeError(`${label} is invalid`);
  return new Date(value.getTime());
}

function canonicalIsoString(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function iso(value: Date | string, label: string): string {
  if (value instanceof Date) return validateDate(value, label).toISOString();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw corrupt(`${label} is invalid`);
  return date.toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function sameFrontier(
  left: PersistedEditableArtifactCausalFrontier,
  right: PersistedEditableArtifactCausalFrontier,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.replicaId === right[index]?.replicaId && entry.counter === right[index]?.counter,
    )
  );
}

function causalCounter(
  frontier: PersistedEditableArtifactCausalFrontier,
  replicaId: string,
): number {
  return frontier.find((entry) => entry.replicaId === replicaId)?.counter ?? 0;
}

function frontierDominates(
  candidate: PersistedEditableArtifactCausalFrontier,
  required: PersistedEditableArtifactCausalFrontier,
): boolean {
  return required.every((entry) => causalCounter(candidate, entry.replicaId) >= entry.counter);
}

function mergeFrontier(
  frontier: PersistedEditableArtifactCausalFrontier,
  entry: PersistedEditableArtifactCausalEntry,
): PersistedEditableArtifactCausalFrontier {
  return mergeFrontiers(frontier, [entry]);
}

function mergeFrontiers(
  ...frontiers: readonly PersistedEditableArtifactCausalFrontier[]
): PersistedEditableArtifactCausalFrontier {
  const counters = new Map<string, number>();
  for (const frontier of frontiers) {
    for (const entry of frontier) {
      counters.set(entry.replicaId, Math.max(counters.get(entry.replicaId) ?? 0, entry.counter));
    }
  }
  return Object.freeze(
    [...counters]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([replicaId, counter]) => Object.freeze({ replicaId, counter })),
  );
}

function cloneFrontier(
  frontier: PersistedEditableArtifactCausalFrontier,
): PersistedEditableArtifactCausalFrontier {
  return Object.freeze(frontier.map((entry) => Object.freeze({ ...entry })));
}

function cloneReceipt(receipt: PersistedEditableArtifactReceipt): PersistedEditableArtifactReceipt {
  return receipt.modality === "spreadsheet"
    ? Object.freeze({
        ...receipt,
        scope: Object.freeze({ ...receipt.scope }),
        intentBytes: receipt.intentBytes.slice(),
        modality: "spreadsheet" as const,
        causalBase: cloneFrontier(receipt.causalBase),
        resolvedCausalBase: cloneFrontier(receipt.resolvedCausalBase),
        resultingCausalFrontier: cloneFrontier(receipt.resultingCausalFrontier),
        selectiveUndoOperationIds: Object.freeze([...receipt.selectiveUndoOperationIds]),
      })
    : Object.freeze({
        ...receipt,
        scope: Object.freeze({ ...receipt.scope }),
        intentBytes: receipt.intentBytes.slice(),
        modality: receipt.modality,
      });
}

function cloneOperation(
  operation: PersistedEditableArtifactOperationRecord,
): PersistedEditableArtifactOperationRecord {
  return Object.freeze({
    ...operation,
    scope: Object.freeze({ ...operation.scope }),
    dot: Object.freeze({ ...operation.dot }),
  });
}

function cloneCommittedTransaction(
  transaction: PersistedEditableArtifactCommittedTransactionRecord,
): PersistedEditableArtifactCommittedTransactionRecord {
  if (!(transaction.committedTransactionBytes instanceof Uint8Array)) {
    throw new TypeError("Canonical committed transaction bytes must be a Uint8Array");
  }
  // Inspect the caller-owned buffer synchronously before copying, then inspect
  // the owned copy in validateOwnedCommitCandidate. This closes the only
  // mutable boundary before the first await without retaining caller memory.
  if (transaction.modality === "spreadsheet") {
    decodeCommittedTransactionSummary(transaction.committedTransactionBytes);
    return Object.freeze({
      ...transaction,
      scope: Object.freeze({ ...transaction.scope }),
      dot: Object.freeze({ ...transaction.dot }),
      resolvedCausalBase: cloneFrontier(transaction.resolvedCausalBase),
      resultingCausalFrontier: cloneFrontier(transaction.resultingCausalFrontier),
      operationIds: Object.freeze([...transaction.operationIds]),
      committedTransactionBytes: transaction.committedTransactionBytes.slice(),
    });
  }
  if (!(transaction.nativeReceiptBytes instanceof Uint8Array)) {
    throw new TypeError("Serialized native receipt bytes must be a Uint8Array");
  }
  decodeEditableArtifactSerializedCommit(
    transaction.committedTransactionBytes,
    transaction.modality,
  );
  return Object.freeze({
    ...transaction,
    scope: Object.freeze({ ...transaction.scope }),
    nativeReceiptBytes: transaction.nativeReceiptBytes.slice(),
    committedTransactionBytes: transaction.committedTransactionBytes.slice(),
  });
}

function cloneOutbox(
  outbox: PersistedEditableArtifactLiveOutboxRecord,
): PersistedEditableArtifactLiveOutboxRecord {
  return Object.freeze({
    ...outbox,
    event: parseLiveEvent(outbox.event),
  });
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneArtifact(
  artifact: Extract<PersistedEditableArtifact, { modality: "spreadsheet" }>,
): Extract<PersistedEditableArtifact, { modality: "spreadsheet" }>;
function cloneArtifact(
  artifact: Extract<PersistedEditableArtifact, { modality: "document" | "presentation" }>,
): Extract<PersistedEditableArtifact, { modality: "document" | "presentation" }>;
function cloneArtifact(artifact: PersistedEditableArtifact): PersistedEditableArtifact;
function cloneArtifact(artifact: PersistedEditableArtifact): PersistedEditableArtifact {
  return artifact.modality === "spreadsheet"
    ? Object.freeze({
        ...artifact,
        scope: Object.freeze({ ...artifact.scope }),
        causalFrontier: cloneFrontier(artifact.causalFrontier),
      })
    : Object.freeze({
        ...artifact,
        scope: Object.freeze({ ...artifact.scope }),
        modality: artifact.modality,
      });
}

function corrupt(message: string): EditableArtifactPersistenceError {
  return new EditableArtifactPersistenceError("corrupt_history", message);
}

function conflict(message: string): EditableArtifactPersistenceError {
  return new EditableArtifactPersistenceError("conflict", message);
}

function outboxLeaseConflict(): EditableArtifactPersistenceError {
  return new EditableArtifactPersistenceError(
    "outbox_lease_conflict",
    "Live outbox record is not leased by this publisher",
  );
}

function mapPersistenceError(error: unknown, message: string): Error {
  if (error instanceof EditableArtifactPersistenceError) return error;
  const code = errorCode(error);
  if (code === "23503" || code === "23505" || code === "23514" || code === "23P01") {
    return new EditableArtifactPersistenceError("conflict", message, { cause: error });
  }
  if (
    code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    code === "57014" ||
    code.startsWith("08") ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03"
  ) {
    return new EditableArtifactPersistenceError("transient", message, { cause: error });
  }
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function errorCode(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const value = objectProperty(current, "code");
    if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) return value;
    current = objectProperty(current, "cause");
  }
  return "";
}

function objectProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}
