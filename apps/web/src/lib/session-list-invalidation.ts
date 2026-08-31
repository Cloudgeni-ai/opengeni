export type SessionListInvalidation = {
  workspaceId: string;
  sessionId: string;
  archived?: boolean;
};

const listeners = new Set<(invalidation: SessionListInvalidation) => void>();

/**
 * Tell other mounted session-list consumers that a confirmed mutation changed
 * whether one root belongs in their current projection. Durable server state
 * remains authoritative; this is only a same-tab prompt to re-read it.
 */
export function notifySessionListChanged(invalidation: SessionListInvalidation): void {
  for (const listener of listeners) listener(invalidation);
}

export function subscribeToSessionListChanges(
  listener: (invalidation: SessionListInvalidation) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
