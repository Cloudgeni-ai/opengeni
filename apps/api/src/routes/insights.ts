import { InsightsRange, WorkspaceInsightsResponse } from "@opengeni/contracts";
import {
  getWorkspaceInsights,
  normalizeWorkspaceInsightsFilter,
  requireAccessGrant,
  WorkspaceInsightsFilterValidationError,
  type ApiRouteDeps,
  type WorkspaceInsightsFilterField,
} from "@opengeni/core";
import { workspaceInsightsMetricObserver } from "@opengeni/observability";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function normalizeWorkspaceInsightsQueryFilter(
  value: string | null | undefined,
  field: WorkspaceInsightsFilterField,
): string | null {
  try {
    return normalizeWorkspaceInsightsFilter(value, field);
  } catch (error) {
    if (error instanceof WorkspaceInsightsFilterValidationError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }
}

export function registerInsightsRoutes(app: Hono, deps: ApiRouteDeps): void {
  const observeRequest = workspaceInsightsMetricObserver(deps.observability);
  app.get("/v1/workspaces/:workspaceId/insights", async (c) => {
    const startedAtMs = performance.now();
    const rangeRaw = c.req.query("range") ?? "week";
    const providerRaw = c.req.query("provider");
    const modelRaw = c.req.query("model");
    let provider: string | null = null;
    let model: string | null = null;
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
      provider = normalizeWorkspaceInsightsQueryFilter(providerRaw, "provider");
      model = normalizeWorkspaceInsightsQueryFilter(modelRaw, "model");

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
