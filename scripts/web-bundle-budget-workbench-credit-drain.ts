import { KIB, wholeKibEnvelope } from "./web-bundle-budget-policy";

/**
 * Exact workbench credit-drain hang-fix Linux/x64 Bun 1.4 direct-session graph
 * (shared Files/Terminal unavailable overlay on current main). Do not rewrite
 * PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_* — that name is another candidate's
 * measurement. Advance only these hang-fix aggregates.
 */
export const WORKBENCH_CREDIT_DRAIN_HANGS_BROWSER_RAW_MEASUREMENT = 2_292_551;
export const WORKBENCH_CREDIT_DRAIN_HANGS_BROWSER_RAW_BUDGET = wholeKibEnvelope(
  WORKBENCH_CREDIT_DRAIN_HANGS_BROWSER_RAW_MEASUREMENT,
);

export const WORKBENCH_CREDIT_DRAIN_HANGS_BROWSER_GZIP_MEASUREMENT = 640_121;
export const WORKBENCH_CREDIT_DRAIN_HANGS_BROWSER_GZIP_BUDGET = wholeKibEnvelope(
  WORKBENCH_CREDIT_DRAIN_HANGS_BROWSER_GZIP_MEASUREMENT,
);

export { KIB };
