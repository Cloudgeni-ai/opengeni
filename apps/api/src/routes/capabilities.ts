import {
  CapabilityCatalogResponse,
  CreateCapabilityCatalogItemRequest,
  DiscoverMcpCapabilitiesResponse,
  EnableCapabilityRequest,
} from "@opengeni/contracts";
import type { Hono } from "hono";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  buildCapabilityCatalog,
  createCatalogItem,
  disableCapability,
  discoverMcpRegistryCapabilities,
  enableCapability,
  officialMcpRegistryUrl,
} from "@opengeni/core";
import { boundedLimit } from "../http/common";

export function registerCapabilityRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings } = deps;

  app.get("/v1/workspaces/:workspaceId/capabilities", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(CapabilityCatalogResponse.parse(await buildCapabilityCatalog({ db, workspaceId, settings })));
  });

  app.post("/v1/workspaces/:workspaceId/capabilities", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = CreateCapabilityCatalogItemRequest.parse(await c.req.json());
    return c.json(await createCatalogItem({ db, accountId: grant.accountId, workspaceId, payload }), 201);
  });

  app.get("/v1/workspaces/:workspaceId/capabilities/discovery/mcp-registry", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const query = c.req.query("query");
    const options: { query?: string; limit?: number } = { limit: boundedLimit(c.req.query("limit")) };
    if (query) {
      options.query = query;
    }
    const items = await discoverMcpRegistryCapabilities(options);
    return c.json(DiscoverMcpCapabilitiesResponse.parse({
      items,
      source: "official_mcp_registry",
      sourceUrl: officialMcpRegistryUrl,
    }));
  });

  app.post("/v1/workspaces/:workspaceId/capabilities/:capabilityId/enable", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = EnableCapabilityRequest.parse(await c.req.json());
    const installation = await enableCapability({
      db,
      grant,
      accountId: grant.accountId,
      workspaceId,
      settings,
      capabilityId: decodeURIComponent(c.req.param("capabilityId")),
      payload,
    });
    return c.json(installation, 201);
  });

  app.post("/v1/workspaces/:workspaceId/capabilities/:capabilityId/disable", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const installation = await disableCapability({
      db,
      accountId: grant.accountId,
      workspaceId,
      settings,
      capabilityId: decodeURIComponent(c.req.param("capabilityId")),
    });
    return c.json(installation);
  });
}
