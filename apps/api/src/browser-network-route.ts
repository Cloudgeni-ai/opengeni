import type {
  InteractionPlacement,
  NetworkRouteConfiguration,
  NetworkRouteConsistency,
} from "@opengeni/contracts";
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
  if (placement.kind !== "external_provider") {
    throw new BrowserSessionStateError(
      "Managed NetworkRoutes require an external browser provider placement",
    );
  }
  if (configuration.providerId !== placement.providerId) {
    throw new BrowserSessionStateError(
      "Managed NetworkRoute belongs to another external browser provider",
    );
  }
  if (configuration.credential !== null) {
    throw new BrowserSessionStateError(
      "Managed provider routes cannot use a separate proxy credential",
    );
  }
  if (consistency.dns !== "provider") {
    throw new BrowserSessionStateError("Managed provider routes require provider DNS");
  }
  if (configuration.providerId === "browserbase") {
    if (configuration.routeId !== "default" || configuration.egressClass !== "residential") {
      throw new BrowserSessionStateError(
        "Browserbase supports only its default managed residential route",
      );
    }
    if (configuration.region !== null && !/^[A-Za-z]{2}$/u.test(configuration.region)) {
      throw new BrowserSessionStateError(
        "Browserbase managed route region must be a two-letter country code",
      );
    }
    if (consistency.stability !== "session") {
      throw new BrowserSessionStateError(
        "Browserbase managed routing cannot promise a stable IP across sessions",
      );
    }
  } else if (configuration.providerId !== "kernel") {
    throw new BrowserSessionStateError(
      `Managed NetworkRoute provider ${configuration.providerId} is unsupported`,
    );
  }
  return {
    providerId: configuration.providerId,
    routeId: configuration.routeId,
    egressClass: configuration.egressClass,
    region: configuration.region,
  };
}
