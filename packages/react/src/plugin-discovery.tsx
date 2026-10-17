import { createDiscoveryCache } from "./discovery-cache";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PluginDiscoveryItem, PluginDiscoveryPage } from "@opengeni/sdk";
import { BoxesIcon } from "lucide-react";
import { CapabilityCatalogRow } from "./capability-catalog-row";
import { ConnectionLogo } from "./connection-logo";
import { useOpenGeniText } from "./messages/runtime";

const discoveryCache = createDiscoveryCache<PluginDiscoveryPage>();
const spacedName = (name: string) => name.replace(/-/g, " ");
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
  /** Display name for a registry slug. Defaults to the slug with dashes as spaces. */
  formatName?: (name: string) => string;
  /** The row tile. Defaults to the plugin logo with a glyph fallback. */
  renderIcon?: (item: PluginDiscoveryItem) => ReactNode;
};
export function PluginDiscovery(props: PluginDiscoveryProps) {
  const t = useOpenGeniText();
  const [provider, setProvider] = useState(props.defaultProvider ?? "");
  return (
    <section
      className={`og-plugin-discovery ${props.resultLimit ? "og-catalog-overview" : ""}`}
      aria-label={t("pluginDiscovery.discoverPlugins")}
    >
      <header>
        <h3>
          {props.resultLimit ? t("pluginDiscovery.plugins") : t("pluginDiscovery.browsePlugins")}
        </h3>
        {!props.resultLimit ? (
          <div
            className="og-plugin-filters"
            role="group"
            aria-label={t("pluginDiscovery.pluginRegistry")}
          >
            {(
              [
                { value: "", label: t("pluginDiscovery.all") },
                { value: "openai", label: t("pluginDiscovery.openaiPluginRegistry") },
                { value: "anthropic", label: t("pluginDiscovery.anthropicPluginRegistry") },
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
  formatName = spacedName,
  renderIcon,
}: PluginDiscoveryProps & { provider: string }) {
  const t = useOpenGeniText();
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
          {total
            ? t("pluginDiscovery.bundlesOfSkillsAndConnections")
            : query.trim()
              ? t("pluginDiscovery.noMatchesForTrim", { trim: query.trim() })
              : t("pluginDiscovery.noPluginsInThisRegistry")}
        </p>
      ) : null}
      <div className="og-plugin-discovery-grid">
        {items.slice(0, resultLimit).map((item) => (
          <CapabilityCatalogRow
            key={item.id}
            data-plugin-id={item.id}
            name={formatName(item.displayName)}
            description={item.description}
            status={installedIds.has(item.id) ? "added" : "available"}
            statusLabel={
              installedIds.has(item.id)
                ? t("pluginDiscovery.installed")
                : t("pluginDiscovery.availableToInstall")
            }
            onOpen={() => onOpen(item)}
            icon={
              renderIcon ? (
                renderIcon(item)
              ) : (
                <ConnectionLogo
                  src={item.logoUrl}
                  name={item.displayName}
                  fallback={<BoxesIcon aria-hidden="true" />}
                />
              )
            }
          />
        ))}
      </div>
      {loading ? <p role="status">{t("pluginDiscovery.loadingPlugins")}</p> : null}
      {error ? (
        <p role="alert">
          {t("pluginDiscovery.couldnTLoadPlugins")}{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            {t("pluginDiscovery.retry")}
          </button>
        </p>
      ) : null}
      {resultLimit && !loading && !error && total > resultLimit ? (
        <button className="og-catalog-more" type="button" onClick={onShowMore}>
          {t("pluginDiscovery.viewAllPlugins")}
        </button>
      ) : null}
      <div ref={sentinel}>
        {!resultLimit && next !== null && !loading && !error ? (
          <button className="og-plugin-more" type="button" onClick={() => setOffset(next)}>
            {t("pluginDiscovery.showMorePlugins")}
          </button>
        ) : null}
      </div>
    </>
  );
}
