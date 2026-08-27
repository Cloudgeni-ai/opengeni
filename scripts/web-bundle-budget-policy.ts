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

/** Exact attachment-preview/drop-overlay Linux/x64 Bun 1.3.14 direct-session measurement. */
export const DIRECT_SESSION_RAW_MEASUREMENT = 2_199_485;
export const DIRECT_SESSION_RAW_BUDGET = wholeKibEnvelope(DIRECT_SESSION_RAW_MEASUREMENT);
