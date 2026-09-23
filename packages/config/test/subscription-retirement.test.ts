import { expect, test } from "bun:test";
import * as config from "../src";

function fixture() {
  const base = config.getSettings({
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_MODEL_CATALOG_SOURCE: "database",
    OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
  });
  const capabilities = config
    .configuredModels(config.withCodexCatalogProvider(base))
    .find((m) => m.id.startsWith("codex/"))!.capabilities;
  const model = { id: "codex/test-model", upstreamModelId: "test-model", capabilities };
  const document = { schemaVersion: 1, builtInModels: ["gpt-5.6-sol"], codexModels: [model] };
  const active = config.applyModelCatalogDocument(base, document);
  const request = {
    modelId: model.id,
    requestedModelId: null,
    modelSource: "session" as const,
    reasoningEffort: "low" as const,
    reasoningSource: "session" as const,
  };
  const accepted = config.resolveTurnExecutionPolicyV1(active, request);
  const retired = config.applyModelCatalogDocument(base, {
    ...document,
    codexModels: [{ ...model, retired: true }],
  });
  return { base, model, document, request, accepted, retired };
}

test("retirement excludes new selection but retains only exact accepted execution", () => {
  const { request, accepted, retired } = fixture();
  expect(config.configuredAllowedModels(config.withCodexCatalogProvider(retired))).not.toContain(
    request.modelId,
  );
  expect(() => config.resolveTurnExecutionPolicyV1(retired, request)).toThrow();
  const execution = config.settingsForAcceptedSubscriptionTurn(retired, accepted, request);
  expect(
    config.assertTurnExecutionPolicyMatchesConfigV1(execution, accepted, request).model
      .definitionVersion,
  ).toBe(accepted.definitionVersion);
  expect(config.configuredAllowedModels(execution)).not.toContain(request.modelId);
  expect(() => config.resolveTurnExecutionPolicyV1(execution, request)).toThrow();
  const restarted = config.settingsForAcceptedSubscriptionTurn(retired, accepted, request);
  expect(
    config.assertTurnExecutionPolicyMatchesConfigV1(restarted, accepted, request).model
      .definitionVersion,
  ).toBe(accepted.definitionVersion);
  const repeated = config.settingsForAcceptedSubscriptionTurn(execution, accepted, request);
  expect(
    config.configuredModels(repeated).filter((model) => model.id === request.modelId),
  ).toHaveLength(1);
  expect(() =>
    config.settingsForAcceptedSubscriptionTurn(retired, accepted, {
      ...request,
      modelId: "codex/other-model",
    }),
  ).toThrow();
});

test("retirement cannot restore changed, deleted or disabled definitions", () => {
  const { base, model, document, request, accepted, retired } = fixture();
  const changed = config.applyModelCatalogDocument(base, {
    ...document,
    codexModels: [{ ...model, retired: true, contextWindowTokens: 12345 }],
  });
  expect(() => config.settingsForAcceptedSubscriptionTurn(changed, accepted, request)).toThrow();
  expect(() =>
    config.settingsForAcceptedSubscriptionTurn(
      { ...retired, codexSubscriptionEnabled: false },
      accepted,
      request,
    ),
  ).toThrow();
  const removed = config.applyModelCatalogDocument(base, { ...document, codexModels: [] });
  expect(() => config.settingsForAcceptedSubscriptionTurn(removed, accepted, request)).toThrow();
});

test("retirement cannot be a default or grant a missing accepted policy", () => {
  const { base, document, model, retired, request } = fixture();
  expect(() =>
    config.applyModelCatalogDocument(base, {
      ...document,
      defaultModel: model.id,
      codexModels: [{ ...model, retired: true }],
    }),
  ).toThrow();
  expect(() =>
    config.settingsForAcceptedSubscriptionTurn(retired, null as never, request),
  ).toThrow();
});
