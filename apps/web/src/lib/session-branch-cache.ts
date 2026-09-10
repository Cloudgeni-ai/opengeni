import type { Session } from "@/types";

import { mergeSessionForRail } from "./sessions-group";

export type SessionBranchPage = {
  sessions: Session[];
  /** Per-row causal generations for rows returned by accepted branch reads. */
  channelGenerations: ReadonlyMap<string, number>;
  nextCursor: string | null;
  loading: boolean;
  /** Whether this load cycle may paint loading or retry feedback in the tree. */
  feedbackVisible: boolean;
  failed: boolean;
  stale: boolean;
  requestId: number | null;
  retryCursor: string | null;
};

export type SessionBranchSummaryDecision = {
  acknowledge: boolean;
  refresh: boolean;
  markStale: boolean;
};

/**
 * Stable summary of the server-owned descendant facts that make an already
 * loaded branch stale. Child creation changes direct/total counts; lifecycle
 * changes advance the status aggregates. Title/content stays owned by the
 * child page or active route projection.
 */
export function sessionBranchSummaryKey(session: Session, readRevision = 0): string {
  const stats = session.treeStats;
  if (!stats) return `${session.id}:${session.updatedAt}:unknown:${readRevision}`;
  return [
    readRevision,
    session.id,
    session.updatedAt,
    stats.directChildren,
    stats.totalDescendants,
    stats.runningDescendants,
    stats.queuedDescendants,
    stats.attentionDescendants,
    stats.pausedDescendants,
    stats.failedDescendants,
    stats.unreadFailedDescendants ?? stats.failedDescendants,
    stats.unreadDescendants ?? 0,
    stats.activelyWorkingDescendants ?? 0,
    stats.attentionSince ?? "",
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
    const cached = sessions[index]!;
    const merged = mergeSessionForRail(cached, child);
    nextSessions[index] = page?.channelGenerations.has(child.id)
      ? { ...merged, channelId: cached.channelId ?? null }
      : merged;
  }
  return new Map(pages).set(parentSessionId, {
    sessions: nextSessions,
    channelGenerations: page?.channelGenerations ?? new Map(),
    nextCursor: page?.nextCursor ?? null,
    loading: page?.loading ?? false,
    feedbackVisible: page?.feedbackVisible ?? false,
    failed: page?.failed ?? false,
    stale: page?.stale ?? false,
    requestId: page?.requestId ?? null,
    retryCursor: page?.retryCursor ?? null,
  });
}

/** Mark one exact branch request active without discarding loaded children. */
export function beginSessionBranchRequest(
  pages: ReadonlyMap<string, SessionBranchPage>,
  parentSessionId: string,
  requestId: number,
  cursor?: string,
  options: { feedbackVisible?: boolean | undefined } = {},
): ReadonlyMap<string, SessionBranchPage> {
  const previous = pages.get(parentSessionId);
  return new Map(pages).set(parentSessionId, {
    sessions: previous?.sessions ?? [],
    channelGenerations: previous?.channelGenerations ?? new Map(),
    nextCursor: previous?.nextCursor ?? null,
    loading: true,
    feedbackVisible: options.feedbackVisible ?? true,
    failed: false,
    stale: false,
    requestId,
    retryCursor: cursor ?? null,
  });
}

/** Refresh the already-loaded window with bounded, opaque-cursor reads. */
export async function readLoadedSessionBranchWindow(
  readPage: (
    cursor?: string,
  ) => Promise<{ sessions: Session[]; pinned: Session[]; nextCursor: string | null }>,
  minimumCount: number,
  initialCursor?: string,
): Promise<{ sessions: Session[]; nextCursor: string | null }> {
  const sessions = new Map<string, Session>();
  const seen = new Set<string>();
  let cursor = initialCursor;
  for (let reads = 0; reads <= Math.max(1, minimumCount); reads += 1) {
    const page = await readPage(cursor);
    for (const session of [...page.sessions, ...page.pinned]) sessions.set(session.id, session);
    if (!page.nextCursor || sessions.size >= minimumCount) {
      return { sessions: [...sessions.values()], nextCursor: page.nextCursor };
    }
    if (seen.has(page.nextCursor)) throw new Error("Child pagination cursor repeated");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("Child pagination made no progress");
}

/** Commit one server child page or a fully refreshed loaded window. */
export function commitSessionBranchPage(
  pages: ReadonlyMap<string, SessionBranchPage>,
  parentSessionId: string,
  input: { sessions: readonly Session[]; nextCursor: string | null },
  options: {
    append?: boolean;
    replaceWindow?: boolean;
    preserve?: readonly Session[] | undefined;
    requestId?: number;
    readGeneration?: number;
  } = {},
): ReadonlyMap<string, SessionBranchPage> {
  const previous = pages.get(parentSessionId);
  if (options.requestId !== undefined && previous?.requestId !== options.requestId) return pages;
  const merged = new Map<string, Session>();
  const channelGenerations = options.append
    ? new Map(previous?.channelGenerations ?? [])
    : new Map<string, number>();
  if (options.append) {
    for (const session of [
      ...(previous?.sessions ?? []),
      ...(options.preserve ?? []),
      ...input.sessions,
    ]) {
      merged.set(session.id, session);
    }
  } else {
    // A refreshed first page owns the leading order. Retain already-loaded
    // tail entries (including an active child outside the first 50) behind it.
    for (const session of input.sessions) merged.set(session.id, session);
    for (const session of [
      ...(options.replaceWindow ? [] : (previous?.sessions ?? [])),
      ...(options.preserve ?? []),
    ]) {
      if (!merged.has(session.id)) merged.set(session.id, session);
    }
  }
  const readGeneration = options.readGeneration ?? 0;
  if (readGeneration > 0) {
    for (const session of input.sessions) {
      channelGenerations.set(session.id, readGeneration);
    }
  }
  return new Map(pages).set(parentSessionId, {
    sessions: [...merged.values()],
    channelGenerations,
    nextCursor: input.nextCursor,
    loading: false,
    feedbackVisible: false,
    failed: false,
    stale: false,
    requestId: null,
    retryCursor: null,
  });
}

/** Current branch rows that may own channel filing, with their actual read starts. */
export function authoritativeSessionBranchChannels(
  page: SessionBranchPage,
): Array<readonly [session: Session, readGeneration: number]> {
  const byId = new Map(page.sessions.map((session) => [session.id, session]));
  const evidence: Array<readonly [session: Session, readGeneration: number]> = [];
  for (const [sessionId, readGeneration] of page.channelGenerations) {
    const session = byId.get(sessionId);
    if (session && readGeneration > 0) evidence.push([session, readGeneration]);
  }
  return evidence;
}

/** Fail only the still-current request and expose its exact retry cursor. */
export function failSessionBranchRequest(
  pages: ReadonlyMap<string, SessionBranchPage>,
  parentSessionId: string,
  requestId: number,
): ReadonlyMap<string, SessionBranchPage> {
  const previous = pages.get(parentSessionId);
  if (!previous || previous.requestId !== requestId) return pages;
  return new Map(pages).set(parentSessionId, {
    ...previous,
    loading: false,
    // Background hydration may suppress transient loading feedback, but a
    // failure must become actionable instead of leaving the branch silently
    // incomplete for the rest of the active route.
    feedbackVisible: true,
    failed: true,
    stale: false,
    requestId: null,
  });
}

/** A fresh cached page already owns the active child's parent branch. */
export function sessionBranchNeedsHydration(page: SessionBranchPage | undefined): boolean {
  return page === undefined || page.failed || page.stale;
}

/** Decide whether a changed parent summary can be acknowledged right now. */
export function sessionBranchSummaryDecision(input: {
  previousKey: string | undefined;
  nextKey: string;
  loading: boolean;
  expanded: boolean;
  stale: boolean;
}): SessionBranchSummaryDecision {
  if (input.loading) {
    return {
      acknowledge: input.previousKey === input.nextKey,
      refresh: false,
      markStale: false,
    };
  }
  if (input.previousKey === undefined || input.previousKey === input.nextKey) {
    return { acknowledge: true, refresh: false, markStale: false };
  }
  return {
    acknowledge: true,
    refresh: input.expanded,
    markStale: !input.expanded && !input.stale,
  };
}
