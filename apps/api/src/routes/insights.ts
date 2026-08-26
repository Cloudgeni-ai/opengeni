import { InsightsRange, WorkspaceInsightsResponse } from "@opengeni/contracts";
import { getWorkspaceInsights, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { workspaceInsightsMetricObserver } from "@opengeni/observability";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerInsightsRoutes(app: Hono, deps: ApiRouteDeps): void {
  const observeRequest = workspaceInsightsMetricObserver(deps.observability);
  app.get("/v1/workspaces/:workspaceId/insights", async (c) => {
    const startedAtMs = performance.now();
    const rangeRaw = c.req.query("range") ?? "week";
    const providerRaw = c.req.query("provider");
    const modelRaw = c.req.query("model");
    const provider = providerRaw && providerRaw !== "all" ? providerRaw : null;
    const model = modelRaw && modelRaw !== "all" ? modelRaw : null;
    let outcome = "failed";

    try {
      const workspaceId = c.req.param("workspaceId");
      await requireAccessGrant(c, deps, workspaceId, "workspace:admin");

      const rangeParsed = InsightsRange.safeParse(rangeRaw);
      if (!rangeParsed.success) {
        throw new HTTPException(400, {
          message: "range must be one of today|week|month|ytd",
        });
      }

      const response = await getWorkspaceInsights(deps.db, deps.settings, {
        workspaceId,
        range: rangeParsed.data,
        provider,
        model,
      });
      c.header("cache-control", "private, no-store");
      const result = c.json(WorkspaceInsightsResponse.parse(response));
      outcome = "completed";
      return result;
    } finally {
      observeRequest({
        range: rangeRaw,
        providerFiltered: provider !== null,
        modelFiltered: model !== null,
        outcome,
        durationMs: performance.now() - startedAtMs,
      });
    }
  });
}
