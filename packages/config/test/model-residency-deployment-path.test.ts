import { describe, expect, test } from "bun:test";
import {
  isEuResidency,
  modelEndpointDeployment,
  modelResidencyRouteProblems,
} from "@opengeni/contracts";
import { builtinModelResidency, configuredModels, euModelRoutes, getSettings } from "../src";

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

const azureDeploymentPathEnv = (deployment: string): NodeJS.ProcessEnv => ({
  OPENGENI_OPENAI_PROVIDER: "azure",
  OPENGENI_AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com",
  OPENGENI_AZURE_OPENAI_DEPLOYMENT: deployment,
  OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
  OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
  OPENGENI_OPENAI_MODEL: "gpt-eu",
});

describe("deployment-path endpoints and residency", () => {
  test("the deployment an endpoint URL calls is read from its path", () => {
    expect(
      modelEndpointDeployment(
        "https://res.openai.azure.com/openai/deployments/gpt-global-standard/responses?api-version=1",
      ),
    ).toBe("gpt-global-standard");
    expect(modelEndpointDeployment("https://res.openai.azure.com/openai/deployments/gpt-eu")).toBe(
      "gpt-eu",
    );
    expect(modelEndpointDeployment("https://res.openai.azure.com/openai/v1/responses")).toBeNull();
    expect(modelEndpointDeployment("not a url")).toBeNull();
    // Read the way the provider reads the path: any case, percent-decoded,
    // empty segments dropped.
    for (const path of [
      "/openai/Deployments/gpt-global/responses",
      "/openai/%64eployments/gpt-global/responses",
      "/openai/deployments//gpt-global/responses",
      "/openai/deployments%2Fgpt-global/responses",
    ]) {
      expect(modelEndpointDeployment(`https://res.openai.azure.com${path}`)).toBe("gpt-global");
    }
    // A deployment path whose deployment can't be read is unknown, not absent.
    for (const path of [
      "/openai/deployments",
      "/openai/deployments/",
      "/openai/deployments/%E0%A4%A",
      "/openai/deployments/gpt-eu/deployments/gpt-global",
      // A decoded dot segment a server could resolve to another deployment.
      "/openai/deployments/gpt-eu%2F..%2Fgpt-global/",
      "/openai/deployments/gpt-eu%2F.%2F/responses",
      "/openai/%2E%2E%2Fdeployments/gpt-eu",
    ]) {
      expect(modelEndpointDeployment(`https://res.openai.azure.com${path}`)).toBe("");
    }
    expect(
      modelResidencyRouteProblems(euDataZone, {
        baseUrl: "https://res.openai.azure.com/openai/deployments/gpt-eu%2F..%2Fgpt-global/",
        upstreamModelId: "gpt-eu",
      }),
    ).toHaveLength(1);
    // An EU claim on a deployment path is right only for the deployment it calls.
    const route = { baseUrl: "https://res.openai.azure.com/openai/deployments/gpt-eu" };
    expect(
      modelResidencyRouteProblems(euDataZone, { ...route, upstreamModelId: "gpt-eu" }),
    ).toEqual([]);
    expect(
      modelResidencyRouteProblems(euDataZone, { ...route, upstreamModelId: "gpt-other" }),
    ).toHaveLength(1);
    for (const baseUrl of [
      "https://res.openai.azure.com/openai/Deployments/gpt-other",
      "https://res.openai.azure.com/openai/deployments/",
    ]) {
      expect(
        modelResidencyRouteProblems(euDataZone, { baseUrl, upstreamModelId: "gpt-eu" }),
      ).toHaveLength(1);
    }
  });

  test("built-in Azure deployment-path mode is EU only for the model that is its deployment", () => {
    const residencyJson = JSON.stringify({ "gpt-eu": euDataZone });
    // Every request goes to gpt-global-standard, whatever the body names: the
    // gpt-eu claim does not describe what runs, so startup refuses it ...
    expect(() =>
      withEnv(
        {
          ...azureDeploymentPathEnv("gpt-global-standard"),
          OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON: residencyJson,
        },
        () => getSettings(),
      ),
    ).toThrow(/calls deployment gpt-global-standard/u);
    // ... and settings that skipped validation resolve it as unknown.
    const mismatched = {
      ...withEnv(azureDeploymentPathEnv("gpt-global-standard"), () => getSettings()),
      builtinModelResidencyJson: residencyJson,
    };
    expect(isEuResidency(builtinModelResidency(mismatched, "gpt-eu"))).toBe(false);
    expect(euModelRoutes(mismatched).get("azure")?.has("gpt-eu") ?? false).toBe(false);
    // When the model is the deployment the endpoint calls, the claim holds.
    const matching = withEnv(
      { ...azureDeploymentPathEnv("gpt-eu"), OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON: residencyJson },
      () => getSettings(),
    );
    expect(isEuResidency(builtinModelResidency(matching, "gpt-eu"))).toBe(true);
    expect(euModelRoutes(matching).get("azure")?.has("gpt-eu")).toBe(true);
  });

  test("a registry provider on a deployment path is EU only for that deployment", () => {
    const providers = JSON.stringify([
      {
        id: "azure-path",
        api: "responses",
        wireProfile: "azure-openai",
        baseUrl: "https://res.openai.azure.com/openai/deployments/gpt-eu",
        apiKey: "key",
        residency: euDataZone,
        models: [
          { id: "azure-path/gpt-eu", upstreamModelId: "gpt-eu" },
          { id: "azure-path/gpt-other", upstreamModelId: "gpt-other" },
        ],
      },
    ]);
    // The operator environment is strict: the gpt-other claim is refused.
    expect(() =>
      withEnv(
        { OPENGENI_OPENAI_API_KEY: "sk-test", OPENGENI_MODEL_PROVIDERS_JSON: providers },
        () => getSettings(),
      ),
    ).toThrow(/calls deployment gpt-eu, not gpt-other/u);
    const settings = {
      ...withEnv({ OPENGENI_OPENAI_API_KEY: "sk-test" }, () => getSettings()),
      modelProvidersJson: providers,
    };
    const byId = new Map(configuredModels(settings).map((model) => [model.id, model]));
    expect(isEuResidency(byId.get("azure-path/gpt-eu")?.residency)).toBe(true);
    expect(isEuResidency(byId.get("azure-path/gpt-other")?.residency)).toBe(false);
  });

  test("EU routes are computed once per settings snapshot", () => {
    const settings = withEnv(
      {
        ...azureDeploymentPathEnv("gpt-eu"),
        OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON: JSON.stringify({ "gpt-eu": euDataZone }),
      },
      () => getSettings(),
    );
    expect(euModelRoutes(settings)).toBe(euModelRoutes(settings));
    expect(euModelRoutes({ ...settings })).not.toBe(euModelRoutes(settings));
  });
});
