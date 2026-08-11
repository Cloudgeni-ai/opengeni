// Shared "needs a human" predicate for ROOT sessions. Deliberately a leaf
// module: it is imported by both the always-loaded rail badge and the lazy
// priority feed, so it must depend on nothing beyond the Session type or the
// bundler re-clusters the priority route's graph into the startup bundle.
import type { Session } from "../types";

/**
 * True when the root itself is blocked on a human (approval/input requested,
 * or failed), or any spawned descendant is (`attentionDescendants`). This is
 * the single source for the rail badge and the feed's blocked+broken count.
 */
export function rootNeedsYou(session: Session): boolean {
  if (session.parentSessionId !== null) return false;
  if (session.status === "requires_action" || session.status === "failed") return true;
  return (session.treeStats?.attentionDescendants ?? 0) > 0;
}
