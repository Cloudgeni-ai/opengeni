import {
  EditableArtifactIdempotencyConflictError,
  EditableArtifactNotFoundError,
  EditableArtifactOutboxLeaseConflictError,
} from "./errors";
import { decodeCommittedTransactionSummary } from "@opengeni/contracts/editable-artifact-committed-transaction";
import { decodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import type {
  ClaimEditableArtifactLiveOutboxRequest,
  CommitAppliedEditableArtifactTransaction,
  CommitEditableArtifactSnapshot,
  CreateEditableArtifactStoreRequest,
  CreateEditableArtifactStoreResult,
  EditableArtifactAuthorizationRevisionPort,
  EditableArtifactScopeAuthorizationRevisionPort,
  EditableArtifactClockPort,
  EditableArtifactKernelState,
  EditableArtifactStableIdFactoryPort,
  EditableArtifactStableIdKind,
  EditableArtifactStorePort,
  EditableArtifactTransactionBasis,
  EditableArtifactSnapshotUnitOfWorkPort,
  ReadEditableArtifactTransactionBasisRequest,
  ReadEditableArtifactAtAuthorizationRevisionResult,
  TryCommitAppliedEditableArtifactTransactionRequest,
  TryCommitAppliedEditableArtifactTransactionResult,
} from "./ports";
import {
  assertBoundedArtifactTitle,
  assertIsoTimestamp,
  assertNonnegativeSafeInteger,
  assertPositiveSafeInteger,
  causalFrontiersEqual,
  editableArtifactCausalFrontier,
  editableArtifactClientTransactionId,
  editableArtifactId,
  editableArtifactOperationId,
  editableArtifactOutboxId,
  editableArtifactReceiptId,
  editableArtifactRequestHash,
  editableArtifactScope,
  editableArtifactStateHash,
  type EditableArtifact,
  type CreateEditableArtifactResult,
  type EditableArtifactCreationReceipt,
  type EditableArtifactCommittedTransactionRecord,
  type EditableArtifactId,
  type EditableArtifactLifecycleState,
  type EditableArtifactLiveOutboxRecord,
  type EditableArtifactModality,
  type EditableArtifactOperationId,
  type EditableArtifactOperationRecord,
  type EditableArtifactOutboxId,
  type EditableArtifactOutboxRetryFailureCode,
  type EditableArtifactOutboxDeadLetterFailureCode,
  type EditableArtifactReceipt,
  type EditableArtifactScope,
  type EditableArtifactSequenceCheckpoint,
  type EditableArtifactSnapshotId,
  type EditableArtifactSnapshotMetadata,
  type EditableArtifactStableId,
  type EditableArtifactStateHash,
  type EditableArtifactSpreadsheetCommittedTransactionRecord,
  type EditableArtifactSerializedCommittedTransactionRecord,
  type EditableArtifactSerializedSnapshotMetadata,
  type EditableArtifactSpreadsheetSnapshotMetadata,
  type EditableArtifactTransactionId,
} from "./types";

type ArtifactAggregate = {
  artifact: EditableArtifact;
  receipts: Map<string, EditableArtifactReceipt>;
  transactions: Map<EditableArtifactTransactionId, EditableArtifactReceipt>;
  committedTransactions: Map<
    EditableArtifactTransactionId,
    EditableArtifactCommittedTransactionRecord
  >;
  operations: Map<EditableArtifactOperationId, EditableArtifactOperationRecord>;
  undoClaims: Map<EditableArtifactOperationId, EditableArtifactTransactionId>;
  snapshots: Map<EditableArtifactSnapshotId, EditableArtifactSnapshotMetadata>;
  checkpoints: Map<number, EditableArtifactSequenceCheckpoint>;
  outbox: Map<EditableArtifactOutboxId, EditableArtifactLiveOutboxRecord>;
};

export type SeedInMemoryEditableArtifact = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  title: string;
  stateHash: EditableArtifactStateHash;
  lifecycle?: EditableArtifactLifecycleState;
  authorizationRevision?: number;
  /** Authoritative native revision for a pre-existing serialized artifact. */
  nativeRevision?: number;
  createdAt?: string;
}>;

/**
 * Executable correctness reference for tests. It deliberately serializes and
 * copies aggregate history; production runtimes must use the PostgreSQL CAS
 * adapter rather than treating this O(history) store as a performance model.
 */
export class InMemoryEditableArtifactStore
  implements
    EditableArtifactStorePort,
    EditableArtifactAuthorizationRevisionPort,
    EditableArtifactScopeAuthorizationRevisionPort
{
  private aggregates = new Map<string, ArtifactAggregate>();
  private creationReceipts = new Map<string, EditableArtifactCreationReceipt>();
  private scopeCreateAuthorizationRevisions = new Map<string, number>();
  private exclusiveTail: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async findArtifactCreation(
    scopeInput: EditableArtifactScope,
    operationKind: "create" | "import",
    authorityKey: string,
    idempotencyKeyInput: string,
  ): Promise<CreateEditableArtifactResult | null> {
    const scope = editableArtifactScope(scopeInput);
    const idempotencyKey = editableArtifactClientTransactionId(idempotencyKeyInput);
    const key = creationReceiptKey(scope, operationKind, authorityKey, idempotencyKey);
    return this.exclusive(async () => {
      const receipt = this.creationReceipts.get(key);
      if (!receipt) return null;
      const aggregate = this.aggregates.get(aggregateKey(scope, receipt.artifactId));
      const snapshot = aggregate?.snapshots.get(receipt.genesisSnapshotId);
      if (!aggregate || !snapshot) {
        throw new Error("Artifact creation receipt is corrupt");
      }
      return Object.freeze({
        artifact: cloneArtifact(aggregate.artifact),
        genesisSnapshot: cloneSnapshot(snapshot),
        creationReceipt: cloneCreationReceipt(receipt),
        replayed: true,
      });
    });
  }

  async createArtifact(
    input: CreateEditableArtifactStoreRequest,
  ): Promise<CreateEditableArtifactStoreResult> {
    const scope = editableArtifactScope(input.scope);
    const artifactId = editableArtifactId(input.artifactId);
    const receiptId = editableArtifactReceiptId(input.receiptId);
    const idempotencyKey = editableArtifactClientTransactionId(input.idempotencyKey);
    const requestHash = editableArtifactRequestHash(input.requestHash);
    if (input.operationKind !== "create" && input.operationKind !== "import") {
      throw new TypeError("Unknown editable artifact origin operation");
    }
    if ((input.operationKind === "import") !== Boolean(input.originalImport)) {
      throw new TypeError("Editable artifact import source does not match its origin operation");
    }
    assertBoundedArtifactTitle(input.title);
    assertPositiveSafeInteger(
      input.expectedScopeAuthorizationRevision,
      "expected scope create authorization revision",
    );
    assertPositiveSafeInteger(
      input.initialArtifactAuthorizationRevision,
      "initial artifact authorization revision",
    );
    const genesisSnapshot = cloneSnapshot(input.genesisSnapshot);
    const outbox = cloneOutbox(input.outbox);
    assertGenesisCreateRequest(
      scope,
      artifactId,
      input.operationKind,
      genesisSnapshot,
      outbox,
    );
    if (!(["spreadsheet", "presentation", "document"] as const).includes(input.modality)) {
      throw new TypeError("Unknown editable artifact modality");
    }
    if (genesisSnapshot.modality !== input.modality) {
      throw new TypeError("Genesis snapshot modality does not match artifact modality");
    }
    const creationKey = creationReceiptKey(
      scope,
      input.operationKind,
      input.authorityKey,
      idempotencyKey,
    );
    return this.exclusive(async () => {
      const prior = this.creationReceipts.get(creationKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new EditableArtifactIdempotencyConflictError();
        }
        const replay = this.aggregates.get(aggregateKey(scope, prior.artifactId));
        if (!replay) throw new Error("Artifact creation receipt is corrupt");
        const replaySnapshot = replay.snapshots.get(prior.genesisSnapshotId);
        if (!replaySnapshot) {
          throw new Error("Artifact creation receipt has no genesis snapshot");
        }
        return Object.freeze({
          kind: "result" as const,
          value: Object.freeze({
            artifact: cloneArtifact(replay.artifact),
            genesisSnapshot: cloneSnapshot(replaySnapshot),
            creationReceipt: cloneCreationReceipt(prior),
            replayed: true,
          }),
        });
      }
      const scopeKey = authorizationScopeKey(scope);
      const currentScopeRevision = this.scopeCreateAuthorizationRevisions.get(scopeKey) ?? 1;
      if (currentScopeRevision !== input.expectedScopeAuthorizationRevision) {
        return Object.freeze({ kind: "authorization_stale" as const });
      }
      const key = aggregateKey(scope, artifactId);
      if (this.aggregates.has(key)) {
        throw new Error("Editable artifact identity already exists");
      }
      const commonArtifact = {
        scope,
        id: artifactId,
        title: input.title,
        lifecycle: "active",
        authorizationRevision: input.initialArtifactAuthorizationRevision,
        headSequence: 0,
        stateHash: genesisSnapshot.stateHash,
        currentSnapshotId: genesisSnapshot.snapshotId,
        createdAt: genesisSnapshot.publishedAt,
        updatedAt: genesisSnapshot.publishedAt,
      } as const;
      const artifact: EditableArtifact =
        input.modality === "spreadsheet"
          ? {
              ...commonArtifact,
              modality: "spreadsheet",
              causalFrontier: editableArtifactCausalFrontier(
                genesisSnapshot.modality === "spreadsheet"
                  ? genesisSnapshot.coveredCausalFrontier
                  : [],
              ),
            }
          : { ...commonArtifact, modality: input.modality };
      const creationReceipt: EditableArtifactCreationReceipt = Object.freeze({
        receiptId,
        scope,
        artifactId,
        operationKind: input.operationKind,
        authorityKey: input.authorityKey,
        idempotencyKey,
        requestHash,
        genesisSnapshotId: genesisSnapshot.snapshotId,
        createdAt: genesisSnapshot.publishedAt,
      });
      this.aggregates.set(key, emptyAggregate(artifact, genesisSnapshot, outbox));
      this.creationReceipts.set(creationKey, creationReceipt);
      return Object.freeze({
        kind: "result" as const,
        value: Object.freeze({
          artifact: cloneArtifact(artifact),
          genesisSnapshot: cloneSnapshot(genesisSnapshot),
          creationReceipt: cloneCreationReceipt(creationReceipt),
          replayed: false,
        }),
      });
    });
  }

  async readScopeCreateAuthorizationRevision(scope: EditableArtifactScope): Promise<number> {
    const key = authorizationScopeKey(editableArtifactScope(scope));
    return this.exclusive(async () => {
      const revision = this.scopeCreateAuthorizationRevisions.get(key) ?? 1;
      this.scopeCreateAuthorizationRevisions.set(key, revision);
      return revision;
    });
  }

  async advanceScopeCreateAuthorizationRevision(
    scope: EditableArtifactScope,
    expectedRevision: number,
    nextRevision: number,
  ): Promise<Readonly<{ applied: boolean; authorizationRevision: number }>> {
    assertPositiveSafeInteger(expectedRevision, "expected scope create authorization revision");
    assertPositiveSafeInteger(nextRevision, "next scope create authorization revision");
    if (nextRevision <= expectedRevision) {
      throw new TypeError(
        "Next scope create authorization revision must exceed the expected revision",
      );
    }
    const key = authorizationScopeKey(editableArtifactScope(scope));
    return this.exclusive(async () => {
      const current = this.scopeCreateAuthorizationRevisions.get(key) ?? 1;
      if (current !== expectedRevision) {
        return Object.freeze({
          applied: false,
          authorizationRevision: current,
        });
      }
      this.scopeCreateAuthorizationRevisions.set(key, nextRevision);
      return Object.freeze({
        applied: true,
        authorizationRevision: nextRevision,
      });
    });
  }

  async seedArtifact(input: SeedInMemoryEditableArtifact): Promise<EditableArtifact> {
    const scope = editableArtifactScope(input.scope);
    const artifactId = editableArtifactId(input.artifactId);
    assertBoundedArtifactTitle(input.title);
    const stateHash = editableArtifactStateHash(input.stateHash);
    const createdAt = input.createdAt ?? new Date(0).toISOString();
    assertIsoTimestamp(createdAt, "artifact creation timestamp");
    if (!(["spreadsheet", "presentation", "document"] as const).includes(input.modality)) {
      throw new TypeError("Unknown editable artifact modality");
    }
    const lifecycle = input.lifecycle ?? "active";
    if (lifecycle !== "active" && lifecycle !== "archived") {
      throw new TypeError("Unknown editable artifact lifecycle state");
    }
    const authorizationRevision = input.authorizationRevision ?? 1;
    assertPositiveSafeInteger(authorizationRevision, "artifact authorization revision");
    const title = input.title;
    const modality = input.modality;
    const nativeRevision = input.nativeRevision ?? 0;
    assertNonnegativeSafeInteger(nativeRevision, "artifact native revision");
    return this.exclusive(async () => {
      const key = aggregateKey(scope, artifactId);
      if (this.aggregates.has(key)) throw new Error("Editable artifact is already seeded");
      const commonArtifact = {
        scope,
        id: artifactId,
        title,
        lifecycle,
        authorizationRevision,
        headSequence: 0,
        stateHash,
        currentSnapshotId: null,
        createdAt,
        updatedAt: createdAt,
      } as const;
      const artifact: EditableArtifact =
        modality === "spreadsheet"
          ? {
              ...commonArtifact,
              modality: "spreadsheet",
              causalFrontier: editableArtifactCausalFrontier([]),
            }
          : { ...commonArtifact, modality };
      this.aggregates.set(key, {
        artifact,
        receipts: new Map(),
        transactions: new Map(),
        committedTransactions: new Map(),
        operations: new Map(),
        undoClaims: new Map(),
        snapshots: new Map(),
        checkpoints: new Map([[0, checkpointAtGenesis(artifact, nativeRevision)]]),
        outbox: new Map(),
      });
      return cloneArtifact(artifact);
    });
  }

  async getArtifact(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
  ): Promise<EditableArtifact | null> {
    const key = aggregateKey(editableArtifactScope(scope), editableArtifactId(artifactId));
    return this.exclusive(async () => {
      const aggregate = this.aggregates.get(key);
      return aggregate ? cloneArtifact(aggregate.artifact) : null;
    });
  }

  async readArtifactAtAuthorizationRevision(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    expectedAuthorizationRevision: number,
  ): Promise<ReadEditableArtifactAtAuthorizationRevisionResult> {
    assertPositiveSafeInteger(
      expectedAuthorizationRevision,
      "expected artifact authorization revision",
    );
    const key = aggregateKey(editableArtifactScope(scope), editableArtifactId(artifactId));
    return this.exclusive(async () => {
      const aggregate = this.aggregates.get(key);
      if (!aggregate) {
        return Object.freeze({ kind: "result" as const, artifact: null });
      }
      if (aggregate.artifact.authorizationRevision !== expectedAuthorizationRevision) {
        return Object.freeze({ kind: "authorization_stale" as const });
      }
      return Object.freeze({
        kind: "result" as const,
        artifact: cloneArtifact(aggregate.artifact),
      });
    });
  }

  /** Test/admin seam modeling the local policy invalidation transaction. */
  async advanceAuthorizationRevision(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    expectedRevision: number,
    nextRevision: number,
  ): Promise<Readonly<{ applied: boolean; authorizationRevision: number }>> {
    assertPositiveSafeInteger(expectedRevision, "expected artifact authorization revision");
    assertPositiveSafeInteger(nextRevision, "next artifact authorization revision");
    if (nextRevision <= expectedRevision) {
      throw new TypeError("Next artifact authorization revision must exceed the expected revision");
    }
    const key = aggregateKey(editableArtifactScope(scope), editableArtifactId(artifactId));
    return this.exclusive(async () => {
      const aggregate = this.aggregates.get(key);
      if (!aggregate) throw new EditableArtifactNotFoundError();
      if (aggregate.artifact.authorizationRevision !== expectedRevision) {
        return Object.freeze({
          applied: false,
          authorizationRevision: aggregate.artifact.authorizationRevision,
        });
      }
      const updatedAt = authoritativeNow(this.now).toISOString();
      aggregate.artifact = {
        ...aggregate.artifact,
        authorizationRevision: nextRevision,
        updatedAt: laterIsoTimestamp(aggregate.artifact.updatedAt, updatedAt),
      };
      return Object.freeze({
        applied: true,
        authorizationRevision: nextRevision,
      });
    });
  }

  async readTransactionBasis(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    request: ReadEditableArtifactTransactionBasisRequest,
  ): Promise<EditableArtifactTransactionBasis> {
    const normalizedScope = editableArtifactScope(scope);
    const normalizedArtifactId = editableArtifactId(artifactId);
    const key = aggregateKey(normalizedScope, normalizedArtifactId);
    return this.exclusive(async () => {
      const aggregate = this.aggregates.get(key);
      if (!aggregate) throw new EditableArtifactNotFoundError();
      const priorReceipt = aggregate.receipts.get(
        receiptKey(request.actorKey, request.clientTransactionId),
      );
      if (priorReceipt) {
        return Object.freeze({
          kind: "existing",
          receipt: cloneReceipt(priorReceipt),
        });
      }
      const predecessor = request.previousLocalTransactionId
        ? aggregate.receipts.get(receiptKey(request.actorKey, request.previousLocalTransactionId))
        : undefined;
      const undoTargets: Extract<
        EditableArtifactTransactionBasis,
        { kind: "basis" }
      >["undoTargets"] = Object.freeze(
        request.selectiveUndoOperationIds.map((operationId) =>
          Object.freeze({
            operationId,
            operation: aggregate.operations.has(operationId)
              ? cloneOperation(aggregate.operations.get(operationId)!)
              : null,
            claimedBy: aggregate.undoClaims.get(operationId) ?? null,
          }),
        ),
      );
      const kernelState = kernelStateFromAggregate(aggregate);
      return Object.freeze({
        kind: "basis",
        artifact: kernelState.artifact,
        predecessor: predecessor ? cloneReceipt(predecessor) : null,
        undoTargets,
        kernelState,
      });
    });
  }

  async readSnapshotCompactionBasis(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    expectedAuthorizationRevision: number,
  ): Promise<
    | Readonly<{ kind: "basis"; state: EditableArtifactKernelState }>
    | Readonly<{ kind: "authorization_stale" }>
  > {
    const normalizedScope = editableArtifactScope(scope);
    const normalizedArtifactId = editableArtifactId(artifactId);
    const key = aggregateKey(normalizedScope, normalizedArtifactId);
    return this.exclusive(async () => {
      const aggregate = this.aggregates.get(key);
      if (!aggregate) throw new EditableArtifactNotFoundError();
      if (aggregate.artifact.authorizationRevision !== expectedAuthorizationRevision) {
        return Object.freeze({ kind: "authorization_stale" as const });
      }
      return Object.freeze({ kind: "basis" as const, state: kernelStateFromAggregate(aggregate) });
    });
  }

  async tryCommitAppliedTransaction(
    request: TryCommitAppliedEditableArtifactTransactionRequest,
  ): Promise<TryCommitAppliedEditableArtifactTransactionResult> {
    const scope = editableArtifactScope(request.scope);
    const artifactId = editableArtifactId(request.artifactId);
    const key = aggregateKey(scope, artifactId);
    return this.exclusive(async () => {
      const aggregate = this.aggregates.get(key);
      if (!aggregate) throw new EditableArtifactNotFoundError();

      // The idempotency winner is authoritative even when its commit changed
      // the head before this candidate reached the CAS.
      const prior = aggregate.receipts.get(
        receiptKey(request.actorKey, request.clientTransactionId),
      );
      if (prior) {
        if (prior.requestHash !== request.requestHash) {
          throw new EditableArtifactIdempotencyConflictError();
        }
        return Object.freeze({
          kind: "replayed",
          receipt: cloneReceipt(prior),
        });
      }

      const artifact = aggregate.artifact;
      if (
        artifact.lifecycle !== request.expectedLifecycle ||
        artifact.authorizationRevision !== request.expectedAuthorizationRevision ||
        artifact.headSequence !== request.expectedHeadSequence
      ) {
        return Object.freeze({ kind: "stale" });
      }
      if (!sameExpectedPredecessor(aggregate, request.expectedPredecessor)) {
        return Object.freeze({ kind: "stale" });
      }
      if (
        request.expectedUnclaimedUndoTargets.some((operationId) =>
          aggregate.undoClaims.has(operationId),
        )
      ) {
        return Object.freeze({ kind: "stale" });
      }

      const working = cloneAggregate(aggregate);
      commitAppliedTransaction(working, request);
      // No callback can retain `working` on this path; every caller-owned
      // buffer was copied by commitAppliedTransaction.
      this.aggregates.set(key, working);
      return Object.freeze({
        kind: "committed",
        receipt: cloneReceipt(request.receipt),
      });
    });
  }

  async withSnapshotPublicationLock<T>(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    callback: (unitOfWork: EditableArtifactSnapshotUnitOfWorkPort) => Promise<T>,
  ): Promise<T> {
    const key = aggregateKey(editableArtifactScope(scope), editableArtifactId(artifactId));
    return this.exclusive(async () => {
      const aggregate = this.aggregates.get(key);
      if (!aggregate) throw new EditableArtifactNotFoundError();
      const working = cloneAggregate(aggregate);
      const unitOfWork = new InMemoryEditableArtifactSnapshotUnitOfWork(working);
      try {
        const result = await callback(unitOfWork);
        // Never install the aggregate still referenced by the callback's UoW.
        this.aggregates.set(key, cloneAggregate(working));
        return result;
      } finally {
        unitOfWork.close();
      }
    });
  }

  async claimLiveOutbox(
    request: ClaimEditableArtifactLiveOutboxRequest,
  ): Promise<readonly EditableArtifactLiveOutboxRecord[]> {
    assertLeaseRequest(request);
    const owner = request.owner;
    const leaseDurationMs = request.leaseDurationMs;
    const limit = request.limit;
    return this.exclusive(async () => {
      const nowMs = authoritativeNow(this.now).getTime();
      const eligible = [...this.aggregates.values()]
        .flatMap((aggregate) =>
          [...aggregate.outbox.values()].map((record) => ({
            aggregate,
            record,
          })),
        )
        .filter(({ record }) => {
          if (record.state === "pending") {
            return new Date(record.nextAttemptAt).getTime() <= nowMs;
          }
          if (record.state !== "publishing" || !record.leaseExpiresAt) return false;
          return new Date(record.leaseExpiresAt).getTime() <= nowMs;
        })
        .sort(
          (left, right) =>
            compareText(left.record.createdAt, right.record.createdAt) ||
            compareText(left.record.outboxId, right.record.outboxId),
        )
        .slice(0, limit);
      const leaseExpiresAt = new Date(nowMs + leaseDurationMs).toISOString();
      return Object.freeze(
        eligible.map(({ aggregate, record }) => {
          if (record.attemptCount >= Number.MAX_SAFE_INTEGER) {
            throw new Error("Editable artifact outbox attempt counter exhausted");
          }
          const claimed: EditableArtifactLiveOutboxRecord = {
            ...record,
            state: "publishing",
            attemptCount: record.attemptCount + 1,
            leaseOwner: owner,
            leaseExpiresAt,
          };
          aggregate.outbox.set(record.outboxId, claimed);
          return cloneOutbox(claimed);
        }),
      );
    });
  }

  async markLiveOutboxPublished(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
  }): Promise<void> {
    const outboxId = editableArtifactOutboxId(input.outboxId);
    const owner = assertLeaseOwner(input.owner);
    assertPositiveSafeInteger(input.attemptCount, "outbox attempt count");
    await this.exclusive(async () => {
      const publishedAt = authoritativeNow(this.now);
      const publishedAtMs = publishedAt.getTime();
      const publishedAtIso = publishedAt.toISOString();
      const located = this.findOutbox(outboxId);
      if (!located) throw new EditableArtifactOutboxLeaseConflictError();
      const record = located.record;
      if (record.state === "published") {
        if (record.attemptCount === input.attemptCount) return;
        throw new EditableArtifactOutboxLeaseConflictError();
      }
      if (
        record.state !== "publishing" ||
        record.leaseOwner !== owner ||
        record.attemptCount !== input.attemptCount ||
        !record.leaseExpiresAt ||
        publishedAtMs >= new Date(record.leaseExpiresAt).getTime()
      ) {
        throw new EditableArtifactOutboxLeaseConflictError();
      }
      located.aggregate.outbox.set(outboxId, {
        ...record,
        state: "published",
        leaseOwner: null,
        leaseExpiresAt: null,
        publishedAt: publishedAtIso,
      });
    });
  }

  async releaseLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
  }): Promise<void> {
    const outboxId = editableArtifactOutboxId(input.outboxId);
    const owner = assertLeaseOwner(input.owner);
    assertPositiveSafeInteger(input.attemptCount, "outbox attempt count");
    await this.exclusive(async () => {
      const releasedAt = authoritativeNow(this.now).toISOString();
      const located = this.findOutbox(outboxId);
      if (!located) throw new EditableArtifactOutboxLeaseConflictError();
      if (
        (located.record.state === "published" ||
          (located.record.state === "pending" &&
            located.record.leaseOwner === null &&
            located.record.leaseExpiresAt === null)) &&
        located.record.attemptCount === input.attemptCount
      ) {
        return;
      }
      if (
        located.record.state !== "publishing" ||
        located.record.leaseOwner !== owner ||
        located.record.attemptCount !== input.attemptCount
      ) {
        throw new EditableArtifactOutboxLeaseConflictError();
      }
      located.aggregate.outbox.set(outboxId, {
        ...located.record,
        state: "pending",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: releasedAt,
      });
    });
  }

  async renewLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    leaseDurationMs: number;
  }): Promise<void> {
    const outboxId = editableArtifactOutboxId(input.outboxId);
    const owner = assertLeaseOwner(input.owner);
    assertPositiveSafeInteger(input.attemptCount, "outbox attempt count");
    assertLeaseDuration(input.leaseDurationMs);
    await this.exclusive(async () => {
      const nowMs = authoritativeNow(this.now).getTime();
      const located = this.findOutbox(outboxId);
      if (!located) throw new EditableArtifactOutboxLeaseConflictError();
      assertActiveOutboxLease(located.record, owner, input.attemptCount, nowMs);
      located.aggregate.outbox.set(outboxId, {
        ...located.record,
        leaseExpiresAt: new Date(nowMs + input.leaseDurationMs).toISOString(),
      });
    });
  }

  async retryLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    retryDelayMs: number;
    errorCode: EditableArtifactOutboxRetryFailureCode;
  }): Promise<void> {
    const outboxId = editableArtifactOutboxId(input.outboxId);
    const owner = assertLeaseOwner(input.owner);
    assertPositiveSafeInteger(input.attemptCount, "outbox attempt count");
    assertRetryDelay(input.retryDelayMs);
    assertRetryErrorCode(input.errorCode);
    await this.exclusive(async () => {
      const nowMs = authoritativeNow(this.now).getTime();
      const located = this.findOutbox(outboxId);
      if (!located) throw new EditableArtifactOutboxLeaseConflictError();
      const record = located.record;
      if (
        record.state === "pending" &&
        record.attemptCount === input.attemptCount &&
        record.leaseOwner === null &&
        record.leaseExpiresAt === null &&
        record.lastErrorCode === input.errorCode
      ) {
        return;
      }
      assertActiveOutboxLease(record, owner, input.attemptCount, nowMs);
      located.aggregate.outbox.set(outboxId, {
        ...record,
        state: "pending",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(nowMs + input.retryDelayMs).toISOString(),
        lastErrorCode: input.errorCode,
      });
    });
  }

  async deadLetterLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    errorCode: EditableArtifactOutboxDeadLetterFailureCode;
  }): Promise<void> {
    const outboxId = editableArtifactOutboxId(input.outboxId);
    const owner = assertLeaseOwner(input.owner);
    assertPositiveSafeInteger(input.attemptCount, "outbox attempt count");
    assertDeadLetterErrorCode(input.errorCode);
    await this.exclusive(async () => {
      const now = authoritativeNow(this.now);
      const nowMs = now.getTime();
      const located = this.findOutbox(outboxId);
      if (!located) throw new EditableArtifactOutboxLeaseConflictError();
      const record = located.record;
      if (
        record.state === "dead_lettered" &&
        record.attemptCount === input.attemptCount &&
        record.leaseOwner === null &&
        record.leaseExpiresAt === null &&
        record.lastErrorCode === input.errorCode
      ) {
        return;
      }
      assertActiveOutboxLease(record, owner, input.attemptCount, nowMs);
      located.aggregate.outbox.set(outboxId, {
        ...record,
        state: "dead_lettered",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: input.errorCode,
        deadLetteredAt: now.toISOString(),
      });
    });
  }

  async listReceipts(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
  ): Promise<readonly EditableArtifactReceipt[]> {
    return this.inspectAggregate(scope, artifactId, (aggregate) =>
      Object.freeze(
        [...aggregate.transactions.values()]
          .sort((left, right) => left.sequenceStart - right.sequenceStart)
          .map(cloneReceipt),
      ),
    );
  }

  async listOperations(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
  ): Promise<readonly EditableArtifactOperationRecord[]> {
    return this.inspectAggregate(scope, artifactId, (aggregate) =>
      Object.freeze(
        [...aggregate.operations.values()]
          .sort((left, right) => left.sequence - right.sequence)
          .map(cloneOperation),
      ),
    );
  }

  async listCommittedTransactions(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
  ): Promise<readonly EditableArtifactCommittedTransactionRecord[]> {
    return this.inspectAggregate(scope, artifactId, (aggregate) =>
      Object.freeze(
        [...aggregate.committedTransactions.values()]
          .sort((left, right) => left.sequenceStart - right.sequenceStart)
          .map(cloneCommittedTransaction),
      ),
    );
  }

  async listSnapshots(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
  ): Promise<readonly EditableArtifactSnapshotMetadata[]> {
    return this.inspectAggregate(scope, artifactId, (aggregate) =>
      Object.freeze(
        [...aggregate.snapshots.values()]
          .sort((left, right) => left.coveredHeadSequence - right.coveredHeadSequence)
          .map(cloneSnapshot),
      ),
    );
  }

  async listOutbox(): Promise<readonly EditableArtifactLiveOutboxRecord[]> {
    return this.exclusive(async () =>
      Object.freeze(
        [...this.aggregates.values()]
          .flatMap((aggregate) => [...aggregate.outbox.values()])
          .sort(
            (left, right) =>
              compareText(left.createdAt, right.createdAt) ||
              compareText(left.outboxId, right.outboxId),
          )
          .map(cloneOutbox),
      ),
    );
  }

  private async inspectAggregate<T>(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
    inspect: (aggregate: ArtifactAggregate) => T,
  ): Promise<T> {
    const key = aggregateKey(editableArtifactScope(scope), editableArtifactId(artifactId));
    return this.exclusive(async () => {
      const aggregate = this.aggregates.get(key);
      if (!aggregate) throw new EditableArtifactNotFoundError();
      return inspect(aggregate);
    });
  }

  private findOutbox(
    outboxId: EditableArtifactOutboxId,
  ): { aggregate: ArtifactAggregate; record: EditableArtifactLiveOutboxRecord } | undefined {
    for (const aggregate of this.aggregates.values()) {
      const record = aggregate.outbox.get(outboxId);
      if (record) return { aggregate, record };
    }
    return undefined;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function commitAppliedTransaction(
  aggregate: ArtifactAggregate,
  input: CommitAppliedEditableArtifactTransaction,
): void {
  const artifact = aggregate.artifact;
  if (input.expectedHeadSequence !== artifact.headSequence) {
    throw new Error("In-memory artifact head changed before its CAS commit");
  }
  if (
    input.receipt.modality !== artifact.modality ||
    input.committedTransaction.modality !== artifact.modality ||
    input.receipt.sequenceStart !== artifact.headSequence + 1
  ) {
    throw new Error("Committed transaction modality or interval is invalid");
  }
  if (
    input.receipt.serverTransactionId !== input.serverTransactionId ||
    input.operations.some(
      (operation, index) =>
        operation.serverTransactionId !== input.serverTransactionId ||
        operation.sequence !== input.receipt.sequenceStart + index,
    )
  ) {
    throw new Error("Committed operations are not bound to the transaction interval");
  }
  const committed = input.committedTransaction;
  if (
    committed.serverTransactionId !== input.serverTransactionId ||
    committed.scope.accountId !== artifact.scope.accountId ||
    committed.scope.workspaceId !== artifact.scope.workspaceId ||
    committed.artifactId !== artifact.id ||
    committed.requestHash !== input.receipt.requestHash ||
    committed.sequenceStart !== input.receipt.sequenceStart ||
    committed.sequenceEnd !== input.receipt.sequenceEnd ||
    committed.priorStateHash !== artifact.stateHash ||
    committed.stateHash !== input.receipt.stateHash ||
    !(committed.committedTransactionBytes instanceof Uint8Array) ||
    committed.committedTransactionBytes.byteLength < 1
  ) {
    throw new Error("Canonical committed transaction disagrees with its receipt");
  }
  if (
    input.outbox.event.kind !== "transaction_committed" ||
    input.outbox.event.modality !== artifact.modality ||
    input.outbox.event.serverTransactionId !== input.serverTransactionId ||
    input.outbox.event.sequenceStart !== input.receipt.sequenceStart ||
    input.outbox.event.sequenceEnd !== input.receipt.sequenceEnd ||
    input.outbox.event.stateHash !== input.receipt.stateHash
  ) {
    throw new Error("Transaction outbox projection is inconsistent");
  }
  if (artifact.modality === "spreadsheet") {
    if (
      input.receipt.modality !== "spreadsheet" ||
      committed.modality !== "spreadsheet" ||
      input.outbox.event.modality !== "spreadsheet" ||
      input.operations.length !== input.receipt.operationCount ||
      input.receipt.sequenceEnd !== artifact.headSequence + input.operations.length ||
      committed.operationIds.length !== input.operations.length ||
      committed.operationIds.some(
        (operationId, index) => operationId !== input.operations[index]?.operationId,
      ) ||
      !causalFrontiersEqual(
        committed.resultingCausalFrontier,
        input.receipt.resultingCausalFrontier,
      ) ||
      input.outbox.event.operationProtocolVersion !== input.receipt.operationProtocolVersion
    ) {
      throw new Error("Spreadsheet commit disagrees with its CRDT receipt");
    }
    const summary = decodeCommittedTransactionSummary(committed.committedTransactionBytes);
    if (
      summary.transactionId !== input.serverTransactionId ||
      summary.priorStateHash !== committed.priorStateHash ||
      summary.stateHash !== committed.stateHash ||
      summary.operationIds.length !== committed.operationIds.length
    ) {
      throw new Error("Spreadsheet OGACO metadata disagrees with its record");
    }
  } else {
    if (
      input.receipt.modality !== artifact.modality ||
      committed.modality !== artifact.modality ||
      input.outbox.event.modality !== artifact.modality ||
      input.operations.length !== 0 ||
      input.receipt.sequenceEnd !== input.receipt.sequenceStart ||
      committed.sequenceEnd !== committed.sequenceStart ||
      input.receipt.commitProtocolVersion !== committed.commitProtocolVersion ||
      input.receipt.priorNativeRevision !== committed.priorNativeRevision ||
      input.receipt.nativeRevision !== committed.nativeRevision ||
      input.receipt.commandCount !== committed.commandCount ||
      input.outbox.event.commitProtocolVersion !== input.receipt.commitProtocolVersion
    ) {
      throw new Error("Serialized commit disagrees with its authoritative receipt");
    }
    const summary = decodeEditableArtifactSerializedCommit(
      committed.committedTransactionBytes,
      artifact.modality,
    );
    if (
      summary.transactionId !== input.serverTransactionId ||
      summary.parentHeadSequence !== artifact.headSequence ||
      summary.resultHeadSequence !== input.receipt.sequenceEnd ||
      summary.priorNativeRevision !== committed.priorNativeRevision ||
      summary.nativeReceipt.revision !== committed.nativeRevision ||
      summary.nativeReceipt.commandCount !== committed.commandCount ||
      summary.priorStateHash !== artifact.stateHash ||
      summary.stateHash !== input.receipt.stateHash ||
      summary.requestHash !== input.receipt.requestHash ||
      !sameBytes(summary.intentBytes, input.receipt.intentBytes) ||
      !sameBytes(summary.nativeReceiptBytes, committed.nativeReceiptBytes)
    ) {
      throw new Error("Serialized OGAST metadata disagrees with its record");
    }
  }
  const idempotencyKey = receiptKey(input.receipt.actorKey, input.receipt.clientTransactionId);
  if (
    aggregate.receipts.has(idempotencyKey) ||
    aggregate.transactions.has(input.serverTransactionId) ||
    aggregate.committedTransactions.has(input.serverTransactionId) ||
    aggregate.outbox.has(input.outbox.outboxId)
  ) {
    throw new Error("Duplicate transaction, receipt, or outbox identity");
  }
  for (const operation of input.operations) {
    if (aggregate.operations.has(operation.operationId)) {
      throw new Error(`Duplicate operation identity: ${operation.operationId}`);
    }
  }
  if (input.receipt.modality === "spreadsheet") {
    for (const target of input.receipt.selectiveUndoOperationIds) {
      if (aggregate.undoClaims.has(target)) {
        throw new Error(`Duplicate selective undo claim: ${target}`);
      }
      aggregate.undoClaims.set(target, input.serverTransactionId);
    }
  }
  aggregate.receipts.set(idempotencyKey, cloneReceipt(input.receipt));
  aggregate.transactions.set(input.serverTransactionId, cloneReceipt(input.receipt));
  aggregate.committedTransactions.set(
    input.serverTransactionId,
    cloneCommittedTransaction(input.committedTransaction),
  );
  for (const operation of input.operations) {
    aggregate.operations.set(operation.operationId, cloneOperation(operation));
  }
  aggregate.outbox.set(input.outbox.outboxId, cloneOutbox(input.outbox));
  if (artifact.modality === "spreadsheet") {
    if (input.receipt.modality !== "spreadsheet") {
      throw new Error("Spreadsheet artifact received a serialized receipt");
    }
    aggregate.artifact = {
      ...artifact,
      headSequence: input.receipt.sequenceEnd,
      causalFrontier: cloneFrontier(input.receipt.resultingCausalFrontier),
      stateHash: input.receipt.stateHash,
      updatedAt: laterIsoTimestamp(artifact.updatedAt, input.receipt.committedAt),
    };
    aggregate.checkpoints.set(input.receipt.sequenceEnd, {
      modality: "spreadsheet",
      headSequence: input.receipt.sequenceEnd,
      causalFrontier: cloneFrontier(input.receipt.resultingCausalFrontier),
      stateHash: input.receipt.stateHash,
    });
  } else {
    if (input.receipt.modality === "spreadsheet") {
      throw new Error("Serialized artifact received a spreadsheet receipt");
    }
    aggregate.artifact = {
      ...artifact,
      headSequence: input.receipt.sequenceEnd,
      stateHash: input.receipt.stateHash,
      updatedAt: laterIsoTimestamp(artifact.updatedAt, input.receipt.committedAt),
    };
    aggregate.checkpoints.set(input.receipt.sequenceEnd, {
      modality: artifact.modality,
      headSequence: input.receipt.sequenceEnd,
      nativeRevision: input.receipt.nativeRevision,
      stateHash: input.receipt.stateHash,
    });
  }
}

class InMemoryEditableArtifactSnapshotUnitOfWork implements EditableArtifactSnapshotUnitOfWorkPort {
  private committed = false;
  private closed = false;

  constructor(private readonly aggregate: ArtifactAggregate) {}

  artifact(): EditableArtifact {
    this.assertOpen();
    return cloneArtifact(this.aggregate.artifact);
  }

  async checkpoint(headSequence: number): Promise<EditableArtifactSequenceCheckpoint | null> {
    this.assertOpen();
    const checkpoint = this.aggregate.checkpoints.get(headSequence);
    return checkpoint ? cloneCheckpoint(checkpoint) : null;
  }

  async findSnapshot(
    snapshotId: EditableArtifactSnapshotId,
  ): Promise<EditableArtifactSnapshotMetadata | null> {
    this.assertOpen();
    const snapshot = this.aggregate.snapshots.get(snapshotId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  async commitSnapshot(
    input: CommitEditableArtifactSnapshot,
  ): Promise<Readonly<{ kind: "committed" }>> {
    this.assertUncommitted();
    if (
      input.authorizationPermission !== undefined &&
      input.authorizationPermission !== "manage" &&
      input.authorizationPermission !== "read" &&
      input.authorizationPermission !== "edit"
    ) {
      throw new TypeError("Snapshot authorization permission is invalid");
    }
    const artifact = this.aggregate.artifact;
    if (input.expectedCurrentSnapshotId !== artifact.currentSnapshotId) {
      throw new Error("In-memory current snapshot changed inside its transaction lock");
    }
    if (input.expectedAuthorizationRevision !== artifact.authorizationRevision) {
      throw new Error("In-memory artifact authorization changed before snapshot commit");
    }
    if (
      this.aggregate.snapshots.has(input.snapshot.snapshotId) ||
      this.aggregate.outbox.has(input.outbox.outboxId)
    ) {
      throw new Error("Duplicate snapshot or outbox identity");
    }
    const checkpoint = this.aggregate.checkpoints.get(input.snapshot.coveredHeadSequence);
    if (
      !checkpoint ||
      checkpoint.modality !== artifact.modality ||
      input.snapshot.modality !== artifact.modality ||
      checkpoint.stateHash !== input.snapshot.stateHash ||
      (input.snapshot.modality === "spreadsheet" &&
        (checkpoint.modality !== "spreadsheet" ||
          !causalFrontiersEqual(
            checkpoint.causalFrontier,
            input.snapshot.coveredCausalFrontier,
          ))) ||
      (input.snapshot.modality !== "spreadsheet" &&
        (checkpoint.modality === "spreadsheet" ||
          checkpoint.nativeRevision !== input.snapshot.nativeRevision))
    ) {
      throw new Error("Snapshot does not match an authoritative checkpoint");
    }
    this.aggregate.snapshots.set(input.snapshot.snapshotId, cloneSnapshot(input.snapshot));
    this.aggregate.outbox.set(input.outbox.outboxId, cloneOutbox(input.outbox));
    this.aggregate.artifact = {
      ...artifact,
      currentSnapshotId: input.snapshot.snapshotId,
      updatedAt: laterIsoTimestamp(artifact.updatedAt, input.snapshot.publishedAt),
    };
    this.committed = true;
    return Object.freeze({ kind: "committed" as const });
  }

  private assertUncommitted(): void {
    this.assertOpen();
    if (this.committed) throw new Error("Artifact unit of work may commit exactly once");
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Artifact unit of work is no longer inside its lock");
    }
  }
}

/** Deterministic persisted-namespace allocator for reference tests/adapters. */
export class InMemoryEditableArtifactStableIdFactory implements EditableArtifactStableIdFactoryPort {
  private nextCounter: bigint;
  private readonly namespace: bigint;

  constructor(namespace: bigint | string, initialCounter = 1n) {
    this.namespace =
      typeof namespace === "bigint" ? namespace : BigInt(`0x${namespace.replace(/^0x/, "")}`);
    if (this.namespace < 1n || this.namespace > 0xffff_ffff_ffff_ffffn) {
      throw new TypeError("Stable id namespace must be a nonzero unsigned 64-bit integer");
    }
    if (initialCounter < 1n || initialCounter > 0xffff_ffff_ffff_ffffn) {
      throw new TypeError("Stable id counter must be a nonzero unsigned 64-bit integer");
    }
    this.nextCounter = initialCounter;
  }

  next(_kind: EditableArtifactStableIdKind): EditableArtifactStableId {
    if (this.nextCounter > 0xffff_ffff_ffff_ffffn) {
      throw new Error("Stable id namespace exhausted");
    }
    const value = `${this.namespace.toString(16).padStart(16, "0")}${this.nextCounter
      .toString(16)
      .padStart(16, "0")}`;
    this.nextCounter += 1n;
    return editableArtifactOperationId(value);
  }
}

export class SystemEditableArtifactClock implements EditableArtifactClockPort {
  now(): Date {
    return new Date();
  }
}

function aggregateKey(scope: EditableArtifactScope, artifactId: EditableArtifactId): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, artifactId]);
}

function authorizationScopeKey(scope: EditableArtifactScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId]);
}

function creationReceiptKey(
  scope: EditableArtifactScope,
  operationKind: "create" | "import",
  authorityKey: string,
  idempotencyKey: string,
): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    operationKind,
    authorityKey,
    idempotencyKey,
  ]);
}

function emptyAggregate(
  artifact: EditableArtifact,
  genesisSnapshot: EditableArtifactSnapshotMetadata,
  outbox: EditableArtifactLiveOutboxRecord,
): ArtifactAggregate {
  return {
    artifact,
    receipts: new Map(),
    transactions: new Map(),
    committedTransactions: new Map(),
    operations: new Map(),
    undoClaims: new Map(),
    snapshots: new Map([[genesisSnapshot.snapshotId, cloneSnapshot(genesisSnapshot)]]),
    checkpoints: new Map([
      [
        0,
        checkpointAtGenesis(
          artifact,
          genesisSnapshot.modality === "spreadsheet" ? 0 : genesisSnapshot.nativeRevision,
        ),
      ],
    ]),
    outbox: new Map([[outbox.outboxId, cloneOutbox(outbox)]]),
  };
}

function assertGenesisCreateRequest(
  scope: EditableArtifactScope,
  artifactId: EditableArtifactId,
  operationKind: "create" | "import",
  snapshot: EditableArtifactSnapshotMetadata,
  outbox: EditableArtifactLiveOutboxRecord,
): void {
  assertIsoTimestamp(snapshot.verifiedAt, "genesis snapshot verification time");
  assertIsoTimestamp(snapshot.publishedAt, "genesis snapshot publication time");
  if (
    snapshot.scope.accountId !== scope.accountId ||
    snapshot.scope.workspaceId !== scope.workspaceId ||
    snapshot.artifactId !== artifactId ||
    snapshot.coveredHeadSequence !== 0 ||
    (operationKind === "create" &&
      snapshot.modality === "spreadsheet" &&
      snapshot.coveredCausalFrontier.length !== 0) ||
    Date.parse(snapshot.verifiedAt) > Date.parse(snapshot.publishedAt)
  ) {
    throw new TypeError(
      "Genesis snapshot is not the verified sequence-zero state for this artifact",
    );
  }
  if (
    outbox.state !== "pending" ||
    outbox.attemptCount !== 0 ||
    outbox.leaseOwner !== null ||
    outbox.leaseExpiresAt !== null ||
    outbox.nextAttemptAt !== snapshot.publishedAt ||
    outbox.lastErrorCode !== null ||
    outbox.publishedAt !== null ||
    outbox.deadLetteredAt !== null ||
    outbox.createdAt !== snapshot.publishedAt ||
    outbox.event.kind !== "snapshot_published" ||
    outbox.event.scope.accountId !== scope.accountId ||
    outbox.event.scope.workspaceId !== scope.workspaceId ||
    outbox.event.artifactId !== artifactId ||
    outbox.event.modality !== snapshot.modality ||
    outbox.event.snapshotId !== snapshot.snapshotId ||
    outbox.event.coveredHeadSequence !== 0 ||
    outbox.event.stateHash !== snapshot.stateHash ||
    (snapshot.modality === "spreadsheet" &&
      (outbox.event.modality !== "spreadsheet" ||
        outbox.event.operationProtocolVersion !== snapshot.operationProtocolVersion)) ||
    outbox.event.publishedAt !== snapshot.publishedAt
  ) {
    throw new TypeError("Genesis snapshot outbox projection is inconsistent");
  }
}

function receiptKey(actorKey: string, clientTransactionId: string): string {
  return JSON.stringify([actorKey, clientTransactionId]);
}

function sameExpectedPredecessor(
  aggregate: ArtifactAggregate,
  expected: TryCommitAppliedEditableArtifactTransactionRequest["expectedPredecessor"],
): boolean {
  if (expected === null) return true;
  const actual = aggregate.receipts.get(
    receiptKey(expected.actorKey, expected.clientTransactionId),
  );
  return (
    actual !== undefined &&
    actual.receiptId === expected.receiptId &&
    actual.serverTransactionId === expected.serverTransactionId &&
    actual.replicaId === expected.replicaId &&
    actual.replicaCounter === expected.replicaCounter
  );
}

function assertLeaseRequest(request: ClaimEditableArtifactLiveOutboxRequest): void {
  assertLeaseOwner(request.owner);
  assertLeaseDuration(request.leaseDurationMs);
  assertPositiveSafeInteger(request.limit, "outbox claim limit");
  if (request.limit > 1_000) throw new TypeError("Outbox claim limit must not exceed 1000");
}

function assertLeaseDuration(value: number): void {
  assertPositiveSafeInteger(value, "outbox lease duration");
  if (value > 24 * 60 * 60 * 1000) {
    throw new TypeError("Outbox lease duration must not exceed 24 hours");
  }
}

function assertRetryDelay(value: number): void {
  assertPositiveSafeInteger(value, "outbox retry delay");
  if (value > 24 * 60 * 60 * 1000) {
    throw new TypeError("Outbox retry delay must not exceed 24 hours");
  }
}

function assertActiveOutboxLease(
  record: EditableArtifactLiveOutboxRecord,
  owner: string,
  attemptCount: number,
  nowMs: number,
): void {
  if (
    record.state !== "publishing" ||
    record.leaseOwner !== owner ||
    record.attemptCount !== attemptCount ||
    !record.leaseExpiresAt ||
    nowMs >= Date.parse(record.leaseExpiresAt)
  ) {
    throw new EditableArtifactOutboxLeaseConflictError();
  }
}

function assertRetryErrorCode(
  value: string,
): asserts value is EditableArtifactOutboxRetryFailureCode {
  if (
    value !== "broker_unavailable" &&
    value !== "broker_backpressure" &&
    value !== "publish_timeout"
  ) {
    throw new TypeError("Outbox retry error code is invalid");
  }
}

function assertDeadLetterErrorCode(
  value: string,
): asserts value is EditableArtifactOutboxDeadLetterFailureCode {
  if (value !== "invalid_hint" && value !== "oversized_hint") {
    throw new TypeError("Outbox dead-letter error code is invalid");
  }
}

function assertLeaseOwner(owner: string): string {
  if (owner.length < 1 || owner.length > 256) {
    throw new TypeError("Outbox lease owner must contain 1-256 characters");
  }
  return owner;
}

function authoritativeNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Editable artifact store clock returned an invalid date");
  }
  return new Date(value);
}

function laterIsoTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function cloneAggregate(aggregate: ArtifactAggregate): ArtifactAggregate {
  return {
    artifact: cloneArtifact(aggregate.artifact),
    receipts: new Map([...aggregate.receipts].map(([key, value]) => [key, cloneReceipt(value)])),
    transactions: new Map(
      [...aggregate.transactions].map(([key, value]) => [key, cloneReceipt(value)]),
    ),
    committedTransactions: new Map(
      [...aggregate.committedTransactions].map(([key, value]) => [
        key,
        cloneCommittedTransaction(value),
      ]),
    ),
    operations: new Map(
      [...aggregate.operations].map(([key, value]) => [key, cloneOperation(value)]),
    ),
    undoClaims: new Map(aggregate.undoClaims),
    snapshots: new Map([...aggregate.snapshots].map(([key, value]) => [key, cloneSnapshot(value)])),
    checkpoints: new Map(
      [...aggregate.checkpoints].map(([key, value]) => [key, cloneCheckpoint(value)]),
    ),
    outbox: new Map([...aggregate.outbox].map(([key, value]) => [key, cloneOutbox(value)])),
  };
}

function kernelStateFromAggregate(aggregate: ArtifactAggregate): EditableArtifactKernelState {
  const snapshot = aggregate.artifact.currentSnapshotId
    ? (aggregate.snapshots.get(aggregate.artifact.currentSnapshotId) ?? null)
    : null;
  const artifact = cloneArtifact(aggregate.artifact);
  const covered = snapshot?.coveredHeadSequence ?? 0;
  const coveredCheckpoint = aggregate.checkpoints.get(covered);
  if (!coveredCheckpoint || coveredCheckpoint.modality !== artifact.modality) {
    throw new Error("Artifact replay base has no matching checkpoint");
  }
  const tail = [...aggregate.committedTransactions.values()]
    .filter((transaction) => transaction.sequenceEnd > covered)
    .sort((left, right) => left.sequenceStart - right.sequenceStart)
    .map(cloneCommittedTransaction);
  const tailByteSize = tail.reduce(
    (total, transaction) => total + transaction.committedTransactionBytes.byteLength,
    0,
  );
  const common = {
    tailTransactionCount: tail.length,
    tailByteSize,
  } as const;
  if (artifact.modality === "spreadsheet") {
    return Object.freeze({
      ...common,
      modality: artifact.modality,
      artifact,
      snapshot: snapshot?.modality === "spreadsheet" ? cloneSnapshot(snapshot) : null,
      committedTransactionTail: Object.freeze(
        tail.map((transaction) => {
          if (transaction.modality !== "spreadsheet") {
            throw new Error("Spreadsheet artifact contains a cross-modality transaction");
          }
          return transaction;
        }),
      ),
    });
  }
  return Object.freeze({
    ...common,
    modality: artifact.modality,
    artifact,
    snapshot: snapshot && snapshot.modality !== "spreadsheet" ? cloneSnapshot(snapshot) : null,
    baseNativeRevision:
      coveredCheckpoint.modality === "spreadsheet"
        ? (() => {
            throw new Error("Serialized artifact has a spreadsheet replay checkpoint");
          })()
        : coveredCheckpoint.nativeRevision,
    committedTransactionTail: Object.freeze(
      tail.map((transaction) => {
        if (transaction.modality !== artifact.modality) {
          throw new Error("Serialized artifact contains a cross-modality transaction");
        }
        return transaction;
      }),
    ),
  });
}

function cloneArtifact(artifact: EditableArtifact): EditableArtifact {
  if (artifact.modality !== "spreadsheet") {
    return Object.freeze({
      ...artifact,
      scope: Object.freeze({ ...artifact.scope }),
    });
  }
  return Object.freeze({
    ...artifact,
    scope: Object.freeze({ ...artifact.scope }),
    causalFrontier: cloneFrontier(artifact.causalFrontier),
  });
}

function cloneCreationReceipt(
  receipt: EditableArtifactCreationReceipt,
): EditableArtifactCreationReceipt {
  return Object.freeze({
    ...receipt,
    scope: Object.freeze({ ...receipt.scope }),
  });
}

function cloneReceipt(receipt: EditableArtifactReceipt): EditableArtifactReceipt {
  if (receipt.modality !== "spreadsheet") {
    return Object.freeze({
      ...receipt,
      scope: Object.freeze({ ...receipt.scope }),
      intentBytes: receipt.intentBytes.slice(),
    });
  }
  return Object.freeze({
    ...receipt,
    scope: Object.freeze({ ...receipt.scope }),
    intentBytes: receipt.intentBytes.slice(),
    causalBase: cloneFrontier(receipt.causalBase),
    resolvedCausalBase: cloneFrontier(receipt.resolvedCausalBase),
    resultingCausalFrontier: cloneFrontier(receipt.resultingCausalFrontier),
    selectiveUndoOperationIds: Object.freeze([...receipt.selectiveUndoOperationIds]),
  });
}

function cloneOperation(
  operation: EditableArtifactOperationRecord,
): EditableArtifactOperationRecord {
  return Object.freeze({
    ...operation,
    scope: Object.freeze({ ...operation.scope }),
    dot: Object.freeze({ ...operation.dot }),
  });
}

function cloneCommittedTransaction(
  transaction: EditableArtifactSpreadsheetCommittedTransactionRecord,
): EditableArtifactSpreadsheetCommittedTransactionRecord;
function cloneCommittedTransaction(
  transaction: EditableArtifactSerializedCommittedTransactionRecord,
): EditableArtifactSerializedCommittedTransactionRecord;
function cloneCommittedTransaction(
  transaction: EditableArtifactCommittedTransactionRecord,
): EditableArtifactCommittedTransactionRecord;
function cloneCommittedTransaction(
  transaction: EditableArtifactCommittedTransactionRecord,
): EditableArtifactCommittedTransactionRecord {
  if (transaction.modality !== "spreadsheet") {
    return Object.freeze({
      ...transaction,
      scope: Object.freeze({ ...transaction.scope }),
      nativeReceiptBytes: transaction.nativeReceiptBytes.slice(),
      committedTransactionBytes: transaction.committedTransactionBytes.slice(),
    });
  }
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

function cloneSnapshot(
  snapshot: EditableArtifactSpreadsheetSnapshotMetadata,
): EditableArtifactSpreadsheetSnapshotMetadata;
function cloneSnapshot(
  snapshot: EditableArtifactSerializedSnapshotMetadata,
): EditableArtifactSerializedSnapshotMetadata;
function cloneSnapshot(
  snapshot: EditableArtifactSnapshotMetadata,
): EditableArtifactSnapshotMetadata;
function cloneSnapshot(
  snapshot: EditableArtifactSnapshotMetadata,
): EditableArtifactSnapshotMetadata {
  if (snapshot.modality !== "spreadsheet") {
    return Object.freeze({
      ...snapshot,
      scope: Object.freeze({ ...snapshot.scope }),
    });
  }
  return Object.freeze({
    ...snapshot,
    scope: Object.freeze({ ...snapshot.scope }),
    coveredCausalFrontier: cloneFrontier(snapshot.coveredCausalFrontier),
  });
}

function cloneCheckpoint(
  checkpoint: EditableArtifactSequenceCheckpoint,
): EditableArtifactSequenceCheckpoint {
  if (checkpoint.modality !== "spreadsheet") {
    return Object.freeze({ ...checkpoint });
  }
  return Object.freeze({
    ...checkpoint,
    causalFrontier: cloneFrontier(checkpoint.causalFrontier),
  });
}

function checkpointAtGenesis(
  artifact: EditableArtifact,
  nativeRevision = 0,
): EditableArtifactSequenceCheckpoint {
  return artifact.modality === "spreadsheet"
    ? Object.freeze({
        modality: "spreadsheet" as const,
        headSequence: 0,
        causalFrontier: editableArtifactCausalFrontier([]),
        stateHash: artifact.stateHash,
      })
    : Object.freeze({
        modality: artifact.modality,
        headSequence: 0,
        nativeRevision,
        stateHash: artifact.stateHash,
      });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function cloneOutbox(record: EditableArtifactLiveOutboxRecord): EditableArtifactLiveOutboxRecord {
  return Object.freeze({
    ...record,
    event: Object.freeze({
      ...record.event,
      scope: Object.freeze({ ...record.event.scope }),
    }),
  });
}

function cloneFrontier<T extends readonly { replicaId: string; counter: number }[]>(
  frontier: T,
): T {
  return Object.freeze(frontier.map((entry) => Object.freeze({ ...entry }))) as unknown as T;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
