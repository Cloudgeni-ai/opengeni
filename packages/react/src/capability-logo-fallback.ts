import type { CapabilityCatalogItem } from "@opengeni/sdk";
import gmailLogo from "./assets/gmail.ico";

/** Passive catalogue identity, shared by embedded and console surfaces. */
export function capabilityLogoFallback(
  item: Pick<CapabilityCatalogItem, "id"> &
    Partial<Pick<CapabilityCatalogItem, "metadata" | "mcpUrl">>,
): string | null {
  if (
    item.id.startsWith("mcp:integrations-sh:gmailmcp-googleapis-com-") ||
    item.mcpUrl === "https://gmailmcp.googleapis.com/mcp/v1"
  )
    return gmailLogo;
  const original = item.metadata?.originalLogoUrl;
  if (typeof original !== "string") return null;
  try {
    const url = new URL(original);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
