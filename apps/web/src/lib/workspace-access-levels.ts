import {
  workspaceAccessLevels,
  type WorkspaceAccessLevel,
  type WorkspaceAccessLevelDefinition,
} from "./permissions";

/**
 * Merge the server's named-role catalog over the client fallback, per role, so
 * a partial or missing server catalog never drops an assignable role.
 */
export function resolveWorkspaceAccessLevels(
  serverRoles: ReadonlyArray<WorkspaceAccessLevelDefinition> | null | undefined,
): ReadonlyArray<WorkspaceAccessLevelDefinition> {
  if (!serverRoles || serverRoles.length === 0) return workspaceAccessLevels;
  return workspaceAccessLevels.map(
    (fallback) => serverRoles.find((role) => role.role === fallback.role) ?? fallback,
  );
}

/** What a member's stored grant means: a named role, the workspace owner, or custom. */
export function workspaceMemberAccessRole(
  member: { role: string; permissions: readonly string[] },
  levels: ReadonlyArray<WorkspaceAccessLevelDefinition>,
): WorkspaceAccessLevel | "owner" | "custom" {
  if (member.role === "owner") return "owner";
  const granted = new Set(member.permissions);
  const level = levels.find(
    (candidate) =>
      candidate.role === member.role &&
      new Set(candidate.permissions).size === granted.size &&
      candidate.permissions.every((permission) => granted.has(permission)),
  );
  return level?.role ?? "custom";
}
