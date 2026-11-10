import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import {
  MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION,
  MICROSOFT_TEAMS_INTEGRATION_DEFINITION,
  MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION,
  MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
} from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import {
  API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  listConnectionsMetadata,
  listInstalledApiIntegrations,
  loadConnectionCredentialForBroker,
  uninstallApiIntegration,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { createSignedState, readSignedState } from "@opengeni/github";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";

import { createApp } from "../src/app";
import { requireAccessGrantAuthorization } from "@opengeni/core";
import { requireWorkspaceToolGatewayAuthorization } from "../src/workspace-tool-gateway";
import {
  setCuratedConnectFinishRetryDelays,
  stopCuratedConnectFinishRetries,
} from "../src/integrations/curated-connect-finish";

const DELEGATION_SECRET = "api-integration-provider-oauth-delegation";
const STATE_SECRET = "api-integration-provider-oauth-state";
const EDGE_ACCESS_KEY = "api-integration-provider-oauth-edge";
const MICROSOFT_CLIENT_ID = "microsoft-provider-client";
const MICROSOFT_CLIENT_SECRET = "microsoft-provider-client-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;
const workspaceIds: string[] = [];

beforeAll(async () => {
  // Callbacks that fall back keep trying in the background; tests that rely
  // on the fallback state turn that on only where they exercise it.
  setCuratedConnectFinishRetryDelays([]);
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
    integrationsOauthClientsJson: JSON.stringify({
      "https://login.microsoftonline.com/common/v2.0": {
        clientId: MICROSOFT_CLIENT_ID,
        clientSecret: MICROSOFT_CLIENT_SECRET,
        tokenEndpointAuthMethod: "client_secret_post",
      },
    }),
  }) as Settings;
}, 180_000);

afterAll(async () => {
  stopCuratedConnectFinishRetries();
  setCuratedConnectFinishRetryDelays(null);
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
  permissions: Permission[] = ["connections:read", "connections:write", "workspace:read"],
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: workspace.subjectId,
    permissions,
    principalKind,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

type TokenPlan = {
  scopes: string[];
  refreshToken?: string;
};

function providerFixture() {
  let sourceTitle = "OneDrive fixture";
  let sourceAvailable = true;
  let onSourceRead: (() => Promise<void>) | undefined;
  let beforeTokenReply: (() => Promise<void>) | undefined;
  const microsoftPlans: TokenPlan[] = [];
  const tokenRequests: Array<{
    family: "microsoft";
    body: URLSearchParams;
    authorization: string | null;
  }> = [];
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
    if (url.href === MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.source.url) {
      await onSourceRead?.();
      if (!sourceAvailable) return new Response("unavailable", { status: 503 });
      return Response.json({
        openapi: "3.0.3",
        info: { title: sourceTitle, version: "1" },
        servers: [{ url: "https://graph.microsoft.com/v1.0" }],
        paths: {
          "/me/drive/root/children": {
            get: { operationId: "listFiles", responses: { "200": { description: "Files" } } },
          },
          "/me/joinedTeams": {
            get: { operationId: "listJoinedTeams", responses: { "200": { description: "Teams" } } },
          },
          "/me/drive/items/{itemId}": {
            get: {
              operationId: "getFile",
              parameters: [
                { name: "itemId", in: "path", required: true, schema: { type: "string" } },
              ],
              responses: { "200": { description: "File" } },
            },
          },
        },
      });
    }
    if (
      url.href === MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.authentication.tokenUrl ||
      url.href === MICROSOFT_TEAMS_INTEGRATION_DEFINITION.authentication.tokenUrl
    ) {
      await beforeTokenReply?.();
      const body = requestBody(init?.body);
      tokenRequests.push({
        family: "microsoft",
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const plan = microsoftPlans.shift() ?? {
        scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
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
    /** The provider's API description cannot be read (the callback then saves only the account). */
    setSourceAvailable(value: boolean) {
      sourceAvailable = value;
    },
    /** Runs whenever the provider's API description is read. */
    setOnSourceRead(hook: (() => Promise<void>) | undefined) {
      onSourceRead = hook;
    },
    setBeforeTokenReply(hook: (() => Promise<void>) | undefined) {
      beforeTokenReply = hook;
    },
    microsoftPlans,
    tokenRequests,
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
  test("Teams OAuth and generic Connect honor the exact workspace rollout before consent and callback", async () => {
    if (!available) throw new Error("Teams rollout acceptance requires PostgreSQL");
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const previousEnabled = settings.microsoftTeamsToolsEnabled;
    const previousWorkspaces = settings.microsoftTeamsAllowedWorkspaceIds;
    try {
      settings.microsoftTeamsToolsEnabled = false;
      settings.microsoftTeamsAllowedWorkspaceIds = [];
      expect(
        (
          await start(fixture, workspace, {
            definitionId: "microsoft-teams",
            ownership: "workspace",
          })
        ).response.status,
      ).toBe(404);
      const generic = await testApp(fixture).request(
        `/v1/workspaces/${workspace.workspaceId}/connect/attempts`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace),
            "content-type": "application/json",
            "x-opengeni-access-key": EDGE_ACCESS_KEY,
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          body: JSON.stringify({
            providerId: "microsoft-teams",
            ownership: "workspace",
            returnUrl: `http://127.0.0.1:3000/workspaces/${workspace.workspaceId}/plugins`,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      expect(generic.status).toBe(404);
      settings.microsoftTeamsAllowedWorkspaceIds = [workspace.workspaceId];
      const enabled = await start(fixture, workspace, {
        definitionId: "microsoft-teams",
        ownership: "workspace",
      });
      expect(enabled.response.status).toBe(200);
      const url = new URL(enabled.authorizationUrl);
      expect(url.pathname).toBe("/organizations/oauth2/v2.0/authorize");
      expect(url.searchParams.get("scope")).toContain("ChatMessage.Send");
      settings.microsoftTeamsAllowedWorkspaceIds = [];
      const settled = await callback(fixture, url.searchParams.get("state")!);
      expect(settled.status).toBe(302);
      expect(settled.headers.get("location")).toContain("state_invalid");
      expect(fixture.tokenRequests).toHaveLength(0);
      expect(await listConnectionsMetadata(client.db, workspace.workspaceId, null)).toHaveLength(0);
      // A new, enabled consent completes through the organizational token endpoint
      // and persists only the Teams workload grant under the normal broker role.
      settings.microsoftTeamsAllowedWorkspaceIds = [workspace.workspaceId];
      fixture.microsoftPlans.push({
        scopes: [...MICROSOFT_TEAMS_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "teams-fixture-refresh",
      });
      const retry = await start(fixture, workspace, {
        definitionId: "microsoft-teams",
        ownership: "workspace",
      });
      expect(retry.response.status).toBe(200);
      const completed = await callback(
        fixture,
        new URL(retry.authorizationUrl).searchParams.get("state")!,
      );
      expect(completed.status).toBe(302);
      expect(
        new URL(completed.headers.get("location")!).searchParams.get("integration_oauth"),
      ).toBe("success");
      const connections = await listConnectionsMetadata(client.db, workspace.workspaceId, null);
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({
        subjectId: null,
        providerDomain: "graph.microsoft.com",
        kind: "oauth2",
        status: "active",
        metadata: {
          credentialRole: API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
          authorizedDefinitionIds: ["microsoft-teams"],
        },
      });
      expect([...connections[0]!.grantedScopes].sort()).toEqual(
        [...MICROSOFT_TEAMS_INTEGRATION_DEFINITION.authentication.scopes].sort(),
      );
      expect(fixture.tokenRequests).toHaveLength(1);
    } finally {
      settings.microsoftTeamsToolsEnabled = previousEnabled;
      settings.microsoftTeamsAllowedWorkspaceIds = previousWorkspaces;
    }
  });

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
            definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
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
        (provider: { id: string }) => provider.id === MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
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
    fixture.setBeforeTokenReply(async () => {
      await shared!.admin`update api_keys set revoked_at = now() where id = ${key.id}`;
    });
    const denied = await callback(fixture, firstState);
    expect(new URL(denied.headers.get("location")!).searchParams.get("integration_oauth")).toBe(
      "error",
    );
    expect(
      await listConnectionsMetadata(client.db, workspace.workspaceId, external.subjectId),
    ).toEqual([]);
    fixture.setBeforeTokenReply(undefined);
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
      providerId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
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
    // The reviewed tools cannot be read during the callback: it saves the
    // account and leaves the install step to the app, as before.
    fixture.setSourceAvailable(false);
    const completed = await callback(fixture, secondState);
    fixture.setSourceAvailable(true);
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
    fixture.setSourceTitle("Updated OneDrive fixture");
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
      providerId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
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
  test("connects a OneDrive definition with signed PKCE state and no callback perimeter credential", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.microsoftPlans.push({
      scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "microsoft-refresh-token",
    });
    const started = await start(fixture, workspace, {
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    expect(started.response.status).toBe(200);
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://login.microsoftonline.com");
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual(
      MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes,
    );
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toContain("offline_access");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("select_account");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8000/v1/integrations/provider-oauth/callback",
    );
    const state = authorizationUrl.searchParams.get("state")!;
    const connected = await callback(
      fixture,
      state,
      "fixture-code",
      "/v1/integrations/provider-oauth/callback",
    );
    expect(connected.status).toBe(302);
    const location = new URL(connected.headers.get("location")!);
    expect(location.origin).toBe("http://127.0.0.1:3000");
    expect(location.searchParams.get("integration_oauth")).toBe("success");
    expect(location.searchParams.get("definitionId")).toBe(
      MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
    );

    const connections = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect(connection).toMatchObject({
      subjectId: workspace.subjectId,
      providerDomain: "graph.microsoft.com",
      kind: "oauth2",
      status: "active",
      grantedScopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      metadata: {
        credentialRole: API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
        providerFamily: "microsoft",
        providerPrincipalId: "microsoft-principal-1",
        providerEmail: "microsoft.user@example.com",
        authorizedDefinitionIds: [MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id],
      },
    });
    expect(JSON.stringify(connection)).not.toContain("microsoft-access");
    expect(JSON.stringify(connection)).not.toContain("microsoft-refresh-token");
    const credential = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: workspace.workspaceId,
      connectionId: connection.id,
      providerDomain: connection.providerDomain,
      kind: "oauth2",
      subjectId: workspace.subjectId,
      allowSubjectOwned: true,
    });
    expect(credential?.credential).toMatchObject({
      refresh_token: "microsoft-refresh-token",
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      token_endpoint: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.tokenUrl,
    });
    expect(fixture.tokenRequests[0]?.body.get("client_secret")).toBe(MICROSOFT_CLIENT_SECRET);

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
      scopes: MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.authentication.scopes.filter(
        (scope) => scope !== "offline_access",
      ),
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
    fixture.microsoftPlans.push({
      scopes: unionScopes.filter((scope) => scope !== "offline_access"),
    });
    const reconnect = await start(fixture, workspace, {
      definitionId: MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION.id,
      connectionId: firstConnection.id,
      ownership: "workspace",
    });
    expect(reconnect.response.status).toBe(200);
    expect(
      new URL(reconnect.authorizationUrl).searchParams.get("scope")?.split(" ").sort(),
    ).toEqual([...unionScopes].sort());
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
    expect([...reconnected.grantedScopes].sort()).toEqual([...unionScopes].sort());
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

  test("Microsoft still requires mail permissions and a refresh token", async () => {
    if (!available) return;
    for (const missing of ["Mail.Send", "refresh_token"]) {
      const workspace = await freshWorkspace();
      const fixture = providerFixture();
      fixture.microsoftPlans.push({
        scopes: MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.authentication.scopes.filter(
          (scope) => scope !== "offline_access" && scope !== missing,
        ),
        ...(missing === "refresh_token" ? {} : { refreshToken: "must-not-persist" }),
      });
      const started = await start(fixture, workspace, {
        definitionId: MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.id,
        ownership: "workspace",
      });
      const result = await callback(
        fixture,
        new URL(started.authorizationUrl).searchParams.get("state")!,
      );
      expect(new URL(result.headers.get("location")!).searchParams.get("reason")).toBe(
        missing === "refresh_token" ? "refresh_token_missing" : "scope_not_granted",
      );
      expect(
        await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId),
      ).toEqual([]);
    }
  }, 60_000);

  test("converges concurrent same-principal callbacks and rejects insufficient provider grants", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.microsoftPlans.push(
      {
        scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "microsoft-refresh-a",
      },
      {
        scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "microsoft-refresh-b",
      },
    );
    const [left, right] = await Promise.all([
      start(fixture, workspace, {
        definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
        ownership: "personal",
      }),
      start(fixture, workspace, {
        definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
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
    ).filter((connection) => connection.providerDomain === "graph.microsoft.com");
    expect(connections).toHaveLength(1);

    const insufficientWorkspace = await freshWorkspace();
    const insufficient = providerFixture();
    insufficient.microsoftPlans.push({
      scopes: ["openid", "email", "profile"],
      refreshToken: "must-not-persist",
    });
    const insufficientStart = await start(insufficient, insufficientWorkspace, {
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
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
      MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION,
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
    fixture.microsoftPlans.push({
      scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "microsoft-refresh-token",
    });
    const started = await start(fixture, workspace, {
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
      ownership: "workspace",
    });
    expect(started.response.status).toBe(200);
    const connected = await callback(
      fixture,
      new URL(started.authorizationUrl).searchParams.get("state")!,
      "fixture-code",
      "/v1/integrations/provider-oauth/callback",
    );
    const location = new URL(connected.headers.get("location")!);
    expect(location.searchParams.get("integration_oauth")).toBe("success");
    expect(location.searchParams.get("ownership")).toBe("workspace");
    const connections = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    ).filter((connection) => connection.providerDomain === "graph.microsoft.com");
    expect(connections).toHaveLength(1);
    expect(connections[0]!.subjectId).toBeNull();
  }, 60_000);

  test("a legacy in-flight state cannot land a personal owner through the callback", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.microsoftPlans.push({
      scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "microsoft-refresh-token",
    });
    // Mint the exact state an older deployment would have signed: personal
    // ownership with no `personalOwnerVerified` claim. This is the rolling-
    // deploy window the callback fence exists to close - the start route is
    // already fenced, so nothing else can produce this shape.
    const legacyState = await legacyProviderOAuthState(workspace, {
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    const refused = await callback(
      fixture,
      legacyState,
      "fixture-code",
      "/v1/integrations/provider-oauth/callback",
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
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
      personalOwnerVerified: true,
    });
    const accepted = await callback(
      fixture,
      verifiedState,
      "fixture-code",
      "/v1/integrations/provider-oauth/callback",
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
    fixture.microsoftPlans.push({
      scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "microsoft-refresh-token",
    });

    // FORGERY: splice the claim into the base64 payload of a legacy state
    // without re-signing. The claim rides inside the HMAC-signed payload, so
    // this invalidates the signature rather than granting personal ownership.
    const legacyState = await legacyProviderOAuthState(workspace, {
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
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
      "/v1/integrations/provider-oauth/callback",
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
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
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
      "/v1/integrations/provider-oauth/callback",
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
      "/v1/integrations/provider-oauth/callback",
    );
    expect(new URL(accepted.headers.get("location")!).searchParams.get("integration_oauth")).toBe(
      "success",
    );
    const replayed = await callback(
      fixture,
      verified,
      "fixture-code",
      "/v1/integrations/provider-oauth/callback",
    );
    expect(new URL(replayed.headers.get("location")!).searchParams.get("reason")).toBe(
      "state_replayed",
    );
    expect(
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId),
    ).toHaveLength(1);
  }, 60_000);

  test("a person installs a reviewed definition for their own account without integration management", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const app = testApp(fixture);
    // A person who may connect their own accounts, but not manage integrations.
    const headers = {
      authorization: await bearer(workspace),
      "content-type": "application/json",
      "x-opengeni-access-key": EDGE_ACCESS_KEY,
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    };
    const base = `/v1/workspaces/${workspace.workspaceId}/connect/attempts`;
    // Begin and sign in. The callback finishes setup by itself when the
    // person who started it could have installed the tools.
    const connect = async (
      input: Record<string, unknown>,
      requestHeaders: Record<string, string> = headers,
    ) => {
      fixture.microsoftPlans.push({
        scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "microsoft-refresh-token",
      });
      const begun = await app.request(base, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          providerId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
          returnUrl: "https://host.example/chat",
          idempotencyKey: crypto.randomUUID(),
          ...input,
        }),
      });
      if (begun.status !== 200) throw new Error(`begin failed: ${await begun.text()}`);
      const attempt = await begun.json();
      const state = new URL(attempt.nextAction.url).searchParams.get("state")!;
      await callback(fixture, state);
      const current = await (
        await app.request(`${base}/${attempt.id}`, { headers: requestHeaders })
      ).json();
      return { attempt, current };
    };
    // The manual step the app takes when the callback could not finish.
    const previewAndInstall = async (
      attempt: { id: string },
      requestHeaders: Record<string, string> = headers,
    ) => {
      const advance = (body: unknown) =>
        app.request(`${base}/${attempt.id}/advance`, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(body),
        });
      const preview = await (
        await advance({
          expectedRevision: 2,
          idempotencyKey: crypto.randomUUID(),
          action: { type: "retry" },
        })
      ).json();
      if (preview.state !== "preview")
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      return advance({
        expectedRevision: preview.revision,
        idempotencyKey: crypto.randomUUID(),
        action: {
          type: "install",
          previewId: preview.nextAction.previewId,
          contentHash: preview.nextAction.contentHash,
          operationIds: preview.nextAction.operations.map(
            (operation: { id: string }) => operation.id,
          ),
        },
      });
    };
    const instances = () =>
      listInstalledApiIntegrations(client.db, workspace.workspaceId, workspace.subjectId);

    // Their own account, in a fresh instance named after the attempt.
    const own = await connect({ ownership: "personal" });
    expect(own.attempt.installationTarget).toEqual({
      instanceKey: `account-${own.attempt.id}`,
      displayName: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.name,
    });
    expect(own.current).toMatchObject({
      revision: 2,
      state: "complete",
      credentialsCommitted: true,
      integrationInstalled: true,
    });

    // The narrow "connect my own account" permission alone is enough too
    // (the per-user embed default: no connections:read or connections:write).
    const narrowHeaders = {
      ...headers,
      authorization: await bearer(workspace, "human_session", [
        "connections:personal",
        "workspace:read",
      ]),
    };
    const narrow = await connect({ ownership: "personal" }, narrowHeaders);
    expect(narrow.current).toMatchObject({ state: "complete", integrationInstalled: true });
    // ...but never a workspace account.
    fixture.microsoftPlans.length = 0;
    const narrowShared = await app.request(base, {
      method: "POST",
      headers: narrowHeaders,
      body: JSON.stringify({
        providerId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
        ownership: "workspace",
        returnUrl: "https://host.example/chat",
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(narrowShared.status).toBe(403);

    // A member (connections:write) adds a workspace account integration too.
    const before = new Set((await instances()).map((instance) => instance.instanceKey));
    const workspaceOwned = await connect({ ownership: "workspace" });
    expect(workspaceOwned.current).toMatchObject({
      state: "complete",
      integrationInstalled: true,
    });
    // ...but a member's add is create only: binding an instance that is
    // already set up (here the workspace one) stays integration management.
    // The callback cannot finish it and keeps the account; the manual install
    // is refused.
    const sharedInstance = (await instances()).find(
      (instance) => !before.has(instance.instanceKey),
    );
    expect(sharedInstance).toBeDefined();
    const rebind = await connect({
      ownership: "personal",
      installationTarget: {
        instanceKey: sharedInstance!.instanceKey,
        displayName: "OneDrive",
      },
    });
    expect(rebind.current).toMatchObject({
      state: "connected_but_incomplete",
      credentialsCommitted: true,
      integrationInstalled: false,
    });
    const rebound = await previewAndInstall(rebind.attempt);
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).toContain("Only an admin can change it");
    expect(
      (await instances()).find((instance) => instance.instanceKey === sharedInstance!.instanceKey)
        ?.connectionRef?.connectionId,
    ).toBe(sharedInstance!.connectionRef?.connectionId);

    // Binding an instance this account is not already bound to is adding an
    // integration, which the narrow "connect my own account" permission is not:
    // the callback never finishes it with the person's wider membership rights.
    const other = await connect(
      {
        ownership: "personal",
        installationTarget: { instanceKey: "account-someone-else", displayName: "OneDrive" },
      },
      narrowHeaders,
    );
    expect(other.current).toMatchObject({
      state: "connected_but_incomplete",
      integrationInstalled: false,
    });
    expect(
      (await instances()).some((instance) => instance.instanceKey === "account-someone-else"),
    ).toBe(false);
    const otherInstall = await previewAndInstall(other.attempt, narrowHeaders);
    expect(otherInstall.status).toBe(403);
    expect(await otherInstall.text()).toContain("connections:write");
  }, 60_000);

  test("a built-in integration finishes setup in its callback, with no step left for the app", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const app = testApp(fixture);
    const headers = {
      authorization: await bearer(workspace),
      "content-type": "application/json",
      "x-opengeni-access-key": EDGE_ACCESS_KEY,
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    };
    const base = `/v1/workspaces/${workspace.workspaceId}/connect/attempts`;
    const begun = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
        ownership: "personal",
        returnUrl: "https://host.example/capabilities",
        idempotencyKey: crypto.randomUUID(),
        installationTarget: { instanceKey: "account-sharepoint", displayName: "OneDrive" },
      }),
    });
    expect(begun.status).toBe(200);
    const attempt = await begun.json();
    expect(attempt.state).toBe("requires_user_action");
    // The person signs in and the browser comes back; the app that started
    // setup is gone (dialog closed, page reloaded, desktop app quit). Nothing
    // but the provider's redirect reaches the API.
    const state = new URL(attempt.nextAction.url).searchParams.get("state")!;
    const returned = await callback(fixture, state);
    expect(returned.status).toBe(302);
    expect(returned.headers.get("location")).toBe("https://host.example/capabilities");

    const current = await (await app.request(`${base}/${attempt.id}`, { headers })).json();
    expect(current).toMatchObject({
      id: attempt.id,
      revision: 2,
      state: "complete",
      credentialsCommitted: true,
      integrationInstalled: true,
      nextAction: { type: "none" },
      account: { ownership: "personal", status: "connected", label: "Microsoft User" },
    });
    expect(current.error).toBeUndefined();
    const installed = (await instances()).find(
      (instance) => instance.instanceKey === "account-sharepoint",
    );
    expect(installed).toMatchObject({
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
      displayName: "OneDrive",
      connectionRef: { connectionId: current.account.id },
    });
    // Every reviewed tool, exactly as the app's automatic install chose.
    expect(installed!.allowedTools).toHaveLength(2);
    // Nothing is pending for the app to resume.
    const pending = await (await app.request(base, { headers })).json();
    expect(JSON.stringify(pending)).not.toContain(attempt.id);
    // A replayed callback changes nothing.
    expect((await callback(fixture, state)).headers.get("location")).toBe(
      "https://host.example/capabilities",
    );
    expect(await (await app.request(`${base}/${attempt.id}`, { headers })).json()).toEqual(current);
    expect(fixture.tokenRequests).toHaveLength(1);

    function instances() {
      return listInstalledApiIntegrations(client.db, workspace.workspaceId, workspace.subjectId);
    }
  }, 60_000);

  async function beginBuiltIn(
    fixture: ReturnType<typeof providerFixture>,
    workspace: Awaited<ReturnType<typeof freshWorkspace>>,
    instanceKey: string,
    definition: { id: string; name: string } = MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION,
  ) {
    const app = testApp(fixture);
    const headers = {
      authorization: await bearer(workspace),
      "content-type": "application/json",
      "x-opengeni-access-key": EDGE_ACCESS_KEY,
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    };
    const base = `/v1/workspaces/${workspace.workspaceId}/connect/attempts`;
    const begun = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: definition.id,
        ownership: "personal",
        returnUrl: "https://host.example/capabilities",
        idempotencyKey: crypto.randomUUID(),
        installationTarget: {
          instanceKey,
          displayName:
            definition.id === MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id
              ? "OneDrive"
              : definition.name,
        },
      }),
    });
    expect(begun.status).toBe(200);
    const attempt = await begun.json();
    const state = new URL(attempt.nextAction.url).searchParams.get("state")!;
    const read = async (id = attempt.id) =>
      await (await app.request(`${base}/${id}`, { headers })).json();
    const installedFor = async () =>
      (
        await listInstalledApiIntegrations(client.db, workspace.workspaceId, workspace.subjectId)
      ).find((instance) => instance.instanceKey === instanceKey);
    return { app, headers, base, attempt, state, read, installedFor };
  }

  test("the callback reads the reviewed tools before its commit, holding no lock", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const setup = await beginBuiltIn(fixture, workspace, "account-before-commit");
    // While the provider's API description is read (a network call that can
    // take seconds), nothing may hold the attempt row or any other lock the
    // commit takes: another transaction locks it without waiting. The read
    // runs alongside the code exchange, whose own short transactions may
    // still be settling, so the read waits until they are done; a transaction
    // held across the read would never be done while the read is pending.
    const lockedDuringRead: boolean[] = [];
    fixture.setOnSourceRead(async () => {
      const lockedNow = () =>
        shared!.admin
          .begin(async (sql) => {
            await sql`select id from connect_attempts where id = ${setup.attempt.id}::uuid for update nowait`;
            const open = await sql`select count(*)::int as count from pg_stat_activity
              where datname = current_database() and pid <> pg_backend_pid()
                and state like 'idle in transaction%'`;
            return open[0]!.count > 0;
          })
          .catch(() => true);
      let locked = await lockedNow();
      for (let check = 0; locked && check < 60; check += 1) {
        await Bun.sleep(50);
        locked = await lockedNow();
      }
      lockedDuringRead.push(locked);
    });
    expect((await callback(fixture, setup.state)).status).toBe(302);
    fixture.setOnSourceRead(undefined);
    expect(lockedDuringRead).toEqual([false]);
    expect(await setup.read()).toMatchObject({ state: "complete", integrationInstalled: true });
  }, 60_000);

  test("when the callback cannot read the tools, the server keeps trying and finishes alone", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const setup = await beginBuiltIn(fixture, workspace, "account-retried");
    setCuratedConnectFinishRetryDelays([25, 25, 25, 25, 25, 25, 25, 25]);
    try {
      // The provider's description is down while the person signs in.
      fixture.setSourceAvailable(false);
      expect((await callback(fixture, setup.state)).status).toBe(302);
      expect(await setup.read()).toMatchObject({ state: "connected_but_incomplete" });
      expect(await setup.installedFor()).toBeUndefined();
      // It comes back. Nobody opens the app; the server finishes on its own.
      fixture.setSourceAvailable(true);
      let current = await setup.read();
      for (let wait = 0; wait < 100 && current.state !== "complete"; wait += 1) {
        await Bun.sleep(50);
        current = await setup.read();
      }
      expect(current).toMatchObject({
        revision: 3,
        state: "complete",
        credentialsCommitted: true,
        integrationInstalled: true,
        nextAction: { type: "none" },
      });
      expect(await setup.installedFor()).toMatchObject({
        definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
        connectionRef: { connectionId: current.account.id },
      });
    } finally {
      fixture.setSourceAvailable(true);
      stopCuratedConnectFinishRetries();
      setCuratedConnectFinishRetryDelays([]);
    }
  }, 60_000);

  test("a setup left with a saved account and no tools finishes when Capabilities opens, even after it expired", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const setup = await beginBuiltIn(fixture, workspace, "account-left-behind");
    // Before this release: the account was saved and the person closed the
    // dialog on "Finishing setup…", so its tools were never added. Its
    // attempt has since passed its short expiry.
    fixture.setSourceAvailable(false);
    expect((await callback(fixture, setup.state)).status).toBe(302);
    fixture.setSourceAvailable(true);
    expect(await setup.read()).toMatchObject({ state: "connected_but_incomplete" });
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    // Time passes (the origin guard keeps the deadline fixed for the app).
    await shared!.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update connect_attempts set expires_at = ${expiresAt}::timestamptz,
        projection = jsonb_set(projection, '{expiresAt}', to_jsonb(${expiresAt}::text))
        where id = ${setup.attempt.id}::uuid`;
    });
    // Reading it now (as a reopened app would) marks it expired.
    expect(await setup.read()).toMatchObject({ state: "expired", credentialsCommitted: true });
    expect(await setup.installedFor()).toBeUndefined();
    const finish = (authorization = setup.headers.authorization) =>
      setup.app.request(`${setup.base}/finish`, {
        method: "POST",
        headers: { ...setup.headers, authorization },
      });

    // Someone without the right to add their own accounts finishes nothing.
    const readOnly = await finish(
      await bearer(workspace, "human_session", ["connections:read", "workspace:read"]),
    );
    expect(readOnly.status).toBe(200);
    expect(await readOnly.json()).toEqual([]);
    expect(await setup.installedFor()).toBeUndefined();

    // The person opens Capabilities: the setup finishes with no dialog.
    const opened = await finish();
    expect(opened.status).toBe(200);
    const completed = await opened.json();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id: setup.attempt.id,
      revision: 4,
      state: "complete",
      integrationInstalled: true,
      installationTarget: { instanceKey: "account-left-behind", displayName: "OneDrive" },
    });
    const installed = await setup.installedFor();
    expect(installed).toMatchObject({
      definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
      connectionRef: { connectionId: completed[0].account.id },
    });
    expect(installed!.allowedTools).toHaveLength(2);
    // Opening it again finds nothing left to do.
    expect(await (await finish()).json()).toEqual([]);
  }, 60_000);

  test("finishing later never brings back an account the person removed", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const setup = await beginBuiltIn(fixture, workspace, "account-removed");
    fixture.setSourceAvailable(false);
    expect((await callback(fixture, setup.state)).status).toBe(302);
    fixture.setSourceAvailable(true);
    const left = await setup.read();
    const removed = await setup.app.request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${left.account.id}`,
      { method: "DELETE", headers: setup.headers },
    );
    expect(removed.status).toBeLessThan(300);
    const opened = await setup.app.request(`${setup.base}/finish`, {
      method: "POST",
      headers: setup.headers,
    });
    expect(await opened.json()).toEqual([]);
    expect(await setup.installedFor()).toBeUndefined();
  }, 60_000);

  test("a leftover for an integration since withdrawn from the workspace stays unfinished", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const previousEnabled = settings.microsoftTeamsToolsEnabled;
    const previousWorkspaces = settings.microsoftTeamsAllowedWorkspaceIds;
    try {
      // Offered to this workspace only.
      settings.microsoftTeamsToolsEnabled = false;
      settings.microsoftTeamsAllowedWorkspaceIds = [workspace.workspaceId];
      const setup = await beginBuiltIn(
        fixture,
        workspace,
        "teams-withdrawn",
        MICROSOFT_TEAMS_INTEGRATION_DEFINITION,
      );
      fixture.microsoftPlans.push({
        scopes: [...MICROSOFT_TEAMS_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "teams-refresh-token",
      });
      fixture.setSourceAvailable(false);
      expect((await callback(fixture, setup.state)).status).toBe(302);
      fixture.setSourceAvailable(true);
      expect(await setup.read()).toMatchObject({ state: "connected_but_incomplete" });
      const finish = () =>
        setup.app.request(`${setup.base}/finish`, { method: "POST", headers: setup.headers });
      // Teams is withdrawn from this workspace before Capabilities opens.
      settings.microsoftTeamsAllowedWorkspaceIds = [];
      const opened = await finish();
      expect(opened.status).toBe(200);
      expect(await opened.json()).toEqual([]);
      expect(await setup.installedFor()).toBeUndefined();
      // Offered here again, the same leftover finishes.
      settings.microsoftTeamsAllowedWorkspaceIds = [workspace.workspaceId];
      expect(await (await finish()).json()).toMatchObject([
        { id: setup.attempt.id, state: "complete", integrationInstalled: true },
      ]);
      expect(await setup.installedFor()).toMatchObject({
        definitionId: MICROSOFT_TEAMS_INTEGRATION_DEFINITION.id,
      });
    } finally {
      settings.microsoftTeamsToolsEnabled = previousEnabled;
      settings.microsoftTeamsAllowedWorkspaceIds = previousWorkspaces;
    }
  }, 60_000);

  test("an older leftover never brings back tools the person removed after connecting the account again", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    // The first setup saved the account but not its tools.
    const first = await beginBuiltIn(fixture, workspace, "account-first");
    fixture.setSourceAvailable(false);
    expect((await callback(fixture, first.state)).status).toBe(302);
    fixture.setSourceAvailable(true);
    const left = await first.read();
    expect(left).toMatchObject({ state: "connected_but_incomplete" });
    // The person connects the same account again, which finishes...
    const second = await beginBuiltIn(fixture, workspace, "account-second");
    expect((await callback(fixture, second.state)).status).toBe(302);
    const done = await second.read();
    expect(done).toMatchObject({ state: "complete", integrationInstalled: true });
    expect(done.account.id).toBe(left.account.id);
    // ...and then removes its tools.
    const installed = (await second.installedFor())!;
    await uninstallApiIntegration(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: workspace.subjectId,
      capabilityId: installed.capabilityId,
      instanceKey: installed.instanceKey,
      expectedInstallationVersion: installed.installationVersion,
      expectedInstanceVersion: installed.instanceVersion,
    });
    const opened = await first.app.request(`${first.base}/finish`, {
      method: "POST",
      headers: first.headers,
    });
    expect(await opened.json()).toEqual([]);
    expect(await first.installedFor()).toBeUndefined();
    expect(
      (
        await listInstalledApiIntegrations(client.db, workspace.workspaceId, workspace.subjectId)
      ).filter((instance) => instance.connectionRef?.connectionId === left.account.id),
    ).toEqual([]);
  }, 60_000);

  test("two finishes at once add one account's tools once", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    // Two setups of the same account were each left without tools (say, a
    // second sign-in from another tab whose callback also could not read them).
    const first = await beginBuiltIn(fixture, workspace, "account-tab-one");
    const second = await beginBuiltIn(fixture, workspace, "account-tab-two");
    fixture.setSourceAvailable(false);
    expect((await callback(fixture, first.state)).status).toBe(302);
    expect((await callback(fixture, second.state)).status).toBe(302);
    fixture.setSourceAvailable(true);
    const connectionId = (await first.read()).account.id;
    expect((await second.read()).account.id).toBe(connectionId);
    // Capabilities and a chat card open together.
    const results = await Promise.all(
      [first, second].map(async (setup) =>
        (
          await setup.app.request(`${setup.base}/finish`, {
            method: "POST",
            headers: setup.headers,
          })
        ).json(),
      ),
    );
    expect(results.flat()).toHaveLength(1);
    const bound = (
      await listInstalledApiIntegrations(client.db, workspace.workspaceId, workspace.subjectId)
    ).filter((instance) => instance.connectionRef?.connectionId === connectionId);
    expect(bound).toHaveLength(1);
    expect(bound[0]!.instanceKey).toBe("account-tab-two");
  }, 60_000);

  test("a non-human principal cannot request personal ownership", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    const refused = await start(
      fixture,
      workspace,
      { definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id, ownership: "personal" },
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
    fixture.microsoftPlans.push({
      scopes: [...MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "microsoft-refresh-token",
    });
    const allowed = await start(
      fixture,
      workspace,
      { definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id, ownership: "workspace" },
      "service",
    );
    expect(allowed.response.status).toBe(200);
    const connected = await callback(
      fixture,
      new URL(allowed.authorizationUrl).searchParams.get("state")!,
      "fixture-code",
      "/v1/integrations/provider-oauth/callback",
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

  // What Microsoft sends back when an organization's consent policy stopped the
  // person: each leaves the attempt with the administrator's approval link and
  // returns the browser to the app that started it.
  const consentCallbacks = [
    {
      name: "consent missing (AADSTS65001)",
      error: "access_denied",
      description:
        "AADSTS65001: The user or administrator has not consented to use the application.",
      state: "failed",
      code: "admin_consent_required",
    },
    {
      name: "only an administrator may grant it (AADSTS90094)",
      error: "access_denied",
      description: "AADSTS90094: The grant requires admin permission.",
      state: "failed",
      code: "admin_consent_required",
    },
    {
      name: "an administrator has to approve the request (AADSTS90093)",
      error: "access_denied",
      description: "AADSTS90093: Calling principal cannot consent due to lack of permissions.",
      state: "failed",
      code: "admin_consent_required",
    },
    {
      name: "consent_required",
      error: "consent_required",
      description: undefined,
      state: "failed",
      code: "admin_consent_required",
    },
    {
      name: "left the approval page (AADSTS65004)",
      error: "access_denied",
      description: "AADSTS65004: User declined to consent to access the app.",
      state: "cancelled",
      code: "provider_denied",
    },
    {
      name: "access_denied without a description",
      error: "access_denied",
      description: undefined,
      state: "cancelled",
      code: "provider_denied",
    },
    {
      name: "another provider error",
      error: "server_error",
      description: "AADSTS50000: There was an error issuing a token.",
      state: "failed",
      code: "provider_denied",
    },
  ] as const;

  for (const definition of [
    MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
    MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION,
  ]) {
    test(`a ${definition.id} sign-in that returns a consent error carries the approval link`, async () => {
      if (!available) return;
      const workspace = await freshWorkspace();
      const fixture = providerFixture();
      const app = testApp(fixture);
      const headers = {
        authorization: await bearer(workspace),
        "content-type": "application/json",
        "x-opengeni-access-key": EDGE_ACCESS_KEY,
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      };
      const base = `/v1/workspaces/${workspace.workspaceId}/connect/attempts`;
      for (const returned of consentCallbacks) {
        const begun = await app.request(base, {
          method: "POST",
          headers,
          body: JSON.stringify({
            providerId: definition.id,
            ownership: "personal",
            returnUrl: "https://host.example/capabilities",
            idempotencyKey: crypto.randomUUID(),
          }),
        });
        expect(begun.status).toBe(200);
        const attempt = await begun.json();
        const signIn = new URL(attempt.nextAction.url);
        const query = new URLSearchParams({
          error: returned.error,
          state: signIn.searchParams.get("state")!,
        });
        if (returned.description) query.set("error_description", returned.description);
        const response = await app.request(`/v1/integrations/provider-oauth/callback?${query}`);
        expect(response.status, returned.name).toBe(302);
        expect(response.headers.get("location"), returned.name).toBe(
          "https://host.example/capabilities",
        );

        const current = await (await app.request(`${base}/${attempt.id}`, { headers })).json();
        expect(current, returned.name).toMatchObject({
          state: returned.state,
          nextAction: { type: "none" },
          credentialsCommitted: false,
          error: { code: returned.code, retryable: true },
        });
        const link = new URL(
          /https:\/\/login\.microsoftonline\.com\/\S+?(?=\s|$)/.exec(current.error.message)![0],
        );
        expect(link.pathname, returned.name).toBe("/organizations/v2.0/adminconsent");
        expect(link.searchParams.get("client_id")).toBe(MICROSOFT_CLIENT_ID);
        expect(link.searchParams.get("redirect_uri")).toBe(signIn.searchParams.get("redirect_uri"));
        expect(link.searchParams.get("state")).toBe("microsoft_admin_consent");
        expect(link.searchParams.get("scope")).not.toContain("offline_access");
        // The approval link never carries the sign-in's signed state.
        expect(current.error.message).not.toContain(signIn.searchParams.get("state")!);
      }
      expect(fixture.tokenRequests).toHaveLength(0);
      expect(
        await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId),
      ).toEqual([]);
    }, 60_000);
  }

  test("an administrator returning from the approval link sees whether it was approved", async () => {
    if (!available) return;
    const app = testApp(providerFixture());
    for (const path of [
      "/v1/integrations/provider-oauth/callback",
      "/v1/integrations/oauth/callback",
    ]) {
      const approved = await app.request(
        `${path}?admin_consent=True&tenant=tenant-1&state=microsoft_admin_consent`,
      );
      expect(approved.status, path).toBe(200);
      expect(await approved.text()).toContain("Approved");
      const refused = await app.request(
        `${path}?error=access_denied&error_description=AADSTS65004&state=microsoft_admin_consent`,
      );
      expect(refused.status, path).toBe(400);
      expect(await refused.text()).toContain("Not approved");
    }
  });
});
