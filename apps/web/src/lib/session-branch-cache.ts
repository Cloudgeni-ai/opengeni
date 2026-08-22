import type { Session } from "@/types";

import { mergeSessionForRail } from "./sessions-group";

export type SessionBranchPage = {
  sessions: Session[];
  nextCursor: string | null;
  loading: boolean;
  failed: boolean;
  stale: boolean;
};

/**
 * Stable summary of the server-owned descendant facts that make an already
 * loaded branch stale. Child creation changes direct/total counts; lifecycle
 * changes advance the status aggregates. Title/content stays owned by the
 * child page or active route projection.
 */
export function sessionBranchSummaryKey(session: Session): string {
  const stats = session.treeStats;
  if (!stats) return `${session.id}:${session.updatedAt}:unknown`;
  return [
    session.id,
    session.updatedAt,
    stats.directChildren,
    stats.totalDescendants,
    stats.runningDescendants,
    stats.queuedDescendants,
    stats.attentionDescendants,
    stats.pausedDescendants,
    stats.failedDescendants,
    stats.unreadDescendants ?? 0,
    stats.activelyWorkingDescendants ?? 0,
    stats.truncated ? 1 : 0,
  ].join(":");
}

/**
 * Persist a route/lineage child in its already-loaded parent branch. The route
 * owns current lifecycle/content while a prior list row may own treeStats.
 */
export function upsertSessionBranchChild(
  pages: ReadonlyMap<string, SessionBranchPage>,
  child: Session,
): ReadonlyMap<string, SessionBranchPage> {
  const parentSessionId = child.parentSessionId;
  if (!parentSessionId) return pages;
  const page = pages.get(parentSessionId);
  const sessions = page?.sessions ?? [];
  const index = sessions.findIndex((session) => session.id === child.id);
  const nextSessions = [...sessions];
  if (index === -1) {
    nextSessions.push(child);
  } else {
    nextSessions[index] = mergeSessionForRail(sessions[index]!, child);
  }
  return new Map(pages).set(parentSessionId, {
    sessions: nextSessions,
    nextCursor: page?.nextCursor ?? null,
    loading: page?.loading ?? false,
    failed: page?.failed ?? false,
    stale: page?.stale ?? false,
  });
}

/** Commit one server child page into the existing branch state. */
export function commitSessionBranchPage(
  pages: ReadonlyMap<string, SessionBranchPage>,
  parentSessionId: string,
  input: { sessions: readonly Session[]; nextCursor: string | null },
  options: { append?: boolean; preserve?: readonly Session[] } = {},
): ReadonlyMap<string, SessionBranchPage> {
  const previous = pages.get(parentSessionId);
  const merged = new Map<string, Session>();
  for (const session of [
    ...(options.append ? (previous?.sessions ?? []) : []),
    ...(options.preserve ?? []),
    ...input.sessions,
  ]) {
    merged.set(session.id, session);
  }
  return new Map(pages).set(parentSessionId, {
    sessions: [...merged.values()],
    nextCursor: input.nextCursor,
    loading: false,
    failed: false,
    stale: false,
  });
}
