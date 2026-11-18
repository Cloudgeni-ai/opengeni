import { describe, expect, test } from "bun:test";
import { CODEX_FALLBACK_MODEL_SLUGS } from "@opengeni/codex/constants";
import {
  calculateModelUsageCostBreakdown,
  codexUpstreamModelSlugs,
  configuredAllowedModels,
  configuredModelListPricingSchedules,
  configuredModelPricingSchedules,
  configuredModels,
  connectedModelPriceBasisFromReportedModel,
  connectedModelPriceBasisModelIds,
  defaultModelPricing,
  getSettings,
  organizationConnectedModelListPrice,
  productLabelForModelId,
  productShortLabelForModelId,
  resolveTurnExecutionPolicyV1,
  selectModelPricing,
  TurnExecutionPolicyModelUnavailableError,
  withCodexCatalogProvider,
} from "../src";

// OpenAI list prices for GPT-6.2, reviewed 2026-11-18 against
// https://developers.openai.com/api/docs/pricing and the gpt-6.2-astra /
// gpt-6.2-sol model pages. USD per 1M tokens: input, cached input, 30-minute
// cache write, output; above 272K input tokens input and cache rates double
// and output is 1.5x for the whole request.
const usd = (value: number) => Math.round(value * 1_000_000);
const officialRows = [
  ["gpt-6.2-astra", [8, 0.4, 10, 40], [16, 0.8, 20, 60]],
  ["gpt-6.2-sol", [2, 0.1, 2.5, 10], [4, 0.2, 5, 15]],
] as const;

function rates([input, cached, write, output]: readonly [number, number, number, number]) {
  return {
    inputMicrosPerMillionTokens: usd(input),
    cachedInputMicrosPerMillionTokens: usd(cached),
    cacheWriteMicrosPerMillionTokens: usd(write),
    outputMicrosPerMillionTokens: usd(output),
    marginBps: 500,
  };
}

function policy(settings: ReturnType<typeof getSettings>, modelId: string) {
  return resolveTurnExecutionPolicyV1(settings, {
    modelId,
    requestedModelId: modelId,
    modelSource: "explicit",
    reasoningEffort: "medium",
    reasoningSource: "explicit",
  });
}

describe("GPT-6.2 Astra and Sol", () => {
  test.each(officialRows)("%s carries OpenAI's Standard and >272K rates", (id, short, long) => {
    const schedule = defaultModelPricing[id]!;
    expect(selectModelPricing(schedule, 272_000)).toEqual(rates(short));
    expect(selectModelPricing(schedule, 272_001)).toEqual(rates(long));
  });

  test("are the built-in OpenAI and Codex defaults in place of GPT-6 Astra", () => {
    const settings = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
    });
    expect(settings.openaiModel).toBe("gpt-6.2-astra");
    expect(configuredAllowedModels(settings)).toEqual([
      "gpt-6.2-astra",
      "gpt-6.2-sol",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect([...CODEX_FALLBACK_MODEL_SLUGS]).toEqual([
      "gpt-6.2-astra",
      "gpt-6.2-sol",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(codexUpstreamModelSlugs(settings)).toEqual([...CODEX_FALLBACK_MODEL_SLUGS]);
    const models = configuredModels(withCodexCatalogProvider(settings));
    for (const slug of ["gpt-6.2-astra", "gpt-6.2-sol"]) {
      for (const id of [slug, `codex/${slug}`]) {
        const model = models.find((candidate) => candidate.id === id)!;
        expect(model.capabilities.inputModalities).toEqual(["text", "image"]);
        expect(model.capabilities.promptCaching).toEqual({
          upstream: "supported",
          runnable: true,
          mode: "implicit",
        });
        expect(model.capabilities.latencyModes.map((mode) => mode.id)).toEqual([
          "standard",
          "fast",
          "ultrafast",
        ]);
      }
    }
    expect(models.some((model) => model.id === "gpt-6-astra")).toBe(false);
    expect(models.some((model) => model.id === "codex/gpt-6-astra")).toBe(false);
  });

  test("price on every route by their OpenAI model id", () => {
    const settings = withCodexCatalogProvider(
      getSettings({ OPENGENI_ENV: "test", OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true" }),
    );
    const debit = configuredModelPricingSchedules(settings);
    const list = configuredModelListPricingSchedules(settings);
    for (const [id] of officialRows) {
      expect(debit[id]).toEqual(defaultModelPricing[id]);
      expect(list[`codex/${id}`]).toEqual(defaultModelPricing[id]);
      expect(connectedModelPriceBasisModelIds(settings)).toContain(id);
      // Azure reports a deployment's base model, often with its snapshot date.
      expect(connectedModelPriceBasisFromReportedModel(settings, `${id}-2026-11-17`)).toBe(id);
      for (const kind of ["azure_openai", "openai"] as const) {
        expect(
          organizationConnectedModelListPrice(settings, kind, {
            upstreamModelId: `team-${id}`,
            listPricingModelId: id,
          }).listPriceKnown,
        ).toBe(true);
      }
    }
  });

  test("bill Ultrafast at OpenAI's 3x launch rate, other GPT-6 models at 6x", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    for (const [id, multiplier] of [
      ["gpt-6.2-astra", 3],
      ["gpt-6.2-sol", 3],
      ["gpt-6.1-sol", 6],
      ["gpt-6-astra", 6],
    ] as const) {
      const settings = getSettings({
        OPENGENI_ENV: "test",
        OPENGENI_OPENAI_MODEL: id,
        OPENGENI_OPENAI_ALLOWED_MODELS: id,
        OPENGENI_MODEL_PRICING_JSON:
          id === "gpt-6.1-sol"
            ? JSON.stringify({ "gpt-6.1-sol": rates([2, 0.1, 2.5, 10]) })
            : undefined,
      });
      const standard = calculateModelUsageCostBreakdown(settings, id, usage);
      const ultrafast = calculateModelUsageCostBreakdown(settings, id, usage, {
        latencyMode: "ultrafast",
      });
      expect(ultrafast.providerCostMicros).toBe(standard.providerCostMicros * multiplier);
    }
  });

  test("have product labels", () => {
    expect(productLabelForModelId("codex/gpt-6.2-astra")).toBe("GPT-6.2 Astra");
    expect(productLabelForModelId("gpt-6.2-sol")).toBe("GPT-6.2 Sol");
    expect(productShortLabelForModelId("codex/gpt-6.2-astra")).toBe("6.2 Astra");
    expect(productShortLabelForModelId("gpt-6.2-sol")).toBe("6.2 Sol");
  });
});

describe("GPT-6 Astra after its removal from the defaults", () => {
  const settings = getSettings({
    OPENGENI_ENV: "test",
    OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
  });

  test("no longer starts new work by default, on either route", () => {
    for (const id of ["gpt-6-astra", "codex/gpt-6-astra"]) {
      expect(() => policy(settings, id)).toThrow(TurnExecutionPolicyModelUnavailableError);
    }
  });

  test("keeps working for deployments that still list it", () => {
    const explicit = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_OPENAI_MODEL: "gpt-6-astra",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-6-astra,gpt-6.2-astra",
    });
    expect(policy(explicit, "gpt-6-astra").upstreamModelId).toBe("gpt-6-astra");
    expect(configuredModelPricingSchedules(explicit)["gpt-6-astra"]).toEqual(
      defaultModelPricing["gpt-6-astra"],
    );
  });

  test("keeps its price for Azure deployments of it and recorded usage", () => {
    expect(defaultModelPricing["gpt-6-astra"]!.default).toEqual(rates([10, 1, 12.5, 50]));
    expect(connectedModelPriceBasisFromReportedModel(settings, "gpt-6-astra-2026-03-05")).toBe(
      "gpt-6-astra",
    );
    expect(
      organizationConnectedModelListPrice(settings, "azure_openai", {
        upstreamModelId: "astra-prod",
        listPricingModelId: "gpt-6-astra",
      }),
    ).toEqual({ listPrice: { basis: "model", modelId: "gpt-6-astra" }, listPriceKnown: true });
    expect(productShortLabelForModelId("codex/gpt-6-astra")).toBe("6 Astra");
  });
});
