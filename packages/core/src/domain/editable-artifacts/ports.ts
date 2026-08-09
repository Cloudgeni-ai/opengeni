import type {
  EditableArtifact,
  EditableArtifactActor,
  EditableArtifactCausalFrontier,
  EditableArtifactId,
  EditableArtifactLiveOutboxRecord,
  EditableArtifactMutationIntent,
  EditableArtifactOperationId,
  EditableArtifactOperationRecord,
  EditableArtifactOutboxId,
  EditableArtifactOutboxRetryFailureCode,
  EditableArtifactOutboxDeadLetterFailureCode,
  EditableArtifactPermission,
  EditableArtifactReceipt,
  EditableArtifactScope,
  EditableArtifactSequenceCheckpoint,
  EditableArtifactSnapshotId,
  EditableArtifactSnapshotMetadata,
  EditableArtifactStableId,
  EditableArtifactStateHash,
  EditableArtifactTransactionId,
  EditableArtifactClientTransactionId,
  EditableArtifactCommittedTransactionRecord,
  EditableArtifactModality,
  EditableArtifactRequestHash,
  EditableArtifactSerialized,
  EditableArtifactSerializedCommittedTransactionRecord,
  EditableArtifactSerializedSnapshotMetadata,
  EditableArtifactSpreadsheet,
  EditableArtifactSpreadsheetCommittedTransactionRecord,
  EditableArtifactSpreadsheetSnapshotMetadata,
  CreateEditableArtifactResult,
  PublishEditableArtifactSnapshotRequest,
  ValidatedEditableArtifactMutationIntent,
} from "./types";

export type EditableArtifactAuthorizationRequest = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  actor: EditableArtifactActor;
  permission: EditableArtifactPermission;
}>;

export type EditableArtifactAuthorizationDecision = Readonly<{
  allowed: boolean;
  /**
   * Current durable local policy revision, even when access is denied.
   * `create` decisions use the workspace's scope-create head. Every other
   * decision uses the target artifact's authorization head. A decision is not
   * commit authority by itself: the corresponding store write must compare
   * this revision atomically with its durable policy head.
   */
  revision: number;
}>;

export interface EditableArtifactAuthorizationPort {
  authorize(
    request: EditableArtifactAuthorizationRequest,
  ): Promise<EditableArtifactAuthorizationDecision>;
}

export type EditableArtifactKernelState =
  | Readonly<{
      modality: "spreadsheet";
      artifact: EditableArtifactSpreadsheet;
      snapshot: EditableArtifactSpreadsheetSnapshotMetadata | null;
      /** Replay work after the current snapshot, used for bounded compaction admission. */
      tailTransactionCount: number;
      tailByteSize: number;
      /** Canonical OGACO tail strictly after the snapshot coverage. */
      committedTransactionTail: readonly EditableArtifactSpreadsheetCommittedTransactionRecord[];
    }>
  | Readonly<{
      modality: "document" | "presentation";
      artifact: EditableArtifactSerialized;
      snapshot: EditableArtifactSerializedSnapshotMetadata | null;
      /** Replay work after the current snapshot, used for bounded compaction admission. */
      tailTransactionCount: number;
      tailByteSize: number;
      /** Native revision at the sequence boundary immediately before the tail. */
      baseNativeRevision: number;
      /** Canonical OGAST tail strictly after the snapshot coverage. */
      committedTransactionTail: readonly EditableArtifactSerializedCommittedTransactionRecord[];
    }>;

type ApplyAuthoritativeEditableArtifactKernelRequestCommon = Readonly<{
  state: EditableArtifactKernelState;
  actor: EditableArtifactActor;
  intent: ValidatedEditableArtifactMutationIntent;
  requestHash: EditableArtifactReceipt["requestHash"];
  intentBytes: Uint8Array;
}>;

export type ApplyAuthoritativeEditableArtifactKernelRequest =
  | (ApplyAuthoritativeEditableArtifactKernelRequestCommon &
      Readonly<{
        modality: "spreadsheet";
        /** Authored base plus the exact resolved predecessor transaction stamp. */
        resolvedCausalBase: EditableArtifactCausalFrontier;
        resolvedUndoTargets: readonly EditableArtifactOperationRecord[];
      }>)
  | (ApplyAuthoritativeEditableArtifactKernelRequestCommon &
      Readonly<{ modality: "document" | "presentation" }>);

export type ApplyAuthoritativeEditableArtifactKernelResult =
  | Readonly<{
      modality: "spreadsheet";
      /** Exact canonical OGACO bytes returned by the authoritative native kernel. */
      committedTransactionBytes: Uint8Array;
      kernelVersion: string;
      modelSchemaVersion: number;
    }>
  | Readonly<{
      modality: "document" | "presentation";
      /** Exact canonical OGADR/OGAPR receipt returned by the native kernel. */
      nativeReceiptBytes: Uint8Array;
      resultingStateHash: EditableArtifactStateHash;
      kernelVersion: string;
      modelSchemaVersion: number;
    }>;

/**
 * The only port allowed to turn untrusted commands into canonical operations.
 * API/client adapters must never construct operation bytes themselves.
 */
export interface AuthoritativeEditableArtifactKernelPort {
  /**
   * Must be side-effect free. Optimistic concurrency may discard a result and
   * invoke the kernel again against a newer authoritative basis.
   */
  applyTransaction(
    request: ApplyAuthoritativeEditableArtifactKernelRequest,
  ): Promise<ApplyAuthoritativeEditableArtifactKernelResult>;
}

/** Trusted adapter over the one shared OGATX001 decoder/hash verifier. */
export interface EditableArtifactMutationIntentCodecPort {
  /** Decode canonical bytes and throw request_hash_mismatch unless the exact digest matches. */
  decodeAndVerify(
    input: Readonly<{
      intentBytes: Uint8Array;
      requestHash: EditableArtifactReceipt["requestHash"];
    }>,
  ): Promise<EditableArtifactMutationIntent>;
}

/**
 * Verifies the immutable blob itself before metadata can become the replay
 * base: size/hash, canonical decode, embedded boundary, kernel/schema/protocol,
 * and reconstructed state hash. `blobReference` must address immutable bytes.
 */
export interface EditableArtifactSnapshotVerifierPort {
  verify(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      actor: EditableArtifactActor;
      snapshot: PublishEditableArtifactSnapshotRequest;
    }>,
  ): Promise<void>;
}

/**
 * Trusted server-side genesis pipeline. It asks the authoritative kernel for
 * the canonical empty model and uploads those exact bytes to immutable object
 * storage. The service still verifies the returned object before publication.
 */
export interface EditableArtifactGenesisPort {
  prepare(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifactId;
    snapshotId: EditableArtifactSnapshotId;
    modality: EditableArtifactModality;
    signal?: AbortSignal;
  }): Promise<PublishEditableArtifactSnapshotRequest>;
}

/** Trusted native reconstruction + immutable upload used only for state-neutral maintenance. */
export interface EditableArtifactCompactionPort {
  prepare(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifactId;
    snapshotId: EditableArtifactSnapshotId;
    state: EditableArtifactKernelState;
    signal?: AbortSignal;
  }): Promise<PublishEditableArtifactSnapshotRequest>;
}

export interface EditableArtifactClockPort {
  now(): Date;
}

export type EditableArtifactStableIdKind =
  | "artifact"
  | "snapshot"
  | "receipt"
  | "outbox"
  | "transaction";

export interface EditableArtifactStableIdFactoryPort {
  next(kind: EditableArtifactStableIdKind): EditableArtifactStableId;
}

export type CreateEditableArtifactStoreRequest = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  /** Rechecked by durable production stores in the creation transaction. */
  authorizationActor: EditableArtifactActor;
  receiptId: EditableArtifactReceipt["receiptId"];
  authorityKey: string;
  idempotencyKey: EditableArtifactClientTransactionId;
  requestHash: EditableArtifactRequestHash;
  /** Scope-create policy head observed by the authorization decision. */
  expectedScopeAuthorizationRevision: number;
  /** Initial per-artifact policy head installed by the successful create. */
  initialArtifactAuthorizationRevision: number;
  modality: EditableArtifactModality;
  title: string;
  createdBySubjectId: string;
  genesisSnapshot: EditableArtifactSnapshotMetadata;
  outbox: EditableArtifactLiveOutboxRecord;
}>;

export type CreateEditableArtifactStoreResult =
  | Readonly<{
      kind: "result";
      value: CreateEditableArtifactResult;
    }>
  | Readonly<{ kind: "authorization_stale" }>;

export type AdvanceEditableArtifactScopeAuthorizationRevisionResult = Readonly<{
  applied: boolean;
  authorizationRevision: number;
}>;

/**
 * Local durable create-policy head. Authorization adapters read this revision
 * while evaluating `create`; invalidation advances it transactionally. This
 * is separate from the per-artifact head because an artifact row does not yet
 * exist while its genesis model is being prepared.
 */
export interface EditableArtifactScopeAuthorizationRevisionPort {
  readScopeCreateAuthorizationRevision(scope: EditableArtifactScope): Promise<number>;
  advanceScopeCreateAuthorizationRevision(
    scope: EditableArtifactScope,
    expectedRevision: number,
    nextRevision: number,
  ): Promise<AdvanceEditableArtifactScopeAuthorizationRevisionResult>;
}

export type AdvanceEditableArtifactAuthorizationRevisionResult = Readonly<{
  applied: boolean;
  authorizationRevision: number;
}>;

export type ReadEditableArtifactAtAuthorizationRevisionResult =
  | Readonly<{ kind: "result"; artifact: EditableArtifact | null }>
  | Readonly<{ kind: "authorization_stale" }>;

/** Separate policy/invalidation capability; ordinary mutation code never owns it. */
export interface EditableArtifactAuthorizationRevisionPort {
  advanceAuthorizationRevision(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    expectedRevision: number,
    nextRevision: number,
  ): Promise<AdvanceEditableArtifactAuthorizationRevisionResult>;
}

export type CommitAppliedEditableArtifactTransaction = Readonly<{
  expectedHeadSequence: number;
  serverTransactionId: EditableArtifactTransactionId;
  receipt: EditableArtifactReceipt;
  committedTransaction: EditableArtifactCommittedTransactionRecord;
  operations: readonly EditableArtifactOperationRecord[];
  outbox: EditableArtifactLiveOutboxRecord;
}>;

export type ReadEditableArtifactTransactionBasisRequest = Readonly<{
  actorKey: string;
  clientTransactionId: EditableArtifactReceipt["clientTransactionId"];
  previousLocalTransactionId: EditableArtifactReceipt["previousLocalTransactionId"];
  selectiveUndoOperationIds: readonly EditableArtifactOperationId[];
}>;

export type EditableArtifactTransactionUndoBasis = Readonly<{
  operationId: EditableArtifactOperationId;
  operation: EditableArtifactOperationRecord | null;
  claimedBy: EditableArtifactTransactionId | null;
}>;

/**
 * One detached, internally consistent read view. Implementations must copy all
 * mutable byte buffers before returning; the kernel may retain this value
 * after the database read transaction has closed.
 */
export type EditableArtifactTransactionBasis =
  | Readonly<{
      /** Indexed fast path; callers decide replay versus hash collision. */
      kind: "existing";
      receipt: EditableArtifactReceipt;
    }>
  | Readonly<{
      kind: "basis";
      artifact: EditableArtifact;
      predecessor: EditableArtifactReceipt | null;
      undoTargets: readonly EditableArtifactTransactionUndoBasis[];
      kernelState: EditableArtifactKernelState;
    }>;

export type ExpectedEditableArtifactPredecessor = Readonly<{
  receiptId: EditableArtifactReceipt["receiptId"];
  serverTransactionId: EditableArtifactTransactionId;
  actorKey: string;
  clientTransactionId: EditableArtifactReceipt["clientTransactionId"];
  replicaId: EditableArtifactReceipt["replicaId"];
  replicaCounter: number;
}>;

export type TryCommitAppliedEditableArtifactTransactionRequest =
  CommitAppliedEditableArtifactTransaction &
    Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      expectedLifecycle: "active";
      expectedAuthorizationRevision: number;
      /** Rechecked by durable production stores in the commit transaction. */
      authorizationActor: EditableArtifactActor;
      actorKey: string;
      clientTransactionId: EditableArtifactReceipt["clientTransactionId"];
      requestHash: EditableArtifactReceipt["requestHash"];
      expectedPredecessor: ExpectedEditableArtifactPredecessor | null;
      expectedUnclaimedUndoTargets: readonly EditableArtifactOperationId[];
    }>;

export type TryCommitAppliedEditableArtifactTransactionResult =
  | Readonly<{ kind: "committed"; receipt: EditableArtifactReceipt }>
  | Readonly<{ kind: "replayed"; receipt: EditableArtifactReceipt }>
  | Readonly<{ kind: "stale" }>;

export type CommitEditableArtifactSnapshot = Readonly<{
  expectedCurrentSnapshotId: EditableArtifactSnapshotId | null;
  expectedAuthorizationRevision: number;
  /** Rechecked by durable production stores in the publication transaction. */
  authorizationActor: EditableArtifactActor;
  /** Public publication requires manage; trusted state-neutral maintenance uses caller authority. */
  authorizationPermission?: "manage" | "read" | "edit";
  snapshot: EditableArtifactSnapshotMetadata;
  outbox: EditableArtifactLiveOutboxRecord;
}>;

export type CommitEditableArtifactSnapshotResult =
  | Readonly<{ kind: "committed" }>
  | Readonly<{ kind: "authorization_stale" }>;

/**
 * Narrow snapshot-metadata transaction. Mutation history and kernel execution
 * are deliberately absent so they cannot drift back under a database lock.
 */
export interface EditableArtifactSnapshotUnitOfWorkPort {
  artifact(): EditableArtifact;
  checkpoint(headSequence: number): Promise<EditableArtifactSequenceCheckpoint | null>;
  findSnapshot(
    snapshotId: EditableArtifactSnapshotId,
  ): Promise<EditableArtifactSnapshotMetadata | null>;
  commitSnapshot(
    input: CommitEditableArtifactSnapshot,
  ): Promise<CommitEditableArtifactSnapshotResult>;
}

export type ClaimEditableArtifactLiveOutboxRequest = Readonly<{
  owner: string;
  leaseDurationMs: number;
  limit: number;
}>;

export interface EditableArtifactStorePort {
  /** Read-only idempotency fast path; `createArtifact` remains authoritative. */
  findArtifactCreation(
    scope: EditableArtifactScope,
    authorityKey: string,
    idempotencyKey: EditableArtifactClientTransactionId,
  ): Promise<CreateEditableArtifactResult | null>;
  createArtifact(
    request: CreateEditableArtifactStoreRequest,
  ): Promise<CreateEditableArtifactStoreResult>;
  /** One tenant-scoped read atomically fenced by the local policy revision. */
  readArtifactAtAuthorizationRevision(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    expectedAuthorizationRevision: number,
  ): Promise<ReadEditableArtifactAtAuthorizationRevisionResult>;
  /** Short consistent read; no write lock may remain held after it resolves. */
  readTransactionBasis(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    request: ReadEditableArtifactTransactionBasisRequest,
  ): Promise<EditableArtifactTransactionBasis>;
  /** Detached exact-head replay basis, fenced by the authorization revision observed by core. */
  readSnapshotCompactionBasis(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    expectedAuthorizationRevision: number,
  ): Promise<
    | Readonly<{ kind: "basis"; state: EditableArtifactKernelState }>
    | Readonly<{ kind: "authorization_stale" }>
  >;
  /**
   * Short atomic commit. Check idempotency before the head CAS. Return stale
   * when any read precondition changed; never partially persist the candidate.
   */
  tryCommitAppliedTransaction(
    request: TryCommitAppliedEditableArtifactTransactionRequest,
  ): Promise<TryCommitAppliedEditableArtifactTransactionResult>;
  /** Snapshot metadata publication remains the only lock-scoped callback. */
  withSnapshotPublicationLock<T>(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    callback: (unitOfWork: EditableArtifactSnapshotUnitOfWorkPort) => Promise<T>,
  ): Promise<T>;
  claimLiveOutbox(
    request: ClaimEditableArtifactLiveOutboxRequest,
  ): Promise<readonly EditableArtifactLiveOutboxRecord[]>;
  markLiveOutboxPublished(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    /** Fences a stale attempt even when one worker identity is reused. */
    attemptCount: number;
  }): Promise<void>;
  releaseLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
  }): Promise<void>;
  renewLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    leaseDurationMs: number;
  }): Promise<void>;
  retryLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    retryDelayMs: number;
    errorCode: EditableArtifactOutboxRetryFailureCode;
  }): Promise<void>;
  deadLetterLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    errorCode: EditableArtifactOutboxDeadLetterFailureCode;
  }): Promise<void>;
}
