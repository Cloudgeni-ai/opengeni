import { withDatabaseTimingObserver, type DatabaseTimingObservation } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

const phases = new Set([
  "auth",
  "require_workspace",
  "model_bundle",
  "usage_bundle",
  "live_warm",
  "scheduled_tasks",
  "session_depth",
  "floor_sessions",
  "online_machines",
  "attached_sessions",
  "scheduled_fires",
] as const);
export type InsightsPhase = typeof phases extends Set<infer T> ? T : never;
export type InsightsPhaseObservation = {
  phase: InsightsPhase;
  stage: "helper" | DatabaseTimingObservation["stage"];
  outcome: "completed" | "failed";
  durationMs: number;
};
export type InsightsPhaseObserver = (observation: InsightsPhaseObservation) => void;
const stages = new Set([
  "helper",
  "transaction_admission",
  "savepoint_admission",
  "rls_setup",
  "scoped_callback",
]);

function observeSafely(
  observer: InsightsPhaseObserver,
  observation: InsightsPhaseObservation,
): void {
  try {
    void Promise.resolve(observer(observation)).catch(() => undefined);
  } catch {
    // Telemetry is never authoritative for results or authorization.
  }
}

/** Helper durations overlap under Promise.all; they must not be summed as request latency. */
export async function measureInsightsPhase<T>(
  observer: InsightsPhaseObserver | undefined,
  phase: InsightsPhase,
  work: () => Promise<T>,
): Promise<T> {
  if (!observer) return work();
  const started = performance.now();
  let outcome: InsightsPhaseObservation["outcome"] = "failed";
  try {
    const result = await withDatabaseTimingObserver(
      (observation) => observeSafely(observer, { ...observation, phase }),
      work,
    );
    outcome = "completed";
    return result;
  } finally {
    observeSafely(observer, {
      phase,
      stage: "helper",
      outcome,
      durationMs: performance.now() - started,
    });
  }
}

/** Closed runtime label projection: caller input, SQL and identities never become labels. */
export function workspaceInsightsPhaseMetricObserver(
  observability: Pick<Observability, "observeHistogram"> | null | undefined,
): InsightsPhaseObserver | undefined {
  if (!observability) return undefined;
  return (observation) => {
    try {
      const result = observability.observeHistogram({
        name: "opengeni_workspace_insights_phase_duration_seconds",
        help: "Insights helper and scoped DB durations; admission includes BEGIN or SAVEPOINT, scoped callback is not pure SQL time. Concurrent phases overlap.",
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 30, 60],
        labels: {
          phase: phases.has(observation.phase) ? observation.phase : "unknown",
          stage: stages.has(observation.stage) ? observation.stage : "unknown",
          outcome: observation.outcome === "completed" ? "completed" : "failed",
        },
        value: Number.isFinite(observation.durationMs)
          ? Math.max(0, observation.durationMs) / 1_000
          : 0,
      });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Includes exporter and metric registration failures.
    }
  };
}
