import { describe, expect, test } from "bun:test";
import {
  assertTurnExecutionPolicyMatchesConfigV1,
  configuredModels,
  configuredProviders,
  getSettings,
  parseAzureGatewayFailoverJson,
  resolveTurnExecutionPolicyV1,
  settingsForAcceptedAzureTurn,
} from "../src";

const env = {
  OPENGENI_ENV: "test",
  OPENGENI_OPENAI_PROVIDER: "azure",
  OPENGENI_OPENAI_MODEL: "fixture-model",
  OPENGENI_OPENAI_ALLOWED_MODELS: "fixture-model",
  OPENGENI_AZURE_OPENAI_BASE_URL: "https://primary.example/openai/v1",
  OPENGENI_AZURE_OPENAI_API_KEY: "primary-secret",
  OPENGENI_VERCEL_AI_GATEWAY_API_KEY: "gateway-secret",
};
const declaration = JSON.stringify({ azure: { "fixture-model": "openai/fixture-model" } });

describe("Azure same-model failover configuration", () => {
  test("activation preserves an accepted primary-only turn without granting fallback", () => {
    const before = getSettings(env);
    const after = getSettings({ ...env, OPENGENI_AZURE_GATEWAY_FAILOVER_JSON: declaration });
    const input = {
      modelId: "fixture-model",
      requestedModelId: null,
      modelSource: "deployment" as const,
      reasoningEffort: before.openaiReasoningEffort,
      reasoningSource: "deployment" as const,
    };
    const accepted = resolveTurnExecutionPolicyV1(before, input);
    const effective = settingsForAcceptedAzureTurn(after, accepted, input);
    expect(configuredProviders(effective)[0]?.azureGatewayFailoverModels).toBeUndefined();
    expect(configuredModels(effective)[0]?.definitionVersion).toBe(accepted.definitionVersion);
    const next = resolveTurnExecutionPolicyV1(after, input);
    expect(settingsForAcceptedAzureTurn(after, next, input)).toBe(after);
    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(
        settingsForAcceptedAzureTurn(before, next, input),
        next,
        input,
      ),
    ).toThrow();
    expect(() =>
      settingsForAcceptedAzureTurn(
        { ...after, azureOpenaiBaseUrl: "https://other-primary.example/openai/v1" },
        accepted,
        input,
      ),
    ).toThrow();
  });

  test("is disabled by default and binds explicit routes into model admission", () => {
    const disabled = getSettings(env);
    const enabled = getSettings({ ...env, OPENGENI_AZURE_GATEWAY_FAILOVER_JSON: declaration });
    expect(configuredProviders(disabled)[0]?.azureGatewayFailoverModels).toBeUndefined();
    expect(configuredProviders(enabled)[0]?.azureGatewayFailoverModels).toEqual({
      "fixture-model": "openai/fixture-model",
    });
    expect(configuredModels(enabled)[0]?.definitionVersion).not.toBe(
      configuredModels(disabled)[0]?.definitionVersion,
    );
    expect(configuredModels(enabled)[0]?.billing).toEqual(configuredModels(disabled)[0]?.billing);
  });

  test("rejects a changed model, empty mapping, invalid JSON and prototype identities", () => {
    for (const value of [
      "invalid",
      "[]",
      '{"azure":{}}',
      '{"azure":{"fixture-model":"openai/other-model"}}',
      '{"__proto__":{"fixture-model":"openai/fixture-model"}}',
    ]) {
      expect(() => parseAzureGatewayFailoverJson(value)).toThrow();
    }
  });

  test("requires the exact deployment rail, model and credential", () => {
    const cases = [
      { ...env, OPENGENI_VERCEL_AI_GATEWAY_API_KEY: undefined },
      { ...env, OPENGENI_OPENAI_PROVIDER: "openai" },
      { ...env, OPENGENI_OPENAI_ALLOWED_MODELS: "other", OPENGENI_OPENAI_MODEL: "other" },
    ];
    for (const source of cases) {
      expect(() =>
        configuredProviders(
          getSettings({ ...source, OPENGENI_AZURE_GATEWAY_FAILOVER_JSON: declaration }),
        ),
      ).toThrow();
    }
  });

  test("never enables workspace, subscription, chat or arbitrary providers", () => {
    for (const id of ["workspace-gateway", "codex-subscription", "unknown"]) {
      expect(() =>
        configuredProviders(
          getSettings({
            ...env,
            OPENGENI_AZURE_GATEWAY_FAILOVER_JSON: JSON.stringify({
              [id]: { "fixture-model": "openai/fixture-model" },
            }),
          }),
        ),
      ).toThrow();
    }
    for (const api of ["chat", "responses"]) {
      const provider = {
        id: "fixture-provider",
        kind: "api-key",
        api,
        baseUrl: "https://provider.example/v1",
        apiKey: "fixture-secret",
        models: [{ id: "fixture/product", upstreamModelId: "fixture-model" }],
      };
      expect(() =>
        configuredProviders(
          getSettings({
            ...env,
            OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([provider]),
            OPENGENI_AZURE_GATEWAY_FAILOVER_JSON: JSON.stringify({
              "fixture-provider": { "fixture-model": "openai/fixture-model" },
            }),
          }),
        ),
      ).toThrow();
    }
  });
});
