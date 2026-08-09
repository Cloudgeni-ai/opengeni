import {
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_VERSION,
  assertCanonicalSpreadsheetArtifactCommandBytes,
  decodeEditableArtifactMutationIntent,
  hashEditableArtifactMutationIntent,
} from "@opengeni/contracts/editable-artifacts";
import { decodeCommittedTransactionSummary } from "@opengeni/contracts/editable-artifact-committed-transaction";
import { editableArtifactCodecFor } from "@opengeni/contracts/editable-artifact-codec-registry";
import { decodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import type {
  EditableArtifactBlockedPending,
  EditableArtifactCausalFrontier,
  EditableArtifactCommittedTransaction,
  EditableArtifactPendingTransaction,
} from "../types";
import type {
  ArtifactWorkerKernelAdapter,
  ArtifactWorkerKernelAdapterFactory,
  ArtifactWorkerKernelSession,
} from "./kernel-adapter";
import { ArtifactWorkerPendingProjectionError } from "./kernel-adapter";
import {
  ArtifactWorkerProtocolError,
  ArtifactWorkerRpcKind,
  decodeArtifactWorkerRpcMessage,
  encodeArtifactWorkerRpcMessage,
  transferListForArtifactWorkerRpcMessage,
  type ArtifactWorkerRpcLimits,
  type ArtifactWorkerRpcMessage,
} from "./rpc-protocol";
import {
  decodeAuthorPendingMetadata,
  decodeCommittedMetadata,
  decodeInitialize,
  decodePendingListMetadata,
  decodeReconcileMetadata,
  decodeSnapshotMetadata,
  encodeErrorPayload,
  encodePendingListMetadata,
  encodeProjectionResponse,
  encodeStateResponse,
  requireMatchingHash,
  sha256Hex,
  type ArtifactWorkerAuthorPendingInput,
  type ArtifactWorkerInitializeInput,
} from "./wire-codec";

export type ArtifactWorkerMessageEvent = { data: unknown };

export type ArtifactWorkerRuntimeEndpoint = {
  addEventListener: (
    type: "message",
    listener: (event: ArtifactWorkerMessageEvent) => void,
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (event: ArtifactWorkerMessageEvent) => void,
  ) => void;
  postMessage: (message: ArtifactWorkerRpcMessage, transfer: Transferable[]) => void;
};

export type InstallArtifactWorkerRuntimeOptions = {
  endpoint: ArtifactWorkerRuntimeEndpoint;
  loadAdapter: ArtifactWorkerKernelAdapterFactory;
  rpcLimits?: Readonly<ArtifactWorkerRpcLimits>;
  onProtocolError?: (error: ArtifactWorkerProtocolError) => void;
};

type InstalledStateCommon = {
  artifactId: string;
  sequence: number;
  protocolVersion: number;
  kernelVersion: string;
  modelSchemaVersion: number;
  stateHash: string;
};

type InstalledState = InstalledStateCommon &
  (
    | { modality: "spreadsheet"; causalFrontier: EditableArtifactCausalFrontier }
    | { modality: "document" | "presentation"; nativeRevision: number }
  );

const MAX_KNOWN_REQUESTS = 64;
const MAX_QUEUED_REQUEST_BYTES = 192 * 1024 * 1024;
const MAX_PENDING_AGGREGATE_BYTES = 64 * 1024 * 1024;

/** Owns all mutable artifact/WASM state inside one dedicated Worker. */
export class ArtifactWorkerRuntime {
  private readonly endpoint: ArtifactWorkerRuntimeEndpoint;
  private readonly loadAdapter: ArtifactWorkerKernelAdapterFactory;
  private readonly rpcLimits: Readonly<ArtifactWorkerRpcLimits> | undefined;
  private readonly onProtocolError: ((error: ArtifactWorkerProtocolError) => void) | undefined;
  private readonly cancelled = new Set<number>();
  private readonly knownRequests = new Map<number, { bytes: number; generation: number }>();
  private queuedRequestBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private generation: number | null = null;
  private initialization: ArtifactWorkerInitializeInput | null = null;
  private adapter: ArtifactWorkerKernelAdapter | null = null;
  private confirmed: ArtifactWorkerKernelSession | null = null;
  private speculative: ArtifactWorkerKernelSession | null = null;
  private installed: InstalledState | null = null;
  private pendingKeys: readonly string[] = Object.freeze([]);
  private blockedPending: readonly EditableArtifactBlockedPending[] = Object.freeze([]);
  private disposed = false;

  private readonly onMessage = (event: ArtifactWorkerMessageEvent): void => {
    if (this.disposed) return;
    let frame;
    try {
      frame = decodeArtifactWorkerRpcMessage(event.data, this.rpcLimits);
    } catch (error) {
      const failure = asProtocolError(error);
      this.reportProtocolError(failure);
      return;
    }
    if (frame.kind === ArtifactWorkerRpcKind.Cancel) {
      if (
        frame.flags === 0 &&
        frame.metadata.byteLength === 0 &&
        frame.segments.length === 0 &&
        this.knownRequests.get(frame.requestId)?.generation === frame.generation
      ) {
        this.cancelled.add(frame.requestId);
      }
      return;
    }
    if (frame.flags !== 0) {
      this.reportProtocolError(runtimeError("noncanonical", "unknown RPC flags are set"));
      return;
    }
    if (this.knownRequests.has(frame.requestId)) {
      this.reportProtocolError(runtimeError("duplicate_request", "RPC request id is duplicated"));
      return;
    }
    const requestBytes = retainedFrameBytes(frame);
    if (
      this.knownRequests.size >= MAX_KNOWN_REQUESTS ||
      this.queuedRequestBytes + requestBytes > MAX_QUEUED_REQUEST_BYTES
    ) {
      this.respondError(
        frame.requestId,
        runtimeError("request_limit", "artifact Worker request queue is full"),
        frame.generation,
      );
      return;
    }
    this.knownRequests.set(frame.requestId, { bytes: requestBytes, generation: frame.generation });
    this.queuedRequestBytes += requestBytes;
    this.queue = this.queue
      .then(() => this.dispatch(frame))
      .catch((error: unknown) => this.reportProtocolError(asProtocolError(error)));
  };

  constructor(options: InstallArtifactWorkerRuntimeOptions) {
    this.endpoint = options.endpoint;
    this.loadAdapter = options.loadAdapter;
    this.rpcLimits = options.rpcLimits;
    this.onProtocolError = options.onProtocolError;
    this.endpoint.addEventListener("message", this.onMessage);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.endpoint.removeEventListener("message", this.onMessage);
    await this.queue.catch(() => {});
    this.releaseState();
    this.disposeAdapter(this.adapter);
    this.adapter = null;
    this.cancelled.clear();
    this.knownRequests.clear();
    this.queuedRequestBytes = 0;
  }

  private async dispatch(frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>): Promise<void> {
    try {
      if (frame.kind === ArtifactWorkerRpcKind.Initialize) {
        await this.initialize(frame);
        return;
      }
      this.requireInitialized(frame.generation);
      this.throwIfCancelled(frame.requestId);
      switch (frame.kind) {
        case ArtifactWorkerRpcKind.Reset:
          this.requireNoPayload(frame);
          this.releaseState();
          this.respond(frame.requestId);
          return;
        case ArtifactWorkerRpcKind.LoadSnapshot:
          await this.loadSnapshot(frame);
          return;
        case ArtifactWorkerRpcKind.ApplyRecovered:
          await this.applyRecovered(frame);
          return;
        case ArtifactWorkerRpcKind.ReconcileCommitted:
          await this.reconcileCommitted(frame);
          return;
        case ArtifactWorkerRpcKind.ReplacePending:
          await this.replacePending(frame);
          return;
        case ArtifactWorkerRpcKind.AuthorPending:
          await this.authorPending(frame);
          return;
        case ArtifactWorkerRpcKind.QuerySpreadsheet:
          this.queryArtifact(frame);
          return;
        case ArtifactWorkerRpcKind.Dispose:
          this.requireNoPayload(frame);
          this.releaseState();
          this.disposeAdapter(this.adapter);
          this.adapter = null;
          this.respond(frame.requestId);
          return;
        default:
          throw runtimeError("unknown_request", `worker cannot execute RPC kind ${frame.kind}`);
      }
    } catch (error) {
      this.respondError(frame.requestId, error, frame.generation);
    } finally {
      this.cancelled.delete(frame.requestId);
      const retainedBytes = this.knownRequests.get(frame.requestId)?.bytes ?? 0;
      this.knownRequests.delete(frame.requestId);
      this.queuedRequestBytes -= retainedBytes;
    }
  }

  private async initialize(
    frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>,
  ): Promise<void> {
    if (this.generation !== null || this.adapter !== null) {
      throw runtimeError("already_initialized", "artifact Worker is already initialized");
    }
    if (frame.segments.length !== 0)
      throw runtimeError("invalid_segment", "initialize has no segments");
    const initialization = decodeInitialize(frame.metadata);
    this.throwIfCancelled(frame.requestId);
    let adapter: ArtifactWorkerKernelAdapter | null = null;
    try {
      adapter = await this.loadAdapter(initialization);
      this.throwIfCancelled(frame.requestId);
    } catch (error) {
      this.disposeAdapter(adapter);
      throw error;
    }
    assertAdapterCompatibility(adapter, initialization);
    this.generation = frame.generation;
    this.initialization = initialization;
    this.adapter = adapter;
    this.respond(frame.requestId);
  }

  private async loadSnapshot(
    frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>,
  ): Promise<void> {
    const initialization = this.requireInitialization();
    const adapter = this.requireAdapter();
    if (frame.segments.length !== 1)
      throw runtimeError("invalid_segment", "snapshot requires one segment");
    const ownedBytes = requireBytesWithin(
      frame.segments[0]!,
      initialization.maximumSnapshotBytes,
      "snapshot",
    );
    const snapshot = decodeSnapshotMetadata(frame.metadata, ownedBytes);
    if (
      snapshot.modality !== initialization.modality ||
      snapshot.modality !== adapter.modality ||
      (snapshot.modality === "spreadsheet" &&
        snapshot.protocolVersion !== adapter.protocolVersion) ||
      snapshot.kernelVersion !== adapter.kernelVersion ||
      snapshot.modelSchemaVersion !== adapter.modelSchemaVersion
    ) {
      throw runtimeError(
        "unsupported_protocol",
        "snapshot protocol/kernel/schema is incompatible with the loaded collaboration kernel",
      );
    }
    const digest = await sha256Hex(ownedBytes);
    this.throwIfCancelled(frame.requestId);
    requireMatchingHash(digest, snapshot.digest, "snapshot digest");
    const canonical = requireBytesWithin(
      adapter.canonicalizeSnapshot(ownedBytes),
      initialization.maximumSnapshotBytes,
      "canonical snapshot",
    );
    if (!bytesEqual(canonical, ownedBytes)) {
      throw runtimeError(
        "noncanonical_snapshot",
        "server snapshot bytes are not canonical; refusing to persist a different model",
      );
    }
    const nextConfirmed = adapter.open(canonical);
    let nextSpeculative: ArtifactWorkerKernelSession | null = null;
    let stateHash: string;
    try {
      stateHash = await nextConfirmed.stateHash();
      this.throwIfCancelled(frame.requestId);
      requireMatchingHash(stateHash, snapshot.stateHash, "snapshot state");
      if (
        snapshot.modality !== "spreadsheet" &&
        nextConfirmed.nativeRevision() !== snapshot.nativeRevision
      ) {
        throw runtimeError(
          "kernel_diverged",
          "serialized snapshot native revision does not match the WASM session",
        );
      }
      nextSpeculative = nextConfirmed.fork();
      this.throwIfCancelled(frame.requestId);
    } catch (error) {
      this.disposeSession(nextConfirmed);
      this.disposeSession(nextSpeculative);
      throw error;
    }
    if (!nextSpeculative) throw runtimeError("kernel_failed", "kernel fork was not created");
    this.installSessions(
      nextConfirmed,
      nextSpeculative,
      snapshot.modality === "spreadsheet"
        ? {
            artifactId: snapshot.artifactId,
            modality: "spreadsheet",
            sequence: snapshot.sequence,
            protocolVersion: snapshot.protocolVersion,
            kernelVersion: snapshot.kernelVersion,
            modelSchemaVersion: snapshot.modelSchemaVersion,
            stateHash,
            causalFrontier: snapshot.causalFrontier,
          }
        : {
            artifactId: snapshot.artifactId,
            modality: snapshot.modality,
            sequence: snapshot.sequence,
            protocolVersion: adapter.protocolVersion,
            kernelVersion: snapshot.kernelVersion,
            modelSchemaVersion: snapshot.modelSchemaVersion,
            stateHash,
            nativeRevision: snapshot.nativeRevision,
          },
      Object.freeze([]),
      Object.freeze([]),
    );
    this.respond(frame.requestId, encodeStateResponse(stateHash, digest));
  }

  private async applyRecovered(
    frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>,
  ): Promise<void> {
    const initialization = this.requireInitialization();
    if (frame.segments.length !== 1) {
      throw runtimeError("invalid_segment", "recovered transaction requires one operation segment");
    }
    const committedTransactionBytes = requireBytesWithin(
      frame.segments[0]!,
      initialization.maximumCommittedTransactionBytes,
      "committed transaction",
    );
    const transaction = decodeCommittedMetadata(frame.metadata, committedTransactionBytes);
    const result = await this.buildCommittedCandidate(transaction, [], frame.requestId);
    this.installCommittedCandidate(result, transaction, []);
    this.respond(frame.requestId, encodeStateResponse(result.stateHash));
  }

  private async reconcileCommitted(
    frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>,
  ): Promise<void> {
    const initialization = this.requireInitialization();
    const decoded = decodeReconcileMetadata(
      frame.metadata,
      frame.segments,
      initialization.maximumPendingTransactions,
    );
    requireBytesWithin(
      decoded.committed.committedTransactionBytes,
      initialization.maximumCommittedTransactionBytes,
      "committed transaction",
    );
    await this.validatePending(decoded.pending);
    const result = await this.buildCommittedCandidate(
      decoded.committed,
      decoded.pending,
      frame.requestId,
    );
    this.installCommittedCandidate(result, decoded.committed, decoded.pending);
    this.respond(
      frame.requestId,
      encodeProjectionResponse(result.blockedPending, result.stateHash),
    );
  }

  private async replacePending(
    frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>,
  ): Promise<void> {
    const initialization = this.requireInitialization();
    const pending = decodePendingListMetadata(
      frame.metadata,
      frame.segments,
      initialization.maximumPendingTransactions,
    );
    await this.validatePending(pending);
    const keys = pending.map(pendingKey);
    if (arraysEqual(keys, this.pendingKeys)) {
      this.respond(frame.requestId, encodeProjectionResponse(this.blockedPending));
      return;
    }
    const candidate = this.requireConfirmed().fork();
    let blockedPending: readonly EditableArtifactBlockedPending[];
    try {
      blockedPending = this.applyPending(candidate, pending, frame.requestId);
      this.throwIfCancelled(frame.requestId);
    } catch (error) {
      this.disposeSession(candidate);
      throw error;
    }
    const previous = this.speculative;
    this.speculative = candidate;
    this.pendingKeys = Object.freeze(keys);
    this.blockedPending = blockedPending;
    this.disposeSession(previous);
    this.respond(frame.requestId, encodeProjectionResponse(blockedPending));
  }

  private async authorPending(
    frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>,
  ): Promise<void> {
    const initialization = this.requireInitialization();
    const adapter = this.requireAdapter();
    if (frame.segments.length !== 1)
      throw runtimeError("invalid_segment", "author requires one command segment");
    const commandBytes = requireBytesWithin(
      frame.segments[0]!,
      initialization.maximumCommandBytes,
      "pending command",
    );
    const input = decodeAuthorPendingMetadata(frame.metadata, commandBytes);
    if (
      input.modality !== initialization.modality ||
      input.modality !== adapter.modality ||
      input.protocolVersion !== adapter.protocolVersion ||
      input.kernelVersion !== adapter.kernelVersion ||
      input.modelSchemaVersion !== adapter.modelSchemaVersion ||
      input.commandVersion !== adapter.commandVersion
    ) {
      throw runtimeError(
        "unsupported_protocol",
        "pending authoring versions are incompatible with the loaded kernel",
      );
    }
    if (this.installed && input.artifactId !== this.installed.artifactId) {
      throw runtimeError("artifact_mismatch", "pending transaction belongs to another artifact");
    }
    try {
      if (input.modality === "spreadsheet") {
        assertCanonicalSpreadsheetArtifactCommandBytes(commandBytes);
      } else {
        editableArtifactCodecFor({
          durableModality: input.modality,
          modelSchemaVersion: input.modelSchemaVersion,
          commandProtocolVersion: input.commandVersion,
        }).command.assertCanonical(commandBytes);
      }
    } catch (error) {
      throw runtimeError(
        "noncanonical_command",
        `pending ${input.modality} command must be canonical before it receives an identity: ${
          error instanceof Error ? error.message : "invalid command"
        }`,
      );
    }
    const canonicalCommand = commandBytes;
    const authored = authorCanonicalPendingIntent(input, canonicalCommand);
    const intentBytes = requireBytesWithin(
      authored.bytes,
      EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
      "OGATX001 intent",
    );
    this.throwIfCancelled(frame.requestId);
    const commonPending = {
      artifactId: input.artifactId,
      clientTransactionId: input.clientTransactionId,
      requestHash: authored.requestHash,
      protocolVersion: input.protocolVersion,
      modelSchemaVersion: input.modelSchemaVersion,
      commandVersion: input.commandVersion,
      replicaId: input.replicaId,
      replicaCounter: input.replicaCounter,
      previousLocalTransactionId: input.previousLocalTransactionId,
      observedHeadSequence: input.observedHeadSequence,
      commandBytes: canonicalCommand,
      intentBytes,
      createdAt: input.createdAt,
    } as const;
    let pending: EditableArtifactPendingTransaction;
    if (input.modality === "spreadsheet") {
      pending = Object.freeze({
        ...commonPending,
        modality: "spreadsheet",
        causalBase: input.causalBase ?? [],
        selectiveUndoTargets: input.selectiveUndoTargets ?? [],
      });
    } else {
      const installed = this.requireInstalled();
      if (installed.modality !== input.modality) {
        throw runtimeError("modality_mismatch", "pending modality does not match installed state");
      }
      const expectedHeadSequence = installed.sequence + this.pendingKeys.length;
      if (input.observedHeadSequence !== expectedHeadSequence) {
        throw runtimeError(
          "serialized_head_conflict",
          "serialized pending command was not authored over the speculative head",
        );
      }
      pending = Object.freeze({
        ...commonPending,
        modality: input.modality,
        observedNativeRevision: this.requireSpeculative().nativeRevision(),
      });
    }
    const metadata = encodePendingListMetadata([pending]);
    // Both buffers are exclusively Worker-owned here: the command arrived by
    // transfer and OGATX authoring allocated the intent. Return them without a
    // second multi-megabyte copy.
    const command = transferableOwnedBuffer(canonicalCommand);
    const intent = transferableOwnedBuffer(intentBytes);
    this.respond(frame.requestId, metadata, [command, intent]);
  }

  private queryArtifact(frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>): void {
    if (frame.metadata.byteLength !== 0 || frame.segments.length !== 1) {
      throw runtimeError("invalid_segment", "artifact query requires one byte segment");
    }
    const initialization = this.requireInitialization();
    const queryBytes = requireBytesWithin(
      frame.segments[0]!,
      initialization.maximumQueryBytes,
      `${initialization.modality} query`,
    );
    const result = requireBytesWithin(
      this.requireSpeculative().query(queryBytes),
      initialization.maximumQueryResponseBytes,
      `${initialization.modality} projection`,
    );
    this.throwIfCancelled(frame.requestId);
    this.respond(frame.requestId, undefined, [transferableOwnedBuffer(result)]);
  }

  private async buildCommittedCandidate(
    transaction: EditableArtifactCommittedTransaction,
    remainingPending: readonly EditableArtifactPendingTransaction[],
    requestId: number,
  ): Promise<{
    confirmed: ArtifactWorkerKernelSession;
    speculative: ArtifactWorkerKernelSession;
    stateHash: string;
    blockedPending: readonly EditableArtifactBlockedPending[];
  }> {
    const installed = this.requireInstalled();
    if (transaction.artifactId !== installed.artifactId) {
      throw runtimeError("artifact_mismatch", "committed transaction belongs to another artifact");
    }
    if (transaction.modality !== installed.modality) {
      throw runtimeError("modality_mismatch", "committed transaction modality is incompatible");
    }
    if (
      transaction.modality === "spreadsheet" &&
      transaction.protocolVersion !== installed.protocolVersion
    )
      throw runtimeError("unsupported_protocol", "committed transaction protocol is incompatible");
    if (transaction.startSequence !== installed.sequence + 1) {
      throw runtimeError("invalid_sequence", "committed transaction is not contiguous");
    }
    assertCommittedEnvelopeMatchesOuter(transaction);
    if (transaction.modality === "spreadsheet" && installed.modality === "spreadsheet") {
      requireFrontierAdvance(installed.causalFrontier, transaction.causalFrontier);
    } else if (transaction.modality !== "spreadsheet" && installed.modality !== "spreadsheet") {
      if (transaction.priorNativeRevision !== installed.nativeRevision) {
        throw runtimeError("invalid_revision", "serialized commit prior revision is not current");
      }
    }
    requireMatchingHash(installed.stateHash, transaction.priorStateHash, "transaction prior state");
    const nextConfirmed = this.requireConfirmed().fork();
    let nextSpeculative: ArtifactWorkerKernelSession | null = null;
    try {
      if (transaction.modality === "spreadsheet") {
        nextConfirmed.applyCommitted(transaction.committedTransactionBytes);
      } else {
        const summary = decodeEditableArtifactSerializedCommit(
          transaction.committedTransactionBytes,
          transaction.modality,
        );
        const intent = decodeEditableArtifactMutationIntent(summary.intentBytes);
        const nativeReceipt = nextConfirmed.applyCommands(intent.commandBytes);
        if (!bytesEqual(nativeReceipt, summary.nativeReceiptBytes)) {
          throw runtimeError(
            "kernel_diverged",
            "WASM native receipt differs from the exact durable OGAST receipt",
          );
        }
        if (nextConfirmed.nativeRevision() !== transaction.nativeRevision) {
          throw runtimeError(
            "kernel_diverged",
            "WASM native revision differs from the exact durable OGAST revision",
          );
        }
      }
      const stateHash = await nextConfirmed.stateHash();
      this.throwIfCancelled(requestId);
      requireMatchingHash(stateHash, transaction.stateHash, "committed state");
      nextSpeculative = nextConfirmed.fork();
      const blockedPending = this.applyPending(
        nextSpeculative,
        remainingPending,
        requestId,
        transaction.endSequence,
      );
      this.throwIfCancelled(requestId);
      return {
        confirmed: nextConfirmed,
        speculative: nextSpeculative,
        stateHash,
        blockedPending,
      };
    } catch (error) {
      this.disposeSession(nextConfirmed);
      this.disposeSession(nextSpeculative);
      throw error;
    }
  }

  private installCommittedCandidate(
    candidate: {
      confirmed: ArtifactWorkerKernelSession;
      speculative: ArtifactWorkerKernelSession;
      stateHash: string;
      blockedPending: readonly EditableArtifactBlockedPending[];
    },
    transaction: EditableArtifactCommittedTransaction,
    pending: readonly EditableArtifactPendingTransaction[],
  ): void {
    const installed = this.requireInstalled();
    this.installSessions(
      candidate.confirmed,
      candidate.speculative,
      transaction.modality === "spreadsheet"
        ? {
            ...installed,
            modality: "spreadsheet",
            sequence: transaction.endSequence,
            stateHash: candidate.stateHash,
            causalFrontier: transaction.causalFrontier,
          }
        : {
            ...installed,
            modality: transaction.modality,
            sequence: transaction.endSequence,
            stateHash: candidate.stateHash,
            nativeRevision: transaction.nativeRevision,
          },
      Object.freeze(pending.map(pendingKey)),
      candidate.blockedPending,
    );
  }

  private applyPending(
    session: ArtifactWorkerKernelSession,
    pending: readonly EditableArtifactPendingTransaction[],
    requestId: number,
    baseSequence = this.requireInstalled().sequence,
  ): readonly EditableArtifactBlockedPending[] {
    const blocked: EditableArtifactBlockedPending[] = [];
    const blockedIds = new Set<string>();
    for (const transaction of pending) {
      this.throwIfCancelled(requestId);
      if (
        transaction.previousLocalTransactionId !== null &&
        blockedIds.has(transaction.previousLocalTransactionId)
      ) {
        blockedIds.add(transaction.clientTransactionId);
        blocked.push(
          Object.freeze({
            clientTransactionId: transaction.clientTransactionId,
            code: "blocked_predecessor",
          }),
        );
        continue;
      }
      try {
        if (transaction.modality === "spreadsheet") {
          session.applyPending(transaction.intentBytes);
        } else {
          if (
            transaction.observedHeadSequence !== baseSequence ||
            transaction.observedNativeRevision !== session.nativeRevision()
          ) {
            throw new ArtifactWorkerPendingProjectionError(
              "serialized_head_conflict",
              "serialized pending transaction is stale",
            );
          }
          session.applyCommands(transaction.commandBytes);
          baseSequence += 1;
        }
      } catch (error) {
        if (!(error instanceof ArtifactWorkerPendingProjectionError)) throw error;
        blockedIds.add(transaction.clientTransactionId);
        blocked.push(
          Object.freeze({ clientTransactionId: transaction.clientTransactionId, code: error.code }),
        );
      }
    }
    return Object.freeze(blocked);
  }

  private async validatePending(
    pending: readonly EditableArtifactPendingTransaction[],
  ): Promise<void> {
    const initialization = this.requireInitialization();
    const installed = this.requireInstalled();
    const adapter = this.requireAdapter();
    const ids = new Set<string>();
    let aggregateBytes = 0;
    for (const transaction of pending) {
      if (transaction.artifactId !== installed.artifactId) {
        throw runtimeError("artifact_mismatch", "pending transaction belongs to another artifact");
      }
      if (transaction.modality !== installed.modality) {
        throw runtimeError("modality_mismatch", "pending transaction modality is incompatible");
      }
      if (
        transaction.protocolVersion !== installed.protocolVersion ||
        transaction.modelSchemaVersion !== installed.modelSchemaVersion ||
        transaction.commandVersion !== adapter.commandVersion
      ) {
        throw runtimeError(
          "unsupported_protocol",
          "pending transaction versions are incompatible with confirmed state",
        );
      }
      if (ids.has(transaction.clientTransactionId)) {
        throw runtimeError("duplicate_transaction", "pending transaction id is duplicated");
      }
      ids.add(transaction.clientTransactionId);
      requireBytesWithin(
        transaction.commandBytes,
        initialization.maximumCommandBytes,
        "pending command",
      );
      requireBytesWithin(
        transaction.intentBytes,
        initialization.maximumIntentBytes,
        "pending intent",
      );
      try {
        if (transaction.modality === "spreadsheet") {
          assertCanonicalSpreadsheetArtifactCommandBytes(transaction.commandBytes);
        } else {
          editableArtifactCodecFor({
            durableModality: transaction.modality,
            modelSchemaVersion: transaction.modelSchemaVersion,
            commandProtocolVersion: transaction.commandVersion,
          }).command.assertCanonical(transaction.commandBytes);
        }
      } catch (error) {
        throw new ArtifactWorkerProtocolError(
          "noncanonical_command",
          `pending transaction contains noncanonical ${transaction.modality} command bytes`,
          { cause: error },
        );
      }
      verifyCanonicalPendingIntent(transaction);
      aggregateBytes += transaction.commandBytes.byteLength + transaction.intentBytes.byteLength;
      if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_PENDING_AGGREGATE_BYTES) {
        throw runtimeError("limit_exceeded", "pending commands exceed their aggregate byte limit");
      }
    }
  }

  private installSessions(
    confirmed: ArtifactWorkerKernelSession,
    speculative: ArtifactWorkerKernelSession,
    installed: InstalledState,
    pendingKeys: readonly string[],
    blockedPending: readonly EditableArtifactBlockedPending[],
  ): void {
    const previousConfirmed = this.confirmed;
    const previousSpeculative = this.speculative;
    this.confirmed = confirmed;
    this.speculative = speculative;
    this.installed = Object.freeze(installed);
    this.pendingKeys = pendingKeys;
    this.blockedPending = blockedPending;
    this.disposeSession(previousConfirmed);
    this.disposeSession(previousSpeculative);
  }

  private releaseState(): void {
    const confirmed = this.confirmed;
    const speculative = this.speculative;
    this.confirmed = null;
    this.speculative = null;
    this.installed = null;
    this.pendingKeys = Object.freeze([]);
    this.blockedPending = Object.freeze([]);
    this.disposeSession(confirmed);
    this.disposeSession(speculative);
  }

  private disposeSession(session: ArtifactWorkerKernelSession | null): void {
    if (!session) return;
    try {
      session.dispose();
    } catch (error) {
      this.reportProtocolError(asProtocolError(error));
    }
  }

  private disposeAdapter(adapter: ArtifactWorkerKernelAdapter | null): void {
    if (!adapter?.dispose) return;
    try {
      adapter.dispose();
    } catch (error) {
      this.reportProtocolError(asProtocolError(error));
    }
  }

  private reportProtocolError(error: ArtifactWorkerProtocolError): void {
    try {
      this.onProtocolError?.(error);
    } catch {
      // Diagnostics must never acquire authority over Worker state or cleanup.
    }
  }

  private requireNoPayload(frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>): void {
    if (frame.metadata.byteLength !== 0 || frame.segments.length !== 0) {
      throw runtimeError("unexpected_payload", "RPC operation must not contain a payload");
    }
  }

  private requireInitialized(generation: number): void {
    if (this.generation === null || this.adapter === null || this.initialization === null) {
      throw runtimeError("not_initialized", "artifact Worker is not initialized");
    }
    if (generation !== this.generation) {
      throw runtimeError("stale_generation", "RPC belongs to a retired Worker generation");
    }
  }

  private requireInitialization(): ArtifactWorkerInitializeInput {
    if (!this.initialization)
      throw runtimeError("not_initialized", "artifact Worker is not initialized");
    return this.initialization;
  }

  private requireAdapter(): ArtifactWorkerKernelAdapter {
    if (!this.adapter) throw runtimeError("not_initialized", "artifact Worker is not initialized");
    return this.adapter;
  }

  private requireConfirmed(): ArtifactWorkerKernelSession {
    if (!this.confirmed)
      throw runtimeError("snapshot_required", "artifact Worker has no confirmed state");
    return this.confirmed;
  }

  private requireSpeculative(): ArtifactWorkerKernelSession {
    if (!this.speculative) {
      throw runtimeError("snapshot_required", "artifact Worker has no speculative state");
    }
    return this.speculative;
  }

  private requireInstalled(): InstalledState {
    if (!this.installed)
      throw runtimeError("snapshot_required", "artifact Worker has no installed snapshot");
    return this.installed;
  }

  private throwIfCancelled(requestId: number): void {
    if (this.cancelled.has(requestId))
      throw runtimeError("cancelled", "artifact Worker request was cancelled");
  }

  private respond(requestId: number, metadata?: Uint8Array, segments?: ArrayBuffer[]): void {
    if (this.generation === null || this.cancelled.has(requestId)) return;
    const response = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Response,
      generation: this.generation,
      requestId,
      ...(metadata ? { metadata } : {}),
      ...(segments ? { segments } : {}),
      ...(this.rpcLimits ? { limits: this.rpcLimits } : {}),
    });
    this.endpoint.postMessage(response, transferListForArtifactWorkerRpcMessage(response));
  }

  private respondError(requestId: number, error: unknown, generation = this.generation): void {
    if (generation === null || this.cancelled.has(requestId)) return;
    const failure = asWorkerFailure(error);
    const response = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Error,
      generation,
      requestId,
      metadata: encodeErrorPayload(failure),
      ...(this.rpcLimits ? { limits: this.rpcLimits } : {}),
    });
    this.endpoint.postMessage(response, transferListForArtifactWorkerRpcMessage(response));
  }
}

function authorCanonicalPendingIntent(
  input: ArtifactWorkerAuthorPendingInput,
  canonicalCommand: Uint8Array,
): { bytes: Uint8Array; requestHash: string } {
  try {
    return hashEditableArtifactMutationIntent(canonicalMutationIntent(input, canonicalCommand));
  } catch (error) {
    throw new ArtifactWorkerProtocolError(
      "invalid_intent",
      "pending transaction cannot be represented by canonical OGATX001",
      { cause: error },
    );
  }
}

function transferableOwnedBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

function verifyCanonicalPendingIntent(transaction: EditableArtifactPendingTransaction): void {
  let expected: { bytes: Uint8Array; requestHash: string };
  try {
    expected = hashEditableArtifactMutationIntent(
      canonicalMutationIntent(transaction, transaction.commandBytes),
    );
  } catch (error) {
    throw new ArtifactWorkerProtocolError(
      "intent_mismatch",
      "pending transaction metadata is not valid canonical OGATX001 input",
      { cause: error },
    );
  }
  if (
    expected.requestHash !== transaction.requestHash ||
    !bytesEqual(expected.bytes, transaction.intentBytes)
  ) {
    throw runtimeError(
      "intent_mismatch",
      "pending transaction bytes do not bind its exact metadata and command",
    );
  }
}

function assertAdapterCompatibility(
  adapter: ArtifactWorkerKernelAdapter,
  initialization: ArtifactWorkerInitializeInput,
): void {
  if (adapter.modality !== initialization.modality) {
    throw runtimeError("modality_mismatch", "loaded kernel modality does not match initialization");
  }
  if (
    adapter.kernelVersion !== initialization.kernelVersion ||
    adapter.protocolVersion !== initialization.protocolVersion ||
    adapter.modelSchemaVersion !== initialization.modelSchemaVersion ||
    adapter.commandVersion !== initialization.commandVersion
  ) {
    throw runtimeError(
      "runtime_identity_mismatch",
      "loaded kernel build/protocol/model identity does not match its package",
    );
  }
  const limits = [
    [adapter.maximumSnapshotBytes, initialization.maximumSnapshotBytes, "snapshot"],
    [adapter.maximumCommandBytes, initialization.maximumCommandBytes, "command"],
    [adapter.maximumIntentBytes, initialization.maximumIntentBytes, "intent"],
    [
      adapter.maximumCommittedTransactionBytes,
      initialization.maximumCommittedTransactionBytes,
      "committed transaction",
    ],
    [adapter.maximumQueryBytes, initialization.maximumQueryBytes, "query"],
    [adapter.maximumQueryResponseBytes, initialization.maximumQueryResponseBytes, "query response"],
  ] as const;
  for (const [advertised, requested, label] of limits) {
    if (advertised < requested) {
      throw runtimeError(
        "unsupported_protocol",
        `loaded collaboration kernel ${label} limit is below the requested Worker limit`,
      );
    }
  }
}

/**
 * Outer delivery/index fields remain useful for storage and routing, but every
 * semantic field duplicated by OGACO must agree exactly before Rust sees it.
 */
function assertCommittedEnvelopeMatchesOuter(
  transaction: EditableArtifactCommittedTransaction,
): void {
  if (transaction.modality !== "spreadsheet") {
    let summary: ReturnType<typeof decodeEditableArtifactSerializedCommit>;
    try {
      summary = decodeEditableArtifactSerializedCommit(
        transaction.committedTransactionBytes,
        transaction.modality,
      );
    } catch (error) {
      throw new ArtifactWorkerProtocolError(
        "invalid_committed_transaction",
        "committed transaction is not canonical OGAST001",
        { cause: error },
      );
    }
    if (
      summary.commitProtocolVersion !== transaction.commitProtocolVersion ||
      summary.transactionId !== transaction.transactionId ||
      summary.requestHash !== transaction.requestHash ||
      summary.parentHeadSequence + 1 !== transaction.startSequence ||
      summary.resultHeadSequence !== transaction.endSequence ||
      summary.priorNativeRevision !== transaction.priorNativeRevision ||
      summary.nativeReceipt.revision !== transaction.nativeRevision ||
      summary.priorStateHash !== transaction.priorStateHash ||
      summary.stateHash !== transaction.stateHash
    ) {
      throw runtimeError(
        "committed_metadata_mismatch",
        "outer committed metadata disagrees with its exact OGAST001 envelope",
      );
    }
    return;
  }
  let summary: ReturnType<typeof decodeCommittedTransactionSummary>;
  try {
    summary = decodeCommittedTransactionSummary(transaction.committedTransactionBytes);
  } catch (error) {
    throw new ArtifactWorkerProtocolError(
      "invalid_committed_transaction",
      "committed transaction is not canonical OGACO001",
      { cause: error },
    );
  }
  if (
    summary.operationProtocolVersion !== transaction.protocolVersion ||
    summary.transactionId !== transaction.transactionId ||
    summary.priorStateHash !== transaction.priorStateHash ||
    summary.stateHash !== transaction.stateHash ||
    !frontiersEqual(summary.resultingCausalFrontier, transaction.causalFrontier)
  ) {
    throw runtimeError(
      "committed_metadata_mismatch",
      "outer committed metadata disagrees with its exact OGACO001 envelope",
    );
  }
}

function frontiersEqual(
  left: readonly Readonly<{ replicaId: string; counter: number }>[],
  right: EditableArtifactCausalFrontier,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.replicaId === right[index]?.replicaId && entry.counter === right[index]?.counter,
    )
  );
}

function canonicalMutationIntent(
  input: ArtifactWorkerAuthorPendingInput | EditableArtifactPendingTransaction,
  commandBytes: Uint8Array,
) {
  return {
    envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
    protocolVersion: input.protocolVersion,
    modelSchemaVersion: input.modelSchemaVersion,
    commandProtocolVersion: input.commandVersion,
    artifactId: input.artifactId,
    clientTransactionId: input.clientTransactionId,
    replicaId: input.replicaId,
    replicaCounter: input.replicaCounter,
    previousLocalTransactionId: input.previousLocalTransactionId,
    observedHeadSequence: input.observedHeadSequence,
    causalBase: input.modality === "spreadsheet" ? (input.causalBase ?? []) : [],
    selectiveUndoOperationIds:
      input.modality === "spreadsheet" ? (input.selectiveUndoTargets ?? []) : [],
    commandBytes,
  } as const;
}

function retainedFrameBytes(frame: ReturnType<typeof decodeArtifactWorkerRpcMessage>): number {
  let bytes = frame.metadata.byteLength;
  for (const segment of frame.segments) bytes += segment.byteLength;
  if (!Number.isSafeInteger(bytes)) {
    throw runtimeError("size_overflow", "artifact Worker request byte count overflowed");
  }
  return bytes;
}

function requireBytesWithin(bytes: Uint8Array, maximum: number, label: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw runtimeError("invalid_bytes", `${label} must be non-empty bytes`);
  }
  if (bytes.byteLength > maximum)
    throw runtimeError("limit_exceeded", `${label} exceeds its byte limit`);
  return bytes;
}

function pendingKey(transaction: EditableArtifactPendingTransaction): string {
  return `${transaction.clientTransactionId}\0${transaction.requestHash}`;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireFrontierAdvance(
  previous: EditableArtifactCausalFrontier,
  next: EditableArtifactCausalFrontier,
): void {
  const nextByReplica = new Map(next.map((entry) => [entry.replicaId, entry.counter]));
  for (const entry of previous) {
    if ((nextByReplica.get(entry.replicaId) ?? -1) < entry.counter) {
      throw runtimeError("invalid_frontier", "committed causal frontier regresses");
    }
  }
}

type WorkerFailure = { code: string; message: string; retryable: boolean };

function asWorkerFailure(error: unknown): WorkerFailure {
  if (error instanceof ArtifactWorkerProtocolError) {
    return {
      code: normalizeErrorCode(error.code),
      message: sanitizeErrorMessage(error.message),
      retryable: false,
    };
  }
  if (error instanceof Error) {
    return {
      code: "kernel_failed",
      message: sanitizeErrorMessage(error.message || "artifact kernel failed"),
      retryable: false,
    };
  }
  return { code: "kernel_failed", message: "artifact kernel failed", retryable: false };
}

function asProtocolError(error: unknown): ArtifactWorkerProtocolError {
  if (error instanceof ArtifactWorkerProtocolError) return error;
  return new ArtifactWorkerProtocolError(
    "runtime_failed",
    error instanceof Error ? error.message : "artifact Worker runtime failed",
    { cause: error },
  );
}

function normalizeErrorCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "kernel_failed";
}

function sanitizeErrorMessage(value: string): string {
  let output = "";
  for (let index = 0; index < value.length && output.length < 2_000; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) {
        output += value[index]! + value[index + 1]!;
        index += 1;
      } else {
        output += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\ufffd";
    } else {
      output += value[index]!;
    }
  }
  return output || "artifact kernel failed";
}

function runtimeError(code: string, message: string): ArtifactWorkerProtocolError {
  return new ArtifactWorkerProtocolError(code, message);
}
