import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
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
    set permissions = '["workspace:read", "workspace:admin", "capabilities:read", "connections:write"]'::jsonb
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
    permissions: ["workspace:read", "capabilities:read"],
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
