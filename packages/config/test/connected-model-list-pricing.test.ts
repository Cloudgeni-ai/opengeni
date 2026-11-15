import { describe, expect, test } from "bun:test";

import {
  configuredModelListPricingSchedules,
  connectedModelPriceBasisFromReportedModel,
  connectedModelPriceBasisModelIds,
  defaultModelPricing,
  getSettings,
  modelListPriceKnown,
  ORGANIZATION_AZURE_OPENAI_MODEL_ID_PREFIX,
  resolveModelProviderForTurn,
  withOrganizationAzureOpenAICatalogProvider,
  withOrganizationAzureOpenAICredential,
  withOrganizationCompatibleProviders,
  withDirectModelProviders,
  withOrganizationDirectCatalogProvider,
  workspaceModelKeyListPriceKnown,
} from "../src";
import { directModelConnectionSpec } from "@opengeni/contracts";

const ENDPOINT = "https://contoso.openai.azure.com/openai/v1";
const DEPLOYMENT = "prod-reasoning";
const MODEL_ID = `${ORGANIZATION_AZURE_OPENAI_MODEL_ID_PREFIX}${DEPLOYMENT}`;
const CUSTOM = {
  inputMicrosPerMillionTokens: 3_000_000,
  cachedInputMicrosPerMillionTokens: 300_000,
  outputMicrosPerMillionTokens: 15_000_000,
};

function base(env: Record<string, string> = {}) {
  return getSettings({ OPENGENI_ENV: "test", OPENGENI_OPENAI_API_KEY: "sk-deployment", ...env });
}

function azure(model: Record<string, unknown> = {}) {
  return withOrganizationAzureOpenAICredential(base(), "azure-org-key", {
    endpoint: ENDPOINT,
    models: [{ upstreamModelId: DEPLOYMENT, ...model }],
  });
}

describe("connected model list pricing", () => {
  test("an Azure deployment without a declared price stays unknown, never free", () => {
    expect(configuredModelListPricingSchedules(azure())[MODEL_ID]).toBeUndefined();
    expect(modelListPriceKnown(azure(), MODEL_ID)).toBe(false);
    // Even a deployment named like a catalogue model does not borrow its rate.
    const named = withOrganizationAzureOpenAICatalogProvider(base(), {
      endpoint: ENDPOINT,
      models: [{ upstreamModelId: "gpt-6-astra" }],
    });
    expect(
      configuredModelListPricingSchedules(named)[
        `${ORGANIZATION_AZURE_OPENAI_MODEL_ID_PREFIX}gpt-6-astra`
      ],
    ).toBeUndefined();
  });

  test("an Azure deployment is priced from its declared base model", () => {
    const settings = azure({ listPricingModelId: "gpt-6-astra" });
    expect(configuredModelListPricingSchedules(settings)[MODEL_ID]).toEqual(
      defaultModelPricing["gpt-6-astra"]!,
    );
    expect(modelListPriceKnown(settings, MODEL_ID)).toBe(true);
  });

  test("an explicit price overrides the base model", () => {
    const settings = azure({ listPricingModelId: "gpt-6-astra", listPricing: CUSTOM });
    expect(configuredModelListPricingSchedules(settings)[MODEL_ID]).toEqual({ default: CUSTOM });
  });

  test("a base model without a known rate stays unknown", () => {
    expect(
      configuredModelListPricingSchedules(azure({ listPricingModelId: "not-a-catalogue-model" }))[
        MODEL_ID
      ],
    ).toBeUndefined();
    // An OpenAI model keeps OpenAI's own list rate when its stored base model has none.
    const openai = withOrganizationDirectCatalogProvider(base(), "openai", {
      models: [{ upstreamModelId: "gpt-6-astra", listPricingModelId: "not-a-catalogue-model" }],
    });
    expect(
      configuredModelListPricingSchedules(openai)["organization-openai/gpt-6-astra"],
    ).toBeDefined();
  });

  test("the operator's explicit rate for the base model is the base price", () => {
    const operator = { default: { ...CUSTOM, marginBps: 0 } };
    const settings = withOrganizationDirectCatalogProvider(
      base({ OPENGENI_MODEL_PRICING_JSON: JSON.stringify({ "house-model": operator }) }),
      "azure_openai",
      {
        endpoint: ENDPOINT,
        models: [{ upstreamModelId: DEPLOYMENT, listPricingModelId: "house-model" }],
      },
    );
    expect(configuredModelListPricingSchedules(settings)[MODEL_ID]).toEqual(operator);
    expect(connectedModelPriceBasisModelIds(settings)).toContain("house-model");
  });

  test("an organization OpenAI-compatible endpoint model takes its declared price", () => {
    const settings = withOrganizationCompatibleProviders(base(), [
      {
        id: "11111111-2222-4333-8444-555555555555",
        baseUrl: "https://llm.example.com/v1",
        api: "chat",
        models: [
          { upstreamModelId: "open-weights", listPricing: CUSTOM },
          { upstreamModelId: "unpriced" },
        ],
      },
    ]);
    const schedules = configuredModelListPricingSchedules(settings);
    const priced = Object.keys(schedules).filter((id) => id.startsWith("organization-compatible-"));
    expect(priced).toEqual([
      "organization-compatible-11111111-2222-4333-8444-555555555555/open-weights",
    ]);
  });

  test("a declared price never changes the model's executable identity", () => {
    const unpriced = resolveModelProviderForTurn(azure(), MODEL_ID)!;
    const priced = resolveModelProviderForTurn(
      azure({ listPricingModelId: "gpt-6-astra", listPricing: CUSTOM }),
      MODEL_ID,
    )!;
    expect(priced.model.definitionVersion).toBe(unpriced.model.definitionVersion);
    expect(priced.model.pricing).toBeUndefined();
  });

  test("a reported model maps to a base model only by exact id or snapshot date", () => {
    const settings = base();
    expect(connectedModelPriceBasisFromReportedModel(settings, "gpt-6-astra")).toBe("gpt-6-astra");
    expect(connectedModelPriceBasisFromReportedModel(settings, "gpt-6-astra-2026-03-05")).toBe(
      "gpt-6-astra",
    );
    expect(connectedModelPriceBasisFromReportedModel(settings, "gpt-6-astra-mini")).toBeNull();
    expect(connectedModelPriceBasisFromReportedModel(settings, "my-gpt-6-astra")).toBeNull();
    expect(connectedModelPriceBasisFromReportedModel(settings, undefined)).toBeNull();
  });

  test("a workspace's own model key is priced by the same rules, from its stored price", () => {
    const key = (listPrice?: unknown) => ({
      id: "00000000-0000-4000-8000-000000000001",
      version: 3,
      subjectId: null,
      kind: "api_key",
      status: "active",
      providerDomain: "contoso.openai.azure.com",
      metadata: {
        credentialRole: "direct_azure_openai",
        directModelProvider: { provider: "azure_openai", model: DEPLOYMENT, endpoint: ENDPOINT },
      },
      ...(listPrice === undefined ? {} : { listPrice }),
    });
    const modelId = directModelConnectionSpec(key())!.modelId;
    const priced = (listPrice?: unknown) =>
      configuredModelListPricingSchedules(
        withDirectModelProviders(base(), [key(listPrice) as never]),
      )[modelId];
    expect(priced()).toBeUndefined();
    expect(workspaceModelKeyListPriceKnown(base(), key(null) as never)).toBe(false);
    expect(priced({ basis: "model", modelId: "gpt-6-astra" })).toEqual(
      defaultModelPricing["gpt-6-astra"]!,
    );
    expect(priced({ basis: "custom", pricing: CUSTOM })).toEqual({ default: CUSTOM });
    expect(
      workspaceModelKeyListPriceKnown(
        base(),
        key({ basis: "model", modelId: "gpt-6-astra" }) as never,
      ),
    ).toBe(true);
    // Any other connection has no price to know.
    expect(
      workspaceModelKeyListPriceKnown(base(), { ...key(), metadata: {} } as never),
    ).toBeUndefined();
  });
});
