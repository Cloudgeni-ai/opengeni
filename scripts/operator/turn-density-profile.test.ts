import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildProfileResult,
  cleanupDensityWorkspace,
  DEFAULT_DENSITIES,
  expectedCompactionCallsForDensity,
  FORCED_COMPACTION_RULE,
  SYNTHETIC_SCENARIOS,
  parseDensitySweep,
  profileConfigFromEnv,
  quantile,
  scenarioForTurn,
  shouldForceCompactionForTurn,
  summarizeNumbers,
  syntheticAllocatedWorkBytesByScenario,
  verifyDensityProfileArtifactText,
  withDeadline,
  withTimeout,
  type DensityMemorySample,
  type DensityMeasurement,
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
    expect(Array.from({ length: 13 }, (_, index) => shouldForceCompactionForTurn(index))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(DEFAULT_DENSITIES.map(expectedCompactionCallsForDensity)).toEqual([
      1, 1, 1, 2, 2, 3, 4, 6,
    ]);
    expect(FORCED_COMPACTION_RULE).toEqual({
      trigger: "operator",
      scenario: "streaming",
      selectionRule: "turnIndex % 6 === 0",
      expectedCallsPerWave: "ceil(density / 6)",
    });
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

  test("uses one absolute deadline across sequential phases", async () => {
    const deadlineAt = Date.now() + 25;
    await withDeadline(Bun.sleep(10), deadlineAt, "first phase timed out");
    await expect(withDeadline(Bun.sleep(30), deadlineAt, "wave deadline elapsed")).rejects.toThrow(
      "wave deadline elapsed",
    );
  });

  test("bounds cleanup independently after a post-gate activity never settles", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    await expect(
      withDeadline(neverSettles, Date.now() + 5, "post-gate activity timed out"),
    ).rejects.toThrow("post-gate activity timed out");
    let deleted = false;
    await cleanupDensityWorkspace(async () => {
      deleted = true;
    }, 100);
    expect(deleted).toBe(true);
    await expect(cleanupDensityWorkspace(() => new Promise(() => undefined), 5)).rejects.toThrow(
      "Timed out deleting density profile workspace",
    );
  });

  test("reports exact synthetic buffer allocation by scenario", () => {
    expect(syntheticAllocatedWorkBytesByScenario(4_097)).toEqual({
      streaming: 2_048,
      "tool-burst": 4_096,
      sandbox: 4_096,
      "fan-out": 2_048,
      wait: 2_048,
      drain: 2_048,
    });
  });

  test("verifies schema-v3 raw samples, statistics, thresholds, cleanup, and exact SHA", () => {
    const text = profileArtifactText();
    const sha256 = createHash("sha256").update(text).digest("hex");
    expect(verifyDensityProfileArtifactText(text, sha256)).toEqual({
      sha256,
      schemaVersion: 3,
      densities: [2],
      wavesPerDensity: 1,
      rawMemorySamples: 6,
      sessionsCreated: 2,
      compactionCalls: 1,
      verifiedCompactionHistoryShrinks: 1,
      targetMet: true,
      hardLimitMet: true,
    });
    expect(() => verifyDensityProfileArtifactText(text, "0".repeat(64))).toThrow(
      "SHA-256 mismatch",
    );
  });

  test("rejects altered derived statistics, raw samples, and cleanup claims", () => {
    const artifact = JSON.parse(profileArtifactText());
    artifact.densities[0].waves[0].incrementalRssMiBPerTurn.worst = 99;
    expect(() => verifyDensityProfileArtifactText(`${JSON.stringify(artifact)}\n`)).toThrow(
      "incrementalRssMiBPerTurn does not match",
    );
    const rawAltered = JSON.parse(profileArtifactText());
    rawAltered.densities[0].waves[0].rawSamples.memory.plateau[0].rss += 1;
    expect(() => verifyDensityProfileArtifactText(`${JSON.stringify(rawAltered)}\n`)).toThrow(
      "raw-sample recomputation",
    );
    const cleanupAltered = JSON.parse(profileArtifactText());
    cleanupAltered.cleanup.workspacesDeleted = 0;
    expect(() => verifyDensityProfileArtifactText(`${JSON.stringify(cleanupAltered)}\n`)).toThrow(
      "artifact.cleanup does not match",
    );
    const compactionCallsAltered = JSON.parse(profileArtifactText());
    compactionCallsAltered.densities[0].waves[0].compactionCalls = 0;
    expect(() =>
      verifyDensityProfileArtifactText(`${JSON.stringify(compactionCallsAltered)}\n`),
    ).toThrow("compactionCalls must equal 1");
    const compactionShrinksAltered = JSON.parse(profileArtifactText());
    compactionShrinksAltered.densities[0].waves[0].verifiedCompactionHistoryShrinks = 0;
    expect(() =>
      verifyDensityProfileArtifactText(`${JSON.stringify(compactionShrinksAltered)}\n`),
    ).toThrow("verifiedCompactionHistoryShrinks must equal 1");
    const compactionRuleAltered = JSON.parse(profileArtifactText());
    compactionRuleAltered.workload.syntheticMix.forcedCompaction.selectionRule = "all turns";
    expect(() =>
      verifyDensityProfileArtifactText(`${JSON.stringify(compactionRuleAltered)}\n`),
    ).toThrow("forcedCompaction does not match");
  });
});

function profileArtifactText(): string {
  const config = profileConfigFromEnv({
    OPENGENI_DENSITY_SWEEP: "2",
    OPENGENI_DENSITY_WAVES: "1",
    OPENGENI_DENSITY_PLATEAU_SAMPLE_INTERVAL_MS: "60000",
    OPENGENI_DENSITY_BASELINE_SAMPLES: "2",
    OPENGENI_DENSITY_SETTLED_SAMPLES: "2",
    OPENGENI_DENSITY_SYNTHETIC_WORK_BYTES: "4097",
  });
  const baseline = [memorySample(100, 40, 5), memorySample(100, 42, 5)];
  const plateau = [memorySample(108, 45, 7), memorySample(110, 47, 7)];
  const settled = [memorySample(102, 43, 5), memorySample(102, 43, 5)];
  const measurement: DensityMeasurement = {
    density: 2,
    waves: [
      {
        wave: 0,
        compactionCalls: 1,
        verifiedCompactionHistoryShrinks: 1,
        baseline: {
          sampleCount: 2,
          rssMiBMedian: 100,
          rssMiBP95: 100,
          rssMiBP99: 100,
          rssMiBMax: 100,
          heapUsedMiBMedian: 41,
          externalMiBMedian: 5,
        },
        plateau: {
          sampleCount: 2,
          rssMiBMedian: 109,
          rssMiBP95: 109.9,
          rssMiBP99: 110,
          rssMiBMax: 110,
          heapUsedMiBMedian: 46,
          externalMiBMedian: 7,
        },
        settled: {
          sampleCount: 2,
          rssMiBMedian: 102,
          rssMiBP95: 102,
          rssMiBP99: 102,
          rssMiBMax: 102,
          heapUsedMiBMedian: 43,
          externalMiBMedian: 5,
        },
        incrementalValues: [4, 5],
        retainedValues: [1],
        plateauToSettledValues: [6, 8],
        rawMemory: { baseline, plateau, settled },
      },
    ],
  };
  const artifact = buildProfileResult({
    config,
    runId: "density-profile-test",
    productionRevision: "test-revision",
    densityMeasurements: [measurement],
    cleanup: { workspacesCreated: 1, workspacesDeleted: 1, sessionsCreated: 2 },
  });
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function memorySample(
  rssMiB: number,
  heapUsedMiB: number,
  externalMiB: number,
): DensityMemorySample {
  const mib = 1024 * 1024;
  return {
    rss: rssMiB * mib,
    heapTotal: 64 * mib,
    heapUsed: heapUsedMiB * mib,
    external: externalMiB * mib,
    arrayBuffers: externalMiB * mib,
  };
}
