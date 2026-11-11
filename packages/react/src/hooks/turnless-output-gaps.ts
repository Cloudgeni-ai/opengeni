import { useCallback, useSyncExternalStore } from "react";

/**
 * Live turnless output (PTY and background command output) reaches the
 * sandbox terminal through the session's live stream, but conversation reads
 * never carry it. When the stream rejoins at the durable head past unread
 * rows, or a burst overflows the live tail before anyone rendered it,
 * `useSessionEvents` bumps this session's generation and the terminal re-reads
 * its newest output by type.
 *
 * Keyed by workspace and session rather than client object: the session
 * history and the terminal can hold different client wrappers, and a spurious
 * re-read is only one bounded read.
 */
type GapEntry = { generation: number; listeners: Set<() => void> };

const MAX_IDLE_ENTRIES = 256;
const entries = new Map<string, GapEntry>();

function gapKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

function gapEntry(key: string): GapEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { generation: 0, listeners: new Set() };
    entries.set(key, entry);
    if (entries.size > MAX_IDLE_ENTRIES) {
      for (const [candidate, held] of entries) {
        if (entries.size <= MAX_IDLE_ENTRIES) break;
        if (candidate !== key && held.listeners.size === 0) entries.delete(candidate);
      }
    }
  }
  return entry;
}

/** @internal Live turnless output of this session may have been missed. */
export function markTurnlessOutputGap(workspaceId: string, sessionId: string): void {
  const entry = gapEntry(gapKey(workspaceId, sessionId));
  entry.generation += 1;
  for (const listener of [...entry.listeners]) listener();
}

/** @internal This session's gap generation; it changes after each possible gap. */
export function useTurnlessOutputGap(
  workspaceId: string,
  sessionId: string | null | undefined,
): number {
  const key = sessionId ? gapKey(workspaceId, sessionId) : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {};
      const entry = gapEntry(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [key],
  );
  const read = useCallback(() => (key ? (entries.get(key)?.generation ?? 0) : 0), [key]);
  return useSyncExternalStore(subscribe, read, read);
}
