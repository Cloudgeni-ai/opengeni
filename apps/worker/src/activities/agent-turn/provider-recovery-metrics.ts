import type { Observability } from "@opengeni/observability";

export type ProviderRecoveryObservation = {
  startedAt: number;
  cause: "rate_limited" | "unavailable" | "connectivity";
};

export function providerRecoveryCause(code: unknown): ProviderRecoveryObservation["cause"] | null {
  if (code === "provider_rate_limited") return "rate_limited";
  if (code === "provider_unavailable") return "unavailable";
  if (code === "upstream_connectivity_unavailable") return "connectivity";
  return null;
}

export function readProviderRecoveryObservation(
  metadata: Record<string, unknown>,
): ProviderRecoveryObservation | undefined {
  const cause = providerRecoveryCause(metadata.providerRecoveryReason);
  const startedAt =
    typeof metadata.providerRecoveryStartedAt === "string"
      ? Date.parse(metadata.providerRecoveryStartedAt)
      : Number.NaN;
  return cause && Number.isFinite(startedAt) ? { cause, startedAt } : undefined;
}

/** Operational observations only; never retry authority, billing or diagnostics. */
export function recordProviderRecoveryOutcome(
  observability: Observability,
  input: {
    route?: { provider: string; model: string } | undefined;
    cause: ProviderRecoveryObservation["cause"];
    outcome: "scheduled" | "recovered" | "exhausted";
    delayMs?: number;
    elapsedMs?: number;
  },
): void {
  if (!input.route) return;
  const labels = { ...input.route, cause: input.cause, outcome: input.outcome };
  try {
    observability.incrementCounter({
      name: "opengeni_model_recovery_total",
      help: "Observed model recovery decisions and successful resumptions.",
      labels,
    });
    if (input.delayMs !== undefined) {
      observability.observeHistogram({
        name: "opengeni_model_recovery_delay_seconds",
        help: "Scheduled model recovery delay, including provider hints and jitter.",
        labels: { ...input.route, cause: input.cause },
        value: Math.max(0, input.delayMs) / 1_000,
      });
    }
    if (input.elapsedMs !== undefined) {
      observability.observeHistogram({
        name: "opengeni_model_recovery_duration_seconds",
        help: "Elapsed recovery episode including backoff, preparation and model requests.",
        labels,
        value: Math.max(0, input.elapsedMs) / 1_000,
      });
    }
  } catch {
    // Metrics cannot interrupt settlement or model progress.
  }
}
