import { describe, expect, test } from "bun:test";
import * as config from "../src";

const SOL_CAPABILITIES = {
  reasoning: {
    upstream: "supported",
    runnable: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    required: false,
  },
  functionCalling: { upstream: "supported", runnable: true },
  structuredOutput: { upstream: "supported", runnable: true },
  hostedTools: {
    webSearch: { upstream: "unknown", runnable: false },
    xSearch: { upstream: "unknown", runnable: false },
    codeExecution: { upstream: "unknown", runnable: false },
    imageGeneration: { upstream: "unknown", runnable: false },
  },
  inputModalities: ["text", "image"],
  inputFileMediaTypes: ["application/pdf"],
  outputModalities: ["text"],
  transports: {
    sse: { upstream: "supported", runnable: true },
    responsesWebSocket: { upstream: "unknown", runnable: false },
    realtimeAudio: { upstream: "unsupported", runnable: false },
  },
  latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
};

const SOL_BASE_URL = "https://sol.example.openai.azure.com/openai/v1";

const solProvider = {
  kind: "api-key",
  id: "azure-sol",
  label: "Azure OpenAI (Sol)",
  api: "responses",
  wireProfile: "azure-openai",
  baseUrl: SOL_BASE_URL,
  models: [
    {
      id: "azure-sol/gpt-6.1-sol",
      upstreamModelId: "gpt-6.1-sol",
      aliases: ["gpt-6.1-sol"],
      label: "GPT-6.1 Sol",
      contextWindowTokens: 1_050_000,
      effectiveContextWindowTokens: 997_500,
      autoCompactTokenLimit: 900_000,
      toolOutputTruncationTokens: 10_000,
      capabilities: SOL_CAPABILITIES,
    },
  ],
};

const fallbackRoutes = [
  {
    productId: "gpt-6-luna",
    via: "opengeni-gateway",
    upstreamModelId: "openai/gpt-6-luna",
    providers: ["openai"],
  },
  {
    productId: "azure-sol/gpt-6.1-sol",
    via: "opengeni-gateway",
    upstreamModelId: "openai/gpt-6.1-sol",
    providers: ["openai"],
  },
];

const pricing = {
  "azure-sol/gpt-6.1-sol": {
    inputMicrosPerMillionTokens: 2_200_000,
    cachedInputMicrosPerMillionTokens: 110_000,
    cacheWriteMicrosPerMillionTokens: 2_750_000,
    outputMicrosPerMillionTokens: 11_000_000,
    marginBps: 500,
  },
};

function envSettings(overrides: Record<string, string | undefined> = {}) {
  return config.getSettings({
    OPENGENI_MODEL_CATALOG_SOURCE: "database",
    OPENGENI_MODEL_COST_POLICY_JSON: "{}",
    OPENGENI_OPENAI_PROVIDER: "azure",
    OPENGENI_AZURE_OPENAI_API_KEY: "azure-test-key",
    OPENGENI_AZURE_OPENAI_BASE_URL: "https://luna.example.openai.azure.com/openai/v1",
    OPENGENI_OPENAI_MODEL: "gpt-6-luna",
    OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-6-luna",
    OPENGENI_VERCEL_AI_GATEWAY_API_KEY: "gateway-test-key",
    OPENGENI_MODEL_PRICING_JSON: JSON.stringify(pricing),
    OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
      { ...solProvider, models: solProvider.models, apiKey: "sol-test-key" },
    ]),
    ...overrides,
  });
}

function catalogDocument(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    defaultModel: "gpt-6-luna",
    builtInModels: ["gpt-6-luna"],
    registryProviders: [solProvider],
    gatewayModels: [],
    openrouterModels: [],
    modelNotes: {},
    ...extra,
  };
}

function catalog(options: { declared?: boolean; env?: Record<string, string | undefined> } = {}) {
  return config.applyModelCatalogDocument(
    envSettings(options.env),
    catalogDocument(options.declared === false ? {} : { fallbackRoutes }),
  );
}

const lunaRequest = {
  modelId: "gpt-6-luna",
  requestedModelId: null,
  modelSource: "session" as const,
  reasoningEffort: "low" as const,
  reasoningSource: "session" as const,
};

describe("credits model fallback routes", () => {
  test("declaring a route changes no primary definition until an operator selects it", () => {
    const undeclared = config.configuredModels(catalog({ declared: false }));
    const declared = config.configuredModels(catalog());
    expect(declared.map((model) => [model.id, model.providerId, model.definitionVersion])).toEqual(
      undeclared.map((model) => [model.id, model.providerId, model.definitionVersion]),
    );
    expect(config.activeModelFallbackRouteProductIds(catalog())).toEqual([]);
    expect(() => config.validateModelCatalogSettings(catalog())).not.toThrow();
  });

  test("a selected route keeps the product identity, pricing and credits billing", () => {
    const primary = config.configuredModels(catalog());
    const switched = config.withModelFallbackRouteSelection(catalog(), [
      "gpt-6-luna",
      "azure-sol/gpt-6.1-sol",
    ]);
    const models = config.configuredModels(switched);
    expect(models.map((model) => model.id)).toEqual(primary.map((model) => model.id));
    for (const route of fallbackRoutes) {
      const before = primary.find((model) => model.id === route.productId)!;
      const after = models.find((model) => model.id === route.productId)!;
      expect(after).toMatchObject({
        id: before.id,
        aliases: before.aliases,
        label: before.label,
        providerId: "opengeni-gateway",
        api: "responses",
        upstreamModelId: route.upstreamModelId,
        deployment: { upstreamModelId: route.upstreamModelId, wireApi: "responses" },
        credentialSource: { kind: "deployment", mechanism: "api_key" },
        billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
        cost: "credits",
        requestPolicy: { gateway: { only: ["openai"], caching: "auto" } },
        executionLimits: before.executionLimits,
      });
      expect(after.pricing).toEqual(before.pricing);
      expect(after.definitionVersion).not.toBe(before.definitionVersion);
      expect(after.capabilities.reasoning).toEqual(before.capabilities.reasoning);
      expect(after.capabilities.inputModalities).toEqual(before.capabilities.inputModalities);
      expect(after.capabilities.hostedTools.webSearch.runnable).toBe(false);
      expect(after.hostedWebSearch).toBe(false);
      expect(after.capabilities.latencyModes.map((mode) => mode.id)).toEqual(["standard"]);
    }
    // The alias still canonicalizes to the unchanged product id.
    expect(config.canonicalizeConfiguredModelId(switched, "gpt-6.1-sol")).toBe(
      "azure-sol/gpt-6.1-sol",
    );
    expect(config.resolveModelProvider(switched, "gpt-6-luna")?.provider).toMatchObject({
      id: "opengeni-gateway",
      kind: "vercel-gateway-managed",
      api: "responses",
    });
    // The turn's own model overrides openaiModel at execution; the built-in
    // provider must not reclaim the switched product.
    expect(
      config.resolveModelProvider({ ...switched, openaiModel: "gpt-6-luna" }, "gpt-6-luna")?.model
        .providerId,
    ).toBe("opengeni-gateway");
  });

  test("selection ignores products without a declared route", () => {
    const switched = config.withModelFallbackRouteSelection(catalog(), ["unknown/model"]);
    expect(switched.activeModelFallbackRoutesJson).toBeUndefined();
    const undeclared = config.withModelFallbackRouteSelection(catalog({ declared: false }), [
      "gpt-6-luna",
    ]);
    expect(config.resolveModelProvider(undeclared, "gpt-6-luna")?.provider.id).toBe("azure");
  });

  test("accepted turns keep their frozen route across a flip in either direction", () => {
    const onPrimary = catalog();
    const onFallback = config.withModelFallbackRouteSelection(onPrimary, ["gpt-6-luna"]);
    const acceptedOnPrimary = config.resolveTurnExecutionPolicyV1(onPrimary, lunaRequest);
    const acceptedOnFallback = config.resolveTurnExecutionPolicyV1(onFallback, lunaRequest);
    expect(acceptedOnPrimary.providerId).toBe("azure");
    expect(acceptedOnFallback).toMatchObject({
      productModelId: "gpt-6-luna",
      providerId: "opengeni-gateway",
      upstreamModelId: "openai/gpt-6-luna",
      wireApi: "responses",
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    });

    // Without the accepted-route pin the frozen identity drifts and fails closed.
    expect(() =>
      config.assertTurnExecutionPolicyMatchesConfigV1(onFallback, acceptedOnPrimary, lunaRequest),
    ).toThrow("does not match the current provider definition");
    expect(() =>
      config.assertTurnExecutionPolicyMatchesConfigV1(onPrimary, acceptedOnFallback, lunaRequest),
    ).toThrow("does not match the current provider definition");

    const primaryTurnAfterFlip = config.settingsForAcceptedModelRoute(
      onFallback,
      acceptedOnPrimary,
    );
    expect(
      config.assertTurnExecutionPolicyMatchesConfigV1(
        primaryTurnAfterFlip,
        acceptedOnPrimary,
        lunaRequest,
      ).provider.id,
    ).toBe("azure");
    const fallbackTurnAfterFlipBack = config.settingsForAcceptedModelRoute(
      onPrimary,
      acceptedOnFallback,
    );
    expect(
      config.assertTurnExecutionPolicyMatchesConfigV1(
        fallbackTurnAfterFlipBack,
        acceptedOnFallback,
        lunaRequest,
      ).provider.id,
    ).toBe("opengeni-gateway");
    // Pinning one product leaves every other product on the operator selection.
    expect(config.settingsForAcceptedModelRoute(onFallback, acceptedOnFallback)).toBe(onFallback);
    const both = config.withModelFallbackRouteSelection(onPrimary, [
      "gpt-6-luna",
      "azure-sol/gpt-6.1-sol",
    ]);
    const pinned = config.settingsForAcceptedModelRoute(both, acceptedOnPrimary);
    expect(config.activeModelFallbackRouteProductIds(pinned)).toEqual(["azure-sol/gpt-6.1-sol"]);
  });

  test("Gateway-reported cost debits the provider price plus the product margin", () => {
    const switched = config.withModelFallbackRouteSelection(catalog(), ["azure-sol/gpt-6.1-sol"]);
    expect(
      config.calculateGatewayReportedCostBreakdown(switched, "azure-sol/gpt-6.1-sol", "0.020000", {
        inputTokens: 1000,
      }),
    ).toEqual({ providerCostMicros: 20_000, creditCostMicros: 21_000 });
  });

  test("catalog preflight rejects routes that could not execute", () => {
    expect(() =>
      config.validateModelCatalogSettings(
        catalog({ env: { OPENGENI_VERCEL_AI_GATEWAY_API_KEY: undefined } }),
      ),
    ).toThrow("managed Vercel AI Gateway is not configured");
    const parse = (routes: unknown[], extra: Record<string, unknown> = {}) =>
      config.parseModelCatalogDocument(catalogDocument({ fallbackRoutes: routes, ...extra }));
    const luna = fallbackRoutes[0]!;
    expect(() => parse([{ ...luna, productId: "codex/gpt-6-luna" }])).toThrow(
      "must name a built-in or registry deployment product",
    );
    expect(() => parse([luna, { ...luna }])).toThrow("duplicate fallback route");
    expect(() => parse([{ ...luna, providers: ["openai", "azure"] }])).toThrow();
    expect(() => parse([{ ...luna, providers: [] }])).toThrow();
    expect(() => parse([{ ...luna, via: "openrouter" }])).toThrow();
    expect(() => parse([{ ...luna, pricing: {} }])).toThrow();
    expect(() =>
      parse([{ ...luna, upstreamModelId: "deepseek/deepseek-v4.1-flash" }], {
        gatewayModels: [
          {
            productId: "deepseek-v4.1-flash",
            workspaceProductId: "workspace-gateway/deepseek-v4.1-flash",
            upstreamModelId: "deepseek/deepseek-v4.1-flash",
            label: "DeepSeek V4.1 Flash",
            providers: ["deepseek"],
          },
        ],
      }),
    ).toThrow("already routed");
  });

  test("a catalog without declared routes never parses a switch selection", () => {
    const settings = catalog({ declared: false });
    expect(config.configuredModelFallbackRoutes(settings)).toEqual([]);
    expect(config.applyModelCatalogDocument(envSettings(), catalogDocument())).toMatchObject({
      resolvedModelFallbackRoutesJson: undefined,
      activeModelFallbackRoutesJson: undefined,
    });
  });
});
