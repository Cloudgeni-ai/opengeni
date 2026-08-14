import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import {
  GOOGLE_DRIVE_INTEGRATION_DEFINITION,
  GOOGLE_GMAIL_INTEGRATION_DEFINITION,
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
  deleteWorkspace,
  ensureManagedAccessForUserWithOrganizationMemberships,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";

import { createApp } from "../src/app";

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
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
  };
}

async function freshManagedWorkspace() {
  const userId = `provider-oauth-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.com`,
    name: "Provider OAuth managed user",
  });
  const grant = access.accessContext.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.accessContext.defaultWorkspaceId,
  )!;
  for (const workspaceGrant of access.accessContext.workspaceGrants) {
    workspaceIds.push(workspaceGrant.workspaceId);
  }
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
  };
}

async function bearer(
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  permissions: Permission[] = ["connections:read", "connections:write", "workspace:read"],
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: workspace.subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

type TokenPlan = {
  scopes: string[];
  refreshToken?: string;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function providerFixture(
  options: {
    googleTokenGate?: Promise<void>;
    googleTokenStarted?: () => void;
  } = {},
) {
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
    if (url.href === GOOGLE_GMAIL_INTEGRATION_DEFINITION.authentication.tokenUrl) {
      const body = requestBody(init?.body);
      tokenRequests.push({
        family: "google",
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      options.googleTokenStarted?.();
      await options.googleTokenGate;
      const plan = googlePlans.shift() ?? {
        scopes: [...GOOGLE_GMAIL_INTEGRATION_DEFINITION.authentication.scopes],
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
  } as never);
}

async function start(
  fixture: ReturnType<typeof providerFixture>,
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  payload: Record<string, unknown>,
  permissions?: Permission[],
) {
  const response = await testApp(fixture).request(
    `/v1/workspaces/${workspace.workspaceId}/integrations/oauth/start`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, permissions),
        "content-type": "application/json",
        "x-opengeni-access-key": EDGE_ACCESS_KEY,
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      },
      body: JSON.stringify(payload),
    },
  );
  const body = (await response.json()) as {
    authorizationUrl?: string;
    error?: unknown;
  };
  return { response, authorizationUrl: body.authorizationUrl ?? "", body };
}

async function disconnect(
  fixture: ReturnType<typeof providerFixture>,
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  connectionId: string,
  permissions?: Permission[],
) {
  return await testApp(fixture).request(
    `/v1/workspaces/${workspace.workspaceId}/connections/${connectionId}`,
    {
      method: "DELETE",
      headers: {
        authorization: await bearer(workspace, permissions),
        "x-opengeni-access-key": EDGE_ACCESS_KEY,
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      },
    },
  );
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
  test("requires literal account admin for workspace Google Drive and revalidates it before callback exchange", async () => {
    if (!available) return;
    const ordinary = await freshWorkspace();
    const ordinaryFixture = providerFixture();
    const workspaceDenied = await start(
      ordinaryFixture,
      ordinary,
      {
        definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
        ownership: "workspace",
      },
      ["connections:read", "connections:write", "workspace:read", "workspace:admin"],
    );
    expect(workspaceDenied.response.status).toBe(403);
    expect(workspaceDenied.body).toMatchObject({
      error: { message: expect.stringContaining("account:admin") },
    });

    ordinaryFixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "personal-drive-refresh",
    });
    const personalStart = await start(ordinaryFixture, ordinary, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    expect(personalStart.response.status).toBe(200);
    const personalCallback = await callback(
      ordinaryFixture,
      new URL(personalStart.authorizationUrl).searchParams.get("state")!,
    );
    expect(
      new URL(personalCallback.headers.get("location")!).searchParams.get("integration_oauth"),
    ).toBe("success");

    const managed = await freshManagedWorkspace();
    const managedFixture = providerFixture();
    managedFixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "must-not-persist",
    });
    const managedStart = await start(
      managedFixture,
      managed,
      {
        definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
        ownership: "workspace",
      },
      ["account:admin", "connections:read", "connections:write", "workspace:read"],
    );
    expect(managedStart.response.status).toBe(200);
    await shared!.admin`
      update organization_memberships
      set status = 'suspended', authorization_revision = authorization_revision + 1,
          updated_at = now()
      where account_id = ${managed.accountId} and subject_id = ${managed.subjectId}
    `;
    const revokedCallback = await callback(
      managedFixture,
      new URL(managedStart.authorizationUrl).searchParams.get("state")!,
    );
    expect(new URL(revokedCallback.headers.get("location")!).searchParams.get("reason")).toBe(
      "connection_conflict",
    );
    expect(managedFixture.tokenRequests).toHaveLength(0);
  }, 60_000);

  test("atomically rejects workspace Google Drive persistence after account authority is revoked", async () => {
    if (!available) return;
    const managed = await freshManagedWorkspace();
    const tokenGate = deferred();
    const tokenStarted = deferred();
    const fixture = providerFixture({
      googleTokenGate: tokenGate.promise,
      googleTokenStarted: tokenStarted.resolve,
    });
    fixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "must-not-persist-after-revocation",
    });
    const started = await start(
      fixture,
      managed,
      {
        definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
        ownership: "workspace",
      },
      ["account:admin", "connections:read", "connections:write", "workspace:read"],
    );
    expect(started.response.status).toBe(200);

    const pending = callback(fixture, new URL(started.authorizationUrl).searchParams.get("state")!);
    await tokenStarted.promise;
    await shared!.admin`
      update organization_memberships
      set status = 'suspended', authorization_revision = authorization_revision + 1,
          updated_at = now()
      where account_id = ${managed.accountId} and subject_id = ${managed.subjectId}
    `;
    tokenGate.resolve();

    const rejected = await pending;
    expect(new URL(rejected.headers.get("location")!).searchParams.get("reason")).toBe(
      "connection_conflict",
    );
    expect(fixture.tokenRequests).toHaveLength(1);
    const persisted = await shared!.admin<Array<{ id: string; credential_encrypted: string }>>`
      select id, credential_encrypted
      from connections
      where workspace_id = ${managed.workspaceId}
        and subject_id is null
        and provider_domain = 'www.googleapis.com'
    `;
    expect(persisted).toEqual([]);
  }, 60_000);

  test("requires literal account admin to disconnect workspace Google Drive without changing personal disconnect", async () => {
    if (!available) return;
    const managed = await freshManagedWorkspace();
    const workspaceFixture = providerFixture();
    workspaceFixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "workspace-drive-refresh",
    });
    const workspaceStart = await start(
      workspaceFixture,
      managed,
      {
        definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
        ownership: "workspace",
      },
      ["account:admin", "connections:read", "connections:write", "workspace:read"],
    );
    const workspaceCallback = await callback(
      workspaceFixture,
      new URL(workspaceStart.authorizationUrl).searchParams.get("state")!,
    );
    expect(
      new URL(workspaceCallback.headers.get("location")!).searchParams.get("integration_oauth"),
    ).toBe("success");
    const workspaceConnection = (
      await listConnectionsMetadata(client.db, managed.workspaceId, managed.subjectId)
    )[0]!;
    const workspaceDenied = await disconnect(workspaceFixture, managed, workspaceConnection.id, [
      "connections:read",
      "connections:write",
      "workspace:read",
      "workspace:admin",
    ]);
    expect(workspaceDenied.status).toBe(403);
    expect(await workspaceDenied.json()).toMatchObject({
      error: { message: expect.stringContaining("account:admin") },
    });

    const personal = await freshWorkspace();
    const personalFixture = providerFixture();
    personalFixture.googlePlans.push({
      scopes: [...GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "personal-drive-refresh",
    });
    const personalStart = await start(personalFixture, personal, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    await callback(
      personalFixture,
      new URL(personalStart.authorizationUrl).searchParams.get("state")!,
    );
    const personalConnection = (
      await listConnectionsMetadata(client.db, personal.workspaceId, personal.subjectId)
    )[0]!;
    const personalDisconnected = await disconnect(personalFixture, personal, personalConnection.id);
    expect(personalDisconnected.status).toBe(200);
    expect(await personalDisconnected.json()).toMatchObject({
      connection: { id: personalConnection.id, status: "revoked" },
    });
  }, 60_000);

  test("connects a Google definition with signed PKCE state and no callback perimeter credential", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = providerFixture();
    fixture.googlePlans.push({
      scopes: [...GOOGLE_GMAIL_INTEGRATION_DEFINITION.authentication.scopes],
      refreshToken: "google-refresh-token",
    });
    const started = await start(fixture, workspace, {
      definitionId: GOOGLE_GMAIL_INTEGRATION_DEFINITION.id,
      ownership: "personal",
    });
    expect(started.response.status).toBe(200);
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual(
      GOOGLE_GMAIL_INTEGRATION_DEFINITION.authentication.scopes,
    );
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent select_account");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8000/v1/integrations/provider-oauth/callback",
    );
    const state = authorizationUrl.searchParams.get("state")!;
    const connected = await callback(fixture, state);
    expect(connected.status).toBe(302);
    const location = new URL(connected.headers.get("location")!);
    expect(location.origin).toBe("http://127.0.0.1:3000");
    expect(location.searchParams.get("integration_oauth")).toBe("success");
    expect(location.searchParams.get("definitionId")).toBe(GOOGLE_GMAIL_INTEGRATION_DEFINITION.id);

    const connections = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect(connection).toMatchObject({
      subjectId: workspace.subjectId,
      providerDomain: "gmail.googleapis.com",
      kind: "oauth2",
      status: "active",
      grantedScopes: GOOGLE_GMAIL_INTEGRATION_DEFINITION.authentication.scopes,
      metadata: {
        credentialRole: API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
        providerFamily: "google",
        providerPrincipalId: "google-principal-1",
        providerEmail: "google.user@example.com",
        authorizedDefinitionIds: [GOOGLE_GMAIL_INTEGRATION_DEFINITION.id],
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
      token_endpoint: GOOGLE_GMAIL_INTEGRATION_DEFINITION.authentication.tokenUrl,
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
        body: JSON.stringify({
          credential: { access_token: "bypass-attempt" },
        }),
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
        scopes: [...GOOGLE_GMAIL_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "google-refresh-a",
      },
      {
        scopes: [...GOOGLE_GMAIL_INTEGRATION_DEFINITION.authentication.scopes],
        refreshToken: "google-refresh-b",
      },
    );
    const [left, right] = await Promise.all([
      start(fixture, workspace, {
        definitionId: GOOGLE_GMAIL_INTEGRATION_DEFINITION.id,
        ownership: "personal",
      }),
      start(fixture, workspace, {
        definitionId: GOOGLE_GMAIL_INTEGRATION_DEFINITION.id,
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
    ).filter((connection) => connection.providerDomain === "gmail.googleapis.com");
    expect(connections).toHaveLength(1);

    const insufficientWorkspace = await freshWorkspace();
    const insufficient = providerFixture();
    insufficient.googlePlans.push({
      scopes: ["openid", "email", "profile"],
      refreshToken: "must-not-persist",
    });
    const insufficientStart = await start(insufficient, insufficientWorkspace, {
      definitionId: GOOGLE_GMAIL_INTEGRATION_DEFINITION.id,
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
});
