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
  item: Pick<CapabilityCatalogItem, "id" | "logoAssetPath"> & Partial<Pick<CapabilityCatalogItem, "metadata">>,
  catalogAssetUrl: (path: string | null) => string | null,
): string | null {
  if (item.id.startsWith("mcp:integrations-sh:gmailmcp-googleapis-com-")) return "/capability-logos/gmail.ico";
  const localLogo = FIRST_PARTY_CAPABILITY_LOGOS[item.id] ?? catalogAssetUrl(item.logoAssetPath);
  if (localLogo) return localLogo;

  // Imports retain the upstream URL after applying our curated overrides,
  // including explicit nulls that suppress a provider's logo.
  const upstreamLogo = item.metadata?.originalLogoUrl;
  if (typeof upstreamLogo !== "string") return null;
  try {
    const url = new URL(upstreamLogo);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
