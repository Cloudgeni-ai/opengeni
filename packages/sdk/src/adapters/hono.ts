/** Any web-standard handler: `createSessionProxyHandler`, `createChatHandler`, or your own. */
export type WebHandler = (request: Request) => Promise<Response>;

/** The part of Hono's context this adapter uses (no Hono dependency). */
export type HonoContextLike = { req: { raw: Request } };

/**
 * Expose a web-standard handler as a Hono handler:
 *
 * ```ts
 * app.all("/api/opengeni/*", toHonoHandler(handler));
 * ```
 */
export function toHonoHandler(
  handler: WebHandler,
): (context: HonoContextLike) => Promise<Response> {
  return async (context) => await handler(context.req.raw);
}
