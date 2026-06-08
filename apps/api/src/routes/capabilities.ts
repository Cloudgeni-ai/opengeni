import {
  CapabilityCatalogResponse,
  CreateCapabilityCatalogItemRequest,
  DiscoverMcpCapabilitiesResponse,
  EnableCapabilityRequest,
} from "@opengeni/contracts";
import type { Hono } from "hono";
import type { ApiRouteDeps } from "../dependencies";
import {
  buildCapabilityCatalog,
  createCatalogItem,
  disableCapability,
  discoverMcpRegistryCapabilities,
  enableCapability,
  officialMcpRegistryUrl,
} from "../domain/capabilities";
import { boundedLimit } from "../http/common";

export function registerCapabilityRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings } = deps;

  app.get("/v1/capabilities", async (c) => {
    return c.json(CapabilityCatalogResponse.parse(await buildCapabilityCatalog({ db, settings })));
  });

  app.post("/v1/capabilities", async (c) => {
    const payload = CreateCapabilityCatalogItemRequest.parse(await c.req.json());
    return c.json(await createCatalogItem({ db, payload }), 201);
  });

  app.get("/v1/capabilities/discovery/mcp-registry", async (c) => {
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

  app.post("/v1/capabilities/:capabilityId/enable", async (c) => {
    const payload = EnableCapabilityRequest.parse(await c.req.json());
    const installation = await enableCapability({
      db,
      settings,
      capabilityId: decodeURIComponent(c.req.param("capabilityId")),
      payload,
    });
    return c.json(installation, 201);
  });

  app.post("/v1/capabilities/:capabilityId/disable", async (c) => {
    const installation = await disableCapability({
      db,
      settings,
      capabilityId: decodeURIComponent(c.req.param("capabilityId")),
    });
    return c.json(installation);
  });
}
