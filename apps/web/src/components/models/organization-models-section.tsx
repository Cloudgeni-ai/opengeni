import { resolveWorkspaceSessionDefaults } from "@opengeni/contracts";
import { useMemo } from "react";

import { useOrganizationWorkspaces } from "@/components/models/connect-audience";
import type { ModelsWorkspace } from "@/components/models/organization-models-list";
import { WorkspaceModelsPage } from "@/components/models/workspace-models-page";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import type { ModelsView } from "@/lib/models-route";
import { canManageWorkspaceSettings, hasWorkspacePermission } from "@/lib/permissions";
import { useNavigate } from "@tanstack/react-router";

/* ----------------------------------------------------------------------------
   Organization settings > Models: who sees which part.

   - Owners and admins: every account and every workspace's model rules.
   - A workspace admin who isn't one: the workspaces they administer, and the
     accounts those workspaces use, read-only.
   - Everyone else never gets here from the rail; the route says who manages
     models instead (org-settings.tsx).

   Everyone who sees the page also sees their own Personal workspace, whose
   default model only they set.
   -------------------------------------------------------------------------- */

export function OrganizationModelsSection({
  anchorWorkspaceId,
  organizationId,
  organizationName,
  administrator,
  administeredWorkspaceIds,
  workspace: requestedWorkspace,
  account,
  view,
}: {
  /** The workspace the settings URL goes through. */
  anchorWorkspaceId: string;
  organizationId: string;
  organizationName: string;
  administrator: boolean;
  administeredWorkspaceIds: readonly string[];
  /** `?workspace=`: the workspace whose model page is open, or that a page was opened from. */
  workspace: string | undefined;
  account: string | undefined;
  view: ModelsView | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const overview = useOrganizationWorkspaces(context.client, organizationId, administrator);

  const workspaces = useMemo<ModelsWorkspace[]>(() => {
    const own = context.workspaces.filter((each) => each.accountId === organizationId);
    const describe = (id: string, name: string): ModelsWorkspace | null => {
      const workspace = own.find((each) => each.id === id);
      const personal = isPersonalWorkspace(workspace ?? null, context.managedSelfContext);
      return {
        id,
        name: workspace?.name ?? name,
        personal,
        canManage: workspace
          ? personal
            ? canManageWorkspaceSettings(
                context.accessContext,
                workspace,
                context.managedSelfContext,
              )
            : hasWorkspacePermission(context.accessContext, id, "workspace:admin")
          : false,
        savedDefaultModel: resolveWorkspaceSessionDefaults(workspace?.settings)?.model ?? null,
      };
    };
    const shared = administrator
      ? (overview.workspaces ?? own.filter((each) => each.kind !== "personal"))
      : own.filter((each) => administeredWorkspaceIds.includes(each.id));
    const personal = own.filter((each) => isPersonalWorkspace(each, context.managedSelfContext));
    const seen = new Set<string>();
    return [...shared, ...personal]
      .map((each) => describe(each.id, each.name))
      .filter((each): each is ModelsWorkspace => {
        if (!each || seen.has(each.id)) return false;
        seen.add(each.id);
        return true;
      });
  }, [
    administeredWorkspaceIds,
    administrator,
    context.accessContext,
    context.managedSelfContext,
    context.workspaces,
    organizationId,
    overview.workspaces,
  ]);

  const target = requestedWorkspace ?? anchorWorkspaceId;
  const targetWorkspace = context.workspaces.find((each) => each.id === target) ?? null;
  const targetEntry = workspaces.find((each) => each.id === target);
  // A workspace page this person can't manage (or can't open) says so instead.
  if (requestedWorkspace && (!targetWorkspace || !targetEntry?.canManage)) {
    return (
      <DetailPage
        back={{
          label: "Models",
          onClick: () =>
            void navigate({
              to: "/workspaces/$workspaceId/organization",
              params: { workspaceId: anchorWorkspaceId },
              search: { section: "models" },
            }),
        }}
        className={FLUSH_DETAIL_PAGE_CLASS}
      >
        <DetailPageHeader title={targetWorkspace?.name ?? "This workspace"} />
        <p className="mt-2 text-sm text-fg-muted">
          Only its workspace admins and the owners and admins of {organizationName} can change its
          models.
        </p>
      </DetailPage>
    );
  }

  const personal = isPersonalWorkspace(targetWorkspace, context.managedSelfContext);
  return (
    <WorkspaceModelsPage
      key={`models:${target}`}
      anchorWorkspaceId={anchorWorkspaceId}
      workspacePage={Boolean(requestedWorkspace)}
      workspaces={workspaces}
      workspacesError={overview.error}
      workspaceId={target}
      workspaceName={targetWorkspace?.name ?? "this workspace"}
      personal={personal}
      organizationId={organizationId}
      organizationName={organizationName}
      canManageSettings={canManageWorkspaceSettings(
        context.accessContext,
        targetWorkspace,
        context.managedSelfContext,
      )}
      canManageConnections={hasWorkspacePermission(
        context.accessContext,
        target,
        "connections:write",
      )}
      canManageOrganizationModels={administrator}
      account={account}
      view={view}
      onConnectionChange={() => undefined}
    />
  );
}
