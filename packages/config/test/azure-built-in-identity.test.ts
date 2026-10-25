import { expect, test } from "bun:test";
import { configuredModels, configuredProviders, getSettings } from "../src";

const base = {
  OPENGENI_ENV: "test",
  OPENGENI_OPENAI_PROVIDER: "azure",
  OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1",
  OPENGENI_OPENAI_MODEL: "reasoning-deployment",
  OPENGENI_OPENAI_ALLOWED_MODELS: "reasoning-deployment,small-deployment",
  OPENGENI_OPENAI_REASONING_EFFORT: "high",
  OPENGENI_OPENAI_ALLOWED_REASONING_EFFORTS: "low,medium,high",
};
const workload = {
  OPENGENI_AZURE_OPENAI_AUTH_MODE: "workload_identity",
  AZURE_TENANT_ID: "tenant",
  AZURE_CLIENT_ID: "client",
  AZURE_FEDERATED_TOKEN_FILE: "/projected/token",
};

test.each([workload, { OPENGENI_AZURE_OPENAI_AUTH_MODE: "managed_identity" }])(
  "identity authentication keeps built-in models and reasoning without a key: %j",
  (identity) => {
    const settings = getSettings({ ...base, ...identity });
    const provider = configuredProviders(settings)[0]!;
    expect(provider.apiKey).toBeUndefined();
    expect(provider.credentialSource).toEqual({ kind: "deployment", mechanism: "azure_ad_bearer" });
    expect(settings.azureOpenaiDeploymentIdentityEnabled).toBe(false);
    const models = configuredModels(settings).filter((model) => model.providerId === provider.id);
    expect(models.map((model) => model.id)).toEqual(["reasoning-deployment", "small-deployment"]);
    for (const model of models) {
      expect(model.capabilities.reasoning.runnable).toBe(true);
      expect(model.capabilities.reasoning.defaultEffort).toBe("high");
      expect(model.capabilities.reasoning.efforts).toEqual(["low", "medium", "high"]);
    }
  },
);

test.each(["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_FEDERATED_TOKEN_FILE"])(
  "workload identity rejects missing %s at startup",
  (missing) => {
    expect(() => getSettings({ ...base, ...workload, [missing]: undefined })).toThrow(
      /workload_identity needs/u,
    );
  },
);

test.each(["workload_identity", "managed_identity"])(
  "%s rejects ambiguous static credentials",
  (mode) => {
    for (const key of ["OPENGENI_AZURE_OPENAI_API_KEY", "OPENGENI_AZURE_OPENAI_AD_TOKEN"]) {
      expect(() =>
        getSettings({
          ...base,
          ...workload,
          OPENGENI_AZURE_OPENAI_AUTH_MODE: mode,
          [key]: "fixture",
        }),
      ).toThrow(/cannot be combined/u);
    }
  },
);

test("static authentication remains the default, and identity mode is explicit", () => {
  expect(() => getSettings(base)).toThrow(/API key or AD token/u);
  expect(getSettings({ ...base, OPENGENI_AZURE_OPENAI_API_KEY: "key" }).azureOpenaiAuthMode).toBe(
    "static",
  );
  expect(
    getSettings({ ...base, OPENGENI_AZURE_OPENAI_AD_TOKEN: "token" }).azureOpenaiAuthMode,
  ).toBe("static");
  expect(() => getSettings({ ...base, OPENGENI_AZURE_OPENAI_AUTH_MODE: "auto" })).toThrow();
});

test("identity mode preserves endpoint/deployment configuration validation", () => {
  expect(() =>
    getSettings({ ...base, ...workload, OPENGENI_AZURE_OPENAI_BASE_URL: undefined }),
  ).toThrow(/BASE_URL/u);
  expect(() =>
    getSettings({
      ...base,
      ...workload,
      OPENGENI_AZURE_OPENAI_BASE_URL: undefined,
      OPENGENI_AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
    }),
  ).toThrow(/DEPLOYMENT/u);
});
