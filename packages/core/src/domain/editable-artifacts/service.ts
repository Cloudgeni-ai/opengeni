import {
  EditableArtifactCausalChainError,
  EditableArtifactCausalFutureError,
  EditableArtifactForbiddenError,
  EditableArtifactIdempotencyConflictError,
  EditableArtifactInvalidRequestError,
  EditableArtifactKernelContractError,
  EditableArtifactNotEditableError,
  EditableArtifactNotFoundError,
  EditableArtifactRetryableConflictError,
  EditableArtifactSnapshotConflictError,
  EditableArtifactStaleBaseError,
  EditableArtifactUndoTargetError,
} from "./errors";
import type {
  AuthoritativeEditableArtifactKernelPort,
  EditableArtifactAuthorizationPort,
  EditableArtifactClockPort,
  EditableArtifactCompactionPort,
  EditableArtifactGenesisPort,
  EditableArtifactKernelState,
  EditableArtifactMutationIntentCodecPort,
  EditableArtifactSnapshotVerifierPort,
  EditableArtifactStableIdFactoryPort,
  EditableArtifactStorePort,
} from "./ports";
import { hashEditableArtifactCreateRequest, hashEditableArtifactImportRequest } from "./hash";
import {
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_UNDO_TARGETS,
  EDITABLE_ARTIFACT_INTENT_VERSION,
  EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
} from "@opengeni/contracts/editable-artifacts";
import {
  COMMITTED_TRANSACTION_PROTOCOL_VERSION,
  MAX_COMMITTED_TRANSACTION_BYTES,
  MAX_COMMITTED_TRANSACTION_OPERATIONS,
  decodeCommittedTransactionSummary,
} from "@opengeni/contracts/editable-artifact-committed-transaction";
import {
  EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
  decodeEditableArtifactSerializedCommit,
  encodeEditableArtifactSerializedCommit,
} from "@opengeni/contracts/editable-artifact-serialized-commit";
import { editableArtifactCodecFor } from "@opengeni/contracts/editable-artifact-codec-registry";
import { EditableArtifactSnapshotVerificationError } from "./snapshot-verifier";
import {
  assertBoundedArtifactTitle,
  assertBoundedKernelVersion,
  assertBoundedOpaqueReference,
  assertIsoTimestamp,
  assertNonnegativeSafeInteger,
  assertPositiveSafeInteger,
  causalCounter,
  causalFrontierDominates,
  causalFrontiersEqual,
  editableArtifactActorKey,
  editableArtifactCausalFrontier,
  editableArtifactClientTransactionId,
  compareCodeUnits,
  editableArtifactContentHash,
  editableArtifactId,
  editableArtifactOperationId,
  editableArtifactOutboxId,
  editableArtifactReceiptId,
  editableArtifactReplicaId,
  editableArtifactRequestHash,
  editableArtifactSnapshotId,
  editableArtifactScope,
  editableArtifactStateHash,
  editableArtifactTransactionId,
  EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES,
  mergeCausalFrontiers,
  type ApplyEditableArtifactTransactionRequest,
  type ApplyEditableArtifactTransactionResult,
  type CreateEditableArtifactRequest,
  type CreateEditableArtifactResult,
  type EditableArtifactOriginalImport,
  type ImportEditableArtifactRequest,
  type EditableArtifact,
  type EditableArtifactActor,
  type EditableArtifactCausalFrontier,
  type EditableArtifactKernelOperation,
  type EditableArtifactLiveOutboxRecord,
  type EditableArtifactMutationIntent,
  type EditableArtifactOperationRecord,
  type EditableArtifactPermission,
  type EditableArtifactReceipt,
  type EditableArtifactScope,
  type EditableArtifactSnapshotMetadata,
  type EditableArtifactSerialized,
  type EditableArtifactSerializedCommittedTransactionRecord,
  type EditableArtifactSerializedReceipt,
  type EditableArtifactSpreadsheet,
  type EditableArtifactSpreadsheetCommittedTransactionRecord,
  type EditableArtifactSpreadsheetReceipt,
  type PublishEditableArtifactSnapshotRequest,
  type ValidatedEditableArtifactMutationIntent,
  validateEditableArtifactActor,
} from "./types";

export const EDITABLE_ARTIFACT_MAX_OPERATIONS_PER_TRANSACTION =
  MAX_COMMITTED_TRANSACTION_OPERATIONS;
export const EDITABLE_ARTIFACT_MAX_UNDO_TARGETS_PER_TRANSACTION = Math.min(
  EDITABLE_ARTIFACT_INTENT_MAX_UNDO_TARGETS,
  MAX_COMMITTED_TRANSACTION_OPERATIONS,
);
export const EDITABLE_ARTIFACT_MAX_COMMAND_BYTES_PER_TRANSACTION =
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES;
export const EDITABLE_ARTIFACT_MAX_INTENT_BYTES_PER_TRANSACTION =
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES;
export const EDITABLE_ARTIFACT_INTENT_PROTOCOL_VERSION = 1;
export const EDITABLE_ARTIFACT_MAX_OPERATION_BYTES_PER_TRANSACTION =
  MAX_COMMITTED_TRANSACTION_BYTES;
/** Canonical OGACO envelope bound. Kept as an alias for existing consumers. */
export const EDITABLE_ARTIFACT_MAX_COMMITTED_TRANSACTION_BYTES =
  EDITABLE_ARTIFACT_MAX_OPERATION_BYTES_PER_TRANSACTION;
export const EDITABLE_ARTIFACT_OPERATION_PROTOCOL_VERSION = COMMITTED_TRANSACTION_PROTOCOL_VERSION;
export const EDITABLE_ARTIFACT_MAX_COMMIT_ATTEMPTS = 4;
/** Compact well before hard replay ceilings so one maximum transaction cannot cross them. */
export const EDITABLE_ARTIFACT_COMPACTION_TRANSACTION_THRESHOLD = 1_024;
export const EDITABLE_ARTIFACT_COMPACTION_BYTE_THRESHOLD = 16 * 1024 * 1024;

export type EditableArtifactServiceDependencies = Readonly<{
  authorization: EditableArtifactAuthorizationPort;
  kernel: AuthoritativeEditableArtifactKernelPort;
  store: EditableArtifactStorePort;
  intentCodec: EditableArtifactMutationIntentCodecPort;
  clock: EditableArtifactClockPort;
  ids: EditableArtifactStableIdFactoryPort;
  snapshotVerifier: EditableArtifactSnapshotVerifierPort;
  genesis: EditableArtifactGenesisPort;
  compaction?: EditableArtifactCompactionPort;
}>;

export class EditableArtifactService {
  private readonly inFlightCreations = new Map<
    string,
    Readonly<{
      requestHash: EditableArtifactReceipt["requestHash"];
      promise: Promise<CreateEditableArtifactResult>;
    }>
  >();
  private readonly inFlightTransactions = new Map<
    string,
    Readonly<{
      requestHash: EditableArtifactReceipt["requestHash"];
      promise: Promise<ApplyEditableArtifactTransactionResult>;
    }>
  >();
  private readonly inFlightImports = new Map<
    string,
    Readonly<{
      requestHash: EditableArtifactReceipt["requestHash"];
      promise: Promise<CreateEditableArtifactResult>;
    }>
  >();
  private readonly inFlightCompactions = new Map<
    string,
    Promise<EditableArtifactSnapshotMetadata>
  >();

  constructor(private readonly dependencies: EditableArtifactServiceDependencies) {}

  async createArtifact(input: {
    scope: EditableArtifactScope;
    actor: EditableArtifactActor;
    request: CreateEditableArtifactRequest;
    signal?: AbortSignal;
  }): Promise<CreateEditableArtifactResult> {
    const scope = editableArtifactScope(input.scope);
    validateEditableArtifactActor(input.actor);
    const actor: EditableArtifactActor = Object.freeze({ ...input.actor });
    const request = normalizeCreateRequest(input.request);
    const requestHash = hashEditableArtifactCreateRequest(request);
    const authorityKey = editableArtifactActorKey(actor);
    const inFlightKey = creationInFlightKey(
      scope,
      "create",
      authorityKey,
      request.idempotencyKey,
    );
    for (;;) {
      const inFlight = this.inFlightCreations.get(inFlightKey);
      if (inFlight) {
        if (inFlight.requestHash === requestHash) {
          const result = await inFlight.promise;
          return copyCreateResult(result, true);
        }
        try {
          await inFlight.promise;
        } catch {
          continue;
        }
        throw new EditableArtifactIdempotencyConflictError();
      }
      const promise = this.createArtifactOptimistically({
        scope,
        actor,
        authorityKey,
        request,
        requestHash,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      this.inFlightCreations.set(inFlightKey, { requestHash, promise });
      try {
        return await promise;
      } finally {
        if (this.inFlightCreations.get(inFlightKey)?.promise === promise) {
          this.inFlightCreations.delete(inFlightKey);
        }
      }
    }
  }

  private async createArtifactOptimistically(input: {
    scope: EditableArtifactScope;
    actor: EditableArtifactActor;
    authorityKey: string;
    request: CreateEditableArtifactRequest;
    requestHash: EditableArtifactReceipt["requestHash"];
    signal?: AbortSignal;
  }): Promise<CreateEditableArtifactResult> {
    const { scope, actor, authorityKey, request, requestHash } = input;
    const artifactId = editableArtifactId(this.dependencies.ids.next("artifact"));
    let authorizationRevision = await this.requirePermission({
      scope,
      artifactId,
      actor,
      permission: "create",
    });
    const existing = await this.dependencies.store.findArtifactCreation(
      scope,
      "create",
      authorityKey,
      request.idempotencyKey,
    );
    if (existing) {
      if (existing.creationReceipt.requestHash !== requestHash) {
        throw new EditableArtifactIdempotencyConflictError();
      }
      return copyCreateResult(existing, true);
    }
    const snapshotId = editableArtifactSnapshotId(this.dependencies.ids.next("snapshot"));
    const candidate = validateSnapshotRequest(
      await this.dependencies.genesis.prepare({
        scope,
        artifactId,
        snapshotId,
        modality: request.modality,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    if (
      candidate.snapshotId !== snapshotId ||
      candidate.modality !== request.modality ||
      candidate.coveredHeadSequence !== 0 ||
      (candidate.modality === "spreadsheet" && candidate.coveredCausalFrontier.length !== 0)
    ) {
      throw new EditableArtifactKernelContractError(
        "Genesis snapshot must use its assigned identity and empty modality boundary",
      );
    }
    await this.dependencies.snapshotVerifier.verify({
      scope,
      artifactId,
      actor,
      snapshot: candidate,
    });
    const publishedAt = canonicalNow(this.dependencies.clock);
    if (Date.parse(candidate.verifiedAt) > Date.parse(publishedAt)) {
      throw new EditableArtifactSnapshotConflictError(
        "Snapshot verification time cannot be after publication",
      );
    }
    const genesisSnapshot: EditableArtifactSnapshotMetadata = Object.freeze({
      ...candidate,
      scope,
      artifactId,
      publishedAt,
    });
    const receiptId = editableArtifactReceiptId(this.dependencies.ids.next("receipt"));
    const outbox = snapshotOutboxRecord(
      editableArtifactOutboxId(this.dependencies.ids.next("outbox")),
      genesisSnapshot,
    );
    for (let attempt = 1; attempt <= EDITABLE_ARTIFACT_MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const outcome = await this.dependencies.store.createArtifact({
        scope,
        artifactId,
        authorizationActor: actor,
        receiptId,
        authorityKey,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        operationKind: "create",
        expectedScopeAuthorizationRevision: authorizationRevision,
        initialArtifactAuthorizationRevision: authorizationRevision,
        modality: request.modality,
        title: request.title,
        createdBySubjectId: actor.subjectId,
        genesisSnapshot,
        outbox,
      });
      if (outcome.kind === "result") return outcome.value;
      authorizationRevision = await this.requirePermission({
        scope,
        artifactId,
        actor,
        permission: "create",
      });
    }
    throw new EditableArtifactRetryableConflictError();
  }

  /**
   * Publishes one verified Office import as the sequence-zero durable state.
   * The caller may name immutable source/snapshot objects, but neither becomes
   * authority until the native snapshot verifier and atomic store commit pass.
   */
  async importArtifact(input: {
    scope: EditableArtifactScope;
    actor: EditableArtifactActor;
    request: ImportEditableArtifactRequest;
    signal?: AbortSignal;
  }): Promise<CreateEditableArtifactResult> {
    const scope = editableArtifactScope(input.scope);
    validateEditableArtifactActor(input.actor);
    const actor: EditableArtifactActor = Object.freeze({ ...input.actor });
    const request = normalizeImportRequest(input.request);
    const requestHash = hashEditableArtifactImportRequest(request);
    const authorityKey = editableArtifactActorKey(actor);
    const inFlightKey = creationInFlightKey(
      scope,
      "import",
      authorityKey,
      request.idempotencyKey,
    );
    for (;;) {
      const inFlight = this.inFlightImports.get(inFlightKey);
      if (inFlight) {
        if (inFlight.requestHash === requestHash) {
          return copyCreateResult(await inFlight.promise, true);
        }
        try {
          await inFlight.promise;
        } catch {
          continue;
        }
        throw new EditableArtifactIdempotencyConflictError();
      }
      const promise = this.importArtifactOptimistically({
        scope,
        actor,
        authorityKey,
        request,
        requestHash,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      this.inFlightImports.set(inFlightKey, { requestHash, promise });
      try {
        return await promise;
      } finally {
        if (this.inFlightImports.get(inFlightKey)?.promise === promise) {
          this.inFlightImports.delete(inFlightKey);
        }
      }
    }
  }

  private async importArtifactOptimistically(input: {
    scope: EditableArtifactScope;
    actor: EditableArtifactActor;
    authorityKey: string;
    request: ImportEditableArtifactRequest;
    requestHash: EditableArtifactReceipt["requestHash"];
    signal?: AbortSignal;
  }): Promise<CreateEditableArtifactResult> {
    const { scope, actor, authorityKey, request, requestHash } = input;
    const artifactId = editableArtifactId(this.dependencies.ids.next("artifact"));
    let authorizationRevision = await this.requirePermission({
      scope,
      artifactId,
      actor,
      permission: "import",
    });
    const existing = await this.dependencies.store.findArtifactCreation(
      scope,
      "import",
      authorityKey,
      request.idempotencyKey,
    );
    if (existing) {
      if (existing.creationReceipt.requestHash !== requestHash) {
        throw new EditableArtifactIdempotencyConflictError();
      }
      return copyCreateResult(existing, true);
    }
    const snapshotId = editableArtifactSnapshotId(this.dependencies.ids.next("snapshot"));
    const verifiedAt = canonicalNow(this.dependencies.clock);
    const candidate = validateSnapshotRequest({
      ...request.snapshot,
      snapshotId,
      verifiedAt,
    } as PublishEditableArtifactSnapshotRequest);
    if (
      candidate.modality !== request.modality ||
      candidate.coveredHeadSequence !== 0
    ) {
      throw new EditableArtifactKernelContractError(
        "Imported snapshot must use its assigned modality and sequence-zero boundary",
      );
    }
    await this.dependencies.snapshotVerifier.verify({
      scope,
      artifactId,
      actor,
      snapshot: candidate,
    });
    const publishedAt = canonicalNow(this.dependencies.clock);
    if (Date.parse(candidate.verifiedAt) > Date.parse(publishedAt)) {
      throw new EditableArtifactSnapshotConflictError(
        "Snapshot verification time cannot be after publication",
      );
    }
    const genesisSnapshot: EditableArtifactSnapshotMetadata = Object.freeze({
      ...candidate,
      scope,
      artifactId,
      publishedAt,
    });
    const receiptId = editableArtifactReceiptId(this.dependencies.ids.next("receipt"));
    const originalImport = Object.freeze({
      ...request.originalImport,
      blobRefId: this.dependencies.ids.next("blob"),
    });
    const outbox = snapshotOutboxRecord(
      editableArtifactOutboxId(this.dependencies.ids.next("outbox")),
      genesisSnapshot,
    );
    for (let attempt = 1; attempt <= EDITABLE_ARTIFACT_MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const outcome = await this.dependencies.store.createArtifact({
        scope,
        artifactId,
        authorizationActor: actor,
        receiptId,
        authorityKey,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        operationKind: "import",
        expectedScopeAuthorizationRevision: authorizationRevision,
        initialArtifactAuthorizationRevision: authorizationRevision,
        modality: request.modality,
        title: request.title,
        createdBySubjectId: actor.subjectId,
        genesisSnapshot,
        originalImport,
        outbox,
      });
      if (outcome.kind === "result") return outcome.value;
      authorizationRevision = await this.requirePermission({
        scope,
        artifactId,
        actor,
        permission: "import",
      });
    }
    throw new EditableArtifactRetryableConflictError();
  }

  async getArtifact(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifact["id"];
    actor: EditableArtifactActor;
  }): Promise<EditableArtifact> {
    const context = normalizeBoundaryContext(input);
    let authorizationRevision = await this.requirePermission({
      ...context,
      permission: "read",
    });
    for (let attempt = 1; attempt <= EDITABLE_ARTIFACT_MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const outcome = await this.dependencies.store.readArtifactAtAuthorizationRevision(
        context.scope,
        context.artifactId,
        authorizationRevision,
      );
      if (outcome.kind === "result") {
        if (!outcome.artifact) throw new EditableArtifactNotFoundError();
        return outcome.artifact;
      }
      authorizationRevision = await this.requirePermission({
        ...context,
        permission: "read",
      });
    }
    throw new EditableArtifactRetryableConflictError();
  }

  async applyTransaction(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifact["id"];
    actor: EditableArtifactActor;
    request: ApplyEditableArtifactTransactionRequest;
  }): Promise<ApplyEditableArtifactTransactionResult> {
    const context = normalizeBoundaryContext(input);
    const request = normalizeTransactionEnvelope(input.request);
    const authorizationRevision = await this.requirePermission({
      ...context,
      permission: "edit",
    });
    const intent = normalizeMutationIntent(
      await this.dependencies.intentCodec.decodeAndVerify({
        intentBytes: request.intentBytes.slice(),
        requestHash: request.requestHash,
      }),
    );
    if (intent.artifactId !== context.artifactId) {
      throw new EditableArtifactInvalidRequestError("Mutation intent is bound to another artifact");
    }
    if (intent.replicaId !== context.actor.replicaId) {
      throw new EditableArtifactInvalidRequestError(
        "Mutation intent is bound to another actor replica",
      );
    }
    const intentBytes = request.intentBytes.slice();
    const actorKey = editableArtifactActorKey(context.actor);
    const inFlightKey = transactionInFlightKey(
      context.scope,
      context.artifactId,
      actorKey,
      intent.clientTransactionId,
    );
    for (;;) {
      const inFlight = this.inFlightTransactions.get(inFlightKey);
      if (inFlight) {
        if (inFlight.requestHash === request.requestHash) {
          const result = await inFlight.promise;
          return Object.freeze({
            receipt: copyReceipt(result.receipt),
            replayed: true,
          });
        }
        // Serialize a conflicting reuse behind the current candidate. If the
        // first commits, the normal durable idempotency check rejects this hash;
        // if it fails, the second remains free to become authoritative. Looping
        // lets simultaneous conflicts coalesce behind their next exact hash.
        try {
          await inFlight.promise;
        } catch {
          // Deliberately continue; the conflicting request has its own outcome.
        }
        continue;
      }

      const promise = this.applyTransactionOptimistically({
        context,
        actorKey,
        request,
        intent,
        intentBytes,
        authorizationRevision,
      });
      this.inFlightTransactions.set(inFlightKey, {
        requestHash: request.requestHash,
        promise,
      });
      try {
        return await promise;
      } finally {
        if (this.inFlightTransactions.get(inFlightKey)?.promise === promise) {
          this.inFlightTransactions.delete(inFlightKey);
        }
      }
    }
  }

  private async applyTransactionOptimistically(input: {
    context: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifact["id"];
      actor: EditableArtifactActor;
    }>;
    actorKey: string;
    request: ApplyEditableArtifactTransactionRequest;
    intent: ValidatedEditableArtifactMutationIntent;
    intentBytes: Uint8Array;
    authorizationRevision: number;
  }): Promise<ApplyEditableArtifactTransactionResult> {
    const { context, actorKey, request, intent, intentBytes } = input;
    let authorizationRevision = input.authorizationRevision;
    for (let attempt = 1; attempt <= EDITABLE_ARTIFACT_MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const basisRead = await this.dependencies.store.readTransactionBasis(
        context.scope,
        context.artifactId,
        {
          actorKey,
          clientTransactionId: intent.clientTransactionId,
          previousLocalTransactionId: intent.previousLocalTransactionId,
          selectiveUndoOperationIds: intent.selectiveUndoOperationIds,
        },
      );
      if (basisRead.kind === "existing") {
        if (basisRead.receipt.requestHash !== request.requestHash) {
          throw new EditableArtifactIdempotencyConflictError();
        }
        return Object.freeze({
          receipt: copyReceipt(basisRead.receipt),
          replayed: true,
        });
      }
      const basis = basisRead;

      const artifact = basis.artifact;
      if (artifact.authorizationRevision !== authorizationRevision) {
        authorizationRevision = await this.requirePermission({
          ...context,
          permission: "edit",
        });
        continue;
      }
      if (artifact.lifecycle !== "active") {
        throw new EditableArtifactNotEditableError(artifact.lifecycle);
      }
      if (this.dependencies.compaction && shouldCompactKernelState(basis.kernelState)) {
        await this.compactCurrentHeadWithPermission(context, "edit");
        // Snapshot publication changes replay coverage but not the head. Read a
        // fresh detached basis so the kernel never replays the old long tail.
        continue;
      }
      validateIntentCommands(artifact, intent);

      if (artifact.modality !== "spreadsheet") {
        if (intent.observedHeadSequence !== artifact.headSequence) {
          throw new EditableArtifactStaleBaseError();
        }
        if (intent.causalBase.length !== 0 || intent.selectiveUndoOperationIds.length !== 0) {
          throw new EditableArtifactInvalidRequestError(
            "Serialized artifacts do not accept CRDT causality or selective undo",
          );
        }
        validateSerializedPredecessor(
          basis.predecessor,
          context.actor.replicaId,
          intent,
          artifact.modality,
        );
        if (
          basis.undoTargets.length !== 0 ||
          basis.kernelState.modality !== artifact.modality ||
          basis.kernelState.artifact.modality !== artifact.modality
        ) {
          throw new Error("Editable artifact store returned a cross-modality serialized basis");
        }
        const priorNativeRevision = serializedBasisNativeRevision(basis.kernelState, artifact);
        const kernelResult = await this.dependencies.kernel.applyTransaction({
          modality: artifact.modality,
          state: basis.kernelState,
          actor: context.actor,
          intent,
          requestHash: request.requestHash,
          intentBytes: intentBytes.slice(),
        });
        const serverTransactionId = editableArtifactTransactionId(
          this.dependencies.ids.next("transaction"),
        );
        let normalizedKernel: ReturnType<typeof validateSerializedKernelResult>;
        try {
          normalizedKernel = validateSerializedKernelResult({
            artifact,
            intent,
            intentBytes,
            requestHash: request.requestHash,
            serverTransactionId,
            priorNativeRevision,
            result: kernelResult,
          });
        } catch (error) {
          if (error instanceof EditableArtifactKernelContractError) throw error;
          throw new EditableArtifactKernelContractError(
            `Authoritative kernel returned malformed serialized data: ${
              error instanceof Error ? error.message : "unknown contract error"
            }`,
          );
        }
        const committedAt = canonicalNow(this.dependencies.clock);
        const sequence = artifact.headSequence + 1;
        assertPositiveSafeInteger(sequence, "serialized resulting head sequence");
        const committedTransaction: EditableArtifactSerializedCommittedTransactionRecord =
          Object.freeze({
            scope: artifact.scope,
            artifactId: artifact.id,
            modality: artifact.modality,
            serverTransactionId,
            requestHash: request.requestHash,
            sequenceStart: sequence,
            sequenceEnd: sequence,
            priorStateHash: artifact.stateHash,
            stateHash: normalizedKernel.stateHash,
            commitProtocolVersion: EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
            priorNativeRevision,
            nativeRevision: normalizedKernel.nativeRevision,
            commandCount: normalizedKernel.commandCount,
            nativeReceiptBytes: normalizedKernel.nativeReceiptBytes.slice(),
            modelSchemaVersion: normalizedKernel.modelSchemaVersion,
            kernelVersion: normalizedKernel.kernelVersion,
            committedTransactionBytes: normalizedKernel.committedTransactionBytes.slice(),
            committedAt,
          });
        const receipt: EditableArtifactSerializedReceipt = Object.freeze({
          receiptId: editableArtifactReceiptId(this.dependencies.ids.next("receipt")),
          scope: artifact.scope,
          artifactId: artifact.id,
          modality: artifact.modality,
          serverTransactionId,
          clientTransactionId: intent.clientTransactionId,
          replicaId: context.actor.replicaId,
          replicaCounter: intent.replicaCounter,
          previousLocalTransactionId: intent.previousLocalTransactionId,
          requestHash: request.requestHash,
          intentBytes: intentBytes.slice(),
          actorKey,
          sequenceStart: sequence,
          sequenceEnd: sequence,
          priorStateHash: artifact.stateHash,
          stateHash: normalizedKernel.stateHash,
          intentEnvelopeVersion: intent.envelopeVersion,
          intentProtocolVersion: intent.protocolVersion,
          commandProtocolVersion: intent.commandProtocolVersion,
          kernelVersion: normalizedKernel.kernelVersion,
          modelSchemaVersion: normalizedKernel.modelSchemaVersion,
          commitProtocolVersion: EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
          priorNativeRevision,
          nativeRevision: normalizedKernel.nativeRevision,
          commandCount: normalizedKernel.commandCount,
          committedAt,
        });
        const outbox = transactionOutboxRecord(
          editableArtifactOutboxId(this.dependencies.ids.next("outbox")),
          receipt,
        );
        const commit = await this.dependencies.store.tryCommitAppliedTransaction({
          scope: context.scope,
          artifactId: context.artifactId,
          expectedLifecycle: "active",
          expectedAuthorizationRevision: authorizationRevision,
          authorizationActor: context.actor,
          expectedHeadSequence: artifact.headSequence,
          actorKey,
          clientTransactionId: intent.clientTransactionId,
          requestHash: request.requestHash,
          expectedPredecessor: basis.predecessor
            ? {
                receiptId: basis.predecessor.receiptId,
                serverTransactionId: basis.predecessor.serverTransactionId,
                actorKey: basis.predecessor.actorKey,
                clientTransactionId: basis.predecessor.clientTransactionId,
                replicaId: basis.predecessor.replicaId,
                replicaCounter: basis.predecessor.replicaCounter,
              }
            : null,
          expectedUnclaimedUndoTargets: Object.freeze([]),
          serverTransactionId,
          receipt,
          committedTransaction,
          operations: Object.freeze([]),
          outbox,
        });
        if (commit.kind === "committed") {
          return Object.freeze({
            receipt: copyReceipt(commit.receipt),
            replayed: false,
          });
        }
        if (commit.kind === "replayed") {
          if (commit.receipt.requestHash !== request.requestHash) {
            throw new EditableArtifactIdempotencyConflictError();
          }
          return Object.freeze({
            receipt: copyReceipt(commit.receipt),
            replayed: true,
          });
        }
        // Re-read before any new kernel call. A changed serialized head fails
        // exact-base validation above instead of being merged or rebased.
        continue;
      }

      if (
        basis.kernelState.modality !== "spreadsheet" ||
        basis.kernelState.artifact.modality !== "spreadsheet"
      ) {
        throw new Error("Editable artifact store returned a cross-modality spreadsheet basis");
      }
      if (intent.observedHeadSequence > artifact.headSequence) {
        throw new EditableArtifactCausalFutureError();
      }
      if (!causalFrontierDominates(artifact.causalFrontier, intent.causalBase)) {
        throw new EditableArtifactCausalFutureError();
      }

      let resolvedCausalBase = intent.causalBase;
      if (intent.previousLocalTransactionId === null) {
        if (intent.replicaCounter !== 1) {
          throw new EditableArtifactCausalChainError(
            "Only a replica's first transaction may omit its local predecessor",
          );
        }
      } else {
        const predecessor = basis.predecessor;
        if (!predecessor) {
          throw new EditableArtifactCausalChainError(
            "Previous local transaction is not committed yet",
          );
        }
        if (
          predecessor.modality !== "spreadsheet" ||
          predecessor.replicaId !== context.actor.replicaId ||
          predecessor.replicaCounter + 1 !== intent.replicaCounter
        ) {
          throw new EditableArtifactCausalChainError(
            "Previous local transaction does not match this replica counter chain",
          );
        }
        resolvedCausalBase = mergeCausalFrontiers(
          intent.causalBase,
          predecessor.resolvedCausalBase,
          editableArtifactCausalFrontier([
            {
              replicaId: predecessor.replicaId,
              counter: predecessor.replicaCounter,
            },
          ]),
        );
      }
      if (
        intent.replicaCounter !==
        causalCounter(artifact.causalFrontier, context.actor.replicaId) + 1
      ) {
        throw new EditableArtifactCausalChainError(
          "Replica counter does not immediately advance the authoritative frontier",
        );
      }
      if (!causalFrontierDominates(artifact.causalFrontier, resolvedCausalBase)) {
        throw new EditableArtifactCausalFutureError();
      }

      if (basis.undoTargets.length !== intent.selectiveUndoOperationIds.length) {
        throw new Error("Editable artifact store returned a malformed transaction undo basis");
      }
      const resolvedUndoTargets: EditableArtifactOperationRecord[] = [];
      for (const [index, operationId] of intent.selectiveUndoOperationIds.entries()) {
        const undoBasis = basis.undoTargets[index];
        if (!undoBasis || undoBasis.operationId !== operationId) {
          throw new Error("Editable artifact store returned a malformed transaction undo basis");
        }
        const operation = undoBasis.operation;
        if (!operation) {
          throw new EditableArtifactUndoTargetError(`Unknown undo target: ${operationId}`);
        }
        if (operation.actorKey !== actorKey) {
          throw new EditableArtifactUndoTargetError(
            `Selective undo may target only operations authored by the same authority: ${operationId}`,
          );
        }
        if (undoBasis.claimedBy) {
          throw new EditableArtifactUndoTargetError(
            `Operation was already selectively undone: ${operationId}`,
          );
        }
        if (causalCounter(resolvedCausalBase, operation.dot.replicaId) < operation.dot.counter) {
          throw new EditableArtifactUndoTargetError(
            `Selective undo target is not present in the transaction's causal base: ${operationId}`,
          );
        }
        resolvedUndoTargets.push(operation);
      }
      Object.freeze(resolvedUndoTargets);

      // This is intentionally outside the store's read and write transactions.
      const kernelResult = await this.dependencies.kernel.applyTransaction({
        modality: "spreadsheet",
        state: basis.kernelState,
        actor: context.actor,
        intent,
        requestHash: request.requestHash,
        intentBytes: intentBytes.slice(),
        resolvedCausalBase,
        resolvedUndoTargets,
      });
      let normalizedKernel: ReturnType<typeof validateKernelResult>;
      try {
        normalizedKernel = validateKernelResult(
          artifact,
          context.actor,
          intent,
          resolvedCausalBase,
          kernelResult,
        );
      } catch (error) {
        if (error instanceof EditableArtifactKernelContractError) throw error;
        throw new EditableArtifactKernelContractError(
          `Authoritative kernel returned malformed data: ${
            error instanceof Error ? error.message : "unknown contract error"
          }`,
        );
      }

      const committedAt = canonicalNow(this.dependencies.clock);
      const serverTransactionId = normalizedKernel.serverTransactionId;
      const sequenceStart = artifact.headSequence + 1;
      const sequenceEnd = artifact.headSequence + normalizedKernel.operationIds.length;
      assertNonnegativeSafeInteger(sequenceEnd, "resulting head sequence");
      const operations: EditableArtifactOperationRecord[] = normalizedKernel.operationIds.map(
        (operationId, index) =>
          Object.freeze({
            scope: artifact.scope,
            artifactId: artifact.id,
            serverTransactionId,
            sequence: sequenceStart + index,
            actorKey,
            createdAt: committedAt,
            operationId,
            dot: normalizedKernel.dot,
          }),
      );
      const committedTransaction: EditableArtifactSpreadsheetCommittedTransactionRecord =
        Object.freeze({
          scope: artifact.scope,
          artifactId: artifact.id,
          modality: "spreadsheet",
          serverTransactionId,
          requestHash: request.requestHash,
          sequenceStart,
          sequenceEnd,
          priorStateHash: normalizedKernel.priorStateHash,
          stateHash: normalizedKernel.stateHash,
          dot: normalizedKernel.dot,
          resolvedCausalBase,
          resultingCausalFrontier: normalizedKernel.resultingCausalFrontier,
          operationIds: normalizedKernel.operationIds,
          operationProtocolVersion: normalizedKernel.operationProtocolVersion,
          modelSchemaVersion: normalizedKernel.modelSchemaVersion,
          kernelVersion: normalizedKernel.kernelVersion,
          committedTransactionBytes: normalizedKernel.committedTransactionBytes.slice(),
          committedAt,
        });
      const receipt = Object.freeze({
        receiptId: editableArtifactReceiptId(this.dependencies.ids.next("receipt")),
        scope: artifact.scope,
        artifactId: artifact.id,
        modality: "spreadsheet",
        serverTransactionId,
        clientTransactionId: intent.clientTransactionId,
        replicaId: context.actor.replicaId,
        replicaCounter: intent.replicaCounter,
        previousLocalTransactionId: intent.previousLocalTransactionId,
        requestHash: request.requestHash,
        intentBytes: intentBytes.slice(),
        actorKey,
        sequenceStart,
        sequenceEnd,
        priorStateHash: normalizedKernel.priorStateHash,
        causalBase: intent.causalBase,
        resolvedCausalBase,
        resultingCausalFrontier: normalizedKernel.resultingCausalFrontier,
        stateHash: normalizedKernel.stateHash,
        operationCount: operations.length,
        selectiveUndoOperationIds: intent.selectiveUndoOperationIds,
        intentEnvelopeVersion: intent.envelopeVersion,
        intentProtocolVersion: intent.protocolVersion,
        commandProtocolVersion: intent.commandProtocolVersion,
        kernelVersion: normalizedKernel.kernelVersion,
        modelSchemaVersion: normalizedKernel.modelSchemaVersion,
        operationProtocolVersion: normalizedKernel.operationProtocolVersion,
        committedAt,
      } as const satisfies EditableArtifactSpreadsheetReceipt);
      const outbox = transactionOutboxRecord(
        editableArtifactOutboxId(this.dependencies.ids.next("outbox")),
        receipt,
      );
      const commit = await this.dependencies.store.tryCommitAppliedTransaction({
        scope: context.scope,
        artifactId: context.artifactId,
        expectedLifecycle: "active",
        expectedAuthorizationRevision: authorizationRevision,
        authorizationActor: context.actor,
        expectedHeadSequence: artifact.headSequence,
        actorKey,
        clientTransactionId: intent.clientTransactionId,
        requestHash: request.requestHash,
        expectedPredecessor: basis.predecessor
          ? {
              receiptId: basis.predecessor.receiptId,
              serverTransactionId: basis.predecessor.serverTransactionId,
              actorKey: basis.predecessor.actorKey,
              clientTransactionId: basis.predecessor.clientTransactionId,
              replicaId: basis.predecessor.replicaId,
              replicaCounter: basis.predecessor.replicaCounter,
            }
          : null,
        expectedUnclaimedUndoTargets: intent.selectiveUndoOperationIds,
        serverTransactionId,
        receipt,
        committedTransaction,
        operations,
        outbox,
      });
      if (commit.kind === "committed") {
        return Object.freeze({
          receipt: copyReceipt(commit.receipt),
          replayed: false,
        });
      }
      if (commit.kind === "replayed") {
        if (commit.receipt.requestHash !== request.requestHash) {
          throw new EditableArtifactIdempotencyConflictError();
        }
        return Object.freeze({
          receipt: copyReceipt(commit.receipt),
          replayed: true,
        });
      }
      // A newer head invalidates every derived value above. Re-read and rerun
      // from scratch; never patch or partially reuse speculative kernel output.
    }
    throw new EditableArtifactRetryableConflictError();
  }

  async compactCurrentHead(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifact["id"];
    actor: EditableArtifactActor;
    signal?: AbortSignal;
  }): Promise<EditableArtifactSnapshotMetadata> {
    return await this.compactCurrentHeadWithPermission(input, "read");
  }

  private async compactCurrentHeadWithPermission(
    input: {
      scope: EditableArtifactScope;
      artifactId: EditableArtifact["id"];
      actor: EditableArtifactActor;
      signal?: AbortSignal;
    },
    authorizationPermission: "read" | "edit",
  ): Promise<EditableArtifactSnapshotMetadata> {
    if (!this.dependencies.compaction) {
      throw new Error("Editable artifact snapshot compaction is not configured");
    }
    const context = normalizeBoundaryContext(input);
    // Coalescing is only a compute optimization. Every caller must cross its
    // own authorization boundary before it may observe another caller's result.
    const authorizationRevision = await this.requirePermission({
      ...context,
      permission: authorizationPermission,
    });
    const key = compactionInFlightKey(
      context.scope,
      context.artifactId,
      context.actor,
      authorizationPermission,
    );
    const existing = this.inFlightCompactions.get(key);
    if (existing) return await existing;
    const promise = this.compactCurrentHeadOnce({
      ...context,
      authorizationRevision,
      authorizationPermission,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    this.inFlightCompactions.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightCompactions.get(key) === promise) this.inFlightCompactions.delete(key);
    }
  }

  private async compactCurrentHeadOnce(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifact["id"];
    actor: EditableArtifactActor;
    authorizationRevision: number;
    authorizationPermission: "read" | "edit";
    signal?: AbortSignal;
  }): Promise<EditableArtifactSnapshotMetadata> {
    const compaction = this.dependencies.compaction;
    if (!compaction) throw new Error("Editable artifact snapshot compaction is not configured");
    let authorizationRevision = input.authorizationRevision;
    for (let attempt = 1; attempt <= EDITABLE_ARTIFACT_MAX_COMMIT_ATTEMPTS; attempt += 1) {
      if (input.signal?.aborted) {
        throw new EditableArtifactSnapshotVerificationError("cancelled");
      }
      const basis = await this.dependencies.store.readSnapshotCompactionBasis(
        input.scope,
        input.artifactId,
        authorizationRevision,
      );
      if (basis.kind === "authorization_stale") {
        authorizationRevision = await this.requirePermission({
          ...input,
          permission: input.authorizationPermission,
        });
        continue;
      }
      const current = basis.state.snapshot;
      if (current && current.coveredHeadSequence === basis.state.artifact.headSequence) {
        return current;
      }
      const candidate = await compaction.prepare({
        scope: input.scope,
        artifactId: input.artifactId,
        snapshotId: editableArtifactSnapshotId(this.dependencies.ids.next("snapshot")),
        state: basis.state,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      await this.dependencies.snapshotVerifier.verify({ ...input, snapshot: candidate });
      try {
        const published = await this.commitVerifiedSnapshotCandidate({
          context: input,
          candidate,
          authorizationRevision,
          authorizationPermission: input.authorizationPermission,
          requireCurrentHead: true,
        });
        return published.snapshot;
      } catch (error) {
        // The durable head advanced while this exact candidate was outside the
        // lock. Reread authority; deterministic candidate failures are not retried.
        if (error instanceof EditableArtifactCompactionRaceError) continue;
        throw error;
      }
    }
    throw new EditableArtifactRetryableConflictError();
  }

  async publishVerifiedSnapshot(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifact["id"];
    actor: EditableArtifactActor;
    snapshot: PublishEditableArtifactSnapshotRequest;
  }): Promise<{
    snapshot: EditableArtifactSnapshotMetadata;
    replayed: boolean;
  }> {
    const context = normalizeBoundaryContext(input);
    const candidate = validateSnapshotRequest(input.snapshot);
    const authorizationRevision = await this.requirePermission({
      ...context,
      permission: "manage",
    });
    await this.dependencies.snapshotVerifier.verify({
      ...context,
      snapshot: candidate,
    });
    return await this.commitVerifiedSnapshotCandidate({
      context,
      candidate,
      authorizationRevision,
      authorizationPermission: "manage",
      requireCurrentHead: false,
    });
  }

  private async commitVerifiedSnapshotCandidate(input: {
    context: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifact["id"];
      actor: EditableArtifactActor;
    }>;
    candidate: PublishEditableArtifactSnapshotRequest;
    authorizationRevision: number;
    authorizationPermission: "manage" | "read" | "edit";
    requireCurrentHead: boolean;
  }): Promise<{
    snapshot: EditableArtifactSnapshotMetadata;
    replayed: boolean;
  }> {
    const { context, candidate, authorizationPermission } = input;
    let authorizationRevision = input.authorizationRevision;
    for (let attempt = 1; attempt <= EDITABLE_ARTIFACT_MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const outcome = await this.dependencies.store.withSnapshotPublicationLock(
        context.scope,
        context.artifactId,
        async (unitOfWork) => {
          const artifact = unitOfWork.artifact();
          if (artifact.modality !== candidate.modality) {
            throw new EditableArtifactSnapshotConflictError(
              "Snapshot modality does not match the durable artifact",
            );
          }
          if (input.requireCurrentHead && candidate.coveredHeadSequence !== artifact.headSequence) {
            throw new EditableArtifactCompactionRaceError(
              "Compaction candidate no longer covers the current durable head",
            );
          }
          if (artifact.authorizationRevision !== authorizationRevision) {
            return Object.freeze({ kind: "authorization_stale" as const });
          }
          const existing = await unitOfWork.findSnapshot(candidate.snapshotId);
          if (existing) {
            if (!sameSnapshotRequest(existing, candidate)) {
              throw new EditableArtifactSnapshotConflictError(
                "Snapshot id was already published with different immutable metadata",
              );
            }
            return Object.freeze({
              kind: "result" as const,
              value: Object.freeze({ snapshot: existing, replayed: true }),
            });
          }
          const checkpoint = await unitOfWork.checkpoint(candidate.coveredHeadSequence);
          if (
            !checkpoint ||
            checkpoint.modality !== candidate.modality ||
            checkpoint.stateHash !== candidate.stateHash ||
            (candidate.modality === "spreadsheet" &&
              (checkpoint.modality !== "spreadsheet" ||
                !causalFrontiersEqual(
                  checkpoint.causalFrontier,
                  candidate.coveredCausalFrontier,
                ))) ||
            (candidate.modality !== "spreadsheet" &&
              (checkpoint.modality === "spreadsheet" ||
                checkpoint.nativeRevision !== candidate.nativeRevision))
          ) {
            throw new EditableArtifactSnapshotConflictError(
              "Snapshot coverage does not match an authoritative transaction boundary",
            );
          }
          if (artifact.currentSnapshotId) {
            const current = await unitOfWork.findSnapshot(artifact.currentSnapshotId);
            if (!current) {
              throw new EditableArtifactSnapshotConflictError(
                "Current snapshot metadata is missing",
              );
            }
            if (candidate.coveredHeadSequence <= current.coveredHeadSequence) {
              if (
                input.requireCurrentHead &&
                current.coveredHeadSequence === artifact.headSequence
              ) {
                return Object.freeze({
                  kind: "result" as const,
                  value: Object.freeze({ snapshot: current, replayed: true }),
                });
              }
              throw new EditableArtifactSnapshotConflictError(
                "Snapshot publication must advance coverage",
              );
            }
          }
          const publishedAt = canonicalNow(this.dependencies.clock);
          const snapshot: EditableArtifactSnapshotMetadata = Object.freeze({
            ...candidate,
            scope: artifact.scope,
            artifactId: artifact.id,
            publishedAt,
          });
          const outbox = snapshotOutboxRecord(
            editableArtifactOutboxId(this.dependencies.ids.next("outbox")),
            snapshot,
          );
          const publication = await unitOfWork.commitSnapshot({
            expectedCurrentSnapshotId: artifact.currentSnapshotId,
            expectedAuthorizationRevision: authorizationRevision,
            authorizationActor: context.actor,
            authorizationPermission,
            snapshot,
            outbox,
          });
          if (publication.kind === "authorization_stale") {
            return Object.freeze({ kind: "authorization_stale" as const });
          }
          return Object.freeze({
            kind: "result" as const,
            value: Object.freeze({ snapshot, replayed: false }),
          });
        },
      );
      if (outcome.kind === "result") return outcome.value;
      authorizationRevision = await this.requirePermission({
        ...context,
        permission: authorizationPermission,
      });
    }
    throw new EditableArtifactRetryableConflictError();
  }

  private async requirePermission(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifact["id"];
    actor: EditableArtifactActor;
    permission: EditableArtifactPermission;
  }): Promise<number> {
    const decision = await this.dependencies.authorization.authorize({
      scope: input.scope,
      artifactId: input.artifactId,
      actor: input.actor,
      permission: input.permission,
    });
    if (typeof decision.allowed !== "boolean") {
      throw new TypeError("Artifact authorization decision is malformed");
    }
    assertPositiveSafeInteger(decision.revision, "artifact authorization revision");
    if (!decision.allowed) {
      throw new EditableArtifactForbiddenError(input.permission);
    }
    return decision.revision;
  }
}

function creationInFlightKey(
  scope: EditableArtifactScope,
  operationKind: "create" | "import",
  actorKey: string,
  idempotencyKey: string,
): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    operationKind,
    actorKey,
    idempotencyKey,
  ]);
}

function transactionInFlightKey(
  scope: EditableArtifactScope,
  artifactId: EditableArtifact["id"],
  actorKey: string,
  clientTransactionId: EditableArtifactReceipt["clientTransactionId"],
): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    artifactId,
    actorKey,
    clientTransactionId,
  ]);
}

function compactionInFlightKey(
  scope: EditableArtifactScope,
  artifactId: EditableArtifact["id"],
  actor: EditableArtifactActor,
  permission: "read" | "edit",
): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    artifactId,
    editableArtifactActorKey(actor),
    permission,
  ]);
}

function shouldCompactKernelState(state: EditableArtifactKernelState): boolean {
  return (
    state.tailTransactionCount >= EDITABLE_ARTIFACT_COMPACTION_TRANSACTION_THRESHOLD ||
    state.tailByteSize >= EDITABLE_ARTIFACT_COMPACTION_BYTE_THRESHOLD
  );
}

class EditableArtifactCompactionRaceError extends EditableArtifactSnapshotConflictError {}

function normalizeCreateRequest(
  input: CreateEditableArtifactRequest,
): CreateEditableArtifactRequest {
  const record = plainDataRecord(input, "artifact create request");
  rejectUnknownKeys(record, ["idempotencyKey", "modality", "title"], "artifact create request");
  const rawIdempotencyKey = dataProperty(record, "idempotencyKey", true);
  const modality = dataProperty(record, "modality", true);
  const title = dataProperty(record, "title", true);
  if (
    typeof rawIdempotencyKey !== "string" ||
    typeof title !== "string" ||
    (modality !== "spreadsheet" && modality !== "presentation" && modality !== "document")
  ) {
    throw new TypeError("Artifact create request fields are malformed");
  }
  assertBoundedArtifactTitle(title);
  return Object.freeze({
    idempotencyKey: editableArtifactClientTransactionId(rawIdempotencyKey),
    modality,
    title,
  });
}

function normalizeImportRequest(
  input: ImportEditableArtifactRequest,
): ImportEditableArtifactRequest {
  const record = plainDataRecord(input, "artifact import request");
  rejectUnknownKeys(
    record,
    ["idempotencyKey", "modality", "title", "originalImport", "snapshot"],
    "artifact import request",
  );
  const rawIdempotencyKey = dataProperty(record, "idempotencyKey", true);
  const modality = dataProperty(record, "modality", true);
  const title = dataProperty(record, "title", true);
  const rawOriginalImport = dataProperty(record, "originalImport", true);
  const rawSnapshot = dataProperty(record, "snapshot", true);
  if (
    typeof rawIdempotencyKey !== "string" ||
    typeof title !== "string" ||
    (modality !== "spreadsheet" && modality !== "presentation" && modality !== "document")
  ) {
    throw new TypeError("Artifact import request fields are malformed");
  }
  assertBoundedArtifactTitle(title);
  const originalImport = normalizeOriginalImport(rawOriginalImport, modality);
  const snapshotRecord = plainDataRecord(rawSnapshot, "artifact import snapshot");
  if (
    Reflect.ownKeys(snapshotRecord).includes("snapshotId") ||
    Reflect.ownKeys(snapshotRecord).includes("verifiedAt")
  ) {
    throw new TypeError("Artifact import snapshot identity and timestamps are server-assigned");
  }
  const candidate = Object.fromEntries(
    Reflect.ownKeys(snapshotRecord).map((key) => {
      if (typeof key !== "string") throw new TypeError("Artifact import snapshot has symbols");
      return [key, dataProperty(snapshotRecord, key, true)];
    }),
  );
  const normalized = validateSnapshotRequest({
    ...candidate,
    snapshotId: "00000000000000000000000000000001",
    verifiedAt: "1970-01-01T00:00:00.000Z",
  } as PublishEditableArtifactSnapshotRequest);
  if (normalized.modality !== modality || normalized.coveredHeadSequence !== 0) {
    throw new TypeError("Artifact import snapshot boundary is malformed");
  }
  const {
    snapshotId: _serverAssignedSnapshotId,
    verifiedAt: _serverAssignedVerifiedAt,
    ...snapshot
  } = normalized;
  return Object.freeze({
    idempotencyKey: editableArtifactClientTransactionId(rawIdempotencyKey),
    modality,
    title,
    originalImport,
    snapshot: Object.freeze(snapshot) as ImportEditableArtifactRequest["snapshot"],
  });
}

function normalizeOriginalImport(
  input: unknown,
  modality: ImportEditableArtifactRequest["modality"],
): EditableArtifactOriginalImport {
  const record = plainDataRecord(input, "artifact original import");
  rejectUnknownKeys(
    record,
    ["fileId", "blobReference", "byteSize", "contentHash", "mimeType"],
    "artifact original import",
  );
  const fileId = dataProperty(record, "fileId", true);
  const blobReference = dataProperty(record, "blobReference", true);
  const byteSize = dataProperty(record, "byteSize", true);
  const contentHash = dataProperty(record, "contentHash", true);
  const mimeType = dataProperty(record, "mimeType", true);
  const expectedMimeType =
    modality === "spreadsheet"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : modality === "document"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (
    typeof fileId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      fileId,
    ) ||
    typeof blobReference !== "string" ||
    typeof byteSize !== "number" ||
    typeof contentHash !== "string" ||
    mimeType !== expectedMimeType
  ) {
    throw new TypeError("Artifact original import fields are malformed");
  }
  assertBoundedOpaqueReference(blobReference, "original import blob reference");
  assertPositiveSafeInteger(byteSize, "original import byte size");
  if (byteSize > EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES) {
    throw new TypeError("Artifact original import exceeds its byte limit");
  }
  return Object.freeze({
    fileId,
    blobReference,
    byteSize,
    contentHash: editableArtifactContentHash(contentHash),
    mimeType: expectedMimeType,
  });
}

function copyReceipt(receipt: EditableArtifactReceipt): EditableArtifactReceipt {
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
    causalBase: editableArtifactCausalFrontier(receipt.causalBase),
    resolvedCausalBase: editableArtifactCausalFrontier(receipt.resolvedCausalBase),
    resultingCausalFrontier: editableArtifactCausalFrontier(receipt.resultingCausalFrontier),
    selectiveUndoOperationIds: Object.freeze([...receipt.selectiveUndoOperationIds]),
  });
}

function copyCreateResult(
  result: CreateEditableArtifactResult,
  replayed = result.replayed,
): CreateEditableArtifactResult {
  const artifact =
    result.artifact.modality === "spreadsheet"
      ? Object.freeze({
          ...result.artifact,
          scope: Object.freeze({ ...result.artifact.scope }),
          causalFrontier: editableArtifactCausalFrontier(result.artifact.causalFrontier),
        })
      : Object.freeze({
          ...result.artifact,
          scope: Object.freeze({ ...result.artifact.scope }),
        });
  const genesisSnapshot =
    result.genesisSnapshot.modality === "spreadsheet"
      ? Object.freeze({
          ...result.genesisSnapshot,
          scope: Object.freeze({ ...result.genesisSnapshot.scope }),
          coveredCausalFrontier: editableArtifactCausalFrontier(
            result.genesisSnapshot.coveredCausalFrontier,
          ),
        })
      : Object.freeze({
          ...result.genesisSnapshot,
          scope: Object.freeze({ ...result.genesisSnapshot.scope }),
        });
  return Object.freeze({
    artifact,
    genesisSnapshot,
    creationReceipt: Object.freeze({
      ...result.creationReceipt,
      scope: Object.freeze({ ...result.creationReceipt.scope }),
    }),
    replayed,
  });
}

function normalizeBoundaryContext(input: {
  scope: EditableArtifactScope;
  artifactId: EditableArtifact["id"];
  actor: EditableArtifactActor;
}): Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifact["id"];
  actor: EditableArtifactActor;
}> {
  const scope = editableArtifactScope(input.scope);
  const artifactId = editableArtifactId(input.artifactId);
  validateEditableArtifactActor(input.actor);
  const actor: EditableArtifactActor = Object.freeze({ ...input.actor });
  return Object.freeze({ scope, artifactId, actor });
}

function normalizeTransactionEnvelope(
  request: ApplyEditableArtifactTransactionRequest,
): ApplyEditableArtifactTransactionRequest {
  const record = plainDataRecord(request, "mutation envelope");
  rejectUnknownKeys(record, ["intentBytes", "requestHash"], "mutation envelope");
  const rawIntentBytes = dataProperty(record, "intentBytes", true);
  const rawRequestHash = dataProperty(record, "requestHash", true);
  if (!(rawIntentBytes instanceof Uint8Array)) {
    throw new TypeError("Mutation intent bytes must be a Uint8Array");
  }
  if (
    rawIntentBytes.byteLength < 1 ||
    rawIntentBytes.byteLength > EDITABLE_ARTIFACT_MAX_INTENT_BYTES_PER_TRANSACTION
  ) {
    throw new TypeError("Mutation intent bytes exceed the bounded envelope size");
  }
  if (typeof rawRequestHash !== "string") {
    throw new TypeError("Mutation request hash must be a string");
  }
  return Object.freeze({
    intentBytes: rawIntentBytes.slice(),
    requestHash: editableArtifactRequestHash(rawRequestHash),
  });
}

function normalizeMutationIntent(
  input: EditableArtifactMutationIntent,
): ValidatedEditableArtifactMutationIntent {
  const record = plainDataRecord(input, "decoded mutation intent");
  rejectUnknownKeys(
    record,
    [
      "envelopeVersion",
      "protocolVersion",
      "modelSchemaVersion",
      "commandProtocolVersion",
      "artifactId",
      "clientTransactionId",
      "replicaId",
      "replicaCounter",
      "previousLocalTransactionId",
      "observedHeadSequence",
      "causalBase",
      "selectiveUndoOperationIds",
      "commandBytes",
    ],
    "decoded mutation intent",
  );
  const envelopeVersion = dataProperty(record, "envelopeVersion", true);
  const protocolVersion = dataProperty(record, "protocolVersion", true);
  const modelSchemaVersion = dataProperty(record, "modelSchemaVersion", true);
  const commandProtocolVersion = dataProperty(record, "commandProtocolVersion", true);
  const rawArtifactId = dataProperty(record, "artifactId", true);
  const rawClientTransactionId = dataProperty(record, "clientTransactionId", true);
  const rawReplicaId = dataProperty(record, "replicaId", true);
  const replicaCounter = dataProperty(record, "replicaCounter", true);
  const rawPreviousLocalTransactionId = dataProperty(record, "previousLocalTransactionId", true);
  const observedHeadSequence = dataProperty(record, "observedHeadSequence", true);
  const rawCausalBase = dataProperty(record, "causalBase", true);
  const rawUndoTargets = dataProperty(record, "selectiveUndoOperationIds", true);
  const rawCommandBytes = dataProperty(record, "commandBytes", true);
  if (
    typeof envelopeVersion !== "number" ||
    typeof protocolVersion !== "number" ||
    typeof modelSchemaVersion !== "number" ||
    typeof commandProtocolVersion !== "number" ||
    typeof rawArtifactId !== "string" ||
    typeof rawClientTransactionId !== "string" ||
    typeof rawReplicaId !== "string" ||
    typeof replicaCounter !== "number" ||
    (rawPreviousLocalTransactionId !== null && typeof rawPreviousLocalTransactionId !== "string") ||
    typeof observedHeadSequence !== "number" ||
    !Array.isArray(rawCausalBase) ||
    !Array.isArray(rawUndoTargets) ||
    !(rawCommandBytes instanceof Uint8Array)
  ) {
    throw new TypeError("Decoded mutation intent fields are malformed");
  }
  if (envelopeVersion !== EDITABLE_ARTIFACT_INTENT_VERSION) {
    throw new TypeError("Mutation intent envelope version is unsupported");
  }
  assertPositiveSafeInteger(protocolVersion, "intent protocol version");
  if (protocolVersion !== EDITABLE_ARTIFACT_INTENT_PROTOCOL_VERSION) {
    throw new TypeError("Mutation intent protocol version is unsupported");
  }
  assertPositiveSafeInteger(modelSchemaVersion, "intent model schema version");
  assertPositiveSafeInteger(commandProtocolVersion, "intent command protocol version");
  const artifactId = editableArtifactId(rawArtifactId);
  const clientTransactionId = editableArtifactClientTransactionId(rawClientTransactionId);
  const replicaId = editableArtifactReplicaId(rawReplicaId);
  assertPositiveSafeInteger(replicaCounter, "replica counter");
  const previousLocalTransactionId =
    rawPreviousLocalTransactionId === null
      ? null
      : editableArtifactClientTransactionId(rawPreviousLocalTransactionId);
  if (previousLocalTransactionId === clientTransactionId) {
    throw new TypeError("A transaction cannot name itself as its local predecessor");
  }
  assertNonnegativeSafeInteger(observedHeadSequence, "observed head sequence");
  const causalBase = editableArtifactCausalFrontier(
    rawCausalBase as EditableArtifactCausalFrontier,
  );
  if (rawUndoTargets.length > EDITABLE_ARTIFACT_MAX_UNDO_TARGETS_PER_TRANSACTION) {
    throw new TypeError("Editable artifact transaction has too many undo targets");
  }
  const selectiveUndoOperationIds = rawUndoTargets.map((target) => {
    if (typeof target !== "string") {
      throw new TypeError("Selective undo target must be a string");
    }
    return editableArtifactOperationId(target);
  });
  if (new Set(selectiveUndoOperationIds).size !== selectiveUndoOperationIds.length) {
    throw new TypeError("Selective undo targets must be unique");
  }
  const sortedUndoTargets = [...selectiveUndoOperationIds].sort(compareCodeUnits);
  if (sortedUndoTargets.some((target, index) => target !== selectiveUndoOperationIds[index])) {
    throw new TypeError("Selective undo targets must be canonically sorted");
  }
  if (
    rawCommandBytes.byteLength < 1 ||
    rawCommandBytes.byteLength > EDITABLE_ARTIFACT_MAX_COMMAND_BYTES_PER_TRANSACTION
  ) {
    throw new TypeError("Mutation command bytes exceed the transaction limit");
  }
  return Object.freeze({
    envelopeVersion,
    protocolVersion,
    modelSchemaVersion,
    commandProtocolVersion,
    artifactId,
    clientTransactionId,
    replicaId,
    replicaCounter,
    previousLocalTransactionId,
    observedHeadSequence,
    causalBase,
    selectiveUndoOperationIds: Object.freeze(selectiveUndoOperationIds),
    commandBytes: rawCommandBytes.slice(),
  });
}

function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) throw new TypeError(`${label} contains unknown property: ${unknown}`);
}

function dataProperty(record: Record<string, unknown>, key: string, required: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) {
    if (required) throw new TypeError(`Missing required property: ${key}`);
    return undefined;
  }
  if (!("value" in descriptor)) throw new TypeError(`Accessor property is not allowed: ${key}`);
  if (descriptor.value === undefined) {
    throw new TypeError(`Undefined property is not allowed: ${key}`);
  }
  return descriptor.value;
}

function validateIntentCommands(
  artifact: EditableArtifact,
  intent: ValidatedEditableArtifactMutationIntent,
): void {
  try {
    const descriptor = editableArtifactCodecFor({
      durableModality: artifact.modality,
      modelSchemaVersion: intent.modelSchemaVersion,
      commandProtocolVersion: intent.commandProtocolVersion,
    });
    descriptor.command.assertCanonical(intent.commandBytes);
    const decoded = descriptor.command.decode(intent.commandBytes);
    if (artifact.modality !== "spreadsheet" && commandCount(decoded) < 1) {
      throw new TypeError("serialized command batch must not be empty");
    }
  } catch (error) {
    throw new EditableArtifactInvalidRequestError(
      `Mutation commands are incompatible with the durable ${artifact.modality} artifact: ${
        error instanceof Error ? error.message : "invalid command envelope"
      }`,
    );
  }
}

function commandCount(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("command decoder returned an invalid batch");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "commands");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) {
    throw new TypeError("command decoder returned an invalid batch");
  }
  return descriptor.value.length;
}

function validateSerializedPredecessor(
  predecessor: EditableArtifactReceipt | null,
  replicaId: EditableArtifactReceipt["replicaId"],
  intent: ValidatedEditableArtifactMutationIntent,
  modality: "document" | "presentation",
): void {
  if (intent.previousLocalTransactionId === null) {
    if (intent.replicaCounter !== 1) {
      throw new EditableArtifactCausalChainError(
        "Only a replica's first transaction may omit its local predecessor",
      );
    }
    return;
  }
  if (!predecessor) {
    throw new EditableArtifactCausalChainError("Previous local transaction is not committed yet");
  }
  if (
    predecessor.modality !== modality ||
    predecessor.replicaId !== replicaId ||
    predecessor.replicaCounter + 1 !== intent.replicaCounter
  ) {
    throw new EditableArtifactCausalChainError(
      "Previous local transaction does not match this serialized replica chain",
    );
  }
}

function serializedBasisNativeRevision(
  state: Extract<
    import("./ports").EditableArtifactKernelState,
    { modality: "document" | "presentation" }
  >,
  artifact: EditableArtifactSerialized,
): number {
  if (
    state.modality !== artifact.modality ||
    state.artifact.id !== artifact.id ||
    state.artifact.stateHash !== artifact.stateHash ||
    state.artifact.headSequence !== artifact.headSequence
  ) {
    throw new Error("Serialized kernel basis disagrees with its artifact head");
  }
  let headSequence = 0;
  assertNonnegativeSafeInteger(state.baseNativeRevision, "serialized kernel base native revision");
  let nativeRevision = state.baseNativeRevision;
  let stateHash: EditableArtifact["stateHash"];
  if (state.snapshot) {
    if (
      state.snapshot.modality !== artifact.modality ||
      state.snapshot.artifactId !== artifact.id
    ) {
      throw new Error("Serialized snapshot basis has the wrong modality or identity");
    }
    if (state.snapshot.nativeRevision !== state.baseNativeRevision) {
      throw new Error("Serialized snapshot disagrees with its native revision checkpoint");
    }
    headSequence = state.snapshot.coveredHeadSequence;
    stateHash = state.snapshot.stateHash;
  } else {
    stateHash = state.committedTransactionTail[0]?.priorStateHash ?? artifact.stateHash;
  }
  for (const committed of state.committedTransactionTail) {
    if (
      committed.modality !== artifact.modality ||
      committed.sequenceStart !== headSequence + 1 ||
      committed.sequenceEnd !== committed.sequenceStart ||
      committed.priorNativeRevision !== nativeRevision ||
      committed.priorStateHash !== stateHash
    ) {
      throw new Error("Serialized transaction tail is not contiguous with its snapshot");
    }
    headSequence = committed.sequenceEnd;
    nativeRevision = committed.nativeRevision;
    stateHash = committed.stateHash;
  }
  if (headSequence !== artifact.headSequence || stateHash !== artifact.stateHash) {
    throw new Error("Serialized kernel basis does not reconstruct its artifact head");
  }
  return nativeRevision;
}

function validateSerializedKernelResult(input: {
  artifact: EditableArtifactSerialized;
  intent: ValidatedEditableArtifactMutationIntent;
  intentBytes: Uint8Array;
  requestHash: EditableArtifactReceipt["requestHash"];
  serverTransactionId: EditableArtifactReceipt["serverTransactionId"];
  priorNativeRevision: number;
  result: Awaited<ReturnType<AuthoritativeEditableArtifactKernelPort["applyTransaction"]>>;
}): {
  committedTransactionBytes: Uint8Array;
  nativeReceiptBytes: Uint8Array;
  nativeRevision: number;
  commandCount: number;
  stateHash: EditableArtifact["stateHash"];
  kernelVersion: string;
  modelSchemaVersion: number;
} {
  const { artifact, intent, result } = input;
  if (result.modality !== artifact.modality) {
    throw new EditableArtifactKernelContractError(
      "Kernel result modality does not match the durable artifact",
    );
  }
  if (!(result.nativeReceiptBytes instanceof Uint8Array)) {
    throw new EditableArtifactKernelContractError(
      "Kernel returned an invalid native serialized receipt",
    );
  }
  assertPositiveSafeInteger(result.modelSchemaVersion, "kernel model schema version");
  if (result.modelSchemaVersion !== intent.modelSchemaVersion) {
    throw new EditableArtifactKernelContractError(
      "Kernel result model schema does not match the canonical intent",
    );
  }
  try {
    assertBoundedKernelVersion(result.kernelVersion);
  } catch {
    throw new EditableArtifactKernelContractError(
      `Kernel version must contain 1-${EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES} well-formed UTF-8 bytes`,
    );
  }
  const stateHash = editableArtifactStateHash(result.resultingStateHash);
  const committedTransactionBytes = encodeEditableArtifactSerializedCommit({
    modality: artifact.modality,
    transactionId: input.serverTransactionId,
    parentHeadSequence: artifact.headSequence,
    resultHeadSequence: artifact.headSequence + 1,
    priorNativeRevision: input.priorNativeRevision,
    priorStateHash: artifact.stateHash,
    stateHash,
    intentBytes: input.intentBytes,
    nativeReceiptBytes: result.nativeReceiptBytes,
  });
  const summary = decodeEditableArtifactSerializedCommit(
    committedTransactionBytes,
    artifact.modality,
  );
  if (summary.requestHash !== input.requestHash) {
    throw new EditableArtifactKernelContractError(
      "Serialized commit does not bind the exact verified request hash",
    );
  }
  return Object.freeze({
    committedTransactionBytes,
    nativeReceiptBytes: summary.nativeReceiptBytes.slice(),
    nativeRevision: summary.nativeReceipt.revision,
    commandCount: summary.nativeReceipt.commandCount,
    stateHash,
    kernelVersion: result.kernelVersion,
    modelSchemaVersion: result.modelSchemaVersion,
  });
}

function validateKernelResult(
  artifact: EditableArtifactSpreadsheet,
  actor: EditableArtifactActor,
  intent: EditableArtifactMutationIntent,
  resolvedCausalBase: EditableArtifactSpreadsheet["causalFrontier"],
  result: Awaited<ReturnType<AuthoritativeEditableArtifactKernelPort["applyTransaction"]>>,
): {
  committedTransactionBytes: Uint8Array;
  serverTransactionId: EditableArtifactReceipt["serverTransactionId"];
  dot: EditableArtifactKernelOperation["dot"];
  operationIds: readonly EditableArtifactKernelOperation["operationId"][];
  priorStateHash: EditableArtifact["stateHash"];
  resultingCausalFrontier: EditableArtifactSpreadsheet["causalFrontier"];
  stateHash: EditableArtifact["stateHash"];
  kernelVersion: string;
  modelSchemaVersion: number;
  operationProtocolVersion: number;
} {
  if (result.modality !== "spreadsheet") {
    throw new EditableArtifactKernelContractError(
      "Kernel result modality does not match the durable spreadsheet",
    );
  }
  if (
    !(result.committedTransactionBytes instanceof Uint8Array) ||
    result.committedTransactionBytes.byteLength < 1 ||
    result.committedTransactionBytes.byteLength > EDITABLE_ARTIFACT_MAX_COMMITTED_TRANSACTION_BYTES
  ) {
    throw new EditableArtifactKernelContractError(
      "Authoritative kernel returned an invalid canonical OGACO envelope",
    );
  }
  // There is one source of truth: metadata is inspected from the exact whole
  // Rust-authored envelope. A separately supplied host summary could otherwise
  // disagree with the bytes ultimately persisted and replayed.
  const summary = decodeCommittedTransactionSummary(result.committedTransactionBytes);
  if (
    summary.operationIds.length < 1 ||
    summary.operationIds.length > EDITABLE_ARTIFACT_MAX_OPERATIONS_PER_TRANSACTION
  ) {
    throw new EditableArtifactKernelContractError(
      "Authoritative kernel returned an invalid operation count",
    );
  }
  if (summary.operationProtocolVersion !== EDITABLE_ARTIFACT_OPERATION_PROTOCOL_VERSION) {
    throw new EditableArtifactKernelContractError(
      "Authoritative kernel returned an unsupported operation protocol version",
    );
  }
  assertPositiveSafeInteger(result.modelSchemaVersion, "kernel model schema version");
  if (result.modelSchemaVersion !== intent.modelSchemaVersion) {
    throw new EditableArtifactKernelContractError(
      "Kernel result model schema does not match the canonical intent",
    );
  }
  try {
    assertBoundedKernelVersion(result.kernelVersion);
  } catch {
    throw new EditableArtifactKernelContractError(
      `Kernel version must contain 1-${EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES} well-formed UTF-8 bytes`,
    );
  }
  const serverTransactionId = editableArtifactTransactionId(summary.transactionId);
  const priorStateHash = editableArtifactStateHash(summary.priorStateHash);
  if (priorStateHash !== artifact.stateHash) {
    throw new EditableArtifactKernelContractError(
      "Kernel committed transaction prior state does not match its authoritative basis",
    );
  }
  const stateHash = editableArtifactStateHash(summary.stateHash);
  const normalizedResolvedBase = editableArtifactCausalFrontier(
    summary.resolvedCausalBase.map((entry) => ({
      replicaId: editableArtifactReplicaId(entry.replicaId),
      counter: entry.counter,
    })),
  );
  if (!causalFrontiersEqual(normalizedResolvedBase, resolvedCausalBase)) {
    throw new EditableArtifactKernelContractError(
      "Kernel committed transaction resolved base does not match server authority",
    );
  }
  const resultingCausalFrontier = editableArtifactCausalFrontier(
    summary.resultingCausalFrontier.map((entry) => ({
      replicaId: editableArtifactReplicaId(entry.replicaId),
      counter: entry.counter,
    })),
  );
  const dotFrontier = editableArtifactCausalFrontier([
    {
      replicaId: editableArtifactReplicaId(summary.dot.replicaId),
      counter: summary.dot.counter,
    },
  ]);
  const dot = dotFrontier[0]!;
  if (dot.replicaId !== actor.replicaId) {
    throw new EditableArtifactKernelContractError(
      "Kernel transaction dot is not owned by the submitting replica",
    );
  }
  if (dot.counter !== intent.replicaCounter) {
    throw new EditableArtifactKernelContractError(
      "Kernel transaction dot does not match the authored replica counter",
    );
  }
  const seenOperationIds = new Set<string>();
  const operationIds = summary.operationIds.map((rawOperationId) => {
    const operationId = editableArtifactOperationId(rawOperationId);
    if (seenOperationIds.has(operationId)) {
      throw new EditableArtifactKernelContractError("Kernel returned duplicate operation ids");
    }
    seenOperationIds.add(operationId);
    return operationId;
  });
  const expectedFrontier = mergeCausalFrontiers(
    artifact.causalFrontier,
    editableArtifactCausalFrontier([
      { replicaId: actor.replicaId, counter: intent.replicaCounter },
    ]),
  );
  if (!causalFrontiersEqual(resultingCausalFrontier, expectedFrontier)) {
    throw new EditableArtifactKernelContractError(
      "Kernel resulting frontier does not exactly match committed operation dots",
    );
  }
  return Object.freeze({
    committedTransactionBytes: result.committedTransactionBytes.slice(),
    serverTransactionId,
    dot,
    operationIds: Object.freeze(operationIds),
    priorStateHash,
    resultingCausalFrontier,
    stateHash,
    kernelVersion: result.kernelVersion,
    modelSchemaVersion: result.modelSchemaVersion,
    operationProtocolVersion: summary.operationProtocolVersion,
  });
}

function transactionOutboxRecord(
  outboxId: ReturnType<typeof editableArtifactOutboxId>,
  receipt: ApplyEditableArtifactTransactionResult["receipt"],
): EditableArtifactLiveOutboxRecord {
  const event =
    receipt.modality === "spreadsheet"
      ? Object.freeze({
          kind: "transaction_committed" as const,
          schemaVersion: 1 as const,
          scope: receipt.scope,
          artifactId: receipt.artifactId,
          modality: receipt.modality,
          serverTransactionId: receipt.serverTransactionId,
          sequenceStart: receipt.sequenceStart,
          sequenceEnd: receipt.sequenceEnd,
          stateHash: receipt.stateHash,
          operationProtocolVersion: receipt.operationProtocolVersion,
          committedAt: receipt.committedAt,
        })
      : Object.freeze({
          kind: "transaction_committed" as const,
          schemaVersion: 1 as const,
          scope: receipt.scope,
          artifactId: receipt.artifactId,
          modality: receipt.modality,
          serverTransactionId: receipt.serverTransactionId,
          sequenceStart: receipt.sequenceStart,
          sequenceEnd: receipt.sequenceEnd,
          stateHash: receipt.stateHash,
          commitProtocolVersion: receipt.commitProtocolVersion,
          committedAt: receipt.committedAt,
        });
  return Object.freeze({
    outboxId,
    event,
    state: "pending",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: receipt.committedAt,
    lastErrorCode: null,
    publishedAt: null,
    deadLetteredAt: null,
    createdAt: receipt.committedAt,
  });
}

function validateSnapshotRequest(
  request: PublishEditableArtifactSnapshotRequest,
): PublishEditableArtifactSnapshotRequest {
  const record = plainDataRecord(request, "snapshot request");
  const rawModality = dataProperty(record, "modality", true);
  if (
    rawModality !== "spreadsheet" &&
    rawModality !== "document" &&
    rawModality !== "presentation"
  ) {
    throw new TypeError("Snapshot modality is invalid");
  }
  rejectUnknownKeys(
    record,
    rawModality === "spreadsheet"
      ? [
          "modality",
          "snapshotId",
          "blobReference",
          "byteSize",
          "contentHash",
          "mimeType",
          "coveredHeadSequence",
          "coveredCausalFrontier",
          "stateHash",
          "modelSchemaVersion",
          "operationProtocolVersion",
          "kernelVersion",
          "crdtStateVersion",
          "verifiedAt",
        ]
      : [
          "modality",
          "snapshotId",
          "blobReference",
          "byteSize",
          "contentHash",
          "mimeType",
          "coveredHeadSequence",
          "stateHash",
          "modelSchemaVersion",
          "kernelVersion",
          "nativeRevision",
          "verifiedAt",
        ],
    "snapshot request",
  );
  const rawSnapshotId = dataProperty(record, "snapshotId", true);
  const rawBlobReference = dataProperty(record, "blobReference", true);
  const rawByteSize = dataProperty(record, "byteSize", true);
  const rawContentHash = dataProperty(record, "contentHash", true);
  const rawMimeType = dataProperty(record, "mimeType", true);
  const rawCoveredHeadSequence = dataProperty(record, "coveredHeadSequence", true);
  const rawStateHash = dataProperty(record, "stateHash", true);
  const rawModelSchemaVersion = dataProperty(record, "modelSchemaVersion", true);
  const rawKernelVersion = dataProperty(record, "kernelVersion", true);
  const rawVerifiedAt = dataProperty(record, "verifiedAt", true);
  if (
    typeof rawSnapshotId !== "string" ||
    typeof rawBlobReference !== "string" ||
    typeof rawByteSize !== "number" ||
    typeof rawContentHash !== "string" ||
    typeof rawCoveredHeadSequence !== "number" ||
    typeof rawStateHash !== "string" ||
    typeof rawModelSchemaVersion !== "number" ||
    typeof rawKernelVersion !== "string" ||
    typeof rawVerifiedAt !== "string"
  ) {
    throw new TypeError("Snapshot request fields are malformed");
  }
  if (rawMimeType !== "application/vnd.opengeni.editable-artifact-snapshot") {
    throw new TypeError("Snapshot MIME type is unsupported");
  }
  const snapshotId = editableArtifactSnapshotId(rawSnapshotId);
  assertBoundedOpaqueReference(rawBlobReference, "snapshot blob reference");
  assertPositiveSafeInteger(rawByteSize, "snapshot byte size");
  const contentHash = editableArtifactContentHash(rawContentHash);
  assertNonnegativeSafeInteger(rawCoveredHeadSequence, "snapshot covered head sequence");
  const stateHash = editableArtifactStateHash(rawStateHash);
  assertPositiveSafeInteger(rawModelSchemaVersion, "snapshot model schema version");
  assertBoundedKernelVersion(rawKernelVersion);
  assertIsoTimestamp(rawVerifiedAt, "snapshot verified timestamp");
  const common = {
    modality: rawModality,
    snapshotId,
    blobReference: rawBlobReference,
    byteSize: rawByteSize,
    contentHash,
    mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
    coveredHeadSequence: rawCoveredHeadSequence,
    stateHash,
    modelSchemaVersion: rawModelSchemaVersion,
    kernelVersion: rawKernelVersion,
    verifiedAt: rawVerifiedAt,
  } as const;
  if (rawModality === "spreadsheet") {
    const rawCoveredCausalFrontier = dataProperty(record, "coveredCausalFrontier", true);
    const rawOperationProtocolVersion = dataProperty(record, "operationProtocolVersion", true);
    const rawCrdtStateVersion = dataProperty(record, "crdtStateVersion", true);
    if (
      !Array.isArray(rawCoveredCausalFrontier) ||
      typeof rawOperationProtocolVersion !== "number" ||
      typeof rawCrdtStateVersion !== "number"
    ) {
      throw new TypeError("Spreadsheet snapshot fields are malformed");
    }
    assertPositiveSafeInteger(rawOperationProtocolVersion, "snapshot operation protocol version");
    assertPositiveSafeInteger(rawCrdtStateVersion, "snapshot CRDT state version");
    return Object.freeze({
      ...common,
      modality: "spreadsheet",
      coveredCausalFrontier: editableArtifactCausalFrontier(
        rawCoveredCausalFrontier as EditableArtifactCausalFrontier,
      ),
      operationProtocolVersion: rawOperationProtocolVersion,
      crdtStateVersion: rawCrdtStateVersion,
    });
  }
  const rawNativeRevision = dataProperty(record, "nativeRevision", true);
  if (typeof rawNativeRevision !== "number") {
    throw new TypeError("Serialized snapshot native revision is malformed");
  }
  assertNonnegativeSafeInteger(rawNativeRevision, "snapshot native revision");
  return Object.freeze({
    ...common,
    modality: rawModality,
    nativeRevision: rawNativeRevision,
  });
}

function sameSnapshotRequest(
  existing: EditableArtifactSnapshotMetadata,
  candidate: PublishEditableArtifactSnapshotRequest,
): boolean {
  if (
    existing.modality !== candidate.modality ||
    !(
      existing.snapshotId === candidate.snapshotId &&
      existing.blobReference === candidate.blobReference &&
      existing.byteSize === candidate.byteSize &&
      existing.contentHash === candidate.contentHash &&
      existing.mimeType === candidate.mimeType &&
      existing.coveredHeadSequence === candidate.coveredHeadSequence &&
      existing.stateHash === candidate.stateHash &&
      existing.modelSchemaVersion === candidate.modelSchemaVersion &&
      existing.kernelVersion === candidate.kernelVersion &&
      existing.verifiedAt === candidate.verifiedAt
    )
  ) {
    return false;
  }
  if (existing.modality === "spreadsheet" && candidate.modality === "spreadsheet") {
    return (
      causalFrontiersEqual(existing.coveredCausalFrontier, candidate.coveredCausalFrontier) &&
      existing.operationProtocolVersion === candidate.operationProtocolVersion &&
      existing.crdtStateVersion === candidate.crdtStateVersion
    );
  }
  return (
    existing.modality !== "spreadsheet" &&
    candidate.modality !== "spreadsheet" &&
    existing.nativeRevision === candidate.nativeRevision
  );
}

function snapshotOutboxRecord(
  outboxId: ReturnType<typeof editableArtifactOutboxId>,
  snapshot: EditableArtifactSnapshotMetadata,
): EditableArtifactLiveOutboxRecord {
  const event =
    snapshot.modality === "spreadsheet"
      ? Object.freeze({
          kind: "snapshot_published" as const,
          schemaVersion: 1 as const,
          scope: snapshot.scope,
          artifactId: snapshot.artifactId,
          modality: snapshot.modality,
          snapshotId: snapshot.snapshotId,
          coveredHeadSequence: snapshot.coveredHeadSequence,
          stateHash: snapshot.stateHash,
          operationProtocolVersion: snapshot.operationProtocolVersion,
          publishedAt: snapshot.publishedAt,
        })
      : Object.freeze({
          kind: "snapshot_published" as const,
          schemaVersion: 1 as const,
          scope: snapshot.scope,
          artifactId: snapshot.artifactId,
          modality: snapshot.modality,
          snapshotId: snapshot.snapshotId,
          coveredHeadSequence: snapshot.coveredHeadSequence,
          stateHash: snapshot.stateHash,
          publishedAt: snapshot.publishedAt,
        });
  return Object.freeze({
    outboxId,
    event,
    state: "pending",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: snapshot.publishedAt,
    lastErrorCode: null,
    publishedAt: null,
    deadLetteredAt: null,
    createdAt: snapshot.publishedAt,
  });
}

function canonicalNow(clock: EditableArtifactClockPort): string {
  const now = clock.now();
  if (Number.isNaN(now.getTime())) throw new TypeError("Artifact clock returned an invalid date");
  return now.toISOString();
}
