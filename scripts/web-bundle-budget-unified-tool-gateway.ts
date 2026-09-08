import {
  EFFECTIVE_DIRECT_SESSION_RAW_BUDGET as BASE_DIRECT_SESSION_RAW_BUDGET,
  wholeKibEnvelope,
} from "./web-bundle-budget-policy";

export {
  KIB,
  wholeKibEnvelope,
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

/**
 * Timeline-annotation composer chip, numbered badges, and review dialog on the
 * always-loaded session graph. Linux CI on 8ea93c686 measured 2,333,281 raw
 * bytes for the default same-origin build and 2,333,299 with a configured
 * loopback API URL. Bind the worse configured graph.
 */
export const TIMELINE_ANNOTATION_UX_RAW_MEASUREMENT = 2_333_299;
export const TIMELINE_ANNOTATION_UX_RAW_BUDGET = wholeKibEnvelope(
  TIMELINE_ANNOTATION_UX_RAW_MEASUREMENT,
);

export const EFFECTIVE_DIRECT_SESSION_RAW_BUDGET = Math.max(
  BASE_DIRECT_SESSION_RAW_BUDGET,
  UNIFIED_TOOL_GATEWAY_BROWSER_RAW_BUDGET,
  // September 6, Bun 1.4 macOS/arm64: main 52ff56a94 measures 2,309,542
  // raw bytes; history anchoring and input handling measure 2,312,535.
  wholeKibEnvelope(2_312_535),
  // September 7: idle queue-offer chrome lifts the graph to 2,315,348.
  wholeKibEnvelope(2_315_348),
  // September 8: organization subscription SDK methods and connection-policy
  // contracts add 4,920 raw / 1,330 gzip bytes over e30c35f07 on macOS.
  // Combined with main's invitation chrome and journey analytics, the integrated
  // graph measures 2,321,561 raw on macOS/Bun 1.3.14. Settings stay route-lazy;
  // retain all gzip, file-count, initial-load, and lazy-chunk ceilings.
  wholeKibEnvelope(2_321_561),
  TIMELINE_ANNOTATION_UX_RAW_BUDGET,
);
