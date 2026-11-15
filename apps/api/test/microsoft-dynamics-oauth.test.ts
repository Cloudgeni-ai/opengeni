import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  buildConnectionTokenResolver,
  createConnection,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  encryptEnvironmentValue,
  ensureExternalIdentity,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import * as network from "@opengeni/network";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { createApp } from "../src/app";
import { chooseMcpAuthorizeScopes } from "../src/integrations/oauth-client";
import {
  assertAuthorizationServerNotReserved,
  builtInOAuthProfileFor,
  DEFAULT_OAUTH_PROFILE,
} from "../src/integrations/oauth-profiles";

const DATAVERSE_MCP_URL = "https://contoso.crm.dynamics.com/api/mcp";
const DATAVERSE_PRM_URL =
  "https://contoso.crm.dynamics.com/.well-known/oauth-protected-resource/api/mcp";
const DATAVERSE_SCOPE = "https://contoso.crm.dynamics.com/user_impersonation";
const FINANCE_MCP_URL = "https://usmf.operations.dynamics.com/mcp";
const ENTRA = "https://login.microsoftonline.com";
const ENTRA_METADATA_URL = `${ENTRA}/organizations/v2.0/.well-known/openid-configuration`;
const ENTRA_TOKEN_URL = `${ENTRA}/organizations/oauth2/v2.0/token`;
const ENTRA_KEYS_URL = `${ENTRA}/organizations/discovery/v2.0/keys`;
const TENANT_ID = "8f3b2c1a-0d4e-4f5a-9b6c-7d8e9f0a1b2c";
const CLIENT_ID = "dynamics-fixture-client";
const CLIENT_SECRET = "dynamics-fixture-secret";
const ACCESS_TOKEN = "dynamics-fixture-access";
const REFRESH_TOKEN = "dynamics-fixture-refresh";

let database: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
const keys = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256" };

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) {
    throw new Error("The PostgreSQL admin and app fixture URLs must be set together");
  }
  const admin = adminUrl ? postgres(adminUrl, { max: 4 }) : null;
  const acquired =
    admin && adminUrl && appUrl
      ? { admin, adminUrl, appUrl, release: async () => await admin.end() }
      : await acquireSharedTestDatabase("microsoft-dynamics-oauth");
  if (!acquired) throw new Error("Microsoft Dynamics OAuth proof requires the PostgreSQL fixture");
  database = acquired;
  client = createDb(database.appUrl);
}, 180_000);

afterAll(async () => {
  try {
    for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  } finally {
    await client?.close();
    await database?.release();
  }
}, 180_000);

function entraMetadata() {
  // Microsoft's real document: a tenant-templated issuer and no PKCE advertisement.
  return {
    issuer: `${ENTRA}/{tenantid}/v2.0`,
    authorization_endpoint: `${ENTRA}/organizations/oauth2/v2.0/authorize`,
    token_endpoint: ENTRA_TOKEN_URL,
    jwks_uri: ENTRA_KEYS_URL,
    userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    response_types_supported: ["code", "id_token", "code id_token"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
  };
}

async function idToken(nonce: string | null, tenant = TENANT_ID) {
  return await new SignJWT({
    tid: tenant,
    email: "seller@contoso.example",
    name: "Contoso Seller",
    ...(nonce ? { nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(`${ENTRA}/${tenant}/v2.0`)
    .setAudience(CLIENT_ID)
    .setSubject("pairwise-subject")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(keys.privateKey);
}

async function fixture(
  options: {
    prm?: Record<string, unknown> | "absent";
    idTokenTenant?: string;
  } = {},
) {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Dynamics customer",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Dynamics callback fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "dynamics-callback-user",
  });
  const key = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Dynamics callback fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["workspace:read", "connections:read", "connections:write"],
  });
  const settings = testSettings({
    productAccessMode: "managed",
    integrationsEnabled: true,
    publicBaseUrl: "https://runtime.example.test",
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    integrationsStateSecret: "dynamics-oauth-fixture-state",
    microsoftDynamicsClientId: CLIENT_ID,
    microsoftDynamicsClientSecret: CLIENT_SECRET,
  });
  const app = createApp({
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    settings,
  });
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
    ),
  };
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect/attempts`;
  const returnUrl = "https://product.example.test/settings?connected=dynamics";
  const requests: Array<{ url: string; authorization: string | null; body: URLSearchParams }> = [];
  let nonce: string | null = null;
  const transport = spyOn(network, "pinnedFetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (init?.body instanceof URLSearchParams) for (const [k, v] of init.body) body.set(k, v);
    requests.push({ url, authorization, body });
    if (url === DATAVERSE_PRM_URL) {
      if (options.prm === "absent") return new Response(null, { status: 404 });
      return Response.json(
        options.prm ?? {
          resource: DATAVERSE_MCP_URL,
          authorization_servers: [`${ENTRA}/${TENANT_ID}/v2.0`],
          scopes_supported: [DATAVERSE_SCOPE],
        },
      );
    }
    if (url.includes("/.well-known/oauth-protected-resource"))
      return new Response(null, { status: 404 });
    if (url === ENTRA_METADATA_URL) return Response.json(entraMetadata());
    if (url === ENTRA_KEYS_URL) return Response.json({ keys: [publicJwk] });
    if (url === ENTRA_TOKEN_URL)
      return Response.json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "https://contoso.crm.dynamics.com/mcp.tools",
        ...(body.get("grant_type") === "authorization_code"
          ? { id_token: await idToken(nonce, options.idTokenTenant) }
          : {}),
      });
    if (url === DATAVERSE_MCP_URL)
      return Response.json(
        { error: "The MCP client is not allowed for this environment." },
        { status: 403 },
      );
    throw new Error(`Unexpected synthetic Microsoft destination: ${url}`);
  });
  async function begin(
    mcpUrl = DATAVERSE_MCP_URL,
    ownership: "personal" | "workspace" = "personal",
  ) {
    const response = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "mcp-oauth",
        ownership,
        returnUrl,
        idempotencyKey: randomUUID(),
      }),
    });
    expect(response.status).toBe(200);
    const attempt = await response.json();
    return await app.request(`${base}/${attempt.id}/advance`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: attempt.revision,
        idempotencyKey: randomUUID(),
        action: { type: "credentials", values: { mcpUrl } },
      }),
    });
  }
  async function authorize(
    mcpUrl = DATAVERSE_MCP_URL,
    ownership: "personal" | "workspace" = "personal",
  ) {
    const advanced = await begin(mcpUrl, ownership);
    expect(advanced.status).toBe(200);
    const ready = await advanced.json();
    expect(ready.state).toBe("requires_user_action");
    const authorizationUrl = new URL(ready.nextAction.url);
    nonce = authorizationUrl.searchParams.get("nonce");
    return { attempt: ready, authorizationUrl, state: authorizationUrl.searchParams.get("state")! };
  }
  const callback = (params: Record<string, string>) =>
    app.request(`/v1/integrations/oauth/callback?${new URLSearchParams(params)}`);
  const read = async (id: string) => (await app.request(`${base}/${id}`, { headers })).json();
  return {
    settings,
    identity,
    requests,
    begin,
    authorize,
    callback,
    read,
    restore: () => transport.mockRestore(),
  };
}

describe("Microsoft Dynamics MCP OAuth", () => {
  test("the profile matches per-customer endpoints and leaves Entra open to other resources", () => {
    const dataverse = builtInOAuthProfileFor({ mcpUrl: DATAVERSE_MCP_URL });
    expect(dataverse?.key).toBe("microsoft-dynamics");
    expect(builtInOAuthProfileFor({ mcpUrl: FINANCE_MCP_URL })?.key).toBe("microsoft-dynamics");
    expect(builtInOAuthProfileFor({ mcpUrl: "https://contoso.example/api/mcp" })).toBeNull();
    const entra = {
      issuer: `${ENTRA}/${TENANT_ID}/v2.0`,
      authorizationServer: `${ENTRA}/${TENANT_ID}/v2.0`,
      authorizationEndpoint: `${ENTRA}/${TENANT_ID}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${ENTRA}/${TENANT_ID}/oauth2/v2.0/token`,
    };
    expect(() => assertAuthorizationServerNotReserved(entra, DEFAULT_OAUTH_PROFILE)).not.toThrow();
    // Personal by default, but an admin may share one account with the workspace.
    expect(dataverse?.defaultOwnership).toBe("personal");
    expect(dataverse?.requiredOwnership).toBeUndefined();
  });

  test("signs in with the deployment's Entra app, environment scope and verified identity", async () => {
    const provider = await fixture();
    try {
      const begun = await provider.authorize();
      const url = begun.authorizationUrl;
      expect(url.origin + url.pathname).toBe(`${ENTRA}/organizations/oauth2/v2.0/authorize`);
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.has("resource")).toBe(false);
      expect(url.searchParams.get("scope")?.split(" ")).toEqual([
        DATAVERSE_SCOPE,
        "offline_access",
        "openid",
        "email",
      ]);
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://runtime.example.test/v1/integrations/oauth/callback",
      );

      const response = await provider.callback({ state: begun.state, code: "fixture-code" });
      expect(response.status).toBe(302);
      const completed = await provider.read(begun.attempt.id);
      expect(completed).toMatchObject({ state: "complete", credentialsCommitted: true });
      const exchange = provider.requests.find((request) => request.url === ENTRA_TOKEN_URL)!;
      expect(exchange.body.get("client_secret")).toBe(CLIENT_SECRET);
      expect(exchange.body.has("resource")).toBe(false);

      const [account] = (
        await listConnectionsMetadata(
          client.db,
          provider.identity.personalWorkspaceId,
          provider.identity.subjectId,
        )
      ).filter((connection) => connection.providerDomain === "contoso.crm.dynamics.com");
      expect(account?.metadata).toMatchObject({
        oidcSubject: "pairwise-subject",
        oidcEmail: "seller@contoso.example",
        mcpToolsVerification: { status: "failed" },
      });
      const credential = await loadConnectionCredentialForBroker(client.db, provider.settings, {
        workspaceId: provider.identity.personalWorkspaceId,
        connectionId: account!.id,
        providerDomain: "contoso.crm.dynamics.com",
        kind: "oauth2",
        subjectId: provider.identity.subjectId,
        allowSubjectOwned: true,
      });
      expect(credential?.credential).toMatchObject({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        client_id: CLIENT_ID,
        token_endpoint: ENTRA_TOKEN_URL,
        resource_parameter_supported: false,
        refresh_scope: `${DATAVERSE_SCOPE} offline_access openid email`,
      });
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("an account can be shared with the workspace", async () => {
    const provider = await fixture();
    try {
      const begun = await provider.authorize(DATAVERSE_MCP_URL, "workspace");
      const response = await provider.callback({ state: begun.state, code: "fixture-code" });
      expect(response.status).toBe(302);
      expect(await provider.read(begun.attempt.id)).toMatchObject({ state: "complete" });
      const [account] = (
        await listConnectionsMetadata(client.db, provider.identity.personalWorkspaceId)
      ).filter((connection) => connection.providerDomain === "contoso.crm.dynamics.com");
      expect(account?.subjectId ?? null).toBeNull();
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("an id_token from another tenant than its issuer claims stays unverified", async () => {
    const provider = await fixture({ idTokenTenant: "not-a-tenant" });
    try {
      const begun = await provider.authorize();
      await provider.callback({ state: begun.state, code: "fixture-code" });
      const accounts = await listConnectionsMetadata(
        client.db,
        provider.identity.personalWorkspaceId,
        provider.identity.subjectId,
      );
      expect(accounts.some((account) => account.metadata.oidcSubject)).toBe(false);
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("the environment's own scope is requested even when the server advertises others", async () => {
    const provider = await fixture({
      prm: {
        resource: DATAVERSE_MCP_URL,
        scopes_supported: ["https://contoso.crm.dynamics.com/mcp.tools"],
      },
    });
    try {
      const begun = await provider.authorize();
      expect(begun.authorizationUrl.searchParams.get("scope")?.split(" ")[0]).toBe(DATAVERSE_SCOPE);
      expect(provider.requests.some((request) => request.url === DATAVERSE_PRM_URL)).toBe(false);
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("a caller can't point the Dynamics client at another resource", () => {
    expect(
      chooseMcpAuthorizeScopes({
        mcpUrl: DATAVERSE_MCP_URL,
        requested: ["https://graph.microsoft.com/.default"],
        challenged: ["https://other.crm.dynamics.com/user_impersonation"],
        supported: [DATAVERSE_SCOPE],
        authorizationServerScopesSupported: ["openid", "offline_access"],
        reconnectGrantedScopes: ["https://graph.microsoft.com/Mail.Read"],
      }),
    ).toEqual([DATAVERSE_SCOPE, "offline_access"]);
  });

  test("Finance and Operations signs in for its environment's resource", async () => {
    const provider = await fixture();
    try {
      const begun = await provider.authorize(FINANCE_MCP_URL);
      expect(begun.authorizationUrl.searchParams.get("scope")?.split(" ")[0]).toBe(
        "https://usmf.operations.dynamics.com/.default",
      );
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("Microsoft's admin-approval refusal becomes an approval link", async () => {
    const provider = await fixture();
    try {
      const begun = await provider.authorize();
      await provider.callback({
        state: begun.state,
        error: "access_denied",
        error_description: "AADSTS65001: The user or administrator has not consented.",
      });
      const failed = await provider.read(begun.attempt.id);
      expect(failed.state).toBe("failed");
      expect(failed.error.code).toBe("admin_consent_required");
      const link = new URL(failed.error.message.match(/https:\/\/\S+/u)![0]);
      expect(link.origin + link.pathname).toBe(`${ENTRA}/organizations/v2.0/adminconsent`);
      expect(link.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(link.searchParams.get("scope")).toBe(DATAVERSE_SCOPE);
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("refresh names the authorized scope again", async () => {
    const provider = await fixture();
    try {
      const saved = await createConnection(client.db, {
        accountId: provider.identity.accountId,
        workspaceId: provider.identity.personalWorkspaceId,
        subjectId: provider.identity.subjectId,
        providerDomain: "contoso.crm.dynamics.com",
        kind: "oauth2",
        grantedScopes: ["https://contoso.crm.dynamics.com/mcp.tools"],
        credentialEncrypted: encryptEnvironmentValue(
          Buffer.from(provider.settings.environmentsEncryptionKey!, "base64"),
          JSON.stringify({
            access_token: "expired",
            refresh_token: REFRESH_TOKEN,
            token_type: "Bearer",
            expires_at: new Date(Date.now() - 60_000).toISOString(),
            mcp_url: DATAVERSE_MCP_URL,
            resource: DATAVERSE_MCP_URL,
            resource_parameter_supported: false,
            token_endpoint: ENTRA_TOKEN_URL,
            refresh_scope: `${DATAVERSE_SCOPE} offline_access`,
            client_id: CLIENT_ID,
            // A secret rotated since sign-in: refresh uses the deployment's current one.
            client_secret: "rotated-away-secret",
            token_endpoint_auth_method: "client_secret_post",
          }),
        ),
        expiresAt: new Date(Date.now() - 60_000),
        metadata: { mcpUrl: DATAVERSE_MCP_URL, resource: DATAVERSE_MCP_URL },
        createdBySubjectId: provider.identity.subjectId,
      });
      const resolved = await buildConnectionTokenResolver(
        client.db,
        provider.settings,
      )({
        workspaceId: provider.identity.personalWorkspaceId,
        subjectId: provider.identity.subjectId,
        serverId: "dynamics",
        destinationUrl: DATAVERSE_MCP_URL,
        connectionRef: {
          connectionId: saved.id,
          providerDomain: "contoso.crm.dynamics.com",
          kind: "oauth2",
          subjectScope: "subject",
          resource: DATAVERSE_MCP_URL,
        },
      });
      expect(resolved).toMatchObject({ status: "ok" });
      const refresh = provider.requests.find((request) => request.url === ENTRA_TOKEN_URL)!;
      expect(refresh.body.get("grant_type")).toBe("refresh_token");
      expect(refresh.body.get("scope")).toBe(`${DATAVERSE_SCOPE} offline_access`);
      expect(refresh.body.has("resource")).toBe(false);
      expect(refresh.body.get("client_secret")).toBe(CLIENT_SECRET);

      // The Dataverse tools reuse the grant for the same environment's Web API only.
      const resolve = buildConnectionTokenResolver(client.db, provider.settings);
      const at = (destinationUrl: string) =>
        resolve({
          workspaceId: provider.identity.personalWorkspaceId,
          subjectId: provider.identity.subjectId,
          serverId: "dynamics",
          destinationUrl,
          connectionRef: {
            connectionId: saved.id,
            providerDomain: "contoso.crm.dynamics.com",
            kind: "oauth2",
            subjectScope: "subject",
            resource: DATAVERSE_MCP_URL,
          },
        });
      expect(
        await at("https://contoso.crm.dynamics.com/api/data/v9.2/accounts?$top=1"),
      ).toMatchObject({ status: "ok" });
      for (const outside of [
        "https://contoso.crm.dynamics.com/api/data/v9.1/accounts",
        "https://contoso.crm.dynamics.com/XRMServices/2011/Organization.svc",
        "https://other.crm.dynamics.com/api/data/v9.2/accounts",
      ])
        expect((await at(outside)).status).not.toBe("ok");
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("a Finance and Operations grant reaches only its environment's data and metadata", async () => {
    const provider = await fixture();
    try {
      const host = "usmf.operations.dynamics.com";
      const saved = await createConnection(client.db, {
        accountId: provider.identity.accountId,
        workspaceId: provider.identity.personalWorkspaceId,
        subjectId: provider.identity.subjectId,
        providerDomain: host,
        kind: "oauth2",
        grantedScopes: [`https://${host}/.default`],
        credentialEncrypted: encryptEnvironmentValue(
          Buffer.from(provider.settings.environmentsEncryptionKey!, "base64"),
          JSON.stringify({
            access_token: "fresh",
            refresh_token: REFRESH_TOKEN,
            token_type: "Bearer",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            mcp_url: FINANCE_MCP_URL,
            resource: FINANCE_MCP_URL,
            resource_parameter_supported: false,
            token_endpoint: ENTRA_TOKEN_URL,
            refresh_scope: `https://${host}/.default offline_access`,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            token_endpoint_auth_method: "client_secret_post",
          }),
        ),
        expiresAt: new Date(Date.now() + 3_600_000),
        metadata: { mcpUrl: FINANCE_MCP_URL, resource: FINANCE_MCP_URL },
        createdBySubjectId: provider.identity.subjectId,
      });
      const resolve = buildConnectionTokenResolver(client.db, provider.settings);
      const at = (destinationUrl: string) =>
        resolve({
          workspaceId: provider.identity.personalWorkspaceId,
          subjectId: provider.identity.subjectId,
          serverId: "dynamics",
          destinationUrl,
          connectionRef: {
            connectionId: saved.id,
            providerDomain: host,
            kind: "oauth2",
            subjectScope: "subject",
            resource: FINANCE_MCP_URL,
          },
        });
      for (const inside of [
        `https://${host}/data/`,
        `https://${host}/data/CustomersV3?$top=1`,
        `https://${host}/Metadata/PublicEntities('CustomerV3')`,
      ])
        expect(await at(inside)).toMatchObject({ status: "ok" });
      for (const outside of [
        `https://${host}/api/services/SomeService`,
        `https://${host}/database`,
        `https://${host}/data-x/CustomersV3`,
        `https://${host}/data/..%2Fapi/services/SomeService`,
        `https://${host}/data/../api/services/SomeService`,
        `https://other.operations.dynamics.com/data/CustomersV3`,
      ])
        expect((await at(outside)).status).not.toBe("ok");
    } finally {
      provider.restore();
    }
  }, 30_000);
});
