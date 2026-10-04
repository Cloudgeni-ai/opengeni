// Entry for a full-page connect redirect from the session route and the app
// context. Importing the journey module on demand keeps those call sites from
// adding a static edge to it (it is still loaded with lib/analytics.ts when
// analytics is active); the marker is written before the page navigates.
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
