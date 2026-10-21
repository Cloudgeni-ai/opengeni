// Router-free projection shared by the error beacon and the failure signals,
// so modules on the API client path never import the router.
import {
  CLIENT_ERROR_REVISION_PATTERN,
  CLIENT_ERROR_ROUTE_PATTERN,
} from "@opengeni/contracts/client-error-report";

/** Reduce a router `fullPath` to the reportable pattern, or `unknown`. */
export function clientRoutePattern(fullPath: string | undefined | null): string {
  if (!fullPath) return "unknown";
  const trimmed = fullPath.length > 1 ? fullPath.replace(/\/+$/, "") : fullPath;
  return CLIENT_ERROR_ROUTE_PATTERN.test(trimmed) ? trimmed : "unknown";
}

export function clientRevision(value: string | undefined | null): string {
  return value && CLIENT_ERROR_REVISION_PATTERN.test(value) ? value : "unknown";
}
