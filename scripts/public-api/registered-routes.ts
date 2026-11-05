/**
 * The routes the API app registers, with every deployment flag that gates
 * route registration enabled, so the inventory is the maximal surface a
 * managed deployment can expose. Shared by the public API check and the
 * published-SDK inventory refresh.
 */
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../../apps/api/src/app";

export function registeredRoutes(): { method: string; path: string }[] {
  const settings = testSettings({
    authRequired: true,
    accessKey: "public-api-surface",
    productAccessMode: "configured",
    integrationsEnabled: true,
    codexSubscriptionEnabled: true,
    supergrokSubscriptionEnabled: true,
    sandboxSelfhostedEnabled: true,
    sandboxDesktopEnabled: true,
    streamControlEnabled: true,
    mcpOauthEnabled: true,
  });
  const observability = createObservability(settings, { component: "api" });
  observability.info = () => undefined;
  observability.warn = () => undefined;
  const app = createApp({
    settings,
    observability,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const seen = new Set<string>();
  const routes: { method: string; path: string }[] = [];
  for (const route of app.routes) {
    // Middleware (`(c, next)`) and catch-all mounts are not callable routes.
    if (route.method === "ALL" || route.handler.length >= 2) continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method, path: route.path });
  }
  return routes;
}
