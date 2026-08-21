import { capabilityCuration } from "@/lib/capabilities";
import type { CapabilityCatalogItem } from "@/types";

/**
 * Product presentation order for the connector browser. The server catalog is
 * still complete and search always runs before this sort; this only stops the
 * initial bounded window from being filled by raw aggregator names before the
 * reviewed and recognizable connector set.
 *
 * The buckets deliberately use provenance/presentation facts, never the
 * `official` flag as a security signal. Within a bucket the server's stable
 * order is preserved.
 */
export function sortConnectorsForPresentation<
  T extends Pick<
    CapabilityCatalogItem,
    "id" | "kind" | "source" | "surfaceType" | "metadata" | "logoAssetPath" | "name"
  >,
>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, bucket: connectorPresentationBucket(item) }))
    .sort((left, right) => left.bucket - right.bucket || left.index - right.index)
    .map(({ item }) => item);
}

function connectorPresentationBucket(
  item: Pick<
    CapabilityCatalogItem,
    "kind" | "source" | "surfaceType" | "metadata" | "logoAssetPath" | "name"
  >,
): number {
  if (
    (item.kind === "mcp" || item.kind === "api") &&
    (item.source === "built_in" || item.surfaceType?.startsWith("first_party_") === true)
  ) {
    return 0;
  }
  const curation = capabilityCuration(item);
  if (curation.featured) return 1;
  if (curation.curated) return 2;
  if (item.logoAssetPath) return 3;
  return opaqueCatalogName(item.name) ? 5 : 4;
}

/** Raw hostnames, machine ids, and punctuation-led labels belong after names a human can scan. */
export function opaqueCatalogName(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return true;
  const letters = normalized.match(/[\p{L}]/gu)?.length ?? 0;
  if (letters < 2) return true;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+){1,}$/i.test(normalized)) return true;
  if (/^[a-z0-9]{12,}(?:[-.][a-z0-9]+)*$/i.test(normalized) && /\d/.test(normalized)) return true;
  return false;
}
