// The app's organization settings pages (People, Billing, General) inside
// Console: the same directory and actions, with every link they make kept
// on Console's own pages.
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, type ReactNode } from "react";

import { useAppContext } from "@opengeni/react/app/app-context";
import {
  organizationAdminIdentityKey,
  type OrganizationAdminIdentity,
} from "@opengeni/react/app/lib/organization-admin";
import { deleteOrganizationWorkspaceWithReconciliation } from "@opengeni/react/app/lib/workspace-deletion";
import { OrganizationDirectoryProvider } from "@/components/organization/organization-directory";
import {
  OrganizationRoutesContext,
  type OrganizationRoutes,
} from "@/components/organization/organization-nav";
import { organizationSettingsAccess } from "@/lib/organization-settings-access";

import { useConsole } from "./console-shared";

/** What the signed-in person may do in this organization's settings pages. */
export function useConsoleOrganizationAccess() {
  const context = useAppContext();
  const { organizationId } = useConsole();
  return organizationSettingsAccess({
    accessContext: context.accessContext,
    clientConfig: context.clientConfig,
    accountId: organizationId,
  });
}

/** The identity organization pages load and act as; anchored on an app workspace when there is one. */
export function useConsoleOrganizationIdentity(): OrganizationAdminIdentity {
  const context = useAppContext();
  const { organizationId, appWorkspaceId } = useConsole();
  return useMemo(
    () => ({
      principalGeneration: context.accessKeyVersion,
      subjectId: context.accessContext.subjectId,
      organizationId,
      workspaceId: appWorkspaceId ?? "",
    }),
    [appWorkspaceId, context.accessContext.subjectId, context.accessKeyVersion, organizationId],
  );
}

export function ConsoleOrganizationProvider({ children }: { children: ReactNode }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const { client, organizationId, search } = useConsole();
  const access = useConsoleOrganizationAccess();
  const identity = useConsoleOrganizationIdentity();
  const accessibleWorkspaceIds = useMemo(
    () => new Set(context.workspaces.map((workspace) => workspace.id)),
    [context.workspaces],
  );

  const routes = useMemo<OrganizationRoutes>(() => {
    const members = (next: { person?: string; invitation?: string; view?: "invite" }) =>
      void navigate({ to: "/console/members", search: { ...search, ...next } });
    const usage = (next: { workspace?: string }) =>
      void navigate({ to: "/console/usage", search: { ...search, ...next } });
    const usageUrl = (query: string) =>
      `${window.location.origin}/console/usage?org=${encodeURIComponent(search.org)}${query}`;
    return {
      openSection: (section) => {
        if (section === "people") members({});
        else if (section === "billing" || section === "insights") usage({});
        else if (section === "developer") void navigate({ to: "/console/api-keys", search });
        else if (section === "workspaces") void navigate({ to: "/console/workspaces", search });
        else void navigate({ to: "/console/settings", search });
      },
      openPerson: (person) => members({ person }),
      openInvitation: (invitation) => members({ invitation }),
      openInvite: () => members({ view: "invite" }),
      openWorkspace: () => void navigate({ to: "/console/workspaces", search }),
      openNewWorkspace: () => void navigate({ to: "/console/workspaces", search }),
      openBudget: (workspace) => usage(workspace ? { workspace } : {}),
      openInsights: null,
      // Appended raw: Stripe replaces its {CHECKOUT_SESSION_ID} placeholder.
      billingReturnUrl: (outcome) =>
        usageUrl(
          outcome === "success"
            ? "&checkout=success&checkoutSession={CHECKOUT_SESSION_ID}"
            : "&checkout=cancelled",
        ),
      billingPortalReturnUrl: usageUrl(""),
    };
  }, [navigate, search]);

  const createWorkspace = useCallback(
    async (name: string, operationId: string): Promise<string | null> => {
      const created = await client.createOrganizationWorkspace(organizationId, {
        name,
        operationId,
      });
      await context.revalidatePrincipalAccess();
      return created.id;
    },
    [client, context, organizationId],
  );
  const deleteWorkspace = useCallback(
    async (workspaceId: string) => {
      await deleteOrganizationWorkspaceWithReconciliation({
        client,
        organizationId,
        workspaceId,
      });
      await context.revalidatePrincipalAccess();
    },
    [client, context, organizationId],
  );

  return (
    <OrganizationDirectoryProvider
      key={organizationAdminIdentityKey(identity)}
      client={client}
      identity={identity}
      actorRole={access.actorRole}
      managedSession={access.organizationAdministratorSession}
      singleUser={access.singleUser}
      accessibleWorkspaceIds={accessibleWorkspaceIds}
      youLabel={context.accessContext.subjectLabel ?? null}
      onAuthorityChanged={context.revalidatePrincipalAccess}
      onCreateWorkspace={createWorkspace}
      onDeleteWorkspace={deleteWorkspace}
    >
      <OrganizationRoutesContext.Provider value={routes}>{children}</OrganizationRoutesContext.Provider>
    </OrganizationDirectoryProvider>
  );
}
