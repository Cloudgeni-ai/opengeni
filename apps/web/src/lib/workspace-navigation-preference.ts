import type { AccessContext, Workspace } from "@/types";

import { authorizedWorkspaceFromList } from "./workspace-scope-context";

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

/**
 * The last workspace used in each organization, so switching organization
 * returns there. Browser-local, namespaced by subject like the landing
 * preference, and only a hint: callers validate it against the current list.
 */
export function organizationWorkspacePreferenceStorageId(subjectId: string): string {
  return [
    "og.workspace.navigation.organizations",
    `v${WORKSPACE_NAVIGATION_PREFERENCE_VERSION}`,
    encodeURIComponent(subjectId),
  ].join(":");
}

const MAX_REMEMBERED_ORGANIZATIONS = 50;

export function readLastWorkspaceIdsByOrganization(
  preferenceStorageId: string,
  storage: WorkspaceNavigationStorage | null = browserStorage(),
): Record<string, string> {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(preferenceStorageId) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const remembered: Record<string, string> = {};
    for (const [accountId, workspaceId] of Object.entries(parsed)) {
      const id = boundedWorkspaceId(workspaceId);
      if (boundedWorkspaceId(accountId) && id) remembered[accountId] = id;
    }
    return remembered;
  } catch {
    return {};
  }
}

export function writeLastWorkspaceIdForOrganization(
  preferenceStorageId: string,
  accountId: string,
  workspaceId: string,
  storage: WorkspaceNavigationStorage | null = browserStorage(),
): void {
  if (!storage || !boundedWorkspaceId(accountId) || !boundedWorkspaceId(workspaceId)) return;
  const remembered = readLastWorkspaceIdsByOrganization(preferenceStorageId, storage);
  if (remembered[accountId] === workspaceId) return;
  delete remembered[accountId];
  // Most recent last; the oldest organizations fall off past the bound.
  const entries = [...Object.entries(remembered), [accountId, workspaceId] as const].slice(
    -MAX_REMEMBERED_ORGANIZATIONS,
  );
  try {
    storage.setItem(preferenceStorageId, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Switching falls back to the organization's first workspace.
  }
}

export function isAuthorizedWorkspaceId(
  workspaceId: string | null | undefined,
  workspaces: readonly Workspace[],
  accessContext: AccessContext,
): workspaceId is string {
  return Boolean(
    workspaceId &&
    authorizedWorkspaceFromList({
      workspaceId,
      workspaces,
      accessContext,
    }),
  );
}

export function resolveLandingWorkspaceId(input: {
  requestedWorkspaceId?: string | null;
  rememberedWorkspaceId?: string | null;
  workspaces: readonly Workspace[];
  accessContext: AccessContext;
}): string | null {
  if (isAuthorizedWorkspaceId(input.requestedWorkspaceId, input.workspaces, input.accessContext)) {
    return input.requestedWorkspaceId;
  }
  if (isAuthorizedWorkspaceId(input.rememberedWorkspaceId, input.workspaces, input.accessContext)) {
    return input.rememberedWorkspaceId;
  }
  if (
    isAuthorizedWorkspaceId(
      input.accessContext.defaultWorkspaceId,
      input.workspaces,
      input.accessContext,
    )
  ) {
    return input.accessContext.defaultWorkspaceId;
  }
  return (
    input.workspaces.find((workspace) =>
      isAuthorizedWorkspaceId(workspace.id, input.workspaces, input.accessContext),
    )?.id ?? null
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
