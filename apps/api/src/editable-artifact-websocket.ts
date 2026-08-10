import {
  EditableArtifactDomainError,
  EditableArtifactLiveError,
  decodeEditableArtifactLiveClientWireFrame,
  encodeEditableArtifactLiveServerWireFrame,
  type EditableArtifactApplicationPort,
  type EditableArtifactLiveClose,
  type EditableArtifactLiveServerFrame,
  type EditableArtifactLiveSession,
  type EditableArtifactLiveSinkPort,
} from "@opengeni/core";

export const EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PATH = "/v1/editable-artifacts/live";
export const EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PROTOCOL = "opengeni-artifact-v1";
export const EDITABLE_ARTIFACT_LIVE_WEBSOCKET_MAX_MESSAGE_BYTES = 8 * 1024 * 1024 + 64 * 1024;

const MAX_QUEUED_MESSAGES = 64;
const MAX_QUEUED_BYTES = 12 * 1024 * 1024;

export type EditableArtifactWebSocketLike = Readonly<{
  data: EditableArtifactWebSocketConnection;
  send(data: Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
  getBufferedAmount?(): number;
}>;

export type EditableArtifactWebSocketUpgradeServer = Readonly<{
  upgrade(
    request: Request,
    options: Readonly<{
      data: EditableArtifactWebSocketConnection;
      headers: HeadersInit;
    }>,
  ): boolean;
}>;

export type EditableArtifactWebSocketHandler = Readonly<{
  open(socket: EditableArtifactWebSocketLike): void;
  message(socket: EditableArtifactWebSocketLike, message: string | Uint8Array | ArrayBuffer): void;
  close(socket: EditableArtifactWebSocketLike): void;
}>;

export class EditableArtifactWebSocketTransport {
  readonly websocket: EditableArtifactWebSocketHandler;

  constructor(private readonly application: EditableArtifactApplicationPort | undefined) {
    this.websocket = Object.freeze({
      open: (socket) => socket.data.attach(socket),
      message: (socket, message) => socket.data.receive(message),
      close: (socket) => socket.data.transportClosed(),
    });
  }

  handles(request: Request): boolean {
    return new URL(request.url).pathname === EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PATH;
  }

  upgrade(request: Request, server: EditableArtifactWebSocketUpgradeServer): Response | undefined {
    const url = new URL(request.url);
    if (url.pathname !== EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PATH) return undefined;
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET" },
      });
    }
    if (!this.application) return new Response("Service Unavailable", { status: 503 });
    if (!offeredProtocol(request.headers.get("sec-websocket-protocol"))) {
      return new Response("WebSocket protocol required", { status: 426 });
    }
    const connection = new EditableArtifactWebSocketConnection(this.application);
    const upgraded = server.upgrade(request, {
      data: connection,
      headers: {
        "sec-websocket-protocol": EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PROTOCOL,
      },
    });
    return upgraded ? undefined : new Response("Bad Request", { status: 400 });
  }
}

/** One socket, one consumed ticket, one stream epoch. */
export class EditableArtifactWebSocketConnection implements EditableArtifactLiveSinkPort {
  private socket: EditableArtifactWebSocketLike | null = null;
  private session: EditableArtifactLiveSession | null = null;
  private work: Promise<void> = Promise.resolve();
  private queuedMessages = 0;
  private queuedBytes = 0;
  private terminal = false;

  constructor(private readonly application: EditableArtifactApplicationPort) {}

  attach(socket: EditableArtifactWebSocketLike): void {
    if (this.socket || this.terminal) {
      socket.close(4400, "invalid connection state");
      return;
    }
    this.socket = socket;
  }

  receive(message: string | Uint8Array | ArrayBuffer): void {
    if (this.terminal) return;
    if (typeof message === "string") {
      void this.fail("invalid_frame");
      return;
    }
    const byteLength = message.byteLength;
    if (
      byteLength === 0 ||
      byteLength > EDITABLE_ARTIFACT_LIVE_WEBSOCKET_MAX_MESSAGE_BYTES ||
      this.queuedMessages + 1 > MAX_QUEUED_MESSAGES ||
      this.queuedBytes + byteLength > MAX_QUEUED_BYTES
    ) {
      void this.fail(
        byteLength > EDITABLE_ARTIFACT_LIVE_WEBSOCKET_MAX_MESSAGE_BYTES
          ? "oversized_frame"
          : "slow_client",
      );
      return;
    }
    const bytes =
      message instanceof Uint8Array ? Uint8Array.from(message) : new Uint8Array(message).slice();
    this.queuedMessages += 1;
    this.queuedBytes += bytes.byteLength;
    const run = this.work.then(async () => {
      try {
        await this.process(bytes);
      } finally {
        this.queuedMessages -= 1;
        this.queuedBytes -= bytes.byteLength;
      }
    });
    this.work = run.catch(async (error: unknown) => {
      await this.handleFailure(error);
    });
  }

  async send(frame: EditableArtifactLiveServerFrame): Promise<void> {
    if (this.terminal || !this.socket) {
      throw new EditableArtifactLiveError("closed", "Editable artifact socket is closed");
    }
    const bytes = encodeEditableArtifactLiveServerWireFrame(frame);
    if (bytes.byteLength > EDITABLE_ARTIFACT_LIVE_WEBSOCKET_MAX_MESSAGE_BYTES) {
      throw new EditableArtifactLiveError(
        "oversized_frame",
        "Editable artifact server frame exceeds socket limit",
        { requiresSnapshot: true },
      );
    }
    const accepted = this.socket.send(bytes, false);
    if (!Number.isSafeInteger(accepted) || accepted <= 0) {
      throw new EditableArtifactLiveError("closed", "Editable artifact socket rejected frame");
    }
  }

  bufferedBytes(): number {
    const buffered = this.socket?.getBufferedAmount?.() ?? this.socket?.bufferedAmount ?? 0;
    return Number.isSafeInteger(buffered) && buffered >= 0 ? buffered : Number.MAX_SAFE_INTEGER;
  }

  close(close: EditableArtifactLiveClose): void {
    if (this.terminal) return;
    this.terminal = true;
    this.socket?.close(closeCode(close.reason), close.reason);
  }

  transportClosed(): void {
    if (this.terminal) return;
    this.terminal = true;
    void this.session?.close("transport_error");
  }

  private async process(bytes: Uint8Array): Promise<void> {
    if (this.terminal) return;
    const frame = decodeEditableArtifactLiveClientWireFrame(bytes);
    if (!this.session) {
      if (frame.type !== "open") {
        throw new EditableArtifactLiveError("invalid_frame", "First socket frame must be open");
      }
      const session = await this.application.openLive({
        token: frame.token,
        artifactId: frame.artifactId,
        protocolVersion: frame.protocolVersion,
        resume: frame.resume,
        sink: this,
      });
      if (this.terminal) {
        await session.close("transport_error");
        return;
      }
      this.session = session;
      void session.closed.then(() => {
        if (!this.terminal)
          this.close({
            reason: "closed",
            retryable: false,
            requiresSnapshot: false,
          });
      });
      return;
    }
    if (frame.type === "open") {
      throw new EditableArtifactLiveError("invalid_frame", "Socket is already open");
    }
    if (
      frame.artifactId !== this.session.artifactId ||
      frame.streamEpoch !== this.session.streamEpoch
    ) {
      throw new EditableArtifactLiveError("stale_epoch", "Socket frame belongs to another stream");
    }
    if (frame.type === "applied") {
      await this.session.acknowledge(frame);
      return;
    }
    let receipt: Awaited<ReturnType<EditableArtifactLiveSession["submitIntent"]>>;
    try {
      receipt = await this.session.submitIntent(frame);
    } catch (error) {
      await this.send({
        type: "mutationRejected",
        protocolVersion: frame.protocolVersion,
        artifactId: frame.artifactId,
        streamEpoch: frame.streamEpoch,
        requestHash: frame.requestHash,
        ...mutationFailure(error),
      });
      return;
    }
    // Always return the exact durable canonical transaction evidence (OGACO
    // or OGAST) on this request's socket, including idempotent unknown-outcome
    // retries whose original fanout was already replayed and ACKed. Transaction
    // first, mapping second: acceptance is never exposed without settle bytes.
    await this.send({
      type: "transaction",
      protocolVersion: frame.protocolVersion,
      artifactId: frame.artifactId,
      streamEpoch: frame.streamEpoch,
      transaction: receipt.transaction,
    });
    await this.send({
      type: "mutationAccepted",
      protocolVersion: frame.protocolVersion,
      artifactId: frame.artifactId,
      streamEpoch: frame.streamEpoch,
      requestHash: receipt.requestHash,
      clientTransactionId: receipt.clientTransactionId,
      transactionId: receipt.transaction.transactionId,
      startSequence: receipt.transaction.startSequence,
      endSequence: receipt.transaction.endSequence,
      stateHash: receipt.transaction.stateHash,
    });
  }

  private async handleFailure(error: unknown): Promise<void> {
    if (this.terminal) return;
    if (error instanceof EditableArtifactLiveError) {
      await this.fail(error.code === "invalid_ticket" ? "transport_error" : error.code);
      return;
    }
    await this.fail("transport_error");
  }

  private async fail(reason: Parameters<EditableArtifactLiveSession["close"]>[0]): Promise<void> {
    if (this.terminal) return;
    this.terminal = true;
    await this.session?.close(reason).catch(() => undefined);
    this.socket?.close(closeCode(reason ?? "transport_error"), reason ?? "transport_error");
  }
}

function mutationFailure(error: unknown): Readonly<{
  code: "invalid_request" | "forbidden" | "conflict" | "unsupported" | "unavailable";
  retryable: boolean;
}> {
  if (error instanceof EditableArtifactDomainError) {
    if (error.code === "forbidden") return { code: "forbidden", retryable: false };
    if (["invalid_request", "request_hash_mismatch", "invalid_undo_target"].includes(error.code)) {
      return { code: "invalid_request", retryable: false };
    }
    if (error.code === "kernel_contract_violation") {
      return { code: "unsupported", retryable: false };
    }
    if (["retryable_conflict", "outbox_lease_conflict"].includes(error.code)) {
      return { code: "conflict", retryable: true };
    }
    return { code: "conflict", retryable: false };
  }
  if (error instanceof EditableArtifactLiveError && error.code === "permission_changed") {
    return { code: "forbidden", retryable: false };
  }
  return { code: "unavailable", retryable: true };
}

function offeredProtocol(value: string | null): boolean {
  return (
    value
      ?.split(",")
      .map((part) => part.trim())
      .includes(EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PROTOCOL) ?? false
  );
}

function closeCode(reason: string): number {
  if (reason === "permission_changed") return 4403;
  if (reason === "ticket_expired" || reason === "ticket_replayed") return 4401;
  if (reason === "protocol_mismatch") return 4406;
  if (reason === "slow_client" || reason === "oversized_frame") return 4409;
  if (reason === "closed") return 1000;
  return 4400;
}
