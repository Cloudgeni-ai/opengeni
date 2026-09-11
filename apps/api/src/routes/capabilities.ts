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
import { z } from "zod";
import pluginSnapshot from "../../../../data/catalog/plugins-snapshot.json";
const discoverablePlugins = pluginSnapshot.sources
  .flatMap((source) => source.entries.map((entry) => ({ ...entry, provider: source.provider })))
  .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
import { inspectMcpAuthentication } from "../integrations/oauth-client";

export function registerCapabilityRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings } = deps;
  app.get("/v1/workspaces/:workspaceId/capabilities/discovery/plugins", async (c) => {
    await requireAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:read");
    const query = (c.req.query("query") ?? "").trim().toLowerCase();
    const provider = c.req.query("provider");
    const id = c.req.query("id");
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(10000)
      .parse(c.req.query("offset") ?? 0);
    const matches = discoverablePlugins.filter(
      (item) =>
        (!id || item.id === id) &&
        (!provider || item.provider === provider) &&
        query
          .split(/\s+/)
          .every((term) =>
            [
              item.displayName,
              item.name,
              item.description,
              item.category,
              item.author?.name,
              ...item.keywords,
              ...(item.components ?? []),
            ]
              .join(" ")
              .toLowerCase()
              .includes(term),
          ),
    );
    const end = offset + 40;
    return c.json({
      items: matches.slice(offset, end),
      total: matches.length,
      nextOffset: end < matches.length ? end : null,
    });
  });
  app.post("/v1/workspaces/:workspaceId/capabilities/discovery/mcp-auth", async (c) => {
    await requireAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:read");
    const { url } = z.object({ url: z.string().url().max(2048) }).parse(await c.req.json());
    return c.json(await inspectMcpAuthentication(url, settings));
  });

  app.get("/v1/workspaces/:workspaceId/capabilities", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(
      CapabilityCatalogResponse.parse(
        await buildCapabilityCatalog({ db, workspaceId, settings, subjectId: grant.subjectId }),
      ),
    );
  });

  app.post("/v1/workspaces/:workspaceId/capabilities", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
    const payload = CreateCapabilityCatalogItemRequest.parse(await c.req.json());
    return c.json(
      await createCatalogItem({ db, accountId: grant.accountId, workspaceId, payload }),
      201,
    );
  });

  app.get("/v1/workspaces/:workspaceId/capabilities/discovery/mcp-registry", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const query = c.req.query("query");
    const options: { query?: string; limit?: number } = {
      limit: boundedLimit(c.req.query("limit")),
    };
    if (query) {
      options.query = query;
    }
    const items = await discoverMcpRegistryCapabilities(options);
    return c.json(
      DiscoverMcpCapabilitiesResponse.parse({
        items,
        source: "official_mcp_registry",
        sourceUrl: officialMcpRegistryUrl,
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/capabilities/:capabilityId/enable", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "capabilities:manage");
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
