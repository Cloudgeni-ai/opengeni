import type { AccessContext, Workspace } from "@/types";

import { workspaceSessionsPath } from "./routes";

export type RouteRecoveryLocation = Pick<Location, "pathname" | "search" | "hash">;

type WorkspaceGrant = AccessContext["workspaceGrants"][number];

const PORTABLE_WORKSPACE_DESTINATIONS: Readonly<
  Record<
    string,
    {
      anyWorkspacePermissions?: readonly string[];
      allWorkspacePermissions?: readonly string[];
    }
  >
> = {
  sessions: { anyWorkspacePermissions: ["sessions:read"] },
  agents: { anyWorkspacePermissions: ["sessions:read"] },
  priority: { anyWorkspacePermissions: ["sessions:read"] },
  "variable-sets": {
    allWorkspacePermissions: ["variable-sets:list", "secrets:list"],
  },
  rigs: { anyWorkspacePermissions: ["rigs:use"] },
  machines: { anyWorkspacePermissions: ["enrollments:read"] },
  capabilities: { anyWorkspacePermissions: ["connections:read"] },
  schedules: {
    anyWorkspacePermissions: ["scheduled_tasks:manage", "scheduled_tasks:run"],
  },
  documents: { anyWorkspacePermissions: ["documents:search", "documents:manage"] },
  memory: { anyWorkspacePermissions: ["workspace:read"] },
  state: { anyWorkspacePermissions: ["workspace:read"] },
  artifacts: { anyWorkspacePermissions: ["artifacts:read"] },
  settings: { anyWorkspacePermissions: ["workspace:read"] },
};

function grantAllows(
  grant: WorkspaceGrant,
  requirement: (typeof PORTABLE_WORKSPACE_DESTINATIONS)[string],
): boolean {
  if (grant.permissions.includes("workspace:admin")) return true;
  const has = (permission: string) =>
    grant.permissions.some((grantedPermission) => grantedPermission === permission);
  return (
    (requirement.allWorkspacePermissions?.every(has) ?? true) &&
    (requirement.anyWorkspacePermissions?.some(has) ?? true)
  );
}

function portableSuffix(pathname: string): string | null {
  const match = /^\/workspaces\/[^/]+\/?(.*)$/u.exec(pathname);
  if (!match) return null;
  const suffix = match[1] ?? "";
  if (!suffix) return "sessions";
  const segments = suffix.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  return PORTABLE_WORKSPACE_DESTINATIONS[segments[0] ?? ""] ? segments[0]! : null;
}

export function workspaceSessionIdFromPath(pathname: string): string | null {
  const match = /^\/workspaces\/[^/]+\/sessions\/([^/]+)\/?$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Choose an equivalent route only from the intersection of the current
 * server-authorized workspace list and current principal grants. Resource
 * detail ids are never carried across workspaces because their authority is
 * not portable.
 */
export function resolveAuthorizedWorkspaceFallback(input: {
  requestedWorkspaceId: string;
  location: RouteRecoveryLocation;
  workspaces: readonly Workspace[];
  accessContext: AccessContext;
}): { workspaceId: string; target: string } | null {
  const suffix = portableSuffix(input.location.pathname);
  if (!suffix || suffix === "organization") return null;
  const requirement = PORTABLE_WORKSPACE_DESTINATIONS[suffix];
  if (!requirement) return null;

  const authorized = input.workspaces.filter((workspace) => {
    if (workspace.id === input.requestedWorkspaceId) return false;
    const grant = input.accessContext.workspaceGrants.find(
      (candidate) =>
        candidate.workspaceId === workspace.id &&
        candidate.accountId === workspace.accountId &&
        candidate.subjectId === input.accessContext.subjectId,
    );
    return grant ? grantAllows(grant, requirement) : false;
  });
  const targetWorkspace =
    authorized.find((workspace) => workspace.id === input.accessContext.defaultWorkspaceId) ??
    authorized[0] ??
    null;
  if (!targetWorkspace) return null;

  const targetPath =
    suffix === "sessions"
      ? workspaceSessionsPath(targetWorkspace.id)
      : `/workspaces/${encodeURIComponent(targetWorkspace.id)}/${suffix}`;
  return {
    workspaceId: targetWorkspace.id,
    target: `${targetPath}${input.location.search}${input.location.hash}`,
  };
}
