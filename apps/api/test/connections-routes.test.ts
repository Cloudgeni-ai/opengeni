import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  createDb,
  decryptEnvironmentValue,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import { readSignedState } from "@opengeni/github";
import { acquireSharedTestDatabase, testSettings, type SharedTestDatabase } from "@opengeni/testing";
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

function publicApp() {
  const publicSettings = testSettings({
    authRequired: true,
    accessKey: "deployment-key",
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: encryptionKey,
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "https://api.opengeni.test",
  }) as Settings;
  return createApp({
    settings: publicSettings,
    db: {} as never,
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

  test("oauth start mints signed state with encrypted PKCE verifier and returns the I1 stub status", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, "subject-a", ["connections:write"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providerDomain: "mcp.example.com",
        resource: "https://mcp.example.com/mcp",
        requestedScopes: ["read", "write"],
        returnPath: "/integrations",
      }),
    });
    expect(response.status).toBe(501);
    const body = await response.json() as { state: string; authorizationUrl: string | null; expiresAt: string };
    expect(body.authorizationUrl).toBeNull();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const state = readSignedState(body.state, STATE_SECRET) as Record<string, unknown> | null;
    expect(state?.workspaceId).toBe(workspace.workspaceId);
    expect(state?.accountId).toBe(workspace.accountId);
    expect(state?.subjectId).toBe("subject-a");
    expect(state?.providerDomain).toBe("mcp.example.com");
    expect(state?.requestedScopes).toEqual(["read", "write"]);
    expect(typeof state?.encryptedPkceVerifier).toBe("string");
    expect(JSON.stringify(state)).not.toContain("codeVerifier");
    expect(decryptEnvironmentValue(rawKey, state!.encryptedPkceVerifier as string).length).toBeGreaterThan(20);

    const callback = await publicApp().request(`/v1/integrations/oauth/callback?code=abc&state=${encodeURIComponent(body.state)}`);
    expect(callback.status).toBe(501);
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
