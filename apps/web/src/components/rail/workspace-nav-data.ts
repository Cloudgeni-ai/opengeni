// Workspace destination catalog (routes, labels, icon keys). Rendering lives in
// `workspace-config-link.tsx`.

export type WorkspaceConfigTarget =
  | "/workspaces/$workspaceId/agents"
  | "/workspaces/$workspaceId/insights"
  | "/workspaces/$workspaceId/variable-sets"
  | "/workspaces/$workspaceId/rigs"
  | "/workspaces/$workspaceId/machines"
  | "/workspaces/$workspaceId/plugins"
  | "/workspaces/$workspaceId/sites"
  | "/workspaces/$workspaceId/applications"
  | "/workspaces/$workspaceId/schedules"
  | "/workspaces/$workspaceId/documents"
  | "/workspaces/$workspaceId/memory"
  | "/workspaces/$workspaceId/state"
  | "/workspaces/$workspaceId/artifacts"
  | "/workspaces/$workspaceId/settings";

export type WorkspaceConfigIcon =
  | "gauge"
  | "box"
  | "server-cog"
  | "laptop"
  | "file-search"
  | "brain-circuit"
  | "map"
  | "plug"
  | "calendar-clock"
  | "panels-top-left"
  | "settings";

export type WorkspaceConfigItem = {
  to: WorkspaceConfigTarget;
  icon: WorkspaceConfigIcon;
  label: string;
  description: string;
  /** When true, only include for subjects with workspace:admin. */
  requiresAdmin?: boolean;
  /** Deployment capability gate projected by /v1/config/client. */
  feature?: "sites" | "advancedDeployments";
};

export type WorkspaceConfigGroup = {
  id: string;
  label: string;
  items: WorkspaceConfigItem[];
};

/** Product destinations promoted to the primary rail beside New session. */
export const PRIMARY_WORKSPACE_ITEMS: WorkspaceConfigItem[] = [
  {
    to: "/workspaces/$workspaceId/plugins",
    icon: "plug",
    label: "Plugins",
    description: "Integrations, MCP servers, skills, and packs",
  },
  {
    to: "/workspaces/$workspaceId/documents",
    icon: "file-search",
    label: "Documents",
    description: "Indexed knowledge for agents",
  },
  {
    to: "/workspaces/$workspaceId/state",
    icon: "brain-circuit",
    label: "Agent Knowledge",
    description: "Instructions, skills, documents, and memory",
  },
  {
    to: "/workspaces/$workspaceId/schedules",
    icon: "calendar-clock",
    label: "Schedules",
    description: "Run agents on a schedule",
  },
  {
    to: "/workspaces/$workspaceId/artifacts",
    icon: "panels-top-left",
    label: "Artifacts",
    description: "Live pages and tools built by agents",
  },
  {
    to: "/workspaces/$workspaceId/sites",
    icon: "panels-top-left",
    label: "Sites",
    description: "Authenticated static apps with native AI and integrations",
    feature: "sites",
  },
  {
    to: "/workspaces/$workspaceId/applications",
    icon: "panels-top-left",
    label: "Advanced deployments",
    description: "Deploy arbitrary full-stack apps to connected infrastructure",
    feature: "advancedDeployments",
  },
];

export const WORKSPACE_CONFIG_GROUPS: WorkspaceConfigGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        to: "/workspaces/$workspaceId/agents",
        icon: "map",
        label: "Agents",
        description: "Live agent trees and spawned work",
      },
      {
        to: "/workspaces/$workspaceId/insights",
        icon: "gauge",
        label: "Insights",
        description: "Spend, blockers, automation, and outcomes",
        requiresAdmin: true,
      },
    ],
  },
  {
    id: "runtime",
    label: "Runtime",
    items: [
      {
        to: "/workspaces/$workspaceId/variable-sets",
        icon: "box",
        label: "Variable sets",
        description: "Secret variableSets for sandboxes",
      },
      {
        to: "/workspaces/$workspaceId/rigs",
        icon: "server-cog",
        label: "Rigs",
        description: "Versioned sandbox machine definitions",
      },
      {
        to: "/workspaces/$workspaceId/machines",
        icon: "laptop",
        label: "Machines",
        description: "Your own connected computers",
      },
    ],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    items: [
      {
        to: "/workspaces/$workspaceId/memory",
        icon: "brain-circuit",
        label: "Memory",
        description: "Durable facts agents carry across sessions",
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      {
        to: "/workspaces/$workspaceId/settings",
        icon: "settings",
        label: "Workspace settings",
        description: "Members, permissions, models, keys, and defaults",
      },
    ],
  },
];

/** Destinations shown in the Browse workspace strip (excludes the settings page itself). */
export const WORKSPACE_BROWSE_ITEMS: WorkspaceConfigItem[] = WORKSPACE_CONFIG_GROUPS.flatMap(
  (group) => group.items,
).filter((item) => item.to !== "/workspaces/$workspaceId/settings");

export function filterWorkspaceConfigGroups(
  groups: WorkspaceConfigGroup[],
  canReadInsights: boolean,
  sitesEnabled = false,
  advancedDeploymentsEnabled = false,
): WorkspaceConfigGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!item.requiresAdmin || canReadInsights) &&
          (item.feature !== "sites" || sitesEnabled) &&
          (item.feature !== "advancedDeployments" || advancedDeploymentsEnabled),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

export function filterWorkspaceItemsByFeatures(
  items: WorkspaceConfigItem[],
  sitesEnabled = false,
  advancedDeploymentsEnabled = false,
): WorkspaceConfigItem[] {
  return items.filter(
    (item) =>
      (item.feature !== "sites" || sitesEnabled) &&
      (item.feature !== "advancedDeployments" || advancedDeploymentsEnabled),
  );
}

function configPathSuffix(to: WorkspaceConfigTarget): string {
  const parts = to.split("/");
  return parts[parts.length - 1] ?? "";
}

export function isWorkspaceConfigPath(pathname: string, workspaceId: string): boolean {
  const prefix = `/workspaces/${workspaceId}/`;
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length).split("/")[0] ?? "";
  return WORKSPACE_CONFIG_GROUPS.some((group) =>
    group.items.some((item) => configPathSuffix(item.to) === rest),
  );
}

export function isConfigItemActive(
  pathname: string,
  workspaceId: string,
  to: WorkspaceConfigTarget,
): boolean {
  return pathname === `/workspaces/${workspaceId}/${configPathSuffix(to)}`;
}
