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

/** Exact Variable Set selection plus attachment-preview merge-tree measurement. */
export const VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT = 2_203_278;
export const VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET = wholeKibEnvelope(
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
);
export const EFFECTIVE_DIRECT_SESSION_RAW_BUDGET = Math.max(
  DIRECT_SESSION_RAW_BUDGET,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
);
