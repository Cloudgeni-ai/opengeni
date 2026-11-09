import type { CapabilityCatalogItem } from "@opengeni/sdk";
import { bundledServiceLogo } from "./connection-service-presentation";

/** Passive catalogue identity, shared by embedded and console surfaces. */
export function capabilityLogoFallback(
  item: Pick<CapabilityCatalogItem, "id"> &
    Partial<Pick<CapabilityCatalogItem, "metadata" | "mcpUrl">>,
): string | null {
  const bundled = bundledServiceLogo(item);
  if (bundled) return bundled;
  const original = item.metadata?.originalLogoUrl;
  if (typeof original !== "string") return null;
  try {
    const url = new URL(original);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
