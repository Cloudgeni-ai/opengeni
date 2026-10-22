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

/**
 * Whether a hint can change a list of Site conversations: a workspace-wide
 * hint, or one naming Site conversations (`siteSessionIds`).
 */
export function hintChangesSiteConversationLists(hint: WorkspaceSessionListEvent): boolean {
  return hint.sessionIds === null || (hint.siteSessionIds?.length ?? 0) > 0;
}

/**
 * Small unpaged lists reconcile on any authorized hint; the rail scopes its own
 * pages. A list of ordinary sessions skips hints that only name Site
 * conversations; a list of Site conversations (`siteConversations`) skips
 * hints that name none.
 */
export function useSessionListHintRefresh(
  refresh: () => Promise<void>,
  error: Error | null,
  options: { siteConversations?: boolean | undefined } = {},
) {
  const { workspaceId, workspaceSessionListEvent: hint, workspaceControlEvent } = useOpenGeni();
  const available = hint?.workspaceId === workspaceId && hint.available;
  const seen = useRef({ hint, workspaceControlEvent });
  const siteConversations = options.siteConversations === true;
  useEffect(() => {
    const previous = seen.current;
    seen.current = { hint, workspaceControlEvent };
    // A new hint that names nothing this list shows changes nothing here.
    const irrelevant =
      hint !== previous.hint &&
      workspaceControlEvent === previous.workspaceControlEvent &&
      hint !== null &&
      hint !== undefined &&
      !(siteConversations
        ? hintChangesSiteConversationLists(hint)
        : hintChangesOrdinaryLists(hint));
    if (irrelevant) return;
    if (available && document.visibilityState !== "hidden") void refresh();
  }, [available, hint, workspaceControlEvent, refresh, siteConversations]);
  useEffect(() => {
    if (!available || !error || document.visibilityState === "hidden") return;
    const timer = window.setTimeout(() => void refresh(), 15_000);
    return () => window.clearTimeout(timer);
  }, [available, error, refresh]);
}
