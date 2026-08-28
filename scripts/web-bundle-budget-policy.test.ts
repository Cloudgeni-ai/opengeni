import { describe, expect, test } from "bun:test";

import {
  DIRECT_SESSION_RAW_BUDGET,
  DIRECT_SESSION_RAW_MEASUREMENT,
  EFFECTIVE_DIRECT_SESSION_RAW_BUDGET,
  HOMESERVER_VARIABLE_NAME_UX_RAW_BUDGET,
  HOMESERVER_VARIABLE_NAME_UX_RAW_MEASUREMENT,
  KIB,
  MINIMUM_RAW_HEADROOM_BYTES,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
  WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET,
  WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT,
  wholeKibEnvelope,
} from "./web-bundle-budget-policy";

describe("web bundle budget policy", () => {
  test("retains at least one KiB above the exact embedded attachment-preview graph", () => {
    expect(DIRECT_SESSION_RAW_MEASUREMENT).toBe(2_200_819);
    expect(DIRECT_SESSION_RAW_BUDGET).toBe(2151 * KIB);
    expect(DIRECT_SESSION_RAW_BUDGET - DIRECT_SESSION_RAW_MEASUREMENT).toBe(1_805);
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

  test("retains the exact version-frozen release-source envelope", () => {
    expect(VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT).toBe(2_205_043);
    expect(VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET).toBe(2155 * KIB);
    expect(
      VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET -
        VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
    ).toBe(1_677);
  });

  test("retains the exact current-main permission-scoped discovery envelope", () => {
    expect(WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT).toBe(2_206_112);
    expect(WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET).toBe(2156 * KIB);
    expect(WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET - WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT).toBe(
      1_632,
    );
    expect(EFFECTIVE_DIRECT_SESSION_RAW_BUDGET).toBe(
      Math.max(
        DIRECT_SESSION_RAW_BUDGET,
        VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
        WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET,
        HOMESERVER_VARIABLE_NAME_UX_RAW_BUDGET,
      ),
    );
  });

  test("retains headroom for the homeserver Variable Set naming backport", () => {
    expect(HOMESERVER_VARIABLE_NAME_UX_RAW_MEASUREMENT).toBe(2_207_929);
    expect(HOMESERVER_VARIABLE_NAME_UX_RAW_BUDGET).toBe(2158 * KIB);
    expect(
      HOMESERVER_VARIABLE_NAME_UX_RAW_BUDGET - HOMESERVER_VARIABLE_NAME_UX_RAW_MEASUREMENT,
    ).toBe(1_863);
  });
});
