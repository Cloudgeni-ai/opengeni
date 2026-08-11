import { describe, expect, test } from "bun:test";
import { calculateVideoGenerationCreditCostMicros, getSettings } from "../src";

describe("video generation settings", () => {
  test("has bounded production-safe defaults", () => {
    const settings = getSettings({});
    expect(settings.videoGenerationPollIntervalMs).toBe(5_000);
    expect(settings.videoGenerationRecoveryDeadlineMs).toBe(2 * 60 * 60_000);
    expect(settings.videoGenerationReferenceUrlTtlSeconds).toBe(3_600);
    expect(settings.videoGenerationMaxConcurrentPerWorkspace).toBe(2);
    expect(settings.videoGenerationWorkspaceQuotaBytes).toBe(20 * 1024 * 1024 * 1024);
    expect(settings.videoGenerationTempDirectory).toBe("/tmp/opengeni-video");
    expect(settings.videoGenerationFfprobePath).toBe("ffprobe");
    expect(settings.videoGenerationCredit480pMicrosPerSecond).toBe(155_000);
    expect(settings.videoGenerationCredit720pMicrosPerSecond).toBe(350_000);
    expect(
      calculateVideoGenerationCreditCostMicros(settings, {
        modelId: "bytedance/seedance-2.5",
        resolution: "480p",
        durationSeconds: 4,
      }),
    ).toBe(620_000);
  });

  test("rejects unsafe operational bounds", () => {
    expect(() =>
      withEnv({ OPENGENI_VIDEO_GENERATION_REFERENCE_URL_TTL_SECONDS: "30" }, getSettings),
    ).toThrow();
    expect(() =>
      withEnv({ OPENGENI_VIDEO_GENERATION_MAX_CONCURRENT_PER_WORKSPACE: "100" }, getSettings),
    ).toThrow();
  });
});

function withEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  const original = process.env;
  process.env = { ...original, ...env };
  try {
    return run();
  } finally {
    process.env = original;
  }
}
