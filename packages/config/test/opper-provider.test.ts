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
  opperMaxOutputTokens,
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

const OPUS = "aws/claude-opus-5-5";
const GEMINI = "vertexai/gemini-3.8-flash-eu";

function base(env: Record<string, string> = {}) {
  return getSettings({ OPENGENI_ENV: "test", ...env });
}

describe("deployment Opper rail", () => {
  test("ships Claude Opus 5.5 (EU) with reasoning, image input and a 128K output cap", () => {
    expect(OPENGENI_OPPER_MODELS.map((model) => model.upstreamModelId)).toEqual([OPUS]);
    const [opus] = OPENGENI_OPPER_MODELS;
    expect(opus).toMatchObject({
      label: "Claude Opus 5.5 (EU)",
      shortLabel: "Opus 5.5",
      contextWindowTokens: 1_000_000,
      effectiveContextWindowTokens: 872_000,
      autoCompactTokenLimit: 800_000,
      maxOutputTokens: 128_000,
    });
    expect(opus!.capabilities.functionCalling).toEqual({ upstream: "supported", runnable: true });
    expect(opus!.capabilities.transports.sse.runnable).toBe(true);
    expect(opus!.capabilities.inputModalities).toEqual(["text", "image"]);
    expect(opus!.capabilities.inputFileMediaTypes).toEqual(["application/pdf"]);
    expect(opus!.capabilities.reasoning).toMatchObject({
      upstream: "supported",
      runnable: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    });
    expect(opus!.pricing).toBeDefined();
  });

  test("sends the configured output cap, a Claude-family floor, or nothing", () => {
    const settings = base();
    expect(opperMaxOutputTokens(settings, OPUS)).toBe(128_000);
    expect(opperMaxOutputTokens(settings, "anthropic/claude-sonnet-4-6")).toBe(64_000);
    expect(opperMaxOutputTokens(settings, "eu.anthropic.claude-haiku-4-5")).toBe(64_000);
    expect(opperMaxOutputTokens(settings, GEMINI)).toBeUndefined();
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
    expect(models.map((m) => m.id)).toEqual([`opper/${OPUS}`]);
    for (const model of models) {
      expect(model.cost).toBe("credits");
      expect(model.deployment.wireApi).toBe("chat");
    }
    expect(models[0]).toMatchObject({
      upstreamModelId: OPUS,
      contextWindowTokens: 1_000_000,
      effectiveContextWindowTokens: 872_000,
      autoCompactTokenLimit: 800_000,
    });
  });

  test("debits the reviewed Opper list price plus the standard 5% margin", () => {
    const settings = base({ OPENGENI_OPPER_API_KEY: "op-deployment" });
    const schedules = configuredModelPricingSchedules(settings);
    expect(schedules[`opper/${OPUS}`]?.default).toEqual({
      inputMicrosPerMillionTokens: 4_400_000,
      cachedInputMicrosPerMillionTokens: 220_000,
      cacheWriteMicrosPerMillionTokens: 5_500_000,
      outputMicrosPerMillionTokens: 22_000_000,
      marginBps: 500,
    });
    // 1M uncached input + 1M output on Opus: ($4.40 + $22.00) * 1.05.
    expect(
      calculateModelUsageCostMicros(settings, `opper/${OPUS}`, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      }),
    ).toBe(27_720_000);
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
    const claude = "anthropic/claude-sonnet-4-6";
    const catalog = withWorkspaceOpperCatalogProvider(settings, [
      { upstreamModelId: custom, label: "Mistral Large (EU)" },
      { upstreamModelId: claude },
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
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${OPUS}`,
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${custom}`,
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${claude}`,
    ]);
    for (const model of models) expect(model.cost).toBe("workspace");
    expect(models[0]!.capabilities.reasoning.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    const customModel = models[1]!;
    // Custom ids get runnable reasoning (Opper ignores an effort a route does
    // not support) and stay text-only outside the Claude/Gemini families.
    expect(customModel).toMatchObject({
      label: "Mistral Large (EU)",
      upstreamModelId: custom,
      capabilities: {
        reasoning: {
          upstream: "unknown",
          runnable: true,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
        functionCalling: { upstream: "supported", runnable: true },
        inputModalities: ["text"],
        inputFileMediaTypes: [],
      },
    });
    expect(models[2]!.capabilities.inputModalities).toEqual(["text", "image"]);
    expect(models[2]!.capabilities.reasoning.runnable).toBe(true);
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
      { upstreamModelId: OPUS, label: "Shadow" },
    ]);
    const matches = configuredModels(catalog).filter(
      (m) => m.providerId === WORKSPACE_OPPER_PROVIDER_ID && m.upstreamModelId === OPUS,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.label).toBe("Claude Opus 5.5 (EU)");
    expect(configuredOpperWorkspaceProductModelIds(base())).toEqual([
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${OPUS}`,
    ]);
  });

  test("an accepted workspace turn resolves its static catalog identity", () => {
    const resolved = resolveModelProviderForTurn(
      base(),
      `${WORKSPACE_OPPER_MODEL_ID_PREFIX}${OPUS}`,
    );
    expect(resolved?.provider.id).toBe(WORKSPACE_OPPER_PROVIDER_ID);
    expect(resolved?.model.upstreamModelId).toBe(OPUS);
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

  test("an organization custom id naming a configured route inherits its definition", () => {
    const catalog = withOrganizationOpperCatalogProvider(base(), [{ upstreamModelId: OPUS }]);
    const model = configuredModels(catalog).find(
      (m) => m.providerId === ORGANIZATION_OPPER_PROVIDER_ID,
    )!;
    expect(model).toMatchObject({
      id: `organization-opper/${OPUS}`,
      label: "Claude Opus 5.5 (EU)",
      contextWindowTokens: 1_000_000,
      effectiveContextWindowTokens: 872_000,
      autoCompactTokenLimit: 800_000,
    });
    expect(model.capabilities).toEqual(OPENGENI_OPPER_MODELS[0]!.capabilities);
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
    expect(parsed.opperModels.map((model) => model.upstreamModelId)).toEqual([OPUS]);
    const settings = applyModelCatalogDocument(
      base({ OPENGENI_OPPER_API_KEY: "op-deployment", OPENGENI_MODEL_CATALOG_SOURCE: "database" }),
      document,
    );
    expect(configuredOpperUpstreamModelIds(settings)).toEqual([OPUS]);
    expect(configuredModelPricingSchedules(settings)[`opper/${OPUS}`]?.default.marginBps).toBe(
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
