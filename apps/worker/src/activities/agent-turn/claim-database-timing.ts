import { withDatabaseTimingObserver, type DatabaseTimingObservation } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import { recordTurnStartupPhase, type TurnStartupPhase } from "../../observability-metrics";

const phases = {
  transaction_admission: "claim_transaction_admission",
  savepoint_admission: "claim_savepoint_admission",
  rls_setup: "claim_rls_setup",
  scoped_callback: "claim_scoped_callback",
} as const satisfies Record<DatabaseTimingObservation["stage"], TurnStartupPhase>;

/** Aggregate within one claim, never per SQL statement. Admission includes
 * BEGIN/SAVEPOINT, not just pool wait; nested callbacks overlap their parents.
 * These observations are attribution, not additive critical-path intervals.
 */
export async function measureClaimDatabaseScopes<T>(
  observability: Observability,
  work: () => Promise<T>,
): Promise<T> {
  const totals = new Map<
    DatabaseTimingObservation["stage"],
    { count: number; durationMs: number; outcome: "completed" | "failed" }
  >();
  try {
    return await withDatabaseTimingObserver(({ stage, outcome, durationMs }) => {
      const total = totals.get(stage) ?? { count: 0, durationMs: 0, outcome: "completed" };
      total.count += 1;
      total.durationMs += durationMs;
      if (outcome === "failed") total.outcome = "failed";
      totals.set(stage, total);
    }, work);
  } finally {
    for (const [stage, total] of totals) {
      try {
        recordTurnStartupPhase(observability, {
          phase: phases[stage],
          provider: "unresolved",
          backend: "unresolved",
          outcome: total.outcome,
          durationSeconds: total.durationMs / 1_000,
          count: total.count,
        });
        observability.incrementCounter({
          name: "opengeni_turn_claim_database_scopes_total",
          help: "Database scope stages observed during claims, including nested scopes and retries.",
          labels: { stage, outcome: total.outcome },
          amount: total.count,
        });
      } catch {
        // Diagnostics cannot fail a claim or replace its original error.
      }
    }
  }
}
