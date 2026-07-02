import type { SessionEvent, SessionStatus, StreamConnectionState } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { buildTimeline, groupTimeline, sessionStatusFromEvents, type TimelineItem } from "../timeline";
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
  /** Whether older durable events are available before the current window. */
  hasOlder: boolean;
  /** True while an older window is being fetched. */
  loadingOlder: boolean;
  /** Prepend an older density-bounded window; resolves true when more remain. */
  loadOlder: () => Promise<boolean>;
  error: Error | null;
};

const TAIL_PAGE_SIZE = 1000;
const INITIAL_GROUP_TARGET = 48;
const INITIAL_EVENT_BUDGET = 10_000;
const OLDER_GROUP_TARGET = 32;
const OLDER_EVENT_BUDGET = 6_000;
const BOUNDARY_PAGE_CAP = 4;

/**
 * Live-stream a session's event log with replay-by-sequence, reconnect, and
 * batched React updates. Fresh loads default to a bounded tail window; pass
 * `replay: "full"` or a nonzero `after` for the previous full replay path.
 */
export function useSessionEvents(sessionId: string | null | undefined, options: UseSessionEventsOptions = {}): UseSessionEventsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = options.enabled ?? true;
  const after = options.after ?? 0;
  const replay = options.replay ?? "windowed";
  const fullReplay = replay === "full" || after !== 0;

  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [connectionState, setConnectionState] = useState<SessionEventsConnectionState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastSequenceRef = useRef(after);
  const oldestSequenceRef = useRef<number | null>(null);
  const hasOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const streamKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    // Reset the accumulated log only when the stream identity changes —
    // pausing via `enabled: false` keeps the timeline visible.
    const streamKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${after}\u0000${fullReplay ? "full" : "windowed"}`;
    if (streamKeyRef.current !== streamKey) {
      streamKeyRef.current = streamKey;
      generationRef.current += 1;
      setEvents([]);
      setError(null);
      setHasOlder(false);
      setLoadingOlder(false);
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
        lastSequenceRef.current = lastInBatch.sequence;
      }
      setEvents((existing) => [...existing, ...batch]);
    };
    const scheduleFlush = () => {
      flushTimer ??= setTimeout(flush, 16);
    };

    void (async () => {
      try {
        if (!fullReplay) {
          setConnectionState("connecting");
          const window = await loadEventWindow(client, workspaceId, sessionId, {
            before: Number.MAX_SAFE_INTEGER,
            pageSize: TAIL_PAGE_SIZE,
            targetGroups: INITIAL_GROUP_TARGET,
            maxEvents: INITIAL_EVENT_BUDGET,
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            return;
          }
          oldestSequenceRef.current = window.oldestSequence;
          hasOlderRef.current = window.hasOlder;
          lastSequenceRef.current = window.newestSequence;
          setHasOlder(window.hasOlder);
          setEvents(window.events);
        }
        const stream = client.streamEvents(workspaceId, sessionId, {
          after: lastSequenceRef.current,
          signal: controller.signal,
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
  }, [client, workspaceId, sessionId, after, enabled, fullReplay]);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!sessionId || fullReplay || loadingOlderRef.current || !hasOlderRef.current) {
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
        pageSize: TAIL_PAGE_SIZE,
        targetGroups: OLDER_GROUP_TARGET,
        maxEvents: OLDER_EVENT_BUDGET,
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
      oldestSequenceRef.current = window.oldestSequence;
      hasOlderRef.current = window.hasOlder;
      setHasOlder(window.hasOlder);
      setEvents((existing) => {
        assertPrependOrder(existing, window.events);
        return [...window.events, ...existing];
      });
      return window.hasOlder;
    } finally {
      if (generationRef.current === generation) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [client, workspaceId, sessionId, fullReplay]);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const sessionStatus = useMemo(() => sessionStatusFromEvents(events), [events]);

  return {
    events,
    timeline,
    sessionStatus,
    connectionState,
    lastSequence: lastSequenceRef.current,
    hasOlder: fullReplay ? false : hasOlder,
    loadingOlder: fullReplay ? false : loadingOlder,
    loadOlder,
    error,
  };
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
    maxEvents: number;
    signal?: AbortSignal;
  },
): Promise<LoadedEventWindow> {
  let cursor = options.before;
  let buffer: SessionEvent[] = [];
  let reachedStart = false;

  while (buffer.length < options.maxEvents && groupCount(buffer) < options.targetGroups) {
    const page = await loadPreviousPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      remainingEvents: options.maxEvents - buffer.length,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (page.length === 0) {
      reachedStart = true;
      break;
    }
    assertAscending(page);
    buffer = [...page, ...buffer];
    cursor = page[0]!.sequence;
    if (page.length < page.requested) {
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
  while (buffer.length < options.maxEvents && !reachedStart && findBoundaryIndex(buffer) === -1 && snapPages < BOUNDARY_PAGE_CAP) {
    const page = await loadPreviousPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      remainingEvents: options.maxEvents - buffer.length,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    snapPages += 1;
    if (page.length === 0) {
      reachedStart = true;
      break;
    }
    assertAscending(page);
    buffer = [...page, ...buffer];
    cursor = page[0]!.sequence;
    if (page.length < page.requested) {
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
    newestSequence: newest?.sequence ?? 0,
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
    remainingEvents: number;
    signal?: AbortSignal;
  },
): Promise<PreviousPage> {
  if (options.signal?.aborted) {
    throw abortError();
  }
  const requested = Math.min(options.pageSize, Math.max(0, options.remainingEvents));
  if (requested === 0) {
    return Object.assign([], { requested });
  }
  const page = await client.listEvents(workspaceId, sessionId, { before, limit: requested });
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
