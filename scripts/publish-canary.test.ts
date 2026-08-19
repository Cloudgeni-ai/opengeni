import { describe, expect, test } from "bun:test";
import { nextCanaryVersion } from "./publish-canary";

describe("nextCanaryVersion", () => {
  test("starts at canary.0 from a stable version", () => {
    expect(nextCanaryVersion("2.0.0", null)).toBe("2.0.0-canary.0");
  });

  test("increments N for the same base", () => {
    expect(nextCanaryVersion("2.0.0", "2.0.0-canary.3")).toBe("2.0.0-canary.4");
  });

  test("restarts at 0 when the committed base moved", () => {
    expect(nextCanaryVersion("2.1.0", "2.0.0-canary.9")).toBe("2.1.0-canary.0");
  });
});
