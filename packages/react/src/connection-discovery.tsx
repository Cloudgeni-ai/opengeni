import type { CapabilityCatalogItem, ConnectionMetadata, OpenGeniClient } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import { CapabilityCatalogRow } from "./capability-catalog-row";
import { ConnectionLogo } from "./connection-logo";
import { ConnectionSkeleton } from "./connection-skeleton";
import { capabilityLogoFallback } from "./capability-logo-fallback";
import { McpConnectionCard } from "./components/session-mcp-capability-card";
import { matchingActiveMcpConnections } from "./mcp-connection-status";

export type ConnectionDiscoveryProps = {
  client: OpenGeniClient;
  workspaceId: string;
  returnUrl: string;
  onConfigured?: (() => void | Promise<void>) | undefined;
};

/** Service discovery over the native catalogue. No host-owned OAuth state or
 * assumed account selection: details resolve current authority before acting. */
export function ConnectionDiscovery(props: ConnectionDiscoveryProps) {
  const [client, setClient] = useState(props.client);
  const [generation, setGeneration] = useState(0);
  if (client !== props.client) {
    setClient(props.client);
    setGeneration(generation + 1);
  }
  return <ScopedDiscovery key={`${generation}:${props.workspaceId}`} {...props} />;
}

function ScopedDiscovery({
  client,
  workspaceId,
  returnUrl,
  onConfigured,
}: ConnectionDiscoveryProps) {
  const [items, setItems] = useState<CapabilityCatalogItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const [selected, setSelected] = useState<CapabilityCatalogItem | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let current = true;
    setFailed(false);
    void Promise.all([client.listCapabilities(workspaceId), client.listConnections(workspaceId)])
      .then(([catalog, inventory]) => {
        if (current) {
          setConnections(inventory);
          setItems(
            catalog.items.filter(
              (item) =>
                item.kind === "mcp" &&
                item.authKind === "oauth2" &&
                Boolean(item.mcpUrl ?? item.endpointUrl),
            ),
          );
        }
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, reload]);
  const matches =
    items?.filter((item) =>
      `${item.name} ${item.description ?? ""} ${item.providerDomain ?? ""}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    ) ?? [];
  return (
    <section className="og-connection-discovery" aria-label="Find a connection">
      <h3>Add a connection</h3>
      <label>
        <span className="og-capability-catalog-sr-only">Search services</span>
        <input
          type="search"
          placeholder="Search services…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(12);
          }}
        />
      </label>
      <div className="og-connection-discovery-results" aria-busy={!items && !failed}>
        {failed ? (
          <p role="alert">
            Services could not be loaded.{" "}
            <button onClick={() => setReload((value) => value + 1)}>Retry</button>
          </p>
        ) : !items ? (
          <ConnectionSkeleton rows={5} label="Loading services" />
        ) : (
          <>
            <div>
              {matches.slice(0, limit).map((item) => {
                const connected = matchingActiveMcpConnections(item, connections).length === 1;
                return (
                  <CapabilityCatalogRow
                    key={item.id}
                    name={item.name}
                    description={item.description ?? undefined}
                    icon={<ServiceLogo client={client} item={item} />}
                    status={connected ? "added" : item.enabled ? "attention" : "available"}
                    statusLabel={
                      connected ? "Connected" : item.enabled ? "Review connection" : "Connect"
                    }
                    showStatusLabel={connected}
                    onOpen={() => {
                      opener.current =
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null;
                      setSelected(item);
                    }}
                  />
                );
              })}
            </div>
            {!matches.length ? <p role="status">No services match your search.</p> : null}
            {matches.length > limit ? (
              <button onClick={() => setLimit((value) => value + 12)}>Show more services</button>
            ) : null}
          </>
        )}
      </div>
      {selected ? (
        <McpConnectionCard
          client={client}
          workspaceId={workspaceId}
          capabilityId={selected.id}
          name={selected.name}
          returnUrl={returnUrl}
          dialogOnly
          onClose={() => {
            setSelected(null);
            queueMicrotask(() => {
              if (opener.current?.isConnected) opener.current.focus();
            });
          }}
          onConfigured={async () => {
            setReload((value) => value + 1);
            await onConfigured?.();
          }}
        />
      ) : null}
    </section>
  );
}

function ServiceLogo({ client, item }: { client: OpenGeniClient; item: CapabilityCatalogItem }) {
  const [src, setSrc] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSrc(null);
    setSettled(false);
    const path = item.logoAssetPath;
    if (!path?.startsWith("catalog-assets/")) return;
    const abort = new AbortController();
    let url: string | null = null;
    void client
      .downloadCatalogAsset(path, { signal: abort.signal })
      .then((blob) => {
        if (abort.signal.aborted || !blob.type.startsWith("image/") || blob.size > 2_000_000)
          return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {})
      .finally(() => {
        if (!abort.signal.aborted) setSettled(true);
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, item.logoAssetPath]);
  return (
    <ConnectionLogo
      name={item.name}
      src={
        src ??
        (item.logoAssetPath?.startsWith("catalog-assets/") && !settled
          ? null
          : capabilityLogoFallback(item))
      }
      loading={Boolean(item.logoAssetPath?.startsWith("catalog-assets/")) && !settled}
    />
  );
}
