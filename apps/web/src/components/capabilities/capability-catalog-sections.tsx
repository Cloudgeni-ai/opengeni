import { GlobeIcon, Loader2Icon, PlugIcon, SearchIcon } from "lucide-react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { CapabilityTile } from "@/components/capabilities/capability-tile";
import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  capabilityFilterLabel,
  capabilityItemKindLabel,
  type CapabilityFilter,
  type ConnectionHealth,
} from "@/lib/capabilities";
import type { ListViewState } from "@/lib/load-state";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem } from "@/types";

/**
 * The kinds the Connectors grid can actually show. Skills, Plugins, and Packs
 * are Bundles and live in their own section with their own search, so offering
 * them here would only ever produce an empty grid.
 */
export const CAPABILITY_FILTERS: readonly CapabilityFilter[] = ["all", "mcp", "api"];

export function CapabilityDiscoveryControls({
  query,
  filter,
  counts,
  onQueryChange,
  onFilterChange,
}: {
  query: string;
  filter: CapabilityFilter;
  counts: Record<CapabilityFilter, number>;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: CapabilityFilter) => void;
}) {
  return (
    <>
      <div className="relative mt-6">
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search connectors"
          className="h-12 rounded-xl pl-11 text-base transition-none placeholder:text-fg"
          aria-label="Search connectors"
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Plugin type filters">
        {CAPABILITY_FILTERS.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={filter === kind}
            onClick={() => onFilterChange(kind)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors pointer-coarse:min-h-11",
              filter === kind
                ? "border-brand/40 bg-brand/10 text-fg"
                : "border-border bg-surface/50 text-fg-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {capabilityFilterLabel(kind)}
            <span className={cn("text-2xs", filter === kind ? "text-fg" : "text-fg-muted")}>
              {counts[kind]}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * The enabled Connectors strip. Its input is already scoped to `mcp`/`api`
 * items (`isConnectorCatalogItem`), so no Skill, Plugin, or Pack reaches it:
 * Bundles have their own section, with their own authority rules and their own
 * remove affordance.
 */
export function EnabledCapabilitiesSection({
  items,
  busyId,
  connectionHealth,
  logoUrl,
  onOpen,
  onDisable,
}: {
  items: CapabilityCatalogItem[];
  busyId: string | null;
  connectionHealth: (item: CapabilityCatalogItem) => ConnectionHealth;
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  onOpen: (item: CapabilityCatalogItem) => void;
  onDisable: (item: CapabilityCatalogItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="enabled-capabilities-heading">
      {/*
        Enabled and Browse are two views of the one Connectors section, not
        top-level surfaces of their own: the page has exactly three <h2>s
        (Integrations, Connectors, Bundles) and these sit under Connectors.
      */}
      <h3 id="enabled-capabilities-heading" className="text-sm font-semibold text-fg">
        Enabled
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <EnabledCard
            key={item.id}
            item={item}
            health={connectionHealth(item)}
            logoSrc={logoUrl(item)}
            busy={busyId === item.id}
            onOpen={() => onOpen(item)}
            onDisable={() => onDisable(item)}
          />
        ))}
      </div>
    </section>
  );
}

export function CapabilityBrowseSection({
  filter,
  query,
  catalogView,
  loadError,
  enabledCount,
  browseItems,
  visibleBrowse,
  registryBusy,
  registrySearched,
  registryResults,
  logoUrl,
  health,
  onRetry,
  onOpen,
  onOpenRegistry,
  onSearchRegistry,
  onLoadMore,
  onQuickConnect,
}: {
  filter: CapabilityFilter;
  query: string;
  catalogView: ListViewState;
  loadError: Error | null;
  enabledCount: number;
  browseItems: CapabilityCatalogItem[];
  visibleBrowse: CapabilityCatalogItem[];
  registryBusy: boolean;
  registrySearched: string | null;
  registryResults: CapabilityCatalogItem[];
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  /** Connection health per item, so an enabled-but-broken row never reads as connected. */
  health?: (item: CapabilityCatalogItem) => ConnectionHealth;
  onRetry: () => void;
  onOpen: (item: CapabilityCatalogItem) => void;
  onOpenRegistry: (item: CapabilityCatalogItem) => void;
  onSearchRegistry: () => void;
  onLoadMore: () => void;
  /** The icon quick-connect fast path; omitted for items with no dialog-free or one-dialog connect action. */
  onQuickConnect?: (item: CapabilityCatalogItem) => (() => void) | undefined;
}) {
  return (
    <section className="space-y-4" aria-labelledby="browse-capabilities-heading">
      {filter === "all" || enabledCount > 0 ? (
        <h3 id="browse-capabilities-heading" className="text-sm font-semibold text-fg">
          Browse
        </h3>
      ) : null}

      {catalogView === "loading" ? (
        <CatalogSkeleton />
      ) : catalogView === "error" ? (
        <LoadErrorState title="Couldn't load plugins" error={loadError} onRetry={onRetry} />
      ) : browseItems.length === 0 ? (
        <RegistryFallback
          query={query}
          busy={registryBusy}
          searched={registrySearched}
          results={registryResults}
          onSearch={onSearchRegistry}
          logoUrl={logoUrl}
          onOpen={onOpenRegistry}
          emptyDefault={enabledCount === 0}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleBrowse.map((item) => (
              <CapabilityTile
                key={item.id}
                item={item}
                logoSrc={logoUrl(item)}
                {...(health ? { health: health(item) } : {})}
                onOpen={() => onOpen(item)}
                onQuickConnect={onQuickConnect?.(item)}
              />
            ))}
          </div>
          {visibleBrowse.length < browseItems.length ? (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="pointer-coarse:min-h-11"
                onClick={onLoadMore}
              >
                See more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function CatalogSkeleton() {
  return (
    <div
      data-capability-catalog-skeleton
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {Array.from({ length: 8 }, (_, index) => `catalog-skeleton-${index + 1}`).map((rowKey) => (
        <div key={rowKey} className="rounded-xl border border-border bg-surface/50 p-4">
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="mt-3 h-4 w-24" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function EnabledCard({
  item,
  health,
  logoSrc,
  busy,
  onOpen,
  onDisable,
}: {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
  logoSrc: string | null;
  busy: boolean;
  onOpen: () => void;
  onDisable: () => void;
}) {
  const needsAttention = health.state === "attention";
  const canRemove = item.kind === "mcp" && item.actions.includes("disconnect");
  const status = needsAttention
    ? {
        label: "Needs attention",
        dot: "bg-status-waiting",
        text: "text-status-waiting",
      }
    : item.stale
      ? {
          label: "No longer in registry",
          dot: "bg-fg-subtle/60",
          text: "text-fg-subtle",
        }
      : {
          label: health.state === "connected" ? "Connected" : "Enabled",
          dot: "bg-status-idle",
          text: "text-fg-subtle",
        };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface/50 p-3">
      <button
        type="button"
        onClick={onOpen}
        data-capability-focus-target
        data-capability-id={item.id}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg pointer-coarse:min-h-11"
      >
        <CapabilityLogo src={logoSrc} name={item.name} size="sm" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-fg">{item.name}</div>
          <div className={cn("flex items-center gap-1.5 text-2xs", status.text)}>
            <span className={cn("size-1.5 rounded-full", status.dot)} />
            {status.label}
            <span aria-hidden className="text-fg-subtle/50">
              ·
            </span>
            <span className="truncate">{capabilityItemKindLabel(item)}</span>
          </div>
        </div>
      </button>
      {canRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onDisable}
          className="shrink-0 pointer-coarse:min-h-11"
        >
          {busy ? (
            <Loader2Icon className="animate-spin motion-reduce:animate-none" />
          ) : (
            "Disconnect"
          )}
        </Button>
      ) : (
        <span className="shrink-0 px-2 text-2xs text-fg-subtle">
          {item.source === "configured"
            ? "Managed"
            : item.source === "built_in"
              ? "Built in"
              : "Manage separately"}
        </span>
      )}
    </div>
  );
}

function RegistryFallback({
  query,
  busy,
  searched,
  results,
  onSearch,
  logoUrl,
  onOpen,
  emptyDefault,
}: {
  query: string;
  busy: boolean;
  searched: string | null;
  results: CapabilityCatalogItem[];
  onSearch: () => void;
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  onOpen: (item: CapabilityCatalogItem) => void;
  emptyDefault: boolean;
}) {
  const term = query.trim();

  if (results.length > 0) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-fg-subtle">From the public MCP registry</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {results.map((item) => (
            <CapabilityTile
              key={item.id}
              item={item}
              logoSrc={logoUrl(item)}
              onOpen={() => onOpen(item)}
            />
          ))}
        </div>
      </div>
    );
  }

  if (!term) {
    return (
      <EmptyState
        icon={<PlugIcon className="size-4" />}
        title={emptyDefault ? "Nothing here yet" : "No matches for this filter"}
        description={
          emptyDefault
            ? "Search the catalog above, connect a custom API, or add an MCP server, Skill, or Plugin."
            : "Try a different filter or search term."
        }
      />
    );
  }

  return (
    <EmptyState
      icon={<GlobeIcon className="size-4" />}
      title={
        searched && searched === term
          ? `No registry servers match “${term}”`
          : `No catalog matches for “${term}”`
      }
      description="Search the public MCP registry for a server to connect."
      action={
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onSearch}>
          {busy ? (
            <Loader2Icon className="animate-spin motion-reduce:animate-none" />
          ) : (
            <SearchIcon />
          )}
          Search the public MCP registry
        </Button>
      }
    />
  );
}
