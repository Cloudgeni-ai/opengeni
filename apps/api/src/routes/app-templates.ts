import { ListAppTemplatesResponse } from "@opengeni/contracts";
import { appTemplates, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";

/**
 * Ready-made apps for the gallery (docs/app-packages.md). Adding one installs
 * its package through the ordinary app package install.
 */
export function registerAppTemplateRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/app-templates", async (context) => {
    await requireAccessGrant(context, deps, context.req.param("workspaceId"), "artifacts:read");
    return context.json(ListAppTemplatesResponse.parse({ templates: appTemplates() }));
  });
}
