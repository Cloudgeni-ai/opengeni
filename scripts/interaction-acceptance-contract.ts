export type InteractionLatencyMetric =
  | "browserCreate"
  | "browserFirstFrame"
  | "browserObserve"
  | "browserActionAcknowledged"
  | "browserActionVisible"
  | "browserReconnect"
  | "computerCreate"
  | "computerFirstFrame"
  | "computerObserve"
  | "computerActionAcknowledged"
  | "computerActionVisible"
  | "computerReconnect"
  | "resourceEnd";

export type InteractionLatencyBudget = {
  statistic: "p95" | "worst";
  limitMs: number;
};

/**
 * End-to-end budgets for the shipped public SDK -> API -> placement controller
 * -> native driver path. These are deliberately user-perceived limits, not
 * isolated service timings. Cold resource creation is allowed seconds; once a
 * resource is live, observation/input/frame convergence is sub-second. The
 * current direct-RFB handshake has an explicit transport-specific exception
 * below; it does not weaken steady-state interaction budgets.
 */
export const INTERACTION_LATENCY_BUDGETS: Readonly<
  Record<InteractionLatencyMetric, InteractionLatencyBudget>
> = Object.freeze({
  browserCreate: { statistic: "p95", limitMs: 5_000 },
  browserFirstFrame: { statistic: "p95", limitMs: 1_500 },
  browserObserve: { statistic: "p95", limitMs: 350 },
  browserActionAcknowledged: { statistic: "p95", limitMs: 350 },
  browserActionVisible: { statistic: "p95", limitMs: 500 },
  browserReconnect: { statistic: "p95", limitMs: 1_500 },
  computerCreate: { statistic: "p95", limitMs: 10_000 },
  computerFirstFrame: { statistic: "p95", limitMs: 1_500 },
  computerObserve: { statistic: "p95", limitMs: 500 },
  computerActionAcknowledged: { statistic: "p95", limitMs: 750 },
  computerActionVisible: { statistic: "p95", limitMs: 750 },
  computerReconnect: { statistic: "p95", limitMs: 1_500 },
  resourceEnd: { statistic: "worst", limitMs: 3_000 },
});

/** RFB performs a version/security/client-init negotiation before the first
 * framebuffer. Keep that protocol-bound setup budget explicit without relaxing
 * the sub-second observe, input, or visible-frame convergence budgets. */
export function interactionLatencyBudgetsForTransport(
  computerTransport: "direct_rfb" | "direct_websocket" | "relay" | null,
): Readonly<Record<InteractionLatencyMetric, InteractionLatencyBudget>> {
  if (computerTransport !== "direct_rfb") return INTERACTION_LATENCY_BUDGETS;
  return Object.freeze({
    ...INTERACTION_LATENCY_BUDGETS,
    computerFirstFrame: { statistic: "p95", limitMs: 5_000 },
    computerReconnect: { statistic: "p95", limitMs: 5_000 },
  });
}
