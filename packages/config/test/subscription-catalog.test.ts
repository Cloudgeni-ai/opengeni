import { expect, test } from "bun:test";
import {
  applyModelCatalogDocument,
  configuredModels,
  getSettings,
  parseModelCatalogDocument,
  resolveTurnExecutionPolicyV1,
  validateModelCatalogSettings,
  withCodexCatalogProvider,
} from "../src";

function fixture() {
  const base = getSettings({
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_MODEL_CATALOG_SOURCE: "database",
    OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
  });
  const capabilities = configuredModels(withCodexCatalogProvider(base)).find((m) =>
    m.id.startsWith("codex/"),
  )!.capabilities;
  const model = {
    id: "codex/test-model",
    upstreamModelId: "test-model",
    label: "Test model",
    capabilities,
    contextWindowTokens: 100_000,
  };
  return {
    base,
    model,
    document: {
      schemaVersion: 1,
      builtInModels: ["gpt-5.6-sol"],
      codexModels: [model],
      defaultModel: model.id,
    },
  };
}

test("database subscription membership replaces fallback and propagates explicit capabilities", () => {
  const { base, document } = fixture();
  const models = configuredModels(
    withCodexCatalogProvider(applyModelCatalogDocument(base, document)),
  );
  expect(models.filter((m) => m.id.startsWith("codex/")).map((m) => m.id)).toEqual([
    "codex/test-model",
  ]);
  expect(models.find((m) => m.id === "codex/test-model")).toMatchObject({
    label: "Test model",
    contextWindowTokens: 100_000,
  });
});

test("new turn policy uses updated membership and cannot admit a removed model", () => {
  const { base, document } = fixture();
  const first = applyModelCatalogDocument(base, {
    ...document,
    modelNotes: { "codex/test-model": "Synthetic test" },
  });
  expect(() => validateModelCatalogSettings(first)).not.toThrow();
  const request = {
    modelId: "codex/test-model",
    requestedModelId: null,
    modelSource: "session" as const,
    reasoningEffort: "low" as const,
    reasoningSource: "session" as const,
  };
  const accepted = resolveTurnExecutionPolicyV1(first, request);
  expect(accepted).toMatchObject({
    productModelId: "codex/test-model",
    providerId: "codex-subscription",
  });
  const next = applyModelCatalogDocument(withCodexCatalogProvider(first), {
    schemaVersion: 1,
    builtInModels: ["gpt-5.6-sol"],
    codexModels: [],
  });
  expect(() => resolveTurnExecutionPolicyV1(next, request)).toThrow();
  expect(accepted.productModelId).toBe("codex/test-model");
  expect(() =>
    resolveTurnExecutionPolicyV1({ ...first, codexSubscriptionEnabled: false }, request),
  ).toThrow();
});

test("explicit empty subscription membership removes defaults; omission preserves them", () => {
  const { base } = fixture();
  const document = { schemaVersion: 1, builtInModels: ["gpt-5.6-sol"] };
  expect(
    configuredModels(
      withCodexCatalogProvider(applyModelCatalogDocument(base, { ...document, codexModels: [] })),
    ).some((m) => m.id.startsWith("codex/")),
  ).toBe(false);
  expect(
    configuredModels(withCodexCatalogProvider(applyModelCatalogDocument(base, document))).some(
      (m) => m.id.startsWith("codex/"),
    ),
  ).toBe(true);
});

test("subscription document rejects forged identity, credentials and excluded default", () => {
  const { document, model } = fixture();
  for (const invalid of [
    { ...model, id: "other/test-model" },
    { ...model, apiKey: "secret" },
    { ...model, baseUrl: "https://example.com" },
  ]) {
    expect(() => parseModelCatalogDocument({ ...document, codexModels: [invalid] })).toThrow();
  }
  expect(() => parseModelCatalogDocument({ ...document, codexModels: [] })).toThrow();
});
