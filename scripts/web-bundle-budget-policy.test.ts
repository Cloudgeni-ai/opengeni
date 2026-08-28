import { describe, expect, test } from "bun:test";

import {
  DIRECT_SESSION_RAW_BUDGET,
  DIRECT_SESSION_RAW_MEASUREMENT,
  EFFECTIVE_DIRECT_SESSION_RAW_BUDGET,
  KIB,
  MINIMUM_RAW_HEADROOM_BYTES,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
  wholeKibEnvelope,
} from "./web-bundle-budget-policy";

describe("web bundle budget policy", () => {
  test("retains at least one KiB above the combined GitHub, attachment, and Variable Set graph", () => {
    expect(DIRECT_SESSION_RAW_MEASUREMENT).toBe(2_218_160);
    expect(DIRECT_SESSION_RAW_BUDGET).toBe(2168 * KIB);
    expect(DIRECT_SESSION_RAW_BUDGET - DIRECT_SESSION_RAW_MEASUREMENT).toBe(1_872);
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

  test("retains the exact current-main Variable Set merge-tree envelope", () => {
    expect(VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT).toBe(2_203_278);
    expect(VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET).toBe(2153 * KIB);
    expect(
      VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET -
        VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
    ).toBe(1_394);
    expect(EFFECTIVE_DIRECT_SESSION_RAW_BUDGET).toBe(
      Math.max(DIRECT_SESSION_RAW_BUDGET, VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET),
    );
  });
});
