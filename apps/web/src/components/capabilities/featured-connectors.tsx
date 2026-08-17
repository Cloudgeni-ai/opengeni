import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import {
  capabilityCategoryLabel,
  capabilityCuration,
  capabilityRequiresPersonalConnection,
  sortFeaturedFirst,
} from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem } from "@/types";

/** Connectors OpenGeni builds and runs itself (first-party bridges such as Fiken). */
export function isBuiltByOpenGeni(item: Pick<CapabilityCatalogItem, "surfaceType">): boolean {
  return item.surfaceType?.startsWith("first_party_") === true;
}

/** Curated `metadata.curation.featured` connectors, in their catalog order. */
export function featuredConnectors(
  items: readonly CapabilityCatalogItem[],
): CapabilityCatalogItem[] {
  return sortFeaturedFirst(items).filter((item) => capabilityCuration(item).featured);
}

/**
 * The Featured strip: the connectors most teams start with, as tiles above the
 * searchable long tail. Every tile opens the same connector detail sheet as the
 * grid. Badges are only "Official" (provider-published) and "Built by OpenGeni";
 * neither is a security review, and nothing here says reviewed or verified.
 */
export function FeaturedConnectorsStrip({
  items,
  logoUrl,
  onOpen,
}: {
  items: CapabilityCatalogItem[];
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  onOpen: (item: CapabilityCatalogItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="featured-connectors-heading">
      <h3 id="featured-connectors-heading" className="text-sm font-semibold text-fg">
        Featured
      </h3>
      <div
        data-featured-connectors
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {items.map((item) => (
          <FeaturedConnectorTile
            key={item.id}
            item={item}
            logoSrc={logoUrl(item)}
            onOpen={() => onOpen(item)}
          />
        ))}
      </div>
    </section>
  );
}

function FeaturedConnectorTile({
  item,
  logoSrc,
  onOpen,
}: {
  item: CapabilityCatalogItem;
  logoSrc: string | null;
  onOpen: () => void;
}) {
  const curation = capabilityCuration(item);
  const builtByOpenGeni = isBuiltByOpenGeni(item);
  const personalOnly = capabilityRequiresPersonalConnection(item);
  const category = capabilityCategoryLabel(item.category);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-featured-connector={item.id}
      className={cn(
        "group flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-surface p-4 text-left",
        "transition-colors hover:border-border-strong hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <CapabilityLogo src={logoSrc} name={item.name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{item.name}</span>
          {category ? (
            <span className="block truncate text-2xs text-fg-subtle">{category}</span>
          ) : null}
        </span>
        {item.enabled ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-status-idle">
            <span className="size-1.5 rounded-full bg-status-idle" />
            Enabled
          </span>
        ) : null}
      </span>
      <span className="line-clamp-2 text-xs leading-5 text-fg-muted">
        {item.description ?? "No description provided."}
      </span>
      {curation.official || builtByOpenGeni || personalOnly ? (
        <span className="mt-auto flex flex-wrap items-center gap-1.5">
          {curation.official ? (
            <span
              data-capability-official
              className="inline-flex items-center rounded-full border border-brand/40 bg-brand/10 px-1.5 text-2xs font-medium uppercase tracking-wide text-brand"
              title="Published by the provider on its own domain"
            >
              Official
            </span>
          ) : null}
          {builtByOpenGeni ? (
            <span
              data-capability-built-by-opengeni
              className="inline-flex items-center rounded-full border border-border bg-surface-2 px-1.5 text-2xs font-medium uppercase tracking-wide text-fg-subtle"
            >
              Built by OpenGeni
            </span>
          ) : null}
          {personalOnly ? (
            <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-1.5 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
              Personal only
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
