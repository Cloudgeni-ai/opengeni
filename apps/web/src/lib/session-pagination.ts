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
  return { generation, sessions: [], nextCursor: undefined, failed: false };
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
): SessionContinuationState {
  if (requestGeneration !== activeGeneration) {
    return state;
  }
  const active = activeSessionContinuation(state, activeGeneration);
  const rows = new Map(active.sessions.map((session) => [session.id, session]));
  for (const session of page.sessions) rows.set(session.id, session);
  return {
    generation: activeGeneration,
    sessions: [...rows.values()],
    nextCursor: page.nextCursor,
    failed: false,
  };
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
): SessionContinuationState {
  if (requestGeneration !== activeGeneration) return state;
  const active = activeSessionContinuation(state, activeGeneration);
  return {
    ...active,
    nextCursor,
    failed: false,
  };
}
