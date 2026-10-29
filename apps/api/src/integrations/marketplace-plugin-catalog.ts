import {
  CapabilityCatalogItem,
  mcpEndpointIdentity,
  pluginMcpUnavailableReason,
  type PluginDiscoveryItem,
} from "@opengeni/contracts";
import { listInstalledPluginPackages, type Database } from "@opengeni/db";
import snapshot from "../../../../data/catalog/plugins-snapshot.json";

/**
 * The marketplace plugins this deployment indexes, as discovery reads them and
 * as integration catalogue entries for agents. A plugin's capability id is
 * `plugin:` and the key it installs under (`plugin:marketplace/openai/linear`),
 * the namespace the workspace catalogue reserves for plugins, so an agent
 * finds one with capability_catalog_search and offers it with
 * capability_authorization_request like any other integration. Installing it
 * stays the person's step, on the card, through the plugin package flow.
 */

export const PLUGIN_CAPABILITY_ID_PREFIX = "plugin:";

/** Every indexed plugin, by display name. */
export const discoverablePlugins: readonly (PluginDiscoveryItem & {
  keywords: string[];
  homepage: string | null;
})[] = snapshot.sources
  .flatMap((source) =>
    source.entries.map((entry) => ({
      ...entry,
      provider: source.provider,
      keywords: entry.keywords ?? [],
      homepage: entry.homepage ?? null,
    })),
  )
  .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));

function pluginKey(item: Pick<PluginDiscoveryItem, "provider" | "name">): string {
  return `marketplace/${item.provider}/${item.name}`;
}

/** The plugin's capability id. */
export function pluginCapabilityId(item: Pick<PluginDiscoveryItem, "provider" | "name">): string {
  return PLUGIN_CAPABILITY_ID_PREFIX + pluginKey(item);
}

/** What installing it adds, by the same rule the install flow uses. */
function installableParts(item: PluginDiscoveryItem): {
  skills: string[];
  servers: string[];
  endpoints: string[];
} {
  const servers = (item.mcpServers ?? []).filter(
    (server) => pluginMcpUnavailableReason(server) === null,
  );
  return {
    skills: (item.skills ?? []).map((skill) => skill.name),
    servers: servers.map((server) => server.name),
    endpoints: servers.flatMap((server) => {
      const key = mcpConnectionEndpointKey(server.endpoint);
      return key ? [key] : [];
    }),
  };
}

/**
 * How a plugin's MCP server and a catalogue connection are recognised as the
 * same endpoint: the endpoint identity without a trailing slash.
 */
export function mcpConnectionEndpointKey(url: string | null | undefined): string | null {
  const identity = mcpEndpointIdentity(url);
  return identity ? identity.replace(/\/+$/u, "") : null;
}

/** The endpoint keys of the MCP servers installing this plugin would add. */
export function pluginMcpEndpointKeys(item: CapabilityCatalogItem): string[] {
  const endpoints = item.metadata.mcpEndpoints;
  return Array.isArray(endpoints)
    ? endpoints.filter((endpoint): endpoint is string => typeof endpoint === "string")
    : [];
}

function hostname(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function catalogItem(
  item: (typeof discoverablePlugins)[number],
  installed: boolean,
): CapabilityCatalogItem {
  const parts = installableParts(item);
  const contents = [
    parts.skills.length
      ? `${parts.skills.length} Skill${parts.skills.length === 1 ? "" : "s"}`
      : "",
    parts.servers.length
      ? `${parts.servers.length} MCP server${parts.servers.length === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const summary = item.description.trim().replace(/(?<![.!?])$/u, ".");
  return CapabilityCatalogItem.parse({
    id: pluginCapabilityId(item),
    kind: "plugin",
    source: "public_registry",
    name: item.displayName.replace(/-/g, " "),
    description: `${summary === "." ? "" : `${summary} `}Plugin with ${contents}.`,
    category: item.category?.toLowerCase() || "plugin",
    tags: [...new Set(["plugin", ...item.keywords, ...parts.skills, ...parts.servers])]
      .filter((tag) => tag.trim().length > 0)
      .slice(0, 32),
    homepageUrl: item.homepage,
    providerDomain: hostname(item.homepage),
    authKind: "none",
    surfaceType: "plugin_package",
    runtime: { available: true, notes: null },
    lifecycle: {
      status: "available",
      readiness: installed ? "ready" : "setup_required",
      detail: null,
      managedBy: "workspace",
    },
    actions: ["install", "inspect"],
    enabled: installed,
    metadata: {
      pluginKey: pluginKey(item),
      discoveryId: item.id,
      provider: item.provider,
      skills: parts.skills,
      mcpServers: parts.servers,
      mcpEndpoints: parts.endpoints,
      recommendationOnly: true,
    },
  });
}

let notInstalledItems: { key: string; item: CapabilityCatalogItem }[] | undefined;

/** The indexed plugins that install something, as catalogue entries for this workspace. */
export async function marketplacePluginCapabilityItems(
  db: Database,
  workspaceId: string,
): Promise<CapabilityCatalogItem[]> {
  return pluginCapabilityItems(
    new Set((await listInstalledPluginPackages(db, workspaceId)).map((plugin) => plugin.pluginKey)),
  );
}

/** The catalogue entries, given the plugin keys installed in the workspace. */
export function pluginCapabilityItems(installed: ReadonlySet<string>): CapabilityCatalogItem[] {
  // The index is fixed for the life of the process; only installs vary.
  notInstalledItems ??= discoverablePlugins
    .filter((item) => {
      const parts = installableParts(item);
      return parts.skills.length + parts.servers.length > 0;
    })
    .map((item) => ({ key: pluginKey(item), item: catalogItem(item, false) }));
  return notInstalledItems.map(({ key, item }) =>
    installed.has(key)
      ? { ...item, enabled: true, lifecycle: { ...item.lifecycle, readiness: "ready" } }
      : item,
  );
}

/** One plugin's catalogue entry, or undefined when the id names none. */
export async function marketplacePluginCapabilityItem(
  db: Database,
  workspaceId: string,
  capabilityId: string,
): Promise<CapabilityCatalogItem | undefined> {
  if (!capabilityId.startsWith(PLUGIN_CAPABILITY_ID_PREFIX)) return undefined;
  return (await marketplacePluginCapabilityItems(db, workspaceId)).find(
    (item) => item.id === capabilityId,
  );
}

/**
 * How an agent sees a plugin's setup: installed, or for a person to install
 * from its card. A plugin installs for the whole workspace; when the catalogue
 * also offers its MCP server as a connection, a request about the person's own
 * account (their mailbox, calendar or files) needs that connection, so an
 * uninstalled plugin's setup names it.
 */
export function pluginCapabilitySetup(
  item: CapabilityCatalogItem,
  connections: readonly { capabilityId: string; name: string }[] = [],
):
  | { status: "ready"; action: null; detail: string }
  | { status: "authorization_required"; action: "enable"; detail: string } {
  if (item.enabled)
    return {
      status: "ready",
      action: null,
      detail: `The ${item.name} plugin is installed in this workspace. Its Skills are available; if you need its MCP servers' tools and they are not in this chat, search the catalog for them.`,
    };
  const named = connections
    .map((connection) => `the ${connection.name} connection (${connection.capabilityId})`)
    .join(" or ");
  return {
    status: "authorization_required",
    action: "enable",
    detail:
      `Not installed. The person can review what the ${item.name} plugin adds and install it for the workspace from its card.` +
      (named
        ? ` For the person's own account, offer ${named} instead: call capability_authorization_request with its capabilityId. Installing the plugin is for everyone in the workspace.`
        : ""),
  };
}
