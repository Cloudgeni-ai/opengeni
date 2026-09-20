import type { ConnectAccount, ConnectController, ConnectProvider } from "@opengeni/connect";
import { ConnectChooser } from "./connect-chooser";
import {
  capabilityConnectProviderId,
  connectionServicePresentation,
  isServiceConnectProvider,
} from "./connection-service-presentation";
import type { CapabilityCatalogItem, ConnectionMetadata, OpenGeniClient } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import { CapabilityCatalogRow } from "./capability-catalog-row";
import { ConnectionLogo } from "./connection-logo";
import { ConnectionSkeleton } from "./connection-skeleton";
import { ConnectionServiceLogo } from "./connection-service-logo";
import { McpConnectionCard } from "./components/session-mcp-capability-card";
import { mcpConnectionDiscoveryState } from "./mcp-connection-status";

export type ConnectionDiscoveryProps = {
  client: OpenGeniClient;
  controller?: ConnectController | undefined;
  workspaceId: string;
  returnUrl: string;
  onConfigured?: (() => void | Promise<void>) | undefined;
};

/** Service discovery over the native catalogue. No host-owned OAuth state or
 * assumed account selection: details resolve current authority before acting. */
export function ConnectionDiscovery(props: ConnectionDiscoveryProps) {
  const [scope, setScope] = useState({ client: props.client, controller: props.controller });
  const [generation, setGeneration] = useState(0);
  if (scope.client !== props.client || scope.controller !== props.controller) {
    setScope({ client: props.client, controller: props.controller });
    setGeneration(generation + 1);
  }
  return <ScopedDiscovery key={`${generation}:${props.workspaceId}`} {...props} />;
}

function ScopedDiscovery({
  client,
  controller,
  workspaceId,
  returnUrl,
  onConfigured,
}: ConnectionDiscoveryProps) {
  const [providers, setProviders] = useState<ConnectProvider[] | null>(null);
  const [accounts, setAccounts] = useState<ConnectAccount[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ConnectProvider | null>(null);
  const [providerFailed, setProviderFailed] = useState(false);
  const [items, setItems] = useState<CapabilityCatalogItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const [selected, setSelected] = useState<CapabilityCatalogItem | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setFailed(false);
    setSelectedProvider(null);
    setProviders(null);
    setItems(null);
    setConnections([]);
    setAccounts([]);
    setProviderFailed(false);
    if (controller)
      void Promise.resolve()
        .then(() => {
          abort.signal.throwIfAborted();
          return Promise.all([
            controller.transport.catalog(workspaceId, { signal: abort.signal }),
            controller.transport.accounts(workspaceId, { signal: abort.signal }),
          ]);
        })
        .then(([catalog, inventory]) => {
          if (!abort.signal.aborted) {
            setProviders(catalog.filter(isServiceConnectProvider));
            setAccounts(inventory);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) setProviderFailed(true);
        });
    void Promise.resolve()
      .then(() => {
        abort.signal.throwIfAborted();
        return Promise.all([
          client.listCapabilities(workspaceId),
          client.listConnections(workspaceId),
        ]);
      })
      .then(([catalog, inventory]) => {
        if (!abort.signal.aborted) {
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
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => {
      abort.abort();
    };
  }, [client, controller, workspaceId, reload]);
  const matches =
    items?.filter((item) =>
      `${item.name} ${item.description ?? ""} ${item.providerDomain ?? ""}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    ) ?? [];
  const providerMatches = (providers ?? []).filter(
    (provider) =>
      !items?.some((item) => capabilityConnectProviderId(item) === provider.id) &&
      provider.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const loading = (!items && !failed) || Boolean(controller && !providers && !providerFailed);
  if (selectedProvider && controller)
    return (
      <section aria-label={`Connect ${selectedProvider.label}`}>
        <button type="button" onClick={() => setSelectedProvider(null)}>
          Back to connections
        </button>
        <ConnectionLogo
          name={selectedProvider.label}
          src={connectionServicePresentation(selectedProvider).logo}
        />
        <ConnectChooser
          controller={controller}
          returnUrl={returnUrl}
          presentation="catalog"
          providerOnly
          initialProviderId={selectedProvider.id}
        />
      </section>
    );
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
      {(providerFailed || failed) && (
        <p role="alert">
          Some services could not be loaded.{" "}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </p>
      )}
      <div className="og-connection-discovery-results">
        <div>
          {providerMatches.map((provider) => {
            const connected = accounts.some(
              (account) => account.providerId === provider.id && account.status === "connected",
            );
            return (
              <CapabilityCatalogRow
                key={provider.id}
                name={provider.label}
                icon={
                  <ConnectionLogo
                    name={provider.label}
                    src={connectionServicePresentation(provider).logo}
                  />
                }
                status={connected ? "added" : "available"}
                statusLabel={connected ? "Connected" : "Connect"}
                showStatusLabel
                onOpen={() => setSelectedProvider(provider)}
              />
            );
          })}
          {matches.slice(0, limit).map((item) => {
            const state = mcpConnectionDiscoveryState(item, connections);
            return (
              <CapabilityCatalogRow
                key={item.id}
                name={item.name}
                description={item.description ?? undefined}
                icon={<ConnectionServiceLogo client={client} item={item} name={item.name} />}
                status={state.status}
                statusLabel={state.label}
                showStatusLabel
                onOpen={() => {
                  opener.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setSelected(item);
                }}
              />
            );
          })}
        </div>

        {loading && <ConnectionSkeleton rows={3} label="Loading services" />}
        {!loading && !failed && !providerFailed && !matches.length && !providerMatches.length && (
          <p role="status">No services match your search.</p>
        )}
        {matches.length > limit && (
          <button type="button" onClick={() => setLimit((value) => value + 12)}>
            Show more services
          </button>
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
