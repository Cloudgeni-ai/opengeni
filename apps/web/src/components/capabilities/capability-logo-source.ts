import type { CapabilityCatalogItem } from "@/types";
import { capabilityLogoFallback } from "@opengeni/react/connect";

/**
 * First-party connector rows are synthesized by the API rather than imported
 * from integrations.sh, so they cannot carry an object-storage logo path.
 * Their small reviewed mark set ships with the web build instead.
 */
export const FIRST_PARTY_CAPABILITY_LOGOS: Readonly<Record<string, string>> = {
  "api:fiken": "/capability-logos/fiken.svg",
  "api:github-app": "/capability-logos/github.svg",
  "api:reddit": "/capability-logos/reddit.svg",
  "api:x": "/capability-logos/x.svg",
};

export function capabilityLogoSource(
  item: Pick<CapabilityCatalogItem, "id" | "logoAssetPath"> &
    Partial<Pick<CapabilityCatalogItem, "metadata">>,
  catalogAssetUrl: (path: string | null) => string | null,
): string | null {
  const localLogo = FIRST_PARTY_CAPABILITY_LOGOS[item.id] ?? catalogAssetUrl(item.logoAssetPath);
  if (localLogo) return localLogo;

  // Imports retain the upstream URL after applying our curated overrides,
  // including explicit nulls that suppress a provider's logo.
  return capabilityLogoFallback(item);
}
