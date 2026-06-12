// Pure helpers behind the workspace switcher's create/rename affordances.
import { hasAccountPermission } from "@/lib/permissions";
import type { AccessContext, Workspace } from "@/types";

/** Sentinel <option> value for the "New workspace…" entry in the switcher. */
export const CREATE_WORKSPACE_OPTION = "__create-workspace__";

/**
 * The account a new workspace would be created under: prefer the account of
 * the active workspace, then the subject's default account, then any account
 * grant that can create workspaces. Null when the subject cannot create one
 * anywhere — the affordance hides instead of failing on submit.
 */
export function workspaceCreationAccountId(context: AccessContext, activeAccountId: string | null): string | null {
  for (const candidate of [activeAccountId, context.defaultAccountId]) {
    if (candidate && hasAccountPermission(context, candidate, "workspace:create")) {
      return candidate;
    }
  }
  return context.accountGrants.find((grant) =>
    grant.permissions.includes("workspace:create") || grant.permissions.includes("account:admin"),
  )?.accountId ?? null;
}

/** Replace-or-append a workspace in the cached list (create + rename share it). */
export function upsertWorkspace(workspaces: Workspace[], workspace: Workspace): Workspace[] {
  if (workspaces.some((candidate) => candidate.id === workspace.id)) {
    return workspaces.map((candidate) => (candidate.id === workspace.id ? workspace : candidate));
  }
  return [...workspaces, workspace];
}
