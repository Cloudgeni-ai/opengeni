// Always-loaded entry for a full-page connect redirect. The journey module is
// imported only when a redirect actually starts, so it stays out of the
// session bundle graph; the marker is written before the page navigates.
import type { IntegrationClass, IntegrationConnectMethod } from "./integration-connect-analytics";

export async function markIntegrationConnectRedirect(
  integrationClass: IntegrationClass | { domain: string | null | undefined },
  method: IntegrationConnectMethod,
  options?: { returnsWithOutcome?: boolean },
): Promise<void> {
  try {
    const { beginIntegrationConnect, integrationClassFromDomain } =
      await import("./integration-connect-analytics");
    beginIntegrationConnect(
      typeof integrationClass === "string"
        ? integrationClass
        : integrationClassFromDomain(integrationClass.domain),
      method,
    ).redirecting(options);
  } catch {
    // Optional telemetry cannot delay or fail the redirect.
  }
}
