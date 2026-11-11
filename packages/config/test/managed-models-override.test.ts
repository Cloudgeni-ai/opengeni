import { describe, expect, test } from "bun:test";

import {
  applyModelCatalogDocument,
  configuredGatewayUpstreamModelIds,
  configuredModelPricingSchedules,
  configuredModels,
  configuredOpenRouterUpstreamModelIds,
  configuredOpperUpstreamModelIds,
  getSettings,
  OPENGENI_OPENROUTER_MODELS,
  OPENGENI_OPPER_MODELS,
  opperMaxOutputTokens,
  parseManagedModelsJson,
  validateModelCatalogSettings,
} from "../src";

const OPUS = OPENGENI_OPPER_MODELS[0]!;
const { pricing: _pricing, ...opusEntry } = OPUS;
const sonnetEntry = {
  ...opusEntry,
  upstreamModelId: "aws/claude-sonnet-4-6-eu",
  label: "Claude Sonnet 4.6 (EU)",
  shortLabel: "Sonnet 4.6",
  maxOutputTokens: 64_000,
};

function base(env: Record<string, string> = {}) {
  return getSettings({ OPENGENI_ENV: "test", ...env });
}

describe("OPENGENI_MANAGED_MODELS_JSON", () => {
  test("unset keeps every reviewed code table", () => {
    const settings = base();
    expect(configuredOpperUpstreamModelIds(settings)).toEqual([OPUS.upstreamModelId]);
    expect(configuredOpenRouterUpstreamModelIds(settings)).toEqual(
      OPENGENI_OPENROUTER_MODELS.map((model) => model.upstreamModelId),
    );
    expect(configuredGatewayUpstreamModelIds(settings).length).toBeGreaterThan(0);
  });

  test("a present key replaces only that provider's list in code mode", () => {
    const settings = base({
      OPENGENI_OPPER_API_KEY: "op-deployment",
      OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({ opperModels: [opusEntry, sonnetEntry] }),
    });
    expect(configuredOpperUpstreamModelIds(settings)).toEqual([
      OPUS.upstreamModelId,
      "aws/claude-sonnet-4-6-eu",
    ]);
    expect(configuredOpenRouterUpstreamModelIds(settings)).toEqual(
      OPENGENI_OPENROUTER_MODELS.map((model) => model.upstreamModelId),
    );
    const sonnet = configuredModels(settings).find(
      (model) => model.id === "opper/aws/claude-sonnet-4-6-eu",
    )!;
    expect(sonnet).toMatchObject({ label: "Claude Sonnet 4.6 (EU)", cost: "credits" });
    expect(opperMaxOutputTokens(settings, "aws/claude-sonnet-4-6-eu")).toBe(64_000);
    // A reviewed Opper list price applies without OPENGENI_MODEL_PRICING_JSON.
    expect(
      configuredModelPricingSchedules(settings)["opper/aws/claude-sonnet-4-6-eu"]?.default,
    ).toMatchObject({ inputMicrosPerMillionTokens: 3_300_000, marginBps: 500 });
  });

  test("an empty array removes that provider's deployment membership", () => {
    const settings = base({
      OPENGENI_OPPER_API_KEY: "op-deployment",
      OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({ opperModels: [] }),
    });
    expect(configuredOpperUpstreamModelIds(settings)).toEqual([]);
    expect(configuredModels(settings).some((model) => model.id.startsWith("opper/"))).toBe(false);
  });

  test("the same mechanism replaces the Gateway and OpenRouter lists", () => {
    const gateway = {
      productId: "deepseek-v4-flash-0731",
      workspaceProductId: "workspace-gateway/deepseek-v4-flash-0731",
      upstreamModelId: "deepseek/deepseek-v4-flash-0731",
      label: "DeepSeek V4 Flash 0731",
      providers: ["baseten"],
    };
    const openrouter = {
      ...OPENGENI_OPENROUTER_MODELS[0]!,
      upstreamModelId: "example/other-model:free",
      label: "Other",
    };
    const settings = base({
      OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({
        gatewayModels: [gateway],
        openrouterModels: [openrouter],
      }),
      // The default policy names the replaced OpenRouter starter, so a new
      // list states its own free/credits policy.
      OPENGENI_MODEL_COST_POLICY_JSON: JSON.stringify({
        "openrouter/example/other-model:free": "free",
      }),
    });
    expect(configuredGatewayUpstreamModelIds(settings)).toEqual([gateway.upstreamModelId]);
    expect(configuredOpenRouterUpstreamModelIds(settings)).toEqual(["example/other-model:free"]);
    expect(configuredOpperUpstreamModelIds(settings)).toEqual([OPUS.upstreamModelId]);
  });

  test("a credits route without a reviewed price requires OPENGENI_MODEL_PRICING_JSON", () => {
    const unpriced = { ...opusEntry, upstreamModelId: "aws/claude-opus-5", label: "Claude Opus 5" };
    const env = {
      OPENGENI_OPPER_API_KEY: "op-deployment",
      OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({ opperModels: [unpriced] }),
    };
    const missing = { ...base(env), billingMode: "stripe" as const };
    expect(() => validateModelCatalogSettings(missing, {})).toThrow(
      /Missing model pricing.*opper\/aws\/claude-opus-5/u,
    );
    const priced = {
      ...base({
        ...env,
        OPENGENI_MODEL_PRICING_JSON: JSON.stringify({
          "opper/aws/claude-opus-5": {
            inputMicrosPerMillionTokens: 5_500_000,
            outputMicrosPerMillionTokens: 27_500_000,
            marginBps: 500,
          },
        }),
      }),
      billingMode: "stripe" as const,
    };
    expect(() => validateModelCatalogSettings(priced, {})).not.toThrow();
  });

  test("rejects prices, unknown keys, duplicates and invalid JSON at boot", () => {
    expect(() =>
      base({ OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({ opperModels: [OPUS] }) }),
    ).toThrow(/OPENGENI_MANAGED_MODELS_JSON is invalid/u);
    expect(() =>
      base({ OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({ builtInModels: ["gpt-6-astra"] }) }),
    ).toThrow(/OPENGENI_MANAGED_MODELS_JSON is invalid/u);
    expect(() =>
      base({
        OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({ opperModels: [opusEntry, opusEntry] }),
      }),
    ).toThrow(/duplicate opperModels model id/u);
    expect(() => base({ OPENGENI_MANAGED_MODELS_JSON: "{" })).toThrow(/valid JSON/u);
    expect(() => parseManagedModelsJson(JSON.stringify({ gatewayModels: [{}] }))).toThrow();
  });

  test("database mode ignores the override; the catalog document stays authoritative", () => {
    const settings = applyModelCatalogDocument(
      base({
        OPENGENI_OPPER_API_KEY: "op-deployment",
        OPENGENI_MODEL_CATALOG_SOURCE: "database",
        OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({ opperModels: [sonnetEntry] }),
      }),
      {
        schemaVersion: 1,
        defaultModel: "gpt-6-astra",
        builtInModels: ["gpt-6-astra"],
        opperModels: [opusEntry],
      },
    );
    expect(configuredOpperUpstreamModelIds(settings)).toEqual([OPUS.upstreamModelId]);
    // Even before the document is applied, database mode never reads the env.
    const unresolved = base({
      OPENGENI_MODEL_CATALOG_SOURCE: "database",
      OPENGENI_MANAGED_MODELS_JSON: JSON.stringify({ opperModels: [sonnetEntry] }),
    });
    expect(configuredOpperUpstreamModelIds(unresolved)).toEqual([OPUS.upstreamModelId]);
  });
});
