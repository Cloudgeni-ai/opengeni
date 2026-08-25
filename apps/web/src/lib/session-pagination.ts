import type { Session } from "@/types";

export type SessionPageIdentity = {
  key: string;
  generation: number;
};

export type SessionContinuationState = {
  generation: number;
  sessions: Session[];
  nextCursor: string | null | undefined;
  failed: boolean;
  /** Page-one read revision whose snapshot produced the retained cursor chain. */
  snapshotReadRevision: number;
  /** Rows fetched from that snapshot, excluding display-only rows retained from older snapshots. */
  authoritativeSessionIds: ReadonlySet<string>;
};

export function sessionPageKey(workspaceId: string, search: string): string {
  return `${workspaceId}\u0000${search}`;
}

/**
 * Advance the request generation whenever the workspace/query changes. The
 * integer matters in addition to the key: a delayed request for A must still be
 * rejected after the user visits A → B → A while it is in flight.
 */
export function advanceSessionPageIdentity(
  current: SessionPageIdentity,
  key: string,
): SessionPageIdentity {
  return current.key === key ? current : { key, generation: current.generation + 1 };
}

export function emptySessionContinuation(generation: number): SessionContinuationState {
  return {
    generation,
    sessions: [],
    nextCursor: undefined,
    failed: false,
    snapshotReadRevision: 0,
    authoritativeSessionIds: new Set(),
  };
}

export function activeSessionContinuation(
  state: SessionContinuationState,
  activeGeneration: number,
): SessionContinuationState {
  return state.generation === activeGeneration ? state : emptySessionContinuation(activeGeneration);
}

/** Merge a continuation only when it belongs to the still-active query. */
export function mergeSessionContinuation(
  state: SessionContinuationState,
  activeGeneration: number,
  requestGeneration: number,
  page: { sessions: Session[]; nextCursor: string | null },
  snapshotReadRevision: number,
): SessionContinuationState {
  if (requestGeneration !== activeGeneration) {
    return state;
  }
  const active = activeSessionContinuation(state, activeGeneration);
  const rows = new Map(active.sessions.map((session) => [session.id, session]));
  const authoritativeSessionIds =
    active.snapshotReadRevision === snapshotReadRevision
      ? new Set(active.authoritativeSessionIds)
      : new Set<string>();
  for (const session of page.sessions) rows.set(session.id, session);
  for (const session of page.sessions) authoritativeSessionIds.add(session.id);
  return {
    generation: activeGeneration,
    sessions: [...rows.values()],
    nextCursor: page.nextCursor,
    failed: false,
    snapshotReadRevision,
    authoritativeSessionIds,
  };
}

/** Current-snapshot continuation rows that may still own mutable list projections. */
export function authoritativeSessionContinuation(
  state: SessionContinuationState,
  activeGeneration: number,
  currentReadRevision: number,
): Session[] {
  const active = activeSessionContinuation(state, activeGeneration);
  if (active.snapshotReadRevision !== currentReadRevision) return [];
  return active.sessions.filter((session) => active.authoritativeSessionIds.has(session.id));
}

/**
 * Persist a causally fresh detail channel onto a display-only retained row.
 * Current-snapshot list evidence remains authoritative and is never rewritten.
 */
export function reconcileRetainedSessionContinuationChannel(
  state: SessionContinuationState,
  activeGeneration: number,
  currentReadRevision: number,
  projected: Pick<Session, "id" | "workspaceId" | "channelId"> | null,
): SessionContinuationState {
  if (!projected || state.generation !== activeGeneration) return state;
  if (
    state.snapshotReadRevision === currentReadRevision &&
    state.authoritativeSessionIds.has(projected.id)
  ) {
    return state;
  }
  const index = state.sessions.findIndex(
    (session) => session.id === projected.id && session.workspaceId === projected.workspaceId,
  );
  if (index === -1) return state;
  const current = state.sessions[index]!;
  const channelId = projected.channelId ?? null;
  if ((current.channelId ?? null) === channelId) return state;
  const sessions = [...state.sessions];
  sessions[index] = { ...current, channelId };
  return { ...state, sessions };
}

/**
 * Rebase retained rows onto a fresh first-page snapshot after the server says
 * the previous cursor expired. Delayed rebases are fenced like ordinary page
 * merges so an A → B → A query transition cannot revive an obsolete cursor.
 */
export function rebaseSessionContinuation(
  state: SessionContinuationState,
  activeGeneration: number,
  requestGeneration: number,
  nextCursor: string | null,
  snapshotReadRevision: number,
): SessionContinuationState {
  if (requestGeneration !== activeGeneration) return state;
  const active = activeSessionContinuation(state, activeGeneration);
  return {
    ...active,
    nextCursor,
    failed: false,
    snapshotReadRevision,
    authoritativeSessionIds: new Set(),
  };
}
