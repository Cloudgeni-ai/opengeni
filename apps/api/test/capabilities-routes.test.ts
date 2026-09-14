import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  upsertCapabilityCatalogItem,
  enableCapabilityInstallation,
  listConnectorToolPermissionPolicies,
  clearCodexAppsCredential,
  createDb,
  deleteWorkspace,
  designateCodexAppsCredential,
  encryptEnvironmentValue,
  upsertCodexSubscriptionCredential,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";

import type { ApiRouteDeps } from "@opengeni/core";
import { registerCapabilityRoutes } from "../src/routes/capabilities";

const DELEGATION_SECRET = "codex-apps-capabilities-route-secret";
const encryptionKey = Buffer.alloc(32, 37);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let workspaceId = "";
let accountId = "";
let subjectId = "";
let available = true;
const settings = testSettings({
  codexConnectedAppsEnabled: true,
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-capabilities-codex-apps");
  if (!shared) {
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  subjectId = `user:codex-apps-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `api-capabilities-account-${crypto.randomUUID()}`,
    accountName: "Codex Apps capabilities account",
    workspaceExternalSource: "test",
    workspaceExternalId: `api-capabilities-workspace-${crypto.randomUUID()}`,
    workspaceName: "Codex Apps capabilities workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  workspaceId = grant.workspaceId;
  accountId = grant.accountId;
  await shared.admin`
    update workspace_memberships
    set permissions = '["workspace:read", "workspace:admin", "connections:write", "capabilities:manage"]'::jsonb
    where workspace_id = ${workspaceId} and subject_id = ${subjectId}`;
  app = new Hono();
  registerCapabilityRoutes(app, { db: client.db, settings } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function request(): Promise<Response> {
  const bearer = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: ["workspace:read"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return await app!.request(`http://x/v1/workspaces/${workspaceId}/capabilities`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

describe("Codex Apps capability catalog API", () => {
  test("projects designated Apps as an enabled selectable MCP server", async () => {
    if (!available || !client) return;
    const credential = await upsertCodexSubscriptionCredential(client.db, {
      accountId,
      workspaceId,
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ access_token: "access", refresh_token: "refresh", id_token: "id" }),
      ),
      chatgptAccountId: `codex-apps-${crypto.randomUUID()}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      lastRefreshAt: new Date(),
      connectedBySubjectId: subjectId,
    });
    expect(
      await designateCodexAppsCredential(client.db, {
        accountId,
        workspaceId,
        credentialId: credential.id,
        subjectId,
        expectedVersion: 0,
      }),
    ).toMatchObject({ kind: "updated" });

    const response = await request();
    expect(response.status).toBe(200);
    const item = (await response.json()).items.find(
      (candidate: { id: string }) => candidate.id === "mcp:codex_apps",
    );
    expect(item).toMatchObject({
      name: "Codex Apps",
      surfaceType: "codex_apps",
      enabled: true,
      runtime: { available: true, mcpServerId: "codex_apps" },
    });
  });

  test("keeps the Apps item visible but unavailable after designation is cleared", async () => {
    if (!available || !client) return;
    expect(
      await clearCodexAppsCredential(client.db, {
        accountId,
        workspaceId,
        subjectId,
        expectedVersion: 1,
      }),
    ).toMatchObject({ kind: "updated", credentialId: null });

    const response = await request();
    expect(response.status).toBe(200);
    const item = (await response.json()).items.find(
      (candidate: { id: string }) => candidate.id === "mcp:codex_apps",
    );
    expect(item).toMatchObject({
      name: "Codex Apps",
      surfaceType: "codex_apps",
      enabled: false,
      runtime: { available: false },
    });
    expect(item.runtime.mcpServerId).toBeUndefined();
  });
});

describe("connector tool permissions API", () => {
  test("discovers MCP annotations and persists scoped defaults and overrides without executing tools", async () => {
    if (!available || !client) return;
    let invocations = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (req.method !== "POST") return new Response(null, { status: 405 });
        const body = (await req.json()) as { id?: string | number; method: string };
        if (body.id === undefined) return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "permissions-fixture", version: "1" },
              }
            : body.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "read_item",
                      title: "Read item",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: true },
                    },
                    {
                      name: "delete_item",
                      title: "Delete item",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: true, destructiveHint: true },
                    },
                    { name: "unknown_action", inputSchema: { type: "object" } },
                  ],
                }
              : (++invocations, { content: [{ type: "text", text: "executed" }] });
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    const capabilityId = `mcp:permissions-${crypto.randomUUID()}`;
    const serverId = `permissions_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await upsertCapabilityCatalogItem(client.db, {
        accountId,
        workspaceId,
        id: capabilityId,
        kind: "mcp",
        source: "manual",
        name: "Permission fixture",
        description: null,
        category: "custom",
        tags: [],
        homepageUrl: null,
        endpointUrl: `http://127.0.0.1:${server.port}/mcp`,
        installUrl: null,
        authModel: null,
        metadata: { mcpServerId: serverId },
      });
      await enableCapabilityInstallation(client.db, {
        accountId,
        workspaceId,
        capabilityId,
        kind: "mcp",
        config: {},
        metadata: {
          mcpConnectivity: { status: "ok", checkedAt: new Date().toISOString(), toolCount: 3 },
        },
      });
      const bearer = await signDelegatedAccessToken(DELEGATION_SECRET, {
        accountId,
        workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: ["workspace:read", "capabilities:manage"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const path = `http://x/v1/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/tool-permissions`;
      const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
      const first = await app!.request(path, { headers });
      expect(first.status).toBe(200);
      const initial = await first.json();
      expect(initial.discoveryError).toBeNull();
      expect(
        initial.tools.map((tool: { name: string; group: string }) => [tool.name, tool.group]),
      ).toEqual([
        ["read_item", "read"],
        ["delete_item", "write"],
        ["unknown_action", "other"],
      ]);
      expect(initial.connectionId).toMatch(/^session-mcp:/);
      const write = (
        toolNames: string[],
        permission: string,
        connectionId = initial.connectionId,
      ) =>
        app!.request(path, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ connectionId, toolNames, permission }),
        });
      expect((await write(["*"], "ask")).status).toBe(200);
      expect((await write(["read_item"], "allow")).status).toBe(200);
      expect((await write(["delete_item"], "block")).status).toBe(200);
      expect((await write(["read_item"], "block", "different-account")).status).toBe(409);
      const saved = await (await app!.request(path, { headers })).json();
      expect(saved.defaultPermission).toBe("ask");
      expect(saved.tools.map((tool: { permission: string }) => tool.permission)).toEqual([
        "allow",
        "block",
        "ask",
      ]);
      const policies = await listConnectorToolPermissionPolicies(client.db, {
        accountId,
        workspaceId,
        connectionId: initial.connectionId,
      });
      expect(policies).toHaveLength(3);
      const reader = await signDelegatedAccessToken(DELEGATION_SECRET, {
        accountId,
        workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: ["workspace:read"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(
        (
          await app!.request(path, {
            method: "PATCH",
            headers: { ...headers, authorization: `Bearer ${reader}` },
            body: JSON.stringify({
              connectionId: initial.connectionId,
              toolNames: ["*"],
              permission: "allow",
            }),
          })
        ).status,
      ).toBe(403);
      const service = await signDelegatedAccessToken(DELEGATION_SECRET, {
        accountId,
        workspaceId,
        subjectId,
        principalKind: "service",
        permissions: ["workspace:read", "capabilities:manage"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(
        (
          await app!.request(path, {
            method: "PATCH",
            headers: { ...headers, authorization: `Bearer ${service}` },
            body: JSON.stringify({
              connectionId: initial.connectionId,
              toolNames: ["*"],
              permission: "allow",
            }),
          })
        ).status,
      ).toBe(403);
      expect(invocations).toBe(0);
    } finally {
      await server.stop(true);
    }
  }, 60_000);
});
