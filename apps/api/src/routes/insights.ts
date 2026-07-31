import { InsightsRange, WorkspaceInsightsResponse } from "@opengeni/contracts";
import { getWorkspaceInsights, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerInsightsRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/insights", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");

    const rangeRaw = c.req.query("range") ?? "week";
    const rangeParsed = InsightsRange.safeParse(rangeRaw);
    if (!rangeParsed.success) {
      throw new HTTPException(400, {
        message: "range must be one of today|week|month|ytd",
      });
    }
    const provider = c.req.query("provider");
    const model = c.req.query("model");

    const response = await getWorkspaceInsights(deps.db, deps.settings, {
      workspaceId,
      range: rangeParsed.data,
      provider: provider && provider !== "all" ? provider : null,
      model: model && model !== "all" ? model : null,
    });
    c.header("cache-control", "private, no-store");
    return c.json(WorkspaceInsightsResponse.parse(response));
  });
}
