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
const REALTIME_DELEGATION_TRANSCRIPT_MAX_BYTES = 65_536;
const REALTIME_DELEGATION_INPUT_MAX_BYTES = 65_536;

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
  ignoredEventCount: number;
  lastIgnoredEventType: string | null;
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
  /** Stop accepting provider events, then durably drain everything already parsed. */
  sealAndFlush(): Promise<void>;
  listen(): void;
  close(): void;
};

type PendingInbound = {
  entry: SessionRealtimeInboundEntry;
  bytes: number;
};

type FinalizedTranscript = {
  role: "user" | "assistant";
  text: string;
  turnId: string;
};

export function createCodexRealtimeV3Bridge(
  options: CodexRealtimeV3BridgeOptions,
): CodexRealtimeV3Bridge {
  let closed = false;
  let sealed = false;
  let listening = false;
  let speaking = false;
  let activeDelegationId: string | null = null;
  let lastError: string | null = null;
  let ignoredEventCount = 0;
  let lastIgnoredEventType: string | null = null;
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
  const finalizedTurnIds = new Set<string>();
  let transcriptSinceDelegation: FinalizedTranscript[] = [];
  let pendingDelegationUserTranscript: { delegationItemId: string; text: string } | null = null;
  const randomUUID = options.randomUUID ?? defaultRandomUUID;

  const snapshot = (): CodexRealtimeV3BridgeSnapshot => ({
    connectionId: options.connectionId,
    connectionEpoch: options.connectionEpoch,
    startupFenceSequence: options.startupFenceSequence,
    modeVersion: options.modeVersion,
    speaking,
    activeDelegationId,
    lastError,
    ignoredEventCount,
    lastIgnoredEventType,
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
    if (closed || sealed || fatal) return false;
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
      }
      for (let index = 0; index < result.outbound.length;) {
        const entry = result.outbound[index]!;
        if (sentSequences.has(entry.sequence)) {
          index += 1;
          continue;
        }
        if (entry.kind === "delegation_progress" && entry.delegationItemId) {
          const progress: SessionRealtimeLedgerEntry[] = [];
          while (index < result.outbound.length) {
            const candidate = result.outbound[index]!;
            if (
              candidate.kind !== "delegation_progress" ||
              candidate.delegationItemId !== entry.delegationItemId
            ) {
              break;
            }
            if (!sentSequences.has(candidate.sequence)) progress.push(candidate);
            index += 1;
          }
          sendDelegationProgress(options.events, entry.delegationItemId, progress);
          for (const candidate of progress) sentSequences.add(candidate.sequence);
          continue;
        }
        sendOutbound(options.events, entry);
        sentSequences.add(entry.sequence);
        if (
          entry.kind === "session_update" &&
          entry.payload.source === "human_input" &&
          entry.payload.delivery === "steer"
        ) {
          // The session continues under the human's new direction. The typed
          // session update above is all the provider needs; this only keeps the
          // local diagnostic from claiming the prior delegation is still live.
          activeDelegationId = null;
        }
        if (
          (entry.kind === "delegation_result" || entry.kind === "error") &&
          entry.delegationItemId === activeDelegationId
        ) {
          activeDelegationId = null;
        }
        index += 1;
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
    if (closed || sealed || fatal) return Promise.resolve();
    const parsed = parseCodexRealtimeV3Event(payload);
    if (!parsed.ok) {
      if (parsed.reason === "unsupported_type") {
        ignoredEventCount += 1;
        lastIgnoredEventType = parsed.eventType;
        publish();
        return Promise.resolve();
      }
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
    } else if (
      event.type === "input_transcript.added" ||
      event.type === "output_transcript.added"
    ) {
      // These events are provider UI deltas. `turn.done` is the single
      // authoritative finalized transcript persisted below.
    } else if (event.type === "delegation.created") {
      activeDelegationId = event.delegationItemId;
      const transcript = delegationTranscript(transcriptSinceDelegation, event.inputTranscript);
      const coveredTurnIds = transcriptSinceDelegation.map((entry) => entry.turnId);
      durable = enqueue({
        operationId: randomUUID(),
        kind: "delegation_call",
        providerEventId: event.providerEventId,
        delegationItemId: event.delegationItemId,
        text: renderRealtimeDelegationInput(event.inputTranscript, transcript),
        payload: {
          offsetMs: event.offsetMs,
          inputTranscript: event.inputTranscript,
          transcriptFenceTurnIds: coveredTurnIds,
        },
      });
      if (durable) {
        const alreadyFinalized = transcriptSinceDelegation.some(
          (entry) =>
            entry.role === "user" &&
            normalizedTranscript(entry.text) === normalizedTranscript(event.inputTranscript),
        );
        pendingDelegationUserTranscript = alreadyFinalized
          ? null
          : { delegationItemId: event.delegationItemId, text: event.inputTranscript };
        transcriptSinceDelegation = [];
      }
    } else if (event.type === "output_audio.delta") {
      speaking = true;
    } else if (event.type === "turn.done") {
      speaking = false;
      if (event.transcript.length > 0 && !finalizedTurnIds.has(event.turnId)) {
        const coveredByDelegationItemId =
          event.role === "user" &&
          pendingDelegationUserTranscript !== null &&
          normalizedTranscript(event.transcript) ===
            normalizedTranscript(pendingDelegationUserTranscript.text)
            ? pendingDelegationUserTranscript.delegationItemId
            : null;
        durable = enqueue(finalTranscript(randomUUID, event, coveredByDelegationItemId));
        if (durable) {
          finalizedTurnIds.add(event.turnId);
          if (coveredByDelegationItemId) {
            pendingDelegationUserTranscript = null;
          } else {
            transcriptSinceDelegation.push({
              role: event.role,
              text: event.transcript,
              turnId: event.turnId,
            });
          }
        }
      }
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
    if (closed || sealed || listening) return;
    listening = true;
    options.events.addEventListener("message", onMessage);
  };
  if (options.listen !== false) listen();
  publish();
  return {
    snapshot,
    ingest,
    flush: () => requestFlush(true),
    sealAndFlush: async () => {
      if (closed) return;
      sealed = true;
      if (listening) options.events.removeEventListener("message", onMessage);
      listening = false;
      await requestFlush(true);
    },
    listen,
    close: () => {
      if (closed) return;
      closed = true;
      if (listening) options.events.removeEventListener("message", onMessage);
      listening = false;
    },
  };
}

function finalTranscript(
  randomUUID: () => string,
  event: Extract<CodexRealtimeV3Event, { type: "turn.done" }>,
  coveredByDelegationItemId: string | null,
): SessionRealtimeInboundEntry {
  return {
    operationId: randomUUID(),
    kind: event.role === "user" ? "user_transcript" : "assistant_transcript",
    providerEventId: event.providerEventId,
    text: event.transcript,
    payload: {
      turnId: event.turnId,
      ...(coveredByDelegationItemId ? { coveredByDelegationItemId } : {}),
    },
  };
}

function delegationTranscript(
  entries: readonly FinalizedTranscript[],
  inputTranscript: string,
): FinalizedTranscript[] {
  const selected = [...entries];
  const last = selected.at(-1);
  if (
    inputTranscript.length > 0 &&
    !(
      last?.role === "user" &&
      normalizedTranscript(last.text) === normalizedTranscript(inputTranscript)
    )
  ) {
    selected.push({ role: "user", text: inputTranscript, turnId: "provider-delegation-input" });
  }
  const bounded: FinalizedTranscript[] = [];
  let bytes = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const entry = selected[index]!;
    const line = `${entry.role}: ${entry.text}`;
    const lineBytes = utf8ByteLength(line) + (bounded.length > 0 ? 1 : 0);
    if (bytes + lineBytes > REALTIME_DELEGATION_TRANSCRIPT_MAX_BYTES) break;
    bounded.unshift(entry);
    bytes += lineBytes;
  }
  return bounded;
}

function renderRealtimeDelegationInput(
  inputTranscript: string,
  transcript: readonly FinalizedTranscript[],
): string {
  const input = takeUtf8Head(inputTranscript, REALTIME_DELEGATION_INPUT_MAX_BYTES);
  const transcriptDelta = transcript.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
  return [
    "<realtime_delegation>",
    `  <input>${escapeXmlText(input)}</input>`,
    ...(transcriptDelta
      ? [`  <transcript_delta>${escapeXmlText(transcriptDelta)}</transcript_delta>`]
      : []),
    "</realtime_delegation>",
  ].join("\n");
}

function normalizedTranscript(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function takeUtf8Head(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sendOutbound(events: RTCDataChannel, entry: SessionRealtimeLedgerEntry): void {
  if (events.readyState !== "open") throw new Error("Codex realtime data channel is not open");
  const text = entry.text ?? JSON.stringify(entry.payload);
  const payloadChannel =
    entry.payload.channel === "speakable" || entry.payload.channel === "commentary"
      ? entry.payload.channel
      : entry.payload.channel === null
        ? undefined
        : entry.kind === "session_update"
          ? "commentary"
          : undefined;
  const messages =
    (entry.kind === "delegation_result" || entry.kind === "error") && entry.delegationItemId
      ? encodeCodexRealtimeV3DelegationContextAppend({
          delegationItemId: entry.delegationItemId,
          text,
          channel: payloadChannel ?? "speakable",
        })
      : encodeCodexRealtimeV3SessionContextAppend({ text, channel: payloadChannel });
  for (const message of messages) events.send(JSON.stringify(message));
}

function sendDelegationProgress(
  events: RTCDataChannel,
  delegationItemId: string,
  entries: SessionRealtimeLedgerEntry[],
): void {
  if (entries.length === 0) return;
  if (events.readyState !== "open") throw new Error("Codex realtime data channel is not open");
  const text = entries.map((entry) => entry.text ?? "").join("");
  if (text.length === 0) return;
  for (const message of encodeCodexRealtimeV3DelegationContextAppend({
    delegationItemId,
    text,
    channel: "commentary",
  })) {
    events.send(JSON.stringify(message));
  }
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
