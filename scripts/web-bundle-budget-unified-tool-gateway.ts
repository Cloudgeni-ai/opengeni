import {
  EFFECTIVE_DIRECT_SESSION_RAW_BUDGET as BASE_DIRECT_SESSION_RAW_BUDGET,
  wholeKibEnvelope,
} from "./web-bundle-budget-policy";

export {
  KIB,
  PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_FILE_COUNT,
  PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_GZIP_BUDGET,
} from "./web-bundle-budget-policy";

/**
 * Exact unified-tool-gateway browser graph on the September 4, 2026
 * active-work/current-main merge tree. The dynamic tool client remains behind
 * its first-call import, so catalog and invocation implementation bytes stay lazy.
 */
export const UNIFIED_TOOL_GATEWAY_BROWSER_RAW_MEASUREMENT = 2_290_677;
export const UNIFIED_TOOL_GATEWAY_BROWSER_RAW_BUDGET = wholeKibEnvelope(
  UNIFIED_TOOL_GATEWAY_BROWSER_RAW_MEASUREMENT,
);

export const EFFECTIVE_DIRECT_SESSION_RAW_BUDGET = Math.max(
  BASE_DIRECT_SESSION_RAW_BUDGET,
  UNIFIED_TOOL_GATEWAY_BROWSER_RAW_BUDGET,
);
