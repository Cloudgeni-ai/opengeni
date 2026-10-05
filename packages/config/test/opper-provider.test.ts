import { describe, expect, test } from "bun:test";

import {
  applyModelCatalogDocument,
  calculateModelUsageCostMicros,
  configuredModelPricingSchedules,
  configuredModels,
  configuredOpperUpstreamModelIds,
  configuredOpperWorkspaceProductModelIds,
  configuredProviders,
  getSettings,
  opperCredentialProblem,
  OPENGENI_OPPER_MODELS,
  OPPER_BASE_URL,
  OPPER_PROVIDER_ID,
  ORGANIZATION_OPPER_PROVIDER_ID,
  parseModelCatalogDocument,
  policyProviderIdForModel,
  resolveModelProviderForTurn,
  validateModelCatalogSettings,
  withOrganizationOpperCatalogProvider,
  withOrganizationOpperCredential,
  withWorkspaceOpperCatalogProvider,
  withWorkspaceOpperCredential,
  WORKSPACE_OPPER_MODEL_ID_PREFIX,
  WORKSPACE_OPPER_PROVIDER_ID,
} from "../src";

const GEMINI = "vertexai/gemini-3.8-flash-eu";
const SONNET = "aws/claude-sonnet-4-6-eu";

function base(env: Record<string, string> = {}) {
  return getSettings({ OPENGENI_ENV: "test", ...env });
}

describe("deployment Opper rail", () => {
  test("ships the reviewed EU starter routes", () => {
    expect(OPENGENI_OPPER_MODELS.map((model) => model.upstreamModelId)).toEqual([GEMINI, SONNET]);
    for (const model of OPENGENI_OPPER_MODELS) {
      expect(model.capabilities.functionCalling).toEqual({ upstream: "supported", runnable: true });
      expect(model.capabilities.transports.sse.runnable).toBe(true);
      expect(model.capabilities.inputModalities).toEqual(["text"]);
      // Opper advertises no reasoning parameter for either pinned route.
      expect(model.capabilities.reasoning.runnable).toBe(false);
      expect(model.pricing).toBeDefined();
    }
  });

  test("is absent without OPENGENI_OPPER_API_KEY", () => {
    const settings = base();
    expect(configuredProviders(settings).some((p) => p.id === OPPER_PROVIDER_ID)).toBe(false);
    expect(configuredModels(settings).some((m) => m.id.startsWith("opper/"))).toBe(false);
  });

  test("injects deployment-owned, credit-metered Chat routes with the key", () => {
    const settings = base({ OPENGENI_OPPER_API_KEY: "op-deployment" });
    const provider = configuredProviders(settings).find((p) => p.id === OPPER_PROVIDER_ID)!;
    expect(provider).toMatchObject({
      kind: "opper-managed",
      label: "Opper",
      api: "chat",
      baseUrl: OPPER_BASE_URL,
      apiKey: "op-deployment",
      credentialSource: { kind: "deployment", mechanism: "api_key" },
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    });
    const models = configuredModels(settings).filter((m) => m.providerId === OPPER_PROVIDER_ID);
    expect(models.map((m) => m.id)).toEqual([`opper/${GEMINI}`, `opper/${SONNET}`]);
    for (const model of models) {
      expect(model.cost).toBe("credits");
      expect(model.deployment.wireApi).toBe("chat");
    }
    expect(models[0]).toMatchObject({
      upstreamModelId: GEMINI,
      contextWindowTokens: 1_048_576,
      effectiveContextWindowTokens: 983_040,
      autoCompactTokenLimit: 900_000,
    });
    expect(models[1]).toMatchObject({
      upstreamModelId: SONNET,
      contextWindowTokens: 1_000_000,
      effectiveContextWindowTokens: 936_000,
      autoCompactTokenLimit: 800_000,
    });
  });

  test("debits the reviewed Opper list price plus the standard 5% margin", () => {
    const settings = base({ OPENGENI_OPPER_API_KEY: "op-deployment" });
    const schedules = configuredModelPricingSchedules(settings);
    expect(schedules[`opper/${GEMINI}`]?.default).toEqual({
      inputMicrosPerMillionTokens: 825_000,
      cachedInputMicrosPerMillionTokens: 82_500,
      outputMicrosPerMillionTokens: 4_125_000,
      marginBps: 500,
    });
    expect(schedules[`opper/${SONNET}`]?.default).toEqual({
      inputMicrosPerMillionTokens: 3_300_000,
      cachedInputMicrosPerMillionTokens: 330_000,
      cacheWriteMicrosPerMillionTokens: 4_125_000,
      outputMicrosPerMillionTokens: 16_500_000,
      marginBps: 500,
    });
    // 1M uncached input + 1M output on Sonnet: ($3.30 + $16.50) * 1.05.
    expect(
      calculateModelUsageCostMicros(settings, `opper/${SONNET}`, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      }),
    ).toBe(20_790_000);
  });

  test("validates as a managed credits catalog without extra pricing JSON", () => {
    const settings = {
      ...base({ OPENGENI_OPPER_API_KEY: "op-deployment" }),
      billingMode: "stripe" as const,
    };
    expect(() => validateModelCatalogSettings(settings, {})).not.toThrow();
  });

  test("reserves the Opper provider ids and broker kinds from host registry JSON", () => {
    for (const id of [
      OPPER_PROVIDER_ID,
      WORKSPACE_OPPER_PROVIDER_ID,
      ORGANIZATION_OPPER_PROVIDER_ID,
    ]) {
      const env = {
        OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
          {
            id,
            label: "Opper",
            api: "chat",
            baseUrl: OPPER_BASE_URL,
            apiKey: "op-inline",
            models: [{ id: "opper/x", upstreamModelId: "x" }],
          },
        ]),
      };
      expect(() => base(env)).toThrow(/reserved/u);
    }
    const kindEnv = {
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          kind: "opper-workspace",
          id: "my-opper",
          label: "Opper",
          api: "chat",
          baseUrl: OPPER_BASE_URL,
          apiKey: "op-inline",
          models: [{ id: "my-opper/x", upstreamModelId: "x" }],
        },
      ]),
    };
    expect(() => base(kindEnv)).toThrow();
  });
});

describe("workspace Opper rail", () => {
  test("is visible without the deployment key and injects only its runtime key", () => {
    const settings = base();
    const custom = "mistral/mistral-large-eu";
    const catalog = withWorkspaceOpperCatalogProvider(settings, [
      { upstreamModelId: custom, label: "Mistral Large (EU)" },
    ]);
    const provider = configuredProviders(catalog).find(
      (p) => p.id === WORKSPACE_OPPER_PROVIDER_ID,
    )!;
    expect(provider).toMatchObject({
      kind: "opper-workspace",
      label: "Your Opper",
      api: "chat",
      baseUrl: OPPER_BASE_URL,
      credentialSource: { kind: "workspace_connection", mechanism: "api_key" },
      billing: { upstreamPayer: "workspace", metering: "external" },
    });
    expect(provider.apiKey).toBeUndefined();
    expect(configuredProviders(catalog).some((p) => p.id === OPPER_PROVIDER_ID)).toBe(false);

    const models = configuredModels(catalog).filter(
      (m) => m.providerId === WORKSPACE_OPPER_PROVIDER_ID,
    );
    expect(models.map((m) => m.id)).toEqual([
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${GEMINI}`,
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${SONNET}`,
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${custom}`,
    ]);
    for (const model of models) expect(model.cost).toBe("workspace");
    const customModel = models[2]!;
    expect(customModel).toMatchObject({
      label: "Mistral Large (EU)",
      upstreamModelId: custom,
      capabilities: {
        reasoning: { upstream: "unknown", runnable: false, efforts: [] },
        functionCalling: { upstream: "supported", runnable: true },
        inputModalities: ["text"],
        promptCaching: { upstream: "unsupported", runnable: false, mode: "none" },
      },
    });
    expect(customModel.contextWindowTokens).toBeUndefined();
    expect(policyProviderIdForModel(catalog, customModel.id)).toBe(WORKSPACE_OPPER_PROVIDER_ID);

    const runtime = withWorkspaceOpperCredential(catalog, "op-workspace", [
      { upstreamModelId: custom, label: "Mistral Large (EU)" },
    ]);
    expect(
      configuredProviders(runtime).find((p) => p.id === WORKSPACE_OPPER_PROVIDER_ID)?.apiKey,
    ).toBe("op-workspace");
    expect(() => withWorkspaceOpperCredential(catalog, "  ")).toThrow(/empty/u);
  });

  test("curated membership wins over a custom row with the same upstream id", () => {
    const catalog = withWorkspaceOpperCatalogProvider(base(), [
      { upstreamModelId: GEMINI, label: "Shadow" },
    ]);
    const matches = configuredModels(catalog).filter(
      (m) => m.providerId === WORKSPACE_OPPER_PROVIDER_ID && m.upstreamModelId === GEMINI,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.label).toBe("Gemini 3.8 Flash (EU)");
    expect(configuredOpperWorkspaceProductModelIds(base())).toEqual([
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${GEMINI}`,
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${SONNET}`,
    ]);
  });

  test("an accepted workspace turn resolves its static catalog identity", () => {
    const resolved = resolveModelProviderForTurn(
      base(),
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${SONNET}`,
    );
    expect(resolved?.provider.id).toBe(WORKSPACE_OPPER_PROVIDER_ID);
    expect(resolved?.model.upstreamModelId).toBe(SONNET);
  });
});

describe("organization Opper rail", () => {
  test("exposes only explicit organization models, billed to the organization", () => {
    const settings = base();
    expect(withOrganizationOpperCatalogProvider(settings, [])).toBe(settings);
    const catalog = withOrganizationOpperCredential(
      withOrganizationOpperCatalogProvider(settings, [{ upstreamModelId: "gemini-3.8-flash" }]),
      "op-org",
      [{ upstreamModelId: "gemini-3.8-flash" }],
    );
    const provider = configuredProviders(catalog).find(
      (p) => p.id === ORGANIZATION_OPPER_PROVIDER_ID,
    )!;
    expect(provider).toMatchObject({
      kind: "opper-organization",
      apiKey: "op-org",
      credentialSource: { kind: "organization_connection", mechanism: "api_key" },
      billing: { upstreamPayer: "organization", metering: "external" },
    });
    expect(
      configuredModels(catalog)
        .filter((m) => m.providerId === ORGANIZATION_OPPER_PROVIDER_ID)
        .map((m) => [m.id, m.cost]),
    ).toEqual([["organization-opper/gemini-3.8-flash", "organization"]]);
  });
});

describe("deployment catalog document", () => {
  const document = {
    schemaVersion: 1,
    defaultModel: "gpt-6-astra",
    builtInModels: ["gpt-6-astra"],
    opperModels: OPENGENI_OPPER_MODELS.map(({ pricing: _pricing, ...model }) => model),
  };

  test("admits reviewed Opper membership and keeps price in the code snapshot", () => {
    const parsed = parseModelCatalogDocument(document);
    expect(parsed.opperModels.map((model) => model.upstreamModelId)).toEqual([GEMINI, SONNET]);
    const settings = applyModelCatalogDocument(
      base({ OPENGENI_OPPER_API_KEY: "op-deployment", OPENGENI_MODEL_CATALOG_SOURCE: "database" }),
      document,
    );
    expect(configuredOpperUpstreamModelIds(settings)).toEqual([GEMINI, SONNET]);
    expect(configuredModelPricingSchedules(settings)[`opper/${GEMINI}`]?.default.marginBps).toBe(
      500,
    );
  });

  test("rejects prices, duplicate product ids and malformed route ids", () => {
    expect(() =>
      parseModelCatalogDocument({
        ...document,
        opperModels: [{ ...document.opperModels[0]!, pricing: OPENGENI_OPPER_MODELS[0]!.pricing }],
      }),
    ).toThrow();
    expect(() =>
      parseModelCatalogDocument({
        ...document,
        opperModels: [document.opperModels[0]!, document.opperModels[0]!],
      }),
    ).toThrow(/duplicate product id/u);
    expect(() =>
      parseModelCatalogDocument({
        ...document,
        opperModels: [{ ...document.opperModels[0]!, upstreamModelId: "a b" }],
      }),
    ).toThrow();
  });

  test("an empty list removes deployment Opper membership", () => {
    const settings = applyModelCatalogDocument(
      base({ OPENGENI_OPPER_API_KEY: "op-deployment", OPENGENI_MODEL_CATALOG_SOURCE: "database" }),
      { ...document, opperModels: [] },
    );
    expect(configuredProviders(settings).some((p) => p.id === OPPER_PROVIDER_ID)).toBe(false);
  });
});

describe("Opper credentials", () => {
  test("management keys are explained and refused; runtime keys pass", () => {
    expect(opperCredentialProblem("op-mak-abc")).toMatch(/management key/u);
    expect(opperCredentialProblem("  ")).toMatch(/Enter an Opper API key/u);
    expect(opperCredentialProblem("op-runtime-abc")).toBeNull();
    expect(() => base({ OPENGENI_OPPER_API_KEY: "op-mak-abc" })).toThrow(/management key/u);
  });
});
