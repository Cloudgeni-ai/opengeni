import { expect, test } from "bun:test";
import * as config from "../src";

const registryProviders = [
  {
    id: "local-provider",
    kind: "anonymous",
    baseUrl: "https://provider.example.test/v1",
    models: [{ id: "local/model", upstreamModelId: "model" }],
  },
];

function fixture(mixed: boolean) {
  const base = config.getSettings({
    OPENGENI_MODEL_CATALOG_SOURCE: "code",
    OPENGENI_MODEL_COST_POLICY_JSON: "{}",
    OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
    OPENGENI_OPENAI_MODEL: "codex/gpt-6-sol",
    OPENGENI_OPENAI_ALLOWED_MODELS: "codex/gpt-6-sol",
    OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify(mixed ? registryProviders : []),
  });
  const models = config.configuredModels(config.withCodexCatalogProvider(base));
  const codexModels = models
    .filter((m) => m.id.startsWith("codex/"))
    .map((m) => ({
      id: m.id,
      upstreamModelId: m.upstreamModelId,
      capabilities: m.capabilities,
      contextWindowTokens: m.contextWindowTokens,
      effectiveContextWindowTokens: m.effectiveContextWindowTokens,
      autoCompactTokenLimit: m.autoCompactTokenLimit,
      toolOutputTruncationTokens: m.toolOutputTruncationTokens,
    }));
  const document = {
    schemaVersion: 1,
    builtInModels: [],
    defaultModel: base.openaiModel,
    codexModels,
    registryProviders: mixed ? registryProviders : [],
  };
  return { base, models, document };
}

for (const mixed of [false, true]) {
  test(`provider-only catalog preserves execution hashes (mixed=${mixed})`, () => {
    const { base, models, document } = fixture(mixed);
    const applied = config.applyModelCatalogDocument(
      { ...base, modelCatalogSource: "database" },
      JSON.parse(JSON.stringify(document)),
    );
    expect(() => config.validateModelCatalogSettings(applied)).not.toThrow();
    const after = config.configuredModels(config.withCodexCatalogProvider(applied));
    expect(after.map((m) => [m.id, m.definitionVersion])).toEqual(
      models.map((m) => [m.id, m.definitionVersion]),
    );
    expect(after.some((m) => m.providerId === "openai")).toBe(false);
    const old = document.codexModels.find((m) => m.id === document.defaultModel)!;
    const next = { ...old, id: "codex/next-model", upstreamModelId: "next-model" };
    const retired = config.applyModelCatalogDocument(base, {
      ...document,
      defaultModel: next.id,
      codexModels: [{ ...old, retired: true }, next],
    });
    const request = {
      modelId: old.id,
      requestedModelId: null,
      modelSource: "session" as const,
      reasoningEffort: "low" as const,
      reasoningSource: "session" as const,
    };
    const accepted = config.resolveTurnExecutionPolicyV1(applied, request);
    expect(() => config.resolveTurnExecutionPolicyV1(retired, request)).toThrow();
    expect(
      config.resolveTurnExecutionPolicyV1(retired, { ...request, modelId: next.id }).productModelId,
    ).toBe(next.id);
    const restored = config.settingsForAcceptedSubscriptionTurn(retired, accepted, request);
    expect(() =>
      config.assertTurnExecutionPolicyMatchesConfigV1(restored, accepted, request),
    ).not.toThrow();
  });
}

test("provider-only catalogs require an explicit valid active default", () => {
  const { base, document } = fixture(false);
  for (const invalid of [
    { schemaVersion: 1, builtInModels: [] },
    { ...document, defaultModel: undefined },
    { ...document, defaultModel: "unknown/model" },
    { ...document, codexModels: [] },
    { ...document, codexModels: document.codexModels.map((m) => ({ ...m, retired: true })) },
  ])
    expect(() => config.parseModelCatalogDocument(invalid)).toThrow();
  expect(() =>
    config.validateModelCatalogSettings(
      config.applyModelCatalogDocument({ ...base, codexSubscriptionEnabled: false }, document),
    ),
  ).toThrow();
  const anonymous = config.applyModelCatalogDocument(base, {
    schemaVersion: 1,
    builtInModels: [],
    defaultModel: "local/model",
    registryProviders,
    codexModels: [],
  });
  expect(() => config.validateModelCatalogSettings(anonymous)).not.toThrow();
});
