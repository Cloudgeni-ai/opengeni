import {
  capabilityCatalogItemIsTrustedForExposure,
  type CapabilityCatalogItem,
} from "@opengeni/contracts";

/**
 * Whether a connection card labels its service as an "MCP server". A reviewed
 * catalog integration reads as the service itself (its name and provider), so
 * the protocol is noise for most people. A server someone added by hand, or a
 * registry entry nobody reviewed, keeps the label, where it tells a technical
 * person what they are trusting. Unknown (still loading) shows no label.
 */
export function showsMcpServerLabel(
  item:
    | Pick<CapabilityCatalogItem, "source" | "stale" | "authKind" | "metadata">
    | null
    | undefined,
): boolean {
  if (!item) return false;
  switch (item.source) {
    case "built_in":
    case "library":
    case "configured":
      return false;
    case "registry":
      return !capabilityCatalogItemIsTrustedForExposure(item);
    default:
      return true;
  }
}
