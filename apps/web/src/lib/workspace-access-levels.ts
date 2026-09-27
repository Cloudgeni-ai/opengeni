import type { WorkspaceAccessLevel, WorkspaceAccessLevelDefinition } from "./permissions";

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
