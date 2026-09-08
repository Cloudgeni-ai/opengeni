import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import {
  GOOGLE_DRIVE_INTEGRATION_DEFINITION,
  MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION,
  MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
} from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import {
  API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";

import { createApp } from "../src/app";
import { requireAccessGrantAuthorization } from "@opengeni/core";
import { requireWorkspaceToolGatewayAuthorization } from "../src/workspace-tool-gateway";

const DELEGATION_SECRET = "api-integration-provider-oauth-delegation";
const STATE_SECRET = "api-integration-provider-oauth-state";
const EDGE_ACCESS_KEY = "api-integration-provider-oauth-edge";
const GOOGLE_CLIENT_ID = "google-provider-client.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "google-provider-client-secret";
const MICROSOFT_CLIENT_ID = "microsoft-provider-client";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;
const workspaceIds: string[] = [];

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_API_INTEGRATION_PROVIDER_OAUTH_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_API_INTEGRATION_PROVIDER_OAUTH_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_API_INTEGRATION_PROVIDER_OAUTH_TEST_POSTGRES_ADMIN_URL and OPENGENI_API_INTEGRATION_PROVIDER_OAUTH_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  if (adminUrl && appUrl) {
    await migrate(adminUrl);
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => await admin.end().catch(() => undefined),
    };
  } else {
    shared = await acquireSharedTestDatabase("api_integration_provider_oauth");
  }
  if (!shared) {
    available = false;
    console.warn("[api-integration-provider-oauth] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    authRequired: true,
    accessKey: EDGE_ACCESS_KEY,
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "http://127.0.0.1:8000",
    webBaseUrl: "http://127.0.0.1:3000",
    googleDriveClientId: GOOGLE_CLIENT_ID,
    googleDriveClientSecret: GOOGLE_CLIENT_SECRET,
    integrationsOauthClientsJson: JSON.stringify({
      "https://login.microsoftonline.com/common/v2.0": {
        clientId: MICROSOFT_CLIENT_ID,
        tokenEndpointAuthMethod: "none",
      },
    }),
  }) as Settings;
}, 180_000);

afterAll(async () => {
  for (const workspaceId of workspaceIds) {
    await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function freshWorkspace() {
  const subjectId = `user:provider-oauth-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `provider-oauth-account-${crypto.randomUUID()}`,
    accountName: "Provider OAuth account",
    workspaceExternalSource: "test",
    workspaceExternalId: `provider-oauth-workspace-${crypto.randomUUID()}`,
    workspaceName: "Provider OAuth workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  workspaceIds.push(grant.workspaceId);
  return { accountId: grant.accountId, workspaceId: grant.workspaceId, subjectId };
}

async function bearer(
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  principalKind: "human_session" | "service" = "human_session",
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: workspace.subjectId,
    permissions: ["connections:read", "connections:write", "workspace:read"],
    principalKind,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

type TokenPlan = {
  scopes: string[];
  refreshToken?: string;
};

function providerFixture() {
  let sourceTitle = "Drive fixture";
  let beforeGoogleTokenReply: (() => Promise<void>) | undefined;
  const googlePlans: TokenPlan[] = [];
  const microsoftPlans: TokenPlan[] = [];
  const tokenRequests: Array<{
    family: "google" | "microsoft";
    body: URLSearchParams;
    authorization: string | null;
  }> = [];
  let googlePrincipalId = "google-principal-1";
  let microsoftPrincipalId = "microsoft-principal-1";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === "https://www.googleapis.com/fixture-openapi.json")
      return Response.json({
        openapi: "3.0.3",
        info: { title: "Public fixture", version: "1" },
        servers: [{ url: "https://www.googleapis.com" }],
        paths: {
          "/items": {
            get: { operationId: "listItems", responses: { "200": { description: "Items" } } },
          },
        },
      });
    if (url.href === GOOGLE_DRIVE_INTEGRATION_DEFINITION.source.url) {
      return Response.json({
        name: "drive",
        version: "v3",
        title: sourceTitle,
        rootUrl: "https://www.googleapis.com/",
        servicePath: "drive/v3/",
        resources: {
          files: {
            methods: {
              list: {
                id: "drive.files.list",
                path: "files",
                httpMethod: "GET",
                description: "List files",
                response: { $ref: "FileList" },
              },
              get: {
                id: "drive.files.get",
                path: "files/{fileId}",
                httpMethod: "GET",
                description: "Get file",
                parameters: { fileId: { type: "string", required: true, location: "path" } },
                response: { $ref: "File" },
              },
            },
          },
        },
        schemas: {
          File: { type: "object", properties: { id: { type: "string" } } },
          FileList: {
            type: "object",
            properties: { files: { type: "array", items: { $ref: "File" } } },
          },
        },
      });
    }
    if (url.href === GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.tokenUrl) {
      await beforeGoogleTokenReply?.();
      const body = requestBody(init?.body);
      tokenRequests.push({
        family: "google",
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const plan = googlePlans.shift() ?? {
        scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "google-refresh-token",
      };
      return Response.json({
        access_token: `google-access-${tokenRequests.length}`,
        ...(plan.refreshToken ? { refresh_token: plan.refreshToken } : {}),
        token_type: "Bearer",
        expires_in: 3600,
        scope: plan.scopes.join(" "),
      });
    }
    if (url.href === MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.authentication.tokenUrl) {
      const body = requestBody(init?.body);
      tokenRequests.push({
        family: "microsoft",
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const plan = microsoftPlans.shift() ?? {
        scopes: [...MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "microsoft-refresh-token",
      };
      return Response.json({
        access_token: `microsoft-access-${tokenRequests.length}`,
        ...(plan.refreshToken ? { refresh_token: plan.refreshToken } : {}),
        token_type: "Bearer",
        expires_in: 3600,
        scope: plan.scopes.join(" "),
      });
    }
    if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({
        sub: googlePrincipalId,
        email: "google.user@example.com",
        name: "Google User",
      });
    }
    if (url.origin === "https://graph.microsoft.com" && url.pathname === "/v1.0/me") {
      return Response.json({
        id: microsoftPrincipalId,
        mail: "microsoft.user@example.com",
        userPrincipalName: "microsoft.user@example.com",
        displayName: "Microsoft User",
      });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetch,
    setSourceTitle(value: string) {
      sourceTitle = value;
    },
    setBeforeGoogleTokenReply(hook: (() => Promise<void>) | undefined) {
      beforeGoogleTokenReply = hook;
    },
    googlePlans,
    microsoftPlans,
    tokenRequests,
    setGooglePrincipalId(value: string) {
      googlePrincipalId = value;
    },
    setMicrosoftPrincipalId(value: string) {
      microsoftPrincipalId = value;
    },
  };
}

function requestBody(body: BodyInit | null | undefined): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams(typeof body === "string" ? body : "");
}

function testApp(fixture: ReturnType<typeof providerFixture>) {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    apiIntegrationOAuthFetch: fixture.fetch,
    apiIntegrationSourceFetch: fixture.fetch,
  } as never);
}

async function start(
  fixture: ReturnType<typeof providerFixture>,
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  payload: Record<string, unknown>,
  principalKind: "human_session" | "service" = "human_session",
) {
  const response = await testApp(fixture).request(
    `/v1/workspaces/${workspace.workspaceId}/integrations/oauth/start`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, principalKind),
        "content-type": "application/json",
        "x-opengeni-access-key": EDGE_ACCESS_KEY,
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      },
      body: JSON.stringify(payload),
    },
  );
  const body = (await response.json()) as { authorizationUrl?: string; error?: unknown };
  return { response, authorizationUrl: body.authorizationUrl ?? "", body };
}

/**
 * The exact state an older deployment would have signed: a real state minted by
 * the (now fenced) start route, re-signed with the `personalOwnerVerified`
 * claim removed. Re-signing the genuine payload keeps every other field —
 * definition fingerprint, PKCE verifier, nonce — valid, so the callback's
 * refusal can only come from the missing claim.
 */
async function legacyProviderOAuthState(
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  payload: { definitionId: string; ownership: string; personalOwnerVerified?: boolean },
): Promise<string> {
  const started = await start(providerFixture(), workspace, {
    definitionId: payload.definitionId,
    ownership: payload.ownership,
  });
  const raw = new URL(started.authorizationUrl).searchParams.get("state")!;
  const decoded = readSignedState(raw, STATE_SECRET) as Record<string, unknown>;
  const { personalOwnerVerified: _dropped, ...withoutClaim } = decoded;
  return createSignedState(STATE_SECRET, {
    ...withoutClaim,
    ...(payload.personalOwnerVerified === true ? { personalOwnerVerified: true } : {}),
  });
}

async function callback(
  fixture: ReturnType<typeof providerFixture>,
  state: string,
  code = "fixture-code",
  path = "/v1/integrations/provider-oauth/callback",
) {
  return await testApp(fixture).request(
    `${path}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
}

describe("API Integration provider OAuth", () => {
  test("external curated OAuth encrypts actor context and refuses key revocation during exchange", async () => {
    if (!available) throw new Error("External OAuth acceptance requires PostgreSQL");
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const token = crypto.randomUUID();
    const key = await createOrganizationApiKey(client.db, {
      accountId: workspace.accountId,
      name: "External OAuth fixture",
      prefix: "fixture",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: [
        "workspace:read",
        "connections:read",
        "connections:write",
        "members:manage",
        "capabilities:manage",
      ],
    });
    const app = testApp(fixture);
    app.get("/embedding-gateway-authority-fixture", async (c) => {
      const authorization = await requireAccessGrantAuthorization(
        c,
        { db: client.db, settings },
        workspace.workspaceId,
        "workspace:read",
      );
      const grant = requireWorkspaceToolGatewayAuthorization(authorization);
      expect(grant).toBe(authorization.grant);
      const original = authorization.grant;
      authorization.grant = { ...original };
      expect(() => requireWorkspaceToolGatewayAuthorization(authorization)).toThrow();
      authorization.grant = original;
      return c.json({ subjectId: grant.subjectId });
    });
    const serviceHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-opengeni-access-key": EDGE_ACCESS_KEY,
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    };
    const reference = { externalId: "opaque-provider-owner", source: "test-host" };
    const onboarding = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/external-members`,
      {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({
          identity: reference,
          permissions: [
            "workspace:read",
            "connections:read",
            "connections:write",
            "capabilities:manage",
          ],
        }),
      },
    );
    expect(onboarding.status).toBe(200);
    const external = await onboarding.json();
    const headers = {
      ...serviceHeaders,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({ mode: "external", identity: reference }),
      ),
    };
    const begin = async () => {
      const response = await app.request(
        `/v1/workspaces/${workspace.workspaceId}/integrations/oauth/start`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
            ownership: "workspace",
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      return new URL(body.authorizationUrl).searchParams.get("state")!;
    };
    expect((await app.request("/embedding-gateway-authority-fixture", { headers })).status).toBe(
      200,
    );
    expect(
      (await app.request("/embedding-gateway-authority-fixture", { headers: serviceHeaders }))
        .status,
    ).toBe(200);
    const catalogResponse = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/connect/catalog`,
      { headers },
    );
    expect(catalogResponse.status).toBe(200);
    expect(
      (await catalogResponse.json()).find(
        (provider: { id: string }) => provider.id === GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ),
    ).toMatchObject({ readiness: "available", setup: ["oauth"] });
    const serviceCatalog = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/connect/catalog`,
      { headers: serviceHeaders },
    );
    const serviceProviders = await serviceCatalog.json();
    expect(
      serviceProviders.find((provider: { id: string }) => provider.id === "openapi"),
    ).toMatchObject({ readiness: "available", ownership: ["workspace"] });
    expect(
      serviceProviders.every(
        (provider: { ownership: string[] }) => !provider.ownership.includes("personal"),
      ),
    ).toBe(true);
    for (const suffix of [
      "connections/slack-bot/install",
      "connections/fiken/oauth/start",
      "connections/google-drive/install",
      "connections/atlassian/install",
      "connections/github/oauth/start",
      "connections/example/github/reconnect",
    ]) {
      const legacy = await app.request(`/v1/workspaces/${workspace.workspaceId}/${suffix}`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(legacy.status).toBe(422);
      expect(await legacy.text()).toContain("external-user OAuth continuation");
    }
    expect(fixture.tokenRequests).toHaveLength(0);
    const firstState = await begin();
    const signed = readSignedState(firstState, STATE_SECRET) as Record<string, unknown>;
    expect(typeof signed.encryptedExternalContinuation).toBe("string");
    expect(JSON.stringify(signed)).not.toContain(reference.externalId);
    fixture.setBeforeGoogleTokenReply(async () => {
      await shared!.admin`update api_keys set revoked_at = now() where id = ${key.id}`;
    });
    const denied = await callback(fixture, firstState);
    expect(new URL(denied.headers.get("location")!).searchParams.get("integration_oauth")).toBe(
      "error",
    );
    expect(
      await listConnectionsMetadata(client.db, workspace.workspaceId, external.subjectId),
    ).toEqual([]);
    fixture.setBeforeGoogleTokenReply(undefined);
    await shared!.admin`update api_keys set revoked_at = null where id = ${key.id}`;
    const returnUrl = "https://HOST.example:443/finish?opaque=%2f&literal=%2520#unchanged";
    const customBase = `/v1/workspaces/${workspace.workspaceId}/connect/attempts`;
    const customStart = await app.request(customBase, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "openapi",
        ownership: "workspace",
        returnUrl,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(customStart.status).toBe(200);
    const customAttempt = await customStart.json();
    const customAdvance = (body: unknown) =>
      app.request(`${customBase}/${customAttempt.id}/advance`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const customPreviewResponse = await customAdvance({
      expectedRevision: 1,
      idempotencyKey: crypto.randomUUID(),
      action: {
        type: "credentials",
        values: { url: "https://www.googleapis.com/fixture-openapi.json" },
      },
    });
    if (customPreviewResponse.status !== 200)
      throw new Error(`Custom preview failed: ${await customPreviewResponse.text()}`);
    const customPreview = await customPreviewResponse.json();
    expect(customPreview).toMatchObject({
      state: "preview",
      credentialsCommitted: false,
      integrationInstalled: false,
      source: { kind: "openapi" },
    });
    expect(customPreview.nextAction.operations).toHaveLength(1);
    const installCustom = {
      expectedRevision: customPreview.revision,
      idempotencyKey: crypto.randomUUID(),
      action: {
        type: "install",
        previewId: customPreview.nextAction.previewId,
        contentHash: customPreview.nextAction.contentHash,
        operationIds: [customPreview.nextAction.operations[0].id],
      },
    };
    const customInstalledResponse = await customAdvance(installCustom);
    expect(customInstalledResponse.status).toBe(200);
    const customInstalled = await customInstalledResponse.json();
    expect(customInstalled).toMatchObject({
      state: "complete",
      integrationInstalled: true,
      credentialsCommitted: false,
    });
    expect(await (await customAdvance(installCustom)).json()).toEqual(customInstalled);
    const beginPayload = {
      providerId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "workspace",
      returnUrl,
      idempotencyKey: crypto.randomUUID(),
    };
    const durableStart = () =>
      app.request(`/v1/workspaces/${workspace.workspaceId}/connect/attempts`, {
        method: "POST",
        headers,
        body: JSON.stringify(beginPayload),
      });
    const firstBegin = await durableStart();
    expect(firstBegin.status).toBe(200);
    const attempt = await firstBegin.json();
    const replayBegin = await durableStart();
    expect(replayBegin.status).toBe(200);
    expect(await replayBegin.json()).toEqual(attempt);
    const secondState = new URL(attempt.nextAction.url).searchParams.get("state")!;
    const completed = await callback(fixture, secondState);
    expect(completed.headers.get("location")).toBe(returnUrl);
    const exchanges = fixture.tokenRequests.length;
    expect((await callback(fixture, secondState)).headers.get("location")).toBe(returnUrl);
    expect(fixture.tokenRequests).toHaveLength(exchanges);
    const statusResponse = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/connect/attempts/${attempt.id}`,
      { headers },
    );
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      id: attempt.id,
      revision: 2,
      state: "connected_but_incomplete",
      credentialsCommitted: true,
      integrationInstalled: false,
    });
    const advance = (body: unknown) =>
      app.request(
        `/v1/workspaces/${workspace.workspaceId}/connect/attempts/${attempt.id}/advance`,
        { method: "POST", headers, body: JSON.stringify(body) },
      );
    const previewResponse = await advance({
      expectedRevision: 2,
      idempotencyKey: crypto.randomUUID(),
      action: { type: "retry" },
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.state).toBe("preview");
    expect(preview.nextAction.operations).toHaveLength(2);
    const installInput = {
      expectedRevision: 3,
      idempotencyKey: crypto.randomUUID(),
      action: {
        type: "install",
        previewId: preview.nextAction.previewId,
        contentHash: preview.nextAction.contentHash,
        operationIds: [preview.nextAction.operations[0].id],
      },
    };
    const invalidSelection = await advance({
      ...installInput,
      idempotencyKey: crypto.randomUUID(),
      action: { ...installInput.action, operationIds: ["not-reviewed"] },
    });
    expect(invalidSelection.status).toBe(409);
    fixture.setSourceTitle("Updated Drive fixture");
    const changedResponse = await advance(installInput);
    expect(changedResponse.status).toBe(200);
    const changed = await changedResponse.json();
    expect(changed).toMatchObject({
      revision: 4,
      state: "preview",
      integrationInstalled: false,
      error: { code: "source_changed" },
    });
    installInput.expectedRevision = changed.revision;
    installInput.idempotencyKey = crypto.randomUUID();
    installInput.action.previewId = changed.nextAction.previewId;
    installInput.action.contentHash = changed.nextAction.contentHash;
    installInput.action.operationIds = [changed.nextAction.operations[0].id];
    const installedResponse = await advance(installInput);
    expect(installedResponse.status).toBe(200);
    const installed = await installedResponse.json();
    expect(installed).toMatchObject({
      revision: 5,
      state: "complete",
      credentialsCommitted: true,
      integrationInstalled: true,
    });
    expect(await (await advance(installInput)).json()).toEqual(installed);
    const cancelledStart = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/connect/attempts`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ...beginPayload, idempotencyKey: crypto.randomUUID() }),
      },
    );
    const toCancel = await cancelledStart.json();
    const cancelledResponse = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/connect/attempts/${toCancel.id}/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedRevision: 1, idempotencyKey: crypto.randomUUID() }),
      },
    );
    expect(cancelledResponse.status).toBe(200);
    expect((await cancelledResponse.json()).state).toBe("cancelled");
    expect(
      await listConnectionsMetadata(client.db, workspace.workspaceId, external.subjectId),
    ).toHaveLength(1);
    const accountsResponse = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/connect/accounts`,
      { headers },
    );
    expect(accountsResponse.status).toBe(200);
    const accounts = await accountsResponse.json();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "workspace",
      status: "connected",
    });
    expect(Object.keys(accounts[0]).sort()).toEqual([
      "id",
      "label",
      "ownership",
      "providerId",
      "status",
      "version",
    ]);
    expect(accounts[0].version).toBeGreaterThan(0);
    const disconnectPath = `/v1/workspaces/${workspace.workspaceId}/connections/${accounts[0].id}`;
    const staleDisconnect = await app.request(
      `${disconnectPath}?expectedVersion=${accounts[0].version + 1}`,
      { method: "DELETE", headers },
    );
    expect(staleDisconnect.status).toBe(409);
    const invalidDisconnect = await app.request(`${disconnectPath}?expectedVersion=1.5`, {
      method: "DELETE",
      headers,
    });
    expect(invalidDisconnect.status).toBe(400);
    const currentAccounts = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/connect/accounts`,
      { headers },
    );
    expect((await currentAccounts.json())[0]).toMatchObject({
      status: "connected",
      version: accounts[0].version,
    });
  });
  test("connects a Google definition with signed PKCE state and no callback perimeter credential", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.googlePlans.push({
      scopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/drive",
      ],
      refreshToken: "google-refresh-token",
    });
    const started = await start(fixture, workspace, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    expect(started.response.status).toBe(200);
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual(
      GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes,
    );
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent select_account");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8000/v1/integrations/oauth/callback",
    );
    const state = authorizationUrl.searchParams.get("state")!;
    const connected = await callback(
      fixture,
      state,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    expect(connected.status).toBe(302);
    const location = new URL(connected.headers.get("location")!);
    expect(location.origin).toBe("http://127.0.0.1:3000");
    expect(location.searchParams.get("integration_oauth")).toBe("success");
    expect(location.searchParams.get("definitionId")).toBe(GOOGLE_DRIVE_INTEGRATION_DEFINITION.id);

    const connections = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect(connection).toMatchObject({
      subjectId: workspace.subjectId,
      providerDomain: "www.googleapis.com",
      kind: "oauth2",
      status: "active",
      grantedScopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/drive",
      ],
      metadata: {
        credentialRole: API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
        providerFamily: "google",
        providerPrincipalId: "google-principal-1",
        providerEmail: "google.user@example.com",
        authorizedDefinitionIds: [GOOGLE_DRIVE_INTEGRATION_DEFINITION.id],
      },
    });
    expect(JSON.stringify(connection)).not.toContain("google-access");
    expect(JSON.stringify(connection)).not.toContain("google-refresh-token");
    const credential = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: workspace.workspaceId,
      connectionId: connection.id,
      providerDomain: connection.providerDomain,
      kind: "oauth2",
      subjectId: workspace.subjectId,
      allowSubjectOwned: true,
    });
    expect(credential?.credential).toMatchObject({
      refresh_token: "google-refresh-token",
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      token_endpoint: GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.tokenUrl,
    });
    expect(fixture.tokenRequests[0]?.body.get("client_secret")).toBe(GOOGLE_CLIENT_SECRET);

    const genericPatch = await testApp(fixture).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: await bearer(workspace),
          "content-type": "application/json",
          "x-opengeni-access-key": EDGE_ACCESS_KEY,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify({ credential: { access_token: "bypass-attempt" } }),
      },
    );
    expect(genericPatch.status).toBe(422);

    const replay = await callback(fixture, state, "replayed-code");
    expect(new URL(replay.headers.get("location")!).searchParams.get("reason")).toBe(
      "state_replayed",
    );
    expect(fixture.tokenRequests).toHaveLength(1);
  }, 60_000);

  test("unions Microsoft scopes on reconnect, preserves refresh tokens, and rejects account switch", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.microsoftPlans.push({
      scopes: [...MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "microsoft-refresh-token",
    });
    const firstStart = await start(fixture, workspace, {
      definitionId: MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.id,
      ownership: "workspace",
    });
    const firstState = new URL(firstStart.authorizationUrl).searchParams.get("state")!;
    const firstCallback = await callback(fixture, firstState);
    expect(
      new URL(firstCallback.headers.get("location")!).searchParams.get("integration_oauth"),
    ).toBe("success");
    const firstConnection = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    )[0]!;

    const unionScopes = [
      ...new Set([
        ...MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.authentication.scopes,
        ...MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION.authentication.scopes,
      ]),
    ];
    fixture.microsoftPlans.push({ scopes: unionScopes });
    const reconnect = await start(fixture, workspace, {
      definitionId: MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION.id,
      connectionId: firstConnection.id,
      ownership: "workspace",
    });
    expect(reconnect.response.status).toBe(200);
    expect(new URL(reconnect.authorizationUrl).searchParams.get("scope")?.split(" ")).toEqual(
      unionScopes,
    );
    const reconnectState = new URL(reconnect.authorizationUrl).searchParams.get("state")!;
    const reconnectCallback = await callback(fixture, reconnectState);
    expect(
      new URL(reconnectCallback.headers.get("location")!).searchParams.get("integration_oauth"),
    ).toBe("success");
    const reconnected = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    )[0]!;
    expect(reconnected.id).toBe(firstConnection.id);
    expect(reconnected.version).toBe(firstConnection.version + 1);
    expect(reconnected.grantedScopes).toEqual(unionScopes);
    expect(reconnected.metadata.authorizedDefinitionIds).toEqual(
      [
        MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION.id,
        MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.id,
      ].sort(),
    );
    const credential = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: workspace.workspaceId,
      connectionId: reconnected.id,
      providerDomain: "graph.microsoft.com",
      kind: "oauth2",
    });
    expect(credential?.credential.refresh_token).toBe("microsoft-refresh-token");
    expect(credential?.credential.client_id).toBe(MICROSOFT_CLIENT_ID);
    expect(fixture.tokenRequests.filter((request) => request.family === "microsoft")).toEqual([
      expect.objectContaining({ authorization: null }),
      expect.objectContaining({ authorization: null }),
    ]);

    fixture.microsoftPlans.push({
      scopes: unionScopes,
      refreshToken: "must-not-persist",
    });
    const switchStart = await start(fixture, workspace, {
      definitionId: MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION.id,
      connectionId: reconnected.id,
      ownership: "workspace",
    });
    fixture.setMicrosoftPrincipalId("microsoft-principal-other");
    const switchCallback = await callback(
      fixture,
      new URL(switchStart.authorizationUrl).searchParams.get("state")!,
    );
    expect(new URL(switchCallback.headers.get("location")!).searchParams.get("reason")).toBe(
      "account_mismatch",
    );
    const unchanged = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    )[0]!;
    expect(unchanged.version).toBe(reconnected.version);
  }, 60_000);

  test("converges concurrent same-principal callbacks and rejects insufficient provider grants", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.googlePlans.push(
      {
        scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "google-refresh-a",
      },
      {
        scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "google-refresh-b",
      },
    );
    const [left, right] = await Promise.all([
      start(fixture, workspace, {
        definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
        ownership: "personal",
      }),
      start(fixture, workspace, {
        definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
        ownership: "personal",
      }),
    ]);
    const callbacks = await Promise.all([
      callback(fixture, new URL(left.authorizationUrl).searchParams.get("state")!, "left"),
      callback(fixture, new URL(right.authorizationUrl).searchParams.get("state")!, "right"),
    ]);
    expect(
      callbacks.map((response) =>
        new URL(response.headers.get("location")!).searchParams.get("integration_oauth"),
      ),
    ).toEqual(["success", "success"]);
    const connections = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    ).filter((connection) => connection.providerDomain === "www.googleapis.com");
    expect(connections).toHaveLength(1);

    const insufficientWorkspace = await freshWorkspace();
    const insufficient = providerFixture();
    insufficient.googlePlans.push({
      scopes: ["openid", "email", "profile"],
      refreshToken: "must-not-persist",
    });
    const insufficientStart = await start(insufficient, insufficientWorkspace, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    const denied = await callback(
      insufficient,
      new URL(insufficientStart.authorizationUrl).searchParams.get("state")!,
    );
    expect(new URL(denied.headers.get("location")!).searchParams.get("reason")).toBe(
      "scope_not_granted",
    );
    expect(
      await listConnectionsMetadata(
        client.db,
        insufficientWorkspace.workspaceId,
        insufficientWorkspace.subjectId,
      ),
    ).toEqual([]);
  }, 60_000);

  test("an omitted ownership is refused rather than silently picking either value", async () => {
    if (!available) return;
    // Resolving an omission to `personal` was the original defect. Resolving it
    // to `workspace` is the opposite defect: an executed probe confirmed it
    // flips a newly connected Outlook mailbox from subject-scoped to
    // workspace-shared. Both Definitions are exercised, because the Microsoft
    // family is where the widening would actually hurt.
    for (const definition of [
      GOOGLE_DRIVE_INTEGRATION_DEFINITION,
      MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
    ]) {
      const workspace = await freshWorkspace();
      const fixture = providerFixture();
      const started = await start(fixture, workspace, { definitionId: definition.id });
      expect(started.response.status).toBe(422);
      expect(JSON.stringify(started.body)).toContain("ownership is required");
      expect(
        await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId),
      ).toEqual([]);
    }
  }, 60_000);

  test("an explicit workspace ownership still connects and owns no subject", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "google-refresh-token",
    });
    const started = await start(fixture, workspace, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "workspace",
    });
    expect(started.response.status).toBe(200);
    const connected = await callback(
      fixture,
      new URL(started.authorizationUrl).searchParams.get("state")!,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    const location = new URL(connected.headers.get("location")!);
    expect(location.searchParams.get("integration_oauth")).toBe("success");
    expect(location.searchParams.get("ownership")).toBe("workspace");
    const connections = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    ).filter((connection) => connection.providerDomain === "www.googleapis.com");
    expect(connections).toHaveLength(1);
    expect(connections[0]!.subjectId).toBeNull();
  }, 60_000);

  test("a legacy in-flight state cannot land a personal owner through the callback", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "google-refresh-token",
    });
    // Mint the exact state an older deployment would have signed: personal
    // ownership with no `personalOwnerVerified` claim. This is the rolling-
    // deploy window the callback fence exists to close - the start route is
    // already fenced, so nothing else can produce this shape.
    const legacyState = await legacyProviderOAuthState(workspace, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    const refused = await callback(
      fixture,
      legacyState,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    const location = new URL(refused.headers.get("location")!);
    expect(location.searchParams.get("integration_oauth")).toBe("error");
    expect(location.searchParams.get("reason")).toBe("connection_conflict");
    expect(
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId),
    ).toEqual([]);

    // The same state shape with the claim present is accepted, so the fence is
    // the claim and not some unrelated rejection of a hand-minted state.
    const verifiedState = await legacyProviderOAuthState(workspace, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
      personalOwnerVerified: true,
    });
    const accepted = await callback(
      fixture,
      verifiedState,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    expect(new URL(accepted.headers.get("location")!).searchParams.get("integration_oauth")).toBe(
      "success",
    );
    const connections = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connections).toHaveLength(1);
    expect(connections[0]!.subjectId).toBe(workspace.subjectId);
  }, 60_000);

  test("rejects claim forgery, nonce replay, and a mismatched definition fingerprint", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "google-refresh-token",
    });

    // FORGERY: splice the claim into the base64 payload of a legacy state
    // without re-signing. The claim rides inside the HMAC-signed payload, so
    // this invalidates the signature rather than granting personal ownership.
    const legacyState = await legacyProviderOAuthState(workspace, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    const [encoded, signature] = legacyState.split(".", 2);
    const tampered = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    tampered.personalOwnerVerified = true;
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`;
    const forgedResult = await callback(
      fixture,
      forged,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    expect(new URL(forgedResult.headers.get("location")!).searchParams.get("reason")).toBe(
      "state_invalid",
    );

    // DEFINITION/FINGERPRINT MISMATCH: changing the definitionId while keeping
    // the original fingerprint is refused, even when the altered payload is
    // re-signed. The signing secret remains root authority and could mint a
    // fully consistent state; this proves the callback's mismatch check, not
    // isolation from a signing-secret holder.
    const verified = await legacyProviderOAuthState(workspace, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
      personalOwnerVerified: true,
    });
    const verifiedPayload = readSignedState(verified, STATE_SECRET) as Record<string, unknown>;
    const swapped = createSignedState(STATE_SECRET, {
      ...verifiedPayload,
      definitionId: MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.id,
    });
    const swappedResult = await callback(
      fixture,
      swapped,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    expect(new URL(swappedResult.headers.get("location")!).searchParams.get("reason")).toBe(
      "state_invalid",
    );

    // The untampered verified state still works, and is single-use: the nonce
    // table refuses the replay, so a captured personal state cannot be reused.
    const accepted = await callback(
      fixture,
      verified,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    expect(new URL(accepted.headers.get("location")!).searchParams.get("integration_oauth")).toBe(
      "success",
    );
    const replayed = await callback(
      fixture,
      verified,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    expect(new URL(replayed.headers.get("location")!).searchParams.get("reason")).toBe(
      "state_replayed",
    );
    expect(
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId),
    ).toHaveLength(1);
  }, 60_000);

  test("a non-human principal cannot request personal ownership", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const refused = await start(
      fixture,
      workspace,
      { definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id, ownership: "personal" },
      "service",
    );
    expect(refused.response.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain("requires an authenticated human");

    // The refusal is explicit, never a silent downgrade to workspace ownership.
    expect(
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId),
    ).toEqual([]);

    // The same principal may still create the documented workspace-owned
    // Connection, so this narrows rather than blocking the flow outright.
    fixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "google-refresh-token",
    });
    const allowed = await start(
      fixture,
      workspace,
      { definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id, ownership: "workspace" },
      "service",
    );
    expect(allowed.response.status).toBe(200);
    const connected = await callback(
      fixture,
      new URL(allowed.authorizationUrl).searchParams.get("state")!,
      "fixture-code",
      "/v1/integrations/oauth/callback",
    );
    expect(new URL(connected.headers.get("location")!).searchParams.get("integration_oauth")).toBe(
      "success",
    );
    const connections = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connections).toHaveLength(1);
    expect(connections[0]!.subjectId).toBeNull();
  }, 60_000);
});
