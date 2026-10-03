import { describe, expect, test } from "bun:test";
import {
  calculateModelListUsageCostBreakdown,
  calculateModelUsageCostBreakdown,
  configuredModelListPricingSchedules,
  configuredModelPricingSchedules,
  configuredModels,
  defaultModelPricing,
  getSettings,
  parseModelProvidersJson,
  selectModelPricing,
  withClaudeConnectionCatalog,
  withCodexCatalogProvider,
  withOrganizationGatewayCatalogProvider,
  withOrganizationOpenRouterCatalogProvider,
  withWorkspaceGatewayCatalogProvider,
  withWorkspaceOpenRouterCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type ModelPricingScheduleV1,
} from "../src";

// Manually reviewed primary-source rows, not a runtime/generated pricing feed.
// USD per million tokens: input, cache read, 5m cache write (where applicable),
// output. The public sources were checked on 2026-10-03.
// OpenAI: https://developers.openai.com/api/docs/pricing
// xAI: https://docs.x.ai/developers/models/grok-4.5 (also grok-4.6 / grok-4.7)
// Claude: https://platform.claude.com/docs/en/about-claude/pricing
// Thresholds/cache-write rows corroborated by https://ai-gateway.vercel.sh/v1/models
const reviewedRows = [
  ["gpt-6.1-sol", 2, 0.1, 2.5, 10],
  ["grok-4.5", 2, 0.3, null, 6],
  ["grok-4.6", 2, 0.5, null, 6],
  ["grok-4.7", 2, 0.5, null, 6],
  ["claude-opus-5-5", 4, 0.2, 5, 20],
  ["claude-sonnet-5-5", 2, 0.2, 2.5, 10],
  ["claude-opus-5", 5, 0.5, 6.25, 25],
  ["claude-sonnet-5", 2, 0.2, 2.5, 10],
  ["claude-opus-4-8", 5, 0.5, 6.25, 25],
  ["claude-opus-4-7", 5, 0.5, 6.25, 25],
  ["claude-opus-4-6", 5, 0.5, 6.25, 25],
  ["claude-sonnet-4-6", 3, 0.3, 3.75, 15],
  ["claude-haiku-4-5-20251001", 1, 0.1, 1.25, 5],
] as const;
const claudeModels = reviewedRows
  .map(([upstreamModelId]) => upstreamModelId)
  .filter((id) => id.startsWith("claude-"))
  .map((upstreamModelId) => ({ upstreamModelId }));

function catalogSettings() {
  let settings = getSettings({
    OPENGENI_ENV: "test",
    OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED: "true",
    OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-6.1-sol",
  });
  settings = withCodexCatalogProvider(settings);
  // Dynamic catalogs may contain newly reviewed models beyond the fallback.
  const providers = parseModelProvidersJson(settings.modelProvidersJson);
  const codex = providers.find((provider) => provider.kind === "codex-subscription")!;
  codex.models.push({
    ...codex.models[0]!,
    id: "codex/gpt-6.1-sol",
    upstreamModelId: "gpt-6.1-sol",
  });
  settings = { ...settings, modelProvidersJson: JSON.stringify(providers) };
  settings = withXaiSubscriptionCatalogProvider(settings);
  settings = withWorkspaceGatewayCatalogProvider(settings);
  settings = withOrganizationGatewayCatalogProvider(settings, [
    { upstreamModelId: "deepseek/deepseek-v4-flash-0731" },
    { upstreamModelId: "moonshotai/kimi-k3" },
  ]);
  settings = withWorkspaceOpenRouterCatalogProvider(settings);
  settings = withOrganizationOpenRouterCatalogProvider(settings, [
    { upstreamModelId: "nvidia/nemotron-3-super-120b-a12b:free" },
  ]);
  for (const scope of ["organization", "workspace"] as const) {
    settings = withClaudeConnectionCatalog(
      settings,
      { anthropic: { models: claudeModels }, claude_subscription: { models: claudeModels } },
      scope,
    );
  }
  return settings;
}

describe("reviewed supported-model list prices", () => {
  test.each(reviewedRows)(
    "pins the exact primary-source Standard row for %s",
    (id, input, cache, write, output) => {
      expect(defaultModelPricing[id]?.default).toEqual({
        inputMicrosPerMillionTokens: Math.round(input * 1_000_000),
        cachedInputMicrosPerMillionTokens: Math.round(cache * 1_000_000),
        ...(write === null
          ? {}
          : { cacheWriteMicrosPerMillionTokens: Math.round(write * 1_000_000) }),
        outputMicrosPerMillionTokens: Math.round(output * 1_000_000),
        marginBps: 500,
      });
    },
  );

  test("uses GPT-6.1 Sol's own cache rate and the exclusive 272K boundary", () => {
    const schedule = defaultModelPricing["gpt-6.1-sol"]!;
    expect(selectModelPricing(schedule, 272_000)).toEqual(schedule.default);
    expect(selectModelPricing(schedule, 272_001)).toEqual({
      inputMicrosPerMillionTokens: 4_000_000,
      cachedInputMicrosPerMillionTokens: 200_000,
      cacheWriteMicrosPerMillionTokens: 5_000_000,
      outputMicrosPerMillionTokens: 15_000_000,
      marginBps: 500,
    });
  });

  test.each(["grok-4.5", "grok-4.6", "grok-4.7"])(
    "uses the exclusive 200K boundary for %s",
    (id) => {
      const schedule = defaultModelPricing[id]!;
      expect(selectModelPricing(schedule, 200_000)).toEqual(schedule.default);
      expect(selectModelPricing(schedule, 200_001)).toEqual({
        inputMicrosPerMillionTokens: 4_000_000,
        cachedInputMicrosPerMillionTokens: id === "grok-4.5" ? 600_000 : 1_000_000,
        outputMicrosPerMillionTokens: 12_000_000,
        marginBps: 500,
      });
    },
  );

  test("covers every built-in, subscription and reviewed native catalog model without changing payer semantics", () => {
    const settings = catalogSettings();
    const prices = configuredModelListPricingSchedules(settings);
    const models = configuredModels(settings);
    expect(
      models.filter((model) => prices[model.id] === undefined).map((model) => model.id),
    ).toEqual([]);
    expect(models.length).toBe(51);
    for (const model of models) {
      if (model.credentialSource.kind === "connected_subscription") {
        expect(model.billing).toEqual({
          upstreamPayer: "connected_subscription",
          metering: "external",
        });
        expect(model.cost).toBe("subscription");
      } else if (model.providerId.startsWith("organization-")) {
        expect(model.billing).toEqual({ upstreamPayer: "organization", metering: "external" });
        expect(model.cost).toBe("organization");
      } else if (model.providerId.startsWith("workspace-")) {
        expect(model.billing).toEqual({ upstreamPayer: "workspace", metering: "external" });
        expect(model.cost).toBe("workspace");
      }
    }
    expect(prices["codex/gpt-6.1-sol"]).toEqual(defaultModelPricing["gpt-6.1-sol"]);
    expect(prices["supergrok/grok-4.7"]).toEqual(defaultModelPricing["grok-4.7"]);
  });

  test("keeps Claude's no-premium long context and prices 1h cache writes only on that native route", () => {
    let settings = catalogSettings();
    const providers = parseModelProvidersJson(settings.modelProvidersJson);
    providers.find((provider) => provider.id === "workspace-anthropic")!.anthropic!.cacheTtl = "1h";
    settings = { ...settings, modelProvidersJson: JSON.stringify(providers) };
    const prices = configuredModelListPricingSchedules(settings);
    for (const { upstreamModelId: id } of claudeModels) {
      const fiveMinute = prices[`organization-anthropic/${id}`]!;
      const oneHour = prices[`workspace-anthropic/${id}`]!;
      expect(selectModelPricing(fiveMinute, 900_000)).toEqual(fiveMinute.default);
      expect(oneHour.default).toEqual({
        ...fiveMinute.default,
        cacheWriteMicrosPerMillionTokens: fiveMinute.default.inputMicrosPerMillionTokens * 2,
      });
      expect(prices[`organization-claude-subscription/${id}`]).toEqual(fiveMinute);
    }
  });

  test("calculates cache reads/writes and per-request tiers without mutating captured schedules", () => {
    const settings = catalogSettings();
    const schedule = structuredClone(
      configuredModelListPricingSchedules(settings)["codex/gpt-6.1-sol"]!,
    );
    const usage = {
      inputTokens: 200,
      outputTokens: 100,
      inputTokensDetails: { cached_tokens: 100, cache_write_tokens: 100 },
    };
    expect(calculateModelListUsageCostBreakdown(settings, "codex/gpt-6.1-sol", usage)).toEqual({
      providerCostMicros: 1260,
      creditCostMicros: 1323,
    });
    expect(configuredModelListPricingSchedules(settings)["codex/gpt-6.1-sol"]).toEqual(schedule);
    const captured = structuredClone(defaultModelPricing["gpt-6.1-sol"]!);
    const changed = {
      ...settings,
      modelPricingJson: JSON.stringify({
        "gpt-6.1-sol": { inputMicrosPerMillionTokens: 99, outputMicrosPerMillionTokens: 99 },
      }),
    };
    expect(
      configuredModelListPricingSchedules(changed)["codex/gpt-6.1-sol"]!.default
        .inputMicrosPerMillionTokens,
    ).toBe(99);
    expect(captured).toEqual(defaultModelPricing["gpt-6.1-sol"]);
  });

  test("retains registry and explicit product-ID precedence, including an explicit zero price", () => {
    const settings = catalogSettings();
    const providers = parseModelProvidersJson(settings.modelProvidersJson);
    const model = providers
      .find((provider) => provider.kind === "codex-subscription")!
      .models.find((candidate) => candidate.id === "codex/gpt-6.1-sol")!;
    model.pricing = { inputMicrosPerMillionTokens: 11, outputMicrosPerMillionTokens: 22 };
    const inline = { ...settings, modelProvidersJson: JSON.stringify(providers) };
    expect(
      configuredModelListPricingSchedules(inline)[model.id]?.default.inputMicrosPerMillionTokens,
    ).toBe(11);
    const zero: ModelPricingScheduleV1 = {
      default: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    };
    expect(
      configuredModelListPricingSchedules({
        ...inline,
        modelPricingJson: JSON.stringify({ [model.id]: zero }),
      })[model.id],
    ).toEqual(zero);
  });

  test("selects comparison tiers per provider request, not from the turn's aggregate input", () => {
    expect(
      calculateModelListUsageCostBreakdown(catalogSettings(), "codex/gpt-6.1-sol", {
        inputTokens: 500_000,
        outputTokens: 0,
        requestUsageEntries: [
          { inputTokens: 200_000, outputTokens: 0 },
          { inputTokens: 300_000, outputTokens: 0 },
        ],
      }),
    ).toEqual({ providerCostMicros: 1_600_000, creditCostMicros: 1_680_000 });
  });

  test("prices explicit official xAI deployments by upstream identity, not an arbitrary alias", () => {
    const settings = getSettings({ OPENGENI_ENV: "test" });
    const provider = {
      id: "xai",
      api: "responses",
      baseUrl: "https://api.x.ai/v1",
      models: [{ id: "xai/grok-4.6", upstreamModelId: "grok-4.6", aliases: ["my-grok"] }],
    };
    const known = configuredModelListPricingSchedules({
      ...settings,
      modelProvidersJson: JSON.stringify([provider]),
    });
    expect(known["xai/grok-4.6"]).toEqual(defaultModelPricing["grok-4.6"]);
    expect(known["my-grok"]).toBeUndefined();
    const proxy = configuredModelListPricingSchedules({
      ...settings,
      modelProvidersJson: JSON.stringify([{ ...provider, baseUrl: "https://proxy.example/v1" }]),
    });
    expect(proxy["xai/grok-4.6"]).toBeUndefined();
  });

  test("leaves genuinely unpriced custom and future models unknown, even when names resemble reviewed IDs", () => {
    let settings = catalogSettings();
    settings = withWorkspaceGatewayCatalogProvider(settings, [
      { upstreamModelId: "openai/gpt-6.1-sol" },
      { upstreamModelId: "custom/unpriced" },
    ]);
    settings = withClaudeConnectionCatalog(settings, {
      anthropic: { models: [{ upstreamModelId: "claude-opus-99" }] },
    });
    const providers = parseModelProvidersJson(settings.modelProvidersJson);
    const codex = providers.find((provider) => provider.kind === "codex-subscription")!;
    codex.models.push({
      ...codex.models[0]!,
      id: "codex/gpt-99-sol",
      upstreamModelId: "gpt-99-sol",
    });
    settings = { ...settings, modelProvidersJson: JSON.stringify(providers) };
    const prices = configuredModelListPricingSchedules(settings);
    expect(prices["workspace-gateway/openai/gpt-6.1-sol"]).toBeUndefined();
    expect(prices["workspace-gateway/custom/unpriced"]).toBeUndefined();
    expect(prices["organization-anthropic/claude-opus-99"]).toBeUndefined();
    expect(prices["codex/gpt-99-sol"]).toBeUndefined();
  });

  test("distinguishes the verified free OpenRouter route from an unknown rate", () => {
    // https://openrouter.ai/api/v1/models: prompt=0 and completion=0,
    // checked 2026-10-03. Never generalize zero to arbitrary :free suffixes.
    const prices = configuredModelListPricingSchedules(catalogSettings());
    for (const prefix of ["openrouter/", "workspace-openrouter/", "organization-openrouter/"]) {
      expect(
        prices[`${prefix}nvidia/nemotron-3-super-120b-a12b:free`]?.default
          .inputMicrosPerMillionTokens,
      ).toBe(0);
    }
    expect(prices["workspace-openrouter/custom/unknown:free"]).toBeUndefined();
  });

  test("comparison projections never become debit authority or change frozen model definitions", () => {
    const settings = catalogSettings();
    const debitPrices = configuredModelPricingSchedules(settings);
    const before = configuredModels(settings).map((model) => [model.id, model.definitionVersion]);
    configuredModelListPricingSchedules(settings);
    const after = configuredModels(settings).map((model) => [model.id, model.definitionVersion]);
    expect(after).toEqual(before);
    for (const id of [
      "codex/gpt-6.1-sol",
      "supergrok/grok-4.7",
      "organization-anthropic/claude-opus-5-5",
    ]) {
      expect(debitPrices[id]).toBeUndefined();
      expect(() =>
        calculateModelUsageCostBreakdown(settings, id, { inputTokens: 100, outputTokens: 10 }),
      ).toThrow(`Missing model pricing for ${id}`);
      expect(
        calculateModelListUsageCostBreakdown(settings, id, { inputTokens: 100, outputTokens: 10 })
          .providerCostMicros,
      ).toBeGreaterThan(0);
      expect(configuredModels(settings).find((model) => model.id === id)?.pricing).toBeUndefined();
    }
  });
});
