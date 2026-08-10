// Workspace destination catalog (routes, labels, icon keys). Rendering lives in
// `workspace-config-link.tsx`.

export type WorkspaceConfigTarget =
  | "/workspaces/$workspaceId/insights"
  | "/workspaces/$workspaceId/variable-sets"
  | "/workspaces/$workspaceId/rigs"
  | "/workspaces/$workspaceId/machines"
  | "/workspaces/$workspaceId/capabilities"
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
};

export type WorkspaceConfigGroup = {
  id: string;
  label: string;
  items: WorkspaceConfigItem[];
};

export const WORKSPACE_CONFIG_GROUPS: WorkspaceConfigGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
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
        to: "/workspaces/$workspaceId/documents",
        icon: "file-search",
        label: "Documents",
        description: "Indexed knowledge for agents",
      },
      {
        to: "/workspaces/$workspaceId/memory",
        icon: "brain-circuit",
        label: "Memory",
        description: "Durable facts agents carry across sessions",
      },
      {
        to: "/workspaces/$workspaceId/state",
        icon: "map",
        label: "Agent Brain",
        description: "What agents always know and retrieve",
      },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    items: [
      {
        to: "/workspaces/$workspaceId/capabilities",
        icon: "plug",
        label: "Capabilities",
        description: "Packs, MCP servers, and tools",
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
        description: "Live pages and tools built with Geni",
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
        label: "General, members & keys",
        description: "Name, API keys, members, and Codex subscriptions",
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
): WorkspaceConfigGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.requiresAdmin || canReadInsights),
    }))
    .filter((group) => group.items.length > 0);
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
