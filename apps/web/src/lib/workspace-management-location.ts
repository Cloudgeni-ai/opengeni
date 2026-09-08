export type WorkspaceSettingsSection =
  | "general"
  | "members"
  | "tools"
  | "plugins"
  | "models"
  | "api-keys"
  | "danger";

const WORKSPACE_PAGE_TARGETS = [
  "/workspaces/$workspaceId/agents",
  "/workspaces/$workspaceId/insights",
  "/workspaces/$workspaceId/memory",
  "/workspaces/$workspaceId/variable-sets",
  "/workspaces/$workspaceId/rigs",
  "/workspaces/$workspaceId/machines",
] as const;
type WorkspacePageTarget = (typeof WORKSPACE_PAGE_TARGETS)[number];

export type WorkspaceManagementLocation =
  | { kind: "settings"; section: WorkspaceSettingsSection }
  | { kind: "page"; target: WorkspacePageTarget };

const DEFAULT_SETTINGS_SECTION: WorkspaceSettingsSection = "general";

export function workspaceSettingsSectionFromSearch(value: unknown): WorkspaceSettingsSection {
  return value === "members" ||
    value === "tools" ||
    value === "plugins" ||
    value === "models" ||
    value === "api-keys" ||
    value === "danger"
    ? value
    : DEFAULT_SETTINGS_SECTION;
}

/**
 * Resolve the workspace routes that share the persistent management shell.
 * Keep matching segment-aware: `/rigs/:rigId` belongs to Rigs, while a future
 * `/rigs-archive` route must not be captured accidentally.
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
    if (
      pathname === targetPath ||
      (target.endsWith("/rigs") && pathname.startsWith(`${targetPath}/`))
    ) {
      return { kind: "page", target };
    }
  }
  return null;
}
