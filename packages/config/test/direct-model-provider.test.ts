import { expect, test } from "bun:test";
import { AzureOpenAIEndpoint, directModelConnectionSpec } from "@opengeni/contracts";
import {
  configuredModels,
  getSettings,
  resolveModelProvider,
  validateModelCatalogSettings,
  withDirectModelProviders,
} from "../src";

const connection = {
  id: "00000000-0000-4000-8000-000000000001",
  version: 1,
  subjectId: null,
  kind: "api_key",
  status: "active",
  providerDomain: "customer.openai.azure.com",
  metadata: {
    credentialRole: "direct_azure_openai",
    directModelProvider: {
      provider: "azure_openai",
      endpoint: "https://customer.openai.azure.com",
      model: "my-deployment",
    },
  },
};

test("Azure credentials can only be sent to an official resource origin", () => {
  expect(AzureOpenAIEndpoint.parse("https://customer.openai.azure.com/openai/v1/")).toBe(
    "https://customer.openai.azure.com/openai/v1",
  );
  for (const endpoint of [
    "",
    "not-a-url",
    "http://customer.openai.azure.com",
    "https://customer.openai.azure.com.evil.test",
    "https://localhost",
    "https://customer.openai.azure.com:8443",
    "https://user:pass@customer.openai.azure.com",
    "https://customer.openai.azure.com/redirect",
    "https://customer.openai.azure.com?key=value",
  ]) {
    expect(AzureOpenAIEndpoint.safeParse(endpoint).success).toBe(false);
  }
});

test("customer provider definitions retain external billing and bind to one immutable connection", () => {
  const base = getSettings({ OPENGENI_ENV: "test" });
  const spec = directModelConnectionSpec(connection)!;
  const catalog = withDirectModelProviders(base, [connection]);
  const executable = withDirectModelProviders(base, [{ ...connection, apiKey: "customer-secret" }]);
  const model = configuredModels(catalog).find((row) => row.id === spec.modelId)!;
  expect(model.cost).toBe("workspace");
  expect(model.billing).toEqual({ upstreamPayer: "workspace", metering: "external" });
  expect(model.credentialSource).toEqual({ kind: "workspace_connection", mechanism: "api_key" });
  expect(resolveModelProvider(executable, spec.modelId)?.provider.apiKey).toBe("customer-secret");
  expect(resolveModelProvider(executable, spec.modelId)?.provider.wireProfile).toBe("azure-openai");
  expect(
    configuredModels(executable).find((row) => row.id === spec.modelId)?.definitionVersion,
  ).toBe(model.definitionVersion);
  expect(JSON.stringify(model)).not.toContain("customer-secret");
  expect(directModelConnectionSpec({ ...connection, version: 2 })?.modelId).not.toBe(spec.modelId);
  expect(directModelConnectionSpec({ ...connection, status: "revoked" })).toBeNull();
  expect(directModelConnectionSpec({ ...connection, subjectId: "someone" })).toBeNull();
  expect(
    directModelConnectionSpec({ ...connection, providerDomain: "other.openai.azure.com" }),
  ).toBeNull();
  expect(() => validateModelCatalogSettings(catalog)).toThrow("reserved");
});

test("OpenAI customer keys always route to the public OpenAI API", () => {
  const openai = {
    ...connection,
    providerDomain: "api.openai.com",
    metadata: {
      credentialRole: "direct_openai",
      directModelProvider: { provider: "openai", model: "gpt-6-sol" },
    },
  };
  const spec = directModelConnectionSpec(openai)!;
  const route = resolveModelProvider(
    withDirectModelProviders(getSettings({ OPENGENI_ENV: "test" }), [
      { ...openai, apiKey: "customer-openai-key" },
    ]),
    spec.modelId,
  )!;
  expect(route.provider.baseUrl).toBe("https://api.openai.com/v1");
  expect(route.model.upstreamModelId).toBe("gpt-6-sol");
  expect(route.model.cost).toBe("workspace");
});
