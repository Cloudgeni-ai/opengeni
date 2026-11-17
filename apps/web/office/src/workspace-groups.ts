import type { AccessContext, Workspace } from "@opengeni/sdk";
import { t } from "@opengeni/react/app/lib/console-text";
import { orgLabel, workspacesByOrganization } from "@opengeni/react/organization-model";

export type WorkspaceGroup = { label: string; workspaces: Workspace[] };

/**
 * The pane's workspace picker, grouped by organization in the console
 * switcher's order, so two organizations' "Personal workspace" can be told
 * apart. Without the access context, organizations are labelled by id.
 */
export function workspaceGroups(
  workspaces: Workspace[],
  access: AccessContext | null,
): WorkspaceGroup[] {
  if (access) {
    return workspacesByOrganization(t, access, workspaces).map((group) => ({
      label: group.org.label,
      workspaces: group.workspaces,
    }));
  }
  const groups = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    groups.set(workspace.accountId, [...(groups.get(workspace.accountId) ?? []), workspace]);
  }
  return [...groups].map(([accountId, members]) => ({
    label: orgLabel(t, accountId, []),
    workspaces: members,
  }));
}
