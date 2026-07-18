import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DENSITIES,
  SYNTHETIC_SCENARIOS,
  parseDensitySweep,
  profileConfigFromEnv,
  quantile,
  scenarioForTurn,
  summarizeNumbers,
  withTimeout,
} from "./turn-density-profile";

describe("turn density profile release-gate helpers", () => {
  test("defaults to the exact OPE-52 density candidates", () => {
    expect(parseDensitySweep()).toEqual([1, 2, 4, 8, 12, 16, 24, 32]);
    expect(DEFAULT_DENSITIES).toEqual([1, 2, 4, 8, 12, 16, 24, 32]);
  });

  test("allows a unique configured subset but rejects unsupported or duplicate densities", () => {
    expect(parseDensitySweep("32, 8, 1")).toEqual([32, 8, 1]);
    expect(() => parseDensitySweep("1,1")).toThrow("at most once");
    expect(() => parseDensitySweep("3")).toThrow("only 1/2/4/8/12/16/24/32");
  });

  test("keeps the synthetic mix and bounded history settings deterministic", () => {
    const config = profileConfigFromEnv({
      OPENGENI_DENSITY_SWEEP: "1,2",
      OPENGENI_DENSITY_WAVES: "2",
      OPENGENI_DENSITY_ACTIVE_HISTORY_BYTES: "300000",
      OPENGENI_DENSITY_COMPACTION_TAIL_BYTES: "120000",
      OPENGENI_DENSITY_INACTIVE_HISTORY_BYTES: "400000",
      OPENGENI_DENSITY_SYNTHETIC_WORK_BYTES: "4096",
      OPENGENI_DENSITY_ARTIFACT_PATH: "artifacts/density.json",
    });

    expect(config.densities).toEqual([1, 2]);
    expect(config.waves).toBe(2);
    expect(config.activeHistoryBytes).toBe(300_000);
    expect(config.compactionTailBytes).toBe(120_000);
    expect(config.artifactPath).toBe("artifacts/density.json");
    expect(SYNTHETIC_SCENARIOS.map((_, index) => scenarioForTurn(index))).toEqual(
      SYNTHETIC_SCENARIOS,
    );
  });

  test("rejects unbounded profile controls and inconsistent thresholds", () => {
    expect(() => profileConfigFromEnv({ OPENGENI_DENSITY_WAVES: "11" })).toThrow(
      "OPENGENI_DENSITY_WAVES must be at most 10",
    );
    expect(() =>
      profileConfigFromEnv({ OPENGENI_DENSITY_PLATEAU_SAMPLE_INTERVAL_MS: "1" }),
    ).toThrow("must be between 100 and 60000");
    expect(() => profileConfigFromEnv({ OPENGENI_DENSITY_SYNTHETIC_FAN_OUT: "1025" })).toThrow(
      "must be at most 1024",
    );
    expect(() =>
      profileConfigFromEnv({
        OPENGENI_DENSITY_TARGET_MIB_PER_TURN: "101",
        OPENGENI_DENSITY_HARD_LIMIT_MIB_PER_TURN: "100",
      }),
    ).toThrow("must not exceed");
  });

  test("reports interpolation-based p50/p95/p99 and worst values", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 10);
    expect(summarizeNumbers([1, 2, 3, 4])).toEqual({
      count: 4,
      p50: 2.5,
      p95: 3.9,
      p99: 4,
      worst: 4,
    });
  });

  test("clears a long deadline after work settles and still rejects real timeouts", async () => {
    expect(await withTimeout(Promise.resolve("settled"), 60_000, "should be cleared")).toBe(
      "settled",
    );
    await expect(
      withTimeout(new Promise(() => undefined), 5, "density deadline elapsed"),
    ).rejects.toThrow("density deadline elapsed");
  });
});
