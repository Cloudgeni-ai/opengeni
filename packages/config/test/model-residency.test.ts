import { describe, expect, test } from "bun:test";
import {
  isEuResidency,
  ModelResidencyV1,
  projectClientModelResidency,
  UNKNOWN_MODEL_RESIDENCY,
} from "@opengeni/contracts";
import {
  applyModelCatalogDocument,
  builtinModelResidency,
  configuredModels,
  getSettings,
  parseModelCatalogDocument,
  parseModelProvidersJson,
  modelCatalogResidencyProblems,
  registryModelResidency,
  withCodexCatalogProvider,
} from "../src";

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

const euDataZone = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: {
    source: "operator_declaration",
    reference: "Azure deployment gpt-eu on res-neu, sku DataZoneStandard",
    verifiedAt: "2026-10-26",
  },
} as const;

function registry(residency: { provider?: unknown; model?: unknown } = {}) {
  return JSON.stringify([
    {
      id: "azure-eu",
      api: "responses",
      wireProfile: "azure-openai",
      baseUrl: "https://res.openai.azure.com/openai/v1",
      apiKey: "key",
      ...(residency.provider === undefined ? {} : { residency: residency.provider }),
      models: [
        {
          id: "azure-eu/gpt-eu",
          upstreamModelId: "gpt-eu",
          ...(residency.model === undefined ? {} : { residency: residency.model }),
        },
        // The name says EU; nothing else does.
        { id: "azure-eu/claude-sonnet-4-6-eu", upstreamModelId: "claude-sonnet-4-6-eu" },
      ],
    },
  ]);
}

function models(env: NodeJS.ProcessEnv) {
  return withEnv({ OPENGENI_OPENAI_API_KEY: "sk-test", ...env }, () =>
    configuredModels(getSettings()),
  );
}

describe("model residency", () => {
  test("an undeclared operator route is unknown and never EU, whatever its name says", () => {
    const all = models({ OPENGENI_MODEL_PROVIDERS_JSON: registry() });
    const named = all.find((model) => model.id === "azure-eu/claude-sonnet-4-6-eu")!;
    expect(named.residency).toEqual(UNKNOWN_MODEL_RESIDENCY);
    expect(isEuResidency(named.residency)).toBe(false);
    expect(projectClientModelResidency(named.residency).eu).toBe(false);
  });

  test("a provider declaration applies to its models and a model declaration overrides it", () => {
    const provider = models({ OPENGENI_MODEL_PROVIDERS_JSON: registry({ provider: euDataZone }) });
    for (const model of provider.filter((entry) => entry.providerId === "azure-eu")) {
      expect(model.residency).toEqual(ModelResidencyV1.parse(euDataZone));
      expect(isEuResidency(model.residency)).toBe(true);
    }
    const overridden = models({
      OPENGENI_MODEL_PROVIDERS_JSON: registry({
        provider: euDataZone,
        model: {
          geography: "global",
          deploymentType: "azure_global",
          evidence: { source: "provider_documentation", reference: "sku GlobalStandard" },
        },
      }),
    }).find((model) => model.id === "azure-eu/gpt-eu")!;
    expect(overridden.residency.geography).toBe("global");
    expect(isEuResidency(overridden.residency)).toBe(false);
  });

  test("an EU claim needs evidence and a non-global deployment type", () => {
    expect(() =>
      parseModelProvidersJson(
        registry({ provider: { ...euDataZone, deploymentType: "azure_global" } }),
      ),
    ).toThrow(/cannot be declared eu/u);
    expect(() =>
      parseModelProvidersJson(
        registry({
          provider: { ...euDataZone, evidence: { source: "operator_declaration", reference: "" } },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseModelProvidersJson(
        registry({
          provider: { ...euDataZone, evidence: { source: "built_in_rule", reference: "x" } },
        }),
      ),
    ).toThrow();
    expect(isEuResidency({ ...euDataZone, deploymentType: "bedrock_global_profile" })).toBe(false);
    expect(
      isEuResidency({
        ...euDataZone,
        evidence: { source: "none", reference: null, verifiedAt: null },
      }),
    ).toBe(false);
    expect(isEuResidency(undefined)).toBe(false);
    expect(isEuResidency({ geography: "eu" })).toBe(false);
  });

  test("gateways, subscriptions and unknown routing can never be declared EU", () => {
    for (const deploymentType of ["gateway", "subscription", "unknown", "azure_global"]) {
      expect(() =>
        parseModelProvidersJson(registry({ provider: { ...euDataZone, deploymentType } })),
      ).toThrow(/cannot be declared eu/u);
      expect(isEuResidency({ ...euDataZone, deploymentType })).toBe(false);
    }
  });

  test("an EU claim must name EU regions for its cloud", () => {
    for (const regions of [[], ["eastus"], ["uksouth"], ["eu-west-1"]]) {
      expect(() =>
        parseModelProvidersJson(registry({ provider: { ...euDataZone, regions } })),
      ).toThrow();
    }
    expect(
      isEuResidency({
        ...euDataZone,
        deploymentType: "bedrock_geo_profile",
        regions: ["eu-west-2"],
      }),
    ).toBe(false);
    expect(
      isEuResidency({
        ...euDataZone,
        deploymentType: "bedrock_geo_profile",
        regions: ["eu-central-1", "eu-west-1"],
      }),
    ).toBe(true);
  });

  test("operator evidence is a declaration or provider documentation with a real date", () => {
    for (const evidence of [
      { ...euDataZone.evidence, source: "admin_declaration" },
      { ...euDataZone.evidence, source: "provider_api" },
      { ...euDataZone.evidence, verifiedAt: "2026-99-99T::Z" },
    ]) {
      expect(() =>
        parseModelProvidersJson(registry({ provider: { ...euDataZone, evidence } })),
      ).toThrow();
    }
  });

  test("an EU claim its route contradicts counts as unknown and is refused at load", () => {
    const bedrock = (deploymentType: "bedrock_geo_profile" | "bedrock_regional") =>
      ({
        geography: "eu",
        deploymentType,
        regions: ["eu-central-1"],
        evidence: {
          source: "provider_documentation",
          reference: "AWS Bedrock eu. profiles",
          verifiedAt: null,
        },
      }) as const;
    const eu = (
      deploymentType: "bedrock_geo_profile" | "bedrock_regional",
      upstreamModelId: string,
      baseUrl?: string,
    ) =>
      isEuResidency(
        registryModelResidency(
          { kind: "api-key", residency: bedrock(deploymentType), baseUrl },
          { upstreamModelId },
        ),
      );
    expect(eu("bedrock_geo_profile", "us.anthropic.claude-sonnet")).toBe(false);
    expect(eu("bedrock_geo_profile", "anthropic.claude-sonnet")).toBe(false);
    expect(eu("bedrock_geo_profile", "eu.anthropic.claude-sonnet")).toBe(true);
    // Any Bedrock claim, not only geo profiles.
    expect(eu("bedrock_regional", "global.anthropic.claude-sonnet-4-5")).toBe(false);
    expect(eu("bedrock_regional", "apac.anthropic.claude-sonnet")).toBe(false);
    expect(eu("bedrock_regional", "anthropic.claude-sonnet")).toBe(true);
    // A known global host cannot carry an EU claim; a distinct EU host can.
    const providerDefault = {
      ...euDataZone,
      deploymentType: "provider_default",
      regions: [],
    } as const;
    const onHost = (baseUrl: string) =>
      isEuResidency(
        registryModelResidency(
          { kind: "api-key", residency: providerDefault, baseUrl },
          { upstreamModelId: "model" },
        ),
      );
    expect(onHost("https://openrouter.ai/api/v1")).toBe(false);
    expect(onHost("https://api.openai.com/v1")).toBe(false);
    expect(onHost("https://eu.api.openai.com/v1")).toBe(true);
    // Configuration with such a claim is refused when it is loaded.
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            id: "router",
            api: "chat",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "key",
            residency: providerDefault,
            models: [{ id: "router/model", upstreamModelId: "model" }],
          },
        ]),
      ),
    ).toThrow(/routes outside the EU/u);
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            id: "bedrock",
            api: "anthropic-messages",
            baseUrl: "https://bedrock-proxy.example.eu/v1",
            apiKey: "key",
            residency: bedrock("bedrock_regional"),
            models: [{ id: "bedrock/sonnet", upstreamModelId: "global.anthropic.claude-sonnet" }],
          },
        ]),
      ),
    ).toThrow(/inference profile/u);
  });

  test("the host transport supplies residency; a different database claim makes it unknown", () => {
    const hostSettings = (residency: { provider?: unknown; model?: unknown }) =>
      withEnv(
        { OPENGENI_OPENAI_API_KEY: "sk-test", OPENGENI_MODEL_PROVIDERS_JSON: registry(residency) },
        () => getSettings(),
      );
    const document = (residency: { provider?: unknown; model?: unknown }) => ({
      schemaVersion: 1,
      defaultModel: "azure-eu/gpt-eu",
      builtInModels: [],
      registryProviders: JSON.parse(registry(residency)).map(
        ({ apiKey: _apiKey, ...provider }: Record<string, unknown>) => provider,
      ),
    });
    const gptEu = (settings: ReturnType<typeof getSettings>) =>
      configuredModels(settings).find((model) => model.id === "azure-eu/gpt-eu")?.residency;
    const quietly = <T>(fn: () => T): T => {
      const warn = console.warn;
      console.warn = () => {};
      try {
        return fn();
      } finally {
        console.warn = warn;
      }
    };
    // Host declares EU, the database is silent: unknown, and the catalog still loads.
    const hostOnly = quietly(() =>
      applyModelCatalogDocument(hostSettings({ provider: euDataZone }), document({})),
    );
    expect(gptEu(hostOnly)).toEqual(UNKNOWN_MODEL_RESIDENCY);
    // The database declares EU on a transport the host never vouched for: unknown.
    const databaseOnly = quietly(() =>
      applyModelCatalogDocument(hostSettings({}), document({ model: euDataZone })),
    );
    expect(gptEu(databaseOnly)).toEqual(UNKNOWN_MODEL_RESIDENCY);
    // The same claim agrees; re-verified evidence and reordered regions are the same claim.
    const agreed = applyModelCatalogDocument(
      hostSettings({ model: { ...euDataZone, regions: ["swedencentral", "germanywestcentral"] } }),
      document({
        model: {
          ...euDataZone,
          regions: ["germanywestcentral", "swedencentral", "swedencentral"],
          evidence: { ...euDataZone.evidence, reference: "older text", verifiedAt: "2026-01-01" },
        },
      }),
    );
    expect(isEuResidency(gptEu(agreed))).toBe(true);
    // Evidence comes from the host.
    expect(gptEu(agreed)?.evidence.reference).toBe(euDataZone.evidence.reference);
    // Claims compare per model: a provider-level host claim matches a database
    // claim only where the database makes it too. Here the sibling model has
    // none in the database, so the whole provider is unknown.
    const levels = quietly(() =>
      applyModelCatalogDocument(
        hostSettings({ provider: euDataZone }),
        document({ model: euDataZone }),
      ),
    );
    expect(gptEu(levels)).toEqual(UNKNOWN_MODEL_RESIDENCY);
    const providerLevels = applyModelCatalogDocument(
      hostSettings({ provider: euDataZone }),
      document({ provider: euDataZone }),
    );
    expect(isEuResidency(gptEu(providerLevels))).toBe(true);
  });

  test("a built-in declaration for a model that is not configured warns at startup", () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      withEnv(
        {
          OPENGENI_OPENAI_PROVIDER: "azure",
          OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
          OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
          OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON: JSON.stringify({ "gpt-typo": euDataZone }),
        },
        () => getSettings(),
      );
    } finally {
      console.warn = warn;
    }
    expect(warnings.some((message) => message.includes("gpt-typo"))).toBe(true);
  });

  test("a built-in EU claim on a global host is unknown and refused at startup", () => {
    const providerDefault = { ...euDataZone, deploymentType: "provider_default", regions: [] };
    const env = (extra: NodeJS.ProcessEnv) => ({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_OPENAI_MODEL: "gpt-5",
      OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON: JSON.stringify({ "gpt-5": providerDefault }),
      ...extra,
    });
    for (const extra of [{}, { OPENGENI_OPENAI_BASE_URL: "https://api.openai.com/v1" }]) {
      expect(() => withEnv(env(extra), () => getSettings())).toThrow(/routes outside the EU/u);
      // The resolver applies the same check to settings that skipped validation.
      const settings = withEnv(
        { OPENGENI_OPENAI_API_KEY: "sk-test", OPENGENI_OPENAI_MODEL: "gpt-5", ...extra },
        () => getSettings(),
      );
      expect(
        isEuResidency(
          builtinModelResidency(
            {
              ...settings,
              builtinModelResidencyJson: JSON.stringify({ "gpt-5": providerDefault }),
            },
            "gpt-5",
          ),
        ),
      ).toBe(false);
    }
    // A distinct EU endpoint is not a global host.
    const eu = withEnv(env({ OPENGENI_OPENAI_BASE_URL: "https://eu.api.openai.com/v1" }), () =>
      getSettings(),
    );
    expect(isEuResidency(builtinModelResidency(eu, "gpt-5"))).toBe(true);
  });

  test("name checks ignore case and a trailing dot", () => {
    const providerDefault = {
      ...euDataZone,
      deploymentType: "provider_default",
      regions: [],
    } as const;
    expect(
      isEuResidency(
        registryModelResidency(
          { kind: "api-key", residency: providerDefault, baseUrl: "https://openrouter.ai./api/v1" },
          { upstreamModelId: "model" },
        ),
      ),
    ).toBe(false);
    expect(
      isEuResidency(
        registryModelResidency(
          {
            kind: "api-key",
            residency: {
              ...euDataZone,
              deploymentType: "bedrock_regional",
              regions: ["eu-central-1"],
            },
          },
          { upstreamModelId: "US.anthropic.claude-sonnet" },
        ),
      ),
    ).toBe(false);
  });

  test("a stored catalog with a contradicted claim loads as unknown; the upsert refuses it", () => {
    const providerDefault = { ...euDataZone, deploymentType: "provider_default", regions: [] };
    const document = {
      schemaVersion: 1,
      defaultModel: "router/model",
      builtInModels: [],
      registryProviders: [
        {
          id: "router",
          kind: "anonymous",
          api: "chat",
          baseUrl: "https://openrouter.ai/api/v1",
          residency: providerDefault,
          models: [{ id: "router/model", upstreamModelId: "model" }],
        },
      ],
    };
    const host = withEnv({ OPENGENI_OPENAI_API_KEY: "sk-test" }, () => getSettings());
    expect(() => parseModelCatalogDocument(document)).not.toThrow();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      const applied = applyModelCatalogDocument(host, document);
      applyModelCatalogDocument(host, document);
      expect(
        configuredModels(applied).find((model) => model.id === "router/model")?.residency,
      ).toEqual(UNKNOWN_MODEL_RESIDENCY);
    } finally {
      console.warn = warn;
    }
    // Warned once, not on every resolve.
    expect(warnings.filter((message) => message.includes("router")).length).toBe(1);
    expect(modelCatalogResidencyProblems(host, document).join(" ")).toMatch(
      /routes outside the EU/u,
    );
  });

  test("non-operator provider kinds cannot declare their own residency", () => {
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            kind: "direct-azure-organization",
            id: "org-azure",
            api: "responses",
            baseUrl: "https://customer.openai.azure.com/openai/v1",
            apiKey: "key",
            residency: euDataZone,
            models: [{ id: "org-azure/gpt" }],
          },
        ]),
      ),
    ).toThrow(/built-in residency rule/u);
  });

  test("built-in rules keep subscriptions, gateways and customer connections out of the EU", () => {
    for (const kind of [
      "codex-subscription",
      "xai-subscription",
      "claude-subscription-organization",
      "anthropic-workspace",
      "vercel-gateway-managed",
      "openrouter-managed",
      "opper-managed",
      "direct-openai-organization",
      "direct-azure-organization",
    ] as const) {
      const residency = registryModelResidency({ kind });
      expect(ModelResidencyV1.safeParse(residency).success).toBe(true);
      expect(residency.evidence.source).toBe("built_in_rule");
      expect(residency.evidence.reference).toBeTruthy();
      expect(isEuResidency(residency)).toBe(false);
    }
    const codex = withEnv(
      { OPENGENI_OPENAI_API_KEY: "sk-test", OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true" },
      () => configuredModels(withCodexCatalogProvider(getSettings())),
    ).filter((model) => model.id.startsWith("codex/"));
    expect(codex.length).toBeGreaterThan(0);
    for (const model of codex) {
      expect(model.residency.geography).toBe("us");
      expect(isEuResidency(model.residency)).toBe(false);
    }
  });

  test("the built-in Azure provider is unknown until the operator declares it", () => {
    const azureEnv = {
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
      OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
    };
    const undeclared = withEnv(azureEnv, () => getSettings());
    expect(isEuResidency(builtinModelResidency(undeclared, undeclared.openaiModel))).toBe(false);
    // Each built-in model is its own deployment: declaring one leaves the rest unknown.
    const declared = withEnv(
      {
        ...azureEnv,
        OPENGENI_OPENAI_MODEL: "gpt-eu",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-eu,gpt-global",
        OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON: JSON.stringify({ "gpt-eu": euDataZone }),
      },
      () => getSettings(),
    );
    expect(isEuResidency(builtinModelResidency(declared, "gpt-eu"))).toBe(true);
    expect(isEuResidency(builtinModelResidency(declared, "gpt-global"))).toBe(false);
    const byId = new Map(configuredModels(declared).map((model) => [model.id, model]));
    expect(isEuResidency(byId.get("gpt-eu")?.residency)).toBe(true);
    expect(isEuResidency(byId.get("gpt-global")?.residency)).toBe(false);
    expect(() =>
      withEnv(
        {
          ...azureEnv,
          OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON: JSON.stringify({
            "gpt-eu": { ...euDataZone, deploymentType: "azure_global" },
          }),
        },
        () => getSettings(),
      ),
    ).toThrow(/OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON is invalid/u);
  });

  test("a declaration is part of the definition version, an absent one changes nothing", () => {
    const undeclared = models({ OPENGENI_MODEL_PROVIDERS_JSON: registry() }).find(
      (model) => model.id === "azure-eu/gpt-eu",
    )!;
    const declared = models({
      OPENGENI_MODEL_PROVIDERS_JSON: registry({ model: euDataZone }),
    }).find((model) => model.id === "azure-eu/gpt-eu")!;
    const otherRegion = models({
      OPENGENI_MODEL_PROVIDERS_JSON: registry({
        model: { ...euDataZone, regions: ["germanywestcentral"] },
      }),
    }).find((model) => model.id === "azure-eu/gpt-eu")!;
    const reverified = models({
      OPENGENI_MODEL_PROVIDERS_JSON: registry({
        model: {
          ...euDataZone,
          regions: ["swedencentral", "germanywestcentral", "swedencentral"],
          evidence: { ...euDataZone.evidence, verifiedAt: "2026-11-30" },
        },
      }),
    }).find((model) => model.id === "azure-eu/gpt-eu")!;
    const reordered = models({
      OPENGENI_MODEL_PROVIDERS_JSON: registry({
        model: { ...euDataZone, regions: ["germanywestcentral", "swedencentral"] },
      }),
    }).find((model) => model.id === "azure-eu/gpt-eu")!;
    expect(declared.definitionVersion).not.toBe(undeclared.definitionVersion);
    expect(otherRegion.definitionVersion).not.toBe(declared.definitionVersion);
    // Re-verifying evidence, reordering or repeating regions keeps the digest.
    expect(reverified.residency.regions).toEqual(["germanywestcentral", "swedencentral"]);
    expect(reverified.definitionVersion).toBe(reordered.definitionVersion);
    // The sibling model without a declaration keeps its digest.
    const siblingBefore = models({ OPENGENI_MODEL_PROVIDERS_JSON: registry() }).find(
      (model) => model.id === "azure-eu/claude-sonnet-4-6-eu",
    )!;
    const siblingAfter = models({
      OPENGENI_MODEL_PROVIDERS_JSON: registry({ model: euDataZone }),
    }).find((model) => model.id === "azure-eu/claude-sonnet-4-6-eu")!;
    expect(siblingAfter.definitionVersion).toBe(siblingBefore.definitionVersion);
  });

  test("the deployment catalog accepts residency on registry providers and models", () => {
    const document = parseModelCatalogDocument({
      schemaVersion: 1,
      defaultModel: "azure-eu/gpt-eu",
      builtInModels: [],
      registryProviders: [
        {
          id: "azure-eu",
          api: "responses",
          baseUrl: "https://res.openai.azure.com/openai/v1",
          residency: euDataZone,
          models: [{ id: "azure-eu/gpt-eu", upstreamModelId: "gpt-eu", residency: euDataZone }],
        },
      ],
    });
    expect(document.registryProviders[0]?.residency?.geography).toBe("eu");
  });

  test("the client projection carries the verdict but not the evidence text", () => {
    const projected = projectClientModelResidency(ModelResidencyV1.parse(euDataZone));
    expect(projected).toEqual({
      geography: "eu",
      deploymentType: "azure_data_zone",
      regions: ["swedencentral"],
      evidenceSource: "operator_declaration",
      eu: true,
    });
    expect(JSON.stringify(projected)).not.toContain("res-neu");
  });
});
