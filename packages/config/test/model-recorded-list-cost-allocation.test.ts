import { describe, expect, test } from "bun:test";
import {
  allocateRecordedModelListCostByClass,
  calculateModelListUsageCostBreakdown,
  calculateModelListUsageCostSnapshot,
  configuredModels,
  getSettings,
  withClaudeConnectionCatalog,
  type ModelRecordedListCostAllocation,
  type ModelUsageInput,
} from "../src";

const base = getSettings({
  OPENGENI_ENV: "test",
  OPENGENI_OPENAI_MODEL: "gpt-6.1-sol",
  OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-6.1-sol",
  OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
    {
      id: "xai-list-test",
      api: "responses",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "xai_mock_only",
      models: [{ id: "grok-4.6" }],
    },
  ]),
});
const usage: ModelUsageInput = {
  inputTokens: 300,
  outputTokens: 100,
  inputTokensDetails: { cached_tokens: 100, cache_write_tokens: 100 },
};
function expectAllocationSum(allocation: ModelRecordedListCostAllocation, recorded: number) {
  expect(allocation.listByClassMicros).not.toBeNull();
  expect(Object.values(allocation.listByClassMicros!).reduce((sum, cost) => sum + cost, 0)).toBe(
    recorded,
  );
  expect(
    Object.values(allocation.listByClassMicros!).every(
      (cost) => Number.isSafeInteger(cost) && cost >= 0,
    ),
  ).toBe(true);
  expect(allocation.listByClassApprox).toBe(true);
}
function equalRateSettings(rate = 1_000_000) {
  return {
    ...base,
    modelPricingJson: JSON.stringify({
      "allocation/model": {
        inputMicrosPerMillionTokens: rate,
        cachedInputMicrosPerMillionTokens: rate,
        cacheWriteMicrosPerMillionTokens: rate,
        outputMicrosPerMillionTokens: rate,
        marginBps: 7500,
      },
    }),
  };
}
const equalUsage: ModelUsageInput = {
  inputTokens: 3,
  outputTokens: 1,
  inputTokensDetails: { cached_tokens: 1, cache_write_tokens: 1 },
};

describe("historical list-cost allocation, never repricing", () => {
  test("allocates the recorded total using unrounded rates, not today's calculated total", () => {
    const fact = { estimatedProviderCostMicros: 1001, usage: structuredClone(usage) };
    const before = structuredClone(fact);
    const definitions = configuredModels(base).map((model) => model.definitionVersion);
    const current = calculateModelListUsageCostBreakdown(base, "gpt-6.1-sol", fact.usage);
    expect(current.providerCostMicros).toBe(1460);
    const result = allocateRecordedModelListCostByClass(
      base,
      "gpt-6.1-sol",
      fact.usage,
      fact.estimatedProviderCostMicros,
    );
    expect(result.listByClassMicros).toEqual({
      uncachedInput: 137,
      cacheRead: 7,
      cacheWrite: 171,
      output: 686,
    });
    expectAllocationSum(result, 1001);
    expect(fact).toEqual(before);
    expect(configuredModels(base).map((model) => model.definitionVersion)).toEqual(definitions);
  });

  test.each([null, undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "leaves absent or invalid recorded cost %s unknown",
    (recorded) => {
      expect(allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", usage, recorded)).toEqual({
        listByClassMicros: null,
        listByClassApprox: false,
      });
    },
  );

  test.each([
    { ...usage, inputTokens: undefined },
    { ...usage, outputTokens: undefined },
    { ...usage, inputTokens: -1 },
    { ...usage, outputTokens: 1.5 },
    { ...usage, inputTokensDetails: undefined },
    { ...usage, inputTokensDetails: { cached_tokens: 100 } },
    { ...usage, inputTokensDetails: { cache_write_tokens: 100 } },
    { ...usage, inputTokensDetails: { cached_tokens: -1, cache_write_tokens: 100 } },
    { ...usage, inputTokensDetails: { cached_tokens: 1.5, cache_write_tokens: 100 } },
    { ...usage, inputTokensDetails: { cached_tokens: 250, cache_write_tokens: 100 } },
    { ...usage, inputTokensDetails: [{ cached_tokens: 100, cache_write_tokens: 100 }, {}] },
  ])("never replaces incomplete or invalid class telemetry with known zero", (entry) => {
    const result = allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", entry, 0);
    expect(result).toEqual({ listByClassMicros: null, listByClassApprox: false });
  });

  test("accepts observed aliases/entry arrays without mutating the inputs", () => {
    const entries: ModelUsageInput = {
      inputTokens: 300,
      outputTokens: 100,
      inputTokensDetails: [
        { cachedInputTokens: 50, cacheWriteTokens: 50 },
        { cached_input_tokens: 50, cache_write_tokens: 50 },
      ],
    };
    expect(allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", entries, 1001)).toEqual(
      allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", usage, 1001),
    );
  });

  test.each([0, 1, 2, 3, 4, 5, 7, 101, Number.MAX_SAFE_INTEGER])(
    "conserves %s micros with deterministic largest-remainder ties",
    (recorded) => {
      const result = allocateRecordedModelListCostByClass(
        equalRateSettings(),
        "allocation/model",
        equalUsage,
        recorded,
      );
      expectAllocationSum(result, recorded);
      const quotient = Math.floor(recorded / 4);
      const remainder = recorded % 4;
      expect(Object.values(result.listByClassMicros!)).toEqual(
        [0, 1, 2, 3].map((index) => quotient + (index < remainder ? 1 : 0)),
      );
    },
  );

  test("uses BigInt for weights/products beyond Number's exact integer range", () => {
    const count = Number.MAX_SAFE_INTEGER;
    const input: ModelUsageInput = {
      inputTokens: count,
      outputTokens: count - 1,
      inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
    };
    const result = allocateRecordedModelListCostByClass(
      equalRateSettings(count),
      "allocation/model",
      input,
      count,
    );
    expect(result.listByClassMicros).toEqual({
      uncachedInput: 4_503_599_627_370_496,
      cacheRead: 0,
      cacheWrite: 0,
      output: 4_503_599_627_370_495,
    });
    expectAllocationSum(result, count);
  });

  test("does not round tiny weights before computing their ratio or add credit margin", () => {
    const settings = {
      ...base,
      modelPricingJson: JSON.stringify({
        "allocation/model": {
          inputMicrosPerMillionTokens: 1,
          outputMicrosPerMillionTokens: 3,
          marginBps: 7500,
        },
      }),
    };
    const result = allocateRecordedModelListCostByClass(
      settings,
      "allocation/model",
      {
        inputTokens: 1,
        outputTokens: 1,
        inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
      },
      100,
    );
    expect(result.listByClassMicros).toEqual({
      uncachedInput: 25,
      cacheRead: 0,
      cacheWrite: 0,
      output: 75,
    });
    expectAllocationSum(result, 100);
  });

  test("known zero is eligible, but zero weights cannot explain a positive recorded total", () => {
    const free = equalRateSettings(0);
    expectAllocationSum(
      allocateRecordedModelListCostByClass(free, "allocation/model", equalUsage, 0),
      0,
    );
    expect(
      allocateRecordedModelListCostByClass(free, "allocation/model", equalUsage, 1)
        .listByClassMicros,
    ).toBeNull();
    const noTokens: ModelUsageInput = {
      inputTokens: 0,
      outputTokens: 0,
      inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
    };
    expectAllocationSum(allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", noTokens, 0), 0);
    expect(
      allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", noTokens, 1).listByClassMicros,
    ).toBeNull();
  });

  test("unknown model or unavailable positive class rate stays unknown, even with recorded zero", () => {
    expect(
      allocateRecordedModelListCostByClass(base, "future/model", usage, 0).listByClassMicros,
    ).toBeNull();
    expect(
      allocateRecordedModelListCostByClass(base, "grok-4.6", usage, 1001).listByClassMicros,
    ).toBeNull();
    const noRead = {
      ...base,
      modelPricingJson: JSON.stringify({
        "gpt-6.1-sol": {
          inputMicrosPerMillionTokens: 2_000_000,
          outputMicrosPerMillionTokens: 10_000_000,
        },
      }),
    };
    expect(
      allocateRecordedModelListCostByClass(noRead, "gpt-6.1-sol", usage, 0).listByClassMicros,
    ).toBeNull();
    expectAllocationSum(
      allocateRecordedModelListCostByClass(
        noRead,
        "gpt-6.1-sol",
        {
          inputTokens: 100,
          outputTokens: 100,
          inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
        },
        1,
      ),
      1,
    );
  });

  test("context threshold and observed request entries select rates, never a new recorded total", () => {
    const input: ModelUsageInput = {
      inputTokens: 500_000,
      outputTokens: 200_000,
      requestUsageEntries: [
        {
          inputTokens: 200_000,
          outputTokens: 100_000,
          inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
        },
        {
          inputTokens: 300_000,
          outputTokens: 100_000,
          inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      ],
    };
    const result = allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", input, 410);
    expect(result.listByClassMicros).toEqual({
      uncachedInput: 160,
      cacheRead: 0,
      cacheWrite: 0,
      output: 250,
    });
    expectAllocationSum(result, 410);
    for (const [tokens, expected] of [
      [272_000, 352],
      [272_001, 420],
    ]) {
      const tier = allocateRecordedModelListCostByClass(
        base,
        "gpt-6.1-sol",
        {
          inputTokens: tokens,
          outputTokens: 100_000,
          inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
        },
        1000,
      );
      expect(tier.listByClassMicros?.uncachedInput).toBe(expected);
      expectAllocationSum(tier, 1000);
    }
  });

  test("TTL-unknown Claude history can be allocated approximately, never captured as exact forward pricing", () => {
    const settings = withClaudeConnectionCatalog(base, {
      anthropic: { models: [{ upstreamModelId: "claude-opus-5-5" }] },
    });
    const model = "organization-anthropic/claude-opus-5-5";
    const allocated = allocateRecordedModelListCostByClass(settings, model, usage, 292);
    expect(allocated.listByClassMicros).toEqual({
      uncachedInput: 40,
      cacheRead: 2,
      cacheWrite: 50,
      output: 200,
    });
    expectAllocationSum(allocated, 292);
    expect(
      calculateModelListUsageCostSnapshot(settings, model, usage, { priceContextKnown: true })
        .listByClassMicros,
    ).toBeNull();
  });

  test("reasoning tokens are a subset of observed output, not a fifth charged class", () => {
    const withReasoning = {
      ...usage,
      reasoningTokens: 40,
      outputTokensDetails: { reasoning_tokens: 40 },
    };
    const result = allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", withReasoning, 1001);
    expect(result).toEqual(allocateRecordedModelListCostByClass(base, "gpt-6.1-sol", usage, 1001));
    expectAllocationSum(result, 1001);
  });

  test("never gives zero-weight classes a residual micro", () => {
    const result = allocateRecordedModelListCostByClass(
      base,
      "gpt-6.1-sol",
      {
        inputTokens: 0,
        outputTokens: 1,
        inputTokensDetails: { cached_tokens: 0, cache_write_tokens: 0 },
      },
      1,
    );
    expect(result.listByClassMicros).toEqual({
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1,
    });
    expectAllocationSum(result, 1);
  });

  test("eligible class coverage never substitutes for all historical priced usage", () => {
    const facts = [
      { model: "gpt-6.1-sol", usage, recorded: 1001 },
      { model: "gpt-6.1-sol", usage: { inputTokens: 300 }, recorded: 500 },
      { model: "future/model", usage, recorded: 700 },
      { model: "gpt-6.1-sol", usage, recorded: null },
      { model: "gpt-6.1-sol", usage, recorded: 0 },
    ];
    const before = structuredClone(facts);
    const eligible = facts
      .map((fact) =>
        allocateRecordedModelListCostByClass(base, fact.model, fact.usage, fact.recorded),
      )
      .filter((allocation) => allocation.listByClassMicros !== null);
    const coveredMicros = eligible.reduce(
      (total, allocation) =>
        total + Object.values(allocation.listByClassMicros!).reduce((sum, cost) => sum + cost, 0),
      0,
    );
    expect(eligible).toHaveLength(2);
    expect(coveredMicros).toBe(1001);
    expect(facts.reduce((total, fact) => total + (fact.recorded ?? 0), 0)).toBe(2201);
    expect(facts).toEqual(before);
  });
});
