import {
  decodeEditableArtifactLiveServerWireFrame,
  encodeEditableArtifactLiveAppliedWireFrame,
  encodeEditableArtifactLiveMutationWireFrame,
  encodeEditableArtifactLiveOpenWireFrame,
  type EditableArtifactLiveOpenWireFrame,
  type EditableArtifactLiveCommittedTransaction as ContractCommittedTransaction,
  type EditableArtifactLiveServerFrame,
} from "@opengeni/contracts/editable-artifact-live";
import {
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
  hashEditableArtifactMutationIntentBytes,
} from "@opengeni/contracts/editable-artifacts";
import { MAX_COMMITTED_TRANSACTION_BYTES } from "@opengeni/contracts/editable-artifact-committed-transaction";
import { EditableArtifactSyncError, EditableArtifactTransportError } from "./errors";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "../types";
import type {
  EditableArtifactBootstrap,
  EditableArtifactCausalFrontier,
  EditableArtifactCommittedTransaction,
  EditableArtifactLiveClose,
  EditableArtifactLiveConnection,
  EditableArtifactLiveLimits,
  EditableArtifactLiveMessage,
  EditableArtifactModality,
  EditableArtifactPendingTransaction,
  EditableArtifactReplayPage,
  EditableArtifactSnapshot,
  EditableArtifactSubmitReceipt,
  EditableArtifactSyncTicket,
  EditableArtifactSyncTransport,
} from "./types";

const LIVE_PATH = "/v1/editable-artifacts/live";
const LIVE_SUBPROTOCOL = "opengeni-artifact-v1";
const DEFAULT_MAX_SERVER_FRAME_BYTES = 8 * 1024 * 1024 + 64 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
const MAX_TICKET_RESPONSE_BYTES = 16 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const STABLE_ID = /^(?!0{32}$)[0-9a-f]{32}$/u;
const REPLICA_ID = /^(?!0{16}$)[0-9a-f]{16}$/u;

export type EditableArtifactWebSocketMessageEvent = Readonly<{ data: unknown }>;
export type EditableArtifactWebSocketCloseEvent = Readonly<{
  code?: number;
  reason?: string;
}>;

export type EditableArtifactWebSocketLike = {
  binaryType: string;
  readonly protocol: string;
  readonly readyState: number;
  send(data: Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: EditableArtifactWebSocketMessageEvent) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: EditableArtifactWebSocketCloseEvent) => void,
  ): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: EditableArtifactWebSocketMessageEvent) => void,
  ): void;
  removeEventListener(type: "error", listener: () => void): void;
  removeEventListener(
    type: "close",
    listener: (event: EditableArtifactWebSocketCloseEvent) => void,
  ): void;
};

export type CreateEditableArtifactHttpLiveTransportOptions = Readonly<{
  baseUrl: string | URL;
  workspaceId: string;
  protocolVersion: number;
  kernelVersion: string;
  modelSchemaVersion: number;
  apiKey?: string;
  headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  webSocketUrl?: string | URL;
  webSocketFactory?: (url: string, protocol: string) => EditableArtifactWebSocketLike;
  allowInsecureDevelopmentTransport?: boolean;
  maximumServerFrameBytes?: number;
  maximumSnapshotBytes?: number;
  handshakeTimeoutMs?: number;
  submitTimeoutMs?: number;
}>;

/**
 * Production HTTP + authenticated binary WebSocket transport. The one-use
 * ticket is sent only inside the first OGALV frame, never in the socket URL.
 */
export function createEditableArtifactHttpLiveTransport(
  options: CreateEditableArtifactHttpLiveTransportOptions,
): EditableArtifactSyncTransport {
  return new HttpLiveTransport(options);
}

class HttpLiveTransport implements EditableArtifactSyncTransport {
  private readonly baseUrl: URL;
  private readonly socketUrl: URL;
  private readonly workspaceId: string;
  private readonly protocolVersion: number;
  private readonly kernelVersion: string;
  private readonly modelSchemaVersion: number;
  private readonly apiKey: string | undefined;
  private readonly headerSource: CreateEditableArtifactHttpLiveTransportOptions["headers"];
  private readonly credentials: RequestCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: NonNullable<
    CreateEditableArtifactHttpLiveTransportOptions["webSocketFactory"]
  >;
  private readonly maximumServerFrameBytes: number;
  private readonly maximumSnapshotBytes: number;
  private readonly handshakeTimeoutMs: number;
  private readonly submitTimeoutMs: number;

  constructor(options: CreateEditableArtifactHttpLiveTransportOptions) {
    this.baseUrl = transportBaseUrl(options.baseUrl);
    this.socketUrl = socketUrl(options.webSocketUrl, this.baseUrl);
    const insecure = options.allowInsecureDevelopmentTransport ?? false;
    requireTransportSecurity(this.baseUrl, this.socketUrl, insecure);
    this.workspaceId = boundedString(options.workspaceId, "workspaceId", 256);
    this.protocolVersion = positiveU16(options.protocolVersion, "protocolVersion");
    this.kernelVersion = boundedString(options.kernelVersion, "kernelVersion", 512);
    this.modelSchemaVersion = positiveU16(options.modelSchemaVersion, "modelSchemaVersion");
    this.apiKey = options.apiKey;
    if (this.apiKey !== undefined) boundedString(this.apiKey, "apiKey", 16 * 1024);
    this.headerSource = options.headers;
    this.credentials = options.credentials ?? "same-origin";
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.maximumServerFrameBytes = positiveBounded(
      options.maximumServerFrameBytes ?? DEFAULT_MAX_SERVER_FRAME_BYTES,
      128 * 1024 * 1024,
      "maximumServerFrameBytes",
    );
    this.maximumSnapshotBytes = positiveBounded(
      options.maximumSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
      EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
      "maximumSnapshotBytes",
    );
    this.handshakeTimeoutMs = positiveBounded(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      5 * 60_000,
      "handshakeTimeoutMs",
    );
    this.submitTimeoutMs = positiveBounded(
      options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS,
      5 * 60_000,
      "submitTimeoutMs",
    );
  }

  async mintTicket(input: {
    artifactId: string;
    replicaId: string;
    signal: AbortSignal;
  }): Promise<EditableArtifactSyncTicket> {
    requireStableId(input.artifactId, "artifactId");
    requireReplicaId(input.replicaId);
    input.signal.throwIfAborted();
    const url = childUrl(
      this.baseUrl,
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/editable-artifacts/${encodeURIComponent(input.artifactId)}/live-ticket`,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        credentials: this.credentials,
        headers: {
          ...this.headers(),
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          replicaId: input.replicaId,
          protocolVersion: this.protocolVersion,
          kernelVersion: this.kernelVersion,
          modelSchemaVersion: this.modelSchemaVersion,
        }),
        signal: input.signal,
      });
    } catch (cause) {
      input.signal.throwIfAborted();
      throw new EditableArtifactTransportError("editable artifact ticket request failed", {
        code: "ticket_transport_error",
        cause,
      });
    }
    if (!response.ok) {
      await response.body?.cancel("ticket request rejected").catch(() => undefined);
      throw new EditableArtifactTransportError(
        `editable artifact ticket request failed with HTTP ${response.status}`,
        {
          code: response.status === 403 ? "permission_changed" : "ticket_rejected",
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        },
      );
    }
    const value = await readBoundedJson(response, MAX_TICKET_RESPONSE_BYTES);
    return validateTicket(value, input.artifactId, input.replicaId, this.protocolVersion);
  }

  async openLive(input: {
    ticket: EditableArtifactSyncTicket;
    after: number;
    stateHash: string | null;
    resume:
      | { modality: "spreadsheet"; causalFrontier: EditableArtifactCausalFrontier }
      | { modality: "document" | "presentation"; nativeRevision: number | null };
    requireSnapshot: boolean;
    signal: AbortSignal;
    onMessage: (message: EditableArtifactLiveMessage) => void;
  }): Promise<EditableArtifactLiveConnection> {
    if (input.resume.modality !== input.ticket.modality) {
      throw new TypeError("live resume modality does not match its ticket");
    }
    if (
      input.resume.modality !== "spreadsheet" &&
      (input.stateHash === null) !== (input.resume.nativeRevision === null)
    ) {
      throw new TypeError(
        "serialized live resume state hash and native revision must be present together",
      );
    }
    const socket = this.webSocketFactory(this.socketUrl.href, LIVE_SUBPROTOCOL);
    const commonResume = {
      localCursor: input.stateHash === null ? null : safeSequence(input.after, "after"),
      localStateHash: input.stateHash,
      requireSnapshot: input.requireSnapshot || input.stateHash === null,
    } as const;
    const resume: EditableArtifactLiveOpenWireFrame["resume"] =
      input.resume.modality === "spreadsheet"
        ? {
            ...commonResume,
            localCausalFrontier: cloneFrontier(input.resume.causalFrontier),
          }
        : {
            ...commonResume,
            modality: input.resume.modality,
            localNativeRevision: input.resume.nativeRevision,
          };
    const connection = new HttpLiveConnection({
      socket,
      ticket: input.ticket,
      resume,
      kernelVersion: this.kernelVersion,
      modelSchemaVersion: this.modelSchemaVersion,
      maximumServerFrameBytes: this.maximumServerFrameBytes,
      maximumSnapshotBytes: this.maximumSnapshotBytes,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      submitTimeoutMs: this.submitTimeoutMs,
      signal: input.signal,
      onMessage: input.onMessage,
    });
    await connection.ready();
    return connection;
  }

  private headers(): Readonly<Record<string, string>> {
    const supplied =
      typeof this.headerSource === "function" ? this.headerSource() : this.headerSource;
    return {
      ...(supplied ?? {}),
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}

type ConnectionInput = Readonly<{
  socket: EditableArtifactWebSocketLike;
  ticket: EditableArtifactSyncTicket;
  resume: EditableArtifactLiveOpenWireFrame["resume"];
  kernelVersion: string;
  modelSchemaVersion: number;
  maximumServerFrameBytes: number;
  maximumSnapshotBytes: number;
  handshakeTimeoutMs: number;
  submitTimeoutMs: number;
  signal: AbortSignal;
  onMessage: (message: EditableArtifactLiveMessage) => void;
}>;

type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type SnapshotAssembly = {
  metadata: OmitEach<
    Extract<EditableArtifactLiveServerFrame, { type: "snapshot" }>,
    "bytes" | "offset" | "final"
  >;
  bytes: Uint8Array;
  nextOffset: number;
};

type PendingSubmission = {
  pending: EditableArtifactPendingTransaction;
  deferred: Deferred<EditableArtifactSubmitReceipt>;
  accepted: Extract<EditableArtifactLiveServerFrame, { type: "mutationAccepted" }> | null;
  timeout: ReturnType<typeof setTimeout>;
  sent: boolean;
};

class HttpLiveConnection implements EditableArtifactLiveConnection {
  private readonly socket: EditableArtifactWebSocketLike;
  private readonly ticket: EditableArtifactSyncTicket;
  private readonly resume: EditableArtifactLiveOpenWireFrame["resume"];
  private readonly kernelVersion: string;
  private readonly modelSchemaVersion: number;
  private readonly maximumServerFrameBytes: number;
  private readonly maximumSnapshotBytes: number;
  private readonly submitTimeoutMs: number;
  private readonly signal: AbortSignal;
  private readonly onMessage: (message: EditableArtifactLiveMessage) => void;
  private readonly readyDeferred = new Deferred<void>();
  private readonly closedDeferred = new Deferred<EditableArtifactLiveClose>();
  private readonly firstPostOpen = new Deferred<
    "snapshot" | "transaction" | "barrier" | "resync"
  >();
  private readonly snapshotDeferred = new Deferred<EditableArtifactSnapshot>();
  private readonly progressWaiters = new Set<Deferred<void>>();
  private readonly replayByStart = new Map<number, EditableArtifactCommittedTransaction>();
  private readonly transactionsById = new Map<string, EditableArtifactCommittedTransaction>();
  private readonly submissions = new Map<string, PendingSubmission>();
  private openFrame: Extract<EditableArtifactLiveServerFrame, { type: "open" }> | null = null;
  private snapshotAssembly: SnapshotAssembly | null = null;
  private snapshot: EditableArtifactSnapshot | null = null;
  private terminal: Error | null = null;
  private localClose = false;
  private bootstrapRead = false;
  private bootstrapDelivered = false;
  private messageTail: Promise<void> = Promise.resolve();
  private targetHead = 0;
  private barrierSequence: number | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout>;

  constructor(input: ConnectionInput) {
    this.socket = input.socket;
    this.ticket = input.ticket;
    this.resume = input.resume;
    this.kernelVersion = input.kernelVersion;
    this.modelSchemaVersion = input.modelSchemaVersion;
    this.maximumServerFrameBytes = input.maximumServerFrameBytes;
    this.maximumSnapshotBytes = input.maximumSnapshotBytes;
    this.submitTimeoutMs = input.submitTimeoutMs;
    this.signal = input.signal;
    this.onMessage = input.onMessage;
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", this.handleOpen);
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("error", this.handleError);
    this.socket.addEventListener("close", this.handleClose);
    this.signal.addEventListener("abort", this.handleAbort, { once: true });
    this.handshakeTimer = setTimeout(() => {
      this.fail(new EditableArtifactTransportError("editable artifact live handshake timed out"));
    }, input.handshakeTimeoutMs);
  }

  get streamEpoch(): string {
    return this.requireOpen().streamEpoch;
  }

  get limits(): EditableArtifactLiveLimits {
    const frame = this.requireOpen();
    return Object.freeze({
      maxClientFrameBytes: frame.maxClientFrameBytes,
      maxCommandBytes: frame.maxCommandBytes,
      maxIntentBytes: frame.maxIntentBytes,
      maxCommittedTransactionBytes: frame.maxCommittedTransactionBytes,
      maxSnapshotBytes: frame.maxSnapshotBytes,
      maxInFlightTransactions: frame.maxInFlightTransactions,
      maxInFlightBytes: frame.maxInFlightBytes,
    });
  }

  readonly closed = this.closedDeferred.promise;

  async ready(): Promise<void> {
    await abortable(this.readyDeferred.promise, this.signal);
  }

  async readBootstrap(input: {
    localCursor: number | null;
    localStateHash: string | null;
    resume:
      | { modality: "spreadsheet"; localCausalFrontier: EditableArtifactCausalFrontier }
      | { modality: "document" | "presentation"; localNativeRevision: number | null };
    requireSnapshot: boolean;
    signal: AbortSignal;
  }): Promise<EditableArtifactBootstrap> {
    if (this.bootstrapRead) throw new TypeError("live bootstrap may only be read once");
    this.bootstrapRead = true;
    const open = this.requireOpen();
    if (input.resume.modality !== this.ticket.modality) {
      throw new TypeError("bootstrap resume modality does not match its ticket");
    }
    if (
      input.resume.modality !== "spreadsheet" &&
      ((input.localCursor === null) !== (input.localStateHash === null) ||
        (input.localStateHash === null) !== (input.resume.localNativeRevision === null))
    ) {
      throw new TypeError(
        "serialized bootstrap cursor, state hash, and native revision must be present together",
      );
    }
    const first = await abortable(this.firstPostOpen.promise, input.signal);
    if (first === "resync") {
      clearTimeout(this.handshakeTimer);
      throw new EditableArtifactSyncError("resync_required", "server requires a fresh snapshot", {
        retryable: true,
        requiresSnapshot: true,
      });
    }
    let snapshot: EditableArtifactSnapshot | null = null;
    if (first === "snapshot")
      snapshot = await abortable(this.snapshotDeferred.promise, input.signal);
    if (input.requireSnapshot && snapshot === null) {
      throw new EditableArtifactSyncError(
        "invalid_bootstrap",
        "server omitted the required snapshot",
        {
          requiresSnapshot: true,
        },
      );
    }
    const boundarySequence = snapshot?.sequence ?? input.localCursor;
    const boundaryStateHash = snapshot?.stateHash ?? input.localStateHash;
    if (boundarySequence === null || boundaryStateHash === null) {
      throw new EditableArtifactSyncError(
        "invalid_bootstrap",
        "live stream established no state boundary",
        {
          requiresSnapshot: true,
        },
      );
    }
    if (boundarySequence > open.headSequence) {
      throw new EditableArtifactSyncError(
        "invalid_bootstrap",
        "local state is ahead of the live head",
        {
          requiresSnapshot: true,
        },
      );
    }
    const commonBootstrap = {
      artifactId: this.ticket.artifactId,
      protocolVersion: this.ticket.protocolVersion,
      headSequence: boundarySequence,
      headStateHash: boundaryStateHash,
      kernelVersion: snapshot?.kernelVersion ?? this.kernelVersion,
      modelSchemaVersion: snapshot?.modelSchemaVersion ?? this.modelSchemaVersion,
      writable: open.writable,
      minimumReplaySequence: open.minimumReplaySequence,
      snapshot,
      resyncRequired: false,
    } as const;
    const bootstrap: EditableArtifactBootstrap =
      this.ticket.modality === "spreadsheet"
        ? {
            ...commonBootstrap,
            modality: "spreadsheet",
            headCausalFrontier: cloneFrontier(
              snapshot?.modality === "spreadsheet"
                ? snapshot.causalFrontier
                : input.resume.modality === "spreadsheet"
                  ? input.resume.localCausalFrontier
                  : [],
            ),
          }
        : {
            ...commonBootstrap,
            modality: this.ticket.modality,
            headNativeRevision: serializedBoundaryRevision(
              snapshot,
              input.resume,
              this.ticket.modality,
            ),
          };
    this.bootstrapDelivered = true;
    clearTimeout(this.handshakeTimer);
    return bootstrap;
  }

  async replay(input: {
    after: number;
    through: number;
    limit: number;
    signal: AbortSignal;
  }): Promise<EditableArtifactReplayPage> {
    const after = safeSequence(input.after, "replay after");
    const through = safeSequence(input.through, "replay through");
    const limit = positiveBounded(input.limit, 10_000, "replay limit");
    if (after >= through) {
      return {
        artifactId: this.ticket.artifactId,
        transactions: [],
        headSequence: this.targetHead,
      };
    }
    while (true) {
      this.throwIfTerminal();
      const transactions: EditableArtifactCommittedTransaction[] = [];
      let expected = after + 1;
      while (transactions.length < limit) {
        const transaction = this.replayByStart.get(expected);
        if (!transaction || transaction.endSequence > through) break;
        transactions.push(transaction);
        expected = transaction.endSequence + 1;
      }
      if (transactions.length > 0) {
        return {
          artifactId: this.ticket.artifactId,
          transactions: transactions.map(cloneCommitted),
          headSequence: this.targetHead,
        };
      }
      if (this.barrierSequence !== null && this.barrierSequence >= through) {
        throw new EditableArtifactSyncError(
          "invalid_sequence",
          `live stream omitted committed sequence ${after + 1}`,
          { retryable: true, requiresSnapshot: true },
        );
      }
      await this.waitForProgress(input.signal);
    }
  }

  async submit(input: {
    transaction: EditableArtifactPendingTransaction;
    signal: AbortSignal;
  }): Promise<EditableArtifactSubmitReceipt> {
    this.throwIfTerminal();
    const open = this.requireOpen();
    const pending = input.transaction;
    if (pending.artifactId !== this.ticket.artifactId) {
      throw new TypeError("pending transaction belongs to another artifact");
    }
    if (pending.protocolVersion !== this.ticket.protocolVersion) {
      throw new EditableArtifactTransportError("pending protocol does not match live stream", {
        code: "unsupported",
        retryable: false,
      });
    }
    if (
      pending.commandBytes.byteLength >
      Math.min(open.maxCommandBytes, EDITABLE_ARTIFACT_COMMAND_MAX_BYTES)
    ) {
      throw new EditableArtifactTransportError("pending command exceeds negotiated live limit", {
        code: "limit_exceeded",
        retryable: false,
      });
    }
    if (
      pending.intentBytes.byteLength >
      Math.min(open.maxIntentBytes, EDITABLE_ARTIFACT_INTENT_MAX_BYTES)
    ) {
      throw new EditableArtifactTransportError("pending intent exceeds negotiated live limit", {
        code: "limit_exceeded",
        retryable: false,
      });
    }
    if (hashEditableArtifactMutationIntentBytes(pending.intentBytes) !== pending.requestHash) {
      throw new TypeError("pending requestHash does not bind its exact OGATX bytes");
    }
    if (this.submissions.has(pending.requestHash)) {
      throw new TypeError("pending request is already submitted on this stream");
    }
    const frame = encodeEditableArtifactLiveMutationWireFrame({
      type: "mutation",
      protocolVersion: pending.protocolVersion,
      artifactId: pending.artifactId,
      streamEpoch: open.streamEpoch,
      requestHash: pending.requestHash,
      intentBytes: pending.intentBytes,
    });
    if (frame.byteLength > open.maxClientFrameBytes) {
      throw new EditableArtifactTransportError("pending frame exceeds negotiated live limit", {
        code: "limit_exceeded",
        retryable: false,
      });
    }
    const deferred = new Deferred<EditableArtifactSubmitReceipt>();
    const submission: PendingSubmission = {
      pending,
      deferred,
      accepted: null,
      sent: false,
      timeout: setTimeout(() => {
        if (!this.submissions.delete(pending.requestHash)) return;
        deferred.reject(
          new EditableArtifactTransportError("pending mutation response timed out", {
            code: "submit_timeout",
            outcomeUnknown: true,
          }),
        );
        this.close("submit_timeout");
      }, this.submitTimeoutMs),
    };
    this.submissions.set(pending.requestHash, submission);
    try {
      input.signal.throwIfAborted();
      this.socket.send(frame);
      submission.sent = true;
    } catch (cause) {
      clearTimeout(submission.timeout);
      this.submissions.delete(pending.requestHash);
      input.signal.throwIfAborted();
      throw new EditableArtifactTransportError("pending mutation send failed", {
        code: "transport_error",
        outcomeUnknown: true,
        cause,
      });
    }
    return await abortable(deferred.promise, input.signal);
  }

  async acknowledge(input: {
    sequence: number;
    stateHash: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.throwIfTerminal();
    input.signal.throwIfAborted();
    const frame = encodeEditableArtifactLiveAppliedWireFrame({
      type: "applied",
      protocolVersion: this.ticket.protocolVersion,
      artifactId: this.ticket.artifactId,
      streamEpoch: this.streamEpoch,
      sequence: safeSequence(input.sequence, "acknowledged sequence"),
      stateHash: requireSha256(input.stateHash, "acknowledged stateHash"),
    });
    if (frame.byteLength > this.limits.maxClientFrameBytes) {
      throw new TypeError("acknowledgement exceeds negotiated live limit");
    }
    try {
      this.socket.send(frame);
    } catch (cause) {
      throw new EditableArtifactTransportError("live acknowledgement send failed", { cause });
    }
    for (const [start, transaction] of this.replayByStart) {
      if (transaction.endSequence <= input.sequence) this.replayByStart.delete(start);
    }
  }

  close(reason = "closed"): void {
    if (this.terminal) return;
    this.localClose = true;
    try {
      this.socket.close(1000, boundedCloseReason(reason));
    } finally {
      this.finish({ reason: "closed" });
    }
  }

  private readonly handleOpen = (): void => {
    if (this.signal.aborted) {
      this.close("aborted");
      return;
    }
    try {
      if (this.socket.protocol !== LIVE_SUBPROTOCOL) {
        throw new EditableArtifactTransportError(
          "editable artifact WebSocket did not negotiate the required subprotocol",
          { code: "protocol_mismatch" },
        );
      }
      this.socket.send(
        encodeEditableArtifactLiveOpenWireFrame({
          type: "open",
          protocolVersion: this.ticket.protocolVersion,
          artifactId: this.ticket.artifactId,
          token: this.ticket.token,
          resume: this.resume,
        }),
      );
    } catch (cause) {
      this.fail(
        cause instanceof EditableArtifactTransportError
          ? cause
          : new EditableArtifactTransportError("live open frame send failed", { cause }),
      );
    }
  };

  private readonly handleMessage = (event: EditableArtifactWebSocketMessageEvent): void => {
    this.messageTail = this.messageTail
      .then(async () => {
        const bytes = await binaryMessage(event.data, this.maximumServerFrameBytes);
        this.handleServerFrame(decodeEditableArtifactLiveServerWireFrame(bytes));
      })
      .catch((cause: unknown) => {
        this.fail(
          cause instanceof Error
            ? cause
            : new EditableArtifactTransportError("invalid live server frame", { cause }),
        );
      });
  };

  private readonly handleError = (): void => {
    this.fail(new EditableArtifactTransportError("editable artifact WebSocket failed"));
  };

  private readonly handleClose = (event: EditableArtifactWebSocketCloseEvent): void => {
    if (this.terminal) return;
    const reason = event.reason ?? "transport_error";
    if (RESYNC_CLOSE_REASONS.has(reason)) {
      this.onMessage({
        type: "resync_required",
        artifactId: this.ticket.artifactId,
        reason,
      });
    }
    this.finish({ reason: this.localClose ? "closed" : closeReason(reason) });
  };

  private readonly handleAbort = (): void => this.close("aborted");

  private handleServerFrame(frame: EditableArtifactLiveServerFrame): void {
    if (this.terminal) return;
    if (this.openFrame === null) {
      if (frame.type !== "open") throw new TypeError("first live server frame must be open");
      this.validateIdentity(frame);
      this.validateNegotiatedLimits(frame);
      this.openFrame = frame;
      this.targetHead = frame.headSequence;
      this.onMessage({
        type: "head",
        artifactId: this.ticket.artifactId,
        headSequence: frame.headSequence,
      });
      this.readyDeferred.resolve();
      return;
    }
    if (frame.type === "open") throw new TypeError("live server sent a second open frame");
    this.validateIdentity(frame);
    switch (frame.type) {
      case "snapshot":
        this.consumeSnapshot(frame);
        return;
      case "transaction": {
        if (frame.transaction.artifactId !== this.ticket.artifactId) {
          throw new TypeError("live transaction belongs to another artifact");
        }
        if (transactionModality(frame.transaction) !== this.ticket.modality) {
          throw new TypeError("live transaction modality mismatch");
        }
        if (
          (frame.transaction.modality === undefined ||
            frame.transaction.modality === "spreadsheet") &&
          frame.transaction.protocolVersion !== this.ticket.protocolVersion
        )
          throw new TypeError("live transaction protocol mismatch");
        if (
          frame.transaction.committedTransactionBytes.byteLength >
          this.limits.maxCommittedTransactionBytes
        ) {
          throw new RangeError("live transaction exceeds negotiated committed byte limit");
        }
        const transaction = cloneCommitted(frame.transaction);
        const existing = this.replayByStart.get(transaction.startSequence);
        if (existing && existing.transactionId !== transaction.transactionId) {
          throw new TypeError("live stream reused a committed sequence");
        }
        this.replayByStart.set(transaction.startSequence, transaction);
        if (this.submissions.has(transaction.requestHash)) {
          this.transactionsById.set(transaction.transactionId, transaction);
        }
        this.targetHead = Math.max(this.targetHead, transaction.endSequence);
        this.firstPostOpen.resolve("transaction");
        if (this.bootstrapDelivered) {
          this.onMessage({
            type: "transaction.committed",
            transaction: cloneCommitted(transaction),
          });
        }
        this.trySettleAccepted(transaction.transactionId);
        this.notifyProgress();
        return;
      }
      case "barrier":
        this.barrierSequence = frame.sequence;
        this.targetHead = Math.max(this.targetHead, frame.sequence);
        this.firstPostOpen.resolve("barrier");
        this.onMessage({
          type: "head",
          artifactId: this.ticket.artifactId,
          headSequence: frame.sequence,
        });
        this.notifyProgress();
        return;
      case "watermark":
        this.targetHead = Math.max(this.targetHead, frame.headSequence);
        this.onMessage({
          type: "head",
          artifactId: this.ticket.artifactId,
          headSequence: frame.headSequence,
        });
        this.notifyProgress();
        return;
      case "resyncRequired":
        this.firstPostOpen.resolve("resync");
        this.onMessage({
          type: "resync_required",
          artifactId: this.ticket.artifactId,
          reason: frame.reason,
        });
        this.notifyProgress();
        return;
      case "authorizationChanged":
        this.onMessage({
          type: "authorization",
          artifactId: this.ticket.artifactId,
          writable: frame.writable,
        });
        return;
      case "mutationAccepted":
        this.acceptMutation(frame);
        return;
      case "mutationRejected":
        this.rejectMutation(frame);
        return;
      case "applied":
        return;
    }
  }

  private consumeSnapshot(
    frame: Extract<EditableArtifactLiveServerFrame, { type: "snapshot" }>,
  ): void {
    this.firstPostOpen.resolve("snapshot");
    if (frame.totalBytes > Math.min(this.limits.maxSnapshotBytes, this.maximumSnapshotBytes)) {
      throw new RangeError("live snapshot exceeds negotiated browser limit");
    }
    if (frame.protocolVersion !== this.ticket.protocolVersion) {
      throw new TypeError("live snapshot protocol mismatch");
    }
    if (serverModality(frame.modality) !== this.ticket.modality) {
      throw new TypeError("live snapshot modality mismatch");
    }
    if (this.snapshotAssembly === null) {
      if (frame.offset !== 0) throw new TypeError("live snapshot does not start at byte zero");
      const { bytes: _bytes, offset: _offset, final: _final, ...metadata } = frame;
      this.snapshotAssembly = {
        metadata,
        bytes: new Uint8Array(frame.totalBytes),
        nextOffset: 0,
      };
    }
    const assembly = this.snapshotAssembly;
    if (
      frame.offset !== assembly.nextOffset ||
      frame.totalBytes !== assembly.metadata.totalBytes ||
      frame.sequence !== assembly.metadata.sequence ||
      frame.stateHash !== assembly.metadata.stateHash ||
      frame.digest !== assembly.metadata.digest ||
      frame.kernelVersion !== assembly.metadata.kernelVersion ||
      frame.modelSchemaVersion !== assembly.metadata.modelSchemaVersion ||
      !snapshotChunkAuthorityEqual(frame, assembly.metadata)
    ) {
      throw new TypeError("live snapshot chunks do not share one identity");
    }
    assembly.bytes.set(frame.bytes, frame.offset);
    assembly.nextOffset += frame.bytes.byteLength;
    if (!frame.final) return;
    if (assembly.nextOffset !== assembly.bytes.byteLength) {
      throw new TypeError("live snapshot is incomplete");
    }
    const commonSnapshot = {
      artifactId: this.ticket.artifactId,
      sequence: frame.sequence,
      stateHash: frame.stateHash,
      digest: frame.digest,
      kernelVersion: frame.kernelVersion,
      modelSchemaVersion: frame.modelSchemaVersion,
      bytes: assembly.bytes,
    } as const;
    const snapshot: EditableArtifactSnapshot =
      "causalFrontier" in frame
        ? Object.freeze({
            ...commonSnapshot,
            modality: "spreadsheet" as const,
            causalFrontier: cloneFrontier(frame.causalFrontier),
            protocolVersion: frame.protocolVersion,
          })
        : Object.freeze({
            ...commonSnapshot,
            modality: requireSerializedModality(frame.modality),
            nativeRevision: frame.nativeRevision,
          });
    this.snapshot = snapshot;
    this.snapshotDeferred.resolve(snapshot);
    this.notifyProgress();
  }

  private acceptMutation(
    frame: Extract<EditableArtifactLiveServerFrame, { type: "mutationAccepted" }>,
  ): void {
    const submission = this.submissions.get(frame.requestHash);
    if (!submission) return;
    if (frame.clientTransactionId !== submission.pending.clientTransactionId) {
      throw new TypeError("mutation acceptance changed the client transaction identity");
    }
    submission.accepted = frame;
    this.trySettleAccepted(frame.transactionId);
  }

  private trySettleAccepted(transactionId: string): void {
    const transaction = this.transactionsById.get(transactionId);
    if (!transaction) return;
    const submission = this.submissions.get(transaction.requestHash);
    if (!submission?.accepted || submission.accepted.transactionId !== transactionId) return;
    const accepted = submission.accepted;
    if (
      accepted.startSequence !== transaction.startSequence ||
      accepted.endSequence !== transaction.endSequence ||
      accepted.stateHash !== transaction.stateHash ||
      accepted.requestHash !== transaction.requestHash
    ) {
      throw new TypeError("mutation acceptance does not match its committed transaction");
    }
    clearTimeout(submission.timeout);
    this.submissions.delete(transaction.requestHash);
    this.transactionsById.delete(transaction.transactionId);
    submission.deferred.resolve({
      artifactId: this.ticket.artifactId,
      clientTransactionId: accepted.clientTransactionId,
      transactionId: transaction.transactionId,
      requestHash: transaction.requestHash,
      committed: cloneCommitted(transaction),
    });
  }

  private rejectMutation(
    frame: Extract<EditableArtifactLiveServerFrame, { type: "mutationRejected" }>,
  ): void {
    const submission = this.submissions.get(frame.requestHash);
    if (!submission) return;
    clearTimeout(submission.timeout);
    this.submissions.delete(frame.requestHash);
    submission.deferred.reject(
      new EditableArtifactTransportError(`editable artifact mutation rejected: ${frame.code}`, {
        code: frame.code,
        retryable: frame.retryable,
        outcomeUnknown: false,
      }),
    );
  }

  private validateIdentity(frame: EditableArtifactLiveServerFrame): void {
    if (frame.artifactId !== this.ticket.artifactId) {
      throw new TypeError("live server frame belongs to another artifact");
    }
    if (frame.protocolVersion !== this.ticket.protocolVersion) {
      throw new TypeError("live server frame protocol mismatch");
    }
    if (frame.type === "open" && serverModality(frame.modality) !== this.ticket.modality) {
      throw new TypeError("live open modality does not match its ticket");
    }
    if (this.openFrame && frame.streamEpoch !== this.openFrame.streamEpoch) {
      throw new TypeError("live server frame belongs to another stream epoch");
    }
  }

  private validateNegotiatedLimits(
    frame: Extract<EditableArtifactLiveServerFrame, { type: "open" }>,
  ): void {
    if (
      frame.maxCommandBytes > EDITABLE_ARTIFACT_COMMAND_MAX_BYTES ||
      frame.maxIntentBytes > EDITABLE_ARTIFACT_INTENT_MAX_BYTES ||
      frame.maxCommittedTransactionBytes > MAX_COMMITTED_TRANSACTION_BYTES
    ) {
      throw new TypeError("live server advertised incompatible protocol limits");
    }
  }

  private requireOpen(): Extract<EditableArtifactLiveServerFrame, { type: "open" }> {
    if (!this.openFrame) throw new TypeError("live stream has not completed its handshake");
    return this.openFrame;
  }

  private throwIfTerminal(): void {
    if (this.terminal) throw this.terminal;
    this.signal.throwIfAborted();
  }

  private waitForProgress(signal: AbortSignal): Promise<void> {
    this.throwIfTerminal();
    const deferred = new Deferred<void>();
    this.progressWaiters.add(deferred);
    return abortable(deferred.promise, signal).finally(() => this.progressWaiters.delete(deferred));
  }

  private notifyProgress(): void {
    for (const waiter of this.progressWaiters) waiter.resolve();
    this.progressWaiters.clear();
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.finish({ reason: "transport_error", error });
    try {
      this.socket.close(4400, "invalid_frame");
    } catch {
      // Terminal state above is authoritative even if the host socket throws.
    }
  }

  private finish(input: { reason: EditableArtifactLiveClose["reason"]; error?: Error }): void {
    if (this.terminal) return;
    clearTimeout(this.handshakeTimer);
    this.terminal =
      input.error ?? new EditableArtifactTransportError("editable artifact live stream closed");
    this.socket.removeEventListener("open", this.handleOpen);
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.removeEventListener("close", this.handleClose);
    this.signal.removeEventListener("abort", this.handleAbort);
    this.readyDeferred.reject(this.terminal);
    this.firstPostOpen.reject(this.terminal);
    this.snapshotDeferred.reject(this.terminal);
    this.notifyProgress();
    for (const submission of this.submissions.values()) {
      clearTimeout(submission.timeout);
      submission.deferred.reject(
        new EditableArtifactTransportError("live stream closed before mutation outcome", {
          code: "transport_error",
          outcomeUnknown: submission.sent,
          cause: input.error,
        }),
      );
    }
    this.submissions.clear();
    this.closedDeferred.resolve({
      reason: input.reason,
      ...(input.error ? { error: input.error } : {}),
    });
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T | PromiseLike<T>) => void;
  private rejectPromise!: (reason?: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    // Several lifecycle barriers are intentionally rejectable before a caller
    // starts awaiting them; mark the rejection observed without changing it.
    void this.promise.catch(() => undefined);
  }

  resolve(
    value: T extends void ? undefined : T = undefined as T extends void ? undefined : T,
  ): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise(value as T);
  }

  reject(reason: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectPromise(reason);
  }
}

function cloneCommitted(
  transaction: EditableArtifactCommittedTransaction | ContractCommittedTransaction,
): EditableArtifactCommittedTransaction {
  if (transaction.modality === undefined || transaction.modality === "spreadsheet") {
    return {
      ...transaction,
      modality: "spreadsheet",
      causalFrontier: cloneFrontier(transaction.causalFrontier),
      committedTransactionBytes: transaction.committedTransactionBytes.slice(),
    };
  }
  if (!("priorNativeRevision" in transaction)) {
    throw new TypeError("serialized transaction lacks native revision metadata");
  }
  return {
    artifactId: transaction.artifactId,
    transactionId: transaction.transactionId,
    requestHash: transaction.requestHash,
    startSequence: transaction.startSequence,
    endSequence: transaction.endSequence,
    priorStateHash: transaction.priorStateHash,
    stateHash: transaction.stateHash,
    modality: requireSerializedModality(transaction.modality),
    priorNativeRevision: transaction.priorNativeRevision,
    nativeRevision: transaction.nativeRevision,
    commitProtocolVersion: transaction.commitProtocolVersion,
    committedTransactionBytes: transaction.committedTransactionBytes.slice(),
  };
}

function transactionModality(
  transaction: EditableArtifactCommittedTransaction | ContractCommittedTransaction,
): EditableArtifactModality {
  return transaction.modality ?? "spreadsheet";
}

function serverModality(value: EditableArtifactModality | undefined): EditableArtifactModality {
  return value ?? "spreadsheet";
}

function serializedBoundaryRevision(
  snapshot: EditableArtifactSnapshot | null,
  resume:
    | { modality: "spreadsheet"; localCausalFrontier: EditableArtifactCausalFrontier }
    | { modality: "document" | "presentation"; localNativeRevision: number | null },
  modality: "document" | "presentation",
): number {
  if (snapshot !== null) {
    if (snapshot.modality !== modality) throw new TypeError("snapshot modality mismatch");
    return snapshot.nativeRevision;
  }
  if (resume.modality !== modality || resume.localNativeRevision === null) {
    throw new EditableArtifactSyncError(
      "invalid_bootstrap",
      "serialized live stream established no native revision boundary",
      { requiresSnapshot: true },
    );
  }
  return resume.localNativeRevision;
}

function snapshotChunkAuthorityEqual(
  frame: Extract<EditableArtifactLiveServerFrame, { type: "snapshot" }>,
  metadata: SnapshotAssembly["metadata"],
): boolean {
  const modality = serverModality(frame.modality);
  if (modality !== serverModality(metadata.modality)) return false;
  if ("causalFrontier" in frame) {
    if (!("causalFrontier" in metadata)) return false;
    return frontiersEqual(frame.causalFrontier, metadata.causalFrontier);
  }
  if (!("nativeRevision" in metadata)) return false;
  return frame.nativeRevision === metadata.nativeRevision;
}

function requireSerializedModality(
  value: EditableArtifactModality | undefined,
): "document" | "presentation" {
  if (value !== "document" && value !== "presentation") {
    throw new TypeError("serialized artifact modality is invalid");
  }
  return value;
}

function cloneFrontier(frontier: EditableArtifactCausalFrontier): EditableArtifactCausalFrontier {
  if (!Array.isArray(frontier) || frontier.length > 1_024) {
    throw new TypeError("causal frontier is invalid");
  }
  let previous = "";
  return frontier.map((entry) => {
    requireReplicaId(entry.replicaId);
    if (!Number.isSafeInteger(entry.counter) || entry.counter <= 0 || entry.replicaId <= previous) {
      throw new TypeError("causal frontier must be positive, sorted, and duplicate-free");
    }
    previous = entry.replicaId;
    return { replicaId: entry.replicaId, counter: entry.counter };
  });
}

function frontiersEqual(
  left: EditableArtifactCausalFrontier,
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

async function binaryMessage(value: unknown, maximumBytes: number): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > maximumBytes)
      throw new RangeError("live server frame exceeds byte limit");
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > maximumBytes)
      throw new RangeError("live server frame exceeds byte limit");
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    if (value.size > maximumBytes) throw new RangeError("live server frame exceeds byte limit");
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError("editable artifact live transport accepts binary frames only");
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      await response.body?.cancel("ticket response exceeds byte limit").catch(() => undefined);
      throw new TypeError("ticket response content-length is invalid");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("ticket response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) throw new RangeError("ticket response exceeds byte limit");
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel("ticket response rejected").catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new TypeError("ticket response is not valid UTF-8 JSON", { cause });
  }
}

function validateTicket(
  value: unknown,
  artifactId: string,
  replicaId: string,
  protocolVersion: number,
): EditableArtifactSyncTicket {
  if (!isPlainRecord(value)) throw new TypeError("ticket response must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["artifactId", "expiresAt", "modality", "protocolVersion", "replicaId", "token"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("ticket response has unknown or missing fields");
  }
  if (
    value.artifactId !== artifactId ||
    value.replicaId !== replicaId ||
    value.protocolVersion !== protocolVersion
  ) {
    throw new TypeError("ticket response identity does not match its request");
  }
  const modality = requireModality(value.modality, "ticket modality");
  if (
    typeof value.token !== "string" ||
    value.token.length > 4_096 ||
    !/^[A-Za-z0-9._~-]+$/u.test(value.token)
  ) {
    throw new TypeError("ticket token is invalid");
  }
  if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new TypeError("ticket expiry is invalid");
  }
  return {
    artifactId,
    modality,
    replicaId,
    token: value.token,
    expiresAt: value.expiresAt,
    protocolVersion,
  };
}

function requireModality(value: unknown, label: string): EditableArtifactModality {
  if (value !== "document" && value !== "spreadsheet" && value !== "presentation") {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function transportBaseUrl(value: string | URL): URL {
  const base = resolveUrl(value, "baseUrl");
  if (base.username || base.password || base.search || base.hash) {
    throw new TypeError("baseUrl must not contain credentials, query, or fragment");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError("baseUrl must use HTTP or HTTPS");
  }
  return base;
}

function socketUrl(value: string | URL | undefined, baseUrl: URL): URL {
  const url =
    value === undefined ? childUrl(baseUrl, LIVE_PATH) : resolveUrl(value, "webSocketUrl");
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("webSocketUrl must not contain credentials, query, or fragment");
  }
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("webSocketUrl must use WS or WSS");
  }
  return url;
}

function childUrl(base: URL, path: string): URL {
  const result = new URL(base.href);
  result.pathname = `${result.pathname.replace(/\/+$/u, "")}${path}`;
  result.search = "";
  result.hash = "";
  return result;
}

function resolveUrl(value: string | URL, label: string): URL {
  if (value instanceof URL) return new URL(value.href);
  try {
    return new URL(value, typeof location === "undefined" ? undefined : location.href);
  } catch (cause) {
    throw new TypeError(`${label} must be an absolute URL outside a browser`, { cause });
  }
}

function requireTransportSecurity(base: URL, socket: URL, allowInsecure: boolean): void {
  if (allowInsecure) return;
  if (base.protocol !== "https:" || socket.protocol !== "wss:") {
    throw new TypeError("editable artifact production transport requires HTTPS and WSS");
  }
}

function defaultWebSocketFactory(url: string, protocol: string): EditableArtifactWebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new TypeError("WebSocket is unavailable; provide webSocketFactory");
  }
  return new WebSocket(url, protocol) as unknown as EditableArtifactWebSocketLike;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function requireStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new TypeError(`${label} must be 32 lowercase nonzero hex characters`);
  }
}

function requireReplicaId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REPLICA_ID.test(value)) {
    throw new TypeError("replicaId must be 16 lowercase nonzero hex characters");
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function safeSequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} is invalid`);
  return value as number;
}

function positiveU16(value: unknown, label: string): number {
  const number = positiveBounded(value, 0xffff, label);
  return number;
}

function positiveBounded(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as number;
}

function boundedCloseReason(value: string): string {
  return value.length <= 100 && /^[\x20-\x7e]*$/u.test(value) ? value : "closed";
}

function closeReason(value: string): EditableArtifactLiveClose["reason"] {
  if (value === "permission_changed") return "permission_changed";
  if (value === "ticket_expired" || value === "ticket_replayed") return "ticket_expired";
  return value === "closed" ? "closed" : "transport_error";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

const RESYNC_CLOSE_REASONS = new Set([
  "retention_gap",
  "durable_gap",
  "invalid_ack",
  "slow_client",
  "oversized_frame",
]);
