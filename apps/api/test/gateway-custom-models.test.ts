import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  VERCEL_AI_GATEWAY_CONNECTION_DOMAIN,
  VERCEL_AI_GATEWAY_CONNECTION_ROLE,
  resolveModelProvider,
} from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { createSessionForRequest, resolveCatalogSettings, type ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  createSession,
  MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS,
  upsertWorkspaceModelPolicy,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";

import {
  createAppComposition,
  resolveWorkspaceMcpRouteDeps,
  type AppDependencies,
} from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const SECRET = "gateway-custom-models-test-secret-at-least-32-bytes";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let publicApp: Hono | null = null;
let publicRouteDeps: ApiRouteDeps | null = null;
let grant: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number] | null = null;

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: SECRET,
});

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) return await acquireSharedTestDatabase("gateway-custom-models");
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
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
  const composition = createAppComposition({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
  } satisfies AppDependencies);
  publicApp = composition.app;
  publicRouteDeps = composition.routeDeps;
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

async function callMcpTool(
  deps: ApiRouteDeps,
  accessGrant: NonNullable<typeof grant>,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const server = buildOpenGeniMcpServer(deps, accessGrant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "gateway-custom-models-test", version: "1" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  try {
    return await mcpClient.callTool({ name, arguments: arguments_ });
  } finally {
    await Promise.all([mcpClient.close(), server.close()]);
  }
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
      { upstreamModelId: "a".repeat(239) },
      { upstreamModelId: "a".repeat(257) },
      { upstreamModelId: "anthropic|claude" },
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

    for (const upstreamModelId of [
      "deepseek/deepseek-v4-flash-0731",
      "deepseek-v4-flash-0731",
      "kimi-k3",
    ]) {
      const collision = await request("/gateway-custom-models", {
        method: "POST",
        body: { upstreamModelId },
      });
      expect(collision.status).toBe(422);
    }
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
    const mcpDeps = await resolveWorkspaceMcpRouteDeps(publicRouteDeps!, grant);
    expect(resolveModelProvider(mcpDeps.settings, productModelId)?.model).toMatchObject({
      id: productModelId,
      cost: "workspace",
    });

    const inheritedSession = await createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Inherited policy-check fixture",
      resources: [],
      metadata: {},
      model: productModelId,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const scheduledTask = await createScheduledTask(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      name: "Continue the accepted Gateway model",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `gateway-custom-model-${crypto.randomUUID()}`,
      runMode: "existing_session",
      targetSessionId: inheritedSession.id,
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Continue with the session's already accepted model",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const mcpTrigger = await callMcpTool(mcpDeps, grant, "scheduled_tasks_trigger", {
      id: scheduledTask.id,
      triggerId: crypto.randomUUID(),
    });
    expect(mcpTrigger).not.toMatchObject({ isError: true });
    const inheritedChild = await createSessionForRequest(
      publicRouteDeps!,
      {
        ...grant,
        metadata: { ...(grant.metadata ?? {}), sessionId: inheritedSession.id },
      },
      grant.workspaceId,
      {
        initialMessage: "Inherit the parent custom Gateway model",
        resources: [],
        sandboxBackend: "none",
      },
    );
    expect(inheritedChild.model).toBe(productModelId);

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

    const blockedInheritedSend = await publicApp.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${inheritedSession.id}/events`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(["sessions:control"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: { text: "blocked inherited custom model", resources: [] },
        }),
      },
    );
    expect(blockedInheritedSend.status).toBe(422);
    expect(await blockedInheritedSend.text()).toContain(
      "not allowed by this workspace's model policy",
    );

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

    await upsertWorkspaceModelPolicy(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      allowedProviders: null,
      allowedModels: null,
    });

    const missingModelIdempotencyKey = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const missingCreate = await publicApp.request(
        `http://x/v1/workspaces/${grant.workspaceId}/sessions`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(["sessions:create"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            initialMessage: "Missing custom model must be a policy error",
            resources: [],
            model: productModelId,
            sandboxBackend: "none",
            idempotencyKey: missingModelIdempotencyKey,
          }),
        },
      );
      expect(missingCreate.status).toBe(422);
      expect(await missingCreate.text()).toContain(productModelId);
    }

    const postRetirementMcpDeps = await resolveWorkspaceMcpRouteDeps(publicRouteDeps!, grant);
    expect(resolveModelProvider(postRetirementMcpDeps.settings, productModelId)).toBeUndefined();
    const inheritedAfterDelete = await createSessionForRequest(
      postRetirementMcpDeps,
      {
        ...grant,
        metadata: { ...(grant.metadata ?? {}), sessionId: inheritedSession.id },
      },
      grant.workspaceId,
      {
        initialMessage: "Continue the parent model accepted before retirement",
        resources: [],
        sandboxBackend: "none",
      },
    );
    expect(inheritedAfterDelete.model).toBe(productModelId);

    const switchedAfterDelete = await publicApp.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${inheritedSession.id}/events`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(["sessions:control"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: {
            text: "switch away from the removed custom model",
            resources: [],
            model: settings.openaiModel,
          },
        }),
      },
    );
    expect(switchedAfterDelete.status).toBe(202);
  });

  test("enforces the transactional per-workspace custom-model bound", async () => {
    if (!shared || !grant) return;
    await shared.admin`
      delete from workspace_gateway_custom_models
      where workspace_id = ${grant.workspaceId}::uuid
    `;
    await shared.admin`
      insert into workspace_gateway_custom_models (
        id,
        account_id,
        workspace_id,
        upstream_model_id,
        label,
        created_by_subject_id
      )
      select
        gen_random_uuid(),
        ${grant.accountId}::uuid,
        ${grant.workspaceId}::uuid,
        'limit/provider-model-' || ordinal::text,
        null,
        ${grant.subjectId}
      from generate_series(1, ${MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS - 1}) as ordinal
      on conflict (workspace_id, upstream_model_id) do nothing
    `;

    const results = await Promise.all(
      ["limit/provider-model-final-a", "limit/provider-model-final-b"].map(
        async (upstreamModelId) =>
          await request("/gateway-custom-models", {
            method: "POST",
            body: { upstreamModelId },
          }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
    const overflow = results.find((result) => result.status === 422)!;
    expect(await overflow.text()).toContain(
      `workspace Gateway custom model limit reached (${MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS})`,
    );
    expect((await (await request("/gateway-custom-models")).json()).models).toHaveLength(
      MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS,
    );
  });
});
