import { localBrowserBoundaryResponse, type LocalBrowserBoundary } from "./local-browser-boundary";

export type ApiWebSocketUpgradeRoute<Server> = {
  handles(request: Request): boolean;
  upgrade(request: Request, server: Server): Response | undefined;
};

export type ApiWebSocketUpgradeDispatch =
  | { handled: false }
  | { handled: true; response: Response | undefined };

/**
 * WebSocket upgrades bypass the Hono app, so the local-mode browser boundary
 * (./local-browser-boundary.ts) is applied here before a transport upgrades.
 * Returns `{ handled: false }` when no transport claims the request, so the
 * caller dispatches it to the app, where the boundary runs as middleware.
 */
export function dispatchApiWebSocketUpgrade<Server>(
  request: Request,
  server: Server,
  routes: ReadonlyArray<ApiWebSocketUpgradeRoute<Server>>,
  localBrowserBoundary: LocalBrowserBoundary | null,
): ApiWebSocketUpgradeDispatch {
  const route = routes.find((candidate) => candidate.handles(request));
  if (!route) return { handled: false };
  const rejection = localBrowserBoundary?.rejection(request);
  if (rejection) return { handled: true, response: localBrowserBoundaryResponse(rejection) };
  return { handled: true, response: route.upgrade(request, server) };
}
