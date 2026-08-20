export type WorkspaceTransitionIdentity = {
  workspaceId: string | null;
  revision: number;
};

export type WorkspaceOperationIdentity = {
  id: number;
  transition: WorkspaceTransitionIdentity;
};

export function beginWorkspaceTransition(
  current: WorkspaceTransitionIdentity,
  workspaceId: string,
): { identity: WorkspaceTransitionIdentity; changed: boolean } {
  if (current.workspaceId === workspaceId) {
    return { identity: current, changed: false };
  }
  return {
    identity: { workspaceId, revision: current.revision + 1 },
    changed: true,
  };
}

export function invalidateWorkspaceTransition(
  current: WorkspaceTransitionIdentity,
): WorkspaceTransitionIdentity {
  return { workspaceId: null, revision: current.revision + 1 };
}

export function ownsWorkspaceTransition(
  current: WorkspaceTransitionIdentity,
  accepted: WorkspaceTransitionIdentity,
  workspaceId: string,
): boolean {
  return (
    current.workspaceId === workspaceId &&
    accepted.workspaceId === workspaceId &&
    current.revision === accepted.revision
  );
}

export function beginWorkspaceOperation(
  previousSequence: number,
  transition: WorkspaceTransitionIdentity,
): { sequence: number; operation: WorkspaceOperationIdentity } {
  const sequence = previousSequence + 1;
  return { sequence, operation: { id: sequence, transition } };
}

export function ownsWorkspaceOperation(
  active: WorkspaceOperationIdentity | null,
  currentTransition: WorkspaceTransitionIdentity,
  operation: WorkspaceOperationIdentity,
  workspaceId: string,
): boolean {
  return (
    active?.id === operation.id &&
    ownsWorkspaceTransition(currentTransition, operation.transition, workspaceId)
  );
}

export function settleWorkspaceOperation(
  active: WorkspaceOperationIdentity | null,
  operation: WorkspaceOperationIdentity,
): { active: WorkspaceOperationIdentity | null; settledCurrent: boolean } {
  if (active?.id !== operation.id) {
    return { active, settledCurrent: false };
  }
  return { active: null, settledCurrent: true };
}

/**
 * Resolve or reject one non-abortable request only while its route-owned
 * generation is current. A stale rejection becomes an inert null result so a
 * caller cannot surface the previous workspace's failure after transition.
 */
export async function runCurrentWorkspaceRequest<T>(input: {
  signal?: AbortSignal | undefined;
  requestId: number;
  currentRequestId: () => number;
  request: () => Promise<T>;
}): Promise<T | null> {
  try {
    const value = await input.request();
    return input.signal?.aborted || input.currentRequestId() !== input.requestId ? null : value;
  } catch (error) {
    if (input.signal?.aborted || input.currentRequestId() !== input.requestId) {
      return null;
    }
    throw error;
  }
}
