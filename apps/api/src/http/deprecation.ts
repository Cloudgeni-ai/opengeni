import type { Context, MiddlewareHandler } from "hono";
import { ApiHttpError } from "./api-error";
import { registeredHandlerRoutePath } from "./registered-route-label";

/**
 * The answer of a public route that was removed after its deprecation: 410
 * `gone`, naming the route that replaced it ("METHOD /v1/path") so a caller
 * can move without reading docs. Call it with literal arguments: the
 * organization MCP action catalog reads the replacement from the handler
 * (scripts/public-api/action-catalog.ts), leaves the retired action out of
 * search and points describe and call at its replacement.
 */
export function routeRetired(replacement: string, message: string): ApiHttpError {
  return new ApiHttpError(410, {
    code: "gone",
    message,
    retryable: false,
    outcomeUnknown: false,
    details: { code: "route_retired", replacement },
  });
}

/**
 * A public `/v1` route whose current behaviour is scheduled for removal.
 *
 * See docs/design/api-compatibility-policy.md: a breaking change to the public
 * surface is announced, advertised on every affected response with the
 * standard `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers plus a
 * `Link: rel="deprecation"` to the migration notes, and the old behaviour is
 * kept for at least 90 days on the managed service or until the next major,
 * whichever is later. Published SDKs surface these headers to the integrator.
 */
export type RouteDeprecation = {
  /** Upper-case HTTP method. */
  method: string;
  /** The exact registered Hono template, e.g. `/v1/workspaces/:workspaceId/packs`. */
  path: string;
  /** When the deprecation was announced (ISO 8601). */
  deprecatedAt: string;
  /** Earliest removal on the managed service (ISO 8601). */
  sunset: string;
  /** Public migration notes (changelog/docs URL). */
  link: string;
  /** Optional successor route or document. */
  successor?: string;
};

/**
 * Every currently deprecated public route. Adding an entry here is the
 * server-side half of a deprecation; the breaking change itself still needs an
 * entry in scripts/public-api-breaking-changes.json and a new major.
 */
export const DEPRECATED_ROUTES: readonly RouteDeprecation[] = [
  // The first automation API (sources, triggers, runs and its webhook) and
  // PR Review, which was built on it. Automations are now scheduled tasks
  // with event triggers on event sources; pull-request review is one of them.
  ...(
    [
      ["GET", "/v1/workspaces/:workspaceId/automations/sources"],
      ["POST", "/v1/workspaces/:workspaceId/automations/sources"],
      ["PATCH", "/v1/workspaces/:workspaceId/automations/sources/:sourceId"],
      ["DELETE", "/v1/workspaces/:workspaceId/automations/sources/:sourceId"],
      ["POST", "/v1/workspaces/:workspaceId/automations/sources/:sourceId/events"],
      ["GET", "/v1/workspaces/:workspaceId/automations/triggers"],
      ["POST", "/v1/workspaces/:workspaceId/automations/triggers"],
      ["PATCH", "/v1/workspaces/:workspaceId/automations/triggers/:triggerId"],
      ["DELETE", "/v1/workspaces/:workspaceId/automations/triggers/:triggerId"],
      ["GET", "/v1/workspaces/:workspaceId/automations/runs"],
      ["POST", "/v1/webhooks/automations/:endpointId"],
      ["GET", "/v1/workspaces/:workspaceId/pr-review/registrations"],
      ["POST", "/v1/workspaces/:workspaceId/pr-review/registrations"],
      ["PATCH", "/v1/workspaces/:workspaceId/pr-review/registrations/:registrationId"],
      ["DELETE", "/v1/workspaces/:workspaceId/pr-review/registrations/:registrationId"],
      ["POST", "/v1/workspaces/:workspaceId/pr-review/repositories"],
      ["PATCH", "/v1/workspaces/:workspaceId/pr-review/repositories/:bindingId"],
      ["DELETE", "/v1/workspaces/:workspaceId/pr-review/repositories/:bindingId"],
      ["GET", "/v1/workspaces/:workspaceId/pr-review/github"],
    ] as const
  ).map(
    ([method, path]): RouteDeprecation => ({
      method,
      path,
      deprecatedAt: "2026-10-24T00:00:00Z",
      sunset: "2027-01-25T00:00:00Z",
      link: "https://docs.opengeni.ai/integrate/background-agents#moving-from-the-first-automation-api",
      successor: "https://docs.opengeni.ai/integrate/background-agents#from-your-products-events",
    }),
  ),
];

const MINIMUM_NOTICE_MS = 90 * 24 * 60 * 60 * 1000;

function isoMillis(value: string, field: string, deprecation: RouteDeprecation): number {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new Error(
      `deprecation ${deprecation.method} ${deprecation.path}: ${field} is not an ISO date`,
    );
  }
  return millis;
}

/** Validate one registry entry; the policy's 90-day minimum is enforced here. */
export function assertValidRouteDeprecation(deprecation: RouteDeprecation): void {
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(deprecation.method)) {
    throw new Error(`deprecation method must be an upper-case HTTP verb: ${deprecation.method}`);
  }
  if (!deprecation.path.startsWith("/v1/")) {
    throw new Error(`deprecation path must be a /v1 route template: ${deprecation.path}`);
  }
  const deprecatedAt = isoMillis(deprecation.deprecatedAt, "deprecatedAt", deprecation);
  const sunset = isoMillis(deprecation.sunset, "sunset", deprecation);
  if (sunset - deprecatedAt < MINIMUM_NOTICE_MS) {
    throw new Error(
      `deprecation ${deprecation.method} ${deprecation.path}: sunset must be at least 90 days after deprecatedAt`,
    );
  }
  if (!/^https:\/\//.test(deprecation.link)) {
    throw new Error(
      `deprecation ${deprecation.method} ${deprecation.path}: link must be an https URL`,
    );
  }
}

/** The response headers that advertise one deprecation. */
export function deprecationHeaders(deprecation: RouteDeprecation): Record<string, string> {
  const deprecatedAt = Math.floor(Date.parse(deprecation.deprecatedAt) / 1000);
  const links = [`<${deprecation.link}>; rel="deprecation"; type="text/html"`];
  if (deprecation.successor) links.push(`<${deprecation.successor}>; rel="successor-version"`);
  return {
    // RFC 9745: a structured-field date, `@<unix seconds>`.
    Deprecation: `@${deprecatedAt}`,
    // RFC 8594: an HTTP-date.
    Sunset: new Date(deprecation.sunset).toUTCString(),
    Link: links.join(", "),
  };
}

function appendHeader(context: Context, name: string, value: string): void {
  const existing = context.res.headers.get(name);
  context.res.headers.set(name, existing ? `${existing}, ${value}` : value);
}

/**
 * Stamp deprecation headers on every response from a registered deprecated
 * route, including error responses, so an integrator sees the notice whatever
 * the call's outcome. Matching uses the registered route template, never
 * request data.
 */
export function deprecationHeadersMiddleware(
  registry: readonly RouteDeprecation[] = DEPRECATED_ROUTES,
): MiddlewareHandler {
  for (const deprecation of registry) assertValidRouteDeprecation(deprecation);
  const byRoute = new Map(registry.map((entry) => [`${entry.method} ${entry.path}`, entry]));
  return async (context, next) => {
    await next();
    if (byRoute.size === 0) return;
    const path = registeredHandlerRoutePath(context);
    if (!path) return;
    const deprecation = byRoute.get(`${context.req.method} ${path}`);
    if (!deprecation) return;
    const headers = deprecationHeaders(deprecation);
    try {
      context.res.headers.set("Deprecation", headers.Deprecation!);
    } catch {
      // Immutable headers (a proxied or redirect response): copy once.
      context.res = new Response(context.res.body, context.res);
      context.res.headers.set("Deprecation", headers.Deprecation!);
    }
    context.res.headers.set("Sunset", headers.Sunset!);
    appendHeader(context, "Link", headers.Link!);
  };
}
