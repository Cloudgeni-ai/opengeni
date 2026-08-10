import type { EditableArtifactAuthorizationPort } from "../domain/editable-artifacts/ports";
import type { EditableArtifactService } from "../domain/editable-artifacts/service";
import {
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
} from "@opengeni/contracts/editable-artifacts";
import { decodeCommittedTransactionSummary } from "@opengeni/contracts/editable-artifact-committed-transaction";
import { decodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import { EDITABLE_ARTIFACT_MAX_COMMITTED_TRANSACTION_BYTES } from "../domain/editable-artifacts/service";
import {
  assertNonnegativeSafeInteger,
  assertPositiveSafeInteger,
  editableArtifactActorKey,
  editableArtifactCausalFrontier,
  editableArtifactId,
  editableArtifactRequestHash,
  editableArtifactStateHash,
  editableArtifactTransactionId,
  type EditableArtifactActor,
  type EditableArtifactCausalFrontier,
  type EditableArtifactId,
  type EditableArtifactModality,
  type EditableArtifactRequestHash,
  type EditableArtifactScope,
  type EditableArtifactStateHash,
} from "../domain/editable-artifacts/types";
import { EditableArtifactLiveError } from "./errors";
import type {
  EditableArtifactLiveAuthorizationInvalidationPort,
  EditableArtifactLiveClockPort,
  EditableArtifactLiveHintPort,
  EditableArtifactLiveReadPort,
  EditableArtifactLiveSchedulerPort,
  EditableArtifactLiveServerDependencies,
  EditableArtifactLiveSinkPort,
  EditableArtifactLiveTicketStorePort,
  EditableArtifactLiveTokenPort,
} from "./ports";
import { EditableArtifactLiveTicketAuthority } from "./ticket";
import {
  EDITABLE_ARTIFACT_LIVE_PROTOCOL_VERSION,
  type EditableArtifactLiveAppliedClientFrame,
  type EditableArtifactLiveBootstrap,
  type EditableArtifactLiveClientFrame,
  type EditableArtifactLiveClose,
  type EditableArtifactLiveCloseReason,
  type EditableArtifactLiveCommittedTransaction,
  type EditableArtifactLiveMutationClientFrame,
  type EditableArtifactLiveMutationReceipt,
  type EditableArtifactLiveResume,
  type EditableArtifactLiveServerFrame,
  type EditableArtifactLiveSnapshot,
  type EditableArtifactLiveTicket,
  type EditableArtifactLiveTicketRecord,
} from "./types";

const textEncoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

// Shared OGATX is bounded at 5 MiB and whole OGACO at 8 MiB. Transport
// metadata gets a small fixed allowance; valid SDK-authored transactions must
// never enter a reconnect loop because a lower hidden live limit rejects them.
const DEFAULT_MAX_CLIENT_FRAME_BYTES = 5 * 1024 * 1024 + 64 * 1024;
const DEFAULT_MAX_OUTBOUND_FRAME_BYTES = 8 * 1024 * 1024 + 64 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES;
const DEFAULT_SNAPSHOT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_IN_FLIGHT_TRANSACTIONS = 256;
const DEFAULT_MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const DEFAULT_REPLAY_PAGE_TRANSACTIONS = 256;
const DEFAULT_REPLAY_PAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_QUEUE_FRAMES = 64;
const DEFAULT_MAX_INBOUND_QUEUE_BYTES = 12 * 1024 * 1024;
const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;
const DEFAULT_REAUTHORIZE_INTERVAL_MS = 15_000;
const DEFAULT_ACK_TIMEOUT_MS = 30_000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_CAUSAL_ACTORS = 1_024;

export type EditableArtifactLiveServerOptions = Readonly<{
  protocolVersion?: number;
  ticketTtlMs?: number;
  maxClientFrameBytes?: number;
  maxOutboundFrameBytes?: number;
  maxSnapshotBytes?: number;
  snapshotChunkBytes?: number;
  maxInFlightTransactions?: number;
  maxInFlightBytes?: number;
  replayPageTransactions?: number;
  replayPageBytes?: number;
  maxSocketBufferedBytes?: number;
  maxInboundQueueFrames?: number;
  maxInboundQueueBytes?: number;
  reconcileIntervalMs?: number;
  reauthorizeIntervalMs?: number;
  ackTimeoutMs?: number;
  sendTimeoutMs?: number;
}>;

type NormalizedOptions = Required<Omit<EditableArtifactLiveServerOptions, "ticketTtlMs">> &
  Readonly<{ ticketTtlMs?: number }>;

export type OpenEditableArtifactLiveInput = Readonly<{
  token: string;
  artifactId: EditableArtifactId;
  protocolVersion: number;
  resume: EditableArtifactLiveResume;
  sink: EditableArtifactLiveSinkPort;
  signal?: AbortSignal;
}>;

export interface EditableArtifactLiveSession {
  readonly artifactId: EditableArtifactId;
  readonly modality: EditableArtifactModality;
  readonly streamEpoch: string;
  readonly closed: Promise<EditableArtifactLiveClose>;
  receive(bytes: Uint8Array): Promise<void>;
  acknowledge(frame: EditableArtifactLiveAppliedClientFrame): Promise<void>;
  submitIntent(
    input: Readonly<{
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      requestHash: EditableArtifactRequestHash;
      intentBytes: Uint8Array;
    }>,
  ): Promise<EditableArtifactLiveMutationReceipt>;
  reconcileNow(): Promise<void>;
  reauthorizeNow(): Promise<void>;
  close(reason?: EditableArtifactLiveCloseReason): Promise<void>;
}

export class EditableArtifactLiveServer {
  private readonly options: NormalizedOptions;
  private readonly ticketAuthority: EditableArtifactLiveTicketAuthority;

  constructor(
    private readonly dependencies: EditableArtifactLiveServerDependencies,
    options: EditableArtifactLiveServerOptions = {},
  ) {
    this.options = normalizeOptions(options);
    this.ticketAuthority = new EditableArtifactLiveTicketAuthority({
      authorization: dependencies.authorization,
      tickets: dependencies.tickets,
      tokens: dependencies.tokens,
      clock: dependencies.clock,
      protocolVersion: this.options.protocolVersion,
      ...(this.options.ticketTtlMs === undefined ? {} : { ttlMs: this.options.ticketTtlMs }),
    });
  }

  mintTicket(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      modality: EditableArtifactModality;
      actor: EditableArtifactActor;
      allowEdit: boolean;
    }>,
  ): Promise<EditableArtifactLiveTicket> {
    return this.ticketAuthority.mint(input);
  }

  async openLive(input: OpenEditableArtifactLiveInput): Promise<EditableArtifactLiveSession> {
    const artifactId = editableArtifactId(input.artifactId);
    const ticket = await this.ticketAuthority.consume({
      token: input.token,
      artifactId,
      protocolVersion: input.protocolVersion,
    });
    validateResume(input.resume, ticket.modality);
    const streamEpoch = `live_${this.dependencies.tokens.randomOpaqueToken()}`;
    boundedString(streamEpoch, "stream epoch", MAX_IDENTIFIER_BYTES);
    const session = new EditableArtifactLiveSessionImpl({
      dependencies: this.dependencies,
      options: this.options,
      ticket,
      streamEpoch,
      resume: input.resume,
      sink: input.sink,
      ...(input.signal === undefined ? {} : { parentSignal: input.signal }),
    });
    await session.start();
    return session;
  }
}

type SessionConstructor = Readonly<{
  dependencies: EditableArtifactLiveServerDependencies;
  options: NormalizedOptions;
  ticket: EditableArtifactLiveTicketRecord;
  streamEpoch: string;
  resume: EditableArtifactLiveResume;
  sink: EditableArtifactLiveSinkPort;
  parentSignal?: AbortSignal;
}>;

type InFlight = Readonly<{
  bytes: number;
  stateHash: EditableArtifactStateHash;
  sentAt: number;
}>;

class EditableArtifactLiveSessionImpl implements EditableArtifactLiveSession {
  readonly artifactId: EditableArtifactId;
  readonly modality: EditableArtifactModality;
  readonly streamEpoch: string;
  readonly closed: Promise<EditableArtifactLiveClose>;

  private readonly dependencies: EditableArtifactLiveServerDependencies;
  private readonly options: NormalizedOptions;
  private readonly ticket: EditableArtifactLiveTicketRecord;
  private readonly resume: EditableArtifactLiveResume;
  private readonly sink: EditableArtifactLiveSinkPort;
  private readonly abort = new AbortController();
  private readonly boundaries = new Map<number, EditableArtifactStateHash>();
  private readonly inFlight = new Map<number, InFlight>();
  private resolveClosed!: (close: EditableArtifactLiveClose) => void;
  private workTail: Promise<void> = Promise.resolve();
  private releaseHints: (() => void) | null = null;
  private releaseInvalidations: (() => void) | null = null;
  private detachParent: (() => void) | null = null;
  private maintenance: Promise<void> | null = null;
  private closedValue: EditableArtifactLiveClose | null = null;
  private bootstrapping = true;
  private reconcileRequested = false;
  private reconcileScheduled = false;
  private reauthorizationRequested = false;
  private reauthorizationScheduled = false;
  private sentSequence = 0;
  private sentStateHash: EditableArtifactStateHash | null = null;
  private ackedSequence = 0;
  private ackedStateHash: EditableArtifactStateHash | null = null;
  private targetHead = 0;
  private inFlightBytes = 0;
  private oldestInFlightAt = 0;
  private writable = false;
  private authorizationRevision = 0;
  private queuedInboundFrames = 0;
  private queuedInboundBytes = 0;

  constructor(input: SessionConstructor) {
    this.dependencies = input.dependencies;
    this.options = input.options;
    this.ticket = input.ticket;
    this.artifactId = input.ticket.artifactId;
    this.modality = input.ticket.modality;
    this.streamEpoch = input.streamEpoch;
    this.resume = input.resume;
    this.sink = input.sink;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    if (input.parentSignal) {
      const close = () => void this.close("closed");
      if (input.parentSignal.aborted) close();
      else {
        input.parentSignal.addEventListener("abort", close, { once: true });
        this.detachParent = () => input.parentSignal!.removeEventListener("abort", close);
      }
    }
  }

  async start(): Promise<void> {
    try {
      this.assertOpen();
      this.authorizationRevision = await this.requireRead();
      this.assertOpen();

      // The hint subscription resolves only after its broker flush barrier.
      // It is deliberately established before the first authoritative head read.
      const releaseHints = await this.dependencies.hints.subscribe({
        scope: this.ticket.scope,
        artifactId: this.artifactId,
        onHint: () => this.requestReconcile(),
        onReconnect: () => this.requestReconcile(),
      });
      if (this.closedValue) {
        safeRelease(releaseHints);
        this.assertOpen();
      }
      this.releaseHints = releaseHints;
      const releaseInvalidations = await this.dependencies.invalidations.subscribe({
        scope: this.ticket.scope,
        artifactId: this.artifactId,
        actor: this.ticket.actor,
        onInvalidated: () => this.requestReauthorization(),
      });
      if (this.closedValue) {
        safeRelease(releaseInvalidations);
        this.assertOpen();
      }
      this.releaseInvalidations = releaseInvalidations;
      // Close the authorization-subscription race before reading any artifact
      // bytes. Later revocations are caught by the subscription and periodic
      // reauthorization.
      this.authorizationRevision = Math.max(this.authorizationRevision, await this.requireRead());
      this.assertOpen();
      let editDecision = await this.checkPermission("edit");
      if (editDecision.revision > this.authorizationRevision) {
        this.authorizationRevision = editDecision.revision;
        await this.requireRead();
      } else if (editDecision.revision < this.authorizationRevision) {
        editDecision = await this.checkPermission("edit");
      }
      this.writable = editDecision.revision === this.authorizationRevision && editDecision.allowed;
      this.assertOpen();
      const bootstrap = await this.dependencies.read.readBootstrap({
        scope: this.ticket.scope,
        artifactId: this.artifactId,
        resume: this.resume,
        protocolVersion: this.options.protocolVersion,
      });
      this.assertOpen();
      validateBootstrap(bootstrap, this.artifactId, this.modality, this.resume, this.options);
      this.targetHead = bootstrap.headSequence;
      await this.send({
        type: "open",
        protocolVersion: this.options.protocolVersion,
        artifactId: this.artifactId,
        streamEpoch: this.streamEpoch,
        modality: this.modality,
        writable: this.writable,
        headSequence: bootstrap.headSequence,
        minimumReplaySequence: bootstrap.minimumReplaySequence,
        maxClientFrameBytes: this.options.maxClientFrameBytes,
        maxCommandBytes: Math.min(
          EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
          Math.max(0, this.options.maxClientFrameBytes - 64 * 1024),
        ),
        maxIntentBytes: Math.min(
          EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
          Math.max(0, this.options.maxClientFrameBytes - 64 * 1024),
        ),
        maxCommittedTransactionBytes: Math.min(
          EDITABLE_ARTIFACT_MAX_COMMITTED_TRANSACTION_BYTES,
          Math.max(0, this.options.maxOutboundFrameBytes - 64 * 1024),
        ),
        maxSnapshotBytes: this.options.maxSnapshotBytes,
        maxInFlightTransactions: this.options.maxInFlightTransactions,
        maxInFlightBytes: this.options.maxInFlightBytes,
      });
      await this.applyBootstrap(bootstrap);

      // Close the final-notification race even when the broker loses the hint:
      // reread durable authority after snapshot/replay, while already subscribed.
      await this.reconcileFromDurableHead();
      await this.sendBarrier();
      this.bootstrapping = false;
      if (this.reconcileRequested) this.requestReconcile();
      this.maintenance = this.runMaintenance().catch((error: unknown) => {
        if (!this.abort.signal.aborted) void this.fail(error);
      });
    } catch (error) {
      await this.fail(error);
      throw error;
    }
  }

  receive(bytes: Uint8Array): Promise<void> {
    if (this.closedValue)
      return Promise.reject(new EditableArtifactLiveError("closed", "Live session is closed"));
    if (!(bytes instanceof Uint8Array)) {
      return Promise.reject(new TypeError("Live frame must be Uint8Array"));
    }
    if (bytes.byteLength > this.options.maxClientFrameBytes) {
      const error = new EditableArtifactLiveError(
        "oversized_frame",
        "Client live frame exceeds the byte limit",
      );
      void this.fail(error);
      return Promise.reject(error);
    }
    let frame: EditableArtifactLiveClientFrame;
    try {
      frame = decodeClientFrame(
        bytes,
        this.artifactId,
        this.streamEpoch,
        this.options.protocolVersion,
      );
    } catch (error) {
      const failure =
        error instanceof EditableArtifactLiveError
          ? error
          : new EditableArtifactLiveError("invalid_frame", "Client live frame is malformed", {
              cause: error,
            });
      void this.fail(failure);
      return Promise.reject(failure);
    }
    return this.enqueueInbound(bytes.byteLength, async () => {
      await this.applyAcknowledgement(frame);
    });
  }

  acknowledge(frame: EditableArtifactLiveAppliedClientFrame): Promise<void> {
    if (this.closedValue) {
      return Promise.reject(new EditableArtifactLiveError("closed", "Live session is closed"));
    }
    let normalized: EditableArtifactLiveAppliedClientFrame;
    try {
      normalized = validateAppliedFrame(
        frame,
        this.artifactId,
        this.streamEpoch,
        this.options.protocolVersion,
      );
    } catch (error) {
      const failure =
        error instanceof EditableArtifactLiveError
          ? error
          : new EditableArtifactLiveError("invalid_frame", "Client live ACK is malformed", {
              cause: error,
            });
      void this.fail(failure);
      return Promise.reject(failure);
    }
    return this.enqueueInbound(256, async () => {
      await this.applyAcknowledgement(normalized);
    });
  }

  submitIntent(
    input: Readonly<{
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      requestHash: EditableArtifactRequestHash;
      intentBytes: Uint8Array;
    }>,
  ): Promise<EditableArtifactLiveMutationReceipt> {
    if (this.closedValue) {
      return Promise.reject(new EditableArtifactLiveError("closed", "Live session is closed"));
    }
    if (input.protocolVersion !== this.options.protocolVersion) {
      const error = new EditableArtifactLiveError(
        "protocol_mismatch",
        "Mutation protocol mismatch",
      );
      void this.fail(error);
      return Promise.reject(error);
    }
    let inputArtifactId: EditableArtifactId;
    try {
      inputArtifactId = editableArtifactId(input.artifactId);
    } catch (cause) {
      const error = new EditableArtifactLiveError(
        "invalid_frame",
        "Mutation artifact id is malformed",
        { cause },
      );
      void this.fail(error);
      return Promise.reject(error);
    }
    if (inputArtifactId !== this.artifactId) {
      const error = new EditableArtifactLiveError("invalid_frame", "Mutation artifact mismatch");
      void this.fail(error);
      return Promise.reject(error);
    }
    if (input.streamEpoch !== this.streamEpoch) {
      const error = new EditableArtifactLiveError(
        "stale_epoch",
        "Mutation belongs to a stale stream epoch",
      );
      void this.fail(error);
      return Promise.reject(error);
    }
    try {
      editableArtifactRequestHash(input.requestHash);
    } catch (cause) {
      const error = new EditableArtifactLiveError(
        "invalid_frame",
        "Mutation request hash is malformed",
        { cause },
      );
      return Promise.reject(error);
    }
    if (
      !(input.intentBytes instanceof Uint8Array) ||
      input.intentBytes.byteLength === 0 ||
      input.intentBytes.byteLength > this.options.maxClientFrameBytes
    ) {
      const error = new EditableArtifactLiveError(
        "oversized_frame",
        "Mutation intent exceeds the byte limit",
      );
      void this.fail(error);
      return Promise.reject(error);
    }
    return this.enqueueInbound(
      input.intentBytes.byteLength,
      () => this.applyMutation(input),
      false,
    );
  }

  reconcileNow(): Promise<void> {
    return this.enqueue(() => this.reconcileFromDurableHead());
  }

  reauthorizeNow(): Promise<void> {
    return this.enqueue(() => this.reauthorize());
  }

  async close(reason: EditableArtifactLiveCloseReason = "closed"): Promise<void> {
    if (this.closedValue) return;
    const close = closeValue(reason);
    this.closedValue = close;
    this.abort.abort();
    safeRelease(this.releaseHints);
    this.releaseHints = null;
    safeRelease(this.releaseInvalidations);
    this.releaseInvalidations = null;
    safeRelease(this.detachParent);
    this.detachParent = null;
    try {
      this.sink.close(close);
    } catch {
      // Adapter teardown is best effort; the protocol session is already
      // atomically closed and must never leak cleanup failures to callers.
    }
    this.resolveClosed(close);
  }

  private assertOpen(): void {
    if (this.closedValue) {
      throw new EditableArtifactLiveError("closed", "Live session is closed");
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.workTail.then(async () => {
      if (this.closedValue) {
        throw new EditableArtifactLiveError("closed", "Live session is closed");
      }
      return await task();
    });
    this.workTail = result.then(
      () => undefined,
      (error: unknown) => this.fail(error),
    );
    return result;
  }

  private enqueueInbound<T>(bytes: number, task: () => Promise<T>, fatal = true): Promise<T> {
    if (
      this.queuedInboundFrames + 1 > this.options.maxInboundQueueFrames ||
      this.queuedInboundBytes + bytes > this.options.maxInboundQueueBytes
    ) {
      const error = new EditableArtifactLiveError(
        "slow_client",
        "Live inbound work queue is full",
        { requiresSnapshot: true },
      );
      void this.fail(error);
      return Promise.reject(error);
    }
    this.queuedInboundFrames += 1;
    this.queuedInboundBytes += bytes;
    const run = async () => {
      try {
        return await task();
      } finally {
        this.queuedInboundFrames -= 1;
        this.queuedInboundBytes -= bytes;
      }
    };
    if (fatal) return this.enqueue(run);
    const result = this.workTail.then(async () => {
      if (this.closedValue) {
        throw new EditableArtifactLiveError("closed", "Live session is closed");
      }
      return await run();
    });
    // A rejected mutation is request-scoped. Unknown outcomes are retried with
    // the same intent/hash; they do not corrupt or tear down the read stream.
    this.workTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requestReconcile(): void {
    if (this.closedValue) return;
    this.reconcileRequested = true;
    if (this.bootstrapping || this.reconcileScheduled) return;
    this.reconcileScheduled = true;
    void this.enqueue(async () => {
      try {
        while (this.reconcileRequested && !this.closedValue) {
          this.reconcileRequested = false;
          await this.reconcileFromDurableHead();
        }
      } finally {
        this.reconcileScheduled = false;
        if (this.reconcileRequested && !this.closedValue) this.requestReconcile();
      }
    }).catch(() => undefined);
  }

  private requestReauthorization(): void {
    if (this.closedValue) return;
    this.reauthorizationRequested = true;
    if (this.reauthorizationScheduled) return;
    this.reauthorizationScheduled = true;
    void this.enqueue(async () => {
      try {
        while (this.reauthorizationRequested && !this.closedValue) {
          this.reauthorizationRequested = false;
          await this.reauthorize();
        }
      } finally {
        this.reauthorizationScheduled = false;
        if (this.reauthorizationRequested && !this.closedValue) {
          this.requestReauthorization();
        }
      }
    }).catch(() => undefined);
  }

  private async applyBootstrap(bootstrap: EditableArtifactLiveBootstrap): Promise<void> {
    if (bootstrap.resumeAccepted) {
      this.sentSequence = bootstrap.resumeSequence;
      this.ackedSequence = bootstrap.resumeSequence;
      this.sentStateHash = bootstrap.resumeStateHash;
      this.ackedStateHash = bootstrap.resumeStateHash;
      this.boundaries.set(bootstrap.resumeSequence, bootstrap.resumeStateHash);
    } else if (bootstrap.snapshot) {
      await this.sendSnapshot(bootstrap.snapshot);
      this.sentSequence = bootstrap.snapshot.sequence;
      this.sentStateHash = bootstrap.snapshot.stateHash;
      this.boundaries.set(bootstrap.snapshot.sequence, bootstrap.snapshot.stateHash);
      // Sequence zero is the immutable genesis boundary, not a committed
      // mutation that needs a replica lease advancement. Seed only its hash so
      // the client's exact snapshot ACK is valid; snapshots above zero remain
      // unacknowledged until their ACK is durably recorded below.
      if (bootstrap.snapshot.sequence === 0) {
        this.ackedStateHash = bootstrap.snapshot.stateHash;
      }
    } else {
      await this.requireResync("retention_gap", bootstrap.headSequence);
      return;
    }
    if (this.sentSequence + 1 < bootstrap.minimumReplaySequence) {
      await this.requireResync("retention_gap", bootstrap.headSequence);
      return;
    }
    await this.pumpThrough(bootstrap.headSequence);
    if (
      !this.closedValue &&
      this.sentSequence === bootstrap.headSequence &&
      this.sentStateHash !== bootstrap.stateHash
    ) {
      await this.requireResync("durable_gap", bootstrap.headSequence);
    }
  }

  private async sendSnapshot(snapshot: EditableArtifactLiveSnapshot): Promise<void> {
    if (snapshot.bytes.byteLength > this.options.maxSnapshotBytes) {
      await this.requireResync("oversized_frame", snapshot.sequence);
      return;
    }
    // The durable read port owns this immutable snapshot for bootstrap. Copy
    // each bounded wire chunk, never the entire potentially 128 MiB snapshot.
    const snapshotBytes = snapshot.bytes;
    if (snapshot.modality !== this.modality) {
      throw new EditableArtifactLiveError(
        "durable_gap",
        "Snapshot modality differs from its durable ticket",
        { requiresSnapshot: true },
      );
    }
    const causalFrontier =
      snapshot.modality === "spreadsheet"
        ? validateFrontier(snapshot.causalFrontier, "snapshot causal frontier")
        : null;
    const totalBytes = snapshotBytes.byteLength;
    if (totalBytes === 0)
      throw new EditableArtifactLiveError("durable_gap", "Snapshot is empty", {
        requiresSnapshot: true,
      });
    for (let offset = 0; offset < totalBytes; offset += this.options.snapshotChunkBytes) {
      const bytes = snapshotBytes.slice(
        offset,
        Math.min(offset + this.options.snapshotChunkBytes, totalBytes),
      );
      const common = {
        type: "snapshot",
        protocolVersion: this.options.protocolVersion,
        artifactId: this.artifactId,
        streamEpoch: this.streamEpoch,
        sequence: snapshot.sequence,
        stateHash: snapshot.stateHash,
        digest: snapshot.digest,
        kernelVersion: snapshot.kernelVersion,
        modelSchemaVersion: snapshot.modelSchemaVersion,
        offset,
        totalBytes,
        final: offset + bytes.byteLength === totalBytes,
        bytes,
      } as const;
      await this.send(
        snapshot.modality === "spreadsheet"
          ? { ...common, modality: snapshot.modality, causalFrontier: causalFrontier! }
          : {
              ...common,
              modality: snapshot.modality,
              nativeRevision: snapshot.nativeRevision,
            },
      );
    }
  }

  private async reconcileFromDurableHead(): Promise<void> {
    if (this.closedValue) return;
    const head = await this.dependencies.read.readHead(this.ticket.scope, this.artifactId);
    validateHead(head, this.modality);
    if (head.headSequence < this.sentSequence) {
      await this.requireResync("durable_gap", head.headSequence);
      return;
    }
    this.targetHead = head.headSequence;
    if (this.sentSequence + 1 < head.minimumReplaySequence) {
      await this.requireResync("retention_gap", head.headSequence);
      return;
    }
    await this.pumpThrough(head.headSequence);
    if (
      !this.closedValue &&
      this.sentSequence === head.headSequence &&
      this.sentStateHash !== head.stateHash
    ) {
      await this.requireResync("durable_gap", head.headSequence);
      return;
    }
    if (!this.closedValue) {
      await this.send({
        type: "watermark",
        protocolVersion: this.options.protocolVersion,
        artifactId: this.artifactId,
        streamEpoch: this.streamEpoch,
        headSequence: head.headSequence,
      });
    }
  }

  private async pumpThrough(through: number): Promise<void> {
    assertNonnegativeSafeInteger(through, "target head sequence");
    while (!this.closedValue && this.sentSequence < through) {
      if (this.inFlight.size >= this.options.maxInFlightTransactions) return;
      const page = await this.dependencies.read.readTransactions({
        scope: this.ticket.scope,
        artifactId: this.artifactId,
        after: this.sentSequence,
        through,
        maxCount: this.options.replayPageTransactions,
        maxBytes: this.options.replayPageBytes,
      });
      validatePage(
        page,
        this.sentSequence,
        through,
        this.options.replayPageTransactions,
        this.options.replayPageBytes,
      );
      if (this.sentSequence + 1 < page.minimumReplaySequence) {
        await this.requireResync("retention_gap", page.headSequence);
        return;
      }
      if (page.transactions.length === 0) {
        await this.requireResync("durable_gap", page.headSequence);
        return;
      }
      let progressed = false;
      for (const transaction of page.transactions) {
        validateTransaction(
          transaction,
          this.artifactId,
          this.modality,
          Math.min(
            this.options.replayPageBytes,
            Math.max(0, this.options.maxOutboundFrameBytes - 64 * 1024),
          ),
        );
        if (transaction.endSequence > through) {
          await this.requireResync("durable_gap", page.headSequence);
          return;
        }
        if (transaction.startSequence !== this.sentSequence + 1) {
          await this.requireResync("durable_gap", page.headSequence);
          return;
        }
        if (this.sentStateHash && transaction.priorStateHash !== this.sentStateHash) {
          await this.requireResync("durable_gap", page.headSequence);
          return;
        }
        const ownedTransaction = ownTransaction(transaction);
        const frameBytes = estimateFrameBytes({
          type: "transaction",
          protocolVersion: this.options.protocolVersion,
          artifactId: this.artifactId,
          streamEpoch: this.streamEpoch,
          transaction: ownedTransaction,
        });
        if (
          frameBytes > this.options.maxOutboundFrameBytes ||
          frameBytes > this.options.maxInFlightBytes
        ) {
          await this.requireResync("oversized_frame", page.headSequence);
          return;
        }
        if (
          this.inFlight.size >= this.options.maxInFlightTransactions ||
          this.inFlightBytes + frameBytes > this.options.maxInFlightBytes
        ) {
          return;
        }
        await this.send({
          type: "transaction",
          protocolVersion: this.options.protocolVersion,
          artifactId: this.artifactId,
          streamEpoch: this.streamEpoch,
          transaction: ownedTransaction,
        });
        this.sentSequence = ownedTransaction.endSequence;
        this.sentStateHash = ownedTransaction.stateHash;
        this.boundaries.set(ownedTransaction.endSequence, ownedTransaction.stateHash);
        const sentAt = this.dependencies.clock.now().getTime();
        this.inFlight.set(ownedTransaction.endSequence, {
          bytes: frameBytes,
          stateHash: ownedTransaction.stateHash,
          sentAt,
        });
        this.inFlightBytes += frameBytes;
        if (this.oldestInFlightAt === 0) this.oldestInFlightAt = sentAt;
        progressed = true;
        if (this.sentSequence >= through) break;
      }
      if (!progressed) return;
    }
  }

  private async applyAcknowledgement(frame: EditableArtifactLiveAppliedClientFrame): Promise<void> {
    if (frame.sequence < this.ackedSequence || frame.sequence > this.sentSequence) {
      await this.requireResync("invalid_ack", this.targetHead);
      return;
    }
    const expected =
      frame.sequence === this.ackedSequence
        ? this.ackedStateHash
        : this.boundaries.get(frame.sequence);
    if (!expected || expected !== frame.stateHash) {
      await this.requireResync("invalid_ack", this.targetHead);
      return;
    }
    if (frame.sequence > this.ackedSequence) {
      await this.dependencies.read.acknowledgeReplica({
        scope: this.ticket.scope,
        artifactId: this.artifactId,
        replicaId: this.ticket.actor.replicaId,
        actorKey: editableArtifactActorKey(this.ticket.actor),
        streamEpoch: this.streamEpoch,
        sequence: frame.sequence,
        stateHash: frame.stateHash,
      });
      this.ackedSequence = frame.sequence;
      this.ackedStateHash = frame.stateHash;
      for (const [sequence, inFlight] of this.inFlight) {
        if (sequence <= frame.sequence) {
          this.inFlight.delete(sequence);
          this.inFlightBytes -= inFlight.bytes;
        }
      }
      for (const sequence of this.boundaries.keys()) {
        if (sequence < frame.sequence) this.boundaries.delete(sequence);
      }
      this.oldestInFlightAt =
        this.inFlight.size === 0
          ? 0
          : Math.min(...[...this.inFlight.values()].map((value) => value.sentAt));
    }
    await this.send({
      type: "applied",
      protocolVersion: this.options.protocolVersion,
      artifactId: this.artifactId,
      streamEpoch: this.streamEpoch,
      sequence: frame.sequence,
      stateHash: frame.stateHash,
    });
    await this.reconcileFromDurableHead();
  }

  private async applyMutation(
    frame: EditableArtifactLiveMutationClientFrame,
  ): Promise<EditableArtifactLiveMutationReceipt> {
    // Refresh both permissions at one local revision. An old allowed=true must
    // never re-enable writes after a newer revocation was observed.
    await this.reauthorize();
    if (this.closedValue) {
      throw new EditableArtifactLiveError(
        "permission_changed",
        "Editable artifact read permission changed",
      );
    }
    if (!this.writable) {
      throw new EditableArtifactLiveError(
        "permission_changed",
        "Editable artifact edit permission denied",
      );
    }
    let result: Awaited<ReturnType<EditableArtifactService["applyTransaction"]>>;
    try {
      result = await this.dependencies.domain.applyTransaction({
        scope: this.ticket.scope,
        artifactId: this.artifactId,
        actor: this.ticket.actor,
        request: {
          intentBytes: frame.intentBytes.slice(),
          requestHash: frame.requestHash,
        },
      });
    } catch (error) {
      // The domain is authoritative for the mutation/revocation race. Refresh
      // presentation permissions before returning the request-scoped failure.
      await this.reauthorize();
      throw error;
    }
    const transaction = await this.dependencies.read.readCommittedTransaction({
      scope: this.ticket.scope,
      artifactId: this.artifactId,
      transactionId: result.receipt.serverTransactionId,
    });
    if (
      !transaction ||
      result.receipt.modality !== this.modality ||
      transaction.modality !== this.modality ||
      transaction.startSequence !== result.receipt.sequenceStart ||
      transaction.endSequence !== result.receipt.sequenceEnd ||
      transaction.transactionId !== result.receipt.serverTransactionId ||
      result.receipt.requestHash !== frame.requestHash ||
      transaction.requestHash !== result.receipt.requestHash ||
      transaction.stateHash !== result.receipt.stateHash
    ) {
      await this.requireResync("durable_gap", this.targetHead);
      throw new EditableArtifactLiveError(
        "durable_gap",
        "Committed mutation is unavailable from durable replay",
        { requiresSnapshot: true },
      );
    }
    validateTransaction(
      transaction,
      this.artifactId,
      this.modality,
      Math.min(
        this.options.replayPageBytes,
        Math.max(0, this.options.maxOutboundFrameBytes - 64 * 1024),
      ),
    );
    const ownedTransaction = ownTransaction(transaction);
    await this.reconcileFromDurableHead();
    return Object.freeze({
      clientTransactionId: result.receipt.clientTransactionId,
      requestHash: result.receipt.requestHash,
      transaction: ownedTransaction,
    });
  }

  private async reauthorize(): Promise<void> {
    let readDecision = await this.checkPermission("read");
    let editDecision = await this.checkPermission("edit");
    const targetRevision = Math.max(
      this.authorizationRevision,
      readDecision.revision,
      editDecision.revision,
    );
    // A policy update can land between the two reads. Retry only the stale
    // decision once; persistent revision skew fails closed below.
    if (readDecision.revision < targetRevision) {
      readDecision = await this.checkPermission("read");
    }
    if (editDecision.revision < targetRevision) {
      editDecision = await this.checkPermission("edit");
    }
    const coherentRevision = Math.max(targetRevision, readDecision.revision, editDecision.revision);
    if (readDecision.revision !== coherentRevision) {
      await this.close("permission_changed");
      return;
    }
    if (!readDecision.allowed) {
      await this.close("permission_changed");
      return;
    }
    const nextWritable = editDecision.revision === coherentRevision && editDecision.allowed;
    const revisionChanged = coherentRevision !== this.authorizationRevision;
    this.authorizationRevision = coherentRevision;
    if (nextWritable !== this.writable || revisionChanged) {
      this.writable = nextWritable;
      await this.sendAuthorization();
    }
  }

  private async sendAuthorization(): Promise<void> {
    await this.send({
      type: "authorizationChanged",
      protocolVersion: this.options.protocolVersion,
      artifactId: this.artifactId,
      streamEpoch: this.streamEpoch,
      writable: this.writable,
    });
  }

  private async requireRead(): Promise<number> {
    const decision = await this.checkPermission("read");
    if (!decision.allowed || decision.revision < this.authorizationRevision) {
      throw new EditableArtifactLiveError(
        "permission_changed",
        "Editable artifact read permission denied",
      );
    }
    return decision.revision;
  }

  private async checkPermission(
    permission: "read" | "edit",
  ): Promise<Awaited<ReturnType<EditableArtifactAuthorizationPort["authorize"]>>> {
    const decision = await this.dependencies.authorization.authorize({
      scope: this.ticket.scope,
      artifactId: this.artifactId,
      actor: this.ticket.actor,
      permission,
    });
    if (permission === "edit" && !this.ticket.allowEdit) {
      return Object.freeze({ ...decision, allowed: false });
    }
    return decision;
  }

  private async sendBarrier(): Promise<void> {
    if (!this.sentStateHash)
      throw new EditableArtifactLiveError("durable_gap", "Bootstrap has no state boundary");
    await this.send({
      type: "barrier",
      protocolVersion: this.options.protocolVersion,
      artifactId: this.artifactId,
      streamEpoch: this.streamEpoch,
      sequence: this.sentSequence,
      stateHash: this.sentStateHash,
    });
  }

  private async send(frame: EditableArtifactLiveServerFrame): Promise<void> {
    if (this.closedValue) return;
    const bytes = estimateFrameBytes(frame);
    if (bytes > this.options.maxOutboundFrameBytes) {
      throw new EditableArtifactLiveError(
        "oversized_frame",
        "Server live frame exceeds the byte limit",
        { requiresSnapshot: true },
      );
    }
    const buffered = this.sink.bufferedBytes();
    if (
      !Number.isSafeInteger(buffered) ||
      buffered < 0 ||
      buffered + bytes > this.options.maxSocketBufferedBytes
    ) {
      throw new EditableArtifactLiveError("slow_client", "Live socket send buffer is full", {
        retryable: true,
        requiresSnapshot: true,
      });
    }
    const timeout = new AbortController();
    try {
      await Promise.race([
        this.sink.send(frame),
        this.dependencies.scheduler.sleep(this.options.sendTimeoutMs, timeout.signal).then(() => {
          throw new EditableArtifactLiveError("slow_client", "Live socket write timed out", {
            retryable: true,
            requiresSnapshot: true,
          });
        }),
      ]);
    } finally {
      timeout.abort();
    }
  }

  private async requireResync(
    reason: "retention_gap" | "durable_gap" | "invalid_ack" | "slow_client" | "oversized_frame",
    headSequence: number,
  ): Promise<void> {
    if (this.closedValue) return;
    try {
      await this.send({
        type: "resyncRequired",
        protocolVersion: this.options.protocolVersion,
        artifactId: this.artifactId,
        streamEpoch: this.streamEpoch,
        reason,
        headSequence,
      });
    } catch {
      // A blocked transport may be unable to carry the advisory frame. The
      // typed close still forces a verified snapshot on reconnect.
    }
    await this.close(reason);
  }

  private async runMaintenance(): Promise<void> {
    let nextReconcile = this.dependencies.clock.now().getTime() + this.options.reconcileIntervalMs;
    let nextAuthorization =
      this.dependencies.clock.now().getTime() + this.options.reauthorizeIntervalMs;
    const tick = Math.max(
      10,
      Math.min(
        this.options.reconcileIntervalMs,
        this.options.reauthorizeIntervalMs,
        this.options.ackTimeoutMs,
      ),
    );
    while (!this.abort.signal.aborted) {
      await this.dependencies.scheduler.sleep(tick, this.abort.signal);
      if (this.abort.signal.aborted || this.closedValue) return;
      const now = this.dependencies.clock.now().getTime();
      if (this.oldestInFlightAt !== 0 && now - this.oldestInFlightAt >= this.options.ackTimeoutMs) {
        await this.enqueue(() => this.requireResync("slow_client", this.targetHead));
        return;
      }
      if (now >= nextAuthorization) {
        await this.reauthorizeNow();
        nextAuthorization = now + this.options.reauthorizeIntervalMs;
      }
      if (this.closedValue) return;
      if (now >= nextReconcile) {
        await this.reconcileNow();
        nextReconcile = now + this.options.reconcileIntervalMs;
      }
    }
  }

  private async fail(error: unknown): Promise<void> {
    if (this.closedValue) return;
    if (error instanceof EditableArtifactLiveError) {
      if (
        error.requiresSnapshot &&
        ["durable_gap", "retention_gap", "invalid_ack", "slow_client", "oversized_frame"].includes(
          error.code,
        )
      ) {
        await this.requireResync(
          error.code as
            | "durable_gap"
            | "retention_gap"
            | "invalid_ack"
            | "slow_client"
            | "oversized_frame",
          this.targetHead,
        );
        return;
      }
      await this.close(error.code === "invalid_ticket" ? "transport_error" : error.code);
      return;
    }
    await this.close("transport_error");
  }
}

function decodeClientFrame(
  bytes: Uint8Array,
  artifactId: EditableArtifactId,
  streamEpoch: string,
  protocolVersion: number,
): EditableArtifactLiveClientFrame {
  let value: unknown;
  try {
    value = JSON.parse(strictDecoder.decode(bytes));
  } catch (cause) {
    throw new EditableArtifactLiveError(
      "invalid_frame",
      "Client live frame is not valid UTF-8 JSON",
      { cause },
    );
  }
  const frame = plainRecord(value, "client frame");
  const type = requiredString(frame, "type", 32);
  const actualProtocol = requiredSafeInteger(frame, "protocolVersion");
  const actualArtifact = editableArtifactId(requiredString(frame, "artifactId", 64));
  const actualEpoch = requiredString(frame, "streamEpoch", MAX_IDENTIFIER_BYTES);
  if (actualProtocol !== protocolVersion)
    throw new EditableArtifactLiveError("protocol_mismatch", "Client frame protocol mismatch");
  if (actualArtifact !== artifactId)
    throw new EditableArtifactLiveError("invalid_frame", "Client frame artifact mismatch");
  if (actualEpoch !== streamEpoch)
    throw new EditableArtifactLiveError(
      "stale_epoch",
      "Client frame belongs to a stale stream epoch",
    );
  if (type === "applied") {
    rejectUnknown(frame, [
      "type",
      "protocolVersion",
      "artifactId",
      "streamEpoch",
      "sequence",
      "stateHash",
    ]);
    return validateAppliedFrame(
      Object.freeze({
        type,
        protocolVersion,
        artifactId,
        streamEpoch,
        sequence: requiredSafeInteger(frame, "sequence"),
        stateHash: editableArtifactStateHash(requiredString(frame, "stateHash", 80)),
      }),
      artifactId,
      streamEpoch,
      protocolVersion,
    );
  }
  throw new EditableArtifactLiveError("invalid_frame", `Unknown client live frame: ${type}`);
}

function validateAppliedFrame(
  frame: EditableArtifactLiveAppliedClientFrame,
  artifactId: EditableArtifactId,
  streamEpoch: string,
  protocolVersion: number,
): EditableArtifactLiveAppliedClientFrame {
  if (frame.type !== "applied") {
    throw new EditableArtifactLiveError("invalid_frame", "Client frame is not an apply ACK");
  }
  if (frame.protocolVersion !== protocolVersion) {
    throw new EditableArtifactLiveError("protocol_mismatch", "Client frame protocol mismatch");
  }
  if (editableArtifactId(frame.artifactId) !== artifactId) {
    throw new EditableArtifactLiveError("invalid_frame", "Client frame artifact mismatch");
  }
  boundedString(frame.streamEpoch, "stream epoch", MAX_IDENTIFIER_BYTES);
  if (frame.streamEpoch !== streamEpoch) {
    throw new EditableArtifactLiveError(
      "stale_epoch",
      "Client frame belongs to a stale stream epoch",
    );
  }
  assertNonnegativeSafeInteger(frame.sequence, "applied sequence");
  return Object.freeze({
    type: "applied",
    protocolVersion,
    artifactId,
    streamEpoch,
    sequence: frame.sequence,
    stateHash: editableArtifactStateHash(frame.stateHash),
  });
}

function validateResume(
  resume: EditableArtifactLiveResume,
  durableModality: EditableArtifactModality,
): void {
  const resumeModality = resume.modality ?? "spreadsheet";
  if (resumeModality !== durableModality) {
    throw new EditableArtifactLiveError(
      "invalid_frame",
      "Resume modality differs from the durable artifact",
    );
  }
  if (resume.localCursor !== null) assertNonnegativeSafeInteger(resume.localCursor, "local cursor");
  if (resume.localStateHash !== null) editableArtifactStateHash(resume.localStateHash);
  if (resumeModality === "spreadsheet") {
    if (!("localCausalFrontier" in resume)) {
      throw new TypeError("spreadsheet resume requires a causal frontier");
    }
    validateFrontier(resume.localCausalFrontier, "local causal frontier");
  } else if ("localNativeRevision" in resume && resume.localNativeRevision !== null) {
    assertNonnegativeSafeInteger(resume.localNativeRevision, "local native revision");
  } else if (!("localNativeRevision" in resume)) {
    throw new TypeError("serialized resume requires a native revision");
  }
  if (typeof resume.requireSnapshot !== "boolean")
    throw new TypeError("requireSnapshot must be boolean");
  if ((resume.localCursor === null) !== (resume.localStateHash === null)) {
    throw new TypeError("resume cursor and state hash must both be null or present");
  }
  if (
    resumeModality !== "spreadsheet" &&
    "localNativeRevision" in resume &&
    (resume.localCursor === null) !== (resume.localNativeRevision === null)
  ) {
    throw new TypeError(
      "serialized resume cursor and native revision must both be null or present",
    );
  }
}

function validateBootstrap(
  bootstrap: EditableArtifactLiveBootstrap,
  artifactId: EditableArtifactId,
  durableModality: EditableArtifactModality,
  resume: EditableArtifactLiveResume,
  options: NormalizedOptions,
): void {
  validateHead(bootstrap, durableModality);
  assertNonnegativeSafeInteger(bootstrap.resumeSequence, "bootstrap resume sequence");
  editableArtifactStateHash(bootstrap.resumeStateHash);
  if (typeof bootstrap.resumeAccepted !== "boolean")
    throw new TypeError("resumeAccepted must be boolean");
  if (bootstrap.resumeSequence > bootstrap.headSequence)
    throw new TypeError("bootstrap resume is beyond head");
  if (
    bootstrap.resumeAccepted &&
    (resume.requireSnapshot ||
      resume.localCursor === null ||
      resume.localStateHash === null ||
      bootstrap.resumeSequence !== resume.localCursor ||
      bootstrap.resumeStateHash !== resume.localStateHash)
  ) {
    throw new TypeError("bootstrap accepted a different or unverified resume boundary");
  }
  if (bootstrap.snapshot) {
    const snapshot = bootstrap.snapshot;
    if (snapshot.modality !== durableModality) throw new TypeError("snapshot modality mismatch");
    if (snapshot.artifactId !== artifactId) throw new TypeError("snapshot artifact mismatch");
    assertNonnegativeSafeInteger(snapshot.sequence, "snapshot sequence");
    if (snapshot.sequence > bootstrap.headSequence) throw new TypeError("snapshot is beyond head");
    editableArtifactStateHash(snapshot.stateHash);
    if (snapshot.modality === "spreadsheet") {
      validateFrontier(snapshot.causalFrontier, "snapshot causal frontier");
      assertPositiveSafeInteger(
        snapshot.operationProtocolVersion,
        "snapshot operation protocol version",
      );
    } else {
      assertNonnegativeSafeInteger(snapshot.nativeRevision, "snapshot native revision");
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(snapshot.digest))
      throw new TypeError("snapshot digest is malformed");
    assertPositiveSafeInteger(snapshot.modelSchemaVersion, "snapshot model schema version");
    boundedString(
      snapshot.kernelVersion,
      "snapshot kernel version",
      EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
    );
    if (
      !(snapshot.bytes instanceof Uint8Array) ||
      snapshot.bytes.byteLength > options.maxSnapshotBytes
    ) {
      throw new EditableArtifactLiveError("oversized_frame", "Snapshot bytes exceed live limit", {
        requiresSnapshot: true,
      });
    }
  }
}

function validateHead(
  head:
    | EditableArtifactLiveBootstrap
    | Awaited<ReturnType<EditableArtifactLiveReadPort["readHead"]>>,
  durableModality: EditableArtifactModality,
): void {
  if (head.modality !== durableModality) throw new TypeError("durable live head modality mismatch");
  assertNonnegativeSafeInteger(head.headSequence, "head sequence");
  assertNonnegativeSafeInteger(head.minimumReplaySequence, "minimum replay sequence");
  if (head.minimumReplaySequence > head.headSequence + 1)
    throw new TypeError("minimum replay sequence is beyond head");
  editableArtifactStateHash(head.stateHash);
  if (head.modality === "spreadsheet") {
    validateFrontier(head.causalFrontier, "head causal frontier");
  } else {
    assertNonnegativeSafeInteger(head.nativeRevision, "head native revision");
  }
}

function validatePage(
  page: {
    transactions: readonly EditableArtifactLiveCommittedTransaction[];
    headSequence: number;
    minimumReplaySequence: number;
  },
  after: number,
  through: number,
  maxCount: number,
  maxBytes: number,
): void {
  if (!Array.isArray(page.transactions)) throw new TypeError("transaction page is malformed");
  assertNonnegativeSafeInteger(page.headSequence, "page head sequence");
  assertNonnegativeSafeInteger(page.minimumReplaySequence, "page minimum replay sequence");
  if (page.headSequence < through || after > through)
    throw new TypeError("transaction page does not cover requested target");
  if (page.transactions.length > maxCount) {
    throw new EditableArtifactLiveError(
      "oversized_frame",
      "Durable transaction page exceeds the count limit",
      { requiresSnapshot: true },
    );
  }
  let bytes = 0;
  for (const transaction of page.transactions) {
    bytes += transaction.committedTransactionBytes.byteLength;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
      throw new EditableArtifactLiveError(
        "oversized_frame",
        "Durable transaction page exceeds the byte limit",
        { requiresSnapshot: true },
      );
    }
  }
}

function validateTransaction(
  transaction: EditableArtifactLiveCommittedTransaction,
  artifactId: EditableArtifactId,
  durableModality: EditableArtifactModality,
  maxBytes: number,
): void {
  if (transaction.artifactId !== artifactId) throw new TypeError("transaction artifact mismatch");
  if (transaction.modality !== durableModality)
    throw new TypeError("transaction modality differs from the durable artifact");
  editableArtifactTransactionId(transaction.transactionId);
  assertPositiveSafeInteger(transaction.startSequence, "transaction start sequence");
  assertPositiveSafeInteger(transaction.endSequence, "transaction end sequence");
  if (transaction.endSequence < transaction.startSequence)
    throw new TypeError("transaction sequence interval is inverted");
  editableArtifactRequestHash(transaction.requestHash);
  editableArtifactStateHash(transaction.priorStateHash);
  editableArtifactStateHash(transaction.stateHash);
  if (transaction.modality === "spreadsheet") {
    assertPositiveSafeInteger(
      transaction.operationProtocolVersion,
      "transaction operation protocol version",
    );
    validateFrontier(transaction.causalFrontier, "transaction causal frontier");
  } else {
    assertPositiveSafeInteger(
      transaction.commitProtocolVersion,
      "transaction commit protocol version",
    );
    assertNonnegativeSafeInteger(
      transaction.priorNativeRevision,
      "transaction prior native revision",
    );
    assertNonnegativeSafeInteger(transaction.nativeRevision, "transaction native revision");
  }
  if (
    !(transaction.committedTransactionBytes instanceof Uint8Array) ||
    transaction.committedTransactionBytes.byteLength === 0 ||
    transaction.committedTransactionBytes.byteLength > maxBytes
  ) {
    throw new EditableArtifactLiveError(
      "oversized_frame",
      "Canonical transaction bytes exceed live limit",
      { requiresSnapshot: true },
    );
  }
  try {
    if (transaction.modality === "spreadsheet") {
      const summary = decodeCommittedTransactionSummary(transaction.committedTransactionBytes);
      if (
        summary.transactionId !== transaction.transactionId ||
        summary.priorStateHash !== transaction.priorStateHash ||
        summary.stateHash !== transaction.stateHash ||
        summary.operationProtocolVersion !== transaction.operationProtocolVersion ||
        !sameFrontier(summary.resultingCausalFrontier, transaction.causalFrontier)
      ) {
        throw new TypeError("spreadsheet transaction projection mismatch");
      }
    } else {
      const summary = decodeEditableArtifactSerializedCommit(
        transaction.committedTransactionBytes,
        transaction.modality,
      );
      if (
        summary.transactionId !== transaction.transactionId ||
        summary.requestHash !== transaction.requestHash ||
        summary.parentHeadSequence !== transaction.startSequence - 1 ||
        summary.resultHeadSequence !== transaction.endSequence ||
        summary.priorStateHash !== transaction.priorStateHash ||
        summary.stateHash !== transaction.stateHash ||
        summary.priorNativeRevision !== transaction.priorNativeRevision ||
        summary.nativeReceipt.revision !== transaction.nativeRevision ||
        summary.commitProtocolVersion !== transaction.commitProtocolVersion
      ) {
        throw new TypeError("serialized transaction projection mismatch");
      }
    }
  } catch (cause) {
    throw new EditableArtifactLiveError(
      "durable_gap",
      "Canonical transaction bytes disagree with durable live metadata",
      { requiresSnapshot: true, cause },
    );
  }
}

function estimateFrameBytes(frame: EditableArtifactLiveServerFrame): number {
  if (frame.type === "snapshot") {
    const { bytes, ...metadata } = frame;
    return textEncoder.encode(JSON.stringify(metadata)).byteLength + bytes.byteLength + 128;
  }
  if (frame.type === "transaction") {
    const { committedTransactionBytes, ...transaction } = frame.transaction;
    return (
      textEncoder.encode(JSON.stringify({ ...frame, transaction })).byteLength +
      committedTransactionBytes.byteLength +
      128
    );
  }
  return textEncoder.encode(JSON.stringify(frame)).byteLength;
}

function validateFrontier(
  frontier: EditableArtifactCausalFrontier,
  label: string,
): EditableArtifactCausalFrontier {
  if (!Array.isArray(frontier) || frontier.length > MAX_CAUSAL_ACTORS) {
    throw new EditableArtifactLiveError(
      "oversized_frame",
      `${label} exceeds ${MAX_CAUSAL_ACTORS} actors`,
      { requiresSnapshot: true },
    );
  }
  const normalized = editableArtifactCausalFrontier(frontier);
  if (normalized.length > MAX_CAUSAL_ACTORS) {
    throw new EditableArtifactLiveError(
      "oversized_frame",
      `${label} exceeds ${MAX_CAUSAL_ACTORS} actors`,
      { requiresSnapshot: true },
    );
  }
  return normalized;
}

function sameFrontier(
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

function ownTransaction(
  transaction: EditableArtifactLiveCommittedTransaction,
): EditableArtifactLiveCommittedTransaction {
  return transaction.modality === "spreadsheet"
    ? Object.freeze({
        ...transaction,
        causalFrontier: validateFrontier(transaction.causalFrontier, "transaction causal frontier"),
        committedTransactionBytes: transaction.committedTransactionBytes.slice(),
      })
    : Object.freeze({
        ...transaction,
        committedTransactionBytes: transaction.committedTransactionBytes.slice(),
      });
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EditableArtifactLiveError("invalid_frame", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EditableArtifactLiveError("invalid_frame", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, maxBytes: number): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new EditableArtifactLiveError("invalid_frame", `${key} must be a string`);
  boundedString(value, key, maxBytes);
  return value;
}

function requiredSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value))
    throw new EditableArtifactLiveError("invalid_frame", `${key} must be a safe integer`);
  return value as number;
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown)
    throw new EditableArtifactLiveError(
      "invalid_frame",
      `Unknown client frame property: ${unknown}`,
    );
}

function boundedString(value: string, label: string, maxBytes: number): void {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes < 1 || bytes > maxBytes || value.trim() !== value)
    throw new TypeError(`${label} is malformed`);
}

function normalizeOptions(options: EditableArtifactLiveServerOptions): NormalizedOptions {
  const normalized = {
    protocolVersion: options.protocolVersion ?? EDITABLE_ARTIFACT_LIVE_PROTOCOL_VERSION,
    maxClientFrameBytes: options.maxClientFrameBytes ?? DEFAULT_MAX_CLIENT_FRAME_BYTES,
    maxOutboundFrameBytes: options.maxOutboundFrameBytes ?? DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
    maxSnapshotBytes: options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
    snapshotChunkBytes: options.snapshotChunkBytes ?? DEFAULT_SNAPSHOT_CHUNK_BYTES,
    maxInFlightTransactions: options.maxInFlightTransactions ?? DEFAULT_MAX_IN_FLIGHT_TRANSACTIONS,
    maxInFlightBytes: options.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES,
    replayPageTransactions: options.replayPageTransactions ?? DEFAULT_REPLAY_PAGE_TRANSACTIONS,
    replayPageBytes: options.replayPageBytes ?? DEFAULT_REPLAY_PAGE_BYTES,
    maxSocketBufferedBytes: options.maxSocketBufferedBytes ?? DEFAULT_MAX_SOCKET_BUFFERED_BYTES,
    maxInboundQueueFrames: options.maxInboundQueueFrames ?? DEFAULT_MAX_INBOUND_QUEUE_FRAMES,
    maxInboundQueueBytes: options.maxInboundQueueBytes ?? DEFAULT_MAX_INBOUND_QUEUE_BYTES,
    reconcileIntervalMs: options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    reauthorizeIntervalMs: options.reauthorizeIntervalMs ?? DEFAULT_REAUTHORIZE_INTERVAL_MS,
    ackTimeoutMs: options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
    sendTimeoutMs: options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
    ...(options.ticketTtlMs === undefined ? {} : { ticketTtlMs: options.ticketTtlMs }),
  };
  for (const [label, value] of Object.entries(normalized)) {
    if (label === "ticketTtlMs") continue;
    assertPositiveSafeInteger(value, label);
  }
  if (normalized.maxSnapshotBytes > EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES) {
    throw new TypeError("maxSnapshotBytes exceeds the browser-compatible product limit");
  }
  if (normalized.snapshotChunkBytes + 1024 > normalized.maxOutboundFrameBytes) {
    throw new TypeError("snapshot chunk exceeds maximum outbound frame");
  }
  if (normalized.replayPageBytes < normalized.maxOutboundFrameBytes) {
    throw new TypeError("replay page bytes must cover one maximum outbound frame");
  }
  return Object.freeze(normalized);
}

function closeValue(reason: EditableArtifactLiveCloseReason): EditableArtifactLiveClose {
  return Object.freeze({
    reason,
    retryable: ["ticket_expired", "permission_changed", "slow_client", "transport_error"].includes(
      reason,
    ),
    requiresSnapshot: [
      "invalid_ack",
      "retention_gap",
      "durable_gap",
      "slow_client",
      "oversized_frame",
    ].includes(reason),
  });
}

function safeRelease(release: (() => void) | null): void {
  try {
    release?.();
  } catch {
    // Subscription/listener teardown is best effort after the session has
    // already transitioned to its terminal state.
  }
}

export class SystemEditableArtifactLiveClock implements EditableArtifactLiveClockPort {
  now(): Date {
    return new Date();
  }
}

export class SystemEditableArtifactLiveScheduler implements EditableArtifactLiveSchedulerPort {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }
}

// Re-export port names from this module's type surface for structural server factories.
export type {
  EditableArtifactAuthorizationPort,
  EditableArtifactService,
  EditableArtifactLiveAuthorizationInvalidationPort,
  EditableArtifactLiveHintPort,
  EditableArtifactLiveReadPort,
  EditableArtifactLiveSchedulerPort,
  EditableArtifactLiveSinkPort,
  EditableArtifactLiveTicketStorePort,
  EditableArtifactLiveTokenPort,
};
