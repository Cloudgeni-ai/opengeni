// Main rail destination catalog (routes, labels, icon keys). Rendering lives in
// `workspace-config-link.tsx`.
import type { RailDestinationId } from "@/lib/rail-destinations";

export type WorkspaceConfigTarget =
  | "/workspaces/$workspaceId/agents"
  | "/workspaces/$workspaceId/insights"
  | "/workspaces/$workspaceId/variable-sets"
  | "/workspaces/$workspaceId/rigs"
  | "/workspaces/$workspaceId/machines"
  | "/workspaces/$workspaceId/plugins"
  | "/workspaces/$workspaceId/schedules"
  | "/workspaces/$workspaceId/state"
  | "/workspaces/$workspaceId/artifacts"
  | "/workspaces/$workspaceId/settings";

export type WorkspaceConfigIcon =
  | "gauge"
  | "bar-chart"
  | "network"
  | "box"
  | "server-cog"
  | "laptop"
  | "brain-circuit"
  | "map"
  | "plug"
  | "calendar-clock"
  | "panels-top-left"
  | "settings";

export type WorkspaceConfigItem = {
  /** Stable id for the rail customization; Settings is always shown. */
  id: RailDestinationId | "settings";
  to: WorkspaceConfigTarget;
  icon: WorkspaceConfigIcon;
  label: string;
  description: string;
  /** When true, only include for subjects with workspace:admin. */
  requiresAdmin?: boolean;
};

/**
 * The workspace destinations beside New session and For you. Every destination
 * once, with one name and one icon (the same icon as its page header). Settings
 * is the last entry and always shown; the rest can be moved under More.
 */
export const PRIMARY_WORKSPACE_ITEMS: WorkspaceConfigItem[] = [
  {
    id: "agents",
    to: "/workspaces/$workspaceId/agents",
    icon: "network",
    label: "Agents",
    description: "Every workstream in this workspace, live",
  },
  {
    id: "schedules",
    to: "/workspaces/$workspaceId/schedules",
    icon: "calendar-clock",
    label: "Schedules",
    description: "Run agents on a schedule",
  },
  {
    id: "artifacts",
    to: "/workspaces/$workspaceId/artifacts",
    icon: "panels-top-left",
    label: "Artifacts",
    description: "Sites, images, documents, and files built with Geni",
  },
  {
    id: "knowledge",
    to: "/workspaces/$workspaceId/state",
    icon: "brain-circuit",
    label: "Knowledge",
    description: "Knowledge, instructions, and skills",
  },
  {
    id: "capabilities",
    to: "/workspaces/$workspaceId/plugins",
    icon: "plug",
    label: "Capabilities",
    description: "Plugins, Skills, and integrations",
  },
  {
    id: "insights",
    to: "/workspaces/$workspaceId/insights",
    icon: "bar-chart",
    label: "Insights",
    description: "Usage and spend for this workspace",
    requiresAdmin: true,
  },
  {
    id: "settings",
    to: "/workspaces/$workspaceId/settings",
    icon: "settings",
    label: "Settings",
    description: "General, access, models, API keys and runtime",
  },
];

/** Rail entries this viewer can open: Insights is for workspace admins. */
export function primaryWorkspaceItemsFor(canReadInsights: boolean): WorkspaceConfigItem[] {
  return PRIMARY_WORKSPACE_ITEMS.filter((item) => !item.requiresAdmin || canReadInsights);
}

/** Routes that open inside the settings frame, so the rail's Settings entry is current. */
const SETTINGS_FRAME_SEGMENTS = ["settings", "variable-sets", "rigs", "machines", "organization"];

export function isWorkspaceSettingsPath(pathname: string, workspaceId: string): boolean {
  const prefix = `/workspaces/${workspaceId}/`;
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length).split("/")[0] ?? "";
  return SETTINGS_FRAME_SEGMENTS.includes(rest);
}

function configPathSuffix(to: WorkspaceConfigTarget): string {
  const parts = to.split("/");
  return parts[parts.length - 1] ?? "";
}

export function isConfigItemActive(
  pathname: string,
  workspaceId: string,
  to: WorkspaceConfigTarget,
): boolean {
  if (to === "/workspaces/$workspaceId/settings") {
    return isWorkspaceSettingsPath(pathname, workspaceId);
  }
  const destination = `/workspaces/${workspaceId}/${configPathSuffix(to)}`;
  return pathname === destination || pathname.startsWith(`${destination}/`);
}
