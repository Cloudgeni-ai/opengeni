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
 * always-loaded session graph after merging current main (a7a60271a). The local
 * Linux/x64 Bun 1.4 same-origin production graph measures 2,350,400 raw bytes.
 * Bind 2,350,418 so a 5-digit loopback URL still fits the documented 18-byte
 * configured-URL ceiling.
 */
export const TIMELINE_ANNOTATION_UX_RAW_MEASUREMENT = 2_350_418;
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
  // Pending organization-invitation chrome on the always-loaded rail footer
  // added 2,032 bytes on that 2,312,535 baseline (2,314,567 on Linux/x64).
  // Combined estimate after merging current main: 2,315,348 + 2,032 = 2,317,380.
  wholeKibEnvelope(2_317_380),
  // September 8, Bun 1.4 Linux/x64, embedding + main 45405585: 2,333,201
  // bytes. Connect setup/identity consent stay lazy; organization embedding
  // administration stays outside the browser client. This includes the native
  // actor-aware transport and main's identified product-journey capture.
  // Keep the measured envelope rather than relaxing startup/chunk/file limits.
  wholeKibEnvelope(2_333_201),
  wholeKibEnvelope(2_315_348),
  // September 8: organization subscription SDK methods and connection-policy
  // contracts add 4,920 raw / 1,330 gzip bytes over e30c35f07 on macOS.
  // Combined with main's invitation chrome and journey analytics, the integrated
  // graph measures 2,321,561 raw on macOS/Bun 1.3.14. Settings stay route-lazy;
  // retain all gzip, file-count, initial-load, and lazy-chunk ceilings.
  wholeKibEnvelope(2_321_561),
  // Exact Linux/x64 Bun1.4 merge with main0c39126f's organization subscriptions
  // and per-account model access: 2,345,266 raw bytes. Keep settings lazy and
  // all startup, file-count and per-chunk caps unchanged.
  wholeKibEnvelope(2_345_266),
  // Site-origin navigation and grouping: Bun 1.4 macOS/arm64 measures
  // 2,324,500 raw bytes. Splitting the tiny heading increases the graph to
  // 2,324,964 through shared chunk overhead, so retain synchronous rail UI.
  // Advance only the measured raw envelope; compressed and other caps stay fixed.
  wholeKibEnvelope(2_324_500),
  TIMELINE_ANNOTATION_UX_RAW_BUDGET,
);
