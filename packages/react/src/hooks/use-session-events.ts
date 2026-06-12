import type { SessionEvent, SessionStatus, StreamConnectionState } from "@opengeni/sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { buildTimeline, sessionStatusFromEvents, type TimelineItem } from "../timeline";

export type SessionEventsConnectionState = StreamConnectionState | "idle" | "ended" | "error";

export type UseSessionEventsOptions = ClientOverride & {
  /** Resume after this sequence (exclusive). Defaults to 0 = full replay. */
  after?: number | undefined;
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
  error: Error | null;
};

/**
 * Live-stream a session's event log with replay-by-sequence, reconnect, and
 * batched React updates. The SDK guarantees ordered, gap-free, exactly-once
 * delivery; this hook accumulates the log and projects it into a timeline.
 */
export function useSessionEvents(sessionId: string | null | undefined, options: UseSessionEventsOptions = {}): UseSessionEventsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = options.enabled ?? true;
  const after = options.after ?? 0;

  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [connectionState, setConnectionState] = useState<SessionEventsConnectionState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const lastSequenceRef = useRef(after);
  const streamKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // Reset the accumulated log only when the stream identity changes —
    // pausing via `enabled: false` keeps the timeline visible.
    const streamKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${after}`;
    if (streamKeyRef.current !== streamKey) {
      streamKeyRef.current = streamKey;
      setEvents([]);
      setError(null);
      lastSequenceRef.current = after;
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
      setEvents((existing) => [...existing, ...batch]);
    };
    const scheduleFlush = () => {
      flushTimer ??= setTimeout(flush, 16);
    };

    void (async () => {
      try {
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
          lastSequenceRef.current = event.sequence;
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
  }, [client, workspaceId, sessionId, after, enabled]);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const sessionStatus = useMemo(() => sessionStatusFromEvents(events), [events]);

  return {
    events,
    timeline,
    sessionStatus,
    connectionState,
    lastSequence: lastSequenceRef.current,
    error,
  };
}
