import type { SessionEvent } from "@opengeni/sdk";
import { useEffect, useRef } from "react";

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
