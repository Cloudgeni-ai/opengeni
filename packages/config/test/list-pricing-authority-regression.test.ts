import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertTurnExecutionPolicyMatchesConfigV1,
  calculateModelListUsageCostBreakdown,
  calculateModelUsageCostBreakdown,
  configuredModelListPricingSchedules,
  configuredModelPricingSchedules,
  configuredModels,
  defaultModelPricing,
  getSettings,
  resolveTurnExecutionPolicyV1,
  selectModelPricing,
} from "../src";

// Captured by importing the detached base's config, not this PR's config:
// 272c01613b2f8071eab3024f855fcb39fd54a6fc (2026-10-03).
const BASE_DEBIT_TABLE_SHA256 = "5761bd31ef1dfcd918d1b750904342619a454895c1ee63d2d8f60c64c4a87c7a";
const BASE_BARE_SOL_DEFINITION =
  "sha256:d58cb44d22f04624f6e68c1432a55ae3715168254c33bc2d89a46320b1dd8b0c";
const base = getSettings({ OPENGENI_ENV: "test" });

describe("comparison pricing preserves base debit and accepted-policy authority", () => {
  test("keeps the entire base debit-default table unchanged", () => {
    expect(createHash("sha256").update(JSON.stringify(defaultModelPricing)).digest("hex")).toBe(
      BASE_DEBIT_TABLE_SHA256,
    );
    for (const id of ["gpt-6.1-sol", "grok-4.5", "grok-4.6", "grok-4.7", "claude-opus-5-5"]) {
      expect(defaultModelPricing[id]).toBeUndefined();
      expect(configuredModelPricingSchedules(base)[id]).toBeUndefined();
    }
  });

  test("retains the base accepted bare GPT-6.1 Sol definition and missing debit price", () => {
    const settings = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_OPENAI_MODEL: "gpt-6.1-sol",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-6.1-sol",
    });
    const input = {
      modelId: "gpt-6.1-sol",
      requestedModelId: "gpt-6.1-sol",
      modelSource: "explicit" as const,
      reasoningEffort: "medium" as const,
      reasoningSource: "explicit" as const,
      latencyMode: "standard" as const,
      latencyModeSource: "explicit" as const,
    };
    const current = resolveTurnExecutionPolicyV1(settings, input);
    const acceptedAtBase = { ...current, definitionVersion: BASE_BARE_SOL_DEFINITION };
    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(settings, acceptedAtBase, input),
    ).not.toThrow();
    expect(current.definitionVersion).toBe(BASE_BARE_SOL_DEFINITION);
    expect(configuredModels(settings)[0]?.pricing).toBeUndefined();
    expect(() =>
      calculateModelUsageCostBreakdown(settings, "gpt-6.1-sol", {
        inputTokens: 100,
        outputTokens: 10,
      }),
    ).toThrow("Missing model pricing");
    expect(
      calculateModelListUsageCostBreakdown(settings, "gpt-6.1-sol", {
        inputTokens: 100,
        outputTokens: 10,
      }).providerCostMicros,
    ).toBeGreaterThan(0);
  });

  test.each(["gpt-6.1-sol", "grok-4.6", "claude-opus-5-5"])(
    "never inherits a newly reviewed list rate on an untrusted bare proxy ID %s",
    (id) => {
      const settings = {
        ...base,
        modelProvidersJson: JSON.stringify([
          {
            id: "untrusted",
            api: "responses",
            baseUrl: "https://proxy.example/v1",
            models: [{ id }],
          },
        ]),
      };
      expect(configuredModelListPricingSchedules(settings)[id]).toBeUndefined();
      expect(configuredModelPricingSchedules(settings)[id]).toBeUndefined();
      expect(configuredModels(settings).find((model) => model.id === id)?.pricing).toBeUndefined();
      const explicit = {
        ...settings,
        modelPricingJson: JSON.stringify({
          [id]: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
        }),
      };
      expect(
        configuredModelListPricingSchedules(explicit)[id]?.default.inputMicrosPerMillionTokens,
      ).toBe(0);
    },
  );

  test("does not expose newly reviewed bare rates on disabled, proxy, or Azure built-in routes", () => {
    expect(configuredModelListPricingSchedules(base)["gpt-6.1-sol"]).toBeUndefined();
    for (const settings of [
      {
        ...base,
        openaiModel: "gpt-6.1-sol",
        openaiAllowedModels: "gpt-6.1-sol",
        openaiBaseUrl: "https://proxy.example/v1",
      },
      {
        ...base,
        openaiModel: "gpt-6.1-sol",
        openaiAllowedModels: "gpt-6.1-sol",
        openaiProvider: "azure" as const,
      },
      { ...base, openaiModel: "claude-opus-5-5", openaiAllowedModels: "claude-opus-5-5" },
    ]) {
      expect(configuredModelListPricingSchedules(settings)[settings.openaiModel]).toBeUndefined();
    }
  });

  test.each(["grok-4.5", "grok-4.6", "grok-4.7"])(
    "keeps native xAI's 200,000 boundary separate from an explicit Gateway 200,001 schedule for %s",
    (id) => {
      const nativeSettings = {
        ...base,
        modelProvidersJson: JSON.stringify([
          {
            id: "native-xai",
            api: "responses",
            baseUrl: "https://api.x.ai/v1",
            models: [{ id: `native/${id}`, upstreamModelId: id }],
          },
        ]),
      };
      const native = configuredModelListPricingSchedules(nativeSettings)[`native/${id}`]!;
      expect(selectModelPricing(native, 199_999).inputMicrosPerMillionTokens).toBe(2_000_000);
      expect(selectModelPricing(native, 200_000).inputMicrosPerMillionTokens).toBe(4_000_000);
      const gateway = {
        ...native,
        inputTokenTiers: native.inputTokenTiers?.map((tier) => ({
          ...tier,
          minimumInputTokens: 200_001,
        })),
      };
      const gatewaySettings = {
        ...base,
        modelProvidersJson: JSON.stringify([
          {
            id: "gateway",
            api: "responses",
            baseUrl: "https://ai-gateway.vercel.sh/v1",
            models: [{ id: `gateway/${id}`, upstreamModelId: `xai/${id}`, pricing: gateway }],
          },
        ]),
      };
      const explicitGateway =
        configuredModelListPricingSchedules(gatewaySettings)[`gateway/${id}`]!;
      expect(selectModelPricing(explicitGateway, 200_000).inputMicrosPerMillionTokens).toBe(
        2_000_000,
      );
      expect(selectModelPricing(explicitGateway, 200_001).inputMicrosPerMillionTokens).toBe(
        4_000_000,
      );
      expect(configuredModelPricingSchedules(nativeSettings)[`native/${id}`]).toBeUndefined();
      expect(configuredModelPricingSchedules(gatewaySettings)[`gateway/${id}`]).toEqual(gateway);
    },
  );
});
