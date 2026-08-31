import type { WorkspaceDeleteObservation, WorkspaceDeleteObserver } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1_200, 2_400,
  3_600,
];
const INVENTORY_BUCKETS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_000, 5_000, 10_000];

function recordWorkspaceDeleteObservation(
  observability: Observability,
  identity: { accountId: string; workspaceId: string },
  observation: WorkspaceDeleteObservation,
): void {
  const labels = { phase: observation.phase, outcome: observation.outcome };
  observability.observeHistogram({
    name: "opengeni_workspace_delete_phase_seconds",
    help: "Workspace deletion transaction and bounded internal phase duration in seconds.",
    labels,
    buckets: DURATION_BUCKETS,
    value: Math.max(0, observation.durationSeconds),
  });
  if (observation.phase === "transaction") {
    observability.incrementCounter({
      name: "opengeni_workspace_delete_attempts_total",
      help: "Workspace deletion attempts by terminal database outcome.",
      labels: { outcome: observation.outcome },
    });
  }
  for (const [kind, count] of Object.entries(observation.inventory ?? {})) {
    observability.observeHistogram({
      name: "opengeni_workspace_delete_inventory_rows",
      help: "Rows or live owners observed by workspace deletion preflight inventory class.",
      labels: { kind },
      buckets: INVENTORY_BUCKETS,
      value: Math.max(0, Math.floor(count ?? 0)),
    });
  }
  observability.info("Workspace deletion phase", {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    phase: observation.phase,
    outcome: observation.outcome,
    durationSeconds: observation.durationSeconds,
    inventoryJson: JSON.stringify(observation.inventory ?? {}),
  });
}

/**
 * Retain exact workspace deletion timing and inventory without putting tenant
 * identifiers in metric labels. Observer failures never change deletion truth.
 */
export function workspaceDeleteObserver(
  observability: Observability | null | undefined,
  identity: { accountId: string; workspaceId: string },
): WorkspaceDeleteObserver | undefined {
  if (!observability) return undefined;
  return {
    onPhase: (observation) => {
      try {
        recordWorkspaceDeleteObservation(observability, identity, observation);
      } catch {
        try {
          observability.incrementCounter({
            name: "opengeni_observability_observer_errors_total",
            help: "Observability observer failures isolated from product execution.",
            labels: { observer: "workspace_delete" },
          });
        } catch {
          // The metrics registry itself is unhealthy. Deletion remains authoritative.
        }
      }
    },
  };
}
