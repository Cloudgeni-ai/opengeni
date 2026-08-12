import type {
  InteractionPlacement,
  NetworkRouteConfiguration,
  NetworkRouteConsistency,
} from "@opengeni/contracts";
import { networkRoutePlacementCompatibilityIssue } from "@opengeni/contracts";
import { BrowserSessionStateError } from "@opengeni/db";
import type { PlacementBrowserNetworkRoute } from "@opengeni/runtime/sandbox";

/** Resolve one provider-neutral managed route into the exact private selector
 * accepted by the chosen external browser placement. Unsupported guarantees
 * fail before lifecycle dispatch; no provider API key enters this value. */
export function managedNetworkRouteForPlacement(
  configuration: Extract<NetworkRouteConfiguration, { kind: "managed" }>,
  consistency: NetworkRouteConsistency,
  placement: InteractionPlacement,
): NonNullable<PlacementBrowserNetworkRoute["providerRoute"]> {
  const compatibilityIssue = networkRoutePlacementCompatibilityIssue(
    configuration,
    consistency,
    placement,
  );
  if (compatibilityIssue) throw new BrowserSessionStateError(compatibilityIssue);
  if (placement.kind !== "external_provider") throw new Error("unreachable managed placement");
  if (configuration.providerId !== "browserbase" && configuration.providerId !== "kernel") {
    throw new Error("unreachable managed provider");
  }
  return {
    providerId: configuration.providerId,
    routeId: configuration.routeId,
    egressClass: configuration.egressClass,
    region: configuration.region,
  };
}
