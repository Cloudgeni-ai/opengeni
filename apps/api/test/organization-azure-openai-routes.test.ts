import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { ApiRouteDeps } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import * as codexRoutes from "../src/routes/codex";
import { registerOrganizationModelProviderRoutes } from "../src/routes/organization-model-providers";

const ORGANIZATION = "00000000-0000-4000-8000-0000000000a1";
const ADMIN = "user:organization-admin";
const KEY = "azure-org-secret-key-value";
const ENDPOINT = "https://contoso.openai.azure.com/openai/v1";
const BASE = `/v1/organizations/${ORGANIZATION}/model-providers`;
// Fake Microsoft Entra ID app registration; never a real tenant.
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const CLIENT_SECRET = "fake-entra-client-secret-value";

const browser = {
  "content-type": "application/json",
  origin: "https://opengeni.test",
  "sec-fetch-site": "same-origin",
};

function connection(overrides: Partial<opengeniDb.OrganizationModelProviderConnection> = {}) {
  return {
    providerKind: "azure_openai" as const,
    status: "active" as const,
    version: 1,
    endpoint: ENDPOINT,
    authMethod: "api_key" as opengeniDb.OrganizationModelProviderAuthMethod,
    createdAt: new Date("2026-10-17T00:00:00.000Z"),
    updatedAt: new Date("2026-10-17T00:00:00.000Z"),
    ...overrides,
  };
}

describe("organization Azure OpenAI provider routes", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let upsert: ReturnType<
    typeof spyOn<typeof opengeniDb, "upsertOrganizationModelProviderConnection">
  >;
  let create: ReturnType<
    typeof spyOn<typeof opengeniDb, "createOrganizationModelProviderCustomModel">
  >;
  let credential: ReturnType<
    typeof spyOn<typeof opengeniDb, "loadOrganizationModelProviderCredentialForAdministrator">
  >;
  let upstream: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>;
  let upstreamStatus: number;
  let tokenRequests: Array<{ url: string; body: URLSearchParams }>;
  let tokenStatus: number;
  let app: Hono;

  function mount(overrides: Partial<Settings> = {}) {
    const settings = testSettings({
      productAccessMode: "managed",
      publicBaseUrl: "https://opengeni.test",
      environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      ...overrides,
    });
    app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    registerOrganizationModelProviderRoutes(app, {
      db: {} as opengeniDb.Database,
      settings,
      directModelFetch: (async (url: string, init: RequestInit) => {
        if (url.startsWith("https://login.microsoftonline.com/")) {
          tokenRequests.push({ url, body: new URLSearchParams(String(init.body)) });
          return tokenStatus === 200
            ? Response.json({ access_token: "fake-entra-access-token", expires_in: 3600 })
            : Response.json(
                {
                  error: "invalid_client",
                  error_description: `AADSTS7000215: Invalid client secret ${CLIENT_SECRET}`,
                  error_codes: [7000215],
                },
                { status: tokenStatus },
              );
        }
        upstream.push({
          url,
          headers: new Headers(init.headers),
          body: JSON.parse(init.body as string),
        });
        return upstreamStatus === 200
          ? Response.json({ status: "completed" })
          : Response.json(
              { error: { message: `upstream detail ${KEY}` } },
              { status: upstreamStatus },
            );
      }) as typeof fetch,
    } as unknown as ApiRouteDeps);
  }

  beforeEach(() => {
    upstream = [];
    upstreamStatus = 200;
    tokenRequests = [];
    tokenStatus = 200;
    upsert = spyOn(opengeniDb, "upsertOrganizationModelProviderConnection").mockImplementation(
      async (_db, input) =>
        connection({
          providerKind: input.providerKind,
          endpoint: input.endpoint ?? null,
          authMethod: input.authMethod ?? "api_key",
        }),
    );
    create = spyOn(opengeniDb, "createOrganizationModelProviderCustomModel").mockImplementation(
      async (_db, input) => ({
        id: "00000000-0000-4000-8000-0000000000b1",
        accountId: ORGANIZATION,
        providerKind: input.providerKind,
        upstreamModelId: input.upstreamModelId,
        label: input.label ?? null,
        version: 1,
        retiredAt: null,
        createdAt: new Date("2026-10-17T00:00:00.000Z"),
        updatedAt: new Date("2026-10-17T00:00:00.000Z"),
      }),
    );
    credential = spyOn(
      opengeniDb,
      "loadOrganizationModelProviderCredentialForAdministrator",
    ).mockResolvedValue({ apiKey: KEY, endpoint: ENDPOINT });
    spies.push(
      upsert,
      create,
      credential,
      spyOn(codexRoutes, "requireOrganizationCodexHuman").mockResolvedValue({
        subjectId: ADMIN,
        browserSessionHash: "hash",
      } as never),
    );
    mount();
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const put = async (kind: string, body: Record<string, unknown>) =>
    await app.request(`${BASE}/${kind}`, {
      method: "PUT",
      headers: browser,
      body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion: 0, ...body }),
    });

  test("Azure requires its resource endpoint and stores it normalized beside the key", async () => {
    const missing = await put("azure_openai", { apiKey: KEY });
    expect(missing.status).toBe(422);
    expect(upsert).not.toHaveBeenCalled();

    for (const endpoint of [
      "https://proxy.example.com",
      "http://contoso.openai.azure.com",
      "https://contoso.openai.azure.com/other",
    ]) {
      expect((await put("azure_openai", { apiKey: KEY, endpoint })).status).toBe(422);
    }
    expect(upsert).not.toHaveBeenCalled();

    const saved = await put("azure_openai", {
      apiKey: KEY,
      endpoint: "https://contoso.openai.azure.com",
    });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({
      providerKind: "azure_openai",
      status: "active",
      endpoint: ENDPOINT,
    });
    const input = upsert.mock.calls.at(-1)![1];
    expect(input).toMatchObject({ providerKind: "azure_openai", endpoint: ENDPOINT });
    expect(input.credentialEncrypted).not.toContain(KEY);
    expect(input.credentialDigest).toBe(opengeniDb.organizationModelProviderCredentialDigest(KEY));
  });

  test("other organization providers refuse an endpoint and never return one", async () => {
    const refused = await put("openrouter", { apiKey: "sk-or-v1-key", endpoint: ENDPOINT });
    expect(refused.status).toBe(422);
    expect(upsert).not.toHaveBeenCalled();
    const saved = await put("openrouter", { apiKey: "sk-or-v1-key" });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).not.toHaveProperty("endpoint");
    expect(upsert.mock.calls.at(-1)![1]).not.toHaveProperty("endpoint");
  });

  const addDeployment = async (upstreamModelId: string) =>
    await app.request(`${BASE}/azure_openai/custom-models`, {
      method: "POST",
      headers: browser,
      body: JSON.stringify({ operationId: crypto.randomUUID(), upstreamModelId }),
    });

  test("a deployment is verified on the organization endpoint before it is saved", async () => {
    const response = await addDeployment("gpt-6.1-sol");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ upstreamModelId: "gpt-6.1-sol" });
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe(`${ENDPOINT}/responses`);
    expect(upstream[0]!.headers.get("api-key")).toBe(KEY);
    expect(upstream[0]!.body).toMatchObject({ model: "gpt-6.1-sol", store: false });
    expect(credential.mock.calls.at(-1)![2]).toEqual({
      organizationId: ORGANIZATION,
      actorSubjectId: ADMIN,
      providerKind: "azure_openai",
    });
    expect(create.mock.calls.at(-1)![1]).toMatchObject({
      providerKind: "azure_openai",
      upstreamModelId: "gpt-6.1-sol",
    });
  });

  test("a failed deployment check is a safe 422 and saves nothing", async () => {
    upstreamStatus = 404;
    const response = await addDeployment("missing-deployment");
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toContain("deployment");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("upstream detail");
    expect(create).not.toHaveBeenCalled();
  });

  test("an invalid deployment name or a missing connection never calls Azure", async () => {
    expect((await addDeployment("bad/deployment")).status).toBe(422);
    credential.mockResolvedValue(null);
    expect((await addDeployment("gpt-6.1-sol")).status).toBe(409);
    expect(upstream).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  test("other organization custom models are saved without an Azure check", async () => {
    const response = await app.request(`${BASE}/openrouter/custom-models`, {
      method: "POST",
      headers: browser,
      body: JSON.stringify({ operationId: crypto.randomUUID(), upstreamModelId: "vendor/model" }),
    });
    expect(response.status).toBe(201);
    expect(upstream).toHaveLength(0);
    expect(credential).not.toHaveBeenCalled();
  });

  test("mutations keep the same-origin browser guard", async () => {
    const response = await app.request(`${BASE}/azure_openai`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: crypto.randomUUID(), apiKey: KEY, endpoint: ENDPOINT }),
    });
    expect(response.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  const entraApp = {
    method: "entra_client_secret",
    tenantId: TENANT,
    clientId: CLIENT,
    clientSecret: CLIENT_SECRET,
  };

  test("an Entra app connection signs in once, stores the secret encrypted and never returns it", async () => {
    const saved = await put("azure_openai", { authentication: entraApp, endpoint: ENDPOINT });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(CLIENT_SECRET);
    expect(JSON.parse(text)).toMatchObject({
      providerKind: "azure_openai",
      endpoint: ENDPOINT,
      authMethod: "entra_client_secret",
    });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.url).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    );
    expect(tokenRequests[0]!.body.get("client_id")).toBe(CLIENT);
    expect(tokenRequests[0]!.body.get("scope")).toBe(
      "https://cognitiveservices.azure.com/.default",
    );
    const input = upsert.mock.calls.at(-1)![1];
    expect(input.authMethod).toBe("entra_client_secret");
    expect(input.credentialEncrypted).not.toContain(CLIENT_SECRET);
    expect(input.credentialEncrypted).not.toContain(CLIENT);
    // The stored document decrypts back to exactly this app.
    const key = Buffer.alloc(32, 9);
    expect(JSON.parse(opengeniDb.decryptEnvironmentValue(key, input.credentialEncrypted))).toEqual({
      version: 1,
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: CLIENT_SECRET,
    });
    expect(upstream).toHaveLength(0);
  });

  test("a refused Entra app is a safe 422 and saves nothing", async () => {
    tokenStatus = 401;
    const response = await put("azure_openai", { authentication: entraApp, endpoint: ENDPOINT });
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toContain("didn’t accept this app");
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain("AADSTS");
    expect(upsert).not.toHaveBeenCalled();
  });

  test("a key and an Entra sign-in together, or Entra for another provider, are refused", async () => {
    expect(
      (await put("azure_openai", { apiKey: KEY, authentication: entraApp, endpoint: ENDPOINT }))
        .status,
    ).toBe(422);
    expect((await put("azure_openai", { endpoint: ENDPOINT })).status).toBe(422);
    expect((await put("openai", { authentication: entraApp })).status).toBe(422);
    expect(
      (
        await put("azure_openai", {
          authentication: { ...entraApp, clientId: "not-an-application-id" },
          endpoint: ENDPOINT,
        })
      ).status,
    ).toBe(422);
    expect(tokenRequests).toHaveLength(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  test("no organization can claim the deployment identity unless the operator offers it", async () => {
    const deploymentIdentity = {
      azureTenantId: "99999999-8888-4777-8666-555555555555",
      azureClientId: "44444444-3333-4222-8111-000000000000",
      azureClientSecret: "fake-deployment-secret",
    };
    // Configured but not offered, then offered but not configured: both refused.
    for (const overrides of [
      deploymentIdentity,
      { azureOpenaiDeploymentIdentityEnabled: true },
    ] satisfies Partial<Settings>[]) {
      mount(overrides);
      const refused = await put("azure_openai", {
        authentication: { method: "entra_deployment_identity" },
        endpoint: ENDPOINT,
      });
      expect(refused.status).toBe(422);
      expect(await refused.text()).toContain("doesn’t offer its own identity");
    }
    expect(tokenRequests).toHaveLength(0);
    expect(upsert).not.toHaveBeenCalled();

    mount({ ...deploymentIdentity, azureOpenaiDeploymentIdentityEnabled: true });
    const saved = await put("azure_openai", {
      authentication: { method: "entra_deployment_identity" },
      endpoint: ENDPOINT,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ authMethod: "entra_deployment_identity" });
    expect(tokenRequests[0]!.body.get("client_id")).toBe(deploymentIdentity.azureClientId);
    const input = upsert.mock.calls.at(-1)![1];
    expect(input.authMethod).toBe("entra_deployment_identity");
    expect(
      opengeniDb.decryptEnvironmentValue(Buffer.alloc(32, 9), input.credentialEncrypted),
    ).not.toContain(deploymentIdentity.azureClientSecret);
  });

  test("a deployment is verified with an Entra bearer token, never an api-key", async () => {
    credential.mockResolvedValue({
      azureEntra: {
        source: "client_secret",
        tenantId: TENANT,
        clientId: CLIENT,
        clientSecret: CLIENT_SECRET,
      },
      endpoint: ENDPOINT,
    });
    const response = await addDeployment("gpt-6.1-sol");
    expect(response.status).toBe(201);
    expect(tokenRequests).toHaveLength(1);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get("authorization")).toBe("Bearer fake-entra-access-token");
    expect(upstream[0]!.headers.get("api-key")).toBeNull();

    upstreamStatus = 403;
    const refused = await addDeployment("gpt-6.1-luna");
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("Cognitive Services OpenAI User");
  });
});
