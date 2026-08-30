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
  "codemode:call": "Sessions",
  "files:upload": "Files & documents",
  "files:read": "Files & documents",
  "files:write": "Files & documents",
  "documents:manage": "Files & documents",
  "documents:search": "Files & documents",
  "scheduled_tasks:manage": "Scheduled tasks",
  "scheduled_tasks:run": "Scheduled tasks",
  "environments:manage": "Variable sets",
  "environments:use": "Variable sets",
  "variable-sets:list": "Variable sets",
  "variable-sets:read": "Variable sets",
  "variable-sets:write": "Variable sets",
  "variable-sets:manage": "Variable sets",
  "variable-sets:attach": "Variable sets",
  "variable-sets:use": "Variable sets",
  "secrets:list": "Variable sets",
  "secrets:read": "Variable sets",
  "secrets:write": "Variable sets",
  "mcp_servers:attach": "Sessions",
  "github:manage": "GitHub",
  "github:use": "GitHub",
  "goals:manage": "Goals",
  "rigs:use": "Rigs",
  "rigs:manage": "Rigs",
  "artifacts:read": "Artifacts",
  "artifacts:publish": "Artifacts",
  "apps:read": "Apps",
  "apps:write": "Apps",
  "apps:publish": "Apps",
  "apps:run": "Apps",
  "apps:delete": "Apps",
  "enrollments:read": "Machines",
  "enrollments:manage": "Machines",
  "workspace:admin": "Admin & account",
  "api_keys:manage": "Admin & account",
  "connections:read": "Connections",
  "connections:write": "Connections",
  "capabilities:manage": "Connections",
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
  "Artifacts",
  "Apps",
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

// Lazy on purpose: this module lands in a shared chunk, and an eager
// module-scope `Permission.options` read crashes the whole chunk with a TDZ
// error whenever the bundler's chunk graph puts the contracts enum later in
// the evaluation order (adding a new lazy route re-clusters chunks and did
// exactly that). Computing on first use is immune to chunk-order changes.
let cachedApiKeyPermissionGroups: PermissionGroup[] | null = null;
export function apiKeyPermissionGroups(): PermissionGroup[] {
  cachedApiKeyPermissionGroups ??= buildApiKeyPermissionGroups();
  return cachedApiKeyPermissionGroups;
}

// Mirrors the API's ensureDelegablePermissions: a workspace:admin grant can
// delegate everything, any other grant only its own permissions.
export function delegableApiKeyPermissions(grantPermissions: readonly string[]): Set<string> {
  if (grantPermissions.includes("workspace:admin")) {
    return new Set<string>(
      Permission.options.filter(
        (permission) => permission !== "secrets:read" || grantPermissions.includes("secrets:read"),
      ),
    );
  }
  return new Set<string>(
    Permission.options.filter((permission) => grantPermissions.includes(permission)),
  );
}

export const fixedOrganizationApiKeyPermissions = [
  "account:read",
  "workspace:create",
  "workspace:read",
  "workspace:admin",
  "api_keys:manage",
] as const;

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
  const accountOnly = new Set<string>([
    "account:read",
    "account:admin",
    "members:manage",
    "billing:read",
    "billing:manage",
    "workspace:create",
  ]);
  const notFirstPartyMcp = new Set<string>(["codemode:call"]);
  return buildApiKeyPermissionGroups()
    .map((group) => ({
      label: group.label,
      permissions: group.permissions.filter(
        (permission) => !accountOnly.has(permission) && !notFirstPartyMcp.has(permission),
      ),
    }))
    .filter((group) => group.permissions.length > 0);
}

// Lazy for the same chunk-evaluation-order reason as apiKeyPermissionGroups.
let cachedSessionMcpPermissionGroups: PermissionGroup[] | null = null;
export function sessionMcpPermissionGroups(): PermissionGroup[] {
  cachedSessionMcpPermissionGroups ??= buildSessionMcpPermissionGroups();
  return cachedSessionMcpPermissionGroups;
}

/**
 * Groups offered when editing a workspace member's permissions. Workspace
 * scopes only: the account-level scopes (billing, account admin, member
 * management, workspace creation) are granted on the organization, not on a
 * per-workspace membership row, so they are excluded here. `members:manage`
 * and `workspace:admin` stay (they are workspace-scoped membership powers).
 */
export function buildWorkspaceMemberPermissionGroups(): PermissionGroup[] {
  const accountOnly = new Set<string>([
    "account:read",
    "account:admin",
    "billing:read",
    "billing:manage",
    "workspace:create",
  ]);
  // Membership itself is the workspace-access boundary. `workspace:read` is
  // the baseline capability that lets an admitted human discover and open the
  // workspace, so the organization editor includes it automatically instead
  // of presenting it as an optional fine-grained choice.
  const automaticBaseline = new Set<string>(["workspace:read"]);
  return buildApiKeyPermissionGroups()
    .map((group) => ({
      label: group.label,
      permissions: group.permissions.filter(
        (permission) => !accountOnly.has(permission) && !automaticBaseline.has(permission),
      ),
    }))
    .filter((group) => group.permissions.length > 0);
}

// Lazy for the same chunk-evaluation-order reason as apiKeyPermissionGroups.
let cachedWorkspaceMemberPermissionGroups: PermissionGroup[] | null = null;
export function workspaceMemberPermissionGroups(): PermissionGroup[] {
  cachedWorkspaceMemberPermissionGroups ??= buildWorkspaceMemberPermissionGroups();
  return cachedWorkspaceMemberPermissionGroups;
}

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
  "variable-sets:list",
  "variable-sets:read",
  "variable-sets:write",
  "variable-sets:attach",
  "variable-sets:use",
  "secrets:list",
  "secrets:write",
  "goals:manage",
]);

export type WorkspaceAccessLevel = "viewer" | "member" | "admin";

export const workspaceAccessLevels: ReadonlyArray<{
  role: WorkspaceAccessLevel;
  label: string;
  description: string;
  permissions: readonly string[];
}> = [
  {
    role: "viewer",
    label: "Viewer",
    description: "Can browse sessions and shared workspace content.",
    permissions: [
      "workspace:read",
      "sessions:read",
      "stream:view",
      "files:read",
      "documents:search",
      "variable-sets:list",
      "connections:read",
      "rigs:use",
      "artifacts:read",
    ],
  },
  {
    role: "member",
    label: "Member",
    description: "Can create sessions and work with the workspace's shared resources.",
    permissions: [...defaultWorkspaceMemberPermissions],
  },
  {
    role: "admin",
    label: "Workspace admin",
    description: "Can manage this workspace, including its members and integrations.",
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "stream:view",
      "stream:control",
      "stream:acknowledge",
      "terminal:attach",
      "codemode:call",
      "files:upload",
      "files:read",
      "files:write",
      "documents:manage",
      "documents:search",
      "scheduled_tasks:manage",
      "scheduled_tasks:run",
      "github:manage",
      "github:use",
      "api_keys:manage",
      "connections:read",
      "connections:write",
      "variable-sets:list",
      "variable-sets:read",
      "variable-sets:write",
      "variable-sets:manage",
      "variable-sets:attach",
      "variable-sets:use",
      "secrets:list",
      "secrets:write",
      "mcp_servers:attach",
      "goals:manage",
      "rigs:use",
      "rigs:manage",
      "enrollments:read",
      "enrollments:manage",
      "artifacts:read",
      "artifacts:publish",
    ],
  },
];

export function hasWorkspacePermission(
  context: AccessContext | null,
  workspaceId: string,
  permission: string,
): boolean {
  const grant = context?.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  return Boolean(
    grant &&
    (grant.permissions.includes(permission) ||
      (permission !== "secrets:read" && grant.permissions.includes("workspace:admin"))),
  );
}

/**
 * Browser-side projection of the API's current-human Apps authority boundary.
 *
 * Managed mode is proven by the separately authenticated self-context. Local
 * mode has no managed session, so it uses the exact canonical development
 * principal and grant provenance emitted by the local access resolver. The API
 * remains the authority for every request; this prevents the console from
 * hiding routes that the API intentionally permits or exposing controls to a
 * delegated/service-shaped grant.
 */
export function hasDirectHumanWorkspacePermission(
  context: AccessContext | null,
  managedSubjectId: string | null | undefined,
  workspaceId: string,
  permission: string,
): boolean {
  const grant = context?.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  if (!context || !grant || grant.subjectId !== context.subjectId) return false;
  const managedHuman =
    context.mode === "managed" &&
    managedSubjectId !== null &&
    managedSubjectId !== undefined &&
    managedSubjectId === context.subjectId;
  const localHuman =
    context.mode === "local" &&
    context.subjectId === "dev" &&
    grant.principalKind === "human_session" &&
    grant.metadata?.delegated !== true &&
    !grant.serviceInitiator;
  return (managedHuman || localHuman) && hasWorkspacePermission(context, workspaceId, permission);
}

export function hasAccountPermission(
  context: AccessContext | null,
  accountId: string,
  permission: string,
): boolean {
  const grant = context?.accountGrants.find((candidate) => candidate.accountId === accountId);
  return Boolean(
    grant &&
    (grant.permissions.includes(permission) || grant.permissions.includes("account:admin")),
  );
}
