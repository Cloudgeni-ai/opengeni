import { describe, expect, test } from "bun:test";

import {
  DIRECT_SESSION_RAW_BUDGET,
  DIRECT_SESSION_RAW_MEASUREMENT,
  EFFECTIVE_DIRECT_SESSION_RAW_BUDGET,
  HTTP1_BROWSER_STREAMS_RAW_BUDGET,
  HTTP1_BROWSER_STREAMS_RAW_MEASUREMENT,
  KIB,
  MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET,
  MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_MEASUREMENT,
  MINIMUM_RAW_HEADROOM_BYTES,
  TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET,
  TIMELINE_HARDENING_CURRENT_MAIN_RAW_MEASUREMENT,
  TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET,
  TIMELINE_HARDENING_MERGE_TREE_RAW_MEASUREMENT,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
  WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET,
  WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT,
  WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET,
  WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_MEASUREMENT,
  WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET,
  WORKSPACE_MEMBER_ADMINISTRATION_RAW_MEASUREMENT,
  wholeKibEnvelope,
} from "./web-bundle-budget-policy";

describe("web bundle budget policy", () => {
  test("retains at least one KiB above the combined personal GitHub and current-main graph", () => {
    expect(DIRECT_SESSION_RAW_MEASUREMENT).toBe(2_219_469);
    expect(DIRECT_SESSION_RAW_BUDGET).toBe(2169 * KIB);
    expect(DIRECT_SESSION_RAW_BUDGET - DIRECT_SESSION_RAW_MEASUREMENT).toBe(1_587);
    expect(DIRECT_SESSION_RAW_BUDGET - DIRECT_SESSION_RAW_MEASUREMENT).toBeGreaterThanOrEqual(
      MINIMUM_RAW_HEADROOM_BYTES,
    );
  });

  test("retains the reviewed timeline-hardening merge-tree envelope", () => {
    expect(TIMELINE_HARDENING_MERGE_TREE_RAW_MEASUREMENT).toBe(2_201_700);
    expect(TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET).toBe(2152 * KIB);
    expect(
      TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET - TIMELINE_HARDENING_MERGE_TREE_RAW_MEASUREMENT,
    ).toBe(1_948);
  });

  test("retains the exact timeline-hardening current-main envelope", () => {
    expect(TIMELINE_HARDENING_CURRENT_MAIN_RAW_MEASUREMENT).toBe(2_222_765);
    expect(TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET).toBe(2172 * KIB);
    expect(
      TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET - TIMELINE_HARDENING_CURRENT_MAIN_RAW_MEASUREMENT,
    ).toBe(1_363);
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
  });

  test("retains the exact workspace-member administration envelope", () => {
    expect(WORKSPACE_MEMBER_ADMINISTRATION_RAW_MEASUREMENT).toBe(2_210_226);
    expect(WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET).toBe(2160 * KIB);
    expect(
      WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET - WORKSPACE_MEMBER_ADMINISTRATION_RAW_MEASUREMENT,
    ).toBe(1_614);
    expect(EFFECTIVE_DIRECT_SESSION_RAW_BUDGET).toBe(
      Math.max(
        DIRECT_SESSION_RAW_BUDGET,
        TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET,
        TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET,
        VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
        WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET,
        WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET,
        WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET,
        MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET,
        HTTP1_BROWSER_STREAMS_RAW_BUDGET,
      ),
    );
  });

  test("retains the exact workspace-member administration current-main envelope", () => {
    expect(WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_MEASUREMENT).toBe(2_224_726);
    expect(WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET).toBe(2174 * KIB);
    expect(
      WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET -
        WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_MEASUREMENT,
    ).toBe(1_450);
  });

  test("retains the exact managed social sign-in merge-tree envelope", () => {
    expect(MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_MEASUREMENT).toBe(2_226_468);
    expect(MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET).toBe(2176 * KIB);
    expect(
      MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET -
        MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_MEASUREMENT,
    ).toBe(1_756);
  });

  test("retains the exact bounded HTTP/1 browser-stream envelope", () => {
    expect(HTTP1_BROWSER_STREAMS_RAW_MEASUREMENT).toBe(2_236_754);
    expect(HTTP1_BROWSER_STREAMS_RAW_BUDGET).toBe(2186 * KIB);
    expect(HTTP1_BROWSER_STREAMS_RAW_BUDGET - HTTP1_BROWSER_STREAMS_RAW_MEASUREMENT).toBe(1_710);
  });
});
