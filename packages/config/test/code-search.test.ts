import { describe, expect, test } from "bun:test";
import {
  codeSearchDeploymentPolicy,
  decisionModelConfiguration,
  getSettings,
  usableJevApiKey,
} from "../src";

describe("Jev and code_search settings", () => {
  test("default to off with the native Jev endpoint", () => {
    const settings = withEnv({}, getSettings);
    expect(settings.codeSearchMode).toBe("off");
    expect(settings.jevApiKey).toBeUndefined();
    expect(settings.jevBaseUrl).toBe("https://api.typesafe.ai");
    expect(settings.jevModel).toBe("jev-latest");
    expect(settings.jevRequestTimeoutMs).toBe(10_000);
    expect(codeSearchDeploymentPolicy(settings)).toEqual({
      available: false,
      workspaceDefault: "off",
    });
  });

  test("a mode without a usable key offers nothing", () => {
    const missing = withEnv({ OPENGENI_CODE_SEARCH_MODE: "default_on" }, getSettings);
    expect(codeSearchDeploymentPolicy(missing).available).toBe(false);
    const placeholder = withEnv(
      { OPENGENI_CODE_SEARCH_MODE: "default_on", OPENGENI_JEV_API_KEY: "your-key" },
      getSettings,
    );
    expect(usableJevApiKey(placeholder)).toBeUndefined();
    expect(codeSearchDeploymentPolicy(placeholder).available).toBe(false);
  });

  test("opt_in offers the tool without enabling it by default", () => {
    const settings = withEnv(
      { OPENGENI_CODE_SEARCH_MODE: "opt_in", OPENGENI_JEV_API_KEY: "jev_live_example_1234567890" },
      getSettings,
    );
    expect(codeSearchDeploymentPolicy(settings)).toEqual({
      available: true,
      workspaceDefault: "off",
    });
  });

  test("default_on and experiment set the default for workspaces without a setting", () => {
    const key = { OPENGENI_JEV_API_KEY: "jev_live_example_1234567890" };
    const on = withEnv({ ...key, OPENGENI_CODE_SEARCH_MODE: "default_on" }, getSettings);
    expect(codeSearchDeploymentPolicy(on)).toEqual({ available: true, workspaceDefault: "on" });
    const experiment = withEnv({ ...key, OPENGENI_CODE_SEARCH_MODE: "experiment" }, getSettings);
    expect(codeSearchDeploymentPolicy(experiment)).toEqual({
      available: true,
      workspaceDefault: "split",
    });
  });

  test("rejects an unknown mode", () => {
    expect(() => withEnv({ OPENGENI_CODE_SEARCH_MODE: "sometimes" }, getSettings)).toThrow();
  });

  test.each(["jev", "openai", "openrouter"])(
    "shared %s configuration serves both consumers",
    (provider) => {
      const settings = withEnv(
        {
          OPENGENI_CODE_SEARCH_MODE: "opt_in",
          OPENGENI_DECISION_MODEL_PROVIDER: provider,
          OPENGENI_DECISION_MODEL_ID: "configured-model",
          OPENGENI_DECISION_MODEL_API_KEY: "configured-test-key",
          OPENGENI_DECISION_MODEL_BASE_URL: "https://decisions.test/v1",
        },
        getSettings,
      );
      expect(decisionModelConfiguration(settings)).toEqual({
        provider,
        model: "configured-model",
        apiKey: "configured-test-key",
        baseUrl: "https://decisions.test/v1",
      });
      expect(codeSearchDeploymentPolicy(settings)).toEqual({
        available: true,
        workspaceDefault: "off",
      });
    },
  );

  test("partial shared configuration never borrows the legacy credential", () => {
    const settings = withEnv(
      {
        OPENGENI_CODE_SEARCH_MODE: "default_on",
        OPENGENI_JEV_API_KEY: "legacy-test-key",
        OPENGENI_DECISION_MODEL_PROVIDER: "openrouter",
        OPENGENI_DECISION_MODEL_ID: "configured-model",
      },
      getSettings,
    );
    expect(decisionModelConfiguration(settings, true)).toBeUndefined();
    expect(codeSearchDeploymentPolicy(settings).available).toBe(false);
  });

  test("legacy compatibility enables only code search, not new paid consumers", () => {
    const settings = withEnv({ OPENGENI_JEV_API_KEY: "legacy-test-key" }, getSettings);
    expect(decisionModelConfiguration(settings)).toBeUndefined();
    expect(decisionModelConfiguration(settings, true)?.provider).toBe("jev");
    expect(codeSearchDeploymentPolicy(settings).available).toBe(false);
  });

  const azureIdentity = {
    OPENGENI_DECISION_MODEL_AUTH: "deployment_identity",
    OPENGENI_DECISION_MODEL_PROVIDER: "openai",
    OPENGENI_DECISION_MODEL_ID: "configured-deployment",
    OPENGENI_DECISION_MODEL_BASE_URL: "https://resource.openai.azure.test/openai/v1",
    AZURE_TENANT_ID: "tenant-test",
    AZURE_CLIENT_ID: "client-test",
    AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/azure/tokens/token-test",
  };

  test("an Azure OpenAI decision model signs in as the deployment identity, without a key", () => {
    const settings = withEnv(azureIdentity, getSettings);
    expect(decisionModelConfiguration(settings)).toEqual({
      provider: "openai",
      model: "configured-deployment",
      baseUrl: "https://resource.openai.azure.test/openai/v1",
      azureEntra: {
        tenantId: "tenant-test",
        clientId: "client-test",
        federatedTokenFile: "/var/run/secrets/azure/tokens/token-test",
      },
    });
  });

  test.each([
    ["no deployment identity", { AZURE_FEDERATED_TOKEN_FILE: undefined }],
    ["the jev provider", { OPENGENI_DECISION_MODEL_PROVIDER: "jev" }],
    ["no resource base URL", { OPENGENI_DECISION_MODEL_BASE_URL: undefined }],
  ])("deployment identity with %s configures nothing", (_, override) => {
    const settings = withEnv(
      Object.fromEntries(
        Object.entries({ ...azureIdentity, ...override }).filter(([, value]) => value),
      ) as NodeJS.ProcessEnv,
      getSettings,
    );
    expect(decisionModelConfiguration(settings)).toBeUndefined();
    expect(decisionModelConfiguration(settings, true)).toBeUndefined();
  });

  // Azure AI Foundry serves the openrouter-shaped decisions API at its own path.
  const foundryEndpoint =
    "https://resource.services.ai.azure.test/providers/microsoft/v1/systemone";
  const foundry = {
    ...azureIdentity,
    OPENGENI_DECISION_MODEL_PROVIDER: "openrouter",
    OPENGENI_DECISION_MODEL_BASE_URL: undefined,
    OPENGENI_DECISION_MODEL_ENDPOINT: foundryEndpoint,
  };

  test("an Azure AI Foundry decision model posts to its endpoint as the deployment identity", () => {
    const settings = withEnv(defined(foundry), getSettings);
    expect(decisionModelConfiguration(settings)).toEqual({
      provider: "openrouter",
      model: "configured-deployment",
      endpoint: foundryEndpoint,
      azureEntra: {
        tenantId: "tenant-test",
        clientId: "client-test",
        federatedTokenFile: "/var/run/secrets/azure/tokens/token-test",
      },
    });
  });

  test("an explicit endpoint works with a key and is part of the explicit category", () => {
    const keyed = withEnv(
      {
        OPENGENI_DECISION_MODEL_PROVIDER: "openrouter",
        OPENGENI_DECISION_MODEL_ID: "configured-deployment",
        OPENGENI_DECISION_MODEL_API_KEY: "decision-test-key",
        OPENGENI_DECISION_MODEL_ENDPOINT: foundryEndpoint,
      },
      getSettings,
    );
    expect(decisionModelConfiguration(keyed)).toEqual({
      provider: "openrouter",
      model: "configured-deployment",
      apiKey: "decision-test-key",
      endpoint: foundryEndpoint,
    });
    // An endpoint alone is a partial explicit category: nothing, and no legacy fallback.
    const partial = withEnv(
      {
        OPENGENI_DECISION_MODEL_ENDPOINT: foundryEndpoint,
        OPENGENI_JEV_API_KEY: "legacy-test-key",
      },
      getSettings,
    );
    expect(decisionModelConfiguration(partial, true)).toBeUndefined();
    // The Jev client posts to its own path, so an endpoint does not apply to it.
    const jev = withEnv(
      {
        OPENGENI_DECISION_MODEL_PROVIDER: "jev",
        OPENGENI_DECISION_MODEL_ID: "jev-latest",
        OPENGENI_DECISION_MODEL_API_KEY: "decision-test-key",
        OPENGENI_DECISION_MODEL_ENDPOINT: foundryEndpoint,
      },
      getSettings,
    );
    expect(decisionModelConfiguration(jev)).toBeUndefined();
  });

  test("the tool search load threshold is unset by default and must be a probability", () => {
    expect(withEnv({}, getSettings).toolSearchLoadThreshold).toBeUndefined();
    expect(
      withEnv({ OPENGENI_TOOL_SEARCH_LOAD_THRESHOLD: "0.7" }, getSettings).toolSearchLoadThreshold,
    ).toBe(0.7);
    for (const invalid of ["0", "1", "1.5", "-0.1", "high"])
      expect(() =>
        withEnv({ OPENGENI_TOOL_SEARCH_LOAD_THRESHOLD: invalid }, getSettings),
      ).toThrow();
  });
});

function defined(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value)) as NodeJS.ProcessEnv;
}

function withEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return run();
  } finally {
    process.env = original;
  }
}
