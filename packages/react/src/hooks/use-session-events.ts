import type { SessionEvent, SessionStatus, StreamConnectionState } from "@opengeni/sdk";
import { boundSessionEvent, type SessionEvent as ContractSessionEvent } from "@opengeni/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import {
  buildTimeline,
  groupTimeline,
  sessionStatusFromEvents,
  type TimelineItem,
} from "../timeline";
import type { SessionClientLike } from "../client";

export type SessionEventsConnectionState = StreamConnectionState | "idle" | "ended" | "error";

export type UseSessionEventsOptions = ClientOverride & {
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

export const SESSION_EVENT_BROWSER_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_EVENT_BROWSER_MAX_COUNT = 10_000;
export const SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES = 96 * 1024;

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
  const { client, workspaceId, reconcileSession } = useOpenGeni(options);
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
  const lastSequenceRef = useRef(after);
  const oldestSequenceRef = useRef<number | null>(null);
  const hasOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);
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
      generationRef.current += 1;
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
      oldestSequenceRef.current = null;
      hasOlderRef.current = false;
      loadingOlderRef.current = false;
    }
    if (!sessionId || !enabled) {
      setConnectionState("idle");
      return;
    }
    const controller = new AbortController();
    // Batch yielded events into one React update per flush window so a long
    // replay (thousands of events) does not render per event.
    let pending: SessionEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) {
        return;
      }
      const batch = pending;
      pending = [];
      // The resume cursor only advances with delivered batches: events still
      // sitting in `pending` when the stream is torn down are re-fetched on
      // the next connect instead of being skipped.
      const lastInBatch = batch[batch.length - 1];
      if (lastInBatch) {
        lastSequenceRef.current = Math.max(
          lastSequenceRef.current,
          ...batch.map(eventResumeSequence),
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
      flushTimer ??= setTimeout(flush, 16);
    };

    void (async () => {
      try {
        if (!fullReplay) {
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
          if (controller.signal.aborted) {
            return;
          }
          observeSessionStatus(window.events, sessionStatusRef, setSessionStatusProjection);
          const retained = boundBrowserSessionEventWindow(window.events);
          eventWindowRef.current = retained;
          setEventWindow(retained);
          oldestSequenceRef.current = retained.events[0]?.sequence ?? window.oldestSequence;
          hasOlderRef.current = window.hasOlder || retained.truncated;
          lastSequenceRef.current = window.newestSequence;
          setHasOlder(window.hasOlder || retained.truncated);
          setInitialLoading(false);
        }
        if (fullReplay) {
          setInitialLoading(false);
        }
        const stream = client.streamEvents(workspaceId, sessionId, {
          after: lastSequenceRef.current,
          signal: controller.signal,
          beforeLive: async () => await reconcileSession(sessionId),
          onStateChange: (state) => {
            if (!controller.signal.aborted) {
              setConnectionState(state);
            }
          },
        });
        for await (const event of stream) {
          pending.push(event);
          scheduleFlush();
        }
        if (!controller.signal.aborted) {
          flush();
          setConnectionState("ended");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          flush();
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setConnectionState("error");
        }
      }
    })();

    return () => {
      controller.abort();
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
    };
  }, [client, workspaceId, sessionId, after, enabled, fullReplay, streamKey, reconcileSession]);

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
      // Oldest-directed eviction can discard newer in-memory rows. That fact
      // keeps windowTruncated true, but it does not imply older durable rows
      // exist; only the backward DB page can answer hasOlder truthfully.
      const olderStillAvailable = window.hasOlder;
      hasOlderRef.current = olderStillAvailable;
      setHasOlder(olderStillAvailable);
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
 * deliberately separate from durable history and transport paging: eviction
 * changes neither the resume cursor nor whether the source event still exists
 * in PostgreSQL.
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
  return boundSessionEvent(event as unknown as ContractSessionEvent, {
    surface: "browser_legacy_guard",
    maxBytes: SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES,
  }) as unknown as SessionEvent;
}

function browserJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return encoder.encode(serialized === undefined ? "null" : serialized).byteLength;
  } catch {
    return encoder.encode('"[unserializable event payload omitted]"').byteLength;
  }
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
  client: SessionClientLike,
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
  client: SessionClientLike,
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
