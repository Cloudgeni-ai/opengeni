export type AcceptanceEnvironment = "staging" | "production" | "cross-environment";

export type AcceptanceRequirement = {
  id: string;
  environments: readonly AcceptanceEnvironment[];
};

const both = ["staging", "production"] as const;
const staging = ["staging"] as const;
const production = ["production"] as const;
const cross = ["cross-environment"] as const;

/**
 * Per-candidate release gate backed by the deployed live acceptance harness.
 *
 * This is intentionally narrower than the complete product-readiness program
 * in docs/workbench-acceptance.md. A release artifact may contain only claims
 * produced by a deterministic workflow. Manual real-device reviews, exploratory
 * visual polish, and long-running compatibility programs remain required
 * readiness work, but cannot be manufactured anew for every clean candidate.
 */
export const WORKBENCH_ACCEPTANCE_REQUIREMENTS = [
  { id: "release.exact-source", environments: both },
  { id: "security.auth-preflight", environments: both },
  { id: "functional.real-turn", environments: both },
  { id: "functional.capture-content", environments: both },
  { id: "security.signed-url-expiry-refresh", environments: both },
  { id: "functional.real-cold-lease", environments: both },
  { id: "functional.capture-cold-zero-channel-a", environments: both },
  { id: "functional.explicit-wake", environments: both },
  { id: "security.path-confinement", environments: both },
  { id: "functional.editor-guarded-save", environments: both },
  { id: "functional.terminal-roundtrip", environments: both },
  { id: "functional.desktop-framebuffer", environments: staging },
  { id: "functional.control-cancellation", environments: both },
  { id: "accessibility.automated", environments: both },
  { id: "accessibility.touch-targets", environments: both },
  { id: "performance.capture-api-response", environments: both },
  { id: "performance.capture-usable-workbench", environments: both },
  { id: "performance.control-cancellation", environments: both },
  { id: "release.exact-artifact-promotion", environments: cross },
  { id: "release.production-canary", environments: production },
] as const satisfies readonly AcceptanceRequirement[];

export type NumericBudget = {
  statistic: "p95" | "worst";
  direction: "maximum" | "minimum";
  limit: number;
  unit: "ms" | "fps" | "score" | "bytes";
};

export const NUMERIC_PERFORMANCE_BUDGETS: Readonly<Record<string, NumericBudget>> = {
  "performance.capture-api-response": {
    statistic: "p95",
    direction: "maximum",
    limit: 200,
    unit: "ms",
  },
  "performance.capture-usable-workbench": {
    statistic: "p95",
    direction: "maximum",
    limit: 500,
    unit: "ms",
  },
  "performance.control-cancellation": {
    statistic: "worst",
    direction: "maximum",
    limit: 2_000,
    unit: "ms",
  },
};
