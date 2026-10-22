// The "needs a human" predicate for ROOT sessions and the rail's "Needs you"
// view built on it. A leaf module: it depends on nothing beyond the Session
// type so the always-loaded rail can import it without pulling more code into
// the startup bundle.
import type { RailSession as Session } from "./session-list-entry";

/**
 * `requires_action` that a person can act on. A session the runtime could not
 * start (it carries an admission block) reads as Stuck with its own Retry, so
 * it is not counted as waiting on the person.
 */
export function awaitsPerson(session: Session): boolean {
  return (
    session.status === "requires_action" &&
    (session.admissionBlock === undefined || session.admissionBlock === null)
  );
}

/**
 * True when the root itself is blocked on a human (approval/input requested,
 * or failed), or any spawned descendant is (`attentionDescendants`).
 */
export function rootNeedsYou(session: Session): boolean {
  if (session.parentSessionId !== null) return false;
  if (awaitsPerson(session) || session.status === "failed") return true;
  return (session.treeStats?.attentionDescendants ?? 0) > 0;
}

/** How many loaded, unarchived workstreams need the person. */
export function countNeedsYou(sessions: readonly Session[]): number {
  return sessions.filter((session) => !session.archived && rootNeedsYou(session)).length;
}

/**
 * The rows of the "Needs you" view: every workstream (root) that needs a human,
 * with its spawned agents so a parent keeps showing the sub-agent that is
 * waiting. A flat projection (search) can hold a child without its root, so a
 * child that itself needs a human is kept on its own.
 */
export function filterNeedsYou<T extends Session>(sessions: readonly T[]): T[] {
  const roots = new Set<string>();
  for (const session of sessions) {
    if (rootNeedsYou(session)) roots.add(session.id);
  }
  return sessions.filter(
    (session) =>
      roots.has(session.rootSessionId) ||
      (session.parentSessionId !== null && (awaitsPerson(session) || session.status === "failed")),
  );
}
