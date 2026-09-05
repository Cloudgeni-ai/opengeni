import type { WorkDiscoveryMatchClass } from "@opengeni/contracts";
import type { Observability } from "@opengeni/observability";

export type WorkDiscoverySurface = "first_party_mcp" | "agent_topology";
export type WorkDiscoveryMode = "browse" | "query" | "subject";
export type WorkDiscoveryOutcome = "ok" | "empty" | "disabled" | "error";
export type WorkDiscoveryAuthorizationScope = "workspace" | "scoped";

export type WorkDiscoveryObservation = {
  surface: WorkDiscoverySurface;
  mode: WorkDiscoveryMode;
  outcome: WorkDiscoveryOutcome;
  authorizationScope: WorkDiscoveryAuthorizationScope;
  durationMs: number;
  responseBytes: number;
  resultCount: number;
  overlapCount: number;
  matchCounts: Partial<Record<WorkDiscoveryMatchClass, number>>;
};

type WorkDiscoveryObservedRow = {
  relatedWork?: {
    match: { class: WorkDiscoveryMatchClass } | null;
    possibleOverlap: boolean;
  };
};

const RESULT_BUCKETS = [0, 1, 2, 4, 8, 16, 32, 64, 100];
const RESPONSE_BYTE_BUCKETS = [512, 1_024, 4_096, 16_384, 65_536, 128_000, 262_144];
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export function summarizeWorkDiscoveryRows(
  rows: readonly WorkDiscoveryObservedRow[],
): Pick<WorkDiscoveryObservation, "resultCount" | "overlapCount" | "matchCounts"> {
  const matchCounts: WorkDiscoveryObservation["matchCounts"] = {};
  let overlapCount = 0;
  for (const row of rows) {
    if (row.relatedWork?.possibleOverlap) overlapCount += 1;
    const matchClass = row.relatedWork?.match?.class;
    if (matchClass) matchCounts[matchClass] = (matchCounts[matchClass] ?? 0) + 1;
  }
  return { resultCount: rows.length, overlapCount, matchCounts };
}

/**
 * Low-cardinality work-discovery telemetry. Identifiers, search text, subject
 * keys, titles, goals, claim labels, versions, and provenance are excluded by
 * construction. An observability failure never changes product behavior.
 */
export function observeWorkDiscovery(
  observability: Observability | null | undefined,
  observation: WorkDiscoveryObservation,
): void {
  if (!observability) return;
  const labels = {
    surface: observation.surface,
    mode: observation.mode,
    outcome: observation.outcome,
    authorization_scope: observation.authorizationScope,
  };
  try {
    observability.incrementCounter({
      name: "opengeni_work_discovery_requests_total",
      help: "Advisory work-discovery requests by bounded surface, mode, outcome, and authorization scope.",
      labels,
    });
    observability.observeHistogram({
      name: "opengeni_work_discovery_duration_seconds",
      help: "Advisory work-discovery request duration in seconds.",
      labels,
      buckets: DURATION_BUCKETS,
      value: Math.max(0, observation.durationMs) / 1_000,
    });
    observability.observeHistogram({
      name: "opengeni_work_discovery_results",
      help: "Bounded advisory work-discovery result rows per request.",
      labels: { surface: observation.surface, mode: observation.mode },
      buckets: RESULT_BUCKETS,
      value: Math.max(0, Math.floor(observation.resultCount)),
    });
    observability.observeHistogram({
      name: "opengeni_work_discovery_response_bytes",
      help: "Serialized advisory work-discovery response bytes.",
      labels: { surface: observation.surface, mode: observation.mode },
      buckets: RESPONSE_BYTE_BUCKETS,
      value: Math.max(0, Math.floor(observation.responseBytes)),
    });
    if (observation.overlapCount > 0) {
      observability.incrementCounter({
        name: "opengeni_work_discovery_overlap_results_total",
        help: "Advisory discovery rows carrying a possible-overlap explanation.",
        labels: { surface: observation.surface, mode: observation.mode },
        amount: Math.floor(observation.overlapCount),
      });
    }
    for (const matchClass of ["exact_subject", "title", "goal", "fuzzy"] as const) {
      const amount = Math.floor(observation.matchCounts[matchClass] ?? 0);
      if (amount < 1) continue;
      observability.incrementCounter({
        name: "opengeni_work_discovery_matches_total",
        help: "Advisory discovery matches by stable explanation class.",
        labels: {
          surface: observation.surface,
          mode: observation.mode,
          match_class: matchClass,
        },
        amount,
      });
    }
  } catch {
    try {
      observability.incrementCounter({
        name: "opengeni_observability_observer_errors_total",
        help: "Observability observer failures isolated from product execution.",
        labels: { observer: "work_discovery" },
      });
    } catch {
      // The metrics registry itself is unhealthy. Discovery remains authoritative.
    }
  }
}
