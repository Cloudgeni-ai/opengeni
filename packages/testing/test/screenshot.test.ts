import { describe, expect, test } from "bun:test";
import { assertScreenshotIntegrity, type ScreenshotPixelStats } from "../src/screenshot";

const painted: ScreenshotPixelStats = {
  width: 390,
  height: 844,
  quantizedColorCount: 180,
  luminanceStdDev: 22,
  nearBlackPixelRatio: 0,
  nearBlackRowRatio: 0,
  worstNearBlackRowRatio: 0,
  transparentPixelRatio: 0,
};

describe("screenshot integrity", () => {
  test("accepts a varied, opaque painted frame", () => {
    expect(() => assertScreenshotIntegrity(painted, "workbench")).not.toThrow();
  });

  test("rejects blank and compositor-corrupted frames", () => {
    expect(() =>
      assertScreenshotIntegrity(
        {
          ...painted,
          quantizedColorCount: 1,
          luminanceStdDev: 0,
          nearBlackPixelRatio: 1,
          nearBlackRowRatio: 1,
          worstNearBlackRowRatio: 1,
        },
        "blank",
      ),
    ).toThrow("screenshot integrity failed");

    expect(() =>
      assertScreenshotIntegrity(
        {
          ...painted,
          nearBlackPixelRatio: 0.2,
          nearBlackRowRatio: 0.15,
          worstNearBlackRowRatio: 1,
        },
        "banded",
      ),
    ).toThrow("near-black rows");
  });
});
