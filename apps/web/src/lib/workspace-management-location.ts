/**
 * Workspace settings pages, addressed by `?section=` on `/settings`. Settings
 * hold configuration only: the settings rail also links to the Agents and
 * Insights dashboards and the runtime pages, which open as their own pages.
 */
export type WorkspaceSettingsSection = "general" | "access" | "models" | "api-keys" | "learning";

/**
 * Older `?section=` values. They keep working: Members is now Access, Danger
 * zone is the last row of General, and Capabilities is its own page.
 */
export type LegacyWorkspaceSettingsSection = "members" | "danger" | "plugins" | "capabilities";

export const WORKSPACE_SETTINGS_SECTIONS: readonly WorkspaceSettingsSection[] = [
  "general",
  "access",
  "models",
  "api-keys",
  "learning",
];

const WORKSPACE_PAGE_TARGETS = [
  "/workspaces/$workspaceId/agents",
  "/workspaces/$workspaceId/insights",
  "/workspaces/$workspaceId/variable-sets",
  "/workspaces/$workspaceId/rigs",
  "/workspaces/$workspaceId/machines",
] as const;
export type WorkspacePageTarget = (typeof WORKSPACE_PAGE_TARGETS)[number];

export type WorkspaceManagementLocation =
  /** `section` is null when the URL asks for the settings list itself. */
  | { kind: "settings"; section: WorkspaceSettingsSection | null }
  | { kind: "page"; target: WorkspacePageTarget };

/** Parses `?section=`, mapping older names to the page that holds them now. */
export function workspaceSettingsSectionFromSearch(
  value: unknown,
): WorkspaceSettingsSection | null {
  if (WORKSPACE_SETTINGS_SECTIONS.includes(value as WorkspaceSettingsSection)) {
    return value as WorkspaceSettingsSection;
  }
  if (value === "members") return "access";
  if (value === "danger") return "general";
  return null;
}

/**
 * Resolve the workspace routes that open in settings mode: the settings rail
 * replaces the main rail. Matching is segment-aware: `/rigs/:rigId` belongs to
 * Sandbox environments, while a future `/rigs-archive` route is not captured.
 */
export function workspaceManagementLocation(
  pathname: string,
  workspaceId: string,
  settingsSection?: unknown,
): WorkspaceManagementLocation | null {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  if (pathname === `${base}/settings`) {
    return {
      kind: "settings",
      section: workspaceSettingsSectionFromSearch(settingsSection),
    };
  }

  for (const target of WORKSPACE_PAGE_TARGETS) {
    const targetPath = target.replace("$workspaceId", encodeURIComponent(workspaceId));
    if (pathname === targetPath || pathname.startsWith(`${targetPath}/`)) {
      return { kind: "page", target };
    }
  }
  return null;
}
