import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useMemo } from "react";

import type { OrganizationAdminSection } from "@opengeni/react/app/lib/organization-admin";
import type { OrganizationView } from "@/lib/organization-route";

/** Moves between organization settings pages; every page has its own URL. */
export interface OrganizationNavigation {
  openSection: (section: OrganizationAdminSection) => void;
  openPerson: (membershipId: string) => void;
  openInvitation: (invitationId: string) => void;
  openInvite: () => void;
  openWorkspace: (workspaceId: string) => void;
  openNewWorkspace: () => void;
}

/**
 * Where organization pages lead when they are embedded outside the app's
 * organization settings (Opengeni Console): people, billing and workspace
 * links then stay on the embedding surface.
 */
export interface OrganizationRoutes extends OrganizationNavigation {
  /** Billing: the budgets list, or one workspace's budget page. */
  openBudget: (workspaceId: string | undefined) => void;
  /** Billing: Insights, or null when the surface has no Insights page. */
  openInsights: (() => void) | null;
  /** Billing: the page Stripe returns to, with `checkout` (and `checkoutSession`) appended. */
  billingReturnUrl: (outcome: "success" | "cancelled") => string;
  /** Billing: the page a customer-portal visit returns to. */
  billingPortalReturnUrl: string;
}

export const OrganizationRoutesContext = createContext<OrganizationRoutes | null>(null);

/** The embedding surface's routes, or null inside the app's organization settings. */
export function useOrganizationRoutes(): OrganizationRoutes | null {
  return useContext(OrganizationRoutesContext);
}

export function useOrganizationNavigation(workspaceId: string): OrganizationNavigation {
  const navigate = useNavigate();
  const routes = useOrganizationRoutes();
  const app = useMemo<OrganizationNavigation>(() => {
    const go = (search: {
      section: OrganizationAdminSection;
      view?: OrganizationView;
      person?: string;
      invitation?: string;
      workspace?: string;
    }) =>
      void navigate({
        to: "/workspaces/$workspaceId/organization",
        params: { workspaceId },
        search,
      });
    return {
      openSection: (section) => go({ section }),
      openPerson: (person) => go({ section: "people", person }),
      openInvitation: (invitation) => go({ section: "people", invitation }),
      openInvite: () => go({ section: "people", view: "invite" }),
      openWorkspace: (workspace) => go({ section: "workspaces", workspace }),
      openNewWorkspace: () => go({ section: "workspaces", view: "new-workspace" }),
    };
  }, [navigate, workspaceId]);
  return routes ?? app;
}
