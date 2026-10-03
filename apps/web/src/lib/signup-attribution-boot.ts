import { retainIntegrationConnectReturn } from "./integration-connect-return";
import { retainSignupAttribution } from "./signup-attribution";

// Side-effect entry imported by main.tsx ahead of the router: capture
// first-touch campaign parameters in memory and consume one-shot auth return
// markers before TanStack Router caches the initial location. The closed
// outcome of a provider connect return is snapshotted too, because its route
// handler strips it from the URL before analytics may have loaded.
if (typeof window !== "undefined") {
  retainSignupAttribution(window);
  retainIntegrationConnectReturn(window.location.search);
}
