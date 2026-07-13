import { describe, expect, test } from "bun:test";
import {
  contextInputBudgetTokens,
  contextServerCompactThreshold,
  getSettings,
  resolveContextCompactionMode,
  settingsWithResolvedModelContext,
} from "../src";

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const saved: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

describe("context compaction config defaults", () => {
  test("default settings carry the provider-aware compaction knobs", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.contextCompactionMode).toBe("auto");
    expect(settings.contextWindowTokens).toBe(1_050_000);
    expect(settings.contextEffectiveWindowTokens).toBeUndefined();
    expect(settings.contextCompactionThresholdRatio).toBeCloseTo(0.9);
    expect(settings.contextReservedOutputTokens).toBe(128_000);
    expect(settings.contextClientCompactThresholdTokens).toBeUndefined();
    expect(settings.contextServerCompactThresholdTokens).toBeUndefined();
    expect(settings.contextCompactSoftFraction).toBeCloseTo(0.7);
    expect(settings.contextCompactHardFraction).toBeCloseTo(0.85);
    expect(settings.contextKeepRecentTokens).toBe(32_000);
    expect(settings.contextSummaryMaxTokens).toBe(20_000);
  });

  test("env overrides are coerced", () => {
    const settings = withEnv(
      {
        OPENGENI_CONTEXT_COMPACTION_MODE: "client",
        OPENGENI_CONTEXT_WINDOW_TOKENS: "400000",
        OPENGENI_CONTEXT_EFFECTIVE_WINDOW_TOKENS: "380000",
        OPENGENI_COMPACTION_THRESHOLD_RATIO: "0.75",
        OPENGENI_CONTEXT_RESERVED_OUTPUT_TOKENS: "64000",
        OPENGENI_CONTEXT_CLIENT_COMPACT_THRESHOLD_TOKENS: "350000",
        OPENGENI_CONTEXT_COMPACT_SOFT_FRACTION: "0.6",
        OPENGENI_CONTEXT_KEEP_RECENT_TOKENS: "16000",
      },
      () => getSettings(),
    );
    expect(settings.contextCompactionMode).toBe("client");
    expect(settings.contextWindowTokens).toBe(400_000);
    expect(settings.contextEffectiveWindowTokens).toBe(380_000);
    expect(settings.contextCompactionThresholdRatio).toBeCloseTo(0.75);
    expect(settings.contextReservedOutputTokens).toBe(64_000);
    expect(settings.contextClientCompactThresholdTokens).toBe(350_000);
    expect(settings.contextCompactSoftFraction).toBeCloseTo(0.6);
    expect(settings.contextKeepRecentTokens).toBe(16_000);
  });

  test("threshold ratio is clamped to the supported range", () => {
    expect(
      withEnv({ OPENGENI_COMPACTION_THRESHOLD_RATIO: "0.1" }, () => getSettings())
        .contextCompactionThresholdRatio,
    ).toBe(0.3);
    expect(
      withEnv({ OPENGENI_COMPACTION_THRESHOLD_RATIO: "2" }, () => getSettings())
        .contextCompactionThresholdRatio,
    ).toBe(0.9);
  });
});

describe("resolveContextCompactionMode", () => {
  test("auto -> server on the OpenAI platform provider", () => {
    expect(
      resolveContextCompactionMode({ contextCompactionMode: "auto", openaiProvider: "openai" }),
    ).toBe("server");
  });

  test("auto -> client on Azure (server-side compaction unsupported there)", () => {
    expect(
      resolveContextCompactionMode({ contextCompactionMode: "auto", openaiProvider: "azure" }),
    ).toBe("client");
  });

  test("explicit modes override the provider", () => {
    expect(
      resolveContextCompactionMode({ contextCompactionMode: "server", openaiProvider: "azure" }),
    ).toBe("server");
    expect(
      resolveContextCompactionMode({ contextCompactionMode: "client", openaiProvider: "openai" }),
    ).toBe("client");
    expect(
      resolveContextCompactionMode({ contextCompactionMode: "off", openaiProvider: "openai" }),
    ).toBe("off");
  });
});

describe("budget + server threshold", () => {
  test("input budget = window - reserved output", () => {
    expect(
      contextInputBudgetTokens({
        contextWindowTokens: 1_050_000,
        contextReservedOutputTokens: 128_000,
      }),
    ).toBe(922_000);
  });

  test("an explicit effective model window overrides the generic output reserve", () => {
    expect(
      contextInputBudgetTokens({
        contextWindowTokens: 272_000,
        contextEffectiveWindowTokens: 258_400,
        contextReservedOutputTokens: 128_000,
      }),
    ).toBe(258_400);
  });

  test("server threshold defaults to floor(window * threshold ratio)", () => {
    expect(
      contextServerCompactThreshold({
        contextWindowTokens: 1_050_000,
        contextReservedOutputTokens: 128_000,
        contextServerCompactThresholdTokens: undefined,
        contextCompactSoftFraction: 0.7,
        contextCompactionThresholdRatio: 0.6,
      }),
    ).toBe(Math.floor(1_050_000 * 0.6));
  });

  test("server threshold honors an explicit override", () => {
    expect(
      contextServerCompactThreshold({
        contextWindowTokens: 1_050_000,
        contextReservedOutputTokens: 128_000,
        contextServerCompactThresholdTokens: 500_000,
        contextCompactSoftFraction: 0.7,
        contextCompactionThresholdRatio: 0.6,
      }),
    ).toBe(500_000);
  });

  test("server threshold honors an explicit value independently of the input guard", () => {
    expect(
      contextServerCompactThreshold({
        contextWindowTokens: 250_000,
        contextReservedOutputTokens: 128_000,
        contextServerCompactThresholdTokens: 200_000,
        contextCompactSoftFraction: 0.7,
        contextCompactionThresholdRatio: 0.9,
      }),
    ).toBe(200_000);
  });

  test("resolved model context settings keep raw, effective, and trigger limits distinct", () => {
    const settings = withEnv({}, () => getSettings());
    const resolved = settingsWithResolvedModelContext(
      settings,
      { compactionMode: "client" },
      {
        contextWindowTokens: 272_000,
        effectiveContextWindowTokens: 258_400,
        autoCompactTokenLimit: 244_800,
      },
    );
    expect(resolved.contextCompactionMode).toBe("client");
    expect(resolved.contextWindowTokens).toBe(272_000);
    expect(resolved.contextEffectiveWindowTokens).toBe(258_400);
    expect(resolved.contextClientCompactThresholdTokens).toBe(244_800);
    expect(contextInputBudgetTokens(resolved)).toBe(258_400);
  });
});
