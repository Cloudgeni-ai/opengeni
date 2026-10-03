import { createSessionProxyHandler, type SessionProxyHandlerOptions } from "../session-proxy";

/** Any web-standard handler: `createSessionProxyHandler`, `createChatHandler`, or your own. */
export type WebHandler = (request: Request) => Promise<Response>;

/** Route handlers for a Next.js App Router catch-all route. */
export type NextRouteHandlers = {
  GET: WebHandler;
  POST: WebHandler;
  PUT: WebHandler;
  PATCH: WebHandler;
  DELETE: WebHandler;
};

/**
 * Expose a web-standard handler as Next.js App Router route handlers.
 *
 * ```ts
 * // app/api/opengeni/[...path]/route.ts
 * export const dynamic = "force-dynamic";
 * export const { GET, POST, PUT, PATCH, DELETE } = toNextRouteHandlers(handler);
 * ```
 *
 * Next passes the full request URL (including any `basePath`), so the proxy's
 * own `/v1/` detection routes it; responses, including SSE, stream as-is.
 */
export function toNextRouteHandlers(handler: WebHandler): NextRouteHandlers {
  // Next calls route handlers with (request, context); only the request matters.
  const route: WebHandler = async (request) => await handler(request);
  return { GET: route, POST: route, PUT: route, PATCH: route, DELETE: route };
}

/**
 * `createSessionProxyHandler` as Next.js App Router route handlers, for
 * `app/<mount>/[...path]/route.ts`.
 */
export function createSessionProxyRoute(
  target: Parameters<typeof createSessionProxyHandler>[0],
  options: SessionProxyHandlerOptions,
): NextRouteHandlers {
  return toNextRouteHandlers(createSessionProxyHandler(target, options));
}
