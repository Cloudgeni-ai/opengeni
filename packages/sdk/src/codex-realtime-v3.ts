import {
  encodeCodexRealtimeV3DelegationContextAppend,
  encodeCodexRealtimeV3SessionContextAppend,
  parseCodexRealtimeV3Event,
} from "@opengeni/codex/realtime-v3";
import type {
  CodexRealtimeV3ContextAppendChannel,
  CodexRealtimeV3DelegationContextAppend,
  CodexRealtimeV3Event,
  CodexRealtimeV3ParseFailure,
  CodexRealtimeV3ParseResult,
  CodexRealtimeV3SessionContextAppend,
} from "@opengeni/codex/realtime-v3";
import type {
  SessionRealtimeInboundEntry,
  SessionRealtimeLedgerEntry,
  SyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse,
} from "./types";

export {
  CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES,
  contextAppendChunks,
  encodeCodexRealtimeV3DelegationContextAppend,
  encodeCodexRealtimeV3SessionContextAppend,
  parseCodexRealtimeV3Event,
} from "@opengeni/codex/realtime-v3";
export type {
  CodexRealtimeV3ContextAppendChannel,
  CodexRealtimeV3DelegationContextAppend,
  CodexRealtimeV3Event,
  CodexRealtimeV3ParseFailure,
  CodexRealtimeV3ParseResult,
  CodexRealtimeV3SessionContextAppend,
} from "@opengeni/codex/realtime-v3";

export type CodexRealtimeV3BridgeSnapshot = {
  connectionId: string;
  connectionEpoch: number;
  startupFenceSequence: number;
  modeVersion: number;
  speaking: boolean;
  activeDelegationId: string | null;
  lastError: string | null;
  pendingInbound: number;
  clientAckThroughSequence: number | null;
  providerStarted: boolean;
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
  onSnapshot?: ((snapshot: CodexRealtimeV3BridgeSnapshot) => void) | undefined;
};

export type CodexRealtimeV3Bridge = {
  snapshot(): CodexRealtimeV3BridgeSnapshot;
  ingest(payload: string): Promise<void>;
  flush(): Promise<void>;
  close(): void;
};

export function createCodexRealtimeV3Bridge(
  options: CodexRealtimeV3BridgeOptions,
): CodexRealtimeV3Bridge {
  let closed = false;
  let speaking = false;
  let activeDelegationId: string | null = null;
  let lastError: string | null = null;
  let providerStarted:
    | { providerSessionId: string; providerEventId?: string | null | undefined }
    | undefined;
  let providerStartedAccepted = false;
  let clientAckThroughSequence: number | null = null;
  let pendingInbound: SessionRealtimeInboundEntry[] = [];
  let flushing: Promise<void> | null = null;
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
    pendingInbound: pendingInbound.length,
    clientAckThroughSequence,
    providerStarted: providerStartedAccepted,
  });
  const publish = (): void => options.onSnapshot?.(snapshot());

  const flush = async (): Promise<void> => {
    if (closed) return;
    if (flushing) return await flushing;
    flushing = (async () => {
      do {
        const entries = pendingInbound;
        pendingInbound = [];
        const startup = providerStartedAccepted ? undefined : providerStarted;
        const acknowledged = clientAckThroughSequence;
        clientAckThroughSequence = null;
        const result = await options.sync({
          ...options.owner,
          connectionId: options.connectionId,
          connectionEpoch: options.connectionEpoch,
          ...(entries.length === 0 ? {} : { entries }),
          ...(startup ? { providerStarted: startup } : {}),
          ...(acknowledged === null ? {} : { clientAckThroughSequence: acknowledged }),
        });
        if (startup) providerStartedAccepted = true;
        let highestSent: number | null = null;
        for (const entry of result.outbound) {
          if (sentSequences.has(entry.sequence)) continue;
          sendOutbound(options.events, entry);
          sentSequences.add(entry.sequence);
          highestSent = Math.max(highestSent ?? 0, entry.sequence);
        }
        if (highestSent !== null) clientAckThroughSequence = highestSent;
        publish();
      } while (
        !closed &&
        (pendingInbound.length > 0 ||
          (!providerStartedAccepted && providerStarted !== undefined) ||
          clientAckThroughSequence !== null)
      );
    })();
    try {
      await flushing;
    } catch (error) {
      lastError = safeError(error);
      publish();
      throw error;
    } finally {
      flushing = null;
    }
  };

  const ingest = async (payload: string): Promise<void> => {
    if (closed) return;
    const parsed = parseCodexRealtimeV3Event(payload);
    if (!parsed.ok) {
      lastError = `Rejected Codex realtime V3 event: ${parsed.reason}`;
      publish();
      return;
    }
    const event = parsed.event;
    if (event.type === "session.started") {
      providerStarted = {
        providerSessionId: event.sessionId,
        providerEventId: event.providerEventId,
      };
    } else if (event.type === "input_transcript.added") {
      pendingInbound.push(inbound(randomUUID, "user_transcript", event));
    } else if (event.type === "output_transcript.added") {
      pendingInbound.push(inbound(randomUUID, "assistant_transcript", event));
    } else if (event.type === "delegation.created") {
      activeDelegationId = event.delegationItemId;
      pendingInbound.push({
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
      pendingInbound.push({
        operationId: randomUUID(),
        kind: "error",
        providerEventId: event.providerEventId,
        text: event.message,
      });
    }
    publish();
    await flush();
  };

  const onMessage = (message: MessageEvent): void => {
    if (typeof message.data !== "string") return;
    void ingest(message.data).catch(() => undefined);
  };
  options.events.addEventListener("message", onMessage);
  publish();
  return {
    snapshot,
    ingest,
    flush,
    close: () => {
      if (closed) return;
      closed = true;
      options.events.removeEventListener("message", onMessage);
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
    entry.kind === "delegation_result" && entry.delegationItemId
      ? encodeCodexRealtimeV3DelegationContextAppend({
          delegationItemId: entry.delegationItemId,
          text,
          channel: "speakable",
        })
      : encodeCodexRealtimeV3SessionContextAppend({ text, channel: "commentary" });
  for (const message of messages) events.send(JSON.stringify(message));
}

function defaultRandomUUID(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("crypto.randomUUID is unavailable");
  return globalThis.crypto.randomUUID();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Codex realtime bridge failed";
}
