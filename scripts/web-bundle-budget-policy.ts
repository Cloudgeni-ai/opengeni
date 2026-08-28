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

/** Exact embedded-client plus attachment-preview Linux/x64 Bun 1.3.14 direct-session measurement. */
export const DIRECT_SESSION_RAW_MEASUREMENT = 2_200_819;
export const DIRECT_SESSION_RAW_BUDGET = wholeKibEnvelope(DIRECT_SESSION_RAW_MEASUREMENT);

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

/** Exact 0.23.12 homeserver backport with private-HTTP and Variable Set naming fixes. */
export const HOMESERVER_VARIABLE_NAME_UX_RAW_MEASUREMENT = 2_207_929;
export const HOMESERVER_VARIABLE_NAME_UX_RAW_BUDGET = wholeKibEnvelope(
  HOMESERVER_VARIABLE_NAME_UX_RAW_MEASUREMENT,
);
export const EFFECTIVE_DIRECT_SESSION_RAW_BUDGET = Math.max(
  DIRECT_SESSION_RAW_BUDGET,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
  WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET,
  HOMESERVER_VARIABLE_NAME_UX_RAW_BUDGET,
);
