// Organization settings: General, People, Workspaces, Models, Integrations,
// Organization identity, Billing & usage, Developer and Security & data.
// They render inside the settings shell's Organization section
// (components/settings/workspace-settings-shell.tsx); pages this person can't
// use are hidden from the rail (lib/organization-settings-access.ts).
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, UserPlusIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { toast } from "sonner";

import { OrganizationModelsPage } from "@/components/models/organization-models-page";
import type { ReturnTo } from "@/lib/return-to";
import { OrganizationBillingPage } from "@/components/organization/billing-page";
import { OrganizationGeneralPage } from "@/components/organization/general-page";
import { OrganizationIdentityPage } from "@/components/organization/identity-page";
import {
  OrganizationDirectoryProvider,
  useOptionalOrganizationDirectory,
} from "@/components/organization/organization-directory";
import { useOrganizationNavigation } from "@/components/organization/organization-nav";
import { OrganizationPeoplePage } from "@/components/organization/people-page";
import { OrganizationSecurityPage } from "@/components/organization/security-page";
import { OrganizationWorkspacesPage } from "@/components/organization/workspaces-page";
import { OrganizationIntegrationsSection } from "@/components/organization-integrations-section";
import {
  organizationSettingsDescription,
  organizationSettingsLabel,
} from "@/components/settings/organization-settings-pages";
import { Button } from "@/components/ui/button";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import type { ModelsView } from "@/lib/models-route";
import { orgLabel } from "@/lib/org";
import {
  canInviteOrganizationRole,
  organizationAdminIdentityKey,
  type OrganizationAdminIdentity,
  type OrganizationAdminSection,
} from "@/lib/organization-admin";
import {
  organizationSettingsAccess,
  resolveOrganizationSettingsSection,
} from "@/lib/organization-settings-access";
import type { OrganizationView } from "@/lib/organization-route";
import {
  completeWorkspaceDeletionFollowUp,
  deleteOrganizationWorkspaceWithReconciliation,
} from "@/lib/workspace-deletion";
import type { OrganizationMembershipRole } from "@/types";

const LazyOrganizationApiKeysSection = lazy(async () => {
  const module = await import("@/components/organization-api-keys-section");
  return { default: module.OrganizationApiKeysSection };
});

export function OrgSettingsRoute({
  workspaceId,
  checkout,
  section: requestedSection,
  modelsAccount,
  modelsView,
  returnTo,
  organizationView,
  person,
  invitation,
  workspace,
}: {
  workspaceId: string;
  checkout?: "success" | "cancelled";
  section?: OrganizationAdminSection;
  /** Models: the account page that is open. */
  modelsAccount?: string | undefined;
  /** Models: the form page that is open. */
  modelsView?: ModelsView | undefined;
  /** Where a cross-scope link came from; the back link returns there. */
  returnTo?: ReturnTo | undefined;
  /** People or Workspaces: the form page that is open. */
  organizationView?: OrganizationView | undefined;
  /** People: the person whose page is open (organization membership id). */
  person?: string | undefined;
  /** People: the invitation whose page is open. */
  invitation?: string | undefined;
  /** Workspaces: the workspace whose page is open. */
  workspace?: string | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const client = context.client;
  const activeWorkspace =
    context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const fallbackLabel = accountId
    ? orgLabel(accountId, context.accessContext.accountGrants)
    : "Organization";
  // The same rule decides which pages the settings rail lists.
  const {
    actorRole,
    singleUser,
    organizationAdministratorSession,
    canReadBilling,
    canManageBilling,
    canManageOrganizationKnowledge,
    canManageCompanyProfileAgentPolicy,
    canManageOrganizationApiKeys,
    visibleSections,
  } = organizationSettingsAccess({
    accessContext: context.accessContext,
    clientConfig: context.clientConfig,
    accountId,
  });
  const section: OrganizationAdminSection = resolveOrganizationSettingsSection(
    requestedSection,
    visibleSections,
  );

  const adminIdentity = useMemo<OrganizationAdminIdentity>(
    () => ({
      principalGeneration: context.accessKeyVersion,
      subjectId: context.accessContext.subjectId,
      organizationId: accountId,
      workspaceId,
    }),
    [accountId, context.accessContext.subjectId, context.accessKeyVersion, workspaceId],
  );
  const identityKey = organizationAdminIdentityKey(adminIdentity);
  const accessibleWorkspaceIds = useMemo(
    () => new Set(context.workspaces.map((candidate) => candidate.id)),
    [context.workspaces],
  );

  // Confirm the Stripe checkout outcome the /billing return redirect forwarded
  // here. Credits post via the asynchronous webhook, so success is phrased as
  // "shortly" rather than implying the balance already reflects the top-up.
  // The outcome is one-shot: it is dropped from the URL right away so a reload,
  // back navigation, or bookmark neither repeats the toast nor re-counts the
  // funnel event. The Stripe return is a full page load, so the event waits for
  // the analytics module instead of the not-yet-installed observer shim.
  useEffect(() => {
    if (!checkout) return;
    if (checkout === "success") {
      void import("@/lib/analytics")
        .then(({ captureAnalyticsEvent }) => captureAnalyticsEvent("checkout_completed"))
        .catch(() => undefined);
      toast.success("Payment received", {
        description: "Your credits will appear shortly.",
      });
    } else {
      toast("Checkout cancelled", { description: "No charge was made." });
    }
    void navigate({
      to: "/workspaces/$workspaceId/organization",
      params: { workspaceId },
      search: requestedSection ? { section: requestedSection } : {},
      replace: true,
    });
  }, [checkout, navigate, requestedSection, workspaceId]);

  const createWorkspace = useCallback(
    async (name: string, operationId: string): Promise<string | null> => {
      if (singleUser) {
        const created = await context.createWorkspace({ accountId, name });
        if (!created) throw new Error("The workspace wasn't created. Try again.");
        return created.id;
      }
      const created = await client.createOrganizationWorkspace(accountId, { name, operationId });
      await context.revalidatePrincipalAccess();
      return created.id;
    },
    [accountId, client, context, singleUser],
  );

  const deleteWorkspace = useCallback(
    async (deletedId: string) => {
      let remaining: readonly { id: string }[] = context.workspaces.filter(
        (candidate) => candidate.accountId === accountId && candidate.id !== deletedId,
      );
      if (singleUser) {
        const deleted = await context.deleteWorkspace(deletedId);
        if (!deleted) throw new Error("The workspace wasn't deleted. Try again.");
      } else {
        const overview = await deleteOrganizationWorkspaceWithReconciliation({
          client,
          organizationId: accountId,
          workspaceId: deletedId,
        });
        if (overview) remaining = overview.workspaces.filter((each) => each.id !== deletedId);
      }
      // The URL is anchored on a workspace; leave it when that's the one deleted.
      const next =
        deletedId === workspaceId
          ? (remaining.find((each) => accessibleWorkspaceIds.has(each.id)) ??
            context.workspaces.find((each) => each.id !== deletedId) ??
            null)
          : { id: workspaceId };
      const followUp = await completeWorkspaceDeletionFollowUp({
        refreshAccess: async () => {
          if (!singleUser) await context.revalidatePrincipalAccess();
        },
        navigate: async () => {
          if (next) {
            await navigate({
              to: "/workspaces/$workspaceId/organization",
              params: { workspaceId: next.id },
              search: { section: "workspaces" },
              replace: true,
            });
          } else {
            await navigate({ to: "/", replace: true });
          }
        },
      });
      if (followUp.status === "failed") {
        toast.warning("Workspace deleted, but the page may be out of date", {
          description: "Reload to refresh your workspace access.",
        });
      }
    },
    [accessibleWorkspaceIds, accountId, client, context, navigate, singleUser, workspaceId],
  );

  const subPage =
    (section === "models" && Boolean(modelsAccount || modelsView)) ||
    (section === "people" && Boolean(person || invitation || organizationView)) ||
    (section === "workspaces" && Boolean(workspace || organizationView)) ||
    (section === "developer" && organizationView === "new-key") ||
    // Opened from another scope (a workspace's Models): Billing brings its own back link.
    (section === "billing" && Boolean(returnTo));

  return (
    <OrganizationDirectoryProvider
      key={identityKey}
      client={client}
      identity={adminIdentity}
      actorRole={actorRole}
      managedSession={organizationAdministratorSession}
      singleUser={singleUser}
      accessibleWorkspaceIds={accessibleWorkspaceIds}
      youLabel={context.accessContext.subjectLabel ?? null}
      onAuthorityChanged={context.revalidatePrincipalAccess}
      onCreateWorkspace={createWorkspace}
      onDeleteWorkspace={deleteWorkspace}
    >
      <OrganizationSettingsFrame
        workspaceId={workspaceId}
        fallbackLabel={fallbackLabel}
        section={section}
        hideHeader={subPage}
        actorRole={actorRole}
      >
        {section === "general" ? <OrganizationGeneralPage /> : null}

        {section === "people" ? (
          <OrganizationPeoplePage
            workspaceId={workspaceId}
            person={person}
            invitation={invitation}
            view={organizationView === "invite" ? "invite" : undefined}
          />
        ) : null}

        {section === "workspaces" ? (
          <OrganizationWorkspacesPage
            workspaceId={workspaceId}
            workspace={workspace}
            view={organizationView === "new-workspace" ? "new-workspace" : undefined}
            returnTo={returnTo}
            onEnterWorkspace={(createdId) => {
              context.resetSessionView();
              void navigate({
                to: "/workspaces/$workspaceId/sessions",
                params: { workspaceId: createdId },
              });
            }}
          />
        ) : null}

        {section === "models" ? (
          <OrganizationModelsSection
            key={`${identityKey}:models`}
            workspaceId={workspaceId}
            organizationId={accountId}
            fallbackLabel={fallbackLabel}
            account={modelsAccount}
            view={modelsView}
            returnTo={returnTo}
          />
        ) : null}

        {section === "identity" ? (
          <OrganizationIdentityPage
            workspaceId={workspaceId}
            identityKey={identityKey}
            canManage={canManageOrganizationKnowledge}
            canManageAgentPolicy={canManageCompanyProfileAgentPolicy}
          />
        ) : null}

        {section === "integrations" ? (
          <OrganizationIntegrationsSection
            key={`${identityKey}:integrations`}
            client={client}
            identity={adminIdentity}
            actorRole={actorRole}
            managedSession={organizationAdministratorSession}
          />
        ) : null}

        {section === "developer" ? (
          <Suspense fallback={<Skeleton className="h-48 w-full rounded-lg" />}>
            <LazyOrganizationApiKeysSection
              key={`${identityKey}:organization-api-keys`}
              organizationId={accountId}
              canManage={canManageOrganizationApiKeys && Boolean(accountId)}
              view={organizationView === "new-key" ? "new-key" : undefined}
              onViewChange={(view) =>
                void navigate({
                  to: "/workspaces/$workspaceId/organization",
                  params: { workspaceId },
                  search: view ? { section: "developer", view } : { section: "developer" },
                })
              }
              listApiKeys={async () => await client.listOrganizationApiKeys(accountId)}
              createApiKey={async (request) =>
                await client.createOrganizationApiKey(accountId, request)
              }
              deleteApiKey={async (apiKeyId) =>
                await client.deleteOrganizationApiKey(accountId, apiKeyId)
              }
            />
          </Suspense>
        ) : null}

        {section === "billing" ? (
          <BillingSection returnTo={returnTo}>
            <OrganizationBillingPage
              key={`${identityKey}:billing`}
              identity={adminIdentity}
              canReadBilling={canReadBilling}
              canManageBilling={canManageBilling}
            />
          </BillingSection>
        ) : null}

        {section === "security" ? <OrganizationSecurityPage /> : null}
      </OrganizationSettingsFrame>
    </OrganizationDirectoryProvider>
  );
}

/**
 * The page header and body of one organization page, with the organization's
 * real name once it has loaded. The settings shell around it draws the rail.
 */
function OrganizationSettingsFrame({
  workspaceId,
  fallbackLabel,
  section,
  hideHeader,
  actorRole,
  children,
}: {
  workspaceId: string;
  fallbackLabel: string;
  section: OrganizationAdminSection;
  /** A sub-page (a person, a workspace, a form) brings its own back link and title. */
  hideHeader: boolean;
  actorRole: OrganizationMembershipRole | null;
  children: ReactNode;
}) {
  const directory = useOptionalOrganizationDirectory();
  const nav = useOrganizationNavigation(workspaceId);
  const organizationLabel = directory?.overview.value?.organization.name ?? fallbackLabel;
  let actions: ReactNode = null;
  if (section === "people" && canInviteOrganizationRole(actorRole, "member")) {
    actions = (
      <Button type="button" onClick={nav.openInvite} className="pointer-coarse:h-11">
        <UserPlusIcon aria-hidden="true" />
        Invite people
      </Button>
    );
  } else if (section === "workspaces" && directory?.canAdminister) {
    actions = (
      <Button type="button" onClick={nav.openNewWorkspace} className="pointer-coarse:h-11">
        <PlusIcon aria-hidden="true" />
        New workspace
      </Button>
    );
  }
  const body = <div className="grid min-w-0 gap-8 text-left">{children}</div>;
  if (hideHeader) return body;
  return (
    <>
      <PageHeader
        title={organizationSettingsLabel(section)}
        description={organizationSettingsDescription(section, organizationLabel)}
        actions={actions}
      />
      <div className="mt-6">{body}</div>
    </>
  );
}

/** Billing, with a back link to where a cross-scope link came from ("Design preview · Models"). */
function BillingSection({
  returnTo,
  children,
}: {
  returnTo: ReturnTo | undefined;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  if (!returnTo) return <>{children}</>;
  return (
    <DetailPage
      back={{ label: returnTo.label, onClick: () => void navigate({ href: returnTo.path }) }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader title="Billing & usage" />
      <div className="mt-6 min-w-0">{children}</div>
    </DetailPage>
  );
}

/** Models, named with the organization's real name once it has loaded. */
function OrganizationModelsSection({
  fallbackLabel,
  ...props
}: {
  workspaceId: string;
  organizationId: string;
  fallbackLabel: string;
  account: string | undefined;
  view: ModelsView | undefined;
  returnTo: ReturnTo | undefined;
}) {
  const directory = useOptionalOrganizationDirectory();
  return (
    <OrganizationModelsPage
      {...props}
      organizationName={directory?.overview.value?.organization.name ?? fallbackLabel}
    />
  );
}
