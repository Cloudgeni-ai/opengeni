import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  configuredProviders,
  ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
  withOrganizationAzureOpenAICredential,
  withOrganizationAzureOpenAIEntraCredential,
  type AzureEntraProviderCredential,
  type Settings,
} from "@opengeni/config";
import { resetSharedAzureEntraAccessTokenSources } from "@opengeni/network/azure-entra";
import { testSettings } from "@opengeni/testing";

import {
  buildProviderClient,
  OrganizationAzureOpenAIUnavailableError,
} from "../src/model-provider";

// Fake credentials only; the token endpoint and Azure are stubbed below.
const ENDPOINT = "https://organization-azure-entra-runtime.openai.azure.com/openai/v1";
const DEPLOYMENT = "gpt-6.1-sol";
const models = [{ upstreamModelId: DEPLOYMENT }];
const ORG_APP: AzureEntraProviderCredential = {
  source: "client_secret",
  tenantId: "11111111-2222-4333-8444-555555555555",
  clientId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  clientSecret: "fake-organization-client-secret",
};
const DEPLOYMENT_IDENTITY = {
  azureTenantId: "99999999-8888-4777-8666-555555555555",
  azureClientId: "44444444-3333-4222-8111-000000000000",
  azureClientSecret: "fake-deployment-client-secret",
} satisfies Partial<Settings>;

const originalFetch = globalThis.fetch;
let tokenRequests: URLSearchParams[];
let modelRequests: Headers[];
let issued: number;
let tokenStatus: number;
let modelStatuses: number[];

beforeEach(() => {
  resetSharedAzureEntraAccessTokenSources();
  tokenRequests = [];
  modelRequests = [];
  issued = 0;
  tokenStatus = 200;
  modelStatuses = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://login.microsoftonline.com/")) {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      if (tokenStatus !== 200)
        return Response.json(
          { error: "invalid_client", error_codes: [7000215] },
          { status: tokenStatus },
        );
      issued += 1;
      return Response.json({ access_token: `entra-token-${issued}`, expires_in: 3600 });
    }
    modelRequests.push(new Headers(init?.headers));
    const status = modelStatuses.shift() ?? 200;
    if (status !== 200) return Response.json({ error: { message: "token expired" } }, { status });
    return Response.json({
      id: `resp-${modelRequests.length}`,
      object: "response",
      created_at: 0,
      status: "completed",
      model: DEPLOYMENT,
      output: [],
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
  resetSharedAzureEntraAccessTokenSources();
});

function entraClient(credential: AzureEntraProviderCredential, overrides: Partial<Settings> = {}) {
  const settings = withOrganizationAzureOpenAIEntraCredential(
    testSettings({
      openaiApiKey: "sk-deployment-must-not-leak",
      openaiMaxRetries: 0,
      ...overrides,
    }),
    credential,
    { endpoint: ENDPOINT, models },
  );
  const provider = configuredProviders(settings).find(
    (candidate) => candidate.id === ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
  )!;
  return { settings, provider };
}

describe("organization Azure OpenAI with Microsoft Entra ID", () => {
  test("signs every request with a cached bearer token instead of an api-key", async () => {
    const { settings, provider } = entraClient(ORG_APP);
    expect(provider.apiKey).toBeUndefined();
    const client = buildProviderClient(provider, settings);
    await client.responses.create({ model: DEPLOYMENT, input: "hello" });
    await client.responses.create({ model: DEPLOYMENT, input: "again" });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.get("client_id")).toBe(ORG_APP.clientId);
    expect(tokenRequests[0]!.get("client_secret")).toBe(ORG_APP.clientSecret);
    expect(tokenRequests[0]!.get("scope")).toBe("https://cognitiveservices.azure.com/.default");
    expect(modelRequests).toHaveLength(2);
    for (const headers of modelRequests) {
      expect(headers.get("authorization")).toBe("Bearer entra-token-1");
      expect(headers.get("api-key")).toBeNull();
      expect(JSON.stringify([...headers])).not.toContain("sk-deployment-must-not-leak");
      expect(JSON.stringify([...headers])).not.toContain(ORG_APP.clientSecret);
    }
  });

  test("refreshes the token before it expires, across a long-running session", async () => {
    const start = new Date("2026-10-25T12:00:00.000Z");
    setSystemTime(start);
    const { settings, provider } = entraClient(ORG_APP);
    const client = buildProviderClient(provider, settings);
    await client.responses.create({ model: DEPLOYMENT, input: "first" });
    // Still well inside the hour: the cached token is reused.
    setSystemTime(new Date(start.getTime() + 30 * 60_000));
    await client.responses.create({ model: DEPLOYMENT, input: "half an hour in" });
    // Inside the refresh margin before expiry: a new token, before Azure rejects the old one.
    setSystemTime(new Date(start.getTime() + 57 * 60_000));
    await client.responses.create({ model: DEPLOYMENT, input: "near expiry" });
    // Well past the first token's expiry: still signed with a valid one.
    setSystemTime(new Date(start.getTime() + 3 * 60 * 60_000));
    await client.responses.create({ model: DEPLOYMENT, input: "hours later" });
    expect(modelRequests.map((headers) => headers.get("authorization"))).toEqual([
      "Bearer entra-token-1",
      "Bearer entra-token-1",
      "Bearer entra-token-2",
      "Bearer entra-token-3",
    ]);
  });

  test("a token Azure refuses is discarded, so the next request signs in again", async () => {
    const { settings, provider } = entraClient(ORG_APP);
    const client = buildProviderClient(provider, settings);
    modelStatuses = [401];
    const refused = await client.responses
      .create({ model: DEPLOYMENT, input: "hello" })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 401 });
    await client.responses.create({ model: DEPLOYMENT, input: "hello again" });
    expect(modelRequests.map((headers) => headers.get("authorization"))).toEqual([
      "Bearer entra-token-1",
      "Bearer entra-token-2",
    ]);
  });

  test("an app Entra refuses fails as the connection's reconnect error without calling Azure", async () => {
    tokenStatus = 401;
    const { settings, provider } = entraClient(ORG_APP);
    const client = buildProviderClient(provider, settings);
    const failure = await client.responses
      .create({ model: DEPLOYMENT, input: "hello" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 401 });
    expect(String((failure as Error).message)).toContain(
      new OrganizationAzureOpenAIUnavailableError().message,
    );
    expect(tokenRequests).toHaveLength(1);
    expect(modelRequests).toHaveLength(0);
  });

  test("the deployment identity is used only while the operator offers it", async () => {
    const deploymentIdentity: AzureEntraProviderCredential = { source: "deployment_identity" };
    // Configured but not offered, or offered but not configured: fails closed.
    for (const overrides of [
      DEPLOYMENT_IDENTITY,
      { azureOpenaiDeploymentIdentityEnabled: true },
    ] satisfies Partial<Settings>[]) {
      const { settings, provider } = entraClient(deploymentIdentity, overrides);
      expect(provider.azureEntra).toBeUndefined();
      expect(() => buildProviderClient(provider, settings)).toThrow(
        OrganizationAzureOpenAIUnavailableError,
      );
      // Even a provider that names it is refused while the operator does not offer it.
      expect(() =>
        buildProviderClient({ ...provider, azureEntra: deploymentIdentity }, settings),
      ).toThrow(OrganizationAzureOpenAIUnavailableError);
    }
    expect(tokenRequests).toHaveLength(0);

    const { settings, provider } = entraClient(deploymentIdentity, {
      ...DEPLOYMENT_IDENTITY,
      azureOpenaiDeploymentIdentityEnabled: true,
    });
    await buildProviderClient(provider, settings).responses.create({
      model: DEPLOYMENT,
      input: "hello",
    });
    expect(tokenRequests[0]!.get("client_id")).toBe(DEPLOYMENT_IDENTITY.azureClientId);
    expect(modelRequests[0]!.get("authorization")).toBe("Bearer entra-token-1");
  });

  test("one organization's app never signs another's requests", async () => {
    const other: AzureEntraProviderCredential = {
      ...ORG_APP,
      clientSecret: "fake-other-organization-secret",
    };
    const first = entraClient(ORG_APP);
    const second = entraClient(other);
    await buildProviderClient(first.provider, first.settings).responses.create({
      model: DEPLOYMENT,
      input: "a",
    });
    await buildProviderClient(second.provider, second.settings).responses.create({
      model: DEPLOYMENT,
      input: "b",
    });
    expect(tokenRequests.map((body) => body.get("client_secret"))).toEqual([
      ORG_APP.clientSecret,
      "fake-other-organization-secret",
    ]);
    expect(modelRequests.map((headers) => headers.get("authorization"))).toEqual([
      "Bearer entra-token-1",
      "Bearer entra-token-2",
    ]);
  });

  test("API-key connections still send only the api-key header", async () => {
    const settings = withOrganizationAzureOpenAICredential(testSettings(), "azure-org-key", {
      endpoint: ENDPOINT,
      models,
    });
    const provider = configuredProviders(settings).find(
      (candidate) => candidate.id === ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
    )!;
    expect(provider.azureEntra).toBeUndefined();
    await buildProviderClient(provider, settings).responses.create({
      model: DEPLOYMENT,
      input: "hello",
    });
    expect(tokenRequests).toHaveLength(0);
    expect(modelRequests[0]!.get("api-key")).toBe("azure-org-key");
    expect(modelRequests[0]!.get("authorization")).toBeNull();
  });
});
