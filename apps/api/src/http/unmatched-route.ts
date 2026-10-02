import type { Context, Hono } from "hono";
import { matchedRoutes } from "hono/route";

type RegisteredRoute = { method: string; path: string; handler: unknown };

const PROBED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Whether a matched Hono route is a terminal handler rather than middleware.
 *
 * Method-specific registrations (`app.get`, `app.put`, `app.on([...])`) always
 * belong to a real route. `app.use` and `app.all` both register the `ALL`
 * method; Hono itself tells them apart by arity - middleware takes
 * `(context, next)` - so the same rule is applied here.
 */
function isTerminalRoute(route: RegisteredRoute): boolean {
  if (route.method.toUpperCase() !== "ALL") return true;
  return typeof route.handler === "function" && route.handler.length < 2;
}

function routesFor(app: Hono, method: string, path: string): RegisteredRoute[] {
  // Every Hono router returns `[[ [handler, route], params ][], stash?]`.
  const result = app.router.match(method, path) as unknown as [
    Array<[[unknown, RegisteredRoute], unknown]>,
    ...unknown[],
  ];
  return result[0].map(([[, route]]) => route);
}

export type UnmatchedRoute = { status: 404 } | { status: 405; allow: string[] };

/**
 * Classify a request no registered handler can answer, BEFORE authentication
 * or authorization middleware runs. Those layers otherwise turn a request for a
 * route that does not exist into an authorization-shaped failure (for example
 * the fail-closed session operation classifier answering a retryable 503), so
 * a client probing an unknown method or path would be told to retry forever.
 *
 * Returns null when the request has a handler, or when classification itself
 * fails (fail open: the request keeps its previous routing behavior).
 */
export function unmatchedRoute(app: Hono, c: Context): UnmatchedRoute | null {
  const method = c.req.method.toUpperCase();
  // CORS preflights are answered by middleware and have no route handlers.
  if (method === "OPTIONS") return null;
  try {
    if (matchedRoutes(c).some((route) => isTerminalRoute(route as RegisteredRoute))) {
      return null;
    }
    const effectiveMethod = method === "HEAD" ? "GET" : method;
    const allow = PROBED_METHODS.filter(
      (candidate) =>
        candidate !== effectiveMethod &&
        routesFor(app, candidate, c.req.path).some(isTerminalRoute),
    );
    return allow.length > 0 ? { status: 405, allow } : { status: 404 };
  } catch {
    return null;
  }
}
