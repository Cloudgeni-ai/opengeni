import { describe, expect, test } from "bun:test";
import { contextInputBudgetTokens, getSettings, settingsWithResolvedModelContext } from "../src";

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
  test("default settings carry the portable local compaction limits", () => {
    const settings = withEnv({}, () => getSettings());
    expect(settings.contextWindowTokens).toBe(1_050_000);
    expect(settings.contextEffectiveWindowTokens).toBeUndefined();
    expect(settings.contextCompactionThresholdRatio).toBeCloseTo(0.9);
    expect(settings.contextReservedOutputTokens).toBe(128_000);
    expect(settings.contextAutoCompactThresholdTokens).toBeUndefined();
  });

  test("env overrides are coerced", () => {
    const settings = withEnv(
      {
        OPENGENI_CONTEXT_WINDOW_TOKENS: "400000",
        OPENGENI_CONTEXT_EFFECTIVE_WINDOW_TOKENS: "380000",
        OPENGENI_COMPACTION_THRESHOLD_RATIO: "0.75",
        OPENGENI_CONTEXT_RESERVED_OUTPUT_TOKENS: "64000",
        OPENGENI_CONTEXT_AUTO_COMPACT_THRESHOLD_TOKENS: "350000",
      },
      () => getSettings(),
    );
    expect(settings.contextWindowTokens).toBe(400_000);
    expect(settings.contextEffectiveWindowTokens).toBe(380_000);
    expect(settings.contextCompactionThresholdRatio).toBeCloseTo(0.75);
    expect(settings.contextReservedOutputTokens).toBe(64_000);
    expect(settings.contextAutoCompactThresholdTokens).toBe(350_000);
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

describe("context input budget", () => {
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

  test("resolved model context settings keep raw, effective, and trigger limits distinct", () => {
    const settings = withEnv({}, () => getSettings());
    const resolved = settingsWithResolvedModelContext(settings, {
      contextWindowTokens: 272_000,
      effectiveContextWindowTokens: 258_400,
      autoCompactTokenLimit: 244_800,
    });
    expect(resolved.contextWindowTokens).toBe(272_000);
    expect(resolved.contextEffectiveWindowTokens).toBe(258_400);
    expect(resolved.contextAutoCompactThresholdTokens).toBe(244_800);
    expect(contextInputBudgetTokens(resolved)).toBe(258_400);
  });
});
