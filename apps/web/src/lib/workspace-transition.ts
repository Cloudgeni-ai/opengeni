export type WorkspaceTransitionIdentity = {
  workspaceId: string | null;
  revision: number;
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
