import { expect, test } from "bun:test";
import { decisionModelConfiguration, getSettings, publicDecisionModelSettings } from "../src";

const agent = {
  OPENGENI_DECISION_MODEL_PROVIDER: "openai",
  OPENGENI_DECISION_MODEL_ID: "agent-model",
  OPENGENI_DECISION_MODEL_API_KEY: "agent-test-key",
  OPENGENI_DECISION_MODEL_BASE_URL: "https://agents.example.test/v1",
};
function settings(env: NodeJS.ProcessEnv) {
  const original = process.env;
  process.env = { ...agent, ...env };
  try {
    return getSettings();
  } finally {
    process.env = original;
  }
}

test("unset public configuration preserves the exact shared settings", () => {
  const shared = settings({});
  expect(publicDecisionModelSettings(shared)).toBe(shared);
  expect(decisionModelConfiguration(shared)?.model).toBe("agent-model");
});

test.each(["jev", "openai", "openrouter"])("public %s configuration is independent", (provider) => {
  const shared = settings({
    OPENGENI_PUBLIC_DECISION_MODEL_PROVIDER: provider,
    OPENGENI_PUBLIC_DECISION_MODEL_ID: "product-model",
    OPENGENI_PUBLIC_DECISION_MODEL_API_KEY: "product-test-key",
  });
  expect(decisionModelConfiguration(publicDecisionModelSettings(shared))).toEqual({
    provider,
    model: "product-model",
    apiKey: "product-test-key",
  });
  expect(decisionModelConfiguration(shared)).toEqual({
    provider: "openai",
    model: "agent-model",
    apiKey: "agent-test-key",
    baseUrl: "https://agents.example.test/v1",
  });
});

test.each([
  { OPENGENI_PUBLIC_DECISION_MODEL_ID: "product-model" },
  { OPENGENI_PUBLIC_DECISION_MODEL_PROVIDER: "openrouter" },
  { OPENGENI_PUBLIC_DECISION_MODEL_API_KEY: "product-test-key" },
  { OPENGENI_PUBLIC_DECISION_MODEL_BASE_URL: "https://public.example.test/v1" },
  { OPENGENI_PUBLIC_DECISION_MODEL_AUTH: "api_key" },
])("partial public configuration does not borrow agent settings: %j", (env) => {
  const shared = settings(env);
  expect(decisionModelConfiguration(publicDecisionModelSettings(shared))).toBeUndefined();
  expect(decisionModelConfiguration(shared)?.model).toBe("agent-model");
});

test("public API key auth does not inherit agent deployment-identity auth", () => {
  const shared = settings({
    OPENGENI_DECISION_MODEL_AUTH: "deployment_identity",
    OPENGENI_PUBLIC_DECISION_MODEL_PROVIDER: "openrouter",
    OPENGENI_PUBLIC_DECISION_MODEL_ID: "product-model",
    OPENGENI_PUBLIC_DECISION_MODEL_API_KEY: "product-test-key",
  });
  expect(decisionModelConfiguration(publicDecisionModelSettings(shared))?.provider).toBe(
    "openrouter",
  );
  expect(shared.decisionModelAuth).toBe("deployment_identity");
});

test("public configuration reuses deployment-identity support", () => {
  const shared = settings({
    OPENGENI_PUBLIC_DECISION_MODEL_PROVIDER: "openai",
    OPENGENI_PUBLIC_DECISION_MODEL_ID: "public-deployment",
    OPENGENI_PUBLIC_DECISION_MODEL_BASE_URL: "https://public.openai.azure.test/openai/v1",
    OPENGENI_PUBLIC_DECISION_MODEL_AUTH: "deployment_identity",
    AZURE_TENANT_ID: "tenant-test",
    AZURE_CLIENT_ID: "client-test",
    AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/azure/tokens/test",
  });
  expect(decisionModelConfiguration(publicDecisionModelSettings(shared))).toMatchObject({
    provider: "openai",
    model: "public-deployment",
    azureEntra: { tenantId: "tenant-test" },
  });
  expect(shared.decisionModelAuth).toBe("api_key");
});
