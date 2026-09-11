import {
  mcpEndpointIdentity,
  type CapabilityCatalogItem,
  type PluginInstallationSummary,
} from "@opengeni/contracts";
import { useEffect, useRef, useState } from "react";
import { PluginDiscovery as Catalog, PluginDetails } from "@opengeni/react/connect";
import type { PluginDiscoveryItem } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

const EMPTY_INSTALLED_PLUGINS: PluginInstallationSummary[] = [];

export function PluginDiscovery({
  client,
  workspaceId,
  query,
  canManage = false,
  onChanged,
  onOpenConnection,
  onManageInstalled,
  installedPlugins = EMPTY_INSTALLED_PLUGINS,
}: {
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
      setInstalled((previous) => new Set([...previous, item.id]));
      setError(null);
      setSelectedInstallation(plugin);
      setSelected(item);
    } catch {
      setError("Could not load plugin details.");
    }
  }
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  async function install(item: PluginDiscoveryItem) {
    if (!item.sourceUrl || !canManage || busy) return;
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
      {installedPlugins.length ? (
        <section className="mb-6">
          <h3 className="mb-2 text-sm font-semibold">Installed</h3>
          <div className="grid gap-x-6 sm:grid-cols-2">
            {installedPlugins
              .filter((plugin) =>
                (plugin.name + " " + plugin.description)
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((plugin) => (
                <button
                  key={plugin.pluginKey}
                  type="button"
                  className="og-plugin-discovery-row"
                  onClick={() => void openInstalled(plugin)}
                >
                  {plugin.logoUrl ? (
                    <img
                      src={plugin.logoUrl}
                      alt=""
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <strong className="block text-sm font-medium">{plugin.name}</strong>
                    <span className="block line-clamp-1 text-xs text-fg-muted">
                      {plugin.description}
                    </span>
                  </span>
                  <span className="text-xs text-fg-muted">Installed ›</span>
                </button>
              ))}
          </div>
        </section>
      ) : null}
      {!selected && error ? <p role="alert">{error}</p> : null}
      <Catalog
        client={client}
        workspaceId={workspaceId}
        query={query}
        onOpen={(item) => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setError(null);
          setSelectedInstallation(null);
          setSelected(item);
        }}
      />
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          className="flex flex-col gap-0 overflow-y-auto bg-bg p-0 w-full sm:max-w-[36rem]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          {selected ? (
            <>
              <SheetTitle className="sr-only">{selected.displayName}</SheetTitle>
              <SheetDescription className="sr-only">
                Plugin overview and included capabilities
              </SheetDescription>
              <PluginDetails
                key={selected.id}
                item={selected}
                busy={busy}
                installed={
                  installed.has(selected.id) ||
                  installedPlugins.some(
                    (plugin) => plugin.pluginKey === "marketplace/" + selected.id.replace(":", "/"),
                  )
                }
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
              {selectedInstallation && onManageInstalled ? (
                <div className="border-t border-border p-4">
                  <Button
                    variant="outline"
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
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
