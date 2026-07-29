import {
  encodeCodexRealtimeV3DelegationContextAppend,
  encodeCodexRealtimeV3SessionContextAppend,
  parseCodexRealtimeV3Event,
} from "./codex-realtime-v3-wire";
import type { CodexRealtimeV3Event } from "./codex-realtime-v3-wire";
import type {
  SessionRealtimeInboundEntry,
  SessionRealtimeLedgerEntry,
  SyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse,
} from "./types";

export {
  CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES,
  CODEX_REALTIME_V3_MAX_EVENT_BYTES,
  CODEX_REALTIME_V3_MAX_IDENTIFIER_BYTES,
  CODEX_REALTIME_V3_MAX_TEXT_BYTES,
  contextAppendChunks,
  encodeCodexRealtimeV3DelegationContextAppend,
  encodeCodexRealtimeV3SessionContextAppend,
  parseCodexRealtimeV3Event,
} from "./codex-realtime-v3-wire";
export type {
  CodexRealtimeV3ContextAppendChannel,
  CodexRealtimeV3DelegationContextAppend,
  CodexRealtimeV3Event,
  CodexRealtimeV3ParseFailure,
  CodexRealtimeV3ParseResult,
  CodexRealtimeV3SessionContextAppend,
} from "./codex-realtime-v3-wire";

export const CODEX_REALTIME_V3_SYNC_MAX_ENTRIES = 64;
export const CODEX_REALTIME_V3_PENDING_MAX_ENTRIES = 256;
export const CODEX_REALTIME_V3_PENDING_MAX_BYTES = 16 * 1024 * 1024;

export type CodexRealtimeV3BridgeFatal = {
  code: "pending_overflow";
  message: string;
};

export type CodexRealtimeV3BridgeSnapshot = {
  connectionId: string;
  connectionEpoch: number;
  startupFenceSequence: number;
  modeVersion: number;
  speaking: boolean;
  activeDelegationId: string | null;
  lastError: string | null;
  pendingInbound: number;
  pendingInboundBytes: number;
  clientAckThroughSequence: number | null;
  /** Pinned V3 exposes no provider receipt, so this list is always empty. */
  providerAckSequences: number[];
  providerStarted: boolean;
  fatal: CodexRealtimeV3BridgeFatal | null;
};

export type CodexRealtimeV3BridgeOptions = {
  events: RTCDataChannel;
  connectionId: string;
  connectionEpoch: number;
  startupFenceSequence: number;
  modeVersion: number;
  owner: Pick<
    SyncSessionRealtimeLedgerRequest,
    "browserInstanceId" | "ownerKey" | "expectedVersion"
  >;
  sync(request: SyncSessionRealtimeLedgerRequest): Promise<SyncSessionRealtimeLedgerResponse>;
  randomUUID?: (() => string) | undefined;
  /** The controller installs its activation FIFO first, then enables this listener synchronously. */
  listen?: boolean | undefined;
  onSnapshot?: ((snapshot: CodexRealtimeV3BridgeSnapshot) => void) | undefined;
  onFatal?: ((fatal: CodexRealtimeV3BridgeFatal) => void) | undefined;
};

export type CodexRealtimeV3Bridge = {
  snapshot(): CodexRealtimeV3BridgeSnapshot;
  ingest(payload: string): Promise<void>;
  flush(): Promise<void>;
  listen(): void;
  close(): void;
};

type PendingInbound = {
  entry: SessionRealtimeInboundEntry;
  bytes: number;
};

export function createCodexRealtimeV3Bridge(
  options: CodexRealtimeV3BridgeOptions,
): CodexRealtimeV3Bridge {
  let closed = false;
  let listening = false;
  let speaking = false;
  let activeDelegationId: string | null = null;
  let lastError: string | null = null;
  let fatal: CodexRealtimeV3BridgeFatal | null = null;
  let providerStarted:
    | { providerSessionId: string; providerEventId?: string | null | undefined }
    | undefined;
  let providerStartedAccepted = false;
  let clientAckThroughSequence: number | null = null;
  let pendingInbound: PendingInbound[] = [];
  let pendingInboundCount = 0;
  let pendingInboundBytes = 0;
  let flushing: Promise<void> | null = null;
  let flushRequestedWhileRunning = false;
  let forceSync = false;
  const clientReceivedSequences = new Set<number>();
  const sentSequences = new Set<number>();
  const randomUUID = options.randomUUID ?? defaultRandomUUID;

  const snapshot = (): CodexRealtimeV3BridgeSnapshot => ({
    connectionId: options.connectionId,
    connectionEpoch: options.connectionEpoch,
    startupFenceSequence: options.startupFenceSequence,
    modeVersion: options.modeVersion,
    speaking,
    activeDelegationId,
    lastError,
    pendingInbound: pendingInboundCount,
    pendingInboundBytes,
    clientAckThroughSequence,
    providerAckSequences: [],
    providerStarted: providerStartedAccepted,
    fatal,
  });
  const publish = (): void => options.onSnapshot?.(snapshot());

  const triggerFatal = (message: string): void => {
    if (closed || fatal) return;
    fatal = { code: "pending_overflow", message };
    lastError = message;
    publish();
    try {
      options.onFatal?.({ ...fatal });
    } catch {
      // A consumer callback cannot turn a controlled bridge failure into an
      // unhandled provider-message exception.
    }
  };

  const enqueue = (entry: SessionRealtimeInboundEntry): boolean => {
    if (closed || fatal) return false;
    const bytes = utf8ByteLength(JSON.stringify(entry));
    if (
      pendingInboundCount + 1 > CODEX_REALTIME_V3_PENDING_MAX_ENTRIES ||
      pendingInboundBytes + bytes > CODEX_REALTIME_V3_PENDING_MAX_BYTES
    ) {
      triggerFatal("Codex realtime durable event buffer exceeded its hard limit");
      return false;
    }
    pendingInbound.push({ entry, bytes });
    pendingInboundCount += 1;
    pendingInboundBytes += bytes;
    return true;
  };

  const hasWork = (): boolean =>
    pendingInbound.length > 0 ||
    (!providerStartedAccepted && providerStarted !== undefined) ||
    clientAckThroughSequence !== null ||
    forceSync;

  const runFlush = async (): Promise<void> => {
    while (true) {
      if (closed || fatal) break;
      const batch = pendingInbound.splice(0, CODEX_REALTIME_V3_SYNC_MAX_ENTRIES);
      const startup = providerStartedAccepted ? undefined : providerStarted;
      const acknowledgedByClient = clientAckThroughSequence;
      const poll = forceSync;
      forceSync = false;
      flushRequestedWhileRunning = false;
      if (batch.length === 0 && !startup && acknowledgedByClient === null && !poll) break;

      let result: SyncSessionRealtimeLedgerResponse;
      try {
        result = await options.sync({
          ...options.owner,
          connectionId: options.connectionId,
          connectionEpoch: options.connectionEpoch,
          ...(batch.length === 0 ? {} : { entries: batch.map(({ entry }) => entry) }),
          ...(startup ? { providerStarted: startup } : {}),
          ...(acknowledgedByClient === null
            ? {}
            : { clientAckThroughSequence: acknowledgedByClient }),
        });
      } catch (error) {
        // Entries that were in flight retain their accounting and return ahead
        // of every arrival accepted while the request was pending.
        pendingInbound = [...batch, ...pendingInbound];
        throw error;
      }

      for (const item of batch) {
        pendingInboundCount -= 1;
        pendingInboundBytes -= item.bytes;
      }
      if (startup && providerStarted === startup) providerStartedAccepted = true;
      if (
        acknowledgedByClient !== null &&
        clientAckThroughSequence !== null &&
        clientAckThroughSequence <= acknowledgedByClient
      ) {
        clientAckThroughSequence = null;
      }
      if (closed || fatal) break;

      for (const entry of result.outbound) {
        // This is OpenGeni's durable browser-delivery acknowledgment. The
        // provider send below remains at-least-once because pinned V3 exposes
        // no provider receipt and providerAckSequences is never populated.
        if (entry.clientAckedAt === null && !clientReceivedSequences.has(entry.sequence)) {
          clientReceivedSequences.add(entry.sequence);
          clientAckThroughSequence = Math.max(clientAckThroughSequence ?? 0, entry.sequence);
        }
        if (sentSequences.has(entry.sequence)) continue;
        sendOutbound(options.events, entry);
        sentSequences.add(entry.sequence);
      }
      publish();
    }
  };

  const requestFlush = (poll: boolean): Promise<void> => {
    if (closed || fatal) return Promise.resolve();
    if (poll) forceSync = true;
    if (flushing) {
      flushRequestedWhileRunning = true;
      return flushing;
    }
    const task = Promise.resolve()
      .then(runFlush)
      .catch((error: unknown) => {
        lastError = safeError(error);
        publish();
        throw error;
      });
    flushing = task;
    void task.then(
      () => {
        if (flushing !== task) return;
        flushing = null;
        if (!closed && !fatal && (flushRequestedWhileRunning || hasWork())) {
          flushRequestedWhileRunning = false;
          void requestFlush(false).catch(() => undefined);
        }
      },
      () => {
        if (flushing === task) flushing = null;
      },
    );
    return task;
  };

  const ingest = (payload: string): Promise<void> => {
    if (closed || fatal) return Promise.resolve();
    const parsed = parseCodexRealtimeV3Event(payload);
    if (!parsed.ok) {
      lastError = `Rejected Codex realtime V3 event: ${parsed.reason}`;
      publish();
      return Promise.resolve();
    }
    const event = parsed.event;
    let durable = false;
    if (event.type === "session.started") {
      if (!providerStartedAccepted && providerStarted === undefined) {
        providerStarted = {
          providerSessionId: event.sessionId,
          providerEventId: event.providerEventId,
        };
        durable = true;
      }
    } else if (event.type === "input_transcript.added") {
      durable = enqueue(inbound(randomUUID, "user_transcript", event));
    } else if (event.type === "output_transcript.added") {
      durable = enqueue(inbound(randomUUID, "assistant_transcript", event));
    } else if (event.type === "delegation.created") {
      activeDelegationId = event.delegationItemId;
      durable = enqueue({
        operationId: randomUUID(),
        kind: "delegation_call",
        providerEventId: event.providerEventId,
        delegationItemId: event.delegationItemId,
        text: event.inputTranscript,
        payload: { offsetMs: event.offsetMs },
      });
    } else if (event.type === "output_audio.delta") {
      speaking = true;
    } else if (event.type === "turn.done") {
      speaking = false;
    } else if (event.type === "error") {
      lastError = event.message;
      durable = enqueue({
        operationId: randomUUID(),
        kind: "error",
        providerEventId: event.providerEventId,
        text: event.message,
      });
    }
    publish();
    return durable ? requestFlush(false) : Promise.resolve();
  };

  const onMessage = (message: MessageEvent): void => {
    if (typeof message.data !== "string") return;
    void ingest(message.data).catch(() => undefined);
  };
  const listen = (): void => {
    if (closed || listening) return;
    listening = true;
    options.events.addEventListener("message", onMessage);
  };
  if (options.listen !== false) listen();
  publish();
  return {
    snapshot,
    ingest,
    flush: () => requestFlush(true),
    listen,
    close: () => {
      if (closed) return;
      closed = true;
      if (listening) options.events.removeEventListener("message", onMessage);
      listening = false;
    },
  };
}

function inbound(
  randomUUID: () => string,
  kind: "user_transcript" | "assistant_transcript",
  event: Extract<
    CodexRealtimeV3Event,
    { type: "input_transcript.added" | "output_transcript.added" }
  >,
): SessionRealtimeInboundEntry {
  return {
    operationId: randomUUID(),
    kind,
    providerEventId: event.providerEventId,
    text: event.text,
  };
}

function sendOutbound(events: RTCDataChannel, entry: SessionRealtimeLedgerEntry): void {
  if (events.readyState !== "open") throw new Error("Codex realtime data channel is not open");
  const text = entry.text ?? JSON.stringify(entry.payload);
  const messages =
    (entry.kind === "delegation_result" || entry.kind === "error") && entry.delegationItemId
      ? encodeCodexRealtimeV3DelegationContextAppend({
          delegationItemId: entry.delegationItemId,
          text,
          channel: "speakable",
        })
      : encodeCodexRealtimeV3SessionContextAppend({ text, channel: "commentary" });
  for (const message of messages) events.send(JSON.stringify(message));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function defaultRandomUUID(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("crypto.randomUUID is unavailable");
  return globalThis.crypto.randomUUID();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Codex realtime bridge failed";
}
