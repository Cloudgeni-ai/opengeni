// Workspace destination catalog (routes, labels, icon keys). Rendering lives in
// `workspace-config-link.tsx`.

export type WorkspaceConfigTarget =
  | "/workspaces/$workspaceId/get-started"
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
  | "/workspaces/$workspaceId/apps"
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
  | "app-window"
  | "rocket"
  | "settings";

export type WorkspaceConfigItem = {
  to: WorkspaceConfigTarget;
  /** Search the link carries: Apps is the Artifacts page's Apps tab. */
  search?: { kind: "site" };
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

/** Product destinations promoted to the primary rail beside New session. */
export const PRIMARY_WORKSPACE_ITEMS: WorkspaceConfigItem[] = [
  {
    to: "/workspaces/$workspaceId/plugins",
    icon: "plug",
    label: "Capabilities",
    description: "Plugins, Skills, and connected tools",
  },
  {
    to: "/workspaces/$workspaceId/state",
    icon: "brain-circuit",
    label: "Knowledge",
    description: "Knowledge, instructions, and agent learning",
  },
  {
    to: "/workspaces/$workspaceId/automations",
    icon: "zap",
    label: "Automations",
    description: "Run tasks on a schedule or when something happens",
  },
  {
    to: "/workspaces/$workspaceId/agents",
    icon: "bot",
    label: "Agents",
    description: "Named agents you can chat with here and in Slack",
  },
  {
    to: "/workspaces/$workspaceId/meetings",
    icon: "audio-lines",
    label: "Meetings",
    description: "Record meetings and read who said what",
  },
  {
    to: "/workspaces/$workspaceId/artifacts",
    icon: "panels-top-left",
    label: "Artifacts",
    description: "Images, documents, and files built with {product}",
  },
];

/** Apps: installed apps and ready-made ones to add, up front in the rail. */
export const APPS_WORKSPACE_ITEM: WorkspaceConfigItem = {
  to: "/workspaces/$workspaceId/apps",
  icon: "app-window",
  label: "Apps",
  description: "Your team's apps, and ready-made ones to add",
};

/** The guided setups, first under Setup in the full console. */
export const GET_STARTED_WORKSPACE_ITEM: WorkspaceConfigItem = {
  to: "/workspaces/$workspaceId/get-started",
  icon: "rocket",
  label: "Get started",
  description: "Guided setups that end with an agent at work",
};

/** A rail entry's identity. */
export function navItemKey(item: Pick<WorkspaceConfigItem, "to" | "search">): string {
  return item.search ? `${item.to}?kind=${item.search.kind}` : item.to;
}

/**
 * The full console's rail: Agents and Apps up front (after Inbox), and
 * everything that sets the workspace up under one Setup group. Nothing is
 * left out; each page keeps its own address.
 */
const FULL_FRONT_TARGETS: readonly WorkspaceConfigTarget[] = ["/workspaces/$workspaceId/agents"];
const FULL_SETUP_TARGETS: readonly WorkspaceConfigTarget[] = [
  "/workspaces/$workspaceId/plugins",
  "/workspaces/$workspaceId/automations",
  "/workspaces/$workspaceId/state",
  "/workspaces/$workspaceId/artifacts",
  "/workspaces/$workspaceId/meetings",
];

function itemsFor(targets: readonly WorkspaceConfigTarget[]): WorkspaceConfigItem[] {
  return targets.flatMap((to) => PRIMARY_WORKSPACE_ITEMS.filter((item) => item.to === to));
}

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
  "/workspaces/$workspaceId/state",
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

/**
 * The rail destinations the interface lists at the top level: Agents and
 * Apps in the full console; in the simplified interface, the catalog order
 * less what it leaves out or folds away.
 */
export function primaryWorkspaceItems(simplified: boolean): WorkspaceConfigItem[] {
  if (!simplified) return [...itemsFor(FULL_FRONT_TARGETS), APPS_WORKSPACE_ITEM];
  return PRIMARY_WORKSPACE_ITEMS.filter(
    (item) =>
      interfaceListsDestination(simplified, item.to) &&
      !SIMPLIFIED_ADVANCED_DESTINATIONS.has(item.to),
  ).flatMap((item) =>
    item.to === "/workspaces/$workspaceId/artifacts" ? [APPS_WORKSPACE_ITEM, item] : [item],
  );
}

/**
 * The rail's one folded group: "Setup" in the full console (Get started,
 * Capabilities, Automations, Knowledge, Artifacts, Meetings), "Advanced"
 * in the simplified interface (Knowledge, Automations).
 */
export function groupedWorkspaceItems(simplified: boolean): {
  label: string;
  items: WorkspaceConfigItem[];
} {
  return simplified
    ? {
        label: "Advanced",
        items: PRIMARY_WORKSPACE_ITEMS.filter((item) =>
          SIMPLIFIED_ADVANCED_DESTINATIONS.has(item.to),
        ),
      }
    : { label: "Setup", items: [GET_STARTED_WORKSPACE_ITEM, ...itemsFor(FULL_SETUP_TARGETS)] };
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

/**
 * Whether a rail entry is the page you are on. Apps is its page, an app's own
 * view (`/sites/…`) and an app's details (`/artifacts/<id>?kind=site`);
 * Artifacts is the rest of the Artifacts page.
 */
export function isNavItemActive(
  location: { pathname: string; kind?: string | undefined },
  workspaceId: string,
  item: Pick<WorkspaceConfigItem, "to" | "search">,
): boolean {
  const artifacts = `/workspaces/${workspaceId}/artifacts`;
  const onApps =
    location.pathname === `/workspaces/${workspaceId}/apps` ||
    location.pathname.startsWith(`/workspaces/${workspaceId}/sites/`) ||
    ((location.pathname === artifacts || location.pathname.startsWith(`${artifacts}/`)) &&
      location.kind === "site");
  if (item.to === "/workspaces/$workspaceId/apps") return onApps;
  if (item.to === "/workspaces/$workspaceId/artifacts")
    return !onApps && isConfigItemActive(location.pathname, workspaceId, item.to);
  return isConfigItemActive(location.pathname, workspaceId, item.to);
}

/** Routes that belong to a section under another path. */
const SECTION_ALIASES: Readonly<Record<string, WorkspaceConfigTarget>> = {
  sites: "/workspaces/$workspaceId/apps",
  schedules: "/workspaces/$workspaceId/automations",
  memory: "/workspaces/$workspaceId/state",
  documents: "/workspaces/$workspaceId/state",
  "bot-templates": "/workspaces/$workspaceId/agents",
};

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
  const items = [
    ...PRIMARY_WORKSPACE_ITEMS,
    APPS_WORKSPACE_ITEM,
    GET_STARTED_WORKSPACE_ITEM,
    ...WORKSPACE_BROWSE_ITEMS,
  ];
  const target = SECTION_ALIASES[first];
  const item = items.find((each) =>
    target ? each.to === target : configPathSuffix(each.to) === first,
  );
  return item ? { label: item.label, path: `${prefix}${configPathSuffix(item.to)}` } : null;
}
