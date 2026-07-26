import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import {
  createDb,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getConnectionMetadata,
  loadConnectionCredentialForBroker,
  loadIntegrationOAuthClient,
  replaceIntegrationOAuthClient,
  type DbClient,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  startTestMcpServer,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "connections-routes-delegation-secret";
const STATE_SECRET = "connections-routes-state-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

const rawKey = randomBytes(32);
const encryptionKey = rawKey.toString("base64");

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_connections");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[connections-routes] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: encryptionKey,
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "https://api.opengeni.test",
  }) as Settings;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

function app(overrides: Partial<Settings> = {}) {
  return createApp({
    settings: { ...settings, ...overrides },
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

function publicApp(dbOverride: unknown = client?.db ?? {}, overrides: Partial<Settings> = {}) {
  const publicSettings = testSettings({
    authRequired: true,
    accessKey: "deployment-key",
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: encryptionKey,
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "https://api.opengeni.test",
    ...overrides,
  }) as Settings;
  return createApp({
    settings: publicSettings,
    db: dbOverride as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

function publicAppWithDeps(
  dbOverride: unknown,
  overrides: Partial<Settings>,
  extraDeps: Record<string, unknown>,
) {
  const publicSettings = testSettings({
    authRequired: true,
    accessKey: "deployment-key",
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: encryptionKey,
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "https://api.opengeni.test",
    ...overrides,
  }) as Settings;
  return createApp({
    settings: publicSettings,
    db: dbOverride as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    ...extraDeps,
  } as never);
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function bearer(
  workspace: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: Permission[],
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

type FakeAuthorizationServer = {
  url: string;
  tokenRequests: URLSearchParams[];
  tokenRequestAuthHeaders: Array<string | null>;
  registrations: Record<string, unknown>[];
  close: () => void;
};

function startFakeAuthorizationServer(
  options: {
    scopesSupported?: string[];
    codeChallengeMethods?: string[];
    tokenEndpointAuthMethodsSupported?: string[];
    clientIdMetadataDocumentSupported?: boolean;
    issuer?: string;
    dcr?: boolean;
    tokenAccessToken?: string | ((body: URLSearchParams) => string);
    tokenStatus?: number;
    tokenError?: string;
  } = {},
): FakeAuthorizationServer {
  const tokenRequests: URLSearchParams[] = [];
  const tokenRequestAuthHeaders: Array<string | null> = [];
  const registrations: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: "urn:test:mcp",
          authorization_servers: [origin],
          scopes_supported: options.scopesSupported ?? ["documents:read"],
        });
      }
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration"
      ) {
        return Response.json({
          issuer: options.issuer ?? origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: options.codeChallengeMethods ?? ["S256"],
          token_endpoint_auth_methods_supported: options.tokenEndpointAuthMethodsSupported ?? [
            "none",
          ],
          client_id_metadata_document_supported: options.clientIdMetadataDocumentSupported ?? true,
          ...(options.dcr ? { registration_endpoint: `${origin}/register` } : {}),
        });
      }
      if (url.pathname === "/register") {
        const registration = (await request.json()) as Record<string, unknown>;
        registrations.push(registration);
        const authMethod =
          typeof registration.token_endpoint_auth_method === "string"
            ? registration.token_endpoint_auth_method
            : "none";
        return Response.json(
          {
            client_id: `${origin}/registered-client/${registrations.length}`,
            ...(authMethod === "client_secret_basic" || authMethod === "client_secret_post"
              ? { client_secret: `secret-${registrations.length}` }
              : {}),
            token_endpoint_auth_method: authMethod,
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());
        tokenRequests.push(body);
        tokenRequestAuthHeaders.push(request.headers.get("authorization"));
        if (options.tokenStatus && options.tokenStatus >= 400) {
          return Response.json(
            {
              error: options.tokenError ?? "invalid_client",
              error_description: "fake token failure",
            },
            { status: options.tokenStatus },
          );
        }
        return Response.json({
          access_token:
            typeof options.tokenAccessToken === "function"
              ? options.tokenAccessToken(body)
              : (options.tokenAccessToken ?? "mcp-access-token"),
          refresh_token: "mcp-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: body.get("scope") ?? "documents:read",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    tokenRequests,
    tokenRequestAuthHeaders,
    registrations,
    close: () => server.stop(true),
  };
}

describe("connections routes", () => {
  test("manual api_key create/list/get/revoke is permission-gated and never returns secret material", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", [
        "connections:read",
        "connections:write",
      ]),
      "content-type": "application/json",
    };

    const created = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerDomain: "api.example.com",
        kind: "api_key",
        credential: { headers: { authorization: "Bearer X" } },
        grantedScopes: ["read"],
        metadata: { label: "Example API" },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      connection: { id: string; providerDomain: string; status: string };
    };
    expect(createdBody.connection.providerDomain).toBe("api.example.com");
    expect(JSON.stringify(createdBody)).not.toContain("Bearer X");

    const loaded = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: workspace.workspaceId,
      connectionId: createdBody.connection.id,
      providerDomain: "api.example.com",
      allowSubjectOwned: false,
    });
    expect(loaded?.credential).toEqual({ headers: { authorization: "Bearer X" } });

    const listed = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      headers: { authorization: await bearer(workspace, "subject-a", ["connections:read"]) },
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { connections: Array<{ id: string }> };
    expect(listedBody.connections.map((connection) => connection.id)).toContain(
      createdBody.connection.id,
    );
    expect(JSON.stringify(listedBody)).not.toContain("Bearer X");

    const fetched = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${createdBody.connection.id}`,
      {
        headers: { authorization: await bearer(workspace, "subject-a", ["connections:read"]) },
      },
    );
    expect(fetched.status).toBe(200);
    expect(JSON.stringify(await fetched.json())).not.toContain("Bearer X");

    const denied = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, "subject-a", ["connections:read"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providerDomain: "blocked.example.com",
        kind: "api_key",
        credential: { headers: { authorization: "Bearer DENIED" } },
      }),
    });
    expect(denied.status).toBe(403);

    const revoked = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${createdBody.connection.id}`,
      {
        method: "DELETE",
        headers: { authorization: await bearer(workspace, "subject-a", ["connections:write"]) },
      },
    );
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { connection: { status: string } }).connection.status).toBe(
      "revoked",
    );
  });

  test("providerDomain is canonicalized on create and update", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", [
        "connections:read",
        "connections:write",
      ]),
      "content-type": "application/json",
    };
    const created = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerDomain: "WWW.Example.COM",
        kind: "api_key",
        credential: { headers: { authorization: "Bearer X" } },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      connection: { id: string; providerDomain: string };
    };
    expect(createdBody.connection.providerDomain).toBe("example.com");

    const updated = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${createdBody.connection.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ providerDomain: "  WWW.Other-Example.COM  " }),
      },
    );
    expect(updated.status).toBe(200);
    expect(
      ((await updated.json()) as { connection: { providerDomain: string } }).connection
        .providerDomain,
    ).toBe("other-example.com");
  });

  test("a providerDomain that canonicalizes to empty is rejected, not stored blank", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", [
        "connections:read",
        "connections:write",
      ]),
      "content-type": "application/json",
    };
    // "   " passes the contract's min(1) but trims to "" — an empty stored
    // domain would silently break enable-time connectionRef matching.
    const created = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerDomain: "   ",
        kind: "api_key",
        credential: { headers: { authorization: "Bearer X" } },
      }),
    });
    expect(created.status).toBe(400);
  });

  test("PATCH cannot clear a re-auth signal without a fresh credential", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", [
        "connections:read",
        "connections:write",
      ]),
      "content-type": "application/json",
    };
    const created = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerDomain: "api.example.com",
        kind: "api_key",
        credential: { headers: { authorization: "Bearer X" } },
      }),
    });
    const { connection } = (await created.json()) as { connection: { id: string } };

    const bareActivate = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "active" }),
      },
    );
    expect(bareActivate.status).toBe(400);

    const patchRevoke = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "revoked" }),
      },
    );
    expect(patchRevoke.status).toBe(400);

    const reactivate = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          status: "active",
          credential: { headers: { authorization: "Bearer Y" } },
        }),
      },
    );
    expect(reactivate.status).toBe(200);
  });

  test("subject-owned connections are only visible to that subject", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();

    async function create(subjectId: string, providerDomain: string, bodySubjectId?: string) {
      const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, subjectId, [
            "connections:read",
            "connections:write",
          ]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerDomain,
          kind: "api_key",
          ...(bodySubjectId ? { subjectId: bodySubjectId } : {}),
          credential: { headers: { authorization: `Bearer ${providerDomain}` } },
        }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { connection: { id: string } }).connection.id;
    }

    const sharedId = await create("subject-a", "shared.example.com");
    const subjectAId = await create("subject-a", "subject-a.example.com", "subject-a");
    const subjectBId = await create("subject-b", "subject-b.example.com", "subject-b");

    const listed = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      headers: { authorization: await bearer(workspace, "subject-a", ["connections:read"]) },
    });
    expect(listed.status).toBe(200);
    const ids = ((await listed.json()) as { connections: Array<{ id: string }> }).connections.map(
      (connection) => connection.id,
    );
    expect(ids.sort()).toEqual([sharedId, subjectAId].sort());
    expect(ids).not.toContain(subjectBId);

    const crossSubjectGet = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${subjectBId}`,
      {
        headers: { authorization: await bearer(workspace, "subject-a", ["connections:read"]) },
      },
    );
    expect(crossSubjectGet.status).toBe(404);
  });

  test("oauth start/callback completes CIMD flow, creates a verified oauth2 connection, and keeps PKCE verifier out of URLs", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({
      clientIdMetadataDocumentSupported: true,
      scopesSupported: ["documents:read", "documents:write"],
    });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="documents:read"`,
    });
    const response = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerDomain: "mcp.example.com",
          mcpUrl: mcp.url,
          returnPath: "/integrations",
        }),
      },
    );
    try {
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        state: string;
        authorizationUrl: string;
        expiresAt: string;
      };
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const authUrl = new URL(body.authorizationUrl);
      expect(authUrl.pathname).toBe("/authorize");
      expect(authUrl.searchParams.get("client_id")).toBe(
        "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      );
      expect(authUrl.searchParams.get("redirect_uri")).toBe(
        "https://api.opengeni.test/v1/integrations/oauth/callback",
      );
      expect(authUrl.searchParams.get("resource")).toBe("urn:test:mcp");
      expect(authUrl.searchParams.get("scope")).toBe("documents:read");
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authUrl.searchParams.has("code_verifier")).toBe(false);

      const state = readSignedState(body.state, STATE_SECRET) as Record<string, unknown> | null;
      expect(state?.workspaceId).toBe(workspace.workspaceId);
      expect(state?.accountId).toBe(workspace.accountId);
      expect(state?.subjectId).toBe("subject-a");
      expect(state?.providerDomain).toBe("mcp.example.com");
      expect(state?.mcpUrl).toBe(mcp.url);
      expect(state?.resource).toBe("urn:test:mcp");
      expect(state?.authorizeScopes).toEqual(["documents:read"]);
      expect(typeof state?.encryptedPkceVerifier).toBe("string");
      const verifier = decryptEnvironmentValue(rawKey, state!.encryptedPkceVerifier as string);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(body.authorizationUrl).not.toContain(verifier);
      expect(JSON.stringify(state)).not.toContain(verifier);

      const callback = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(callback.status).toBe(302);
      const location = callback.headers.get("location")!;
      expect(location).toContain("integration_oauth=success");
      // The success redirect carries the canonical providerDomain (not just the
      // connectionId) so the SPA can build the enable connectionRef straight from
      // the redirect, without depending on a listConnections round-trip.
      expect(location).toContain("providerDomain=mcp.example.com");

      expect(as.tokenRequests).toHaveLength(1);
      expect(as.tokenRequests[0]!.get("resource")).toBe("urn:test:mcp");
      expect(as.tokenRequests[0]!.get("redirect_uri")).toBe(
        "https://api.opengeni.test/v1/integrations/oauth/callback",
      );
      expect(as.tokenRequests[0]!.get("code_verifier")).toBe(verifier);
      expect(as.tokenRequests[0]!.get("client_id")).toBe(
        "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      );

      const loaded = await loadConnectionCredentialForBroker(client.db, settings, {
        workspaceId: workspace.workspaceId,
        providerDomain: "mcp.example.com",
        kind: "oauth2",
      });
      expect(loaded?.credential).toMatchObject({
        access_token: "mcp-access-token",
        refresh_token: "mcp-refresh-token",
        resource: "urn:test:mcp",
        mcp_url: mcp.url,
        token_endpoint: `${as.url}/token`,
        client_id: "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      });
      expect(loaded?.metadata.authorizationServerIssuer).toBe(new URL(as.url).toString());
      expect(loaded?.metadata.resource).toBe("urn:test:mcp");
      expect(loaded?.metadata.mcpUrl).toBe(mcp.url);
      expect(loaded?.metadata.mcpToolsVerification).toMatchObject({ status: "ok" });
      expect(loaded?.metadata.mcpTools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "search_documents" })]),
      );
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth uses protected-resource metadata resource as token audience while connecting to the MCP endpoint", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({
      clientIdMetadataDocumentSupported: true,
      tokenAccessToken: (body) => `token-for-${body.get("resource")}`,
    });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer token-for-urn:test:mcp",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource"`,
    });
    try {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerDomain: "linear.app",
            mcpUrl: mcp.url,
            returnPath: "/integrations?connect_item=linear",
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { state: string; authorizationUrl: string };
      expect(new URL(body.authorizationUrl).searchParams.get("resource")).toBe("urn:test:mcp");

      const callback = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("integration_oauth=success");
      expect(callback.headers.get("location")).not.toContain("verification=failed");
      expect(as.tokenRequests).toHaveLength(1);
      expect(as.tokenRequests[0]!.get("resource")).toBe("urn:test:mcp");

      const loaded = await loadConnectionCredentialForBroker(client.db, settings, {
        workspaceId: workspace.workspaceId,
        providerDomain: "linear.app",
        kind: "oauth2",
      });
      expect(loaded?.credential).toMatchObject({
        access_token: "token-for-urn:test:mcp",
        resource: "urn:test:mcp",
        mcp_url: mcp.url,
      });
      expect(loaded?.metadata.mcpToolsVerification).toMatchObject({ status: "ok" });
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth callback logs token exchange failures and redirects with a machine-readable reason", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({
      clientIdMetadataDocumentSupported: true,
      scopesSupported: ["documents:read"],
      tokenStatus: 401,
      tokenError: "invalid_client",
    });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="documents:read"`,
    });
    const errors: Array<Record<string, unknown>> = [];
    const observability = {
      startSpan: () => ({ end: () => undefined }),
      recordHttpRequest: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: string, attributes: Record<string, unknown>) =>
        errors.push({ message, ...attributes }),
    };
    const response = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerDomain: "mcp.example.com",
          mcpUrl: mcp.url,
          returnPath: "/integrations?connect_item=linear",
        }),
      },
    );
    try {
      expect(response.status).toBe(200);
      const body = (await response.json()) as { state: string };
      const state = readSignedState(body.state, STATE_SECRET) as Record<string, unknown>;
      const verifier = decryptEnvironmentValue(rawKey, state.encryptedPkceVerifier as string);

      const callback = await publicAppWithDeps(client.db, {}, { observability }).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(callback.status).toBe(302);
      const location = callback.headers.get("location")!;
      expect(location).toContain("integration_oauth=error");
      expect(location).toContain("reason=invalid_client");
      expect(location).toContain("connect_item=linear");

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        message: "MCP OAuth callback failed",
        "opengeni.oauth.stage": "token_exchange",
        "opengeni.oauth.reason": "invalid_client",
        "opengeni.oauth.provider_domain": "mcp.example.com",
        "opengeni.oauth.client_registration_method": "cimd",
      });
      expect(JSON.stringify(errors)).not.toContain(verifier);
      expect(JSON.stringify(errors)).not.toContain("abc");
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth reconnect preserves a subject-owned connection subject", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", [
        "connections:read",
        "connections:write",
      ]),
      "content-type": "application/json",
    };
    const seeded = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerDomain: "subject-oauth.example.com",
        kind: "api_key",
        subjectId: "subject-a",
        credential: { headers: { authorization: "Bearer old" } },
      }),
    });
    expect(seeded.status).toBe(201);
    const seededBody = (await seeded.json()) as {
      connection: { id: string; subjectId: string | null };
    };
    expect(seededBody.connection.subjectId).toBe("subject-a");

    const as = startFakeAuthorizationServer({ clientIdMetadataDocumentSupported: true });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource"`,
    });
    try {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            providerDomain: "subject-oauth.example.com",
            mcpUrl: mcp.url,
            connectionId: seededBody.connection.id,
            returnPath: "/integrations",
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { state: string };
      const callback = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(callback.status).toBe(302);

      const updated = await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        seededBody.connection.id,
        "subject-a",
      );
      expect(updated?.subjectId).toBe("subject-a");
      expect(updated?.kind).toBe("oauth2");
      expect(updated?.status).toBe("active");
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth start uses DCR fallback when CIMD is unavailable", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({
      clientIdMetadataDocumentSupported: false,
      dcr: true,
    });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource"`,
    });
    try {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerDomain: "dcr.example.com",
            mcpUrl: mcp.url,
            requestedScopes: ["documents:read"],
            returnPath: "/integrations",
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { state: string; authorizationUrl: string };
      expect(new URL(body.authorizationUrl).searchParams.get("client_id")).toBe(
        `${as.url}/registered-client/1`,
      );
      expect(as.registrations).toHaveLength(1);
      expect(as.registrations[0]).toMatchObject({
        client_name: "OpenGeni",
        redirect_uris: ["https://api.opengeni.test/v1/integrations/oauth/callback"],
        token_endpoint_auth_method: "none",
        scope: "documents:read",
      });
      const callback = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("integration_oauth=success");
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth start never replays dynamic client registration to a redirect origin", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const hits: string[] = [];
    const registrations: Array<{
      method: string;
      contentType: string | null;
      body: Record<string, unknown>;
    }> = [];
    const redirectHits: string[] = [];
    const redirectSink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        redirectHits.push(new URL(request.url).pathname);
        return Response.json({ client_id: "stolen-registration" });
      },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const origin = `http://127.0.0.1:${source.port}`;
        hits.push(url.pathname);
        if (url.pathname === "/mcp") {
          return new Response("", {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${origin}/prm"` },
          });
        }
        if (url.pathname === "/prm") {
          return Response.json({
            resource: `${origin}/mcp`,
            authorization_servers: [`${origin}/as`],
            scopes_supported: ["documents:read"],
          });
        }
        if (url.pathname === "/as") {
          return Response.json({
            issuer: `${origin}/as`,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        }
        if (url.pathname === "/register") {
          registrations.push({
            method: request.method,
            contentType: request.headers.get("content-type"),
            body: (await request.json()) as Record<string, unknown>,
          });
          return new Response("", {
            status: 307,
            headers: {
              location: `http://127.0.0.1:${redirectSink.port}/capture-registration`,
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const response = await app({ environment: "test" }).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerDomain: "dcr-redirect.example.com",
            mcpUrl: `http://127.0.0.1:${source.port}/mcp`,
            requestedScopes: ["documents:read"],
          }),
        },
      );
      const responseText = await response.text();
      expect(response.status, responseText).toBe(422);
      expect(responseText).toContain("may not follow redirects");
      expect(hits).toEqual(["/mcp", "/prm", "/as", "/register"]);
      expect(registrations).toEqual([
        {
          method: "POST",
          contentType: "application/json",
          body: expect.objectContaining({
            client_name: "OpenGeni",
            redirect_uris: ["https://api.opengeni.test/v1/integrations/oauth/callback"],
          }),
        },
      ]);
      expect(redirectHits).toEqual([]);
    } finally {
      source.stop(true);
      redirectSink.stop(true);
    }
  });

  test("oauth start uses configured operator credentials for Slack-shaped authorization servers", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({
      issuer: "https://mcp.slack.com",
      clientIdMetadataDocumentSupported: false,
      tokenEndpointAuthMethodsSupported: ["client_secret_post"],
      scopesSupported: ["search:read.public", "chat:write"],
    });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="search:read.public chat:write"`,
    });
    try {
      const response = await app({
        integrationsOauthClientsJson: JSON.stringify({
          "https://mcp.slack.com": {
            clientId: "slack-client-id",
            clientSecret: "slack-client-secret",
            tokenEndpointAuthMethod: "client_secret_post",
          },
        }),
      }).request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerDomain: "slack.com",
          mcpUrl: mcp.url,
          returnPath: "/capabilities?connect_item=slack",
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { state: string; authorizationUrl: string };
      const authUrl = new URL(body.authorizationUrl);
      expect(authUrl.searchParams.get("client_id")).toBe("slack-client-id");
      expect(authUrl.searchParams.get("scope")).toBe("search:read.public chat:write");

      const state = readSignedState(body.state, STATE_SECRET) as Record<string, unknown> | null;
      expect(state?.providerDomain).toBe("slack.com");
      expect(state?.clientRegistrationMethod).toBe("operator");
      expect(state?.clientId).toBe("slack-client-id");
      expect(JSON.stringify(state)).not.toContain("slack-client-secret");

      const callback = await publicApp(client.db, {
        integrationsOauthClientsJson: JSON.stringify({
          "https://mcp.slack.com": {
            clientId: "slack-client-id",
            clientSecret: "slack-client-secret",
            tokenEndpointAuthMethod: "client_secret_post",
          },
        }),
      }).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("integration_oauth=success");
      expect(as.tokenRequests).toHaveLength(1);
      expect(as.tokenRequests[0]!.get("client_id")).toBe("slack-client-id");
      expect(as.tokenRequests[0]!.get("client_secret")).toBe("slack-client-secret");
      expect(as.tokenRequestAuthHeaders[0]).toBeNull();
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth start uses one-time manual credentials for Slack-shaped authorization servers", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({
      issuer: "https://mcp.slack.com",
      clientIdMetadataDocumentSupported: false,
      tokenEndpointAuthMethodsSupported: ["client_secret_post"],
      scopesSupported: ["search:read.public", "chat:write"],
    });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="search:read.public chat:write"`,
    });
    try {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerDomain: "slack.com",
            mcpUrl: mcp.url,
            returnPath: "/capabilities?connect_item=slack",
            oauthClient: {
              clientId: "manual-slack-client-id",
              clientSecret: "manual-slack-client-secret",
              tokenEndpointAuthMethod: "client_secret_post",
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { state: string; authorizationUrl: string };
      expect(new URL(body.authorizationUrl).searchParams.get("client_id")).toBe(
        "manual-slack-client-id",
      );
      const state = readSignedState(body.state, STATE_SECRET) as Record<string, unknown> | null;
      expect(state?.clientRegistrationMethod).toBe("manual");
      expect(state?.clientId).toBe("manual-slack-client-id");
      expect(typeof state?.encryptedClientSecret).toBe("string");
      expect(JSON.stringify(state)).not.toContain("manual-slack-client-secret");

      const callback = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("integration_oauth=success");
      expect(as.tokenRequests).toHaveLength(1);
      expect(as.tokenRequests[0]!.get("client_id")).toBe("manual-slack-client-id");
      expect(as.tokenRequests[0]!.get("client_secret")).toBe("manual-slack-client-secret");
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth start uses CIMD for Linear when CIMD is advertised", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({
      issuer: "https://mcp.linear.app",
      clientIdMetadataDocumentSupported: true,
      dcr: true,
      scopesSupported: ["read", "write"],
      tokenEndpointAuthMethodsSupported: ["client_secret_basic", "client_secret_post", "none"],
    });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="read write"`,
    });
    try {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerDomain: "linear.app",
            mcpUrl: mcp.url,
            returnPath: "/integrations?connect_item=linear",
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { state: string; authorizationUrl: string };
      const authUrl = new URL(body.authorizationUrl);
      expect(authUrl.searchParams.get("client_id")).toBe(
        "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      );
      expect(authUrl.searchParams.get("resource")).toBe("urn:test:mcp");
      expect(authUrl.searchParams.get("scope")).toBe("read write");
      expect(as.registrations).toHaveLength(0);

      const state = readSignedState(body.state, STATE_SECRET) as Record<string, unknown> | null;
      expect(state?.clientRegistrationMethod).toBe("cimd");
      expect(state?.clientId).toBe(
        "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      );

      const callback = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("integration_oauth=success");
      expect(as.tokenRequests).toHaveLength(1);
      expect(as.tokenRequests[0]!.get("client_id")).toBe(
        "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      );
      expect(as.tokenRequests[0]!.has("client_secret")).toBe(false);
      expect(as.tokenRequestAuthHeaders[0]).toBeNull();
      expect(as.tokenRequests[0]!.get("resource")).toBe("urn:test:mcp");

      const loadedClient = await loadIntegrationOAuthClient(
        client.db,
        settings,
        "https://mcp.linear.app",
      );
      expect(loadedClient).toBeNull();
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth start ignores stored Linear DCR client when CIMD is advertised", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await replaceIntegrationOAuthClient(client.db, {
      issuer: "https://mcp.linear.app",
      authorizationServer: "https://mcp.linear.app",
      clientId: "public-linear-client",
      tokenEndpointAuthMethod: "none",
      metadata: {
        registrationEndpoint: "https://mcp.linear.app/register",
        registeredAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const as = startFakeAuthorizationServer({
      issuer: "https://mcp.linear.app",
      clientIdMetadataDocumentSupported: true,
      dcr: true,
      scopesSupported: ["read", "write"],
      tokenEndpointAuthMethodsSupported: ["client_secret_basic", "client_secret_post", "none"],
    });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="read write"`,
    });
    try {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerDomain: "linear.app",
            mcpUrl: mcp.url,
            returnPath: "/integrations?connect_item=linear",
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { authorizationUrl: string };
      expect(new URL(body.authorizationUrl).searchParams.get("client_id")).toBe(
        "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      );
      expect(as.registrations).toHaveLength(0);

      const loadedClient = await loadIntegrationOAuthClient(
        client.db,
        settings,
        "https://mcp.linear.app",
      );
      expect(loadedClient).toMatchObject({
        clientId: "public-linear-client",
        clientSecret: null,
        tokenEndpointAuthMethod: "none",
      });
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth discovery validates redirect targets before following metadata redirects", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const hits: string[] = [];
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const origin = `http://127.0.0.1:${source.port}`;
        hits.push(url.pathname);
        if (url.pathname === "/mcp") {
          return new Response("", {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${origin}/prm"` },
          });
        }
        if (url.pathname === "/prm") {
          return new Response("", {
            status: 302,
            headers: { location: "file:///tmp/private-prm" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const response = await app({ environment: "test" }).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          body: JSON.stringify({
            providerDomain: "redirect.example.com",
            mcpUrl: `http://127.0.0.1:${source.port}/mcp`,
          }),
        },
      );
      const responseText = await response.text();
      expect(response.status, responseText).toBe(422);
      expect(responseText).toContain("only supports http and https");
      expect(hits).toEqual(["/mcp", "/prm"]);
    } finally {
      source.stop(true);
    }
  });

  test("oauth callback never replays token exchange secrets to a redirect origin", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const redirectHits: string[] = [];
    const tokenRequests: Array<{ authorization: string | null; body: URLSearchParams }> = [];
    const redirectSink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        redirectHits.push(new URL(request.url).pathname);
        return Response.json({ access_token: "stolen" });
      },
    });
    const tokenOrigin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/token") {
          return new Response("not found", { status: 404 });
        }
        tokenRequests.push({
          authorization: request.headers.get("authorization"),
          body: new URLSearchParams(await request.text()),
        });
        return new Response("", {
          status: 302,
          headers: { location: `http://127.0.0.1:${redirectSink.port}/capture-token` },
        });
      },
    });
    const origin = `http://127.0.0.1:${tokenOrigin.port}`;
    const state = createSignedState(STATE_SECRET, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      providerDomain: "token-redirect.example.com",
      mcpUrl: `${origin}/mcp`,
      resource: `${origin}/mcp`,
      requestedScopes: [],
      authorizeScopes: ["documents:read"],
      encryptedPkceVerifier: encryptEnvironmentValue(rawKey, "redirect-verifier"),
      clientId: "redirect-client",
      tokenEndpoint: `${origin}/token`,
      authorizationServer: origin,
      issuer: origin,
      clientRegistrationMethod: "manual",
      tokenEndpointAuthMethod: "client_secret_basic",
      encryptedClientSecret: encryptEnvironmentValue(rawKey, "redirect-client-secret"),
      returnPath: "/integrations",
    });
    try {
      const response = await publicApp(client.db, { environment: "test" }).request(
        `/v1/integrations/oauth/callback?code=redirect-code&state=${encodeURIComponent(state)}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("integration_oauth=error");
      expect(response.headers.get("location")).toContain("reason=token_exchange_failed");
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]!.authorization).toMatch(/^Basic /);
      expect(tokenRequests[0]!.body.get("code")).toBe("redirect-code");
      expect(tokenRequests[0]!.body.get("code_verifier")).toBe("redirect-verifier");
      expect(redirectHits).toEqual([]);
    } finally {
      tokenOrigin.stop(true);
      redirectSink.stop(true);
    }
  });

  test("oauth callback records non-fatal verification failure without replaying its bearer to a redirect origin", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const hits: string[] = [];
    const redirectHits: string[] = [];
    const tokenBodies: URLSearchParams[] = [];
    const mcpAuthorization: Array<string | null> = [];
    const redirectSink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        redirectHits.push(new URL(request.url).pathname);
        return Response.json({ tools: [] });
      },
    });
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        hits.push(url.pathname);
        if (url.pathname === "/token") {
          tokenBodies.push(new URLSearchParams(await request.text()));
          return Response.json({
            access_token: "mcp-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "documents:read",
          });
        }
        if (url.pathname === "/mcp") {
          mcpAuthorization.push(request.headers.get("authorization"));
          return new Response("", {
            status: 302,
            headers: { location: `http://127.0.0.1:${redirectSink.port}/capture-bearer` },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${provider.port}`;
    const state = createSignedState(STATE_SECRET, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      providerDomain: "verify-redirect.example.com",
      mcpUrl: `${origin}/mcp`,
      resource: `${origin}/mcp`,
      requestedScopes: [],
      authorizeScopes: ["documents:read"],
      encryptedPkceVerifier: encryptEnvironmentValue(rawKey, "verify-redirect-verifier"),
      clientId: "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      tokenEndpoint: `${origin}/token`,
      authorizationServer: origin,
      issuer: origin,
      clientRegistrationMethod: "cimd",
      tokenEndpointAuthMethod: "none",
      returnPath: "/integrations",
    });
    try {
      const response = await publicApp(client.db, { environment: "test" }).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("integration_oauth=success");
      expect(response.headers.get("location")).toContain("verification=failed");
      expect(hits).toEqual(["/token", "/mcp"]);
      expect(tokenBodies).toHaveLength(1);
      expect(tokenBodies[0]!.get("resource")).toBe(`${origin}/mcp`);
      expect(mcpAuthorization).toEqual(["Bearer mcp-access-token"]);
      expect(redirectHits).toEqual([]);
      const loaded = await loadConnectionCredentialForBroker(client.db, settings, {
        workspaceId: workspace.workspaceId,
        providerDomain: "verify-redirect.example.com",
        kind: "oauth2",
      });
      expect(loaded?.credential).toMatchObject({ access_token: "mcp-access-token" });
      expect(loaded?.metadata.mcpToolsVerification).toMatchObject({
        status: "failed",
        reason: "tools_list_failed",
      });
    } finally {
      provider.stop(true);
      redirectSink.stop(true);
    }
  });

  test("oauth start refuses authorization servers that do not support S256", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({ codeChallengeMethods: ["plain"] });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource"`,
    });
    try {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({ providerDomain: "mcp.example.com", mcpUrl: mcp.url }),
        },
      );
      expect(response.status).toBe(422);
      expect(await response.text()).toContain("PKCE S256");
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth callback resolves operator clients with normalized issuer keys", async () => {
    if (!available) return;
    const cases = [
      { configuredSuffix: "/", stateSuffix: "" },
      { configuredSuffix: "", stateSuffix: "/" },
    ];
    for (const [index, entry] of cases.entries()) {
      const workspace = await freshWorkspace();
      const as = startFakeAuthorizationServer();
      const mcp = startTestMcpServer({
        requiredAuthorization: "Bearer mcp-access-token",
      });
      const clientId = `operator-client-${index}`;
      const configuredKey = `${as.url}${entry.configuredSuffix}`;
      const stateIssuer = `${as.url}${entry.stateSuffix}`;
      const state = createSignedState(STATE_SECRET, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: "subject-a",
        providerDomain: `operator-${index}.example.com`,
        resource: mcp.url,
        requestedScopes: [],
        authorizeScopes: ["documents:read"],
        encryptedPkceVerifier: encryptEnvironmentValue(rawKey, `verifier-${index}`),
        clientId,
        tokenEndpoint: `${as.url}/token`,
        authorizationServer: stateIssuer,
        issuer: stateIssuer,
        clientRegistrationMethod: "operator",
        tokenEndpointAuthMethod: "none",
        returnPath: "/integrations",
      });
      try {
        const callback = await publicApp(client.db, {
          integrationsOauthClientsJson: JSON.stringify({
            [configuredKey]: { clientId, tokenEndpointAuthMethod: "none" },
          }),
        }).request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toContain("integration_oauth=success");
        expect(as.tokenRequests.at(-1)?.get("client_id")).toBe(clientId);
      } finally {
        mcp.close();
        as.close();
      }
    }
  });

  test("oauth start rejects invalid resource URLs without a server error", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const response = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerDomain: "invalid-resource.example.com",
          resource: "example.com",
        }),
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  test("oauth routes are hidden while integrations are disabled and start does not discover", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    let fetchCalls = 0;
    const discoveryTarget = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        fetchCalls += 1;
        return new Response("unexpected discovery", { status: 500 });
      },
    });
    try {
      const start = await app({ integrationsEnabled: false, environment: "test" }).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerDomain: "disabled.example.com",
            mcpUrl: `http://127.0.0.1:${discoveryTarget.port}/mcp`,
          }),
        },
      );
      expect(start.status).toBe(404);
      expect(await start.text()).toContain("integrations are not enabled");
      expect(fetchCalls).toBe(0);

      const callback = await app({ integrationsEnabled: false }).request(
        "/v1/integrations/oauth/callback?code=abc&state=state",
      );
      expect(callback.status).toBe(404);
      expect(await callback.text()).toContain("integrations are not enabled");
      expect(fetchCalls).toBe(0);
    } finally {
      discoveryTarget.stop(true);
    }
  });

  test("oauth callback rejects replayed and expired state", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer();
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource"`,
    });
    try {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({ providerDomain: "mcp.example.com", mcpUrl: mcp.url }),
        },
      );
      const body = (await response.json()) as { state: string };
      const first = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(first.status).toBe(302);
      const replay = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`,
      );
      expect(replay.status).toBe(302);
      expect(replay.headers.get("location")).toContain("reason=state_invalid");

      const expiredState = createSignedState(
        STATE_SECRET,
        {
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          subjectId: "subject-a",
          providerDomain: "mcp.example.com",
          resource: mcp.url,
          requestedScopes: [],
          authorizeScopes: ["documents:read"],
          encryptedPkceVerifier: encryptEnvironmentValue(rawKey, "verifier"),
          clientId: "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
          tokenEndpoint: `${as.url}/token`,
          authorizationServer: as.url,
          issuer: as.url,
          clientRegistrationMethod: "cimd",
          tokenEndpointAuthMethod: "none",
          returnPath: "/integrations",
        },
        Math.floor(Date.now() / 1000) - 601,
      );
      const expired = await publicApp(client.db).request(
        `/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(expiredState)}`,
      );
      expect(expired.status).toBe(302);
      expect(expired.headers.get("location")).toContain("reason=state_invalid");
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("client metadata is public and byte-matches its serving URL", async () => {
    const response = await publicApp().request("/v1/integrations/oauth/client-metadata.json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      client_id: "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      client_name: "OpenGeni",
      redirect_uris: ["https://api.opengeni.test/v1/integrations/oauth/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });
});
