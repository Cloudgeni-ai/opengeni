import { describe, expect, test } from "bun:test";

import {
  configuredModels,
  configuredProviders,
  getSettings,
  ORGANIZATION_AZURE_OPENAI_MODEL_ID_PREFIX,
  ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
  policyChargesCreditsForModel,
  resolveModelProviderForTurn,
  resolveTurnExecutionPolicyV1,
  withDirectModelProviders,
  withOrganizationAzureOpenAICatalogProvider,
  withOrganizationAzureOpenAICredential,
} from "../src";

const ENDPOINT = "https://contoso.openai.azure.com/openai/v1";
const DEPLOYMENT = "gpt-6.1-sol";
const MODEL_ID = `${ORGANIZATION_AZURE_OPENAI_MODEL_ID_PREFIX}${DEPLOYMENT}`;

function base(env: Record<string, string> = {}) {
  return getSettings({ OPENGENI_ENV: "test", OPENGENI_OPENAI_API_KEY: "sk-deployment", ...env });
}

function provider(settings: ReturnType<typeof base>) {
  return configuredProviders(settings).find((p) => p.id === ORGANIZATION_AZURE_OPENAI_PROVIDER_ID);
}

describe("organization Azure OpenAI rail", () => {
  test("uses the reserved organization id and model prefix", () => {
    expect(ORGANIZATION_AZURE_OPENAI_PROVIDER_ID).toBe("organization-azure-openai");
    expect(MODEL_ID).toBe("organization-azure-openai/gpt-6.1-sol");
  });

  test("the secret-free catalog overlay needs both an endpoint and a deployment", () => {
    const settings = base();
    expect(
      withOrganizationAzureOpenAICatalogProvider(settings, { endpoint: ENDPOINT, models: [] }),
    ).toBe(settings);
    expect(
      withOrganizationAzureOpenAICatalogProvider(settings, {
        endpoint: null,
        models: [{ upstreamModelId: DEPLOYMENT }],
      }),
    ).toBe(settings);
    // A persisted value outside the official Azure origin never routes.
    expect(
      withOrganizationAzureOpenAICatalogProvider(settings, {
        endpoint: "https://proxy.example.com/openai/v1",
        models: [{ upstreamModelId: DEPLOYMENT }],
      }),
    ).toBe(settings);
    const catalog = withOrganizationAzureOpenAICatalogProvider(settings, {
      endpoint: "https://contoso.openai.azure.com/",
      models: [{ upstreamModelId: DEPLOYMENT, label: "GPT-6.1 Sol" }],
    });
    expect(provider(catalog)).toMatchObject({
      kind: "direct-azure-organization",
      api: "responses",
      wireProfile: "azure-openai",
      baseUrl: ENDPOINT,
    });
    expect(provider(catalog)?.apiKey).toBeUndefined();
    expect(JSON.stringify(catalog.modelProvidersJson)).not.toContain("sk-");
  });

  test("models are the curated deployments, billed to the organization with no credits", () => {
    const catalog = withOrganizationAzureOpenAICredential(base(), "azure-org-key", {
      endpoint: ENDPOINT,
      models: [{ upstreamModelId: DEPLOYMENT }, { upstreamModelId: "gpt-6-luna", label: "Luna" }],
    });
    expect(provider(catalog)).toMatchObject({
      kind: "direct-azure-organization",
      apiKey: "azure-org-key",
      credentialSource: { kind: "organization_connection", mechanism: "api_key" },
      billing: { upstreamPayer: "organization", metering: "external" },
    });
    const models = configuredModels(catalog).filter(
      (model) => model.providerId === ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
    );
    expect(
      models.map((model) => [model.id, model.upstreamModelId, model.label, model.cost]),
    ).toEqual([
      [MODEL_ID, DEPLOYMENT, DEPLOYMENT, "organization"],
      ["organization-azure-openai/gpt-6-luna", "gpt-6-luna", "Luna", "organization"],
    ]);
    for (const model of models) {
      expect(model.credentialSource).toEqual({
        kind: "organization_connection",
        mechanism: "api_key",
      });
      expect(policyChargesCreditsForModel(catalog, model.id)).toBe(false);
    }
  });

  test("capabilities are the conservative workspace direct-Azure definition", () => {
    const settings = base();
    const organization = configuredModels(
      withOrganizationAzureOpenAICatalogProvider(settings, {
        endpoint: ENDPOINT,
        models: [{ upstreamModelId: DEPLOYMENT }],
      }),
    ).find((model) => model.id === MODEL_ID)!;
    const connectionId = crypto.randomUUID();
    const workspace = configuredModels(
      withDirectModelProviders(settings, [
        {
          id: connectionId,
          version: 1,
          subjectId: null,
          kind: "api_key",
          status: "active",
          providerDomain: "contoso.openai.azure.com",
          metadata: {
            credentialRole: "direct_azure_openai",
            directModelProvider: {
              provider: "azure_openai",
              model: DEPLOYMENT,
              endpoint: ENDPOINT,
            },
          },
        },
      ]),
    ).find((model) => model.providerId === `workspace-azure-openai-${connectionId}`)!;
    expect(organization.capabilities).toEqual(workspace.capabilities);
    expect(organization.capabilities.reasoning.runnable).toBe(false);
    expect(organization.capabilities.hostedTools.webSearch.runnable).toBe(false);
  });

  test("the organization id is never paid in credits, even against base settings", () => {
    expect(policyChargesCreditsForModel(base(), MODEL_ID)).toBe(false);
  });

  test("an accepted turn resolves only with the organization overlay; there is no fallback", () => {
    expect(resolveModelProviderForTurn(base(), MODEL_ID)).toBeUndefined();
    const catalog = withOrganizationAzureOpenAICatalogProvider(base(), {
      endpoint: ENDPOINT,
      models: [{ upstreamModelId: DEPLOYMENT }],
    });
    const resolved = resolveModelProviderForTurn(catalog, MODEL_ID);
    expect(resolved?.provider.kind).toBe("direct-azure-organization");
    expect(resolved?.model.upstreamModelId).toBe(DEPLOYMENT);
    expect(resolved?.provider.baseUrl).toBe(ENDPOINT);
  });

  test("the endpoint is part of the executable definition identity", () => {
    const policyFor = (endpoint: string) =>
      resolveTurnExecutionPolicyV1(
        withOrganizationAzureOpenAICatalogProvider(base(), {
          endpoint,
          models: [{ upstreamModelId: DEPLOYMENT }],
        }),
        {
          modelId: MODEL_ID,
          requestedModelId: MODEL_ID,
          modelSource: "explicit",
          reasoningEffort: "medium",
          reasoningSource: "deployment",
        },
      );
    const contoso = policyFor(ENDPOINT);
    expect(contoso.productModelId).toBe(MODEL_ID);
    expect(contoso.billing).toEqual({ upstreamPayer: "organization", metering: "external" });
    expect(policyFor("https://fabrikam.openai.azure.com/openai/v1").definitionVersion).not.toBe(
      contoso.definitionVersion,
    );
  });

  test("host registry JSON cannot claim the organization Azure id or broker kind", () => {
    expect(() =>
      base({
        OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
          {
            id: ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
            api: "responses",
            baseUrl: ENDPOINT,
            apiKey: "inline",
            models: [{ id: "organization-azure-openai/x", upstreamModelId: "x" }],
          },
        ]),
      }),
    ).toThrow(/reserved/u);
    expect(() =>
      base({
        OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
          {
            kind: "direct-azure-organization",
            id: "my-azure",
            api: "responses",
            baseUrl: ENDPOINT,
            apiKey: "inline",
            models: [{ id: "my-azure/x", upstreamModelId: "x" }],
          },
        ]),
      }),
    ).toThrow(/reserved/u);
  });

  test("an empty runtime credential is refused", () => {
    expect(() =>
      withOrganizationAzureOpenAICredential(base(), "  ", {
        endpoint: ENDPOINT,
        models: [{ upstreamModelId: DEPLOYMENT }],
      }),
    ).toThrow(/empty/u);
  });
});
