import { resolveWorkspaceSessionDefaults } from "@opengeni/contracts";
import { useMemo } from "react";

import { useOrganizationWorkspaces } from "@/components/models/connect-audience";
import type { ModelsWorkspace } from "@/components/models/organization-models-list";
import {
  WorkspaceModelsPageBody,
  useOrganizationModelAccounts,
} from "@/components/models/workspace-models-page";
import { DetailPage, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { FLUSH_DETAIL_PAGE_CLASS } from "@opengeni/react/ui/flush-form-page";
import { useAppContext } from "@opengeni/react/app/app-context";
import { isPersonalWorkspace } from "@opengeni/react/app/lib/managed-self-context";
import { organizationModelsSearch, type ModelsView } from "@opengeni/react/app/lib/models-route";
import {
  canContributeWorkspaceContent,
  canManageWorkspaceSettings,
  hasWorkspacePermission,
} from "@opengeni/react/app/lib/permissions";
import { useNavigate } from "@tanstack/react-router";

/* ----------------------------------------------------------------------------
   Organization settings > Models: who sees which part.

   - Owners and admins: every account and every workspace's model rules.
   - An account administrator without a person (the deployment's access key,
     or a service with account:admin): the organization's subscription
     accounts (Codex, SuperGrok, Claude) and every workspace it can open.
     Organization keys and organization defaults are read through a person's
     organization membership, so they stay with owners and admins.
   - A workspace admin who isn't one: the workspaces they administer, and the
     accounts those workspaces use, read-only.
   - A member: their own Personal workspace, whose default model and Allowed
     models only they set, and the accounts it can use, read-only. Each
     shared workspace where they manage connections opens too, to connect and
     manage their own subscriptions there ("Only me"); its models stay
     read-only.
   - Any other key or service never gets here; the route says who manages
     models instead (org-settings.tsx).

   Only owners, admins and account administrators add accounts.
   -------------------------------------------------------------------------- */

export function OrganizationModelsSection({
  anchorWorkspaceId,
  organizationId,
  organizationName,
  administrator,
  personAdministrator = administrator,
  administeredWorkspaceIds,
  workspace: requestedWorkspace,
  account: requestedAccount,
  view: requestedView,
}: {
  /** The workspace the settings URL goes through. */
  anchorWorkspaceId: string;
  organizationId: string;
  organizationName: string;
  /** Administers the organization's subscription accounts (owner, admin or account administrator). */
  administrator: boolean;
  /** An owner or admin acting as a person: also organization keys and defaults. */
  personAdministrator?: boolean;
  administeredWorkspaceIds: readonly string[];
  /** `?workspace=`: the workspace whose model page is open, or that a page was opened from. */
  workspace: string | undefined;
  account: string | undefined;
  view: ModelsView | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  // The administration overview is a person's; an account administrator
  // without one lists the shared workspaces it can open.
  const overview = useOrganizationWorkspaces(context.client, organizationId, personAdministrator);
  // Kept here, above the per-workspace page, so moving between the list and a
  // workspace's page never drops a sign-in that is still going.
  const organizationAccounts = useOrganizationModelAccounts({
    organizationId,
    enabled: administrator && Boolean(organizationId),
    gatewaysEnabled: personAdministrator && Boolean(organizationId),
  });
  // Old organization Models links name its accounts without the "org:" mark.
  const { account, view } = useMemo(
    () =>
      organizationModelsSearch({
        workspace: requestedWorkspace,
        account: requestedAccount,
        view: requestedView,
      }),
    [requestedAccount, requestedView, requestedWorkspace],
  );

  const workspaces = useMemo<ModelsWorkspace[]>(() => {
    const own = context.workspaces.filter((each) => each.accountId === organizationId);
    const describe = (id: string, name: string): ModelsWorkspace | null => {
      const workspace = own.find((each) => each.id === id);
      const personal = isPersonalWorkspace(workspace ?? null, context.managedSelfContext);
      const canManage = workspace
        ? personal
          ? canManageWorkspaceSettings(context.accessContext, workspace, context.managedSelfContext)
          : hasWorkspacePermission(context.accessContext, id, "workspace:admin")
        : false;
      const member = !administrator && !personal && !canManage && Boolean(workspace);
      const ownSubscriptions = hasWorkspacePermission(
        context.accessContext,
        id,
        "connections:write",
      );
      const customModels = canContributeWorkspaceContent(
        context.accessContext,
        workspace ?? null,
        context.managedSelfContext,
      );
      return {
        id,
        name: workspace?.name ?? name,
        personal,
        canManage,
        // A member opens it to connect their own subscriptions or to add and
        // remove its custom models.
        connectOwn: member && (ownSubscriptions || customModels),
        customModels: member && customModels,
        ownSubscriptions,
        savedDefaultModel: resolveWorkspaceSessionDefaults(workspace?.settings)?.model ?? null,
      };
    };
    const shared = administrator
      ? (overview.workspaces ?? own.filter((each) => each.kind !== "personal"))
      : own.filter(
          (each) =>
            administeredWorkspaceIds.includes(each.id) ||
            (!isPersonalWorkspace(each, context.managedSelfContext) &&
              (hasWorkspacePermission(context.accessContext, each.id, "connections:write") ||
                canContributeWorkspaceContent(
                  context.accessContext,
                  each,
                  context.managedSelfContext,
                ))),
        );
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
  // Owners and admins still open it: its defaults read-only, and the
  // organization's accounts and Connect account as everywhere else. A member
  // who manages connections there opens it for their own subscriptions.
  if (
    requestedWorkspace &&
    (!targetWorkspace || (!targetEntry?.canManage && !targetEntry?.connectOwn && !administrator))
  ) {
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
    <WorkspaceModelsPageBody
      key={`models:${target}`}
      organizationAccounts={organizationAccounts}
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
      canManageCustomModels={canContributeWorkspaceContent(
        context.accessContext,
        targetWorkspace,
        context.managedSelfContext,
      )}
      canAdministerWorkspace={hasWorkspacePermission(
        context.accessContext,
        target,
        "workspace:admin",
      )}
      canManageConnections={hasWorkspacePermission(
        context.accessContext,
        target,
        "connections:write",
      )}
      canManageOrganizationModels={administrator}
      organizationPeopleAdministrator={personAdministrator}
      account={account}
      view={view}
      onConnectionChange={() => undefined}
    />
  );
}
