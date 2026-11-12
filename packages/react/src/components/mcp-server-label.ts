import {
  capabilityCatalogItemIsTrustedForExposure,
  type CapabilityCatalogItem,
} from "@opengeni/contracts";
import { microsoftDynamicsProductForMcpUrl } from "@opengeni/contracts/microsoft-dynamics";
import { capabilityPresentation } from "../integration-presentation";

/**
 * Whether a connection card labels its service as an "MCP server". A reviewed
 * catalog integration reads as the service itself (its name and provider), so
 * the protocol is noise for most people. A server someone added by hand, or a
 * registry entry nobody reviewed, keeps the label, where it tells a technical
 * person what they are trusting. Unknown (still loading) shows no label.
 */
export function showsMcpServerLabel(
  item:
    | (Pick<CapabilityCatalogItem, "source" | "stale" | "authKind" | "metadata"> &
        Partial<Pick<CapabilityCatalogItem, "endpointUrl">>)
    | null
    | undefined,
): boolean {
  if (!item) return false;
  // A Microsoft Dynamics environment is Microsoft's own service, signed in to
  // through a reviewed Opengeni profile, wherever its address was entered.
  if (item.endpointUrl && microsoftDynamicsProductForMcpUrl(item.endpointUrl)) return false;
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

/**
 * The quiet line under a connection card's name. A reviewed service names its
 * provider ("Google") when its catalog copy does and otherwise shows nothing;
 * its host name stays in the setup dialog's details. A server someone added
 * by hand, or one nobody reviewed, keeps its host, which is what a technical
 * person checks before trusting it.
 */
export function connectionCardSubtitle(
  item:
    | (Pick<
        CapabilityCatalogItem,
        "source" | "stale" | "authKind" | "metadata" | "providerDomain"
      > &
        Partial<Pick<CapabilityCatalogItem, "endpointUrl">>)
    | null
    | undefined,
): string {
  if (!item) return "";
  // Each Dynamics connection is one environment; its host tells them apart.
  if (item.endpointUrl && microsoftDynamicsProductForMcpUrl(item.endpointUrl))
    return new URL(item.endpointUrl).hostname;
  if (showsMcpServerLabel(item)) return item.providerDomain ?? "";
  return capabilityPresentation(item.metadata)?.providerName ?? "";
}
