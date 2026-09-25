import { useEffect, useRef } from "react";
import type { SessionStatus } from "@opengeni/sdk";

/** Tab-title marker for an open session that settled while the tab was in the background. */
export const ATTENTION_TITLE_PREFIX = "● ";

const BUSY_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "queued",
  "running",
  "recovering",
  "waiting_capacity",
]);
// Finished (idle, including an agent wait for input), failed, or waiting on the
// user for an approval or answer. Cancellation is the user's own action.
const ATTENTION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "idle",
  "failed",
  "requires_action",
]);

/** True when a working session settles into a state the user should look at. */
export function isAttentionTransition(
  previous: SessionStatus | null,
  next: SessionStatus | null,
): boolean {
  return (
    previous !== null &&
    next !== null &&
    BUSY_STATUSES.has(previous) &&
    ATTENTION_STATUSES.has(next)
  );
}

export function withAttentionPrefix(title: string): string {
  return title.startsWith(ATTENTION_TITLE_PREFIX) ? title : `${ATTENTION_TITLE_PREFIX}${title}`;
}

export function withoutAttentionPrefix(title: string): string {
  return title.startsWith(ATTENTION_TITLE_PREFIX)
    ? title.slice(ATTENTION_TITLE_PREFIX.length)
    : title;
}

function inBackground(doc: Document): boolean {
  return doc.visibilityState === "hidden" || !doc.hasFocus();
}

/**
 * Marks the document title when the open session finishes, fails, or needs
 * input while the tab is hidden or unfocused, and clears the mark as soon as
 * the tab is back in front. Presentation only: it never reads or writes
 * session state.
 */
export function useBackgroundAttentionTitle(sessionId: string, status: SessionStatus | null) {
  const previous = useRef<{ sessionId: string; status: SessionStatus | null } | null>(null);
  useEffect(() => {
    const prior = previous.current;
    previous.current = { sessionId, status };
    if (!prior || prior.sessionId !== sessionId) return;
    if (!isAttentionTransition(prior.status, status) || !inBackground(document)) return;
    document.title = withAttentionPrefix(document.title);
  }, [sessionId, status]);
  useEffect(() => {
    const clear = () => {
      if (!inBackground(document)) document.title = withoutAttentionPrefix(document.title);
    };
    window.addEventListener("focus", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("focus", clear);
      document.removeEventListener("visibilitychange", clear);
      document.title = withoutAttentionPrefix(document.title);
    };
  }, []);
}
