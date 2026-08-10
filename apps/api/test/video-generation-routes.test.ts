import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  deleteWorkspace,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerVideoGenerationRoutes } from "../src/routes/video-generation";

const SECRET = "video-generation-routes-test-secret";
const MODEL_ID = "bytedance/seedance-2.5";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("video-generation-routes");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  client = createDb(shared.appUrl, { max: 2 });
  app = new Hono();
  registerVideoGenerationRoutes(app, {
    db: client.db,
    settings: testSettings({ delegationSecret: SECRET }),
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspaceFixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `video-routes-account-${suffix}`,
    accountName: "Video generation routes account",
    workspaceExternalSource: "test",
    workspaceExternalId: `video-routes-workspace-${suffix}`,
    workspaceName: "Video generation routes workspace",
    subjectId: `user:video-routes-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function bearer(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  permissions: Permission[],
) {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: workspace.subjectId,
    principalKind: "human_session",
    permissions,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

function settingsUrl(workspaceId: string) {
  return `http://x/v1/workspaces/${workspaceId}/video-generation`;
}

describe("video generation workspace routes", () => {
  test("keeps video disabled until an admin enables Seedance on a connected Gateway", async () => {
    const workspace = await workspaceFixture();
    try {
      const readAuthorization = await bearer(workspace, ["workspace:read"]);
      const adminAuthorization = await bearer(workspace, ["workspace:read", "workspace:admin"]);

      const initial = await app.request(settingsUrl(workspace.workspaceId), {
        headers: { authorization: readAuthorization },
      });
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        schemaVersion: 1,
        policy: {
          revision: 0,
          fundingSource: "workspace_gateway",
          enabledModelIds: [],
          defaultModelId: null,
        },
        fundingOptions: [
          { source: "opengeni_credits", available: false },
          { source: "workspace_gateway", available: false },
        ],
        availableModels: [{ modelId: MODEL_ID }],
        capabilities: null,
      });

      await createConnection(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: null,
        providerDomain: "ai-gateway.vercel.sh",
        kind: "api_key",
        credentialEncrypted: "test-encrypted-gateway-key",
        metadata: { credentialRole: "vercel_ai_gateway" },
        createdBySubjectId: workspace.subjectId,
      });

      const readOnlyMutation = await app.request(`${settingsUrl(workspace.workspaceId)}/policy`, {
        method: "PUT",
        headers: { authorization: readAuthorization, "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          fundingSource: "workspace_gateway",
          enabledModelIds: [MODEL_ID],
          defaultModelId: MODEL_ID,
        }),
      });
      expect(readOnlyMutation.status).toBe(403);

      const enabled = await app.request(`${settingsUrl(workspace.workspaceId)}/policy`, {
        method: "PUT",
        headers: { authorization: adminAuthorization, "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          fundingSource: "workspace_gateway",
          enabledModelIds: [MODEL_ID],
          defaultModelId: MODEL_ID,
        }),
      });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toEqual({
        schemaVersion: 1,
        revision: 1,
        fundingSource: "workspace_gateway",
        enabledModelIds: [MODEL_ID],
        defaultModelId: MODEL_ID,
      });

      const configured = await app.request(settingsUrl(workspace.workspaceId), {
        headers: { authorization: readAuthorization },
      });
      expect(configured.status).toBe(200);
      expect(await configured.json()).toMatchObject({
        fundingOptions: [
          { source: "opengeni_credits", available: false },
          { source: "workspace_gateway", available: true },
        ],
        policy: {
          revision: 1,
          fundingSource: "workspace_gateway",
          enabledModelIds: [MODEL_ID],
          defaultModelId: MODEL_ID,
        },
        capabilities: {
          schemaVersion: 1,
          defaultModelId: MODEL_ID,
          models: [{ modelId: MODEL_ID }],
        },
      });

      const stale = await app.request(`${settingsUrl(workspace.workspaceId)}/policy`, {
        method: "PUT",
        headers: { authorization: adminAuthorization, "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          fundingSource: "workspace_gateway",
          enabledModelIds: [],
          defaultModelId: null,
        }),
      });
      expect(stale.status).toBe(409);

      const unknown = await app.request(`${settingsUrl(workspace.workspaceId)}/policy`, {
        method: "PUT",
        headers: { authorization: adminAuthorization, "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 1,
          fundingSource: "workspace_gateway",
          enabledModelIds: ["unknown/video-model"],
          defaultModelId: "unknown/video-model",
        }),
      });
      expect(unknown.status).toBe(422);
    } finally {
      await deleteWorkspace(client.db, workspace.workspaceId);
    }
  });

  test("enables the same Seedance capability through OpenGeni credits without a workspace key", async () => {
    const workspace = await workspaceFixture();
    const managedApp = new Hono();
    registerVideoGenerationRoutes(managedApp, {
      db: client.db,
      settings: testSettings({
        delegationSecret: SECRET,
        vercelAiGatewayApiKey: "managed-gateway-key",
        environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
      }),
    } as ApiRouteDeps);
    try {
      const authorization = await bearer(workspace, ["workspace:read", "workspace:admin"]);
      const initial = await managedApp.request(settingsUrl(workspace.workspaceId), {
        headers: { authorization },
      });
      expect(await initial.json()).toMatchObject({
        fundingOptions: [
          { source: "opengeni_credits", available: true },
          { source: "workspace_gateway", available: false },
        ],
        capabilities: null,
      });

      const enabled = await managedApp.request(`${settingsUrl(workspace.workspaceId)}/policy`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          fundingSource: "opengeni_credits",
          enabledModelIds: [MODEL_ID],
          defaultModelId: MODEL_ID,
        }),
      });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({
        revision: 1,
        fundingSource: "opengeni_credits",
      });

      const configured = await managedApp.request(settingsUrl(workspace.workspaceId), {
        headers: { authorization },
      });
      expect(await configured.json()).toMatchObject({
        policy: { fundingSource: "opengeni_credits", enabledModelIds: [MODEL_ID] },
        capabilities: { defaultModelId: MODEL_ID, models: [{ modelId: MODEL_ID }] },
      });
    } finally {
      await deleteWorkspace(client.db, workspace.workspaceId);
    }
  });
});
