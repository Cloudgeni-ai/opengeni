import { describe, expect, test } from "bun:test";
import {
  calculateModelListUsageCostBreakdown,
  calculateModelListUsageCostSnapshot,
  calculateModelUsageCostBreakdown,
  configuredModels,
  getSettings,
  parseModelProvidersJson,
  withClaudeConnectionCatalog,
  type ModelListUsageCostSnapshot,
  type ModelUsageInput,
} from "../src";

const base = getSettings({ OPENGENI_ENV: "test" });
const known = { priceContextKnown: true };
const usage: ModelUsageInput = {
  inputTokens: 200,
  outputTokens: 100,
  inputTokensDetails: { cached_tokens: 100, cache_write_tokens: 100 },
};
function expectClassSum(snapshot: ModelListUsageCostSnapshot) {
  expect(snapshot.listByClassMicros).not.toBeNull();
  expect(Object.values(snapshot.listByClassMicros!).reduce((sum, cost) => sum + cost, 0)).toBe(
    snapshot.providerCostMicros,
  );
  expect(
    Object.values(snapshot.listByClassMicros!).every(
      (cost) => Number.isSafeInteger(cost) && cost >= 0,
    ),
  ).toBe(true);
}
function claudeSettings() {
  return withClaudeConnectionCatalog(base, {
    anthropic: { models: [{ upstreamModelId: "claude-opus-5-5" }] },
  });
}
const claudeId = "organization-anthropic/claude-opus-5-5";
const nativeUsage = {
  inputTokens: 300,
  outputTokens: 100,
  inputTokensDetails: {
    cached_tokens: 100,
    cache_write_tokens: 100,
    cache_write_tokens_5m: 60,
    cache_write_tokens_1h: 40,
  },
};

describe("forward list-price class snapshots", () => {
  test("keeps debit/totals-only result shapes unchanged and requires request price provenance", () => {
    const totals = calculateModelListUsageCostBreakdown(base, "gpt-6.1-sol", usage);
    expect(totals).toEqual({ providerCostMicros: 1260, creditCostMicros: 1323 });
    expect(calculateModelUsageCostBreakdown(base, "gpt-6.1-sol", usage)).toEqual(totals);
    expect(calculateModelListUsageCostSnapshot(base, "gpt-6.1-sol", usage)).toEqual({
      ...totals,
      listByClassMicros: null,
      listByClassApprox: false,
    });
  });

  test("captures independently rounded observed classes without mutating usage or catalog definitions", () => {
    const before = structuredClone(usage);
    const modelsBefore = configuredModels(base).map((model) => model.definitionVersion);
    const snapshot = calculateModelListUsageCostSnapshot(base, "gpt-6.1-sol", usage, known);
    expect(snapshot).toEqual({
      providerCostMicros: 1260,
      creditCostMicros: 1323,
      listByClassMicros: { uncachedInput: 0, cacheRead: 10, cacheWrite: 250, output: 1000 },
      listByClassApprox: false,
    });
    expectClassSum(snapshot);
    expect(usage).toEqual(before);
    expect(configuredModels(base).map((model) => model.definitionVersion)).toEqual(modelsBefore);
  });

  test.each([
    { ...usage, inputTokens: undefined },
    { ...usage, outputTokens: undefined },
    { ...usage, inputTokensDetails: undefined },
    { ...usage, inputTokensDetails: { cached_tokens: 100 } },
    { ...usage, inputTokensDetails: { cache_write_tokens: 100 } },
    { ...usage, inputTokensDetails: { cached_tokens: -1, cache_write_tokens: 100 } },
    { ...usage, inputTokensDetails: { cached_tokens: 1.5, cache_write_tokens: 100 } },
    { ...usage, inputTokensDetails: { cached_tokens: 150, cache_write_tokens: 100 } },
    {
      ...usage,
      inputTokensDetails: [{ cached_tokens: 50, cache_write_tokens: 50 }, { cached_tokens: 50 }],
    },
  ])("leaves missing/invalid/overlapping counters unknown, never assumed zero", (entry) => {
    expect(
      calculateModelListUsageCostSnapshot(base, "gpt-6.1-sol", entry, known).listByClassMicros,
    ).toBeNull();
  });

  test("uses each request's input tier rather than aggregate turn tokens", () => {
    const snapshot = calculateModelListUsageCostSnapshot(
      base,
      "gpt-6.1-sol",
      {
        inputTokens: 500_000,
        outputTokens: 0,
        requestUsageEntries: [
          {
            inputTokens: 200_000,
            outputTokens: 0,
            inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
          },
          {
            inputTokens: 300_000,
            outputTokens: 0,
            inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
          },
        ],
      },
      known,
    );
    expect(snapshot).toEqual({
      providerCostMicros: 1_600_000,
      creditCostMicros: 1_680_000,
      listByClassMicros: { uncachedInput: 1_600_000, cacheRead: 0, cacheWrite: 0, output: 0 },
      listByClassApprox: false,
    });
    expectClassSum(snapshot);
  });

  test("uses authoritative native Claude 5m and 1h rates only with complete TTL counters", () => {
    const settings = claudeSettings();
    const snapshot = calculateModelListUsageCostSnapshot(settings, claudeId, nativeUsage, known);
    expect(snapshot).toEqual({
      providerCostMicros: 3040,
      creditCostMicros: 3192,
      listByClassMicros: { uncachedInput: 400, cacheRead: 20, cacheWrite: 620, output: 2000 },
      listByClassApprox: false,
    });
    expectClassSum(snapshot);
    expect(calculateModelListUsageCostBreakdown(settings, claudeId, nativeUsage)).toEqual({
      providerCostMicros: 2920,
      creditCostMicros: 3066,
    });
    expect(() => calculateModelUsageCostBreakdown(settings, claudeId, nativeUsage)).toThrow(
      "Missing model pricing",
    );
    const onlyOneHour = {
      ...nativeUsage,
      inputTokensDetails: {
        ...nativeUsage.inputTokensDetails,
        cache_write_tokens_5m: 0,
        cache_write_tokens_1h: 100,
      },
    };
    expect(
      calculateModelListUsageCostSnapshot(settings, claudeId, onlyOneHour, known).listByClassMicros
        ?.cacheWrite,
    ).toBe(800);
  });

  test.each([
    { cached_tokens: 100, cache_write_tokens: 100 },
    { cached_tokens: 100, cache_write_tokens: 100, cache_write_tokens_5m: 60 },
    {
      cached_tokens: 100,
      cache_write_tokens: 100,
      cache_write_tokens_5m: 60,
      cache_write_tokens_1h: 30,
    },
  ])(
    "does not assume native Claude's configured 5m TTL proves historical/request write prices",
    (details) => {
      const result = calculateModelListUsageCostSnapshot(
        claudeSettings(),
        claudeId,
        { ...nativeUsage, inputTokensDetails: details },
        known,
      );
      expect(result.listByClassMicros).toBeNull();
      expect(result.listByClassApprox).toBe(false);
    },
  );

  test("does not derive mixed-TTL override rates, but honors a single explicitly configured TTL price", () => {
    const original = claudeSettings();
    const settings = {
      ...original,
      modelPricingJson: JSON.stringify({
        [claudeId]: {
          inputMicrosPerMillionTokens: 4_000_000,
          cachedInputMicrosPerMillionTokens: 200_000,
          cacheWriteMicrosPerMillionTokens: 7_000_000,
          outputMicrosPerMillionTokens: 20_000_000,
        },
      }),
    };
    expect(
      calculateModelListUsageCostSnapshot(settings, claudeId, nativeUsage, known).listByClassMicros,
    ).toBeNull();
    const fiveMinuteOnly = {
      ...nativeUsage,
      inputTokensDetails: {
        ...nativeUsage.inputTokensDetails,
        cache_write_tokens_5m: 100,
        cache_write_tokens_1h: 0,
      },
    };
    const snapshot = calculateModelListUsageCostSnapshot(settings, claudeId, fiveMinuteOnly, known);
    expect(snapshot.listByClassMicros?.cacheWrite).toBe(700);
    expectClassSum(snapshot);
    const providers = parseModelProvidersJson(settings.modelProvidersJson);
    providers.find((provider) => provider.id === "organization-anthropic")!.anthropic!.cacheTtl =
      "1h";
    const oneHourSettings = { ...settings, modelProvidersJson: JSON.stringify(providers) };
    expect(
      calculateModelListUsageCostSnapshot(oneHourSettings, claudeId, fiveMinuteOnly, known)
        .listByClassMicros,
    ).toBeNull();
  });

  test("native zero writes need no invented TTL, but absent positive write/read prices stay unknown", () => {
    const zeroWrites = {
      inputTokens: 100,
      outputTokens: 10,
      inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
    };
    expectClassSum(
      calculateModelListUsageCostSnapshot(claudeSettings(), claudeId, zeroWrites, known),
    );
    expect(
      calculateModelListUsageCostSnapshot(base, "grok-4.6", usage, known).listByClassMicros,
    ).toBeNull();
    const noReadRate = {
      ...base,
      modelPricingJson: JSON.stringify({
        "gpt-6.1-sol": {
          inputMicrosPerMillionTokens: 2_000_000,
          outputMicrosPerMillionTokens: 10_000_000,
        },
      }),
    };
    expect(
      calculateModelListUsageCostSnapshot(noReadRate, "gpt-6.1-sol", usage, known)
        .listByClassMicros,
    ).toBeNull();
  });

  test("distinguishes known explicit zero costs from unknown class counters", () => {
    const settings = {
      ...base,
      modelPricingJson: JSON.stringify({
        "gpt-6.1-sol": {
          inputMicrosPerMillionTokens: 0,
          cachedInputMicrosPerMillionTokens: 0,
          cacheWriteMicrosPerMillionTokens: 0,
          outputMicrosPerMillionTokens: 0,
        },
      }),
    };
    const snapshot = calculateModelListUsageCostSnapshot(settings, "gpt-6.1-sol", usage, known);
    expect(snapshot.listByClassMicros).toEqual({
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    });
    expectClassSum(snapshot);
    expect(
      calculateModelListUsageCostSnapshot(settings, "gpt-6.1-sol", { inputTokens: 200 }, known)
        .listByClassMicros,
    ).toBeNull();
  });

  test.each([10_000, 12_500, 20_000])(
    "preserves latency totals and marks fractional class rounding for multiplier %s",
    (multiplier) => {
      const capabilities = structuredClone(configuredModels(base)[0]!.capabilities);
      capabilities.latencyModes = [
        { id: "standard", upstream: "supported", runnable: true },
        { id: "fast", upstream: "supported", runnable: true, billingMultiplierBps: multiplier },
      ];
      const settings = {
        ...base,
        modelProvidersJson: JSON.stringify([
          {
            id: "snapshot-test",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "snapshot-test/model",
                capabilities,
                pricing: {
                  inputMicrosPerMillionTokens: 1_000_000,
                  cachedInputMicrosPerMillionTokens: 1_000_000,
                  cacheWriteMicrosPerMillionTokens: 1_000_000,
                  outputMicrosPerMillionTokens: 1_000_000,
                  marginBps: 500,
                },
              },
            ],
          },
        ]),
      };
      const input = {
        inputTokens: 3,
        outputTokens: 1,
        inputTokensDetails: { cached_tokens: 1, cache_write_tokens: 1 },
      };
      const options = { ...known, latencyMode: "fast" as const };
      const snapshot = calculateModelListUsageCostSnapshot(
        settings,
        "snapshot-test/model",
        input,
        options,
      );
      const totals = calculateModelListUsageCostBreakdown(
        settings,
        "snapshot-test/model",
        input,
        options,
      );
      expect(snapshot.providerCostMicros).toBe(totals.providerCostMicros);
      expect(snapshot.creditCostMicros).toBe(totals.creditCostMicros);
      expect(snapshot.listByClassApprox).toBe(multiplier === 12_500);
      expectClassSum(snapshot);
      if (multiplier === 12_500)
        expect(snapshot.listByClassMicros).toEqual({
          uncachedInput: 2,
          cacheRead: 1,
          cacheWrite: 1,
          output: 1,
        });
    },
  );

  test("an unverified latency multiplier cannot produce an exact class split", () => {
    expect(
      calculateModelListUsageCostSnapshot(base, "gpt-6.1-sol", usage, {
        ...known,
        latencyMode: "fast",
      }).listByClassMicros,
    ).toBeNull();
  });
});
