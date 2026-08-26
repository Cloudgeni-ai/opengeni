import { describe, expect, test } from "bun:test";

import {
  DIRECT_SESSION_RAW_BUDGET,
  DIRECT_SESSION_RAW_MEASUREMENT,
  KIB,
  MINIMUM_RAW_HEADROOM_BYTES,
  wholeKibEnvelope,
} from "./web-bundle-budget-policy";

describe("web bundle budget policy", () => {
  test("retains at least one KiB above the exact current-main merged graph", () => {
    expect(DIRECT_SESSION_RAW_MEASUREMENT).toBe(2_190_109);
    expect(DIRECT_SESSION_RAW_BUDGET).toBe(2140 * KIB);
    expect(DIRECT_SESSION_RAW_BUDGET - DIRECT_SESSION_RAW_MEASUREMENT).toBe(1_251);
    expect(DIRECT_SESSION_RAW_BUDGET - DIRECT_SESSION_RAW_MEASUREMENT).toBeGreaterThanOrEqual(
      MINIMUM_RAW_HEADROOM_BYTES,
    );
  });

  test("rounds the measured graph plus required headroom to a whole KiB", () => {
    expect(wholeKibEnvelope(2137 * KIB)).toBe(2138 * KIB);
    expect(wholeKibEnvelope(2137 * KIB + 1)).toBe(2139 * KIB);
    expect(wholeKibEnvelope(0, 1)).toBe(KIB);
  });

  test("rejects invalid measurements and headroom instead of weakening the guard", () => {
    expect(() => wholeKibEnvelope(-1)).toThrow("non-negative safe integer");
    expect(() => wholeKibEnvelope(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "non-negative safe integer",
    );
    expect(() => wholeKibEnvelope(1, 0)).toThrow("positive safe integer");
  });
});
