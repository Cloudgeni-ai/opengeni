// Workspace destination catalog (routes, labels, icon keys). Rendering lives in
// `workspace-config-link.tsx`.

export type WorkspaceConfigTarget =
  | "/workspaces/$workspaceId/insights"
  | "/workspaces/$workspaceId/secrets"
  | "/workspaces/$workspaceId/rigs"
  | "/workspaces/$workspaceId/machines"
  | "/workspaces/$workspaceId/plugins"
  | "/workspaces/$workspaceId/automations"
  | "/workspaces/$workspaceId/agents"
  | "/workspaces/$workspaceId/meetings"
  | "/workspaces/$workspaceId/state"
  | "/workspaces/$workspaceId/artifacts"
  | "/workspaces/$workspaceId/settings";

export type WorkspaceConfigIcon =
  | "gauge"
  | "box"
  | "lock-keyhole"
  | "server-cog"
  | "laptop"
  | "brain-circuit"
  | "plug"
  | "zap"
  | "bot"
  | "audio-lines"
  | "panels-top-left"
  | "settings";

export type WorkspaceConfigItem = {
  to: WorkspaceConfigTarget;
  icon: WorkspaceConfigIcon;
  label: string;
  /** Its tooltip; `{product}` is the name people know the product by (`itemDescription`). */
  description: string;
  /** When true, only include for subjects with workspace:admin. */
  requiresAdmin?: boolean;
};

export type WorkspaceConfigGroup = {
  id: string;
  label: string;
  items: WorkspaceConfigItem[];
};

const CAPABILITIES_ITEM: WorkspaceConfigItem = {
  to: "/workspaces/$workspaceId/plugins",
  icon: "plug",
  label: "Capabilities",
  description: "Connections, skills, plugins, and knowledge",
};

/**
 * Knowledge is a tab of Capabilities. The simplified interface, whose
 * Capabilities page shows only connections, lists it under "Advanced".
 */
export const KNOWLEDGE_WORKSPACE_ITEM: WorkspaceConfigItem = {
  to: "/workspaces/$workspaceId/state",
  icon: "brain-circuit",
  label: "Knowledge",
  description: "Knowledge, instructions, and agent learning",
};

const AUTOMATIONS_ITEM: WorkspaceConfigItem = {
  to: "/workspaces/$workspaceId/automations",
  icon: "zap",
  label: "Automations",
  description: "Run tasks on a schedule or when something happens",
};

/** Listed in settings; the rail shows it only while a meeting is being recorded. */
export const MEETINGS_WORKSPACE_ITEM: WorkspaceConfigItem = {
  to: "/workspaces/$workspaceId/meetings",
  icon: "audio-lines",
  label: "Meetings",
  description: "Record meetings and read who said what",
};

/** Product destinations promoted to the primary rail beside New session. */
export const PRIMARY_WORKSPACE_ITEMS: WorkspaceConfigItem[] = [
  CAPABILITIES_ITEM,
  AUTOMATIONS_ITEM,
  {
    to: "/workspaces/$workspaceId/agents",
    icon: "bot",
    label: "Agents",
    description: "Named agents you can chat with here and in Slack",
  },
  {
    to: "/workspaces/$workspaceId/artifacts",
    icon: "panels-top-left",
    label: "Artifacts",
    description: "Apps, images, documents, and files built with {product}",
  },
];

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
        to: "/workspaces/$workspaceId/secrets",
        icon: "lock-keyhole",
        label: "Secrets",
        description: "Logins, keys and files agents use without seeing them",
      },
      {
        to: "/workspaces/$workspaceId/rigs",
        icon: "server-cog",
        label: "Sandbox Environments",
        description: "Custom sandbox setup and health checks",
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

/** A destination's tooltip, naming the product the way the current interface does. */
export function itemDescription(
  item: Pick<WorkspaceConfigItem, "description">,
  productName: string,
) {
  return item.description.replaceAll("{product}", productName);
}

/**
 * What the simplified interface leaves out of its navigation. It is for people
 * using the product, not running or building on it, so its rail and settings list
 * only what such a team needs: chats and what they produce, the workspace and
 * its members, the organization and its people, billing and sign-in security.
 * Models are not listed at all, because every chat there runs one model on
 * credits (see `@opengeni/react/app/lib/simplified-interface-model`).
 *
 * This only shortens the lists: each page still opens by its address, by
 * settings search and by links elsewhere in the app, and no permission
 * depends on it. Turning "Simplified interface" off in the account menu lists
 * everything.
 */
const SIMPLIFIED_UNLISTED_DESTINATIONS: ReadonlySet<WorkspaceConfigTarget> = new Set([
  "/workspaces/$workspaceId/meetings",
  "/workspaces/$workspaceId/insights",
  "/workspaces/$workspaceId/secrets",
  "/workspaces/$workspaceId/rigs",
  "/workspaces/$workspaceId/machines",
]);

/** Destinations the simplified interface keeps but folds under "Advanced" in the rail. */
const SIMPLIFIED_ADVANCED_DESTINATIONS: ReadonlySet<WorkspaceConfigTarget> = new Set([
  "/workspaces/$workspaceId/automations",
]);

/** Workspace settings sections (and "My things") the simplified interface leaves out of the settings rail. */
const SIMPLIFIED_UNLISTED_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  "available",
  "learning",
  "usage",
  "api-keys",
  "developer",
  "mine",
]);

/** Organization settings pages the simplified interface leaves out of the settings rail. */
const SIMPLIFIED_UNLISTED_ORGANIZATION_SECTIONS: ReadonlySet<string> = new Set([
  "workspaces",
  "identity",
  "shared",
  "models",
  "integrations",
  "agents",
  "insights",
  "developer",
  "security",
]);

/** Whether the interface lists a destination in its navigation. */
export function interfaceListsDestination(simplified: boolean, to: string): boolean {
  return !simplified || !SIMPLIFIED_UNLISTED_DESTINATIONS.has(to as WorkspaceConfigTarget);
}

/** Whether the interface lists a workspace settings section in the settings rail. */
export function interfaceListsSettingsSection(simplified: boolean, section: string): boolean {
  return !simplified || !SIMPLIFIED_UNLISTED_SETTINGS_SECTIONS.has(section);
}

/** Whether the interface lists an organization settings page in the settings rail. */
export function interfaceListsOrganizationSection(simplified: boolean, section: string): boolean {
  return !simplified || !SIMPLIFIED_UNLISTED_ORGANIZATION_SECTIONS.has(section);
}

/** The rail destinations the interface lists at the top level, in catalog order. */
export function primaryWorkspaceItems(simplified: boolean): WorkspaceConfigItem[] {
  return PRIMARY_WORKSPACE_ITEMS.filter(
    (item) =>
      interfaceListsDestination(simplified, item.to) &&
      !(simplified && SIMPLIFIED_ADVANCED_DESTINATIONS.has(item.to)),
  );
}

/** The rail destinations the interface folds under "Advanced": none in the full console. */
export function advancedWorkspaceItems(simplified: boolean): WorkspaceConfigItem[] {
  return simplified
    ? [
        KNOWLEDGE_WORKSPACE_ITEM,
        ...PRIMARY_WORKSPACE_ITEMS.filter((item) => SIMPLIFIED_ADVANCED_DESTINATIONS.has(item.to)),
      ]
    : [];
}

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
  const destination = `/workspaces/${workspaceId}/${configPathSuffix(to)}`;
  return pathname === destination || pathname.startsWith(`${destination}/`);
}

/** Routes that belong to a section under another path. */
const SECTION_ALIASES: Readonly<Record<string, WorkspaceConfigTarget>> = {
  sites: "/workspaces/$workspaceId/artifacts",
  schedules: "/workspaces/$workspaceId/automations",
  // Knowledge is a tab of Capabilities.
  state: "/workspaces/$workspaceId/plugins",
  memory: "/workspaces/$workspaceId/plugins",
  documents: "/workspaces/$workspaceId/plugins",
  "bot-templates": "/workspaces/$workspaceId/agents",
};

/**
 * The one listed rail item a page belongs to: the item for its own address,
 * else the item of the section it is in (Knowledge is in Capabilities).
 */
export function activeRailItem(
  pathname: string,
  workspaceId: string,
  items: readonly WorkspaceConfigItem[],
): WorkspaceConfigTarget | null {
  const exact = items.find((item) => isConfigItemActive(pathname, workspaceId, item.to));
  if (exact) return exact.to;
  const prefix = `/workspaces/${workspaceId}/`;
  if (!pathname.startsWith(prefix)) return null;
  const alias = SECTION_ALIASES[pathname.slice(prefix.length).split("/")[0] ?? ""];
  return alias && items.some((item) => item.to === alias) ? alias : null;
}

/**
 * The rail section a workspace page is in, by the same names as the rail:
 * "/workspaces/w/agents/a1" is in Agents. Null for chats and pages outside
 * every section.
 */
export function workspaceSectionForPath(
  pathname: string,
  workspaceId: string,
): { label: string; path: string } | null {
  const prefix = `/workspaces/${workspaceId}/`;
  if (!pathname.startsWith(prefix)) return null;
  const first = pathname.slice(prefix.length).split("/")[0] ?? "";
  const items = [...PRIMARY_WORKSPACE_ITEMS, MEETINGS_WORKSPACE_ITEM, ...WORKSPACE_BROWSE_ITEMS];
  const target = SECTION_ALIASES[first];
  const item = items.find((each) =>
    target ? each.to === target : configPathSuffix(each.to) === first,
  );
  return item ? { label: item.label, path: `${prefix}${configPathSuffix(item.to)}` } : null;
}
