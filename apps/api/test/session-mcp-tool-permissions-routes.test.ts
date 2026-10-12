import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  connectorActionPolicyDecision,
  createDb,
  deleteWorkspace,
  listConnectorToolPermissionPolicies,
  resolveConnectorActionPolicy,
  type DbClient,
} from "@opengeni/db";
import { updateSessionMcpToolPermissions, type ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { registerCapabilityRoutes } from "../src/routes/capabilities";

const DELEGATION_SECRET = "session-mcp-tool-permissions-secret";
const settings = testSettings({ delegationSecret: DELEGATION_SECRET });
const serverId = "cloudgeni-capability";
const url = "https://host.example.test/embedded/capability-mcp/mcp";
// The runtime's credential-free session MCP identity (sessionMcpApprovalConnectionId).
const runtimeConnectionId = `session-mcp:${serverId}:${createHash("sha256").update(url, "utf8").digest("hex")}`;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let workspaceId = "";
let accountId = "";
let subjectId = "";
let available = true;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-mcp-tool-permissions");
  if (!shared) {
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  subjectId = `user:session-mcp-permissions-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `session-mcp-permissions-account-${crypto.randomUUID()}`,
    accountName: "Session MCP permissions account",
    workspaceExternalSource: "test",
    workspaceExternalId: `session-mcp-permissions-workspace-${crypto.randomUUID()}`,
    workspaceName: "Session MCP permissions workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  workspaceId = grant.workspaceId;
  accountId = grant.accountId;
  await shared.admin`
    update workspace_memberships
    set permissions = '["workspace:read", "workspace:admin", "capabilities:manage"]'::jsonb
    where workspace_id = ${workspaceId} and subject_id = ${subjectId}`;
  app = new Hono();
  registerCapabilityRoutes(app, { db: client.db, settings } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function headers(permissions: string[]) {
  const bearer = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: permissions as never,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
}

function path(query?: Record<string, string>) {
  const base = `http://x/v1/workspaces/${workspaceId}/session-mcp-tool-permissions`;
  return query ? `${base}?${new URLSearchParams(query)}` : base;
}

function decide(
  policies: Awaited<ReturnType<typeof listConnectorToolPermissionPolicies>>,
  toolName: string,
  recommended: "allow" | "ask",
) {
  const resolved = resolveConnectorActionPolicy(policies, {
    connectionId: runtimeConnectionId,
    serverId,
    toolName,
    actionName: toolName,
    defaultDecision: recommended,
  });
  if (!resolved.managed) throw new Error("expected a managed decision");
  return connectorActionPolicyDecision(resolved);
}

describe("host session MCP tool permissions", () => {
  test("a host admin sets Allow/Ask/Block that the runtime identity resolves", async () => {
    if (!available || !client) return;
    const admin = await headers(["workspace:read", "capabilities:manage"]);
    const empty = await app!.request(path({ serverId, url }), { headers: admin });
    expect(empty.status).toBe(200);
    const initial = await empty.json();
    expect(initial).toMatchObject({
      connectionId: runtimeConnectionId,
      serverId,
      defaultPermission: null,
      tools: [],
      canManage: true,
      appliesTo: "next_attempt",
    });
    // No rule: the attaching session's requireApproval recommendation decides.
    let policies = await listConnectorToolPermissionPolicies(client.db, {
      accountId,
      workspaceId,
      connectionId: runtimeConnectionId,
    });
    expect(decide(policies, "cloudgeni_list_findings", "allow")).toBe("allow");
    expect(decide(policies, "cloudgeni_delete_scan", "ask")).toBe("ask");

    const patch = (body: Record<string, unknown>, auth = admin) =>
      app!.request(path(), { method: "PATCH", headers: auth, body: JSON.stringify(body) });
    expect(
      (
        await patch({
          serverId,
          url,
          target: "default",
          permission: "allow",
          expectedRevision: initial.revision,
        })
      ).status,
    ).toBe(200);
    // A stale revision is a conflict, not a silent overwrite.
    expect(
      (
        await patch({
          serverId,
          url,
          target: "default",
          permission: "ask",
          expectedRevision: initial.revision,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await patch({
          serverId,
          url,
          target: "tools",
          toolNames: ["cloudgeni_delete_scan"],
          permission: "block",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patch({
          serverId,
          url,
          target: "tools",
          toolNames: ["cloudgeni_merge_pull_request"],
          permission: "ask",
        })
      ).status,
    ).toBe(200);

    const saved = await (await app!.request(path({ serverId, url }), { headers: admin })).json();
    expect(saved.defaultPermission).toBe("allow");
    expect(saved.tools).toEqual([
      { toolName: "cloudgeni_delete_scan", permission: "block" },
      { toolName: "cloudgeni_merge_pull_request", permission: "ask" },
    ]);
    expect(saved.revision).not.toBe(initial.revision);

    policies = await listConnectorToolPermissionPolicies(client.db, {
      accountId,
      workspaceId,
      connectionId: runtimeConnectionId,
    });
    // "Allow all" overrides the Ask recommendation; explicit tool rules win over it.
    expect(decide(policies, "cloudgeni_activate_goal", "ask")).toBe("allow");
    expect(decide(policies, "cloudgeni_delete_scan", "allow")).toBe("block");
    expect(decide(policies, "cloudgeni_merge_pull_request", "allow")).toBe("ask");

    // Reset restores the recommendation path for that tool.
    expect(
      (
        await patch({
          serverId,
          url,
          target: "tools",
          toolNames: ["cloudgeni_delete_scan"],
          permission: null,
        })
      ).status,
    ).toBe(200);
    expect((await patch({ serverId, url, target: "default", permission: null })).status).toBe(200);
    policies = await listConnectorToolPermissionPolicies(client.db, {
      accountId,
      workspaceId,
      connectionId: runtimeConnectionId,
    });
    expect(decide(policies, "cloudgeni_delete_scan", "ask")).toBe("ask");
    expect(decide(policies, "cloudgeni_merge_pull_request", "allow")).toBe("ask");

    // A different exact URL is a different server identity.
    const other = await (
      await app!.request(path({ serverId, url: `${url}/other` }), { headers: admin })
    ).json();
    expect(other.tools).toEqual([]);
    expect(other.connectionId).not.toBe(runtimeConnectionId);
  });

  test("validation and permission boundaries", async () => {
    if (!available || !client) return;
    const admin = await headers(["workspace:read", "capabilities:manage"]);
    const reader = await headers(["workspace:read"]);
    const patch = (body: Record<string, unknown>, auth = admin) =>
      app!.request(path(), { method: "PATCH", headers: auth, body: JSON.stringify(body) });
    expect(
      (await app!.request(path({ serverId, url: "not a url" }), { headers: admin })).status,
    ).toBe(400);
    expect((await app!.request(path({ serverId: "bad id", url }), { headers: admin })).status).toBe(
      400,
    );
    expect(
      (await patch({ serverId, url, target: "tools", toolNames: ["*"], permission: "allow" }))
        .status,
    ).toBe(400);
    expect(
      (await patch({ serverId, url, target: "tools", toolNames: [" x "], permission: "allow" }))
        .status,
    ).toBe(400);
    expect((await patch({ serverId, url, target: "default", permission: "maybe" })).status).toBe(
      400,
    );
    expect(
      (await patch({ serverId, url, target: "default", permission: "allow" }, reader)).status,
    ).toBe(403);
    const readable = await app!.request(path({ serverId, url }), { headers: reader });
    expect(readable.status).toBe(200);
    expect((await readable.json()).canManage).toBe(false);
  });

  test("agents and service principals cannot change the permissions that bound them", async () => {
    const base: AccessGrant = {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "agent",
      permissions: ["workspace:read", "capabilities:manage"],
      principalKind: "agent_attempt",
    } as AccessGrant;
    for (const grant of [
      base,
      { ...base, principalKind: "service" } as AccessGrant,
      { ...base, principalKind: "api_key", serviceInitiator: { kind: "schedule" } } as never,
    ]) {
      const refused = await updateSessionMcpToolPermissions({
        db: null as never,
        workspaceId: base.workspaceId,
        grant,
        payload: { serverId, url, target: "default", permission: "allow" },
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(HTTPException);
      expect((refused as HTTPException).status).toBe(403);
    }
  });
});
