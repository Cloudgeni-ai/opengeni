import { CapabilityTile } from "./capability-tile";
import {
  capabilityCuration,
  sortFeaturedFirst,
  type ConnectionHealth,
} from "@opengeni/react/app/lib/capabilities";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";

export function featuredConnectors(
  items: readonly CapabilityCatalogItem[],
): CapabilityCatalogItem[] {
  return sortFeaturedFirst(items).filter((item) => capabilityCuration(item).featured);
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
