// The customizable sidebar (docs/sidebar-layout.md): read the layout this
// person sees, change their own (anyone who can read the workspace) or the
// workspace default (workspace admins). The agent tools share the same core
// functions.
import {
  isSidebarExternalUrl,
  SidebarLayoutResponse,
  UpdateSidebarLayoutRequest,
} from "@opengeni/contracts";
import {
  readSidebarLayoutForGrant,
  requireAccessGrant,
  sidebarLinkOriginsForGrant,
  updateSidebarLayoutForGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { PinnedFetchOptions } from "@opengeni/network";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseRequestJson } from "../http/request-body";
import { userContentResponseHeaders } from "../http/user-content";
import { readSidebarLinkIcon } from "../sidebar-link-icon";

export function registerSidebarLayoutRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  /** Tests answer outside requests themselves. */
  linkIconFetch: PinnedFetchOptions = {},
): void {
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

  // The site icon of an outside link in the caller's sidebar, for links
  // without an icon of their own: 404 when the site has none to show.
  app.get("/v1/workspaces/:workspaceId/sidebar-layout/link-icon", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const url = c.req.query("url") ?? "";
    if (!isSidebarExternalUrl(url))
      throw new HTTPException(422, { message: "Give an outside link's https address as url." });
    const origins = await sidebarLinkOriginsForGrant(deps, grant);
    if (!origins.has(new URL(url).origin))
      throw new HTTPException(404, { message: "No link to that site in your sidebar." });
    const icon = await readSidebarLinkIcon(url, deps.settings, linkIconFetch);
    if (!icon) throw new HTTPException(404, { message: "That site has no icon to show." });
    // Another site's bytes: the shared user-content headers apply.
    for (const [name, value] of Object.entries(userContentResponseHeaders(icon.contentType)))
      c.header(name, value);
    c.header("cache-control", "private, max-age=86400");
    c.header("content-type", icon.contentType);
    return c.body(icon.bytes.slice().buffer as ArrayBuffer);
  });
}
