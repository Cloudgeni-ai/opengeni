import type { CapabilityCatalogItem } from "@/types";

/**
 * First-party connector rows are synthesized by the API rather than imported
 * from integrations.sh, so they cannot carry an object-storage logo path.
 * Their small reviewed mark set ships with the web build instead.
 */
export const FIRST_PARTY_CAPABILITY_LOGOS: Readonly<Record<string, string>> = {
  "api:fiken": "/capability-logos/fiken.svg",
  "api:reddit": "/capability-logos/reddit.svg",
  "api:x": "/capability-logos/x.svg",
};

export function capabilityLogoSource(
  item: Pick<CapabilityCatalogItem, "id" | "logoAssetPath">,
  catalogAssetUrl: (path: string | null) => string | null,
): string | null {
  return FIRST_PARTY_CAPABILITY_LOGOS[item.id] ?? catalogAssetUrl(item.logoAssetPath);
}
