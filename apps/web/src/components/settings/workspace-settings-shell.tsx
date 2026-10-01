import {
  type WorkspaceSettingsSection,
  type WorkspaceManagementLocation,
} from "@/lib/workspace-management-location";
export {
  workspaceManagementLocation,
  workspaceSettingsSectionFromSearch,
  type WorkspaceSettingsSection,
  type WorkspaceManagementLocation,
} from "@/lib/workspace-management-location";
export { WORKSPACE_SETTINGS_COPY } from "./settings-rail";
import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { organizationSettingsLabel } from "./organization-settings-pages";
import {
  WORKSPACE_SETTINGS_COPY,
  settingsRailItemId,
  useSettingsRail,
  workspacePageLabel,
} from "./settings-rail";
import { SettingsShell, type SettingsShellPage } from "./settings-sidebar";
import { WorkspacePausedBanner } from "@/components/rail/workspace-paused-banner";

/** Sub-pages (an account, a key, a form) bring their own back link and title. */
function isSubPage(section: WorkspaceSettingsSection, search: Record<string, unknown>): boolean {
  if (section === "models") return Boolean(search.account || search.view);
  if (section === "api-keys") return Boolean(search.key);
  if (section === "access") return Boolean(search.view);
  return false;
}

/**
 * Settings for a workspace and its organization: one settings rail with a
 * Workspace section, an Organization section and Your account. Organization
 * pages render inside this same shell, so moving between a workspace page and
 * an organization page keeps the rail in place.
 */
export function WorkspaceManagementShell({
  workspaceId,
  workspaceName,
  organizationName,
  organizationId,
  location,
  organizationManagementOnly = false,
  organizationSettingsWorkspaceId,
  children,
}: {
  workspaceId: string;
  workspaceName?: string;
  organizationName: string;
  /** The organization of a workspace managed without access (`organizationManagementOnly`). */
  organizationId?: string;
  location: WorkspaceManagementLocation;
  /**
   * An organization administrator without access to this workspace: only its
   * name, access and deletion.
   */
  organizationManagementOnly?: boolean;
  organizationSettingsWorkspaceId?: string;
  children: ReactNode;
}) {
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  const rail = useSettingsRail({
    workspaceId: organizationManagementOnly ? null : workspaceId,
    location,
    ...(organizationManagementOnly
      ? {
          managedWorkspace: {
            id: workspaceId,
            name: workspaceName ?? "Workspace",
            organizationId: organizationId ?? "",
            organizationName,
            organizationSettingsWorkspaceId,
          },
        }
      : {}),
  });
  const names = {
    workspace: workspaceName ?? rail.workspaceName ?? "this workspace",
    organization: organizationName,
  };

  const section: WorkspaceSettingsSection | null =
    location.kind === "settings" ? (location.section ?? "general") : null;
  // Organization pages draw their own header (its actions come from the page).
  const page: SettingsShellPage | null =
    section && !isSubPage(section, search)
      ? {
          title: WORKSPACE_SETTINGS_COPY[section].title,
          description: WORKSPACE_SETTINGS_COPY[section].description?.(names),
        }
      : null;
  const currentPage =
    location.kind === "organization"
      ? organizationSettingsLabel(rail.organizationSection ?? "identity")
      : workspacePageLabel(location);
  const activeId =
    location.kind === "organization"
      ? settingsRailItemId({ kind: "organization", section: rail.organizationSection })
      : settingsRailItemId(location);

  return (
    <SettingsShell
      label="Settings"
      back={rail.back}
      home={rail.home}
      scope={rail.picker}
      sections={rail.sections}
      activeId={activeId}
      currentPage={currentPage}
      currentScope={rail.scopeOf(location)}
      page={page}
      layout={location.kind === "page" ? "page" : "settings"}
      notice={
        organizationManagementOnly || location.kind === "organization" ? undefined : (
          <WorkspacePausedBanner workspaceId={workspaceId} />
        )
      }
    >
      {children}
    </SettingsShell>
  );
}

/**
 * The body of one workspace settings page. The page header lives in the
 * settings shell (`WorkspaceManagementShell`), so the body is only the content.
 */
export function WorkspaceSettingsContent({ children }: { children: ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}
