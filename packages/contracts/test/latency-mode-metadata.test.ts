import { describe, expect, test } from "bun:test";
import { LatencyMode, latencyModeForMetadata } from "../src";

describe("latencyModeForMetadata", () => {
  test("keeps every latency mode, including Ultrafast", () => {
    for (const latencyMode of LatencyMode.options) {
      expect(latencyModeForMetadata({ latencyMode }, "standard")).toBe(latencyMode);
    }
  });

  test("falls back for anything else", () => {
    for (const latencyMode of [undefined, null, "", "turbo", "ULTRAFAST", 1]) {
      expect(latencyModeForMetadata({ latencyMode }, "fast")).toBe("fast");
    }
    expect(latencyModeForMetadata({})).toBe("standard");
  });
});
