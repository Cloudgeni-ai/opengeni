// Whether a failed session still needs a person. A leaf module: the rail's
// grouping and its live read projections share it without loading each other.
import type { RailSession as Session } from "./session-list-entry";

/**
 * A failed session whose failure its parent agent consumed. That agent owns
 * the follow-up (retry, restart or replace), so neither the failure nor
 * anything the session logs afterwards reaches the person through an
 * ancestor. Matches the server's tree counts.
 */
export function failureHandledByAgent(
  session: Pick<Session, "status" | "failureHandled">,
): boolean {
  return session.status === "failed" && Boolean(session.failureHandled);
}

/**
 * A failed session the person should still review: unread, and its failure
 * not consumed by a parent agent. Matches the server's
 * `treeStats.unreadFailedDescendants`.
 */
export function needsFailureReview(
  session: Pick<Session, "status" | "unread" | "failureHandled">,
): boolean {
  return session.status === "failed" && Boolean(session.unread) && !failureHandledByAgent(session);
}
