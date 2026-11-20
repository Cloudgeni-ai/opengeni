// The customizable sidebar (docs/sidebar-layout.md): read the layout this
// person sees, change their own (anyone who can read the workspace) or the
// workspace default (workspace admins). The agent tools share the same core
// functions.
import { SidebarLayoutResponse, UpdateSidebarLayoutRequest } from "@opengeni/contracts";
import {
  readSidebarLayoutForGrant,
  requireAccessGrant,
  updateSidebarLayoutForGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import { parseRequestJson } from "../http/request-body";

export function registerSidebarLayoutRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/sidebar-layout", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    c.header("cache-control", "private, no-store");
    return c.json(SidebarLayoutResponse.parse(await readSidebarLayoutForGrant(deps, grant)));
  });

  app.patch("/v1/workspaces/:workspaceId/sidebar-layout", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const payload = await parseRequestJson(c, UpdateSidebarLayoutRequest);
    c.header("cache-control", "private, no-store");
    return c.json(
      SidebarLayoutResponse.parse(await updateSidebarLayoutForGrant(deps, grant, payload)),
    );
  });
}
