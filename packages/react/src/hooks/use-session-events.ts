import type { SessionEvent, SessionStatus, StreamConnectionState } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../provider";
import { buildTimeline, groupTimeline, sessionStatusFromEvents } from "../timeline/projection";
import type { TimelineItem } from "../timeline/types";
import type { EmbeddedSessionClientLike } from "../client";

export type SessionEventsConnectionState = StreamConnectionState | "idle" | "ended" | "error";

export type UseSessionEventsOptions = EmbeddedSessionClientOverride & {
  /** Resume after this sequence (exclusive). Nonzero keeps full replay/resume semantics. */
  after?: number | undefined;
  /** Load a bounded tail by default, or opt back into full replay from `after`. */
  replay?: "windowed" | "full" | undefined;
  /** Pause the stream without unmounting (e.g. hidden tab). Defaults to true. */
  enabled?: boolean | undefined;
};

export type UseSessionEventsResult = {
  /** Replayed + live events, ordered by sequence, no gaps, no duplicates. */
  events: SessionEvent[];
  /** Projected, renderable timeline (memoized over `events`). */
  timeline: TimelineItem[];
  /** Latest session status observed in the event log, if any. */
  sessionStatus: SessionStatus | null;
  connectionState: SessionEventsConnectionState;
  /** Highest sequence seen so far (0 before the first event). */
  lastSequence: number;
  /** Exact serialized bytes retained in the current browser event window. */
  windowBytes: number;
  /** Whether older delivered events were evicted from the browser window. */
  windowTruncated: boolean;
  /** True until the initial tail window has been applied (windowed mode). */
  initialLoading: boolean;
  /** Whether older durable events are available before the current window. */
  hasOlder: boolean;
  /** True while an older window is being fetched. */
  loadingOlder: boolean;
  /** Prepend an older density-bounded window; resolves true when more remain. */
  loadOlder: () => Promise<boolean>;
  error: Error | null;
};

const INITIAL_TAIL_PAGE_SIZE = 1000;
const OLDER_PAGE_SIZE = 5000;
const INITIAL_FETCH_CAP = 1;
const OLDER_GROUP_TARGET = 32;
const OLDER_FETCH_CAP = 2;
const BOUNDARY_PAGE_CAP = 4;
const EMPTY_EVENTS: SessionEvent[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BROWSER_EVENT_TYPE_MAX_BYTES = 256;
const BROWSER_EVENT_ID_MAX_BYTES = 256;
const BROWSER_EVENT_CLIENT_ID_MAX_BYTES = 4 * 1024;
const BROWSER_EVENT_DUPLICATE_REASON_MAX_BYTES = 4 * 1024;
const BROWSER_EVENT_PAYLOAD_PREVIEW_MAX_BYTES = 48 * 1024;
const BROWSER_EVENT_PAYLOAD_IDENTITY_FIELDS = [
  "id",
  "callId",
  "call_id",
  "name",
  "toolName",
  "status",
  "code",
  "isError",
  "stream",
  "commandId",
  "sequence",
  "coalescedUntil",
  "coalescedCount",
  "firstSequence",
  "lastSequence",
] as const;

export const SESSION_EVENT_BROWSER_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_EVENT_BROWSER_MAX_COUNT = 10_000;
export const SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES = 96 * 1024;
export const SESSION_EVENT_BROWSER_PENDING_MAX_BYTES = 1024 * 1024;
export const SESSION_EVENT_BROWSER_PENDING_MAX_COUNT = 256;

export type BrowserSessionEventWindow = {
  events: SessionEvent[];
  bytes: number;
  truncated: boolean;
};

const EMPTY_EVENT_WINDOW: BrowserSessionEventWindow = {
  events: EMPTY_EVENTS,
  bytes: 2,
  truncated: false,
};

/**
 * Live-stream a session's event log with replay-by-sequence, reconnect, and
 * batched React updates. Fresh loads default to a bounded tail window; pass
 * `replay: "full"` or a nonzero `after` for the previous full replay path.
 */
export function useSessionEvents(
  sessionId: string | null | undefined,
  options: UseSessionEventsOptions = {},
): UseSessionEventsResult {
  const { client, workspaceId, reconcileSession } = useEmbeddedSession(options);
  const enabled = options.enabled ?? true;
  const after = options.after ?? 0;
  const replay = options.replay ?? "windowed";
  const fullReplay = replay === "full" || after !== 0;
  const streamKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${after}\u0000${fullReplay ? "full" : "windowed"}`;

  const [eventWindow, setEventWindow] = useState<BrowserSessionEventWindow>(EMPTY_EVENT_WINDOW);
  const [connectionState, setConnectionState] = useState<SessionEventsConnectionState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [sessionStatusProjection, setSessionStatusProjection] = useState<SessionStatus | null>(
    null,
  );
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const lastSequenceRef = useRef(after);
  const streamResumeSequenceRef = useRef(after);
  const oldestSequenceRef = useRef<number | null>(null);
  const hasOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const initialWindowLoadedRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const eventWindowRef = useRef<BrowserSessionEventWindow>(EMPTY_EVENT_WINDOW);
  const sessionStatusRef = useRef<{
    sequence: number;
    status: SessionStatus | null;
  }>({
    sequence: after,
    status: null,
  });
  // Effects reset state after commit. Tag the state so the first render for a
  // new stream identity cannot expose the previous session's event log.
  const [stateStreamKey, setStateStreamKey] = useState(streamKey);

  useEffect(() => {
    // Reset the accumulated log only when the stream identity changes —
    // pausing via `enabled: false` keeps the timeline visible.
    if (streamKeyRef.current !== streamKey) {
      streamKeyRef.current = streamKey;
      setStateStreamKey(streamKey);
      eventWindowRef.current = EMPTY_EVENT_WINDOW;
      setEventWindow(EMPTY_EVENT_WINDOW);
      setError(null);
      setHasOlder(false);
      sessionStatusRef.current = { sequence: after, status: null };
      setSessionStatusProjection(null);
      setLoadingOlder(false);
      setInitialLoading(true);
      lastSequenceRef.current = after;
      streamResumeSequenceRef.current = after;
      oldestSequenceRef.current = null;
      hasOlderRef.current = false;
      loadingOlderRef.current = false;
      initialWindowLoadedRef.current = false;
    }
    // AbortController is advisory: custom SDK clients and async iterators may
    // ignore it and resolve/yield after cleanup. Fence every effect instance so
    // only the newest dependency generation can mutate refs or React state.
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (loadingOlderRef.current) {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
    if (!sessionId || !enabled) {
      setConnectionState("idle");
      return;
    }
    const controller = new AbortController();
    const isCurrent = () => generationRef.current === generation && !controller.signal.aborted;
    streamAbortRef.current = controller;
    // Batch yielded events into one React update per flush window so a long
    // replay (thousands of events) does not render per event. Project every
    // event before retaining it here and synchronously flush at independent
    // count+byte high-water marks: a synchronously yielding async iterator can
    // otherwise starve the 16 ms timer and grow this pre-React buffer without
    // bound even though the final browser window is bounded.
    let pending: SessionEvent[] = [];
    let pendingBytes = 2; // []
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      // A synchronous count/byte high-water flush can run before the scheduled
      // callback gets a macrotask. Cancel that callback before clearing its
      // handle so a long synchronously yielding replay retains at most one
      // timer rather than one stale callback per flushed batch.
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!isCurrent()) {
        pending = [];
        pendingBytes = 2;
        return;
      }
      if (pending.length === 0) {
        return;
      }
      const batch = pending;
      pending = [];
      pendingBytes = 2;
      // The resume cursor only advances with delivered batches: events still
      // sitting in `pending` when the stream is torn down are re-fetched on
      // the next connect instead of being skipped.
      const lastInBatch = batch[batch.length - 1];
      if (lastInBatch) {
        const batchResumeSequence = Math.max(...batch.map(eventResumeSequence));
        lastSequenceRef.current = Math.max(lastSequenceRef.current, batchResumeSequence);
        streamResumeSequenceRef.current = Math.max(
          streamResumeSequenceRef.current,
          batchResumeSequence,
        );
      }
      observeSessionStatus(batch, sessionStatusRef, setSessionStatusProjection);
      const current = eventWindowRef.current;
      const next = boundBrowserSessionEventWindow([...current.events, ...batch]);
      const retained = {
        ...next,
        truncated: current.truncated || next.truncated,
      };
      eventWindowRef.current = retained;
      setEventWindow(retained);
      oldestSequenceRef.current = retained.events[0]?.sequence ?? null;
      if (retained.truncated) {
        hasOlderRef.current = true;
        setHasOlder(true);
      }
    };
    const scheduleFlush = () => {
      if (!isCurrent()) return;
      flushTimer ??= setTimeout(flush, 16);
    };

    void (async () => {
      try {
        if (!fullReplay && !initialWindowLoadedRef.current) {
          setConnectionState("connecting");
          // First paint is ONE compact fetch — the newest window, revealed at
          // the bottom in a few hundred ms. Deeper history loads only when the
          // reader actually scrolls up (the sentinel drives loadOlder).
          const window = await loadEventWindow(client, workspaceId, sessionId, {
            before: Number.MAX_SAFE_INTEGER,
            pageSize: INITIAL_TAIL_PAGE_SIZE,
            targetGroups: Number.POSITIVE_INFINITY,
            maxFetches: INITIAL_FETCH_CAP,
            signal: controller.signal,
          });
          if (!isCurrent()) {
            return;
          }
          observeSessionStatus(window.events, sessionStatusRef, setSessionStatusProjection);
          const retained = boundBrowserSessionEventWindow(window.events);
          eventWindowRef.current = retained;
          setEventWindow(retained);
          oldestSequenceRef.current = retained.events[0]?.sequence ?? window.oldestSequence;
          hasOlderRef.current = window.hasOlder || retained.truncated;
          lastSequenceRef.current = window.newestSequence;
          streamResumeSequenceRef.current = window.newestSequence;
          initialWindowLoadedRef.current = true;
          setHasOlder(window.hasOlder || retained.truncated);
          setInitialLoading(false);
        }
        if (fullReplay) {
          setInitialLoading(false);
        }
        const stream = client.streamEvents(workspaceId, sessionId, {
          after: streamResumeSequenceRef.current,
          signal: controller.signal,
          beforeLive: async () => await reconcileSession(sessionId),
          onStateChange: (state) => {
            if (isCurrent()) {
              setConnectionState(state);
            }
          },
        });
        for await (const event of stream) {
          if (!isCurrent()) break;
          const boundedEvent = boundBrowserLegacyEvent(event);
          const boundedEventBytes = browserJsonBytes(boundedEvent);
          const separatorBytes = pending.length === 0 ? 0 : 1;
          if (
            pending.length > 0 &&
            (pending.length >= SESSION_EVENT_BROWSER_PENDING_MAX_COUNT ||
              pendingBytes + separatorBytes + boundedEventBytes >
                SESSION_EVENT_BROWSER_PENDING_MAX_BYTES)
          ) {
            flush();
          }
          pending.push(boundedEvent);
          pendingBytes += (pending.length === 1 ? 0 : 1) + boundedEventBytes;
          if (
            pending.length >= SESSION_EVENT_BROWSER_PENDING_MAX_COUNT ||
            pendingBytes >= SESSION_EVENT_BROWSER_PENDING_MAX_BYTES
          ) {
            flush();
          } else {
            scheduleFlush();
          }
        }
        if (isCurrent()) {
          flush();
          setConnectionState("ended");
        }
      } catch (cause) {
        if (isCurrent()) {
          flush();
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setConnectionState("error");
        }
      }
    })();

    return () => {
      controller.abort();
      if (generationRef.current === generation) {
        generationRef.current = generation + 1;
      }
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
    };
  }, [
    client,
    workspaceId,
    sessionId,
    after,
    enabled,
    fullReplay,
    streamKey,
    streamEpoch,
    reconcileSession,
  ]);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!sessionId || loadingOlderRef.current || !hasOlderRef.current) {
      return false;
    }
    const before = oldestSequenceRef.current;
    if (before === null) {
      hasOlderRef.current = false;
      setHasOlder(false);
      return false;
    }
    const generation = generationRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const window = await loadEventWindow(client, workspaceId, sessionId, {
        before,
        pageSize: OLDER_PAGE_SIZE,
        targetGroups: OLDER_GROUP_TARGET,
        maxFetches: OLDER_FETCH_CAP,
      });
      if (generationRef.current !== generation) {
        return false;
      }
      if (window.events.length === 0) {
        oldestSequenceRef.current = null;
        hasOlderRef.current = false;
        setHasOlder(false);
        return false;
      }
      const current = eventWindowRef.current;
      assertPrependOrder(current.events, window.events);
      // Freeze the live iterator before replacing its in-memory window. Rows
      // pending in the aborted iterator were never cursor-committed and will
      // be replayed from the retained high-water mark below.
      streamAbortRef.current?.abort();
      observeSessionStatus(window.events, sessionStatusRef, setSessionStatusProjection);
      const next = boundBrowserSessionEventWindow([...window.events, ...current.events], {
        direction: "oldest",
      });
      const retained = {
        ...next,
        truncated: current.truncated || next.truncated,
      };
      const retainedOldest = retained.events[0]?.sequence ?? null;
      if (retainedOldest === null || retainedOldest >= before) {
        throw new Error("@opengeni/react: loadOlder made no durable sequence progress");
      }
      eventWindowRef.current = retained;
      setEventWindow(retained);
      oldestSequenceRef.current = retainedOldest;
      streamResumeSequenceRef.current = maxResumeSequence(retained.events);
      // Oldest-directed eviction can discard newer in-memory rows. That fact
      // keeps windowTruncated true, but it does not imply older durable rows
      // exist; only the backward DB page can answer hasOlder truthfully.
      const olderStillAvailable = window.hasOlder;
      hasOlderRef.current = olderStillAvailable;
      setHasOlder(olderStillAvailable);
      setStreamEpoch((epoch) => epoch + 1);
      return olderStillAvailable;
    } finally {
      if (generationRef.current === generation) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [client, workspaceId, sessionId]);

  const identityMatches = stateStreamKey === streamKey;
  const visibleEvents = identityMatches ? eventWindow.events : EMPTY_EVENTS;
  const timeline = useMemo(() => buildTimeline(visibleEvents), [visibleEvents]);

  return {
    events: visibleEvents,
    timeline,
    sessionStatus: identityMatches ? sessionStatusProjection : null,
    connectionState: identityMatches ? connectionState : "idle",
    lastSequence: identityMatches ? lastSequenceRef.current : after,
    windowBytes: identityMatches ? eventWindow.bytes : 2,
    windowTruncated: identityMatches ? eventWindow.truncated : false,
    initialLoading: fullReplay ? false : identityMatches ? initialLoading : true,
    hasOlder: !identityMatches ? false : hasOlder,
    loadingOlder: !identityMatches ? false : loadingOlder,
    loadOlder,
    error: identityMatches ? error : null,
  };
}

/**
 * Keep one direction-aware count+byte-bounded browser window. Live/default
 * accumulation retains the newest suffix; backward paging retains the oldest
 * prefix so newly fetched history cannot be immediately evicted. This is
 * deliberately separate from durable history and transport paging: when a
 * backward page evicts the live tail, the hook reconnects from the retained
 * high-water mark while preserving the highest-ever-observed sequence
 * separately. The source event remains durable in PostgreSQL throughout.
 */
export function boundBrowserSessionEventWindow(
  events: readonly SessionEvent[],
  options: {
    maxBytes?: number;
    maxCount?: number;
    direction?: "newest" | "oldest";
  } = {},
): BrowserSessionEventWindow {
  const maxBytes = Math.max(1024, options.maxBytes ?? SESSION_EVENT_BROWSER_MAX_BYTES);
  const maxCount = Math.max(1, Math.floor(options.maxCount ?? SESSION_EVENT_BROWSER_MAX_COUNT));
  const safe = events.map(boundBrowserLegacyEvent);
  const selected: SessionEvent[] = [];
  let bytes = 2; // []
  const direction = options.direction ?? "newest";
  const start = direction === "newest" ? safe.length - 1 : 0;
  const end = direction === "newest" ? Math.max(-1, safe.length - maxCount - 1) : safe.length;
  const step = direction === "newest" ? -1 : 1;
  for (let index = start; index !== end && selected.length < maxCount; index += step) {
    const event = safe[index]!;
    const eventBytes = browserJsonBytes(event);
    const separator = selected.length === 0 ? 0 : 1;
    if (bytes + separator + eventBytes > maxBytes) break;
    selected.push(event);
    bytes += separator + eventBytes;
  }
  if (direction === "newest") selected.reverse();
  return {
    events: selected,
    bytes,
    truncated: selected.length < safe.length,
  };
}

function boundBrowserLegacyEvent(event: SessionEvent): SessionEvent {
  // The server-side canonical projection lives in @opengeni/contracts. The
  // publishable React package may depend only on the zero-runtime-dependency
  // SDK, so this is intentionally a last-resort client guard rather than a
  // second durable representation. Reconstructing the SDK wire shape prevents
  // legacy/malformed extra properties from bypassing the browser byte cap.
  const serialized = browserSerialize(event);
  const originalBytes = serialized.serializable
    ? encoder.encode(serialized.value).byteLength
    : null;
  const typeIsSafe =
    browserUtf8Bytes(event.type) <= BROWSER_EVENT_TYPE_MAX_BYTES &&
    !event.type.includes("\n") &&
    !event.type.includes("\r");
  const clientEventId = boundBrowserOptionalText(
    event.clientEventId,
    BROWSER_EVENT_CLIENT_ID_MAX_BYTES,
  );
  const duplicateReason = boundBrowserOptionalText(
    event.duplicateReason,
    BROWSER_EVENT_DUPLICATE_REASON_MAX_BYTES,
  );

  if (
    serialized.serializable &&
    originalBytes !== null &&
    originalBytes <= SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES &&
    typeIsSafe &&
    clientEventId === event.clientEventId &&
    duplicateReason === event.duplicateReason
  ) {
    return event;
  }

  const envelopeProjection = [
    !typeIsSafe
      ? browserEnvelopeFieldProjection("type", event.type, "session.event.envelope_omitted")
      : null,
    clientEventId !== event.clientEventId
      ? browserEnvelopeFieldProjection("clientEventId", event.clientEventId, clientEventId)
      : null,
    duplicateReason !== event.duplicateReason
      ? browserEnvelopeFieldProjection("duplicateReason", event.duplicateReason, duplicateReason)
      : null,
  ].filter((field) => field !== null);
  const payloadSerialization = browserSerialize(event.payload);
  const payloadBytes = payloadSerialization.serializable
    ? encoder.encode(payloadSerialization.value).byteLength
    : null;
  const preview = truncateBrowserUtf8Middle(
    payloadSerialization.value,
    BROWSER_EVENT_PAYLOAD_PREVIEW_MAX_BYTES,
  );
  const truncation = {
    truncated: true as const,
    surface: "browser_legacy_guard" as const,
    reason: serialized.serializable ? "event_envelope_bytes_exceeded" : "event_not_serializable",
    originalBytes,
    deliveredBytes: 0,
    omittedBytes: originalBytes,
    estimatedOriginalTokens: originalBytes === null ? null : Math.ceil(originalBytes / 4),
    estimatedDeliveredTokens: 0,
    fullEvidence: { available: false as const, reason: "not_retained" as const },
    details: [
      {
        path: "$.payload",
        kind: "payload_preview",
        originalBytes: payloadBytes,
        deliveredBytes: browserUtf8Bytes(preview),
      },
    ],
  };
  const payload: Record<string, unknown> = {
    ...browserPayloadIdentity(event.payload),
    preview,
    ...(envelopeProjection.length > 0
      ? {
          originalType: boundBrowserText(event.type, BROWSER_EVENT_TYPE_MAX_BYTES),
          envelopeProjection: {
            truncated: true,
            surface: "browser_legacy_guard",
            fields: envelopeProjection,
          },
        }
      : {}),
    truncation,
  };
  const bounded: SessionEvent = {
    id: boundBrowserText(event.id, BROWSER_EVENT_ID_MAX_BYTES),
    workspaceId: boundBrowserText(event.workspaceId, BROWSER_EVENT_ID_MAX_BYTES),
    sessionId: boundBrowserText(event.sessionId, BROWSER_EVENT_ID_MAX_BYTES),
    sequence: event.sequence,
    type: typeIsSafe ? event.type : "session.event.envelope_omitted",
    payload,
    occurredAt: boundBrowserText(event.occurredAt, BROWSER_EVENT_ID_MAX_BYTES),
    clientEventId,
    turnId: boundBrowserOptionalText(event.turnId, BROWSER_EVENT_ID_MAX_BYTES),
    turnGeneration: event.turnGeneration,
    turnAttemptId: boundBrowserOptionalText(event.turnAttemptId, BROWSER_EVENT_ID_MAX_BYTES),
    turnAssociation: event.turnAssociation,
    duplicateOfEventId: boundBrowserOptionalText(
      event.duplicateOfEventId,
      BROWSER_EVENT_ID_MAX_BYTES,
    ),
    duplicateReason,
  };

  settleBrowserEventTruncation(bounded, truncation);
  if (browserJsonBytes(bounded) > SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES) {
    payload.preview = truncateBrowserUtf8Middle(String(payload.preview), 4 * 1024);
    truncation.details = truncation.details.slice(0, 1);
    settleBrowserEventTruncation(bounded, truncation);
  }
  if (browserJsonBytes(bounded) > SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES) {
    bounded.clientEventId = null;
    bounded.duplicateReason = null;
    payload.preview = "[legacy event omitted at the browser byte boundary]";
    settleBrowserEventTruncation(bounded, truncation);
  }
  return bounded;
}

function browserJsonBytes(value: unknown): number {
  return encoder.encode(browserSerialize(value).value).byteLength;
}

function browserSerialize(value: unknown): { value: string; serializable: boolean } {
  try {
    const serialized = JSON.stringify(value);
    return { value: serialized === undefined ? "null" : serialized, serializable: true };
  } catch {
    return {
      value: '"[unserializable event payload omitted at browser boundary]"',
      serializable: false,
    };
  }
}

function browserPayloadIdentity(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const identity: Record<string, unknown> = {};
  for (const field of BROWSER_EVENT_PAYLOAD_IDENTITY_FIELDS) {
    const value = record[field];
    if (typeof value === "string") {
      identity[field] = boundBrowserText(value, BROWSER_EVENT_ID_MAX_BYTES);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      identity[field] = value;
    }
  }
  return identity;
}

function browserEnvelopeFieldProjection(
  field: string,
  original: string | null | undefined,
  delivered: string | null | undefined,
): { field: string; originalBytes: number; deliveredBytes: number } {
  return {
    field,
    originalBytes: typeof original === "string" ? browserUtf8Bytes(original) : 0,
    deliveredBytes: typeof delivered === "string" ? browserUtf8Bytes(delivered) : 0,
  };
}

function boundBrowserOptionalText<T extends string | null | undefined>(
  value: T,
  maxBytes: number,
): T {
  return (typeof value === "string" ? boundBrowserText(value, maxBytes) : value) as T;
}

function boundBrowserText(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = "…[truncated]";
  const prefixBudget = Math.max(0, maxBytes - browserUtf8Bytes(marker));
  let prefixEnd = Math.min(prefixBudget, bytes.byteLength);
  while (
    prefixEnd > 0 &&
    prefixEnd < bytes.byteLength &&
    isBrowserUtf8Continuation(bytes[prefixEnd]!)
  ) {
    prefixEnd -= 1;
  }
  return `${decoder.decode(bytes.subarray(0, prefixEnd))}${marker}`;
}

function truncateBrowserUtf8Middle(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = `…[${bytes.byteLength - maxBytes} bytes omitted]…`;
  const contentBudget = Math.max(0, maxBytes - browserUtf8Bytes(marker));
  const leftBudget = Math.floor(contentBudget / 2);
  const rightBudget = contentBudget - leftBudget;
  let leftEnd = Math.min(leftBudget, bytes.byteLength);
  while (leftEnd > 0 && leftEnd < bytes.byteLength && isBrowserUtf8Continuation(bytes[leftEnd]!)) {
    leftEnd -= 1;
  }
  let rightStart = Math.max(0, bytes.byteLength - rightBudget);
  while (rightStart < bytes.byteLength && isBrowserUtf8Continuation(bytes[rightStart]!)) {
    rightStart += 1;
  }
  return `${decoder.decode(bytes.subarray(0, leftEnd))}${marker}${decoder.decode(bytes.subarray(rightStart))}`;
}

function settleBrowserEventTruncation(
  event: SessionEvent,
  truncation: {
    originalBytes: number | null;
    deliveredBytes: number;
    omittedBytes: number | null;
    estimatedDeliveredTokens: number;
  },
): void {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const deliveredBytes = browserJsonBytes(event);
    const omittedBytes =
      truncation.originalBytes === null
        ? null
        : Math.max(0, truncation.originalBytes - deliveredBytes);
    const estimatedDeliveredTokens = Math.ceil(deliveredBytes / 4);
    if (
      truncation.deliveredBytes === deliveredBytes &&
      truncation.omittedBytes === omittedBytes &&
      truncation.estimatedDeliveredTokens === estimatedDeliveredTokens
    ) {
      return;
    }
    truncation.deliveredBytes = deliveredBytes;
    truncation.omittedBytes = omittedBytes;
    truncation.estimatedDeliveredTokens = estimatedDeliveredTokens;
  }
  throw new RangeError("Browser event byte accounting did not converge");
}

function browserUtf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function isBrowserUtf8Continuation(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function observeSessionStatus(
  events: readonly SessionEvent[],
  ref: { current: { sequence: number; status: SessionStatus | null } },
  setStatus: (status: SessionStatus | null) => void,
): void {
  let latest: { sequence: number; status: SessionStatus } | null = null;
  for (const event of events) {
    const status = sessionStatusFromEvents([event]);
    if (status && (!latest || event.sequence >= latest.sequence)) {
      latest = { sequence: event.sequence, status };
    }
  }
  if (!latest || latest.sequence < ref.current.sequence) return;
  ref.current = latest;
  setStatus(latest.status);
}

type LoadedEventWindow = {
  events: SessionEvent[];
  oldestSequence: number | null;
  newestSequence: number;
  hasOlder: boolean;
};

async function loadEventWindow(
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  options: {
    before: number;
    pageSize: number;
    targetGroups: number;
    maxFetches: number;
    signal?: AbortSignal;
  },
): Promise<LoadedEventWindow> {
  let cursor = options.before;
  let buffer: SessionEvent[] = [];
  let reachedStart = false;
  let fetches = 0;

  while (fetches < options.maxFetches) {
    if (buffer.length > 0 && groupCount(buffer) >= options.targetGroups) {
      break;
    }
    const page = await loadPreviousPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    fetches += 1;
    if (page.length === 0) {
      reachedStart = true;
      break;
    }
    assertAscending(page);
    buffer = [...page, ...buffer];
    cursor = page[0]!.sequence;
    if (isLogStart(page[0]!)) {
      reachedStart = true;
      break;
    }
  }

  // Boundary snap: a window that starts mid-turn TRIMS its head to the oldest
  // turn boundary already in the buffer — the dropped fragment is refetched by
  // the next loadOlder (everything below the new oldest sequence), whose own
  // window snaps the same way, so every seam lands on a turn start. Extra
  // pages are fetched only when the buffer holds no boundary at all (one
  // monster turn); past the cap a mid-turn top is accepted.
  let snapPages = 0;
  while (
    !reachedStart &&
    findBoundaryIndex(buffer) === -1 &&
    snapPages < BOUNDARY_PAGE_CAP &&
    fetches < options.maxFetches
  ) {
    const page = await loadPreviousPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    fetches += 1;
    snapPages += 1;
    if (page.length === 0) {
      reachedStart = true;
      break;
    }
    assertAscending(page);
    buffer = [...page, ...buffer];
    cursor = page[0]!.sequence;
    if (isLogStart(page[0]!)) {
      reachedStart = true;
      break;
    }
  }
  if (!reachedStart) {
    const boundary = findBoundaryIndex(buffer);
    if (boundary > 0) {
      buffer = buffer.slice(boundary);
    }
  }

  const oldest = buffer[0] ?? null;
  const newest = buffer[buffer.length - 1] ?? null;
  return {
    events: buffer,
    oldestSequence: oldest?.sequence ?? null,
    newestSequence: newest ? maxResumeSequence(buffer) : 0,
    hasOlder: buffer.length > 0 && !reachedStart && oldest?.type !== "session.created",
  };
}

/** Index of the oldest clean turn start in the buffer, or -1. */
function findBoundaryIndex(events: SessionEvent[]): number {
  for (let index = 0; index < events.length; index += 1) {
    const type = events[index]!.type;
    if (type === "session.created" || type === "user.message") {
      return index;
    }
  }
  return -1;
}

type PreviousPage = SessionEvent[] & { requested: number };

async function loadPreviousPage(
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  before: number,
  options: {
    pageSize: number;
    signal?: AbortSignal;
  },
): Promise<PreviousPage> {
  if (options.signal?.aborted) {
    throw abortError();
  }
  const requested = options.pageSize;
  if (requested === 0) {
    return Object.assign([], { requested });
  }
  const page = await client.listEvents(workspaceId, sessionId, {
    before,
    limit: requested,
    compact: true,
  });
  if (options.signal?.aborted) {
    throw abortError();
  }
  return Object.assign(page, { requested });
}

function groupCount(events: SessionEvent[]): number {
  if (events.length === 0) {
    return 0;
  }
  return groupTimeline(buildTimeline(events)).length;
}

function isLogStart(event: SessionEvent): boolean {
  return event.type === "session.created" || event.sequence <= 1;
}

function maxResumeSequence(events: SessionEvent[]): number {
  return events.reduce((max, event) => Math.max(max, eventResumeSequence(event)), 0);
}

function eventResumeSequence(event: SessionEvent): number {
  const payload = asRecord(event.payload);
  const coalescedUntil = Number(payload.coalescedUntil);
  return Math.max(event.sequence, Number.isFinite(coalescedUntil) ? Math.floor(coalescedUntil) : 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function assertAscending(events: SessionEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1]!.sequence >= events[index]!.sequence) {
      throw new Error("@opengeni/react: session events must be ordered by ascending sequence");
    }
  }
}

function assertPrependOrder(existing: SessionEvent[], older: SessionEvent[]): void {
  if (!shouldAssertDevelopment() || existing.length === 0 || older.length === 0) {
    return;
  }
  if (older[older.length - 1]!.sequence >= existing[0]!.sequence) {
    throw new Error("@opengeni/react: loadOlder returned overlapping session events");
  }
}

function shouldAssertDevelopment(): boolean {
  const processEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env;
  return processEnv !== undefined && processEnv.NODE_ENV !== "production";
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
