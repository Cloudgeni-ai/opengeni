import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  createDb,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getConnectionMetadata,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import { acquireSharedTestDatabase, startTestMcpServer, testSettings, type SharedTestDatabase } from "@opengeni/testing";
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
  } catch { /* noop */ }
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

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
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

function requestHeaderValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const lowerName = name.toLowerCase();
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === lowerName)?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[lowerName] ?? null;
}

type FakeAuthorizationServer = {
  url: string;
  tokenRequests: URLSearchParams[];
  registrations: Record<string, unknown>[];
  close: () => void;
};

function startFakeAuthorizationServer(options: {
  scopesSupported?: string[];
  codeChallengeMethods?: string[];
  clientIdMetadataDocumentSupported?: boolean;
  dcr?: boolean;
  tokenAccessToken?: string;
} = {}): FakeAuthorizationServer {
  const tokenRequests: URLSearchParams[] = [];
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
      if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: options.codeChallengeMethods ?? ["S256"],
          client_id_metadata_document_supported: options.clientIdMetadataDocumentSupported ?? true,
          ...(options.dcr ? { registration_endpoint: `${origin}/register` } : {}),
        });
      }
      if (url.pathname === "/register") {
        registrations.push(await request.json() as Record<string, unknown>);
        return Response.json({
          client_id: `${origin}/registered-client/${registrations.length}`,
          token_endpoint_auth_method: "none",
        }, { status: 201 });
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());
        tokenRequests.push(body);
        return Response.json({
          access_token: options.tokenAccessToken ?? "mcp-access-token",
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
    registrations,
    close: () => server.stop(true),
  };
}

describe("connections routes", () => {
  test("manual api_key create/list/get/revoke is permission-gated and never returns secret material", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", ["connections:read", "connections:write"]),
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
    const createdBody = await created.json() as { connection: { id: string; providerDomain: string; status: string } };
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
    const listedBody = await listed.json() as { connections: Array<{ id: string }> };
    expect(listedBody.connections.map((connection) => connection.id)).toContain(createdBody.connection.id);
    expect(JSON.stringify(listedBody)).not.toContain("Bearer X");

    const fetched = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/${createdBody.connection.id}`, {
      headers: { authorization: await bearer(workspace, "subject-a", ["connections:read"]) },
    });
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

    const revoked = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/${createdBody.connection.id}`, {
      method: "DELETE",
      headers: { authorization: await bearer(workspace, "subject-a", ["connections:write"]) },
    });
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as { connection: { status: string } }).connection.status).toBe("revoked");
  });

  test("providerDomain is canonicalized on create and update", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", ["connections:read", "connections:write"]),
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
    const createdBody = await created.json() as { connection: { id: string; providerDomain: string } };
    expect(createdBody.connection.providerDomain).toBe("example.com");

    const updated = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/${createdBody.connection.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ providerDomain: "  WWW.Other-Example.COM  " }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { connection: { providerDomain: string } }).connection.providerDomain).toBe("other-example.com");
  });

  test("a providerDomain that canonicalizes to empty is rejected, not stored blank", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", ["connections:read", "connections:write"]),
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
      authorization: await bearer(workspace, "subject-a", ["connections:read", "connections:write"]),
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
    const { connection } = await created.json() as { connection: { id: string } };

    const bareActivate = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "active" }),
    });
    expect(bareActivate.status).toBe(400);

    const patchRevoke = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "revoked" }),
    });
    expect(patchRevoke.status).toBe(400);

    const reactivate = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "active", credential: { headers: { authorization: "Bearer Y" } } }),
    });
    expect(reactivate.status).toBe(200);
  });

  test("subject-owned connections are only visible to that subject", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();

    async function create(subjectId: string, providerDomain: string, bodySubjectId?: string) {
      const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, subjectId, ["connections:read", "connections:write"]),
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
      return (await response.json() as { connection: { id: string } }).connection.id;
    }

    const sharedId = await create("subject-a", "shared.example.com");
    const subjectAId = await create("subject-a", "subject-a.example.com", "subject-a");
    const subjectBId = await create("subject-b", "subject-b.example.com", "subject-b");

    const listed = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      headers: { authorization: await bearer(workspace, "subject-a", ["connections:read"]) },
    });
    expect(listed.status).toBe(200);
    const ids = (await listed.json() as { connections: Array<{ id: string }> }).connections.map((connection) => connection.id);
    expect(ids.sort()).toEqual([sharedId, subjectAId].sort());
    expect(ids).not.toContain(subjectBId);

    const crossSubjectGet = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/${subjectBId}`, {
      headers: { authorization: await bearer(workspace, "subject-a", ["connections:read"]) },
    });
    expect(crossSubjectGet.status).toBe(404);
  });

  test("oauth start/callback completes CIMD flow, creates a verified oauth2 connection, and keeps PKCE verifier out of URLs", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer({ clientIdMetadataDocumentSupported: true, scopesSupported: ["documents:read", "documents:write"] });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="documents:read"`,
    });
    const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
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
    });
    try {
      expect(response.status).toBe(200);
      const body = await response.json() as { state: string; authorizationUrl: string; expiresAt: string };
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const authUrl = new URL(body.authorizationUrl);
      expect(authUrl.pathname).toBe("/authorize");
      expect(authUrl.searchParams.get("client_id")).toBe("https://api.opengeni.test/v1/integrations/oauth/client-metadata.json");
      expect(authUrl.searchParams.get("redirect_uri")).toBe("https://api.opengeni.test/v1/integrations/oauth/callback");
      expect(authUrl.searchParams.get("resource")).toBe(mcp.url);
      expect(authUrl.searchParams.get("scope")).toBe("documents:read");
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authUrl.searchParams.has("code_verifier")).toBe(false);

      const state = readSignedState(body.state, STATE_SECRET) as Record<string, unknown> | null;
      expect(state?.workspaceId).toBe(workspace.workspaceId);
      expect(state?.accountId).toBe(workspace.accountId);
      expect(state?.subjectId).toBe("subject-a");
      expect(state?.providerDomain).toBe("mcp.example.com");
      expect(state?.resource).toBe(mcp.url);
      expect(state?.authorizeScopes).toEqual(["documents:read"]);
      expect(typeof state?.encryptedPkceVerifier).toBe("string");
      const verifier = decryptEnvironmentValue(rawKey, state!.encryptedPkceVerifier as string);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(body.authorizationUrl).not.toContain(verifier);
      expect(JSON.stringify(state)).not.toContain(verifier);

      const callback = await publicApp(client.db).request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`);
      expect(callback.status).toBe(302);
      const location = callback.headers.get("location")!;
      expect(location).toContain("integration_oauth=success");

      expect(as.tokenRequests).toHaveLength(1);
      expect(as.tokenRequests[0]!.get("resource")).toBe(mcp.url);
      expect(as.tokenRequests[0]!.get("redirect_uri")).toBe("https://api.opengeni.test/v1/integrations/oauth/callback");
      expect(as.tokenRequests[0]!.get("code_verifier")).toBe(verifier);
      expect(as.tokenRequests[0]!.get("client_id")).toBe("https://api.opengeni.test/v1/integrations/oauth/client-metadata.json");

      const loaded = await loadConnectionCredentialForBroker(client.db, settings, {
        workspaceId: workspace.workspaceId,
        providerDomain: "mcp.example.com",
        kind: "oauth2",
      });
      expect(loaded?.credential).toMatchObject({
        access_token: "mcp-access-token",
        refresh_token: "mcp-refresh-token",
        resource: mcp.url,
        token_endpoint: `${as.url}/token`,
        client_id: "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      });
      expect(loaded?.metadata.authorizationServerIssuer).toBe(as.url);
      expect(loaded?.metadata.mcpTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "search_documents" })]));
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth reconnect preserves a subject-owned connection subject", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", ["connections:read", "connections:write"]),
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
    const seededBody = await seeded.json() as { connection: { id: string; subjectId: string | null } };
    expect(seededBody.connection.subjectId).toBe("subject-a");

    const as = startFakeAuthorizationServer({ clientIdMetadataDocumentSupported: true });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource"`,
    });
    try {
      const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerDomain: "subject-oauth.example.com",
          mcpUrl: mcp.url,
          connectionId: seededBody.connection.id,
          returnPath: "/integrations",
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { state: string };
      const callback = await publicApp(client.db).request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`);
      expect(callback.status).toBe(302);

      const updated = await getConnectionMetadata(client.db, workspace.workspaceId, seededBody.connection.id, "subject-a");
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
    const as = startFakeAuthorizationServer({ clientIdMetadataDocumentSupported: false, dcr: true });
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource"`,
    });
    try {
      const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ providerDomain: "dcr.example.com", mcpUrl: mcp.url, requestedScopes: ["documents:read"], returnPath: "/integrations" }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { state: string; authorizationUrl: string };
      expect(new URL(body.authorizationUrl).searchParams.get("client_id")).toBe(`${as.url}/registered-client/1`);
      expect(as.registrations).toHaveLength(1);
      expect(as.registrations[0]).toMatchObject({
        client_name: "OpenGeni",
        redirect_uris: ["https://api.opengeni.test/v1/integrations/oauth/callback"],
        token_endpoint_auth_method: "none",
      });
      const callback = await publicApp(client.db).request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`);
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("integration_oauth=success");
    } finally {
      mcp.close();
      as.close();
    }
  });

  test("oauth discovery validates redirect targets before following metadata redirects", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const originalFetch = globalThis.fetch;
    const hits: string[] = [];
    let privateHopHits = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      hits.push(url);
      expect(init?.redirect).toBe("manual");
      if (url === "https://1.1.1.1/mcp") {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="https://1.1.1.1/prm"` },
        });
      }
      if (url === "https://1.1.1.1/prm") {
        return new Response("", {
          status: 302,
          headers: { location: "https://127.0.0.1/private-prm" },
        });
      }
      if (url === "https://127.0.0.1/private-prm") {
        privateHopHits += 1;
        return Response.json({ authorization_servers: [] });
      }
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;
    try {
      const response = await app({ environment: "production" }).request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ providerDomain: "redirect.example.com", mcpUrl: "https://1.1.1.1/mcp" }),
      });
      expect(response.status).toBe(422);
      expect(await response.text()).toContain("private network");
      expect(hits).toEqual(["https://1.1.1.1/mcp", "https://1.1.1.1/prm"]);
      expect(privateHopHits).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("oauth callback verifies MCP tools through guarded fetch redirects", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const originalFetch = globalThis.fetch;
    const hits: string[] = [];
    let privateHopHits = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      hits.push(url);
      expect(init?.redirect).toBe("manual");
      if (url === "https://1.1.1.1/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("resource")).toBe("https://1.1.1.1/mcp");
        return Response.json({
          access_token: "mcp-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "documents:read",
        });
      }
      if (url === "https://1.1.1.1/mcp") {
        expect(requestHeaderValue(init?.headers, "authorization")).toBe("Bearer mcp-access-token");
        return new Response("", {
          status: 302,
          headers: { location: "https://127.0.0.1/private-mcp" },
        });
      }
      if (url === "https://127.0.0.1/private-mcp") {
        privateHopHits += 1;
        return Response.json({ tools: [] });
      }
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;
    const state = createSignedState(STATE_SECRET, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      providerDomain: "verify-redirect.example.com",
      resource: "https://1.1.1.1/mcp",
      requestedScopes: [],
      authorizeScopes: ["documents:read"],
      encryptedPkceVerifier: encryptEnvironmentValue(rawKey, "verify-redirect-verifier"),
      clientId: "https://api.opengeni.test/v1/integrations/oauth/client-metadata.json",
      tokenEndpoint: "https://1.1.1.1/token",
      authorizationServer: "https://as.example.com",
      issuer: "https://as.example.com",
      clientRegistrationMethod: "cimd",
      tokenEndpointAuthMethod: "none",
      returnPath: "/integrations",
    });
    try {
      const response = await publicApp(client.db, { environment: "production" })
        .request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(response.status).toBe(422);
      expect(await response.text()).toContain("private network");
      expect(hits).toEqual(["https://1.1.1.1/token", "https://1.1.1.1/mcp"]);
      expect(privateHopHits).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
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
      const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ providerDomain: "mcp.example.com", mcpUrl: mcp.url }),
      });
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
    const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, "subject-a", ["connections:write"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ providerDomain: "invalid-resource.example.com", resource: "example.com" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  test("oauth routes are hidden while integrations are disabled and start does not discover", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("unexpected discovery", { status: 500 });
    }) as typeof fetch;
    try {
      const start = await app({ integrationsEnabled: false }).request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ providerDomain: "disabled.example.com", mcpUrl: "https://1.1.1.1/mcp" }),
      });
      expect(start.status).toBe(404);
      expect(await start.text()).toContain("integrations are not enabled");
      expect(fetchCalls).toBe(0);

      const callback = await app({ integrationsEnabled: false }).request("/v1/integrations/oauth/callback?code=abc&state=state");
      expect(callback.status).toBe(404);
      expect(await callback.text()).toContain("integrations are not enabled");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
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
      const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ providerDomain: "mcp.example.com", mcpUrl: mcp.url }),
      });
      const body = await response.json() as { state: string };
      const first = await publicApp(client.db).request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`);
      expect(first.status).toBe(302);
      const replay = await publicApp(client.db).request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`);
      expect(replay.status).toBe(400);

      const expiredState = createSignedState(STATE_SECRET, {
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
      }, Math.floor(Date.now() / 1000) - 601);
      const expired = await publicApp(client.db).request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(expiredState)}`);
      expect(expired.status).toBe(400);
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
