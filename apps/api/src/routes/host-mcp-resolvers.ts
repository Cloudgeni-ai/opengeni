import type { Hono } from "hono";
import { hostMcpResolverForRequest, type ApiRouteDeps } from "@opengeni/core";

export function registerHostMcpResolverRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/organizations/:organizationId/mcp-credential-resolvers/:externalSource";
  app.get(path, async (context) =>
    context.json(
      await hostMcpResolverForRequest(
        context,
        deps,
        context.req.param("organizationId"),
        context.req.param("externalSource"),
        "get",
      ),
    ),
  );
  app.put(path, async (context) =>
    context.json(
      await hostMcpResolverForRequest(
        context,
        deps,
        context.req.param("organizationId"),
        context.req.param("externalSource"),
        "put",
        await context.req.json().catch(() => null),
      ),
    ),
  );
  app.post(`${path}/revoke`, async (context) =>
    context.json(
      await hostMcpResolverForRequest(
        context,
        deps,
        context.req.param("organizationId"),
        context.req.param("externalSource"),
        "revoke",
        await context.req.json().catch(() => null),
      ),
    ),
  );
}
