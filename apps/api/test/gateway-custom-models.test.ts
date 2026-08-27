import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  VERCEL_AI_GATEWAY_CONNECTION_DOMAIN,
  VERCEL_AI_GATEWAY_CONNECTION_ROLE,
} from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { resolveCatalogSettings, type ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  createSession,
  upsertWorkspaceModelPolicy,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";

import { createApp, type AppDependencies } from "../src/app";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const SECRET = "gateway-custom-models-test-secret-at-least-32-bytes";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let publicApp: Hono | null = null;
let grant: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number] | null = null;

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: SECRET,
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("gateway-custom-models");
  if (!shared) return;

  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `gateway-custom-account-${crypto.randomUUID()}`,
    accountName: "Gateway custom model account",
    workspaceExternalSource: "test",
    workspaceExternalId: `gateway-custom-workspace-${crypto.randomUUID()}`,
    workspaceName: "Gateway custom model workspace",
    subjectId: "user:gateway-custom-admin",
  });
  grant = access.workspaceGrants[0]!;
  await createConnection(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: null,
    providerDomain: VERCEL_AI_GATEWAY_CONNECTION_DOMAIN,
    kind: "api_key",
    credentialEncrypted: "not-read-by-metadata-only-catalog-tests",
    metadata: { credentialRole: VERCEL_AI_GATEWAY_CONNECTION_ROLE },
    createdBySubjectId: grant.subjectId,
  });

  app = new Hono();
  registerWorkspaceRoutes(app, {
    settings,
    db: client.db,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, settings),
  } as ApiRouteDeps);
  publicApp = createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } satisfies AppDependencies);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function bearer(permissions: Permission[]): Promise<string> {
  if (!grant) throw new Error("Gateway custom model fixture is unavailable");
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; permissions?: Permission[] } = {},
): Promise<Response> {
  if (!app || !grant) throw new Error("Gateway custom model fixture is unavailable");
  const headers: Record<string, string> = {
    authorization: await bearer(options.permissions ?? ["workspace:read", "workspace:admin"]),
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return await app.request(`http://x/v1/workspaces/${grant.workspaceId}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("workspace Gateway custom model API", () => {
  test("requires workspace admin and rejects invalid or curated-collision inputs", async () => {
    if (!app || !grant) return;

    const readOnly = await request("/gateway-custom-models", {
      method: "POST",
      permissions: ["workspace:read"],
      body: { upstreamModelId: "anthropic/claude-sonnet-4.6" },
    });
    expect(readOnly.status).toBe(403);

    for (const body of [
      { upstreamModelId: "" },
      { upstreamModelId: "a".repeat(257) },
      { upstreamModelId: "anthropic/claude-sonnet-4.6", label: "é".repeat(65) },
      { upstreamModelId: "anthropic/claude-sonnet-4.6", capabilities: {} },
      { upstreamModelId: "anthropic/claude-sonnet-4.6", billing: "credits" },
      { upstreamModelId: "anthropic/claude-sonnet-4.6", credentialSource: {} },
      { upstreamModelId: "anthropic/claude-sonnet-4.6", apiKey: "must-not-be-accepted" },
      { upstreamModelId: "anthropic/claude-sonnet-4.6", enabled: true },
    ]) {
      const invalid = await request("/gateway-custom-models", { method: "POST", body });
      expect(invalid.status).toBe(422);
    }

    const collision = await request("/gateway-custom-models", {
      method: "POST",
      body: { upstreamModelId: "deepseek/deepseek-v4-flash-0731" },
    });
    expect(collision.status).toBe(422);
  });

  test("creates one exact slug, exposes it only to the workspace catalog, and deletes it", async () => {
    if (!app || !publicApp || !grant) return;
    const upstreamModelId = "anthropic/claude-sonnet-4.6";
    const productModelId = `workspace-gateway/${upstreamModelId}`;

    const created = await request("/gateway-custom-models", {
      method: "POST",
      body: { upstreamModelId, label: "Claude Sonnet 4.6" },
    });
    expect(created.status).toBe(201);
    const createdModel = (await created.json()) as { id: string; upstreamModelId: string };
    expect(createdModel.upstreamModelId).toBe(upstreamModelId);

    const duplicate = await request("/gateway-custom-models", {
      method: "POST",
      body: { upstreamModelId },
    });
    expect(duplicate.status).toBe(422);

    const listed = await request("/gateway-custom-models", {
      permissions: ["workspace:read"],
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      models: [{ id: createdModel.id, upstreamModelId, label: "Claude Sonnet 4.6" }],
    });

    const workspaceCatalog = await request("/model-catalog", {
      permissions: ["workspace:read"],
    });
    expect(workspaceCatalog.status).toBe(200);
    const workspacePayload = (await workspaceCatalog.json()) as {
      models: Array<Record<string, unknown>>;
    };
    expect(workspacePayload.models.find((model) => model.id === productModelId)).toMatchObject({
      id: productModelId,
      label: "Claude Sonnet 4.6",
      provider: "workspace-gateway",
      source: "workspace_gateway",
      cost: "workspace",
      availability: { selectable: true },
    });
    expect(JSON.stringify(workspacePayload)).not.toContain(
      "not-read-by-metadata-only-catalog-tests",
    );

    const session = await createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Policy-check fixture",
      resources: [],
      metadata: {},
      model: settings.openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await upsertWorkspaceModelPolicy(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      allowedProviders: null,
      allowedModels: [settings.openaiModel],
    });
    const blockedSend = await publicApp.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/events`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(["sessions:control"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: { text: "blocked custom model", resources: [], model: productModelId },
        }),
      },
    );
    expect(blockedSend.status).toBe(422);
    expect(await blockedSend.text()).toContain("not allowed by this workspace's model policy");

    const publicConfig = await publicApp.request("/v1/config/client");
    expect(publicConfig.status).toBe(200);
    const publicPayload = (await publicConfig.json()) as {
      models: Array<{ id: string }>;
    };
    expect(publicPayload.models.some((model) => model.id === productModelId)).toBe(false);

    const readOnlyDelete = await request(`/gateway-custom-models/${createdModel.id}`, {
      method: "DELETE",
      permissions: ["workspace:read"],
    });
    expect(readOnlyDelete.status).toBe(403);

    const removed = await request(`/gateway-custom-models/${createdModel.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect((await (await request("/gateway-custom-models")).json()).models).toEqual([]);
  });
});
