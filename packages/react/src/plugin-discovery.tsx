import { createDiscoveryCache } from "./discovery-cache";
import { useEffect, useRef, useState } from "react";
import type { PluginDiscoveryItem, PluginDiscoveryPage } from "@opengeni/sdk";
import { BoxesIcon } from "lucide-react";
import { CapabilityCatalogRow } from "./capability-catalog-row";
import { ConnectionLogo } from "./connection-logo";

const discoveryCache = createDiscoveryCache<PluginDiscoveryPage>();
const EMPTY_INSTALLED_IDS: ReadonlySet<string> = new Set();

export type PluginDiscoveryProps = {
  client: {
    discoverPlugins(
      workspaceId: string,
      options?: { query?: string; provider?: string; offset?: number },
    ): Promise<PluginDiscoveryPage>;
  };
  workspaceId: string;
  query: string;
  /** Initially selected registry. Users can still switch registries or browse all. */
  defaultProvider?: "" | "openai" | "anthropic";
  /** Discovery identities already installed in the current workspace. */
  installedIds?: ReadonlySet<string>;
  resultLimit?: number;
  onShowMore?: () => void;
  onOpen: (item: PluginDiscoveryItem) => void;
};
export function PluginDiscovery(props: PluginDiscoveryProps) {
  const [provider, setProvider] = useState(props.defaultProvider ?? "");
  return (
    <section
      className={`og-plugin-discovery ${props.resultLimit ? "og-catalog-overview" : ""}`}
      aria-label="Discover plugins"
    >
      <header>
        <h3>{props.resultLimit ? "Plugins" : "Browse plugins"}</h3>
        {!props.resultLimit ? (
          <div className="og-plugin-filters" role="group" aria-label="Plugin registry">
            {(
              [
                { value: "", label: "All" },
                { value: "openai", label: "OpenAI plugin registry" },
                { value: "anthropic", label: "Anthropic plugin registry" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={provider === option.value}
                onClick={() => setProvider(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      <Results
        key={`${props.workspaceId}:${props.query}:${provider}`}
        {...props}
        provider={provider}
      />
    </section>
  );
}
function Results({
  client,
  workspaceId,
  query,
  provider,
  installedIds = EMPTY_INSTALLED_IDS,
  onOpen,
  resultLimit,
  onShowMore,
}: PluginDiscoveryProps & { provider: string }) {
  const initial = discoveryCache.peek(client, JSON.stringify([workspaceId, query, provider, 0]));
  const [items, setItems] = useState<PluginDiscoveryItem[]>(initial?.items ?? []);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(initial?.nextOffset ?? null);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const cacheKey = JSON.stringify([workspaceId, query, provider, offset]);
    const cached = discoveryCache.peek(client, cacheKey);
    setLoading(!cached);
    setError(false);
    const timer = setTimeout(
      () => {
        void discoveryCache
          .read(client, cacheKey, () =>
            client.discoverPlugins(workspaceId, { query, provider, offset }),
          )
          .then(
            (page) => {
              if (!active) return;
              setItems((previous) => (offset ? [...previous, ...page.items] : page.items));
              setTotal(page.total);
              setNext(page.nextOffset);
              setLoading(false);
            },
            () => {
              if (active) {
                setError(true);
                setLoading(false);
              }
            },
          );
      },
      cached || offset ? 0 : 200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, workspaceId, query, provider, offset, retry]);
  useEffect(() => {
    if (resultLimit || loading || error || next === null || !sentinel.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setOffset(next);
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loading, error, next, resultLimit]);
  return (
    <>
      {!loading && !error ? (
        <p role="status">
          {total ? `${total} plugins` : "No matching plugins. Try another search or registry."}
        </p>
      ) : null}
      <div className="og-plugin-discovery-grid">
        {items.slice(0, resultLimit).map((item) => (
          <CapabilityCatalogRow
            key={item.id}
            data-plugin-id={item.id}
            name={item.displayName.replace(/-/g, " ")}
            description={item.description}
            status={installedIds.has(item.id) ? "added" : "available"}
            statusLabel={installedIds.has(item.id) ? "Installed" : "Available to install"}
            onOpen={() => onOpen(item)}
            icon={
              <ConnectionLogo
                src={item.logoUrl}
                name={item.displayName}
                fallback={<BoxesIcon aria-hidden="true" />}
              />
            }
          />
        ))}
      </div>
      {loading ? <p role="status">Loading plugins…</p> : null}
      {error ? (
        <p role="alert">
          Couldn’t load plugins.{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </p>
      ) : null}
      {resultLimit && !loading && !error && total > resultLimit ? (
        <button className="og-catalog-more" type="button" onClick={onShowMore}>
          View all plugins
        </button>
      ) : null}
      <div ref={sentinel}>
        {!resultLimit && next !== null && !loading && !error ? (
          <button className="og-plugin-more" type="button" onClick={() => setOffset(next)}>
            Show more plugins
          </button>
        ) : null}
      </div>
    </>
  );
}
