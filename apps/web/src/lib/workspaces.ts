// Pure helpers behind the workspace switcher's create/rename affordances.
import { hasAccountPermission } from "@/lib/permissions";
import type { AccessContext, ClientConfig, Workspace } from "@/types";

/** Sentinel <option> value for the "New workspace…" entry in the switcher. */
export const CREATE_WORKSPACE_OPTION = "__create-workspace__";

/**
 * The account a new workspace would be created under: prefer the account of
 * the active workspace, then the subject's default account, then any account
 * grant that can create workspaces. Null when the subject cannot create one
 * anywhere — the affordance hides instead of failing on submit.
 */
export function workspaceCreationAccountId(
  context: AccessContext,
  activeAccountId: string | null,
): string | null {
  for (const candidate of [activeAccountId, context.defaultAccountId]) {
    if (candidate && hasAccountPermission(context, candidate, "workspace:create")) {
      return candidate;
    }
  }
  return (
    context.accountGrants.find(
      (grant) =>
        grant.permissions.includes("workspace:create") ||
        grant.permissions.includes("account:admin"),
    )?.accountId ?? null
  );
}

/**
 * Whether this person administers the organization: an owner or admin in a
 * session that may administer one (a signed-in person, or the single local
 * user). Administrators manage its workspaces, so this also decides whether the
 * picker's "New workspace in <organization>" is available. Kept here, in the
 * startup graph, because the rail's picker needs it; organization settings
 * build on it.
 */
export function administersOrganization(input: {
  accessContext: AccessContext;
  clientConfig: Pick<ClientConfig, "productAccessMode"> & {
    auth: Pick<ClientConfig["auth"], "mode">;
  };
  accountId: string | null;
}): boolean {
  if (!input.accountId) return false;
  const role = input.accessContext.accountGrants.find(
    (grant) => grant.accountId === input.accountId,
  )?.role;
  const administratorSession =
    input.clientConfig.auth.mode === "managedSession" ||
    input.clientConfig.productAccessMode === "local";
  return administratorSession && (role === "owner" || role === "admin");
}

/** Replace-or-append a workspace in the cached list (create + rename share it). */
export function upsertWorkspace(workspaces: Workspace[], workspace: Workspace): Workspace[] {
  if (workspaces.some((candidate) => candidate.id === workspace.id)) {
    return workspaces.map((candidate) => (candidate.id === workspace.id ? workspace : candidate));
  }
  return [...workspaces, workspace];
}
