import { useEffect, useRef } from "react";
import type { WorkspaceSessionListEvent } from "@opengeni/sdk";
import { useOpenGeni } from "../../session-context";

/**
 * Whether a hint can change an ordinary (non-Site-row) list. A hint with an
 * empty `sessionIds` only carries Site conversations, which those lists omit.
 */
export function hintChangesOrdinaryLists(hint: WorkspaceSessionListEvent): boolean {
  return hint.sessionIds === null || hint.sessionIds.length > 0;
}

/** Small unpaged lists reconcile on any authorized hint; the rail scopes its own pages. */
export function useSessionListHintRefresh(refresh: () => Promise<void>, error: Error | null) {
  const { workspaceId, workspaceSessionListEvent: hint, workspaceControlEvent } = useOpenGeni();
  const available = hint?.workspaceId === workspaceId && hint.available;
  const seen = useRef({ hint, workspaceControlEvent });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { hint, workspaceControlEvent };
    // A new hint that only names Site conversations changes nothing here.
    const siteOnly =
      hint !== previous.hint &&
      workspaceControlEvent === previous.workspaceControlEvent &&
      hint !== null &&
      hint !== undefined &&
      !hintChangesOrdinaryLists(hint);
    if (siteOnly) return;
    if (available && document.visibilityState !== "hidden") void refresh();
  }, [available, hint, workspaceControlEvent, refresh]);
  useEffect(() => {
    if (!available || !error || document.visibilityState === "hidden") return;
    const timer = window.setTimeout(() => void refresh(), 15_000);
    return () => window.clearTimeout(timer);
  }, [available, error, refresh]);
}
