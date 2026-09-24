import { InsightsRange, WorkspaceInsightsResponse } from "@opengeni/contracts";
import {
  getWorkspaceInsights,
  measureInsightsPhase,
  workspaceInsightsPhaseMetricObserver,
  normalizeWorkspaceInsightsFilter,
  requireAccessGrant,
  WorkspaceInsightsFilterValidationError,
  type ApiRouteDeps,
  type WorkspaceInsightsFilterField,
} from "@opengeni/core";
import { currentSessionRlsActorIdentityKey } from "@opengeni/db";
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

/**
 * Share one in-flight computation between identical concurrent callers.
 *
 * A reload, a second tab, or a retried fetch joins the rollup already running
 * instead of starting another multi-second aggregate on the database.
 * Authorization and filter validation still run per request before a caller
 * may join; the map only ever holds running work. The caller supplies the
 * complete sharing key, which must identify everything the result depends on.
 */
export function createInFlightCoalescer<T>(): {
  run: (key: string, work: () => Promise<T>) => Promise<T>;
  readonly size: number;
} {
  const inFlight = new Map<string, Promise<T>>();
  return {
    run(key, work) {
      const pending = inFlight.get(key);
      if (pending) return pending;
      const started: Promise<T> = work().finally(() => {
        if (inFlight.get(key) === started) inFlight.delete(key);
      });
      inFlight.set(key, started);
      return started;
    },
    get size() {
      return inFlight.size;
    },
  };
}

/**
 * Insights rows are filtered by the database RLS actor (private sessions are
 * visible only to their owner), so two administrators of one workspace can
 * legitimately receive different responses. The actor identity is part of
 * the key; requests share work only when every visibility input is equal.
 */
export function workspaceInsightsCoalesceKey(input: {
  workspaceId: string;
  range: string;
  provider: string | null;
  model: string | null;
  rlsActor: string | null;
}): string {
  return JSON.stringify([
    input.workspaceId,
    input.range,
    input.provider,
    input.model,
    input.rlsActor,
  ]);
}

export function registerInsightsRoutes(app: Hono, deps: ApiRouteDeps): void {
  const observeRequest = workspaceInsightsMetricObserver(deps.observability);
  const observePhase = workspaceInsightsPhaseMetricObserver(deps.observability);
  const coalesce = createInFlightCoalescer<Awaited<ReturnType<typeof getWorkspaceInsights>>>();
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
      await measureInsightsPhase(observePhase, "auth", () =>
        requireAccessGrant(c, deps, workspaceId, "workspace:admin"),
      );

      const rangeParsed = InsightsRange.safeParse(rangeRaw);
      if (!rangeParsed.success) {
        throw new HTTPException(400, {
          message: "range must be one of today|week|month|ytd",
        });
      }
      provider = normalizeWorkspaceInsightsQueryFilter(providerRaw, "provider");
      model = normalizeWorkspaceInsightsQueryFilter(modelRaw, "model");

      const response = await coalesce.run(
        workspaceInsightsCoalesceKey({
          workspaceId,
          range: rangeParsed.data,
          provider,
          model,
          rlsActor: currentSessionRlsActorIdentityKey(),
        }),
        () =>
          getWorkspaceInsights(
            deps.db,
            deps.settings,
            {
              workspaceId,
              range: rangeParsed.data,
              provider,
              model,
            },
            observePhase,
          ),
      );
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
