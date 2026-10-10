import { describe, expect, test } from "bun:test";
import {
  configuredModelListPricingSchedules,
  configuredModels,
  costAwareCompactionThresholdTokens,
  getSettings,
  settingsWithResolvedModelContext,
  withClaudeConnectionCatalog,
  workspaceModelCompactionPolicy,
} from "../src";

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const saved: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function claudeCatalog(policy: "off" | "cost") {
  const settings = withEnv({ OPENGENI_EXPERIMENT_COMPACT_THRESHOLD_POLICY: policy }, () =>
    getSettings(),
  );
  return withClaudeConnectionCatalog(settings, {
    anthropic: {
      models: [
        { upstreamModelId: "claude-opus-5-5" },
        { upstreamModelId: "claude-sonnet-5-5" },
        { upstreamModelId: "claude-haiku-5-5" },
      ],
    },
  });
}

function claudeModel(settings: ReturnType<typeof getSettings>, upstream: string) {
  return configuredModels(settings).find((row) => row.id.endsWith(`/${upstream}`))!;
}

describe("experiment flags", () => {
  test("both experiments default off and parse from env", () => {
    const defaults = withEnv({}, () => getSettings());
    expect(defaults.experimentCompactThresholdPolicy).toBe("off");
    expect(defaults.experimentCacheTtlPolicy).toBe("off");
    expect(defaults.experimentCompactionCacheReuse).toBe(false);
    expect(
      withEnv({ OPENGENI_EXPERIMENT_COMPACTION_CACHE_REUSE: "1" }, () => getSettings())
        .experimentCompactionCacheReuse,
    ).toBe(true);
    const enabled = withEnv(
      {
        OPENGENI_EXPERIMENT_COMPACT_THRESHOLD_POLICY: "cost",
        OPENGENI_EXPERIMENT_CACHE_TTL_POLICY: "warm_1h",
      },
      () => getSettings(),
    );
    expect(enabled.experimentCompactThresholdPolicy).toBe("cost");
    expect(enabled.experimentCacheTtlPolicy).toBe("warm_1h");
    expect(
      withEnv({ OPENGENI_EXPERIMENT_CACHE_TTL_POLICY: "always_1h" }, () => getSettings())
        .experimentCacheTtlPolicy,
    ).toBe("always_1h");
    expect(() =>
      withEnv({ OPENGENI_EXPERIMENT_CACHE_TTL_POLICY: "24h" }, () => getSettings()),
    ).toThrow();
  });
});

describe("cost-aware compaction threshold", () => {
  test("Claude 5.5 thresholds follow price ratios and the long-context tier", () => {
    const settings = claudeCatalog("off");
    const schedules = configuredModelListPricingSchedules(settings);
    const opus = claudeModel(settings, "claude-opus-5-5");
    const sonnet = claudeModel(settings, "claude-sonnet-5-5");
    const haiku = claudeModel(settings, "claude-haiku-5-5");
    expect(costAwareCompactionThresholdTokens(schedules[opus.id]!)).toBe(190_000);
    expect(costAwareCompactionThresholdTokens(schedules[sonnet.id]!)).toBe(190_000);
    // Haiku's input price rises past 100k, so the policy stays under that tier.
    expect(costAwareCompactionThresholdTokens(schedules[haiku.id]!)).toBe(90_000);
  });

  test("uncached pricing hits the floor and free input gives no recommendation", () => {
    expect(
      costAwareCompactionThresholdTokens({
        default: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1 },
      } as never),
    ).toBe(100_000);
    expect(
      costAwareCompactionThresholdTokens({
        default: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 1 },
      } as never),
    ).toBeUndefined();
  });

  test("policy off keeps the catalog defaults", () => {
    const settings = claudeCatalog("off");
    expect(
      settingsWithResolvedModelContext(settings, claudeModel(settings, "claude-opus-5-5"))
        .contextAutoCompactThresholdTokens,
    ).toBe(300_000);
    expect(
      settingsWithResolvedModelContext(settings, claudeModel(settings, "claude-sonnet-5-5"))
        .contextAutoCompactThresholdTokens,
    ).toBe(800_000);
  });

  test("policy cost lowers defaults but never raises them", () => {
    const settings = claudeCatalog("cost");
    const opus = claudeModel(settings, "claude-opus-5-5");
    expect(settingsWithResolvedModelContext(settings, opus).contextAutoCompactThresholdTokens).toBe(
      190_000,
    );
    expect(workspaceModelCompactionPolicy(settings, opus, {}).defaultTokens).toBe(190_000);
    const haiku = claudeModel(settings, "claude-haiku-5-5");
    expect(
      settingsWithResolvedModelContext(settings, haiku).contextAutoCompactThresholdTokens,
    ).toBe(90_000);
    // A deployment trigger already below the recommendation stays as configured.
    expect(
      settingsWithResolvedModelContext(
        { ...settings, contextAutoCompactThresholdTokens: 60_000 },
        { ...opus, autoCompactTokenLimit: undefined },
      ).contextAutoCompactThresholdTokens,
    ).toBe(60_000);
  });

  test("workspace and organization overrides still win", () => {
    const settings = claudeCatalog("cost");
    const opus = claudeModel(settings, "claude-opus-5-5");
    const workspace = { modelCompactionThresholds: { [opus.id]: 400_000 } };
    expect(workspaceModelCompactionPolicy(settings, opus, workspace).effectiveTokens).toBe(400_000);
    expect(
      settingsWithResolvedModelContext(settings, opus, workspace).contextAutoCompactThresholdTokens,
    ).toBe(400_000);
    const organization = { modelCompactionThresholds: { [opus.id]: 250_000 } };
    expect(
      settingsWithResolvedModelContext(settings, opus, {}, organization)
        .contextAutoCompactThresholdTokens,
    ).toBe(250_000);
  });

  test("billed Codex Sol drops from 244.8k to its cost threshold", () => {
    const env = {
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.6-sol",
    };
    const off = withEnv(env, () => getSettings());
    const on = withEnv({ ...env, OPENGENI_EXPERIMENT_COMPACT_THRESHOLD_POLICY: "cost" }, () =>
      getSettings(),
    );
    const sol = configuredModels(on).find((candidate) => candidate.id === "gpt-5.6-sol")!;
    expect(settingsWithResolvedModelContext(off, sol).contextAutoCompactThresholdTokens).toBe(
      244_800,
    );
    const lowered = settingsWithResolvedModelContext(on, sol).contextAutoCompactThresholdTokens!;
    expect(lowered).toBe(
      costAwareCompactionThresholdTokens(configuredModelListPricingSchedules(on)[sol.id]!)!,
    );
    expect(lowered).toBe(146_000);
  });
});
