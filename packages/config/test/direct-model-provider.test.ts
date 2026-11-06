import { expect, test } from "bun:test";
import {
  AzureOpenAIEndpoint,
  CompatibleModelBaseUrl,
  DirectModelProviderMetadata,
  directModelConnectionSpec,
  directModelProviderOfProviderId,
  isDirectModelId,
  isDirectModelProviderId,
  isEuResidency,
} from "@opengeni/contracts";
import {
  compatibleModelCapabilities,
  configuredModels,
  getSettings,
  policyChargesCreditsForModel,
  resolveModelProvider,
  validateModelCatalogSettings,
  withDirectModelProviders,
  organizationCompatibleConnectionIdOf,
  organizationCompatibleModelId,
  withOrganizationCompatibleProviders,
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

const compatible = {
  ...connection,
  id: "00000000-0000-4000-8000-0000000000c1",
  providerDomain: "api.example.com",
  metadata: {
    credentialRole: "direct_openai_compatible",
    credentialLabel: "Example",
    directModelProvider: {
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      model: "org/model-9b:latest",
      label: "Example",
    },
  },
};

test("an OpenAI-compatible base URL is a public HTTPS origin and path, normalized", () => {
  for (const [input, expected] of [
    ["https://api.example.com/v1", "https://api.example.com/v1"],
    ["https://API.Example.com/v1/", "https://api.example.com/v1"],
    ["https://api.example.com/v1/chat/completions", "https://api.example.com/v1"],
    ["https://api.example.com/v1/responses/", "https://api.example.com/v1"],
    ["https://api.example.com:8443/openai/v1", "https://api.example.com:8443/openai/v1"],
    ["https://api.example.com:443/v1", "https://api.example.com/v1"],
    ["https://api.example.com", "https://api.example.com"],
  ] as const) {
    expect(CompatibleModelBaseUrl.parse(input)).toBe(expected);
  }
  for (const input of [
    "",
    "not-a-url",
    "http://api.example.com/v1",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com/v1?key=value",
    "https://api.example.com/v1#fragment",
    "https://localhost/v1",
    "https://models.local/v1",
    "https://llm.cluster.internal/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.8/v1",
    "https://[::1]/v1",
    "ftp://api.example.com/v1",
  ]) {
    expect(CompatibleModelBaseUrl.safeParse(input).success).toBe(false);
  }
});

test("only an OpenAI-compatible connection names its own base URL, API and label", () => {
  const parse = (value: unknown) => DirectModelProviderMetadata.safeParse(value).success;
  expect(parse({ provider: "openai_compatible", model: "org/model:tag" })).toBe(false);
  expect(
    parse({ provider: "openai_compatible", model: "m", baseUrl: "https://api.example.com/v1" }),
  ).toBe(true);
  expect(
    parse({
      provider: "openai_compatible",
      model: "m",
      baseUrl: "https://api.example.com/v1",
      endpoint: "https://customer.openai.azure.com",
    }),
  ).toBe(false);
  expect(parse({ provider: "openai", model: "gpt-6-sol", baseUrl: "https://evil.test/v1" })).toBe(
    false,
  );
  expect(parse({ provider: "openai", model: "gpt-6-sol", api: "chat" })).toBe(false);
  expect(parse({ provider: "openai", model: "gpt-6-sol", label: "Mine" })).toBe(false);
  // OpenAI and Azure model names keep their existing, narrower shape.
  expect(parse({ provider: "openai", model: "org/model:tag" })).toBe(false);
  expect(
    parse({ provider: "openai_compatible", model: "a b", baseUrl: "https://api.example.com" }),
  ).toBe(false);
});

test("an OpenAI-compatible connection becomes one workspace-paid route bound to its connection", () => {
  const base = getSettings({ OPENGENI_ENV: "test" });
  const spec = directModelConnectionSpec(compatible)!;
  expect(spec.providerId).toBe(`workspace-compatible-${compatible.id}`);
  expect(spec.modelId).toBe(`workspace-compatible-${compatible.id}/1/org/model-9b:latest`);
  expect(spec.baseUrl).toBe("https://api.example.com/v1");
  expect(isDirectModelId(spec.modelId)).toBe(true);
  expect(isDirectModelProviderId(spec.providerId)).toBe(true);
  expect(directModelProviderOfProviderId(spec.providerId)).toBe("openai_compatible");
  expect(directModelProviderOfProviderId(`workspace-openai-${compatible.id}`)).toBe("openai");
  expect(directModelProviderOfProviderId("workspace-openrouter")).toBeNull();
  expect(isDirectModelProviderId("workspace-gateway")).toBe(false);

  const catalog = withDirectModelProviders(base, [compatible]);
  const executable = withDirectModelProviders(base, [{ ...compatible, apiKey: "customer-secret" }]);
  const model = configuredModels(catalog).find((row) => row.id === spec.modelId)!;
  expect(model.cost).toBe("workspace");
  expect(model.billing).toEqual({ upstreamPayer: "workspace", metering: "external" });
  expect(model.credentialSource).toEqual({ kind: "workspace_connection", mechanism: "api_key" });
  expect(model.residency).toMatchObject({ geography: "unknown", deploymentType: "unknown" });
  expect(isEuResidency(model.residency)).toBe(false);
  expect(model.capabilities.functionCalling.runnable).toBe(true);
  expect(model.capabilities.hostedTools.webSearch.runnable).toBe(false);
  expect(policyChargesCreditsForModel(catalog, spec.modelId)).toBe(false);
  const route = resolveModelProvider(executable, spec.modelId)!;
  expect(route.provider).toMatchObject({
    kind: "direct-compatible-workspace",
    label: "Example",
    api: "chat",
    wireProfile: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "customer-secret",
  });
  expect(route.model.upstreamModelId).toBe("org/model-9b:latest");
  expect(JSON.stringify(model)).not.toContain("customer-secret");

  const responses = {
    ...compatible,
    metadata: {
      ...compatible.metadata,
      directModelProvider: {
        provider: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
        model: "m",
        api: "responses",
      },
    },
  };
  const responsesRoute = resolveModelProvider(
    withDirectModelProviders(base, [responses]),
    directModelConnectionSpec(responses)!.modelId,
  )!;
  expect(responsesRoute.provider.api).toBe("responses");
  // Without a label the route is named by its host.
  expect(responsesRoute.provider.label).toBe("api.example.com");

  // The key is bound to the base URL's host and to an active, workspace-owned connection.
  expect(directModelConnectionSpec({ ...compatible, providerDomain: "evil.test" })).toBeNull();
  expect(directModelConnectionSpec({ ...compatible, subjectId: "someone" })).toBeNull();
  expect(
    directModelConnectionSpec({
      ...compatible,
      metadata: { ...compatible.metadata, credentialRole: "direct_openai" },
    }),
  ).toBeNull();
  expect(() => validateModelCatalogSettings(catalog)).toThrow("reserved");
});

test("an organization's compatible endpoints each become one organization-paid route", () => {
  const base = getSettings({ OPENGENI_ENV: "test" });
  const first = {
    id: "00000000-0000-4000-8000-0000000000a1",
    baseUrl: "https://inference.example.com/v1",
    api: "chat" as const,
    label: "Acme",
    models: [{ upstreamModelId: "acme/fast-1" }, { upstreamModelId: "acme/fast-1" }],
  };
  const second = {
    id: "00000000-0000-4000-8000-0000000000b2",
    baseUrl: "https://models.example.org/v1",
    api: "responses" as const,
    models: [{ upstreamModelId: "coder:7b" }],
  };
  const empty = { ...second, id: "00000000-0000-4000-8000-0000000000c3", models: [] };
  const fast = organizationCompatibleModelId(first.id, "acme/fast-1");
  const coder = organizationCompatibleModelId(second.id, "coder:7b");
  expect(fast).toBe(`organization-compatible-${first.id}/acme/fast-1`);
  expect(organizationCompatibleConnectionIdOf(fast)).toBe(first.id);
  expect(organizationCompatibleConnectionIdOf(`organization-compatible-${second.id}`)).toBe(
    second.id,
  );
  expect(organizationCompatibleConnectionIdOf("organization-openai/gpt-5")).toBeNull();
  expect(organizationCompatibleConnectionIdOf("organization-compatible-nope/x")).toBeNull();

  const catalog = withOrganizationCompatibleProviders(base, [first, second, empty]);
  const ids = configuredModels(catalog)
    .map((row) => row.id)
    .filter((id) => id.startsWith("organization-compatible-"));
  // A repeated model is listed once; an endpoint without models adds nothing.
  expect(ids.sort()).toEqual([coder, fast].sort());
  const model = configuredModels(catalog).find((row) => row.id === fast)!;
  expect(model.billing).toEqual({ upstreamPayer: "organization", metering: "external" });
  expect(model.credentialSource).toEqual({ kind: "organization_connection", mechanism: "api_key" });
  expect(model.residency).toMatchObject({ geography: "unknown", deploymentType: "unknown" });
  expect(model.capabilities.functionCalling.runnable).toBe(true);
  expect(policyChargesCreditsForModel(catalog, fast)).toBe(false);
  expect(resolveModelProvider(catalog, coder)!.provider).toMatchObject({
    kind: "direct-compatible-organization",
    label: "models.example.org",
    api: "responses",
    baseUrl: "https://models.example.org/v1",
  });

  const executable = withOrganizationCompatibleProviders(base, [
    { ...first, apiKey: "organization-secret" },
  ]);
  const route = resolveModelProvider(executable, fast)!;
  expect(route.provider).toMatchObject({
    kind: "direct-compatible-organization",
    label: "Acme",
    wireProfile: "openai",
    apiKey: "organization-secret",
  });
  expect(route.model.upstreamModelId).toBe("acme/fast-1");
  expect(JSON.stringify(model)).not.toContain("organization-secret");
  // A later overlay replaces the earlier one rather than adding to it.
  const replaced = withOrganizationCompatibleProviders(catalog, [second]);
  expect(resolveModelProvider(replaced, fast)).toBeUndefined();
  expect(withOrganizationCompatibleProviders(base, [])).toBe(base);
});

test("a compatible model's declared reasoning levels make the picker offer exactly those", () => {
  const base = getSettings({ OPENGENI_ENV: "test" });
  const reasoning = {
    efforts: ["none", "low", "high", "max"] as const,
    defaultEffort: "high" as const,
  };
  const endpoint = {
    id: "00000000-0000-4000-8000-0000000000d4",
    baseUrl: "https://inference.example.com/v1",
    api: "chat" as const,
    models: [
      {
        upstreamModelId: "acme/thinker",
        reasoning: { ...reasoning, efforts: [...reasoning.efforts] },
      },
      { upstreamModelId: "acme/plain", reasoning: null },
    ],
  };
  const catalog = withOrganizationCompatibleProviders(base, [endpoint]);
  const thinker = configuredModels(catalog).find(
    (row) => row.id === organizationCompatibleModelId(endpoint.id, "acme/thinker"),
  )!;
  expect(thinker.capabilities.reasoning).toMatchObject({
    runnable: true,
    efforts: ["none", "low", "high", "max"],
    defaultEffort: "high",
  });
  const plain = configuredModels(catalog).find(
    (row) => row.id === organizationCompatibleModelId(endpoint.id, "acme/plain"),
  )!;
  expect(plain.capabilities.reasoning.runnable).toBe(false);
  expect(plain.capabilities.reasoning.efforts).toEqual([]);

  // A workspace connection carries the same levels in its metadata.
  const workspace = withDirectModelProviders(base, [
    {
      ...compatible,
      metadata: {
        ...compatible.metadata,
        directModelProvider: {
          ...compatible.metadata.directModelProvider,
          reasoning: { efforts: ["low", "high"], defaultEffort: "low" },
        },
      },
    },
  ]);
  const spec = directModelConnectionSpec(compatible)!;
  const direct = configuredModels(workspace).find((row) => row.id === spec.modelId)!;
  expect(direct.capabilities.reasoning).toMatchObject({
    runnable: true,
    efforts: ["low", "high"],
    defaultEffort: "low",
  });
  expect(compatibleModelCapabilities(base, null).reasoning.runnable).toBe(false);
});
