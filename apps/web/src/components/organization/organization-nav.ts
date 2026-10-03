import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import type { OrganizationAdminSection } from "@/lib/organization-admin";
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

export function useOrganizationNavigation(workspaceId: string): OrganizationNavigation {
  const navigate = useNavigate();
  return useMemo(() => {
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
}
