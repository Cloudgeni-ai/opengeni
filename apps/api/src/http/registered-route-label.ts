import type { Context } from "hono";
import { matchedRoutes } from "hono/route";

/**
 * The registered Hono path template of the handler that answers this request.
 *
 * Hono resolves every route matching a request before the first middleware
 * runs, so the metrics middleware can read the exact code-owned template (for
 * example `/v1/workspaces/:workspaceId/rigs/:rigId`) without re-implementing
 * routing. Templates come only from route registrations, never from request
 * data, so they are a closed and bounded metric/log label set.
 *
 * Middleware (arity two: `(context, next)`) and global catch-alls never name a
 * route; the first matched terminal handler is the one Hono dispatches to.
 */
export function registeredHandlerRoutePath(context: Context): string | null {
  try {
    for (const route of matchedRoutes(context)) {
      if (typeof route.handler !== "function" || route.handler.length >= 2) continue;
      const label = boundedRegisteredRouteLabel(route.path);
      if (label) return label;
    }
  } catch {
    // Route labels are observational and must never affect request handling.
  }
  return null;
}

/** Normalize a registered template; drop catch-alls that would name nothing. */
export function boundedRegisteredRouteLabel(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/") || path === "/*") return null;
  // `:param{regex}` constraints are routing detail, not part of the label.
  return path.replace(/(:[A-Za-z0-9_]+)\{[^/]*\}/g, "$1");
}
