import { useEffect, useRef, useState } from "react";
import type { PluginDiscoveryItem, PluginDiscoveryPage } from "@opengeni/sdk";
export type PluginDiscoveryProps = {
  client: {
    discoverPlugins(
      workspaceId: string,
      options?: { query?: string; provider?: string; offset?: number },
    ): Promise<PluginDiscoveryPage>;
  };
  workspaceId: string;
  query: string;
  onOpen: (item: PluginDiscoveryItem) => void;
};
export function PluginDiscovery(props: PluginDiscoveryProps) {
  const [provider, setProvider] = useState("");
  return (
    <section className="og-plugin-discovery" aria-label="Discover plugins">
      <header>
        <h3>Browse plugins</h3>
        <div className="og-plugin-filters" role="group" aria-label="Plugin registry">
          {[
            { value: "", label: "All" },
            { value: "openai", label: "OpenAI plugin registry" },
            { value: "anthropic", label: "Anthropic plugin registry" },
          ].map((option) => (
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
  onOpen,
}: PluginDiscoveryProps & { provider: string }) {
  const [items, setItems] = useState<PluginDiscoveryItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    const timer = setTimeout(
      () => {
        void client.discoverPlugins(workspaceId, { query, provider, offset }).then(
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
      offset ? 0 : 200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, workspaceId, query, provider, offset, retry]);
  useEffect(() => {
    if (loading || error || next === null || !sentinel.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setOffset(next);
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loading, error, next]);
  return (
    <>
      {!loading && !error ? (
        <p role="status">
          {total ? `${total} plugins` : "No matching plugins. Try another search or registry."}
        </p>
      ) : null}
      <div className="og-plugin-discovery-grid">
        {items.map((item) => (
          <button
            key={item.id}
            className="og-plugin-discovery-row"
            type="button"
            onClick={() => onOpen(item)}
          >
            {item.logoUrl ? (
              <img
                src={item.logoUrl}
                alt=""
                loading="lazy"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            ) : null}
            <span className="og-plugin-copy">
              <span className="og-plugin-title">
                <strong>{item.displayName.replace(/-/g, " ")}</strong>
                <small>
                  {item.provider === "openai"
                    ? "OpenAI plugin registry"
                    : "Anthropic plugin registry"}
                </small>
              </span>
              <span className="og-plugin-description">{item.description}</span>
              {item.category ? <span className="og-plugin-category">{item.category}</span> : null}
            </span>
            <span className="og-plugin-open" aria-hidden="true">
              ›
            </span>
          </button>
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
      <div ref={sentinel}>
        {next !== null && !loading && !error ? (
          <button className="og-plugin-more" type="button" onClick={() => setOffset(next)}>
            Show more plugins
          </button>
        ) : null}
      </div>
    </>
  );
}
