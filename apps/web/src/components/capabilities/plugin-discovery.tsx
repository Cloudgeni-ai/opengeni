import {
  mcpEndpointIdentity,
  type CapabilityCatalogItem,
  type PluginInstallationSummary,
} from "@opengeni/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ConnectionInstalled,
  ConnectionLogo,
  PluginDiscovery as Catalog,
  PluginDetails,
} from "@opengeni/react/connect";
import { BoxesIcon } from "lucide-react";
import type { PluginDiscoveryItem } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Dialog, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CapabilityDialogContent } from "./detail-dialog";

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
  installedPlugins = EMPTY_INSTALLED_PLUGINS,
}: {
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
  const [selected, setSelected] = useState<PluginDiscoveryItem | null>(null);
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
      setSelected(null);
      onOpenConnection(item);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open connection.");
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
      setError(cause instanceof Error ? cause.message : "Could not install plugin.");
    } finally {
      setBusy(false);
    }
  }
  const opener = useRef<HTMLElement | null>(null);
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
              name: plugin.name,
              status: plugin.status === "needs_attention" ? "Needs attention" : "Installed",
              needsAttention: plugin.status === "needs_attention",
              onOpen: () => void openInstalled(plugin),
              icon: (
                <ConnectionLogo
                  src={plugin.logoUrl ?? null}
                  name={plugin.name}
                  size={40}
                  fallback={<BoxesIcon aria-hidden="true" />}
                />
              ),
            }))}
        />
      ) : null}
      {!selected && error ? <p role="alert">{error}</p> : null}
      {beforeCatalog}
      <Catalog
        defaultProvider={resultLimit ? "" : "openai"}
        {...(resultLimit ? { resultLimit } : {})}
        {...(onShowMore ? { onShowMore } : {})}
        client={client}
        workspaceId={workspaceId}
        query={query}
        installedIds={installedIds}
        onOpen={(item) => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setError(null);
          setSelectedInstallation(null);
          setSelected(item);
        }}
      />
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <CapabilityDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          {selected ? (
            <div className="min-h-0 overflow-y-auto overscroll-contain">
              <DialogTitle className="sr-only">{selected.displayName}</DialogTitle>
              <DialogDescription className="sr-only">
                Plugin overview and included capabilities
              </DialogDescription>
              <PluginDetails
                key={selected.id}
                item={selected}
                busy={busy}
                installed={installedIds.has(selected.id)}
                connections={Object.fromEntries(
                  (selected.mcpServers ?? []).map((server) => [
                    server.endpoint ?? "",
                    Boolean(match(server.endpoint)?.enabled),
                  ]),
                )}
                {...(canManage && onOpenConnection
                  ? {
                      onConnect: (server: { name: string; endpoint: string | null }) =>
                        void connect(server),
                    }
                  : {})}
                error={error}
                {...(canManage ? { onInstall: () => void install(selected) } : {})}
              />
              {!canManage ? (
                <p className="border-t border-border p-4 text-sm text-fg-muted">
                  Workspace administrators can install, update, and remove imported Skills and
                  Plugins.
                </p>
              ) : null}
              {canManage && selectedInstallation && onManageInstalled ? (
                <div className="border-t border-border p-4">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={(event) => {
                      setSelected(null);
                      onManageInstalled(
                        selectedInstallation,
                        opener.current ?? event.currentTarget,
                      );
                    }}
                  >
                    Manage installation
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </CapabilityDialogContent>
      </Dialog>
    </>
  );
}
