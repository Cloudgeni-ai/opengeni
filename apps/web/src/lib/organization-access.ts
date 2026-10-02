/*
 * Organization access in product words: what an organization API key or a
 * connected agent can do (Read only, Full access, Custom), where (every
 * workspace including new ones, or selected ones) and as whom (the person who
 * connected it, or the organization).
 *
 * The shapes mirror `OrganizationAccessPolicy` in @opengeni/contracts
 * (organization-access.ts). The server is the authority; these helpers only
 * label and preset what a person picks.
 */

import { permissionLabel, WORKSPACE_KEY_PERMISSION_GROUPS } from "@/lib/api-key-presets";

export type OrganizationAccessPreset = "read_only" | "full" | "custom";

export type OrganizationWorkspaceScope =
  | { kind: "all" }
  | { kind: "selected"; workspaceIds: string[] };

export type OrganizationAccessPolicy = {
  preset: OrganizationAccessPreset;
  permissions: string[];
  workspaceScope: OrganizationWorkspaceScope;
};

/** Who the agent acts as: the person who connected it, or the organization. */
export type OrganizationActor = "user" | "organization";

/** Organization-wide scopes first, then everything a workspace key can carry. */
export const ORGANIZATION_PERMISSION_GROUPS: ReadonlyArray<{
  label: string;
  permissions: readonly string[];
}> = [
  {
    label: "Organization",
    permissions: [
      "account:read",
      "account:admin",
      "workspace:create",
      "billing:read",
      "billing:manage",
      "usage_allowances:manage",
    ],
  },
  ...WORKSPACE_KEY_PERMISSION_GROUPS,
];

const READ_ONLY_PERMISSIONS = new Set<string>([
  "account:read",
  "billing:read",
  "workspace:read",
  "sessions:read",
  "stream:view",
  "files:read",
  "documents:search",
  "artifacts:read",
  "connections:read",
  "variable-sets:list",
  "secrets:list",
  "enrollments:read",
]);

export function allOrganizationPermissions(): string[] {
  return ORGANIZATION_PERMISSION_GROUPS.flatMap((group) => [...group.permissions]);
}

export function presetPermissions(preset: Exclude<OrganizationAccessPreset, "custom">): string[] {
  const all = allOrganizationPermissions();
  return preset === "full"
    ? all
    : all.filter((permission) => READ_ONLY_PERMISSIONS.has(permission));
}

/** The preset these permissions match exactly, or custom. */
export function presetFor(permissions: readonly string[]): OrganizationAccessPreset {
  const wanted = new Set(permissions);
  for (const preset of ["full", "read_only"] as const) {
    const expected = presetPermissions(preset);
    if (expected.length === wanted.size && expected.every((permission) => wanted.has(permission)))
      return preset;
  }
  return "custom";
}

/** True when nothing in the set can start, change or delete anything. */
export function isReadOnly(permissions: readonly string[]): boolean {
  return permissions.every((permission) => READ_ONLY_PERMISSIONS.has(permission));
}

export const ACCESS_PRESET_COPY: Record<
  OrganizationAccessPreset,
  { label: string; description: string }
> = {
  read_only: {
    label: "Read only",
    description:
      "See sessions, files, knowledge and settings. Can't start, change or delete anything.",
  },
  full: {
    label: "Full access",
    description:
      "Everything a person with full access can do, including managing people, keys, billing and secret values.",
  },
  custom: {
    label: "Custom",
    description: "Pick exactly what it can do.",
  },
};

export function countLabel(count: number): string {
  return `${count} ${count === 1 ? "permission" : "permissions"}`;
}

/** "Full access", "Read only" or "Custom · 6 permissions". */
export function accessSummary(permissions: readonly string[]): string {
  const preset = presetFor(permissions);
  if (preset === "custom") return `Custom · ${countLabel(permissions.length)}`;
  return ACCESS_PRESET_COPY[preset].label;
}

/** The saved choice in words; a preset stays its name even when capped by a person's access. */
export function policySummary(policy: OrganizationAccessPolicy): string {
  if (policy.preset === "custom") return `Custom · ${countLabel(policy.permissions.length)}`;
  return ACCESS_PRESET_COPY[policy.preset].label;
}

/** "All workspaces", "Design preview" or "3 workspaces". */
export function scopeSummary(
  scope: OrganizationWorkspaceScope,
  workspaces: readonly { id: string; name: string }[] | null,
): string {
  if (scope.kind === "all") return "All workspaces";
  if (scope.workspaceIds.length === 1) {
    const only = workspaces?.find((workspace) => workspace.id === scope.workspaceIds[0]);
    if (only) return only.name;
  }
  return `${scope.workspaceIds.length} ${scope.workspaceIds.length === 1 ? "workspace" : "workspaces"}`;
}

/** "Acts as Maja Berg" or "Acts as the organization". */
export function actorSummary(actor: OrganizationActor, names: { person: string }): string {
  return `Acts as ${actor === "user" ? names.person : "the organization"}`;
}

export { permissionLabel };

const EXTRA_LABELS: Record<string, string> = {
  "usage_allowances:manage": "Set workspace budgets",
};

/** Product label for any organization or workspace permission. */
export function organizationPermissionLabel(permission: string): string {
  return EXTRA_LABELS[permission] ?? permissionLabel(permission);
}

/** Why a policy can't be saved yet, or null. */
export function policyBlockedReason(policy: OrganizationAccessPolicy): string | null {
  if (policy.permissions.length === 0) return "Pick at least one permission.";
  if (policy.workspaceScope.kind === "selected" && policy.workspaceScope.workspaceIds.length === 0)
    return "Choose at least one workspace.";
  return null;
}

export const DEFAULT_POLICY: OrganizationAccessPolicy = {
  preset: "read_only",
  permissions: presetPermissions("read_only"),
  workspaceScope: { kind: "all" },
};
