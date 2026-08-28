export const KIB = 1024;
export const MINIMUM_RAW_HEADROOM_BYTES = KIB;

export function wholeKibEnvelope(
  measuredBytes: number,
  minimumHeadroomBytes = MINIMUM_RAW_HEADROOM_BYTES,
): number {
  if (!Number.isSafeInteger(measuredBytes) || measuredBytes < 0) {
    throw new TypeError("measured bundle bytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(minimumHeadroomBytes) || minimumHeadroomBytes < 1) {
    throw new TypeError("bundle headroom bytes must be a positive safe integer");
  }
  return Math.ceil((measuredBytes + minimumHeadroomBytes) / KIB) * KIB;
}

/** Exact personal-GitHub plus current-main Linux/x64 Bun 1.4 measurement. */
export const DIRECT_SESSION_RAW_MEASUREMENT = 2_219_469;
export const DIRECT_SESSION_RAW_BUDGET = wholeKibEnvelope(DIRECT_SESSION_RAW_MEASUREMENT);

/** Exact timeline-hardening plus its reviewed main Linux/x64 Bun 1.4 measurement. */
export const TIMELINE_HARDENING_MERGE_TREE_RAW_MEASUREMENT = 2_201_700;
export const TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET = wholeKibEnvelope(
  TIMELINE_HARDENING_MERGE_TREE_RAW_MEASUREMENT,
);

/** Exact timeline-hardening plus current-main Linux/x64 Bun 1.4 measurement. */
export const TIMELINE_HARDENING_CURRENT_MAIN_RAW_MEASUREMENT = 2_222_765;
export const TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET = wholeKibEnvelope(
  TIMELINE_HARDENING_CURRENT_MAIN_RAW_MEASUREMENT,
);

/** Exact version-frozen release-source Linux/x64 Bun 1.4 workload measurement. */
export const VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT = 2_205_043;
export const VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET = wholeKibEnvelope(
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
);

/** Exact current-main permission-scoped work-discovery Linux/x64 Bun 1.4 measurement. */
export const WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT = 2_206_112;
export const WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET = wholeKibEnvelope(
  WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT,
);

/** Exact workspace-member administration Linux/x64 Bun 1.4 merge-tree measurement. */
export const WORKSPACE_MEMBER_ADMINISTRATION_RAW_MEASUREMENT = 2_210_226;
export const WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET = wholeKibEnvelope(
  WORKSPACE_MEMBER_ADMINISTRATION_RAW_MEASUREMENT,
);

/** Exact workspace-member administration plus protected-main Linux/x64 Bun 1.4 measurement. */
export const WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_MEASUREMENT = 2_224_726;
export const WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET = wholeKibEnvelope(
  WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_MEASUREMENT,
);

/** Exact managed-social-sign-in current-main merge-tree measurement. */
export const MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_MEASUREMENT = 2_226_468;
export const MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET = wholeKibEnvelope(
  MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_MEASUREMENT,
);

/** Exact bounded HTTP/1 browser-stream Linux/x64 Bun 1.4 measurement. */
export const HTTP1_BROWSER_STREAMS_RAW_MEASUREMENT = 2_237_019;
export const HTTP1_BROWSER_STREAMS_RAW_BUDGET = wholeKibEnvelope(
  HTTP1_BROWSER_STREAMS_RAW_MEASUREMENT,
);
export const EFFECTIVE_DIRECT_SESSION_RAW_BUDGET = Math.max(
  DIRECT_SESSION_RAW_BUDGET,
  TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET,
  TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
  WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET,
  WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET,
  WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET,
  MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET,
  HTTP1_BROWSER_STREAMS_RAW_BUDGET,
);
