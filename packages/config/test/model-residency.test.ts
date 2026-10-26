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

  test("an EU claim on a non-EU Bedrock profile id counts as unknown", () => {
    const bedrock = {
      geography: "eu",
      deploymentType: "bedrock_geo_profile",
      regions: ["eu-central-1"],
      evidence: {
        source: "provider_documentation",
        reference: "AWS Bedrock eu. profiles",
        verifiedAt: null,
      },
    } as const;
    expect(
      isEuResidency(
        registryModelResidency(
          { kind: "api-key", residency: bedrock },
          { upstreamModelId: "us.anthropic.claude-sonnet" },
        ),
      ),
    ).toBe(false);
    expect(
      isEuResidency(
        registryModelResidency(
          { kind: "api-key", residency: bedrock },
          { upstreamModelId: "eu.anthropic.claude-sonnet" },
        ),
      ),
    ).toBe(true);
  });

  test("the database catalog must declare the same residency as the host transport", () => {
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
    // Host declares EU, the database is silent: refused, not silently unknown.
    expect(() =>
      applyModelCatalogDocument(hostSettings({ provider: euDataZone }), document({})),
    ).toThrow(/same residency/u);
    // The database declares EU on a transport the host never vouched for: refused.
    expect(() =>
      applyModelCatalogDocument(hostSettings({}), document({ model: euDataZone })),
    ).toThrow(/same residency/u);
    const agreed = applyModelCatalogDocument(
      hostSettings({ model: euDataZone }),
      document({ model: euDataZone }),
    );
    expect(
      isEuResidency(
        configuredModels(agreed).find((model) => model.id === "azure-eu/gpt-eu")?.residency,
      ),
    ).toBe(true);
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
