import { Permission } from "@opengeni/contracts";

import type { AccessContext } from "@/types";

const permissionGroupAssignments: Record<Permission, string> = {
  "workspace:read": "Workspace",
  "workspace:create": "Workspace",
  "sessions:create": "Sessions",
  "sessions:read": "Sessions",
  "sessions:control": "Sessions",
  "stream:view": "Sessions",
  "stream:control": "Sessions",
  "stream:acknowledge": "Sessions",
  "terminal:attach": "Sessions",
  "toolspace:call": "Sessions",
  "files:upload": "Files & documents",
  "files:read": "Files & documents",
  "files:write": "Files & documents",
  "documents:manage": "Files & documents",
  "documents:search": "Files & documents",
  "scheduled_tasks:manage": "Scheduled tasks",
  "scheduled_tasks:run": "Scheduled tasks",
  "environments:manage": "Variable sets",
  "environments:use": "Variable sets",
  "variable-sets:manage": "Variable sets",
  "variable-sets:use": "Variable sets",
  "mcp_servers:attach": "Sessions",
  "github:manage": "GitHub",
  "github:use": "GitHub",
  "goals:manage": "Goals",
  "rigs:use": "Rigs",
  "rigs:manage": "Rigs",
  "enrollments:read": "Machines",
  "enrollments:manage": "Machines",
  "workspace:admin": "Admin & account",
  "api_keys:manage": "Admin & account",
  "connections:read": "Connections",
  "connections:write": "Connections",
  "members:manage": "Admin & account",
  "account:read": "Admin & account",
  "account:admin": "Admin & account",
  "billing:read": "Admin & account",
  "billing:manage": "Admin & account",
};

const permissionGroupOrder = [
  "Workspace",
  "Sessions",
  "Files & documents",
  "Scheduled tasks",
  "Variable sets",
  "Connections",
  "Machines",
  "GitHub",
  "Goals",
  "Rigs",
  "Admin & account",
];

export type PermissionGroup = { label: string; permissions: Permission[] };

// Derived from the contracts Permission enum so pickers can never drift from
// the API again: every enum value lands in exactly one group.
export function buildApiKeyPermissionGroups(): PermissionGroup[] {
  const groups: PermissionGroup[] = [];
  for (const permission of Permission.options) {
    const label = permissionGroupAssignments[permission] ?? "Other";
    const group = groups.find((candidate) => candidate.label === label);
    if (group) {
      group.permissions.push(permission);
    } else {
      groups.push({ label, permissions: [permission] });
    }
  }
  const rank = (label: string): number => {
    const index = permissionGroupOrder.indexOf(label);
    return index === -1 ? permissionGroupOrder.length : index;
  };
  return groups.sort((a, b) => rank(a.label) - rank(b.label));
}

export const apiKeyPermissionGroups = buildApiKeyPermissionGroups();

// Mirrors the API's ensureDelegablePermissions: a workspace:admin grant can
// delegate everything, any other grant only its own permissions.
export function delegableApiKeyPermissions(grantPermissions: readonly string[]): Set<string> {
  if (grantPermissions.includes("workspace:admin")) {
    return new Set<string>(Permission.options);
  }
  return new Set<string>(Permission.options.filter((permission) => grantPermissions.includes(permission)));
}

export const defaultApiKeyPermissions = new Set<string>([
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "documents:search",
  "scheduled_tasks:run",
  "github:use",
]);

/**
 * Groups offered for a session's first-party MCP (OpenGeni tool) permission
 * scope — the same grouped idiom as the API key dialog. Account-level scopes
 * are excluded: a session's OpenGeni MCP only ever acts inside its workspace.
 */
export function buildSessionMcpPermissionGroups(): PermissionGroup[] {
  const accountOnly = new Set<string>(["account:read", "account:admin", "members:manage", "billing:read", "billing:manage", "workspace:create"]);
  const notFirstPartyMcp = new Set<string>(["toolspace:call"]);
  return buildApiKeyPermissionGroups()
    .map((group) => ({
      label: group.label,
      permissions: group.permissions.filter((permission) => !accountOnly.has(permission) && !notFirstPartyMcp.has(permission)),
    }))
    .filter((group) => group.permissions.length > 0);
}

export const sessionMcpPermissionGroups = buildSessionMcpPermissionGroups();

/**
 * Groups offered when editing a workspace member's permissions. Workspace
 * scopes only: the account-level scopes (billing, account admin, member
 * management, workspace creation) are granted on the organization, not on a
 * per-workspace membership row, so they are excluded here. `members:manage`
 * and `workspace:admin` stay (they are workspace-scoped membership powers).
 */
export function buildWorkspaceMemberPermissionGroups(): PermissionGroup[] {
  const accountOnly = new Set<string>(["account:read", "account:admin", "billing:read", "billing:manage", "workspace:create"]);
  return buildApiKeyPermissionGroups()
    .map((group) => ({
      label: group.label,
      permissions: group.permissions.filter((permission) => !accountOnly.has(permission)),
    }))
    .filter((group) => group.permissions.length > 0);
}

export const workspaceMemberPermissionGroups = buildWorkspaceMemberPermissionGroups();

/**
 * The default permission set for a newly-added workspace member: full
 * collaborator access minus the admin/management powers (which an admin grants
 * deliberately). Mirrors the API-key default set plus goals management.
 */
export const defaultWorkspaceMemberPermissions = new Set<string>([
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:use",
  "variable-sets:use",
  "goals:manage",
]);

export function hasWorkspacePermission(context: AccessContext | null, workspaceId: string, permission: string): boolean {
  const grant = context?.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  return Boolean(grant && (grant.permissions.includes(permission) || grant.permissions.includes("workspace:admin")));
}

export function hasAccountPermission(context: AccessContext | null, accountId: string, permission: string): boolean {
  const grant = context?.accountGrants.find((candidate) => candidate.accountId === accountId);
  return Boolean(grant && (grant.permissions.includes(permission) || grant.permissions.includes("account:admin")));
}
