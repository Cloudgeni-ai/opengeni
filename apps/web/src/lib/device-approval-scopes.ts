import type { AccessContext, ClientConfig } from "@opengeni/react/app/types";
import { lacksWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { canAdministerOrganization } from "@opengeni/react/app/lib/workspaces";

/**
 * Which scopes the device approval page offers for a machine enrolling into a
 * workspace, as the server's approve route decides: the workspace needs
 * `enrollments:manage` there; the organization also needs the person to
 * administer that workspace's organization (its owner or an admin).
 */
export function deviceApprovalScopes(input: {
  accessContext: AccessContext;
  clientConfig: Pick<ClientConfig, "productAccessMode"> & {
    auth: Pick<ClientConfig["auth"], "mode">;
  };
  workspaceId: string | null;
}): { workspace: boolean; organization: boolean } {
  const { accessContext, clientConfig, workspaceId } = input;
  // Before the lookup answers, nothing is refused yet.
  if (!workspaceId) return { workspace: true, organization: false };
  const workspace = !lacksWorkspacePermission(accessContext, workspaceId, "enrollments:manage");
  const organization =
    workspace &&
    accessContext.workspaceGrants.some(
      (grant) =>
        grant.workspaceId === workspaceId &&
        canAdministerOrganization({ accessContext, clientConfig, accountId: grant.accountId }),
    );
  return { workspace, organization };
}
