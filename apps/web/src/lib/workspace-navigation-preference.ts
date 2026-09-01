const WORKSPACE_NAVIGATION_PREFERENCE_VERSION = 1;
const MAX_WORKSPACE_ID_LENGTH = 256;

type WorkspaceNavigationStorage = Pick<Storage, "getItem" | "setItem">;

export type RootWorkspaceSearch = {
  workspaceId?: string;
};

export function workspaceNavigationPreferenceStorageId(subjectId: string): string {
  return [
    "og.workspace.navigation",
    `v${WORKSPACE_NAVIGATION_PREFERENCE_VERSION}`,
    encodeURIComponent(subjectId),
  ].join(":");
}

export function parseRootWorkspaceSearch(search: Record<string, unknown>): RootWorkspaceSearch {
  const workspaceId = boundedWorkspaceId(search.workspaceId);
  return workspaceId ? { workspaceId } : {};
}

export function readLastWorkspaceId(
  preferenceStorageId: string,
  storage: WorkspaceNavigationStorage | null = browserStorage(),
): string | null {
  if (!storage) return null;
  try {
    return boundedWorkspaceId(storage.getItem(preferenceStorageId));
  } catch {
    return null;
  }
}

export function writeLastWorkspaceId(
  preferenceStorageId: string,
  workspaceId: string,
  storage: WorkspaceNavigationStorage | null = browserStorage(),
): void {
  if (!storage || !boundedWorkspaceId(workspaceId)) return;
  try {
    storage.setItem(preferenceStorageId, workspaceId);
  } catch {
    // Navigation remains URL-authoritative when storage is blocked or full.
  }
}

export function isAuthorizedWorkspaceId(
  workspaceId: string | null | undefined,
  listedWorkspaceIds: readonly string[],
  grantedWorkspaceIds: readonly string[],
): workspaceId is string {
  return Boolean(
    workspaceId &&
    (listedWorkspaceIds.includes(workspaceId) || grantedWorkspaceIds.includes(workspaceId)),
  );
}

export function resolveLandingWorkspaceId(input: {
  requestedWorkspaceId?: string | null;
  rememberedWorkspaceId?: string | null;
  defaultWorkspaceId?: string | null;
  listedWorkspaceIds: readonly string[];
  grantedWorkspaceIds: readonly string[];
}): string | null {
  if (
    isAuthorizedWorkspaceId(
      input.requestedWorkspaceId,
      input.listedWorkspaceIds,
      input.grantedWorkspaceIds,
    )
  ) {
    return input.requestedWorkspaceId;
  }
  if (
    isAuthorizedWorkspaceId(
      input.rememberedWorkspaceId,
      input.listedWorkspaceIds,
      input.grantedWorkspaceIds,
    )
  ) {
    return input.rememberedWorkspaceId;
  }
  return (
    input.defaultWorkspaceId ?? input.listedWorkspaceIds[0] ?? input.grantedWorkspaceIds[0] ?? null
  );
}

function boundedWorkspaceId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_WORKSPACE_ID_LENGTH
    ? value
    : null;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
