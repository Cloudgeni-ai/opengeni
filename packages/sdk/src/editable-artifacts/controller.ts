import {
  decodeEditableArtifactMutationIntent,
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
  hashEditableArtifactMutationIntentBytes,
} from "@opengeni/contracts/editable-artifacts";
import {
  decodeCommittedTransactionSummary,
  MAX_COMMITTED_TRANSACTION_BYTES,
} from "@opengeni/contracts/editable-artifact-committed-transaction";
import { editableArtifactCodecFor } from "@opengeni/contracts/editable-artifact-codec-registry";
import { decodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import { EditableArtifactSyncError } from "./errors";
import { EditableArtifactStorageConflictError } from "./storage";
import type { EditableArtifactStoragePort, EditableArtifactStorageScope } from "./storage";
import type {
  EditableArtifactBootstrap,
  EditableArtifactBlockedPending,
  EditableArtifactCausalFrontier,
  EditableArtifactCommittedTransaction,
  EditableArtifactId,
  EditableArtifactLiveConnection,
  EditableArtifactLiveLimits,
  EditableArtifactLiveMessage,
  EditableArtifactModality,
  EditableArtifactPendingTransaction,
  EditableArtifactSerializedCommittedTransaction,
  EditableArtifactSerializedModality,
  EditableArtifactSerializedSnapshot,
  EditableArtifactSpreadsheetCommittedTransaction,
  EditableArtifactSpreadsheetPendingTransaction,
  EditableArtifactSpreadsheetSnapshot,
  EditableArtifactStoredReplica,
  EditableArtifactSubmitReceipt,
  EditableArtifactSyncListener,
  EditableArtifactSyncScheduler,
  EditableArtifactSyncState,
  EditableArtifactSyncTicket,
  EditableArtifactSyncTransport,
  EditableArtifactSyncView,
  EditableArtifactWorkerKernel,
} from "./types";

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_REPLAY_PAGE_SIZE = 256;
const DEFAULT_MAX_QUEUE_MESSAGES = 512;
const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STORED_TAIL = 8_192;
const DEFAULT_MAX_SNAPSHOT_BYTES = EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES;
const DEFAULT_MAX_COMMAND_BYTES = EDITABLE_ARTIFACT_COMMAND_MAX_BYTES;
const DEFAULT_MAX_OPERATION_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REPLAY_PAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PENDING_TRANSACTIONS = 256;
const DEFAULT_MAX_PENDING_BYTES = 32 * 1024 * 1024;
const DEFAULT_MIN_TICKET_TTL_MS = 5_000;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_KERNEL_VERSION_BYTES = 512;
const MAX_TICKET_BYTES = 4_096;
const MAX_FRONTIER_ACTORS = 1_024;

export type CreateEditableArtifactSyncControllerOptions = {
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  /** Authenticated cache authority; every field participates in IndexedDB partitioning. */
  storageAuthority: EditableArtifactCacheAuthority;
  transport: EditableArtifactSyncTransport;
  storage: EditableArtifactStoragePort;
  kernel: EditableArtifactWorkerKernel;
  kernelVersion: string;
  modelSchemaVersion: number;
  commandVersion: number;
  protocolVersion?: number;
  replayPageSize?: number;
  maxQueuedMessages?: number;
  maxQueuedBytes?: number;
  maxStoredTailTransactions?: number;
  maxSnapshotBytes?: number;
  maxCommandBytes?: number;
  maxCommittedTransactionBytes?: number;
  maxReplayPageBytes?: number;
  maxPendingTransactions?: number;
  maxPendingBytes?: number;
  minTicketTtlMs?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  scheduler?: EditableArtifactSyncScheduler;
  clientTransactionIdFactory?: () => string;
  /** Tests/embedded runtimes may inject; defaults to a fresh per-controller UUID. */
  writerReplicaIdFactory?: () => string;
};

export type EditableArtifactCacheAuthority = {
  deploymentOrigin: string;
  accountId: string;
  workspaceId: string;
  principalId: string;
  /** Host-auth revision/session epoch; rotate on logout, grant change, or account switch. */
  authorizationEpoch: string;
};

export type EditableArtifactQueueCommandsInput = {
  commandBytes: Uint8Array;
  selectiveUndoTargets?: readonly string[];
  /** Optional deterministic ID for host-driven retries before WAL persistence. */
  clientTransactionId?: string;
};

export type EditableArtifactSyncController = {
  readonly artifactId: EditableArtifactId;
  readonly modality: EditableArtifactModality;
  start: () => void;
  whenLive: () => Promise<void>;
  close: () => Promise<void>;
  getView: () => EditableArtifactSyncView;
  subscribe: (listener: EditableArtifactSyncListener) => () => void;
  /** Kernel authors/hashes the immutable envelope; SDK WAL persists before delivery. */
  queueCommands: (
    input: EditableArtifactQueueCommandsInput,
  ) => Promise<EditableArtifactPendingTransaction>;
};

type QueuedLiveMessage = {
  message: EditableArtifactLiveMessage;
  bytes: number;
};

type LiveWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type ControllerReplicaCommon = {
  cursor: number;
  stateHash: string;
  updatedAt: number;
};

type ControllerReplica = ControllerReplicaCommon &
  (
    | {
        modality: "spreadsheet";
        snapshot: EditableArtifactSpreadsheetSnapshot;
        causalFrontier: EditableArtifactCausalFrontier;
      }
    | {
        modality: EditableArtifactSerializedModality;
        snapshot: EditableArtifactSerializedSnapshot;
        nativeRevision: number;
      }
  );

export function createEditableArtifactSyncController(
  options: CreateEditableArtifactSyncControllerOptions,
): EditableArtifactSyncController {
  return new EditableArtifactSyncControllerImpl(options);
}

class EditableArtifactSyncControllerImpl implements EditableArtifactSyncController {
  readonly artifactId: EditableArtifactId;
  readonly modality: EditableArtifactModality;

  private readonly transport: EditableArtifactSyncTransport;
  private readonly storage: EditableArtifactStoragePort;
  private readonly storageScope: EditableArtifactStorageScope;
  private readonly kernel: EditableArtifactWorkerKernel;
  private readonly writerReplicaId: string;
  private readonly kernelVersion: string;
  private readonly modelSchemaVersion: number;
  private readonly commandVersion: number;
  private readonly protocolVersion: number;
  private readonly replayPageSize: number;
  private readonly maxQueuedMessages: number;
  private readonly maxQueuedBytes: number;
  private readonly maxStoredTailTransactions: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxCommandBytes: number;
  private readonly maxCommittedTransactionBytes: number;
  private readonly maxReplayPageBytes: number;
  private readonly maxPendingTransactions: number;
  private readonly maxPendingBytes: number;
  private readonly minTicketTtlMs: number;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly scheduler: EditableArtifactSyncScheduler;
  private readonly clientTransactionIdFactory: () => string;

  private readonly abortController = new AbortController();
  private readonly listeners = new Set<EditableArtifactSyncListener>();
  private readonly liveWaiters = new Set<LiveWaiter>();
  private readonly pending = new Map<string, EditableArtifactPendingTransaction>();
  private blockedPending: readonly EditableArtifactBlockedPending[] = [];
  private readonly submitBlockedPending = new Map<string, EditableArtifactBlockedPending>();

  private state: EditableArtifactSyncState = "idle";
  private cursor = 0;
  private headSequence = 0;
  private reconnectAttempt = 0;
  private lastError: Error | null = null;
  private writable = false;
  private replica: ControllerReplica | null = null;
  private retainedTailTransactions = 0;
  private retainedStorageHead: { cursor: number; stateHash: string } | null = null;
  private initialized = false;
  private initializeTask: Promise<void> | null = null;
  private runTask: Promise<void> | null = null;
  private activeTicket: EditableArtifactSyncTicket | null = null;
  private activeConnection: EditableArtifactLiveConnection | null = null;
  private activeLimits: EditableArtifactLiveLimits | null = null;
  private activeEpoch = 0;
  private connectionReady = false;
  private requireSnapshot = false;
  private queuedBytes = 0;
  private readonly liveQueue: QueuedLiveMessage[] = [];
  private drainTask: Promise<void> | null = null;
  private processingFailure: Error | null = null;
  private flushTask: Promise<void> | null = null;
  private readonly flushTasks = new Set<Promise<void>>();
  /**
   * Serializes every operation that moves the Worker and controller causal
   * heads. The Worker commits before its RPC response reaches this thread, so
   * authoring must not observe the controller cursor during that response gap.
   */
  private causalTail: Promise<void> = Promise.resolve();
  private resyncRevision = 0;
  private readonly submittedEpoch = new Map<string, number>();
  /** Receipt-proven mapping from authoritative OGACO/OGAST ids to caller OGATX ids. */
  private readonly acceptedMappings = new Map<
    string,
    Readonly<{ clientTransactionId: string; requestHash: string }>
  >();
  private lastLocalTransactionId: string | null = null;
  private lastLocalReplicaCounter = 0;

  constructor(options: CreateEditableArtifactSyncControllerOptions) {
    this.artifactId = requireStableId(options.artifactId, "artifactId");
    this.modality = requireModality(options.modality);
    this.transport = options.transport;
    this.storage = options.storage;
    this.storageScope = {
      namespace: editableArtifactCacheNamespace(options.storageAuthority),
      artifactId: this.artifactId,
      modality: this.modality,
    };
    this.kernel = options.kernel;
    this.writerReplicaId = boundedNonEmpty(
      (options.writerReplicaIdFactory ?? defaultWriterReplicaId)(),
      "writerReplicaId",
      MAX_IDENTIFIER_BYTES,
    );
    requireReplicaId(this.writerReplicaId, "writerReplicaId");
    this.kernelVersion = boundedNonEmpty(
      options.kernelVersion,
      "kernelVersion",
      MAX_KERNEL_VERSION_BYTES,
    );
    this.modelSchemaVersion = positiveSafeInteger(options.modelSchemaVersion, "modelSchemaVersion");
    this.commandVersion = positiveSafeInteger(options.commandVersion, "commandVersion");
    this.protocolVersion = positiveSafeInteger(
      options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      "protocolVersion",
    );
    this.replayPageSize = positiveSafeInteger(
      options.replayPageSize ?? DEFAULT_REPLAY_PAGE_SIZE,
      "replayPageSize",
    );
    this.maxQueuedMessages = positiveSafeInteger(
      options.maxQueuedMessages ?? DEFAULT_MAX_QUEUE_MESSAGES,
      "maxQueuedMessages",
    );
    this.maxQueuedBytes = positiveSafeInteger(
      options.maxQueuedBytes ?? DEFAULT_MAX_QUEUE_BYTES,
      "maxQueuedBytes",
    );
    this.maxStoredTailTransactions = positiveSafeInteger(
      options.maxStoredTailTransactions ?? DEFAULT_MAX_STORED_TAIL,
      "maxStoredTailTransactions",
    );
    this.maxSnapshotBytes = positiveSafeInteger(
      options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
      "maxSnapshotBytes",
    );
    this.maxCommandBytes = positiveSafeInteger(
      options.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES,
      "maxCommandBytes",
    );
    if (this.maxCommandBytes > EDITABLE_ARTIFACT_COMMAND_MAX_BYTES) {
      throw new RangeError("maxCommandBytes exceeds the editable-artifact contract bound");
    }
    this.maxCommittedTransactionBytes = positiveSafeInteger(
      options.maxCommittedTransactionBytes ?? DEFAULT_MAX_OPERATION_BYTES,
      "maxCommittedTransactionBytes",
    );
    this.maxReplayPageBytes = positiveSafeInteger(
      options.maxReplayPageBytes ?? DEFAULT_MAX_REPLAY_PAGE_BYTES,
      "maxReplayPageBytes",
    );
    this.maxPendingTransactions = positiveSafeInteger(
      options.maxPendingTransactions ?? DEFAULT_MAX_PENDING_TRANSACTIONS,
      "maxPendingTransactions",
    );
    this.maxPendingBytes = positiveSafeInteger(
      options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
      "maxPendingBytes",
    );
    this.minTicketTtlMs = nonNegativeSafeInteger(
      options.minTicketTtlMs ?? DEFAULT_MIN_TICKET_TTL_MS,
      "minTicketTtlMs",
    );
    this.reconnectDelayMs = nonNegativeSafeInteger(
      options.reconnectDelayMs ?? 250,
      "reconnectDelayMs",
    );
    this.maxReconnectDelayMs = nonNegativeSafeInteger(
      options.maxReconnectDelayMs ?? 5_000,
      "maxReconnectDelayMs",
    );
    this.maxReconnectAttempts =
      options.maxReconnectAttempts === undefined
        ? Number.POSITIVE_INFINITY
        : nonNegativeSafeInteger(options.maxReconnectAttempts, "maxReconnectAttempts");
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clientTransactionIdFactory =
      options.clientTransactionIdFactory ?? (() => crypto.randomUUID());
  }

  start(): void {
    if (this.runTask || this.state === "closed") return;
    this.runTask = this.run().catch((error: unknown) => {
      if (this.abortController.signal.aborted) return;
      const failure = asError(error);
      if (failure instanceof EditableArtifactSyncError && failure.code === "unsupported_protocol") {
        this.lastError = failure;
        this.setState("unsupported");
        this.rejectLiveWaiters(failure);
        return;
      }
      this.fail(failure);
    });
  }

  async whenLive(): Promise<void> {
    if (this.state === "live") return;
    if (isTerminal(this.state)) throw this.lastError ?? new Error(`artifact sync is ${this.state}`);
    this.start();
    await new Promise<void>((resolve, reject) => {
      this.liveWaiters.add({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.abortController.abort();
    this.activeEpoch += 1;
    this.connectionReady = false;
    this.activeConnection?.close("client_closed");
    this.activeConnection = null;
    this.clearLiveQueue();
    if (this.runTask) await this.runTask.catch(() => {});
    await Promise.allSettled([...this.flushTasks]);
    await this.causalTail.catch(() => {});
    this.setState("closed");
    this.rejectLiveWaiters(new Error("artifact sync controller closed"));
  }

  getView(): EditableArtifactSyncView {
    return {
      artifactId: this.artifactId,
      modality: this.modality,
      state: this.state,
      cursor: this.cursor,
      headSequence: this.headSequence,
      writable: this.writable,
      pendingTransactions: this.pending.size,
      blockedPending: this.allBlockedPending(),
      queuedMessages: this.liveQueue.length,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
    };
  }

  subscribe(listener: EditableArtifactSyncListener): () => void {
    this.listeners.add(listener);
    listener(this.getView());
    return () => this.listeners.delete(listener);
  }

  queueCommands(
    input: EditableArtifactQueueCommandsInput,
  ): Promise<EditableArtifactPendingTransaction> {
    if (!(input.commandBytes instanceof Uint8Array)) {
      return Promise.reject(new TypeError("commandBytes must be a Uint8Array"));
    }
    const captured: EditableArtifactQueueCommandsInput = {
      ...input,
      commandBytes: input.commandBytes.slice(),
      ...(input.selectiveUndoTargets === undefined
        ? {}
        : { selectiveUndoTargets: [...input.selectiveUndoTargets] }),
    };
    return this.runCausalOperation(() => this.queueCommandsExclusive(captured));
  }

  private runCausalOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.causalTail.then(operation);
    this.causalTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async queueCommandsExclusive(
    input: EditableArtifactQueueCommandsInput,
  ): Promise<EditableArtifactPendingTransaction> {
    if (this.abortController.signal.aborted) {
      throw new Error("artifact sync controller is closed");
    }
    if (!(input.commandBytes instanceof Uint8Array) || input.commandBytes.byteLength === 0) {
      throw new TypeError("commandBytes must be a non-empty Uint8Array");
    }
    const effectiveCommandBytes = Math.min(
      this.maxCommandBytes,
      this.activeLimits?.maxCommandBytes ?? this.maxCommandBytes,
    );
    if (input.commandBytes.byteLength > effectiveCommandBytes) {
      throw new RangeError("commandBytes exceeds the configured bound");
    }
    await this.initialize();
    if (this.abortController.signal.aborted) {
      throw new Error("artifact sync controller is closed");
    }
    const clientTransactionId = requireClientTransactionId(
      input.clientTransactionId ?? this.clientTransactionIdFactory(),
      "clientTransactionId",
    );
    const selectiveUndoTargets = normalizeIdentifiers(
      input.selectiveUndoTargets ?? [],
      "selectiveUndoTargets",
    );
    if (this.modality !== "spreadsheet" && selectiveUndoTargets.length > 0) {
      throw new TypeError("selective undo is only supported for spreadsheet artifacts");
    }
    const existing = this.pending.get(clientTransactionId);
    if (existing) {
      if (
        existing.modality !== this.modality ||
        !bytesEqual(existing.commandBytes, input.commandBytes) ||
        (existing.modality === "spreadsheet" &&
          !identifiersEqual(existing.selectiveUndoTargets, selectiveUndoTargets))
      ) {
        throw new TypeError(
          `clientTransactionId ${clientTransactionId} is already bound to other commands`,
        );
      }
      if (this.replica) {
        try {
          await this.replacePendingOverlay();
        } catch (error) {
          this.requestSnapshotResync(
            `artifact Worker could not restore pending projection: ${asError(error).message}`,
            "resync_required",
          );
        }
      }
      this.rotateReplicaConnectionIfNeeded();
      if (this.state === "live") this.schedulePendingFlush();
      return clonePending(existing);
    }
    if (this.modality !== "spreadsheet" && this.allBlockedPending().length > 0) {
      throw new EditableArtifactSyncError(
        "pending_conflict",
        "resolve the stale serialized edit before authoring another command",
      );
    }
    if (this.pending.size >= this.maxPendingTransactions) {
      throw new RangeError("pending transaction count exceeds the configured bound");
    }
    if (this.pendingBytes() + input.commandBytes.byteLength > this.maxPendingBytes) {
      throw new RangeError("pending transaction bytes exceed the configured bound");
    }
    const foreignPending = this.orderedPending().find(
      (transaction) => transaction.replicaId !== this.writerReplicaId,
    );
    if (foreignPending) {
      throw new Error(
        "pending edits from a prior writer must settle before authoring dependent commands",
      );
    }
    const previous = this.orderedPending()
      .filter((transaction) => transaction.replicaId === this.writerReplicaId)
      .at(-1);
    const confirmedCounter =
      this.modality === "spreadsheet"
        ? (this.currentFrontier().find((entry) => entry.replicaId === this.writerReplicaId)
            ?.counter ?? 0)
        : this.lastLocalReplicaCounter;
    if (previous && previous.replicaCounter < confirmedCounter) {
      throw new Error("pending writer counter is behind its confirmed causal frontier");
    }
    const replicaCounter = positiveSafeInteger(
      (previous?.replicaCounter ?? confirmedCounter) + 1,
      "replicaCounter",
    );
    const previousLocalTransactionId = previous?.clientTransactionId ?? this.lastLocalTransactionId;
    if (replicaCounter > 1 && previousLocalTransactionId === null) {
      throw new Error("writer replica epoch was reused without its causal predecessor");
    }
    const createdAt = this.scheduler.now();
    const observedHeadSequence =
      this.modality === "spreadsheet" ? this.cursor : this.cursor + this.pending.size;
    const authored = await this.kernel.authorPending({
      modality: this.modality,
      protocolVersion: this.protocolVersion,
      kernelVersion: this.kernelVersion,
      modelSchemaVersion: this.modelSchemaVersion,
      commandVersion: this.commandVersion,
      artifactId: this.artifactId,
      clientTransactionId,
      replicaId: this.writerReplicaId,
      replicaCounter,
      previousLocalTransactionId,
      observedHeadSequence,
      ...(this.modality === "spreadsheet"
        ? {
            causalBase: cloneFrontier(this.currentFrontier()),
            selectiveUndoTargets,
          }
        : {}),
      commandBytes: input.commandBytes.slice(),
      createdAt,
    });
    validatePendingTransaction(authored, this.artifactId, this.modality, this.maxCommandBytes);
    if (
      this.activeLimits !== null &&
      authored.intentBytes.byteLength > this.activeLimits.maxIntentBytes
    ) {
      throw new RangeError("intentBytes exceeds the negotiated live bound");
    }
    if (
      this.pendingBytes() + authored.commandBytes.byteLength + authored.intentBytes.byteLength >
      this.maxPendingBytes
    ) {
      throw new RangeError("pending transaction bytes exceed the configured bound");
    }
    verifyAuthoredPending(authored, {
      modality: this.modality,
      clientTransactionId,
      replicaId: this.writerReplicaId,
      replicaCounter,
      previousLocalTransactionId,
      protocolVersion: this.protocolVersion,
      modelSchemaVersion: this.modelSchemaVersion,
      commandVersion: this.commandVersion,
      observedHeadSequence,
      ...(this.modality === "spreadsheet"
        ? {
            causalBase: this.currentFrontier(),
            selectiveUndoTargets,
          }
        : {}),
      commandBytes: input.commandBytes,
      createdAt,
    });
    await this.storage.putPending(this.storageScope, clonePending(authored));
    this.pending.set(authored.clientTransactionId, clonePending(authored));
    if (this.replica) {
      try {
        await this.replacePendingOverlay();
      } catch (error) {
        // The WAL write is the acceptance boundary. Never report this command
        // as rejected after its immutable intent is durable; rebuild the
        // speculative projection from authority + WAL on the next connection.
        this.requestSnapshotResync(
          `artifact Worker could not project durable pending intent: ${asError(error).message}`,
          "resync_required",
        );
      }
    }
    this.emit();
    this.rotateReplicaConnectionIfNeeded();
    if (this.state === "live") this.schedulePendingFlush();
    return clonePending(authored);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializeTask) return await this.initializeTask;
    this.initializeTask = this.initializeOnce();
    try {
      await this.initializeTask;
      this.initialized = true;
    } finally {
      this.initializeTask = null;
    }
  }

  private async initializeOnce(): Promise<void> {
    const pending = await this.storage.listPending(this.storageScope);
    for (const transaction of pending) {
      validatePendingTransaction(transaction, this.artifactId, this.modality, this.maxCommandBytes);
      if (
        transaction.protocolVersion !== this.protocolVersion ||
        transaction.modelSchemaVersion !== this.modelSchemaVersion ||
        transaction.commandVersion !== this.commandVersion
      ) {
        throw new EditableArtifactSyncError(
          "unsupported_protocol",
          `retained pending transaction ${transaction.clientTransactionId} uses incompatible protocol/schema/command versions`,
        );
      }
      const existing = this.pending.get(transaction.clientTransactionId);
      if (existing && existing.requestHash !== transaction.requestHash) {
        throw storageError(`conflicting retained transaction ${transaction.clientTransactionId}`);
      }
      this.pending.set(transaction.clientTransactionId, clonePending(transaction));
      if (transaction.replicaId === this.writerReplicaId) {
        this.lastLocalReplicaCounter = Math.max(
          this.lastLocalReplicaCounter,
          transaction.replicaCounter,
        );
      }
    }
    if (
      this.pending.size > this.maxPendingTransactions ||
      this.pendingBytes() > this.maxPendingBytes
    ) {
      throw storageError("retained pending transaction WAL exceeds configured bounds");
    }

    let stored: EditableArtifactStoredReplica | null;
    try {
      stored = await this.storage.loadReplica(this.storageScope);
    } catch (error) {
      // Confirmed replica state is a reconstructible cache. A malformed or
      // over-bound local record must not permanently brick this artifact; the
      // pending WAL remains separate and is deliberately preserved.
      if (!(error instanceof TypeError) && !(error instanceof RangeError)) {
        throw storageError("failed to load retained artifact replica", error);
      }
      try {
        await this.storage.clearReplica(this.storageScope);
      } catch (clearError) {
        throw storageError("failed to clear invalid retained artifact replica", clearError);
      }
      await this.kernel.reset();
      this.replica = null;
      this.retainedTailTransactions = 0;
      this.cursor = 0;
      this.headSequence = 0;
      this.retainedStorageHead = null;
      this.requireSnapshot = true;
      this.emit();
      return;
    }
    if (!stored) {
      this.requireSnapshot = true;
      this.emit();
      return;
    }
    this.retainedStorageHead = { cursor: stored.cursor, stateHash: stored.stateHash };
    try {
      await this.restoreReplica(stored);
      await this.replacePendingOverlay();
    } catch {
      await this.kernel.reset();
      this.replica = null;
      this.retainedTailTransactions = 0;
      this.cursor = 0;
      this.headSequence = 0;
      this.requireSnapshot = true;
    }
    this.emit();
  }

  private async restoreReplica(stored: EditableArtifactStoredReplica): Promise<void> {
    validateSnapshot(
      stored.snapshot,
      this.artifactId,
      this.modality,
      this.protocolVersion,
      this.kernelVersion,
      this.modelSchemaVersion,
      this.maxSnapshotBytes,
    );
    if (stored.artifactId !== this.artifactId || stored.modality !== this.modality) {
      throw new TypeError("stored artifact authority mismatch");
    }
    await this.kernel.reset();
    const loaded = await this.kernel.loadSnapshot(stored.snapshot);
    requireStateHash(loaded.stateHash, stored.snapshot.stateHash, "retained snapshot");
    requireDigest(loaded.digest, stored.snapshot.digest, "retained snapshot");
    if (stored.tail.length > this.maxStoredTailTransactions) {
      throw new RangeError("retained operation tail exceeds the configured bound");
    }
    let cursor = stored.snapshot.sequence;
    let stateHash = stored.snapshot.stateHash;
    let causalFrontier =
      stored.snapshot.modality === "spreadsheet" ? stored.snapshot.causalFrontier : null;
    let nativeRevision =
      stored.snapshot.modality === "spreadsheet" ? null : stored.snapshot.nativeRevision;
    for (const transaction of stored.tail) {
      validateCommittedTransaction(
        transaction,
        this.artifactId,
        this.modality,
        this.protocolVersion,
        this.maxCommittedTransactionBytes,
      );
      if (transaction.startSequence !== cursor + 1) {
        throw new TypeError("retained transaction tail is not contiguous");
      }
      requireStateHash(transaction.priorStateHash, stateHash, "retained transaction prior state");
      const applied = await this.kernel.applyRecovered(transaction);
      requireStateHash(applied.stateHash, transaction.stateHash, "retained transaction");
      cursor = transaction.endSequence;
      stateHash = transaction.stateHash;
      if (transaction.modality === "spreadsheet") {
        causalFrontier = transaction.causalFrontier;
      } else {
        if (nativeRevision !== transaction.priorNativeRevision) {
          throw new TypeError("retained transaction native revision is not contiguous");
        }
        nativeRevision = transaction.nativeRevision;
      }
    }
    if (stored.cursor !== cursor || stored.stateHash !== stateHash) {
      throw new TypeError("retained artifact cursor does not match its snapshot and tail");
    }
    this.replica =
      stored.snapshot.modality === "spreadsheet"
        ? {
            modality: "spreadsheet",
            snapshot: cloneSnapshot(stored.snapshot),
            cursor,
            stateHash,
            updatedAt: stored.updatedAt,
            causalFrontier: cloneFrontier(causalFrontier ?? []),
          }
        : {
            modality: stored.snapshot.modality,
            snapshot: cloneSnapshot(stored.snapshot),
            cursor,
            stateHash,
            updatedAt: stored.updatedAt,
            nativeRevision: requireNativeRevision(nativeRevision, "retained native revision"),
          };
    this.retainedTailTransactions = stored.tail.length;
    this.cursor = cursor;
    this.headSequence = cursor;
  }

  private async run(): Promise<void> {
    await this.initialize();
    let connectedBefore = false;
    let delayMs = this.reconnectDelayMs;
    while (!this.abortController.signal.aborted) {
      this.processingFailure = null;
      this.connectionReady = false;
      this.setState(
        this.requireSnapshot ? "resyncing" : connectedBefore ? "reconnecting" : "connecting",
      );
      try {
        await this.runConnection();
        connectedBefore = true;
        this.reconnectAttempt = 0;
        delayMs = this.reconnectDelayMs;
      } catch (error) {
        if (this.abortController.signal.aborted) break;
        if (this.state === "live") {
          // A connection that reached the verified live barrier was healthy;
          // only consecutive failures before that barrier consume the budget.
          this.reconnectAttempt = 0;
          delayMs = this.reconnectDelayMs;
        }
        const failure = asError(error);
        this.lastError = failure;
        if (failure instanceof EditableArtifactSyncError && failure.requiresSnapshot) {
          this.requireSnapshot = true;
        }
        if (
          failure instanceof EditableArtifactSyncError &&
          failure.code === "unsupported_protocol"
        ) {
          this.setState("unsupported");
          this.rejectLiveWaiters(failure);
          return;
        }
        if (!isRetryableFailure(failure)) {
          this.fail(failure);
          return;
        }
        connectedBefore = true;
        this.reconnectAttempt += 1;
        this.emit();
        if (this.reconnectAttempt > this.maxReconnectAttempts) {
          this.fail(
            new EditableArtifactSyncError(
              "reconnect_exhausted",
              `artifact sync gave up after ${this.maxReconnectAttempts} reconnect attempts`,
              { cause: failure },
            ),
          );
          return;
        }
      } finally {
        // Every minted ticket owns exactly one live connection. Bootstrap,
        // replay, validation, and queue failures can all exit before the
        // transport's `closed` promise settles, so retire the socket here as
        // well as on the normal close path.
        this.activeConnection?.close("client_reconnect");
        this.activeTicket = null;
        this.activeConnection = null;
        this.activeLimits = null;
        this.connectionReady = false;
      }
      if (this.abortController.signal.aborted) break;
      this.setState(this.requireSnapshot ? "resyncing" : "reconnecting");
      await this.scheduler.sleep(delayMs, this.abortController.signal).catch(() => {});
      delayMs = Math.min(Math.max(delayMs * 2, this.reconnectDelayMs), this.maxReconnectDelayMs);
    }
  }

  private async runConnection(): Promise<void> {
    const signal = this.abortController.signal;
    // Fence callbacks from the retired socket before ticket minting. A closed
    // adapter may still deliver a final queued callback while the next HTTP
    // ticket request is in flight.
    const epoch = ++this.activeEpoch;
    // A submit owned by the retired epoch may still settle, but must neither
    // block nor mutate the successor connection.
    this.flushTask = null;
    this.clearLiveQueue();
    const connectionReplicaId = this.desiredConnectionReplicaId();
    const ticket = await this.transport.mintTicket({
      artifactId: this.artifactId,
      replicaId: connectionReplicaId,
      signal,
    });
    this.validateTicket(ticket, connectionReplicaId);
    this.activeTicket = ticket;
    const resyncRevisionAtBootstrap = this.resyncRevision;

    // The transport must subscribe before the durable head is read. Messages
    // arriving during bootstrap are retained in the bounded queue below.
    const connection = await this.transport.openLive({
      ticket,
      after: this.cursor,
      stateHash: this.replica?.stateHash ?? null,
      resume:
        this.modality === "spreadsheet"
          ? { modality: "spreadsheet", causalFrontier: cloneFrontier(this.currentFrontier()) }
          : {
              modality: this.modality,
              nativeRevision: this.replica === null ? null : this.currentNativeRevision(),
            },
      requireSnapshot: this.requireSnapshot,
      signal,
      onMessage: (message) => this.enqueueLive(epoch, message),
    });
    this.activeConnection = connection;
    validateLiveLimits(connection.limits);
    this.activeLimits = connection.limits;
    boundedNonEmpty(connection.streamEpoch, "connection.streamEpoch", MAX_IDENTIFIER_BYTES);
    if (this.processingFailure) {
      connection.close("protocol_error");
      throw this.processingFailure;
    }
    if (this.resyncRevision !== resyncRevisionAtBootstrap) {
      connection.close("resync_required");
      throw new EditableArtifactSyncError(
        "queue_overflow",
        "live input was discarded before bootstrap; restarting from a verified snapshot",
        { retryable: true, requiresSnapshot: true },
      );
    }
    this.setState(this.requireSnapshot ? "resyncing" : "syncing");
    const bootstrap = await connection.readBootstrap({
      localCursor: this.replica ? this.cursor : null,
      localStateHash: this.replica?.stateHash ?? null,
      resume:
        this.modality === "spreadsheet"
          ? {
              modality: "spreadsheet",
              localCausalFrontier: cloneFrontier(this.currentFrontier()),
            }
          : {
              modality: this.modality,
              localNativeRevision: this.replica === null ? null : this.currentNativeRevision(),
            },
      requireSnapshot: this.requireSnapshot,
      signal,
    });
    await this.applyBootstrap(bootstrap, connection, signal);
    if (this.resyncRevision !== resyncRevisionAtBootstrap) {
      this.requireSnapshot = true;
      throw new EditableArtifactSyncError(
        "queue_overflow",
        "live input was discarded during bootstrap; restarting from a verified snapshot",
        { retryable: true, requiresSnapshot: true },
      );
    }
    if (this.processingFailure) throw this.processingFailure;

    if (this.cursor < this.headSequence) {
      this.enqueueLive(epoch, {
        type: "head",
        artifactId: this.artifactId,
        headSequence: this.headSequence,
      });
    }

    this.connectionReady = true;
    this.scheduleDrain();
    await this.awaitDrain();
    if (this.processingFailure) throw this.processingFailure;
    if (this.requireSnapshot) {
      throw new EditableArtifactSyncError(
        "queue_overflow",
        "live queue requires a verified snapshot resync",
        { retryable: true, requiresSnapshot: true },
      );
    }

    this.lastError = null;
    this.reconnectAttempt = 0;
    this.setState("live");
    this.resolveLiveWaiters();
    this.rotateReplicaConnectionIfNeeded();
    this.schedulePendingFlush();

    const closed = await waitForConnectionClose(connection, signal);
    this.connectionReady = false;
    await this.awaitDrain();
    if (this.processingFailure) throw this.processingFailure;
    if (signal.aborted) return;
    if (closed.reason === "permission_changed") {
      this.writable = false;
      this.emit();
    }
    throw transientError(
      closed.error ?? new TypeError(`artifact live connection closed: ${closed.reason}`),
    );
  }

  private async applyBootstrap(
    bootstrap: EditableArtifactBootstrap,
    connection: EditableArtifactLiveConnection,
    signal: AbortSignal,
  ): Promise<void> {
    if (bootstrap.artifactId !== this.artifactId) {
      throw invalidBootstrap("bootstrap artifact does not match the controller");
    }
    if (bootstrap.modality !== this.modality) {
      throw invalidBootstrap("bootstrap modality does not match the controller");
    }
    this.requireProtocol(bootstrap.protocolVersion);
    if (
      bootstrap.kernelVersion !== this.kernelVersion ||
      bootstrap.modelSchemaVersion !== this.modelSchemaVersion
    ) {
      throw new EditableArtifactSyncError(
        "unsupported_protocol",
        `artifact kernel/schema ${bootstrap.kernelVersion}/${bootstrap.modelSchemaVersion} is incompatible with ${this.kernelVersion}/${this.modelSchemaVersion}`,
      );
    }
    requireSha256(bootstrap.headStateHash, "bootstrap.headStateHash");
    if (bootstrap.modality === "spreadsheet") {
      validateFrontier(bootstrap.headCausalFrontier, "bootstrap.headCausalFrontier");
    } else {
      requireNativeRevision(bootstrap.headNativeRevision, "bootstrap.headNativeRevision");
    }
    this.writable = bootstrap.writable;
    safeSequence(bootstrap.headSequence, "bootstrap headSequence");
    safeSequence(bootstrap.minimumReplaySequence, "bootstrap minimumReplaySequence");
    if (bootstrap.minimumReplaySequence > bootstrap.headSequence + 1) {
      throw invalidBootstrap("minimum replay sequence exceeds the durable head");
    }
    // Bootstrap is the authoritative barrier for this new stream epoch and
    // may legitimately move backward during recovery.
    this.headSequence = bootstrap.headSequence;

    const mustReplace =
      this.requireSnapshot ||
      bootstrap.resyncRequired ||
      !this.replica ||
      this.cursor > bootstrap.headSequence ||
      this.cursor + 1 < bootstrap.minimumReplaySequence;
    const newerSnapshot = bootstrap.snapshot !== null && bootstrap.snapshot.sequence > this.cursor;
    if (mustReplace || newerSnapshot) {
      if (!bootstrap.snapshot) {
        throw invalidBootstrap("server required resync without a snapshot", true);
      }
      await this.replaceSnapshot(bootstrap.snapshot);
    }
    if (!this.replica) throw invalidBootstrap("bootstrap did not establish a snapshot", true);
    if (this.cursor > bootstrap.headSequence) {
      throw invalidBootstrap("local cursor is ahead of the durable artifact head", true);
    }

    this.requireSnapshot = false;
    await this.reconcileTo(bootstrap.headSequence, connection, signal, false);
    await this.replacePendingOverlay();
    requireStateHash(this.replica.stateHash, bootstrap.headStateHash, "bootstrap head barrier");
    if (bootstrap.modality === "spreadsheet") {
      requireFrontier(
        this.currentFrontier(),
        bootstrap.headCausalFrontier,
        "bootstrap head barrier",
      );
    } else {
      requireNativeRevisionEqual(
        this.currentNativeRevision(),
        bootstrap.headNativeRevision,
        "bootstrap head barrier",
      );
    }
    await connection.acknowledge({
      sequence: this.cursor,
      stateHash: this.replica.stateHash,
      signal,
    });
  }

  private replaceSnapshot(snapshot: EditableArtifactStoredReplica["snapshot"]): Promise<void> {
    return this.runCausalOperation(() => this.replaceSnapshotExclusive(snapshot));
  }

  private async replaceSnapshotExclusive(
    snapshot: EditableArtifactStoredReplica["snapshot"],
  ): Promise<void> {
    validateSnapshot(
      snapshot,
      this.artifactId,
      this.modality,
      this.protocolVersion,
      this.kernelVersion,
      this.modelSchemaVersion,
      this.maxSnapshotBytes,
    );
    await this.kernel.reset();
    const loaded = await this.kernel.loadSnapshot(snapshot);
    requireStateHash(loaded.stateHash, snapshot.stateHash, "snapshot");
    requireDigest(loaded.digest, snapshot.digest, "snapshot");
    const storedReplica: EditableArtifactStoredReplica = {
      artifactId: this.artifactId,
      modality: this.modality,
      snapshot: cloneSnapshot(snapshot),
      tail: [],
      cursor: snapshot.sequence,
      stateHash: snapshot.stateHash,
      updatedAt: this.scheduler.now(),
    };
    // Full replacement is one atomic storage generation swap and may move
    // backward during authoritative recovery. The pending WAL is separate.
    try {
      await this.storage.saveReplica(this.storageScope, storedReplica, this.retainedStorageHead);
    } catch (error) {
      if (error instanceof EditableArtifactStorageConflictError) {
        try {
          await this.reloadRetainedProjection();
          if (this.replica) return;
        } catch (reloadError) {
          throw invalidBootstrap(
            `could not adopt a concurrently retained artifact head: ${asError(reloadError).message}`,
            true,
          );
        }
        throw invalidBootstrap("concurrently retained artifact head disappeared", true);
      }
      throw storageError("failed to retain verified artifact snapshot", error);
    }
    this.retainedStorageHead = {
      cursor: storedReplica.cursor,
      stateHash: storedReplica.stateHash,
    };
    this.replica =
      storedReplica.snapshot.modality === "spreadsheet"
        ? {
            modality: "spreadsheet",
            snapshot: storedReplica.snapshot,
            cursor: storedReplica.cursor,
            stateHash: storedReplica.stateHash,
            updatedAt: storedReplica.updatedAt,
            causalFrontier: cloneFrontier(storedReplica.snapshot.causalFrontier),
          }
        : {
            modality: storedReplica.snapshot.modality,
            snapshot: storedReplica.snapshot,
            cursor: storedReplica.cursor,
            stateHash: storedReplica.stateHash,
            updatedAt: storedReplica.updatedAt,
            nativeRevision: storedReplica.snapshot.nativeRevision,
          };
    this.retainedTailTransactions = 0;
    this.cursor = snapshot.sequence;
    this.headSequence = Math.max(this.headSequence, snapshot.sequence);
    this.emit();
  }

  private async reconcileTo(
    target: number,
    connection: EditableArtifactLiveConnection,
    signal: AbortSignal,
    consumeHeadWatermark = true,
  ): Promise<void> {
    let replayThrough = safeSequence(target, "replay target");
    while (this.cursor < replayThrough) {
      const before = this.cursor;
      const page = await connection.replay({
        after: this.cursor,
        through: replayThrough,
        limit: this.replayPageSize,
        signal,
      });
      if (!page || typeof page !== "object") {
        throw invalidSequence("replay page must be an object");
      }
      if (page.artifactId !== this.artifactId) {
        throw invalidSequence("replay page belongs to another artifact");
      }
      if (!Array.isArray(page.transactions)) {
        throw invalidSequence("replay page transactions must be an array");
      }
      if (page.transactions.length > this.replayPageSize) {
        throw invalidSequence("replay page exceeds the negotiated transaction count");
      }
      safeSequence(page.headSequence, "replay headSequence");
      if (consumeHeadWatermark) replayThrough = Math.max(replayThrough, page.headSequence);
      this.headSequence = Math.max(this.headSequence, page.headSequence);
      let pageBytes = 0;
      for (const transaction of page.transactions) {
        validateCommittedTransaction(
          transaction,
          this.artifactId,
          this.modality,
          this.protocolVersion,
          this.maxCommittedTransactionBytes,
        );
        pageBytes += estimateCommittedTransactionBytes(transaction);
        if (!Number.isSafeInteger(pageBytes) || pageBytes > this.maxReplayPageBytes) {
          throw invalidSequence("replay page exceeds the negotiated byte bound");
        }
      }
      for (const transaction of page.transactions) {
        if (transaction.endSequence <= this.cursor) continue;
        if (transaction.endSequence > replayThrough) {
          throw invalidSequence("replay returned a transaction beyond the requested target");
        }
        await this.applyCommitted(transaction);
      }
      if (this.cursor === before) {
        throw invalidSequence(
          `durable replay did not provide sequence ${this.cursor + 1} through ${target}`,
        );
      }
    }
  }

  private enqueueLive(epoch: number, message: EditableArtifactLiveMessage): void {
    if (epoch !== this.activeEpoch || this.abortController.signal.aborted) return;
    let bytes: number;
    try {
      validateLiveMessage(
        message,
        this.artifactId,
        this.modality,
        this.protocolVersion,
        this.maxCommittedTransactionBytes,
      );
      bytes = estimateLiveMessageBytes(message);
    } catch (error) {
      this.processingFailure =
        error instanceof EditableArtifactSyncError
          ? error
          : invalidSequence(`invalid live message: ${asError(error).message}`);
      this.activeConnection?.close("protocol_error");
      return;
    }
    if (
      this.liveQueue.length + 1 > this.maxQueuedMessages ||
      this.queuedBytes + bytes > this.maxQueuedBytes
    ) {
      this.requestSnapshotResync("bounded live queue overflow");
      return;
    }
    this.liveQueue.push({ message, bytes });
    this.queuedBytes += bytes;
    this.emit();
    if (this.connectionReady) this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (!this.connectionReady || this.drainTask || this.liveQueue.length === 0) return;
    this.drainTask = this.drainLiveQueue()
      .catch((error: unknown) => {
        const failure = asError(error);
        this.processingFailure = failure;
        if (failure instanceof EditableArtifactSyncError && failure.requiresSnapshot) {
          this.requireSnapshot = true;
        }
        this.activeConnection?.close("client_reconcile_failed");
      })
      .finally(() => {
        this.drainTask = null;
        if (this.connectionReady && this.liveQueue.length > 0 && !this.processingFailure) {
          this.scheduleDrain();
        }
      });
  }

  private async drainLiveQueue(): Promise<void> {
    const connection = this.activeConnection;
    if (!connection) return;
    while (this.connectionReady && this.liveQueue.length > 0) {
      const queued = this.liveQueue.shift();
      if (!queued) break;
      this.queuedBytes -= queued.bytes;
      const message = queued.message;
      if (message.type === "resync_required") {
        this.requestSnapshotResync(message.reason, "resync_required");
        break;
      }
      if (message.type === "authorization") {
        this.writable = message.writable;
        if (message.writable) {
          if (
            this.lastError instanceof EditableArtifactSyncError &&
            this.lastError.code === "permission_changed"
          ) {
            this.lastError = null;
          }
          this.schedulePendingFlush();
        }
        this.emit();
        continue;
      }
      if (message.type === "head") {
        this.headSequence = Math.max(this.headSequence, message.headSequence);
        await this.reconcileTo(message.headSequence, connection, this.abortController.signal);
      } else {
        const transaction = message.transaction;
        this.headSequence = Math.max(this.headSequence, transaction.endSequence);
        if (transaction.startSequence > this.cursor + 1) {
          await this.reconcileTo(
            transaction.startSequence - 1,
            connection,
            this.abortController.signal,
          );
        }
        await this.applyCommitted(transaction);
      }
      this.emit();
    }
  }

  private async awaitDrain(): Promise<void> {
    while (this.drainTask) await this.drainTask;
  }

  private applyCommitted(transaction: EditableArtifactCommittedTransaction): Promise<void> {
    return this.runCausalOperation(() => this.applyCommittedExclusive(transaction));
  }

  private async applyCommittedExclusive(
    transaction: EditableArtifactCommittedTransaction,
  ): Promise<void> {
    const embeddedPending = validateCommittedTransaction(
      transaction,
      this.artifactId,
      this.modality,
      this.protocolVersion,
      this.maxCommittedTransactionBytes,
    );
    if (embeddedPending) {
      const pending = this.pending.get(embeddedPending.clientTransactionId);
      if (
        pending?.requestHash === embeddedPending.requestHash &&
        bytesEqual(pending.intentBytes, embeddedPending.intentBytes)
      ) {
        this.recordAcceptedMappingIdentity(transaction.transactionId, embeddedPending);
      }
    }
    if (transaction.endSequence <= this.cursor) {
      await this.settlePending(transaction, false);
      return;
    }
    if (transaction.startSequence !== this.cursor + 1) {
      throw invalidSequence(
        `expected committed sequence ${this.cursor + 1}, received ${transaction.startSequence}`,
      );
    }
    if (!this.replica)
      throw invalidBootstrap("cannot apply a transaction without a snapshot", true);
    requireStateHash(transaction.priorStateHash, this.replica.stateHash, "transaction prior state");
    const accepted = this.acceptedMappings.get(transaction.transactionId);
    const orderedPending = this.orderedPending();
    // OGACO carries the canonical mutation and resulting frontier, but not the
    // caller's client transaction id. The server deliberately sends those
    // committed bytes before mutationAccepted. Suppress an exact request-hash
    // match only from speculative replay so the same CRDT dot is not applied
    // twice; retain the WAL until the later authority mapping settles identity.
    const provisionalProjectionMatches =
      transaction.modality === "spreadsheet" && accepted === undefined
        ? orderedPending.filter((pending) => pending.requestHash === transaction.requestHash)
        : [];
    if (provisionalProjectionMatches.length > 1) {
      throw invalidSequence("multiple pending transactions share one committed request hash");
    }
    const provisionalProjectionMatch = provisionalProjectionMatches[0];
    const remainingPending = orderedPending.filter(
      (pending) =>
        (accepted === undefined ||
          pending.clientTransactionId !== accepted.clientTransactionId ||
          pending.requestHash !== accepted.requestHash) &&
        (provisionalProjectionMatch === undefined ||
          pending.clientTransactionId !== provisionalProjectionMatch.clientTransactionId ||
          pending.requestHash !== provisionalProjectionMatch.requestHash),
    );
    const updatedAt = this.scheduler.now();
    let applied: { stateHash: string };
    try {
      if (this.connectionReady) {
        const reconciled = await this.kernel.reconcileCommitted(transaction, remainingPending);
        this.setBlockedPending(reconciled.blockedPending);
        applied = reconciled;
      } else {
        applied = await this.kernel.applyRecovered(transaction);
      }
      requireStateHash(applied.stateHash, transaction.stateHash, "committed transaction");
    } catch (error) {
      await this.reloadRetainedProjection();
      throw error;
    }
    try {
      await this.storage.appendCommitted(this.storageScope, {
        artifactId: this.artifactId,
        expectedCursor: this.cursor,
        expectedStateHash: this.replica.stateHash,
        transaction: cloneCommitted(transaction),
        updatedAt,
      });
    } catch (error) {
      try {
        await this.reloadRetainedProjection();
      } catch (reloadError) {
        throw storageError("failed to reload retained artifact transaction state", reloadError);
      }
      if (error instanceof EditableArtifactStorageConflictError) {
        // Another tab may have already advanced or compacted the same verified
        // log. Its atomic retained head is authoritative for this browser
        // cache; adopt it instead of failing an otherwise healthy live stream.
        if (this.replica && this.cursor >= transaction.endSequence) {
          await this.settlePending(transaction, false);
          const connection = this.activeConnection;
          if (connection) {
            await connection.acknowledge({
              sequence: this.cursor,
              stateHash: this.replica.stateHash,
              signal: this.abortController.signal,
            });
          }
          this.emit();
          this.rotateReplicaConnectionIfNeeded();
          return;
        }
        throw invalidSequence(
          "retained artifact head changed without covering the live transaction",
        );
      }
      throw storageError("failed to retain committed artifact transaction", error);
    }

    this.replica.cursor = transaction.endSequence;
    this.replica.stateHash = transaction.stateHash;
    this.replica.updatedAt = updatedAt;
    if (transaction.modality === "spreadsheet") {
      if (this.replica.modality !== "spreadsheet") {
        throw invalidSequence("spreadsheet transaction reached a serialized replica");
      }
      this.replica.causalFrontier = cloneFrontier(transaction.causalFrontier);
    } else {
      if (this.replica.modality !== transaction.modality) {
        throw invalidSequence("serialized transaction modality does not match the replica");
      }
      this.replica.nativeRevision = transaction.nativeRevision;
    }
    this.retainedTailTransactions += 1;
    this.cursor = transaction.endSequence;
    this.retainedStorageHead = {
      cursor: transaction.endSequence,
      stateHash: transaction.stateHash,
    };
    this.headSequence = Math.max(this.headSequence, transaction.endSequence);
    await this.settlePending(transaction, this.connectionReady);
    const connection = this.activeConnection;
    if (connection) {
      await connection.acknowledge({
        sequence: transaction.endSequence,
        stateHash: transaction.stateHash,
        signal: this.abortController.signal,
      });
    }
    if (this.retainedTailTransactions > this.maxStoredTailTransactions) {
      this.requestSnapshotResync("retained operation tail exceeded its bound", "resync_required");
    }
    this.emit();
    this.rotateReplicaConnectionIfNeeded();
  }

  private async reloadRetainedProjection(): Promise<void> {
    const stored = await this.storage.loadReplica(this.storageScope);
    if (!stored) {
      await this.kernel.reset();
      this.replica = null;
      this.retainedTailTransactions = 0;
      this.cursor = 0;
      this.headSequence = 0;
      this.retainedStorageHead = null;
      this.requireSnapshot = true;
      return;
    }
    this.retainedStorageHead = { cursor: stored.cursor, stateHash: stored.stateHash };
    await this.restoreReplica(stored);
    await this.replacePendingOverlay();
  }

  private async settlePending(
    transaction: EditableArtifactCommittedTransaction,
    overlayAlreadyReconciled: boolean,
  ): Promise<void> {
    const accepted = this.acceptedMappings.get(transaction.transactionId);
    if (!accepted || accepted.requestHash !== transaction.requestHash) return;
    const pending = this.pending.get(accepted.clientTransactionId);
    if (!pending || pending.requestHash !== accepted.requestHash) return;
    await this.storage.deletePending(this.storageScope, accepted.clientTransactionId);
    this.pending.delete(accepted.clientTransactionId);
    this.acceptedMappings.delete(transaction.transactionId);
    if (pending.replicaId === this.writerReplicaId) {
      this.lastLocalTransactionId = pending.clientTransactionId;
      this.lastLocalReplicaCounter = Math.max(this.lastLocalReplicaCounter, pending.replicaCounter);
    }
    this.submittedEpoch.delete(accepted.clientTransactionId);
    this.submitBlockedPending.delete(accepted.clientTransactionId);
    if (!overlayAlreadyReconciled) await this.replacePendingOverlay();
    this.emit();
    this.rotateReplicaConnectionIfNeeded();
    if (this.state === "live") this.schedulePendingFlush();
  }

  private schedulePendingFlush(): void {
    if (
      this.flushTask ||
      this.state !== "live" ||
      !this.writable ||
      !this.activeTicket ||
      !this.activeConnection ||
      this.pending.size === 0
    ) {
      return;
    }
    const epoch = this.activeEpoch;
    const connection = this.activeConnection;
    let task!: Promise<void>;
    task = this.flushPending()
      .catch((error: unknown) => {
        if (epoch !== this.activeEpoch || connection !== this.activeConnection) return;
        const failure = asError(error);
        this.lastError = failure;
        this.processingFailure = failure;
        connection.close(
          isRetryableFailure(failure) ? "pending_outcome_unknown" : "pending_rejected",
        );
      })
      .finally(() => {
        this.flushTasks.delete(task);
        if (this.flushTask !== task) return;
        this.flushTask = null;
        if (this.state === "live" && !this.lastError && this.hasSubmittablePending()) {
          this.schedulePendingFlush();
        }
      });
    this.flushTask = task;
    this.flushTasks.add(task);
  }

  private async flushPending(): Promise<void> {
    const ticket = this.activeTicket;
    const connection = this.activeConnection;
    if (!ticket || !connection) return;
    const epoch = this.activeEpoch;
    const batch = this.orderedPending();
    for (const transaction of batch) {
      if (this.state !== "live" || ticket !== this.activeTicket || epoch !== this.activeEpoch)
        return;
      if (transaction.replicaId !== ticket.replicaId) continue;
      if (
        transaction.previousLocalTransactionId &&
        this.pending.has(transaction.previousLocalTransactionId)
      ) {
        continue;
      }
      if (this.pendingIsBlocked(transaction.clientTransactionId)) continue;
      if (this.submittedEpoch.get(transaction.clientTransactionId) === epoch) continue;
      this.submittedEpoch.set(transaction.clientTransactionId, epoch);
      let receipt: EditableArtifactSubmitReceipt;
      try {
        receipt = await connection.submit({
          transaction: clonePending(transaction),
          signal: this.abortController.signal,
        });
      } catch (error) {
        if (
          ticket !== this.activeTicket ||
          connection !== this.activeConnection ||
          epoch !== this.activeEpoch
        ) {
          return;
        }
        const failure = asError(error);
        const code = errorCode(failure);
        if (code === "permission_changed") {
          this.submittedEpoch.delete(transaction.clientTransactionId);
          this.writable = false;
          this.lastError = new EditableArtifactSyncError("permission_changed", failure.message);
          this.emit();
          return;
        }
        if (isRetryableFailure(failure)) throw failure;
        if (code === "closed" || code === "stale_epoch") throw transientError(failure);
        this.submittedEpoch.delete(transaction.clientTransactionId);
        const blockedCode = boundedNonEmpty(
          code ?? "submit_rejected",
          "submit rejection code",
          MAX_IDENTIFIER_BYTES,
        );
        this.submitBlockedPending.set(transaction.clientTransactionId, {
          clientTransactionId: transaction.clientTransactionId,
          code: blockedCode,
        });
        this.emit();
        this.rotateReplicaConnectionIfNeeded();
        continue;
      }
      if (
        ticket !== this.activeTicket ||
        connection !== this.activeConnection ||
        epoch !== this.activeEpoch
      )
        return;
      if (
        !receipt ||
        typeof receipt !== "object" ||
        !receipt.committed ||
        typeof receipt.committed !== "object" ||
        receipt.artifactId !== this.artifactId ||
        receipt.clientTransactionId !== transaction.clientTransactionId ||
        receipt.requestHash !== transaction.requestHash ||
        receipt.committed.artifactId !== this.artifactId ||
        receipt.committed.transactionId !== receipt.transactionId ||
        receipt.committed.requestHash !== transaction.requestHash
      ) {
        throw invalidSequence("submit receipt identity does not match the pending transaction");
      }
      validateCommittedTransaction(
        receipt.committed,
        this.artifactId,
        this.modality,
        this.protocolVersion,
        this.maxCommittedTransactionBytes,
      );
      this.recordAcceptedMapping(receipt);
      this.enqueueLive(epoch, {
        type: "transaction.committed",
        transaction: receipt.committed,
      });
    }
  }

  private recordAcceptedMapping(receipt: EditableArtifactSubmitReceipt): void {
    this.recordAcceptedMappingIdentity(receipt.transactionId, {
      clientTransactionId: receipt.clientTransactionId,
      requestHash: receipt.requestHash,
    });
  }

  private recordAcceptedMappingIdentity(
    transactionId: string,
    next: Readonly<{ clientTransactionId: string; requestHash: string }>,
  ): void {
    const existing = this.acceptedMappings.get(transactionId);
    if (
      existing &&
      (existing.clientTransactionId !== next.clientTransactionId ||
        existing.requestHash !== next.requestHash)
    ) {
      throw invalidSequence("authority reused a committed transaction id for another request");
    }
    this.acceptedMappings.set(transactionId, Object.freeze({ ...next }));
  }

  private requestSnapshotResync(
    reason: string,
    code: "queue_overflow" | "resync_required" = "queue_overflow",
  ): void {
    this.resyncRevision += 1;
    this.requireSnapshot = true;
    this.lastError = new EditableArtifactSyncError(code, reason, {
      retryable: true,
      requiresSnapshot: true,
    });
    this.clearLiveQueue();
    this.activeConnection?.close("resync_required");
    this.emit();
  }

  private clearLiveQueue(): void {
    this.liveQueue.length = 0;
    this.queuedBytes = 0;
    this.emit();
  }

  private validateTicket(ticket: EditableArtifactSyncTicket, expectedReplicaId: string): void {
    if (ticket.artifactId !== this.artifactId) {
      throw new EditableArtifactSyncError(
        "unsupported_protocol",
        "sync ticket belongs to another artifact",
      );
    }
    if (ticket.modality !== this.modality) {
      throw new EditableArtifactSyncError(
        "unsupported_protocol",
        "sync ticket modality does not match the controller",
      );
    }
    if (ticket.replicaId !== expectedReplicaId) {
      throw new EditableArtifactSyncError(
        "unsupported_protocol",
        "sync ticket is not bound to the requested writer replica",
      );
    }
    this.requireProtocol(ticket.protocolVersion);
    boundedNonEmpty(ticket.token, "ticket.token", MAX_TICKET_BYTES);
    const expiresAt = Date.parse(ticket.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw invalidBootstrap("sync ticket has an invalid expiry");
    }
    if (expiresAt <= this.scheduler.now() + this.minTicketTtlMs) {
      throw transientError(new TypeError("sync ticket is expired or too close to expiry"));
    }
  }

  private orderedPending(): EditableArtifactPendingTransaction[] {
    return orderPendingTransactions([...this.pending.values()]);
  }

  private hasSubmittablePending(): boolean {
    const activeReplicaId = this.activeTicket?.replicaId;
    return this.orderedPending().some(
      (transaction) =>
        transaction.replicaId === activeReplicaId &&
        this.submittedEpoch.get(transaction.clientTransactionId) !== this.activeEpoch &&
        !this.pendingIsBlocked(transaction.clientTransactionId) &&
        (!transaction.previousLocalTransactionId ||
          !this.pending.has(transaction.previousLocalTransactionId)),
    );
  }

  private pendingBytes(): number {
    let bytes = 0;
    for (const transaction of this.pending.values()) {
      bytes += transaction.commandBytes.byteLength + transaction.intentBytes.byteLength;
      if (!Number.isSafeInteger(bytes)) return Number.POSITIVE_INFINITY;
    }
    return bytes;
  }

  private currentFrontier(): EditableArtifactCausalFrontier {
    if (this.replica === null) return [];
    if (this.replica.modality !== "spreadsheet") {
      throw new TypeError("serialized artifacts do not have a causal frontier");
    }
    return this.replica.causalFrontier;
  }

  private currentNativeRevision(): number {
    if (this.replica === null || this.replica.modality === "spreadsheet") {
      throw new TypeError("spreadsheet artifacts do not have a native revision");
    }
    return this.replica.nativeRevision;
  }

  private desiredConnectionReplicaId(): string {
    return (
      this.orderedPending().find(
        (transaction) =>
          !this.pendingIsBlocked(transaction.clientTransactionId) &&
          (!transaction.previousLocalTransactionId ||
            !this.pending.has(transaction.previousLocalTransactionId)),
      )?.replicaId ?? this.writerReplicaId
    );
  }

  private rotateReplicaConnectionIfNeeded(): void {
    const ticket = this.activeTicket;
    if (!ticket || ticket.replicaId === this.desiredConnectionReplicaId()) return;
    this.activeConnection?.close("replica_changed");
  }

  private async replacePendingOverlay(): Promise<void> {
    const projection = await this.kernel.replacePending(this.orderedPending());
    this.setBlockedPending(projection.blockedPending);
  }

  private pendingIsBlocked(clientTransactionId: string): boolean {
    const blockedIds = new Set([
      ...this.blockedPending.map((blocked) => blocked.clientTransactionId),
      ...this.submitBlockedPending.keys(),
    ]);
    let current = this.pending.get(clientTransactionId);
    const visited = new Set<string>();
    while (current) {
      if (blockedIds.has(current.clientTransactionId)) return true;
      const predecessor = current.previousLocalTransactionId;
      if (!predecessor || visited.has(predecessor)) return false;
      visited.add(predecessor);
      current = this.pending.get(predecessor);
    }
    return false;
  }

  private setBlockedPending(values: readonly EditableArtifactBlockedPending[]): void {
    const seen = new Set<string>();
    this.blockedPending = values.map((value) => {
      requireClientTransactionId(value.clientTransactionId, "blocked clientTransactionId");
      boundedNonEmpty(value.code, "blocked code", MAX_IDENTIFIER_BYTES);
      if (!this.pending.has(value.clientTransactionId) || seen.has(value.clientTransactionId)) {
        throw new TypeError("worker returned an invalid blocked pending identity");
      }
      seen.add(value.clientTransactionId);
      return { ...value };
    });
    this.emit();
  }

  private allBlockedPending(): EditableArtifactBlockedPending[] {
    const byId = new Map<string, EditableArtifactBlockedPending>();
    for (const blocked of this.blockedPending) {
      byId.set(blocked.clientTransactionId, { ...blocked });
    }
    for (const blocked of this.submitBlockedPending.values()) {
      byId.set(blocked.clientTransactionId, { ...blocked });
    }
    return [...byId.values()].sort((left, right) =>
      compareCodeUnits(left.clientTransactionId, right.clientTransactionId),
    );
  }

  private requireProtocol(actual: number): void {
    if (actual !== this.protocolVersion) {
      throw new EditableArtifactSyncError(
        "unsupported_protocol",
        `artifact protocol ${actual} is incompatible with client ${this.protocolVersion}`,
      );
    }
  }

  private setState(state: EditableArtifactSyncState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit();
  }

  private emit(): void {
    const view = this.getView();
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // Observers cannot own transport or kernel lifecycle.
      }
    }
  }

  private resolveLiveWaiters(): void {
    for (const waiter of this.liveWaiters) waiter.resolve();
    this.liveWaiters.clear();
  }

  private rejectLiveWaiters(error: Error): void {
    for (const waiter of this.liveWaiters) waiter.reject(error);
    this.liveWaiters.clear();
  }

  private fail(error: Error): void {
    this.lastError = error;
    this.setState("failed");
    this.rejectLiveWaiters(error);
    this.activeConnection?.close("client_failed");
  }
}

function validatePendingTransaction(
  transaction: EditableArtifactPendingTransaction,
  artifactId: EditableArtifactId,
  modality: EditableArtifactModality,
  maxCommandBytes: number,
): void {
  if (transaction.artifactId !== artifactId || transaction.modality !== modality) {
    throw new TypeError("pending artifact authority mismatch");
  }
  requireClientTransactionId(transaction.clientTransactionId, "clientTransactionId");
  requireSha256(transaction.requestHash, "requestHash");
  requireReplicaId(transaction.replicaId, "replicaId");
  positiveU16(transaction.protocolVersion, "protocolVersion");
  positiveU16(transaction.modelSchemaVersion, "modelSchemaVersion");
  positiveU16(transaction.commandVersion, "commandVersion");
  positiveSafeInteger(transaction.replicaCounter, "replicaCounter");
  if (transaction.previousLocalTransactionId !== null) {
    requireClientTransactionId(
      transaction.previousLocalTransactionId,
      "previousLocalTransactionId",
    );
    if (transaction.previousLocalTransactionId === transaction.clientTransactionId) {
      throw new TypeError("a pending transaction cannot depend on itself");
    }
  }
  if (!(transaction.commandBytes instanceof Uint8Array)) {
    throw new TypeError("commandBytes must be a Uint8Array");
  }
  if (
    !(transaction.intentBytes instanceof Uint8Array) ||
    transaction.intentBytes.byteLength === 0
  ) {
    throw new TypeError("intentBytes must be a non-empty Uint8Array");
  }
  if (transaction.intentBytes.byteLength > EDITABLE_ARTIFACT_INTENT_MAX_BYTES) {
    throw new RangeError("intentBytes exceeds the configured bound");
  }
  safeSequence(transaction.observedHeadSequence, "observedHeadSequence");
  if (transaction.commandBytes.byteLength === 0) throw new TypeError("commandBytes is empty");
  if (transaction.commandBytes.byteLength > maxCommandBytes) {
    throw new RangeError("commandBytes exceeds the configured bound");
  }
  nonNegativeSafeInteger(transaction.createdAt, "createdAt");
  const intent = decodeEditableArtifactMutationIntent(transaction.intentBytes);
  if (
    intent.artifactId !== transaction.artifactId ||
    intent.clientTransactionId !== transaction.clientTransactionId ||
    intent.replicaId !== transaction.replicaId ||
    intent.replicaCounter !== transaction.replicaCounter ||
    intent.previousLocalTransactionId !== transaction.previousLocalTransactionId ||
    intent.protocolVersion !== transaction.protocolVersion ||
    intent.modelSchemaVersion !== transaction.modelSchemaVersion ||
    intent.commandProtocolVersion !== transaction.commandVersion ||
    intent.observedHeadSequence !== transaction.observedHeadSequence ||
    !bytesEqual(intent.commandBytes, transaction.commandBytes)
  ) {
    throw new TypeError("pending fields do not exactly match their canonical OGATX envelope");
  }
  editableArtifactCodecFor({
    durableModality: transaction.modality,
    modelSchemaVersion: transaction.modelSchemaVersion,
    commandProtocolVersion: transaction.commandVersion,
  }).command.assertCanonical(transaction.commandBytes);
  if (transaction.modality === "spreadsheet") {
    validateFrontier(transaction.causalBase, "causalBase");
    normalizeIdentifiers(transaction.selectiveUndoTargets, "selectiveUndoTargets");
    if (
      !identifiersEqual(intent.selectiveUndoOperationIds, transaction.selectiveUndoTargets) ||
      !frontiersEqual(intent.causalBase, transaction.causalBase)
    ) {
      throw new TypeError("spreadsheet pending causality does not match its OGATX envelope");
    }
  } else {
    requireNativeRevision(transaction.observedNativeRevision, "observedNativeRevision");
    if (intent.causalBase.length !== 0 || intent.selectiveUndoOperationIds.length !== 0) {
      throw new TypeError("serialized pending transactions cannot carry CRDT causality");
    }
  }
  if (
    hashEditableArtifactMutationIntentBytes(transaction.intentBytes) !== transaction.requestHash
  ) {
    throw new TypeError("pending requestHash does not match its canonical OGATX envelope");
  }
}

function validateLiveLimits(limits: EditableArtifactLiveLimits): void {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new TypeError("live connection limits must be an object");
  }
  positiveSafeInteger(limits.maxClientFrameBytes, "limits.maxClientFrameBytes");
  nonNegativeSafeInteger(limits.maxCommandBytes, "limits.maxCommandBytes");
  nonNegativeSafeInteger(limits.maxIntentBytes, "limits.maxIntentBytes");
  nonNegativeSafeInteger(
    limits.maxCommittedTransactionBytes,
    "limits.maxCommittedTransactionBytes",
  );
  positiveSafeInteger(limits.maxSnapshotBytes, "limits.maxSnapshotBytes");
  positiveSafeInteger(limits.maxInFlightTransactions, "limits.maxInFlightTransactions");
  positiveSafeInteger(limits.maxInFlightBytes, "limits.maxInFlightBytes");
  if (
    limits.maxCommandBytes > EDITABLE_ARTIFACT_COMMAND_MAX_BYTES ||
    limits.maxIntentBytes > EDITABLE_ARTIFACT_INTENT_MAX_BYTES ||
    limits.maxCommittedTransactionBytes > MAX_COMMITTED_TRANSACTION_BYTES
  ) {
    throw new TypeError("live connection advertised incompatible protocol limits");
  }
}

type ExpectedAuthoredPending = Readonly<{
  modality: EditableArtifactModality;
  clientTransactionId: string;
  protocolVersion: number;
  modelSchemaVersion: number;
  commandVersion: number;
  replicaId: string;
  replicaCounter: number;
  previousLocalTransactionId: string | null;
  observedHeadSequence: number;
  commandBytes: Uint8Array;
  createdAt: number;
  causalBase?: EditableArtifactCausalFrontier;
  selectiveUndoTargets?: readonly string[];
}>;

function verifyAuthoredPending(
  actual: EditableArtifactPendingTransaction,
  expected: ExpectedAuthoredPending,
): void {
  if (
    actual.modality !== expected.modality ||
    actual.clientTransactionId !== expected.clientTransactionId ||
    actual.protocolVersion !== expected.protocolVersion ||
    actual.modelSchemaVersion !== expected.modelSchemaVersion ||
    actual.commandVersion !== expected.commandVersion ||
    actual.replicaId !== expected.replicaId ||
    actual.replicaCounter !== expected.replicaCounter ||
    actual.previousLocalTransactionId !== expected.previousLocalTransactionId ||
    actual.observedHeadSequence !== expected.observedHeadSequence ||
    actual.createdAt !== expected.createdAt ||
    !bytesEqual(actual.commandBytes, expected.commandBytes)
  ) {
    throw new TypeError("worker authored a pending envelope that differs from its immutable input");
  }
  if (actual.modality === "spreadsheet") {
    if (
      expected.causalBase === undefined ||
      expected.selectiveUndoTargets === undefined ||
      !identifiersEqual(actual.selectiveUndoTargets, expected.selectiveUndoTargets)
    ) {
      throw new TypeError("worker authored invalid spreadsheet pending metadata");
    }
    requireFrontier(actual.causalBase, expected.causalBase, "authored pending");
  } else if (expected.causalBase !== undefined || expected.selectiveUndoTargets !== undefined) {
    throw new TypeError("worker authored serialized pending with spreadsheet metadata");
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validateCommittedTransaction(
  transaction: EditableArtifactCommittedTransaction,
  artifactId: EditableArtifactId,
  modality: EditableArtifactModality,
  protocolVersion: number,
  maxCommittedTransactionBytes: number,
): Readonly<{
  clientTransactionId: string;
  requestHash: string;
  intentBytes: Uint8Array;
}> | null {
  if (transaction.artifactId !== artifactId || transaction.modality !== modality) {
    throw invalidSequence("transaction artifact authority mismatch");
  }
  requireStableId(transaction.transactionId, "transactionId");
  requireSha256(transaction.requestHash, "requestHash");
  requireSha256(transaction.priorStateHash, "priorStateHash");
  requireSha256(transaction.stateHash, "stateHash");
  safeSequence(transaction.startSequence, "transaction startSequence");
  safeSequence(transaction.endSequence, "transaction endSequence");
  if (transaction.startSequence < 1 || transaction.endSequence < transaction.startSequence) {
    throw invalidSequence("transaction sequence interval is invalid");
  }
  if (!(transaction.committedTransactionBytes instanceof Uint8Array)) {
    throw invalidSequence("transaction committedTransactionBytes must be a Uint8Array");
  }
  if (transaction.committedTransactionBytes.byteLength === 0) {
    throw invalidSequence("transaction committedTransactionBytes is empty");
  }
  if (transaction.committedTransactionBytes.byteLength > maxCommittedTransactionBytes) {
    throw invalidSequence("transaction committedTransactionBytes exceeds the configured bound");
  }
  if (transaction.modality === "spreadsheet") {
    if (transaction.protocolVersion !== protocolVersion) {
      throw new EditableArtifactSyncError(
        "unsupported_protocol",
        `transaction protocol ${transaction.protocolVersion} is incompatible with client ${protocolVersion}`,
      );
    }
    validateFrontier(transaction.causalFrontier, "causalFrontier");
    let summary: ReturnType<typeof decodeCommittedTransactionSummary>;
    try {
      summary = decodeCommittedTransactionSummary(transaction.committedTransactionBytes);
    } catch (error) {
      throw invalidSequence(`invalid OGACO envelope: ${asError(error).message}`);
    }
    if (
      summary.transactionId !== transaction.transactionId ||
      summary.operationProtocolVersion !== transaction.protocolVersion ||
      summary.priorStateHash !== transaction.priorStateHash ||
      summary.stateHash !== transaction.stateHash ||
      !frontiersEqual(summary.resultingCausalFrontier, transaction.causalFrontier)
    ) {
      throw invalidSequence("committed routing fields do not exactly match the OGACO envelope");
    }
    return null;
  }
  requireNativeRevision(transaction.priorNativeRevision, "transaction.priorNativeRevision");
  requireNativeRevision(transaction.nativeRevision, "transaction.nativeRevision");
  let summary: ReturnType<typeof decodeEditableArtifactSerializedCommit>;
  try {
    summary = decodeEditableArtifactSerializedCommit(
      transaction.committedTransactionBytes,
      transaction.modality,
    );
  } catch (error) {
    throw invalidSequence(`invalid OGAST envelope: ${asError(error).message}`);
  }
  if (
    summary.modality !== transaction.modality ||
    summary.transactionId !== transaction.transactionId ||
    summary.parentHeadSequence !== transaction.startSequence - 1 ||
    summary.resultHeadSequence !== transaction.endSequence ||
    summary.priorNativeRevision !== transaction.priorNativeRevision ||
    summary.nativeReceipt.revision !== transaction.nativeRevision ||
    summary.commitProtocolVersion !== transaction.commitProtocolVersion ||
    summary.priorStateHash !== transaction.priorStateHash ||
    summary.stateHash !== transaction.stateHash ||
    summary.requestHash !== transaction.requestHash ||
    summary.intent.artifactId !== transaction.artifactId
  ) {
    throw invalidSequence("committed routing fields do not exactly match the OGAST envelope");
  }
  return Object.freeze({
    clientTransactionId: summary.intent.clientTransactionId,
    requestHash: summary.requestHash,
    intentBytes: summary.intentBytes,
  });
}

function validateSnapshot(
  snapshot: EditableArtifactStoredReplica["snapshot"],
  artifactId: EditableArtifactId,
  modality: EditableArtifactModality,
  protocolVersion: number,
  kernelVersion: string,
  modelSchemaVersion: number,
  maxSnapshotBytes: number,
): void {
  if (snapshot.artifactId !== artifactId || snapshot.modality !== modality) {
    throw invalidBootstrap("snapshot artifact authority mismatch");
  }
  safeSequence(snapshot.sequence, "snapshot sequence");
  requireSha256(snapshot.stateHash, "snapshot.stateHash");
  requireSha256(snapshot.digest, "snapshot.digest");
  boundedNonEmpty(snapshot.kernelVersion, "snapshot.kernelVersion", MAX_KERNEL_VERSION_BYTES);
  positiveSafeInteger(snapshot.modelSchemaVersion, "snapshot.modelSchemaVersion");
  if (snapshot.modality === "spreadsheet") {
    validateFrontier(snapshot.causalFrontier, "snapshot.causalFrontier");
    if (snapshot.protocolVersion !== protocolVersion) {
      throw new EditableArtifactSyncError(
        "unsupported_protocol",
        `snapshot protocol ${snapshot.protocolVersion} is incompatible with client ${protocolVersion}`,
      );
    }
  } else {
    requireNativeRevision(snapshot.nativeRevision, "snapshot.nativeRevision");
  }
  if (
    snapshot.kernelVersion !== kernelVersion ||
    snapshot.modelSchemaVersion !== modelSchemaVersion
  ) {
    throw new EditableArtifactSyncError(
      "unsupported_protocol",
      `snapshot kernel/schema ${snapshot.kernelVersion}/${snapshot.modelSchemaVersion} is incompatible with ${kernelVersion}/${modelSchemaVersion}`,
    );
  }
  if (!(snapshot.bytes instanceof Uint8Array)) {
    throw invalidBootstrap("snapshot bytes must be a Uint8Array");
  }
  if (snapshot.bytes.byteLength === 0) throw invalidBootstrap("snapshot bytes is empty");
  if (snapshot.bytes.byteLength > maxSnapshotBytes) {
    throw invalidBootstrap("snapshot bytes exceeds the configured bound");
  }
}

function validateFrontier(frontier: EditableArtifactCausalFrontier, label: string): void {
  if (!Array.isArray(frontier)) throw new TypeError(`${label} must be an array`);
  if (frontier.length > MAX_FRONTIER_ACTORS) {
    throw new RangeError(`${label} exceeds ${MAX_FRONTIER_ACTORS} actors`);
  }
  let previous: string | null = null;
  for (const [index, entry] of frontier.entries()) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.getPrototypeOf(entry) !== Object.prototype
    ) {
      throw new TypeError(`${label}[${index}] must be a plain object`);
    }
    requireReplicaId(entry.replicaId, `${label}[${index}].replicaId`);
    positiveSafeInteger(entry.counter, `${label}[${index}].counter`);
    if (previous !== null && compareCodeUnits(previous, entry.replicaId) >= 0) {
      throw new TypeError(`${label} must be strictly sorted and duplicate-free`);
    }
    previous = entry.replicaId;
  }
}

function validateLiveMessage(
  message: EditableArtifactLiveMessage,
  artifactId: EditableArtifactId,
  modality: EditableArtifactModality,
  protocolVersion: number,
  maxCommittedTransactionBytes: number,
): void {
  if (!message || typeof message !== "object") {
    throw invalidSequence("live message must be an object");
  }
  if (message.type === "transaction.committed") {
    validateCommittedTransaction(
      message.transaction,
      artifactId,
      modality,
      protocolVersion,
      maxCommittedTransactionBytes,
    );
    return;
  }
  if (message.type === "head") {
    if (message.artifactId !== artifactId) {
      throw invalidSequence("live head belongs to another artifact");
    }
    safeSequence(message.headSequence, "live headSequence");
    return;
  }
  if (message.type === "authorization") {
    if (message.artifactId !== artifactId) {
      throw invalidSequence("live authorization belongs to another artifact");
    }
    if (typeof message.writable !== "boolean") {
      throw invalidSequence("live authorization writable must be boolean");
    }
    return;
  }
  if (message.type === "resync_required") {
    if (message.artifactId !== artifactId) {
      throw invalidSequence("live resync belongs to another artifact");
    }
    boundedNonEmpty(message.reason, "live resync reason", 8 * 1024);
    return;
  }
  throw invalidSequence("live message type is unsupported");
}

function estimateLiveMessageBytes(message: EditableArtifactLiveMessage): number {
  if (message.type === "transaction.committed") {
    return estimateCommittedTransactionBytes(message.transaction);
  }
  if (message.type === "resync_required") {
    return new TextEncoder().encode(message.reason).byteLength + 128;
  }
  return 96;
}

function estimateCommittedTransactionBytes(
  transaction: EditableArtifactCommittedTransaction,
): number {
  return (
    transaction.committedTransactionBytes.byteLength +
    512 +
    (transaction.modality === "spreadsheet"
      ? transaction.causalFrontier.length * (MAX_IDENTIFIER_BYTES + 16)
      : 32)
  );
}

function requireStateHash(actual: string, expected: string, source: string): void {
  if (actual !== expected) {
    throw new EditableArtifactSyncError(
      "kernel_diverged",
      `${source} produced state hash ${actual}; expected ${expected}`,
      { retryable: true, requiresSnapshot: true },
    );
  }
}

function requireDigest(actual: string, expected: string, source: string): void {
  requireSha256(actual, `${source} computed digest`);
  if (actual !== expected) {
    throw new EditableArtifactSyncError(
      "kernel_diverged",
      `${source} bytes produced digest ${actual}; expected ${expected}`,
      { retryable: true, requiresSnapshot: true },
    );
  }
}

function requireFrontier(
  actual: EditableArtifactCausalFrontier,
  expected: EditableArtifactCausalFrontier,
  source: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some(
      (entry, index) =>
        entry.replicaId !== expected[index]?.replicaId ||
        entry.counter !== expected[index]?.counter,
    )
  ) {
    throw new EditableArtifactSyncError(
      "kernel_diverged",
      `${source} causal frontier does not match the authoritative barrier`,
      { retryable: true, requiresSnapshot: true },
    );
  }
}

function orderPendingTransactions(
  transactions: EditableArtifactPendingTransaction[],
): EditableArtifactPendingTransaction[] {
  const byId = new Map<string, EditableArtifactPendingTransaction>();
  const replicaCounters = new Set<string>();
  for (const transaction of transactions) {
    if (byId.has(transaction.clientTransactionId)) {
      throw new TypeError(`duplicate pending transaction ${transaction.clientTransactionId}`);
    }
    const counterKey = `${transaction.replicaId}\0${transaction.replicaCounter}`;
    if (replicaCounters.has(counterKey)) {
      throw new TypeError(
        `replica ${transaction.replicaId} reused counter ${transaction.replicaCounter}`,
      );
    }
    replicaCounters.add(counterKey);
    byId.set(transaction.clientTransactionId, transaction);
  }

  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const transaction of transactions) {
    let count = 0;
    const dependency = transaction.previousLocalTransactionId;
    if (dependency && byId.has(dependency)) {
      const list = children.get(dependency) ?? [];
      list.push(transaction.clientTransactionId);
      children.set(dependency, list);
      count += 1;
    }
    indegree.set(transaction.clientTransactionId, count);
  }

  const ready = transactions
    .filter((transaction) => indegree.get(transaction.clientTransactionId) === 0)
    .sort(comparePendingStable);
  const ordered: EditableArtifactPendingTransaction[] = [];
  while (ready.length > 0) {
    const transaction = ready.shift();
    if (!transaction) break;
    ordered.push(transaction);
    for (const childId of children.get(transaction.clientTransactionId) ?? []) {
      const next = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, next);
      if (next === 0) {
        const child = byId.get(childId);
        if (child) insertSorted(ready, child, comparePendingStable);
      }
    }
  }
  if (ordered.length !== transactions.length) {
    throw new TypeError("pending transaction dependencies contain a cycle");
  }
  return ordered;
}

function comparePendingStable(
  left: EditableArtifactPendingTransaction,
  right: EditableArtifactPendingTransaction,
): number {
  const replica = compareCodeUnits(left.replicaId, right.replicaId);
  if (replica !== 0) return replica;
  if (left.replicaCounter !== right.replicaCounter) {
    return left.replicaCounter < right.replicaCounter ? -1 : 1;
  }
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return compareCodeUnits(left.clientTransactionId, right.clientTransactionId);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function insertSorted<T>(values: T[], value: T, compare: (left: T, right: T) => number): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(values[middle] as T, value) <= 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function cloneSnapshot(
  snapshot: EditableArtifactSpreadsheetSnapshot,
): EditableArtifactSpreadsheetSnapshot;
function cloneSnapshot(
  snapshot: EditableArtifactSerializedSnapshot,
): EditableArtifactSerializedSnapshot;
function cloneSnapshot(
  snapshot: EditableArtifactStoredReplica["snapshot"],
): EditableArtifactStoredReplica["snapshot"];
function cloneSnapshot(
  snapshot: EditableArtifactStoredReplica["snapshot"],
): EditableArtifactStoredReplica["snapshot"] {
  return snapshot.modality === "spreadsheet"
    ? {
        ...snapshot,
        causalFrontier: cloneFrontier(snapshot.causalFrontier),
        bytes: snapshot.bytes.slice(),
      }
    : { ...snapshot, bytes: snapshot.bytes.slice() };
}

function cloneCommitted(
  transaction: EditableArtifactSpreadsheetCommittedTransaction,
): EditableArtifactSpreadsheetCommittedTransaction;
function cloneCommitted(
  transaction: EditableArtifactSerializedCommittedTransaction,
): EditableArtifactSerializedCommittedTransaction;
function cloneCommitted(
  transaction: EditableArtifactCommittedTransaction,
): EditableArtifactCommittedTransaction;
function cloneCommitted(
  transaction: EditableArtifactCommittedTransaction,
): EditableArtifactCommittedTransaction {
  return transaction.modality === "spreadsheet"
    ? {
        ...transaction,
        causalFrontier: cloneFrontier(transaction.causalFrontier),
        committedTransactionBytes: transaction.committedTransactionBytes.slice(),
      }
    : {
        ...transaction,
        committedTransactionBytes: transaction.committedTransactionBytes.slice(),
      };
}

function clonePending(
  transaction: EditableArtifactSpreadsheetPendingTransaction,
): EditableArtifactSpreadsheetPendingTransaction;
function clonePending(
  transaction: Exclude<EditableArtifactPendingTransaction, { modality: "spreadsheet" }>,
): Exclude<EditableArtifactPendingTransaction, { modality: "spreadsheet" }>;
function clonePending(
  transaction: EditableArtifactPendingTransaction,
): EditableArtifactPendingTransaction;
function clonePending(
  transaction: EditableArtifactPendingTransaction,
): EditableArtifactPendingTransaction {
  return transaction.modality === "spreadsheet"
    ? {
        ...transaction,
        causalBase: cloneFrontier(transaction.causalBase),
        selectiveUndoTargets: [...transaction.selectiveUndoTargets],
        commandBytes: transaction.commandBytes.slice(),
        intentBytes: transaction.intentBytes.slice(),
      }
    : {
        ...transaction,
        commandBytes: transaction.commandBytes.slice(),
        intentBytes: transaction.intentBytes.slice(),
      };
}

function safeSequence(value: number, label: string): number {
  return nonNegativeSafeInteger(value, label);
}

function requireModality(value: unknown): EditableArtifactModality {
  if (value !== "document" && value !== "spreadsheet" && value !== "presentation") {
    throw new TypeError("artifact modality is invalid");
  }
  return value;
}

function requireNativeRevision(value: number | null, label: string): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireNativeRevisionEqual(actual: number, expected: number, source: string): void {
  requireNativeRevision(actual, `${source} actual native revision`);
  requireNativeRevision(expected, `${source} expected native revision`);
  if (actual !== expected) {
    throw new EditableArtifactSyncError(
      "kernel_diverged",
      `${source} native revision ${actual} does not match ${expected}`,
      { retryable: true, requiresSnapshot: true },
    );
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function positiveU16(value: number, label: string): number {
  const validated = positiveSafeInteger(value, label);
  if (validated > 0xffff) throw new RangeError(`${label} must fit an unsigned 16-bit integer`);
  return validated;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function boundedNonEmpty(value: string, label: string, maxBytes: number): string {
  requireNonEmpty(value, label);
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function requireSha256(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a canonical sha256: digest`);
  }
  return value;
}

function requireStableId(value: string, label: string): string {
  if (!/^(?!0{32}$)[a-f0-9]{32}$/u.test(value)) {
    throw new TypeError(`${label} must be 32 lowercase nonzero hex characters`);
  }
  return value;
}

function requireClientTransactionId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical portable transaction id`);
  }
  return value;
}

function requireReplicaId(value: string, label: string): string {
  if (!/^(?!0{16}$)[a-f0-9]{16}$/.test(value)) {
    throw new TypeError(`${label} must be 16 lowercase nonzero hex characters`);
  }
  return value;
}

function defaultWriterReplicaId(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (value !== "0000000000000000") return value;
  }
}

export function editableArtifactCacheNamespace(authority: EditableArtifactCacheAuthority): string {
  const origin = new URL(authority.deploymentOrigin).origin;
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
    throw new TypeError("storageAuthority.deploymentOrigin must be HTTP(S)");
  }
  return JSON.stringify([
    origin,
    boundedNonEmpty(authority.accountId, "storageAuthority.accountId", MAX_IDENTIFIER_BYTES),
    boundedNonEmpty(authority.workspaceId, "storageAuthority.workspaceId", MAX_IDENTIFIER_BYTES),
    boundedNonEmpty(authority.principalId, "storageAuthority.principalId", MAX_IDENTIFIER_BYTES),
    boundedNonEmpty(
      authority.authorizationEpoch,
      "storageAuthority.authorizationEpoch",
      MAX_IDENTIFIER_BYTES,
    ),
  ]);
}

function cloneFrontier(frontier: EditableArtifactCausalFrontier): EditableArtifactCausalFrontier {
  return frontier.map((entry) => ({ ...entry }));
}

function frontiersEqual(
  left: readonly Readonly<{ replicaId: string; counter: number }>[],
  right: readonly Readonly<{ replicaId: string; counter: number }>[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.replicaId === right[index]?.replicaId && entry.counter === right[index]?.counter,
    )
  );
}

function normalizeIdentifiers(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  if (values.length > 1_024) throw new RangeError(`${label} exceeds 1024 entries`);
  const normalized = values.map((value, index) =>
    boundedNonEmpty(value, `${label}[${index}]`, MAX_IDENTIFIER_BYTES),
  );
  normalized.sort(compareCodeUnits);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1] === normalized[index]) {
      throw new TypeError(`${label} contains a duplicate identifier`);
    }
  }
  return normalized;
}

function identifiersEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidBootstrap(message: string, retryable = false): EditableArtifactSyncError {
  return new EditableArtifactSyncError("invalid_bootstrap", message, {
    retryable,
    requiresSnapshot: retryable,
  });
}

function invalidSequence(message: string): EditableArtifactSyncError {
  return new EditableArtifactSyncError("invalid_sequence", message, {
    retryable: true,
    requiresSnapshot: true,
  });
}

function transientError(cause: unknown): EditableArtifactSyncError {
  return new EditableArtifactSyncError("invalid_bootstrap", "artifact transport interrupted", {
    retryable: true,
    cause,
  });
}

function storageError(message: string, cause?: unknown): EditableArtifactSyncError {
  return new EditableArtifactSyncError("storage_failed", message, { cause });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: Error): string | null {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function isRetryableFailure(error: Error): boolean {
  if (error instanceof EditableArtifactSyncError) return error.retryable;
  return (error as Error & { retryable?: unknown }).retryable === true;
}

function isTerminal(state: EditableArtifactSyncState): boolean {
  return state === "unsupported" || state === "failed" || state === "closed";
}

function waitForConnectionClose(
  connection: EditableArtifactLiveConnection,
  signal: AbortSignal,
): Promise<Awaited<EditableArtifactLiveConnection["closed"]>> {
  if (signal.aborted) return Promise.resolve({ reason: "closed" });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: Awaited<EditableArtifactLiveConnection["closed"]>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => finish({ reason: "closed" });
    signal.addEventListener("abort", onAbort, { once: true });
    void connection.closed.then(finish, fail);
  });
}

const defaultScheduler: EditableArtifactSyncScheduler = {
  now: () => Date.now(),
  sleep: async (delayMs, signal) => {
    if (signal.aborted || delayMs <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delayMs);
      const onAbort = () => done();
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};
