import { describe, expect, test } from "bun:test";

import {
  EFFECTIVE_DIRECT_SESSION_RAW_BUDGET,
  KIB,
  UNIFIED_TOOL_GATEWAY_BROWSER_RAW_BUDGET,
  UNIFIED_TOOL_GATEWAY_BROWSER_RAW_MEASUREMENT,
} from "./web-bundle-budget-unified-tool-gateway";

describe("unified tool gateway web bundle budget", () => {
  test("retains the lazy unified-tool-gateway browser envelope", () => {
    expect(UNIFIED_TOOL_GATEWAY_BROWSER_RAW_MEASUREMENT).toBe(2_290_677);
    expect(UNIFIED_TOOL_GATEWAY_BROWSER_RAW_BUDGET).toBe(2238 * KIB);
    expect(
      UNIFIED_TOOL_GATEWAY_BROWSER_RAW_BUDGET - UNIFIED_TOOL_GATEWAY_BROWSER_RAW_MEASUREMENT,
    ).toBe(1_035);
    expect(EFFECTIVE_DIRECT_SESSION_RAW_BUDGET).toBe(UNIFIED_TOOL_GATEWAY_BROWSER_RAW_BUDGET);
  });
});
