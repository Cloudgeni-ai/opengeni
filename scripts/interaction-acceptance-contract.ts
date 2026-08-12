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
 * resource is live, observation/input/frame convergence is sub-second.
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
  computerCreate: { statistic: "p95", limitMs: 5_000 },
  computerFirstFrame: { statistic: "p95", limitMs: 1_500 },
  computerObserve: { statistic: "p95", limitMs: 500 },
  computerActionAcknowledged: { statistic: "p95", limitMs: 500 },
  computerActionVisible: { statistic: "p95", limitMs: 750 },
  computerReconnect: { statistic: "p95", limitMs: 1_500 },
  resourceEnd: { statistic: "worst", limitMs: 3_000 },
});
