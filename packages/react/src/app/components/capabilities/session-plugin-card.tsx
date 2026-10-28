/**
 * The card an agent posts to offer a marketplace plugin (a bundle of Skills
 * and MCP servers). The person reviews what it adds and installs it for the
 * workspace here, through the same preview-then-install flow as Capabilities;
 * then the agent is told to carry on. Its MCP servers may still need
 * connecting, which the agent offers with their own cards.
 */
import { useEffect, useRef, useState } from "react";
import { pluginMcpUnavailableReason } from "@opengeni/contracts/plugin-discovery";
import type { PluginDiscoveryItem } from "@opengeni/sdk";

import { SessionCapabilityFrame } from "../../../components/session-capability-frame";
import { PluginDetails } from "../../../plugin-details";
import { userErrorText } from "../../../ui/api-error";
import type { AuthNeededItem } from "../../../timeline";
import { useAppContext } from "../../app-context";
import { continueAfterCapabilitySetup } from "./attach-session-capability";

const PREFIX = "plugin:marketplace/";

/** The discovery id (`openai:linear`) behind a plugin capability id, or null. */
export function pluginDiscoveryId(capabilityId: string): string | null {
  if (!capabilityId.startsWith(PREFIX)) return null;
  const [provider, name, ...rest] = capabilityId.slice(PREFIX.length).split("/");
  return provider && name && rest.length === 0 ? `${provider}:${name}` : null;
}

type Loaded =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "ready"; item: PluginDiscoveryItem; installed: boolean };

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "By Sentry · 2 Skills · 1 MCP server": who made it and what installing it
 * adds, by the install flow's rule.
 */
export function pluginSubtitle(item: PluginDiscoveryItem): string {
  const skills = item.skills?.length ?? 0;
  const servers = (item.mcpServers ?? []).filter(
    (server) => pluginMcpUnavailableReason(server) === null,
  ).length;
  return [
    item.author?.name ? `By ${item.author.name}` : "",
    skills ? count(skills, "Skill", "Skills") : "",
    servers ? count(servers, "MCP server", "MCP servers") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SessionPluginCapabilityCard({
  item,
  workspaceId,
  sessionId,
  onConfigured,
}: {
  item: AuthNeededItem;
  workspaceId: string;
  sessionId: string;
  onConfigured?: (() => Promise<void>) | undefined;
}) {
  const { client } = useAppContext();
  const capability = item.capability!;
  const discoveryId = pluginDiscoveryId(capability.id);
  const pluginKey = capability.id.slice("plugin:".length);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!discoveryId) {
      setLoaded({ state: "missing" });
      return;
    }
    let live = true;
    Promise.all([
      client.discoverPlugins(workspaceId, { id: discoveryId }),
      client.listInstalledPlugins(workspaceId).catch(() => ({ plugins: [] })),
    ]).then(
      ([page, installed]) => {
        if (!live) return;
        const plugin = page.items.find((entry) => entry.id === discoveryId);
        if (!plugin) {
          setLoaded({ state: "missing" });
          return;
        }
        const already = installed.plugins.some((entry) => entry.pluginKey === pluginKey);
        setLoaded({ state: "ready", item: plugin, installed: already });
        if (already) setComplete(true);
      },
      () => {
        if (live) setLoaded({ state: "missing" });
      },
    );
    return () => {
      live = false;
    };
  }, [client, discoveryId, pluginKey, workspaceId]);

  const plugin = loaded.state === "ready" ? loaded.item : null;
  const name = (plugin?.displayName ?? capability.name).replace(/-/g, " ");

  const install = async () => {
    if (!plugin?.sourceUrl || busy) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await client.previewPlugin(workspaceId, {
        url: plugin.sourceUrl,
        bindings: {},
      });
      await client.installPlugin(workspaceId, {
        url: plugin.sourceUrl,
        bindings: {},
        expectedManifestDigest: preview.manifestDigest,
        expectedComponents: preview.components.map((component) => ({
          key: component.key,
          digest: component.digest,
        })),
        idempotencyKey: crypto.randomUUID(),
        ...(preview.installationVersion !== null
          ? { expectedInstallationVersion: preview.installationVersion }
          : {}),
      });
      setComplete(true);
      setExpanded(false);
      await onConfigured?.();
      continueAfterCapabilitySetup(client, workspaceId, sessionId, capability.id);
    } catch (cause) {
      setError(userErrorText(cause, "Couldn't install the plugin."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SessionCapabilityFrame
      name={name}
      subtitle={(plugin && pluginSubtitle(plugin)) || item.providerDomain}
      logo={plugin?.logoUrl ?? null}
      typeLabel="Plugin"
      description={capability.rationale || plugin?.description || ""}
      clampDescription={Boolean(capability.rationale)}
      skill={false}
      expanded={expanded}
      complete={complete}
      completeLabel="Installed in this workspace."
      actionLabel="Review plugin"
      note="Installing adds its Skills and MCP servers to this workspace for everyone. You can remove it in Capabilities."
      actionUnavailable={
        loaded.state === "missing"
          ? "This plugin isn't available here anymore. Ask the agent to search again."
          : undefined
      }
      busy={busy || loaded.state === "loading"}
      opener={opener}
      onOpen={() => {
        setError(null);
        setExpanded(true);
      }}
      onClose={() => setExpanded(false)}
    >
      {plugin ? (
        <PluginDetails
          item={plugin}
          showIdentity={false}
          busy={busy}
          installed={complete}
          error={error}
          onInstall={() => void install()}
        />
      ) : null}
    </SessionCapabilityFrame>
  );
}
