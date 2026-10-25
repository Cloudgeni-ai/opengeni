import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getOrCreateTrace } from "@openai/agents-core";
import {
  configuredProviders,
  resolveModelProvider,
  withOrganizationAzureOpenAICredential,
  withOrganizationAzureOpenAIEntraCredential,
  type Settings,
} from "@opengeni/config";
import { resetSharedAzureEntraAccessTokenSources } from "@opengeni/network/azure-entra";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenAIClientFromSettings, buildProviderClient } from "../src/model-provider-client";
import { buildOpenGeniAgent } from "../src/index";
import { buildModelInstance } from "../src/model-provider-routing";
import { runSingleModelCall } from "../src/single-model-call";
import { requestBodyText } from "../src/replayable-json-body";

const originalFetch = globalThis.fetch;
let directory: string;
let settings: Settings;
let tokenRequests: URLSearchParams[];
let requests: { url: string; headers: Headers; body: Record<string, unknown> }[];
let modelStatus: number;

beforeEach(async () => {
  directory = await mkdtemp(join(import.meta.dir, ".azure-identity-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "projected-assertion-1");
  resetSharedAzureEntraAccessTokenSources();
  tokenRequests = [];
  requests = [];
  modelStatus = 200;
  settings = testSettings({
    sandboxBackend: "none",
    openaiProvider: "azure",
    openaiApiKey: "unrelated-key-must-not-leak",
    azureOpenaiAuthMode: "workload_identity",
    azureOpenaiApiKey: undefined,
    azureOpenaiAdToken: undefined,
    azureOpenaiBaseUrl: "https://builtin-identity.openai.azure.com/openai/v1",
    azureTenantId: "tenant",
    azureClientId: "client",
    azureFederatedTokenFile: tokenFile,
    openaiModel: "reasoning-deployment",
    openaiAllowedModels: "reasoning-deployment,small-deployment",
    openaiReasoningEffort: "high",
    openaiResponsesWebSocketEnabled: false,
    openaiMaxRetries: 0,
  });
  globalThis.fetch = (async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    if (url.startsWith("https://login.microsoftonline.com/")) {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: `token-${tokenRequests.length}`, expires_in: 3600 });
    }
    requests.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(await requestBodyText(init?.body)),
    });
    if (modelStatus !== 200)
      return Response.json({ error: { message: "refused" } }, { status: modelStatus });
    return Response.json({
      id: "resp-test",
      status: "completed",
      model: "reasoning-deployment",
      output: [],
    });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setSystemTime();
  resetSharedAzureEntraAccessTokenSources();
  await rm(directory, { recursive: true, force: true });
});

test("built-in workload identity refreshes and rereads the projected token across a long session", async () => {
  const start = new Date("2026-10-25T12:00:00Z").getTime();
  setSystemTime(start);
  const provider = configuredProviders(settings)[0]!;
  const client = buildProviderClient(provider, settings);
  const send = () =>
    client.responses.create({
      model: "reasoning-deployment",
      input: "hello",
      reasoning: { effort: "high" },
    });
  await send();
  setSystemTime(start + 54 * 60_000);
  await send();
  await writeFile(settings.azureFederatedTokenFile!, "projected-assertion-2");
  setSystemTime(start + 55 * 60_000);
  await send();
  setSystemTime(start + 3 * 3_600_000);
  // Compaction's direct-settings path shares the same current token source.
  await buildOpenAIClientFromSettings(settings).responses.create({
    model: "reasoning-deployment",
    input: "summary",
  });
  expect(tokenRequests.map((body) => body.get("client_assertion"))).toEqual([
    "projected-assertion-1",
    "projected-assertion-2",
    "projected-assertion-2",
  ]);
  expect(
    tokenRequests.every(
      (body) =>
        body.get("scope") === "https://cognitiveservices.azure.com/.default" &&
        !body.has("client_secret"),
    ),
  ).toBe(true);
  expect(requests.map(({ headers }) => headers.get("authorization"))).toEqual([
    "Bearer token-1",
    "Bearer token-1",
    "Bearer token-2",
    "Bearer token-3",
  ]);
  expect(requests.every(({ headers }) => !headers.has("api-key"))).toBe(true);
  expect(requests[0]!.body.reasoning).toEqual({ effort: "high" });
});

test("a refused built-in token is discarded without replaying the model request", async () => {
  const client = buildProviderClient(configuredProviders(settings)[0]!, settings);
  modelStatus = 401;
  const failure = await client.responses
    .create({ model: "reasoning-deployment", input: "hello" })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ status: 401 });
  modelStatus = 200;
  await client.responses.create({ model: "reasoning-deployment", input: "again" });
  expect(requests).toHaveLength(2);
  expect(tokenRequests).toHaveLength(2);
  expect(requests[1]!.headers.get("authorization")).toBe("Bearer token-2");
});

test("client-secret deployment identity refreshes bearer tokens without a token file or API key", async () => {
  const start = new Date("2026-10-25T12:00:00Z").getTime();
  setSystemTime(start);
  const identitySettings = {
    ...settings,
    azureOpenaiAuthMode: "deployment_identity" as const,
    azureFederatedTokenFile: undefined,
    azureClientSecret: "fake-deployment-client-secret",
  };
  const provider = configuredProviders(identitySettings)[0]!;
  expect(provider.apiKey).toBeUndefined();
  expect(identitySettings.azureOpenaiDeploymentIdentityEnabled).toBe(false);
  const client = buildProviderClient(provider, identitySettings);
  const send = () =>
    client.responses.create({
      model: "reasoning-deployment",
      input: "hello",
      reasoning: { effort: "high" },
    });
  await send();
  setSystemTime(start + 54 * 60_000);
  await send();
  setSystemTime(start + 55 * 60_000);
  await send();
  setSystemTime(start + 3 * 3_600_000);
  await buildOpenAIClientFromSettings(identitySettings).responses.create({
    model: "reasoning-deployment",
    input: "summary",
  });
  expect(tokenRequests).toHaveLength(3);
  for (const body of tokenRequests) {
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      client_id: "client",
      client_secret: identitySettings.azureClientSecret,
      scope: "https://cognitiveservices.azure.com/.default",
    });
  }
  expect(requests.map(({ headers }) => headers.get("authorization"))).toEqual([
    "Bearer token-1",
    "Bearer token-1",
    "Bearer token-2",
    "Bearer token-3",
  ]);
  expect(requests.every(({ headers }) => !headers.has("api-key"))).toBe(true);
  expect(requests[0]!.body.reasoning).toEqual({ effort: "high" });
  expect(JSON.stringify(requests)).not.toContain(identitySettings.azureClientSecret);
});

test("client-secret rotation creates a fresh built-in client and token source", async () => {
  const firstSettings = {
    ...settings,
    azureOpenaiAuthMode: "deployment_identity" as const,
    azureFederatedTokenFile: undefined,
    azureClientSecret: "first-secret",
  };
  const secondSettings = { ...firstSettings, azureClientSecret: "replacement-secret" };
  const first = buildProviderClient(configuredProviders(firstSettings)[0]!, firstSettings);
  const second = buildProviderClient(configuredProviders(secondSettings)[0]!, secondSettings);
  expect(first).not.toBe(second);
  await first.responses.create({ model: "reasoning-deployment", input: "a" });
  await second.responses.create({ model: "reasoning-deployment", input: "b" });
  expect(tokenRequests.map((body) => body.get("client_secret"))).toEqual([
    "first-secret",
    "replacement-secret",
  ]);
  expect(requests.map(({ headers }) => headers.get("authorization"))).toEqual([
    "Bearer token-1",
    "Bearer token-2",
  ]);
});

test("deployment identity uses the shared federated-file precedence rather than the client secret", async () => {
  const identitySettings = {
    ...settings,
    azureOpenaiAuthMode: "deployment_identity" as const,
    azureClientSecret: "unused-secret",
  };
  await buildOpenAIClientFromSettings(identitySettings).responses.create({
    model: "reasoning-deployment",
    input: "hello",
  });
  expect(tokenRequests[0]!.get("client_assertion")).toBe("projected-assertion-1");
  expect(tokenRequests[0]!.has("client_secret")).toBe(false);
});

test("changing identity invalidates the built-in client cache", async () => {
  const first = buildProviderClient(configuredProviders(settings)[0]!, settings);
  const otherSettings = { ...settings, azureClientId: "other-client" };
  const second = buildProviderClient(configuredProviders(otherSettings)[0]!, otherSettings);
  expect(first).not.toBe(second);
  await first.responses.create({ model: "reasoning-deployment", input: "a" });
  await second.responses.create({ model: "reasoning-deployment", input: "b" });
  expect(tokenRequests.map((body) => body.get("client_id"))).toEqual(["client", "other-client"]);
});

test("an unreadable projected token fails closed without a key or developer-login fallback", async () => {
  const unavailable = { ...settings, azureFederatedTokenFile: join(directory, "missing-token") };
  const failure = await buildOpenAIClientFromSettings(unavailable)
    .responses.create({ model: "reasoning-deployment", input: "hello" })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(tokenRequests).toHaveLength(0);
  expect(requests).toHaveLength(0);
});

test("endpoint/deployment mode keeps its api-version with identity authentication", async () => {
  const endpointSettings = {
    ...settings,
    azureOpenaiBaseUrl: undefined,
    azureOpenaiEndpoint: "https://endpoint.openai.azure.com",
    azureOpenaiDeployment: "reasoning-deployment",
    azureOpenaiApiVersion: "2025-04-01-preview",
  };
  await buildOpenAIClientFromSettings(endpointSettings).responses.create({
    model: "reasoning-deployment",
    input: "hello",
  });
  expect(new URL(requests[0]!.url).searchParams.get("api-version")).toBe("2025-04-01-preview");
  expect(requests[0]!.headers.get("api-key")).toBeNull();
});

test("system and user-assigned managed identities use the SDK endpoint, Cognitive Services audience and refresh", async () => {
  const previousEndpoint = process.env.IDENTITY_ENDPOINT;
  const previousHeader = process.env.IDENTITY_HEADER;
  const identityRequests: URL[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      identityRequests.push(new URL(request.url));
      expect(request.headers.get("x-identity-header")).toBe("fake-identity-header");
      return Response.json({
        access_token: `managed-${identityRequests.length}`,
        expires_on: String(Math.floor(Date.now() / 1000) + 3600),
        resource: "https://cognitiveservices.azure.com",
        token_type: "Bearer",
      });
    },
  });
  process.env.IDENTITY_ENDPOINT = `${server.url}identity`;
  process.env.IDENTITY_HEADER = "fake-identity-header";
  try {
    const start = Date.now();
    for (const clientId of [undefined, "00000000-0000-4000-8000-000000000001"]) {
      setSystemTime(start);
      identityRequests.length = 0;
      requests = [];
      const managedSettings = {
        ...settings,
        azureOpenaiAuthMode: "managed_identity" as const,
        azureClientId: clientId,
        azureFederatedTokenFile: undefined,
      };
      const client = buildProviderClient(configuredProviders(managedSettings)[0]!, managedSettings);
      const send = () => client.responses.create({ model: "reasoning-deployment", input: "hello" });
      await send();
      await send();
      expect(identityRequests).toHaveLength(1);
      // Refusal discards both the wrapper cache and the SDK credential's cache.
      modelStatus = 401;
      expect(await send().catch((error: unknown) => error)).toMatchObject({ status: 401 });
      modelStatus = 200;
      await send();
      expect(identityRequests).toHaveLength(2);
      expect(identityRequests[0]!.searchParams.get("client_id")).toBe(
        managedSettings.azureClientId ?? null,
      );
      expect(identityRequests[0]!.searchParams.get("resource")).toBe(
        "https://cognitiveservices.azure.com",
      );
      expect(requests.at(-1)!.headers.get("authorization")).toBe("Bearer managed-2");
      setSystemTime(Date.now() + 55 * 60_000);
      await send();
      expect(identityRequests).toHaveLength(3);
      expect(requests.at(-1)!.headers.get("authorization")).toBe("Bearer managed-3");
      expect(requests.every(({ headers }) => !headers.has("api-key"))).toBe(true);
    }
  } finally {
    server.stop(true);
    if (previousEndpoint === undefined) delete process.env.IDENTITY_ENDPOINT;
    else process.env.IDENTITY_ENDPOINT = previousEndpoint;
    if (previousHeader === undefined) delete process.env.IDENTITY_HEADER;
    else process.env.IDENTITY_HEADER = previousHeader;
  }
});

test.each(["builtin", "builtin-client-secret", "organization-key", "organization-entra"] as const)(
  "%s keeps high reasoning in the agent and title request",
  async (kind) => {
    const input = {
      endpoint: "https://organization.openai.azure.com/openai/v1",
      models: [{ upstreamModelId: "reasoning-deployment" }],
    };
    const routedSettings =
      kind === "organization-key"
        ? withOrganizationAzureOpenAICredential(settings, "organization-key", input)
        : kind === "organization-entra"
          ? withOrganizationAzureOpenAIEntraCredential(
              settings,
              {
                source: "client_secret",
                tenantId: "org-tenant",
                clientId: "org-client",
                clientSecret: "org-secret",
              },
              input,
            )
          : kind === "builtin-client-secret"
            ? {
                ...settings,
                azureOpenaiAuthMode: "deployment_identity" as const,
                azureFederatedTokenFile: undefined,
                azureClientSecret: "fake-deployment-secret",
              }
            : settings;
    const modelId =
      kind === "builtin" || kind === "builtin-client-secret"
        ? "reasoning-deployment"
        : "organization-azure-openai/reasoning-deployment";
    const { provider, model } = resolveModelProvider(routedSettings, modelId);
    expect(model.capabilities.reasoning.runnable).toBe(true);
    const agent = buildOpenGeniAgent(routedSettings, { model: modelId, reasoningEffort: "high" });
    expect(agent.modelSettings.reasoning?.effort).toBe("high");
    const client = buildProviderClient(provider, routedSettings);
    await getOrCreateTrace(() =>
      buildModelInstance(provider, client, model.upstreamModelId).getResponse({
        input: "hello",
        modelSettings: agent.modelSettings,
        tools: [],
        handoffs: [],
        outputType: "text",
        tracing: false,
      } as never),
    );
    await runSingleModelCall(
      {
        client,
        provider,
        modelId: model.upstreamModelId,
      },
      { messages: [{ role: "user", content: "title" }], reasoningEffort: "high" },
    );
    expect(requests[0]!.body.reasoning).toMatchObject({ effort: "high" });
    expect(requests[1]!.body.reasoning).toEqual({ effort: "high" });
    expect(requests[0]!.body.model).toBe("reasoning-deployment");
  },
);
