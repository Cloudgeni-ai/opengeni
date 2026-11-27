import type { SessionEvent } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";

/**
 * The highest event sequence in the history when it first loaded for this
 * session, or null until then. Everything at or below it was committed before
 * that history read, so a read started after it already includes it.
 */
export function useSessionHistoryBaseline(
  sessionId: string,
  events: readonly SessionEvent[],
  ready: boolean,
): number | null {
  const [baseline, setBaseline] = useState<{ sessionId: string; sequence: number } | null>(null);
  const current = baseline?.sessionId === sessionId ? baseline.sequence : null;
  if (ready && current === null) {
    const sequence = events.reduce((max, event) => Math.max(max, event.sequence), 0);
    setBaseline({ sessionId, sequence });
    return sequence;
  }
  return current;
}

/**
 * The newest matching event after `baseline`, 0 when there is none, or null
 * while the baseline is unknown. Older history arriving later never changes it,
 * so it is a refresh key for reads that only live events can make stale.
 * Events are in sequence order, so the walk stops at the baseline: a streamed
 * update costs only the events after it.
 */
export function latestSequenceAfter(
  events: readonly SessionEvent[],
  baseline: number | null,
  matches: (event: SessionEvent) => boolean,
): number | null {
  if (baseline === null) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.sequence <= baseline) break;
    if (matches(event)) return event.sequence;
  }
  return 0;
}

/**
 * `onEvent` for each event newer than any seen since the history first
 * loaded. The first ready read only sets where "new" starts, so loading the
 * history, an older page or a reconnect's replay calls nothing again.
 */
export function useLiveSessionEvents(
  sessionId: string | null,
  events: readonly SessionEvent[],
  ready: boolean,
  onEvent: ((event: SessionEvent) => void) | undefined,
): void {
  const callback = useRef(onEvent);
  callback.current = onEvent;
  const seen = useRef<{ sessionId: string | null; sequence: number | null }>({
    sessionId,
    sequence: null,
  });
  useEffect(() => {
    if (seen.current.sessionId !== sessionId) seen.current = { sessionId, sequence: null };
    if (!ready || sessionId === null) return;
    const previous = seen.current.sequence;
    const newest = events.reduce((max, event) => Math.max(max, event.sequence), previous ?? 0);
    seen.current = { sessionId, sequence: newest };
    if (previous === null) return;
    const fresh = events
      .filter((event) => event.sequence > previous)
      .sort((a, b) => a.sequence - b.sequence);
    for (const event of fresh) callback.current?.(event);
  }, [events, ready, sessionId]);
}
