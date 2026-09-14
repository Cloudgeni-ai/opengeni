import { CapabilityTile } from "./capability-tile";
import { capabilityCuration, sortFeaturedFirst, type ConnectionHealth } from "@/lib/capabilities";
import type { CapabilityCatalogItem } from "@/types";

export function isBuiltByOpenGeni(item: Pick<CapabilityCatalogItem, "surfaceType">): boolean {
  return item.surfaceType?.startsWith("first_party_") === true;
}

export function featuredConnectors(
  items: readonly CapabilityCatalogItem[],
): CapabilityCatalogItem[] {
  return sortFeaturedFirst(items).filter((item) => capabilityCuration(item).featured);
}

/** Featured and browse use the same row and setup action. */
export function FeaturedConnectorsStrip({
  items,
  logoUrl,
  onOpen,
  health,
}: {
  items: CapabilityCatalogItem[];
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  onOpen: (item: CapabilityCatalogItem) => void;
  health?: (item: CapabilityCatalogItem) => ConnectionHealth;
  /** @deprecated Each row now has one action. */
  onQuickConnect?: (item: CapabilityCatalogItem) => (() => void) | undefined;
}) {
  if (!items.length) return null;
  return (
    <section className="space-y-3" aria-labelledby="featured-connectors-heading">
      <h3 id="featured-connectors-heading" className="text-sm font-semibold text-fg">
        Featured
      </h3>
      <div data-featured-connectors className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {items.map((item) => (
          <FeaturedConnectorTile
            key={item.id}
            item={item}
            logoSrc={logoUrl(item)}
            onOpen={() => onOpen(item)}
            health={health?.(item)}
          />
        ))}
      </div>
    </section>
  );
}

export function FeaturedConnectorTile(props: {
  item: CapabilityCatalogItem;
  logoSrc: string | null;
  onOpen: () => void;
  health?: ConnectionHealth | undefined;
  onQuickConnect?: () => void;
}) {
  return (
    <div data-featured-connector={props.item.id}>
      <CapabilityTile {...props} />
    </div>
  );
}
