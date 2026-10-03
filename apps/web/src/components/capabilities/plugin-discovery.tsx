import {
  mcpEndpointIdentity,
  type CapabilityCatalogItem,
  type PluginInstallationSummary,
} from "@opengeni/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectionInstalled, PluginDiscovery as Catalog } from "@opengeni/react/connect";
import { BoxesIcon } from "lucide-react";
import type { PluginDiscoveryItem } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { CapabilityMark } from "./capability-page";
import { CapabilitySlotPage, useCapabilityPageSlot } from "./capability-page-slot";
import { PluginPage, type PluginManageActions } from "./plugin-page";
import { humanizeName } from "./skill-copy";
import { userErrorText } from "@/lib/api-error";

const EMPTY_INSTALLED_PLUGINS: PluginInstallationSummary[] = [];

export function PluginDiscovery({
  client,
  workspaceId,
  query,
  canManage = false,
  beforeCatalog,
  resultLimit,
  onShowMore,
  onChanged,
  onOpenConnection,
  onManageInstalled,
  manage,
  installedPlugins = EMPTY_INSTALLED_PLUGINS,
}: {
  /** Update and remove for an installed plugin, shown on its page. */
  manage?: ((plugin: PluginInstallationSummary) => PluginManageActions) | undefined;
  beforeCatalog?: ReactNode;
  resultLimit?: number;
  onShowMore?: () => void;
  installedPlugins?: PluginInstallationSummary[];
  onOpenConnection?: (item: CapabilityCatalogItem) => void;
  onManageInstalled?: (plugin: PluginInstallationSummary, opener: HTMLElement) => void;
  canManage?: boolean;
  onChanged?: () => void;
  client: OpenGeniBrowserClient;
  workspaceId: string;
  query: string;
}) {
  const slot = useCapabilityPageSlot();
  const [selected, setSelectedState] = useState<PluginDiscoveryItem | null>(null);
  // The plugin page lives in the route's page slot (`?open=plugin:<id>`).
  function setSelected(item: PluginDiscoveryItem | null) {
    setSelectedState(item);
    if (item) {
      if (slot && slot.openKey !== `plugin:${item.id}`) slot.open(`plugin:${item.id}`);
    } else if (slot?.openKey?.startsWith("plugin:")) {
      slot.close();
    }
  }
  const slotKey = slot?.openKey ?? null;
  useEffect(() => {
    if (!slot) return;
    if (!slotKey?.startsWith("plugin:")) {
      // Keep the plugin while one of its connections is open, so Back returns to it.
      if (!slotKey && selected) setSelectedState(null);
      return;
    }
    if (selected && slotKey === `plugin:${selected.id}`) return;
    // A reload or a shared link: only installed plugins can be looked up again.
    const id = slotKey.slice("plugin:".length);
    const plugin = installedPlugins.find(
      (candidate) =>
        candidate.pluginKey.startsWith("marketplace/") &&
        candidate.pluginKey.slice("marketplace/".length).replace("/", ":") === id,
    );
    if (plugin) void openInstalled(plugin);
    else if (!selected) slot.close({ replace: true });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- follows the URL only
  }, [slotKey]);
  const [selectedInstallation, setSelectedInstallation] =
    useState<PluginInstallationSummary | null>(null);
  const [connections, setConnections] = useState<CapabilityCatalogItem[]>([]);
  useEffect(() => {
    let active = true;
    void client
      .listCapabilities(workspaceId)
      .then((page) => {
        if (active) setConnections(page.items);
      })
      .catch(() => {
        if (active) setError("Could not load connection status.");
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, selected?.id]);
  function match(endpoint: string | null, candidates = connections) {
    return candidates
      .filter(
        (item) =>
          item.kind === "mcp" &&
          Boolean(endpoint) &&
          mcpEndpointIdentity(item.endpointUrl) === mcpEndpointIdentity(endpoint),
      )
      .sort(
        (a, b) =>
          Number(a.id.startsWith("mcp:configured:marketplace-")) -
            Number(b.id.startsWith("mcp:configured:marketplace-")) ||
          Number(b.enabled) - Number(a.enabled),
      )[0];
  }
  async function connect(server: { name: string; endpoint: string | null }) {
    if (!server.endpoint || !onOpenConnection || busy || !canManage) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await client.listCapabilities(workspaceId);
      setConnections(fresh.items);
      const existing = match(server.endpoint, fresh.items);
      const endpoint = mcpEndpointIdentity(server.endpoint);
      if (!endpoint) throw new Error("Invalid MCP endpoint");
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint))),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 24);
      const item =
        existing ??
        (await client.createCapability(workspaceId, {
          id: "mcp:endpoint:" + hash,
          kind: "mcp",
          source: "manual",
          name: server.name,
          endpointUrl: server.endpoint,
          category: "integrations",
          tags: ["mcp"],
          metadata: { authDiscovery: "unknown" },
        }));
      // The connection opens its own page; Back returns to this plugin.
      onOpenConnection(item);
    } catch (cause) {
      setError(userErrorText(cause, "Could not open connection."));
    } finally {
      setBusy(false);
    }
  }
  async function openInstalled(plugin: PluginInstallationSummary) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      const item = await client.getInstalledPluginDetails(workspaceId, plugin.pluginKey);
      setError(null);
      setSelectedInstallation(plugin);
      setSelected(item);
    } catch {
      setError("Could not load plugin details.");
    }
  }
  function closePage() {
    setSelected(null);
    const target = opener.current;
    opener.current = null;
    queueMicrotask(() => {
      if (target?.isConnected) target.focus();
    });
  }
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  // Optimistic installation feedback lasts until the parent reloads the
  // authoritative list. Otherwise a removed plugin stays marked as installed.
  useEffect(() => {
    setInstalled(new Set());
  }, [installedPlugins, workspaceId]);
  const installedIds = new Set([
    ...installed,
    ...installedPlugins
      .filter((plugin) => plugin.pluginKey.startsWith("marketplace/"))
      .map((plugin) => plugin.pluginKey.slice("marketplace/".length).replace("/", ":")),
  ]);
  const [error, setError] = useState<string | null>(null);
  async function install(item: PluginDiscoveryItem) {
    if (!item.sourceUrl || !canManage || busy || installedIds.has(item.id)) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await client.previewPlugin(workspaceId, {
        url: item.sourceUrl,
        bindings: {},
      });
      await client.installPlugin(workspaceId, {
        url: item.sourceUrl,
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
      setInstalled((previous) => new Set([...previous, item.id]));
      onChanged?.();
    } catch (cause) {
      setError(userErrorText(cause, "Could not install plugin."));
    } finally {
      setBusy(false);
    }
  }
  const opener = useRef<HTMLElement | null>(null);
  const selectedIsInstalled =
    selected !== null &&
    (installedIds.has(selected.id) ||
      Boolean(
        selectedInstallation &&
        installedPlugins.some((plugin) => plugin.pluginKey === selectedInstallation.pluginKey),
      ));
  const liveInstallation =
    selectedInstallation &&
    (installedPlugins.find((plugin) => plugin.pluginKey === selectedInstallation.pluginKey) ??
      null);
  return (
    <>
      {!resultLimit ? (
        <ConnectionInstalled
          title="Installed"
          items={installedPlugins
            .filter((plugin) =>
              (plugin.name + " " + plugin.description)
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .map((plugin) => ({
              id: plugin.pluginKey,
              name: humanizeName(plugin.name),
              status: plugin.status === "needs_attention" ? "Needs attention" : "Installed",
              needsAttention: plugin.status === "needs_attention",
              onOpen: () => void openInstalled(plugin),
              icon: (
                <CapabilityMark
                  src={plugin.logoUrl ?? null}
                  name={plugin.name}
                  icon={<BoxesIcon />}
                />
              ),
            }))}
        />
      ) : null}
      {!selected && error ? <p role="alert">{error}</p> : null}
      {beforeCatalog}
      <Catalog
        defaultProvider=""
        {...(resultLimit ? { resultLimit } : {})}
        {...(onShowMore ? { onShowMore } : {})}
        client={client}
        workspaceId={workspaceId}
        query={query}
        installedIds={installedIds}
        formatName={humanizeName}
        renderIcon={(item) => (
          <CapabilityMark src={item.logoUrl} name={item.displayName} icon={<BoxesIcon />} />
        )}
        onOpen={(item) => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setError(null);
          setSelectedInstallation(null);
          setSelected(item);
        }}
      />
      {selected ? (
        <SlotOrInline slotted={slot !== null} pageKey={`plugin:${selected.id}`}>
          <PluginPage
            key={selected.id}
            item={selected}
            installation={liveInstallation}
            installed={selectedIsInstalled}
            busy={busy}
            error={error}
            canManage={canManage}
            connections={Object.fromEntries(
              (selected.mcpServers ?? []).map((server) => [
                server.endpoint ?? "",
                Boolean(match(server.endpoint)?.enabled),
              ]),
            )}
            onConnect={
              canManage && onOpenConnection
                ? (server: { name: string; endpoint: string | null }) => void connect(server)
                : undefined
            }
            onInstall={canManage ? () => void install(selected) : undefined}
            manage={
              liveInstallation && manage
                ? manage(liveInstallation)
                : liveInstallation && onManageInstalled && canManage
                  ? {
                      busy,
                      onUpdate: () =>
                        onManageInstalled(liveInstallation, opener.current ?? document.body),
                      onRemove: () =>
                        onManageInstalled(liveInstallation, opener.current ?? document.body),
                    }
                  : undefined
            }
            onBack={closePage}
          />
        </SlotOrInline>
      ) : null}
    </>
  );
}

/** In Capabilities the page goes to the route's page slot; elsewhere it renders in place. */
function SlotOrInline({
  slotted,
  pageKey,
  children,
}: {
  slotted: boolean;
  pageKey: string;
  children: ReactNode;
}) {
  return slotted ? <CapabilitySlotPage pageKey={pageKey}>{children}</CapabilitySlotPage> : children;
}
