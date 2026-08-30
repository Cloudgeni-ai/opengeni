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
  createAutomationSource,
  createConnection,
  createDb,
  createSession,
  MAX_WORKSPACE_GATEWAY_CUSTOM_MODEL_RECORDS,
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

function automationSessionTemplate(model: string | null) {
  return {
    prompt: "Investigate the accepted event",
    instructions: null,
    resources: [],
    skills: [],
    tools: [],
    firstPartyMcpTools: [],
    firstPartyMcpPermissions: [],
    model,
    reasoningEffort: null,
    sandboxBackend: null,
    policyRole: null,
    metadata: {},
  };
}

async function createAutomationSourceFixture(name: string) {
  if (!client || !grant) throw new Error("Gateway custom model fixture is unavailable");
  return await createAutomationSource(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBySubjectId: grant.subjectId,
    webhookSecretEncrypted: "test-ciphertext",
    request: {
      name,
      adapterId: "signed-json.v1",
      webhookSecret: "never-stored-secret",
      configuration: {},
    },
  });
}

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
      syncScheduledTask: async () => undefined,
      deleteScheduledTaskSchedule: async () => undefined,
      triggerScheduledTask: async () => undefined,
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
  target: Hono | null = app,
): Promise<Response> {
  if (!target || !grant) throw new Error("Gateway custom model fixture is unavailable");
  const headers: Record<string, string> = {
    authorization: await bearer(options.permissions ?? ["workspace:read", "workspace:admin"]),
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return await target.request(`http://x/v1/workspaces/${grant.workspaceId}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function waitForBlockedBackend(blockerPid: number, description: string): Promise<void> {
  if (!shared) throw new Error("Gateway custom model fixture is unavailable");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin<Array<{ waiting: boolean }>>`
      select exists (
        select 1
        from pg_stat_activity activity
        where activity.datname = current_database()
          and activity.state = 'active'
          and activity.wait_event_type = 'Lock'
          and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      ) as waiting
    `;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`${description} did not block behind backend ${blockerPid}`);
}

async function callMcpTool(
  deps: ApiRouteDeps,
  accessGrant: NonNullable<typeof grant>,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const server = buildOpenGeniMcpServer(deps, accessGrant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({
    name: "gateway-custom-models-test",
    version: "1",
  });
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
      {
        upstreamModelId: "anthropic/claude-sonnet-4.6",
        apiKey: "must-not-be-accepted",
      },
      { upstreamModelId: "anthropic/claude-sonnet-4.6", enabled: true },
    ]) {
      const invalid = await request("/gateway-custom-models", {
        method: "POST",
        body: { operationId: crypto.randomUUID(), ...body },
      });
      expect(invalid.status).toBe(422);
    }

    for (const upstreamModelId of [
      "deepseek/deepseek-v4-flash-0731",
      "deepseek-v4-flash-0731",
      "kimi-k3",
    ]) {
      const collision = await request("/gateway-custom-models", {
        method: "POST",
        body: { operationId: crypto.randomUUID(), upstreamModelId },
      });
      expect(collision.status).toBe(422);
    }
  });

  test("creates one exact slug, exposes it only to the workspace catalog, and deletes it", async () => {
    if (!app || !publicApp || !grant) return;
    const upstreamModelId = "anthropic/claude-sonnet-4.6";
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const createOperationId = crypto.randomUUID();
    const createBody = {
      operationId: createOperationId,
      upstreamModelId,
      label: "Claude Sonnet 4.6",
    };

    const created = await request("/gateway-custom-models", {
      method: "POST",
      body: createBody,
    });
    expect(created.status).toBe(201);
    const createdModel = (await created.json()) as {
      id: string;
      upstreamModelId: string;
      version: number;
    };
    expect(createdModel.upstreamModelId).toBe(upstreamModelId);
    expect(createdModel.version).toBe(1);

    const replayedCreate = await request("/gateway-custom-models", {
      method: "POST",
      body: createBody,
    });
    expect(replayedCreate.status).toBe(201);
    expect(await replayedCreate.json()).toMatchObject({
      id: createdModel.id,
      upstreamModelId,
      version: 1,
    });

    const replayOnlyApp = new Hono();
    registerWorkspaceRoutes(replayOnlyApp, {
      settings,
      db: client!.db,
      resolveCatalogSettings: async () => {
        throw new Error("catalog unavailable after committed custom-model create");
      },
    } as ApiRouteDeps);
    const replayedWithoutCatalog = await request(
      "/gateway-custom-models",
      { method: "POST", body: createBody },
      replayOnlyApp,
    );
    expect(replayedWithoutCatalog.status).toBe(201);
    expect(await replayedWithoutCatalog.json()).toMatchObject({
      id: createdModel.id,
      upstreamModelId,
      version: 1,
    });

    const reusedCreateOperation = await request("/gateway-custom-models", {
      method: "POST",
      body: { ...createBody, label: "Different payload" },
    });
    expect(reusedCreateOperation.status).toBe(409);

    const duplicate = await request("/gateway-custom-models", {
      method: "POST",
      body: { operationId: crypto.randomUUID(), upstreamModelId },
    });
    expect(duplicate.status).toBe(409);

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
          payload: {
            text: "blocked custom model",
            resources: [],
            model: productModelId,
          },
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
      body: {
        expectedVersion: createdModel.version,
        operationId: crypto.randomUUID(),
      },
    });
    expect(readOnlyDelete.status).toBe(403);

    const deleteOperationId = crypto.randomUUID();
    const deleteBody = {
      expectedVersion: createdModel.version,
      operationId: deleteOperationId,
    };
    const removed = await request(`/gateway-custom-models/${createdModel.id}`, {
      method: "DELETE",
      body: deleteBody,
    });
    expect(removed.status).toBe(204);
    const replayedDelete = await request(`/gateway-custom-models/${createdModel.id}`, {
      method: "DELETE",
      body: deleteBody,
    });
    expect(replayedDelete.status).toBe(204);
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

    const replacementResponse = await request("/gateway-custom-models", {
      method: "POST",
      body: {
        operationId: crypto.randomUUID(),
        upstreamModelId,
        label: "Claude Sonnet replacement",
      },
    });
    expect(replacementResponse.status).toBe(201);
    const replacement = (await replacementResponse.json()) as {
      id: string;
      version: number;
    };
    expect(replacement.id).not.toBe(createdModel.id);
    expect(replacement.version).toBe(1);

    const delayedDeleteReplay = await request(`/gateway-custom-models/${createdModel.id}`, {
      method: "DELETE",
      body: deleteBody,
    });
    expect(delayedDeleteReplay.status).toBe(204);
    const staleDelete = await request(`/gateway-custom-models/${createdModel.id}`, {
      method: "DELETE",
      body: {
        expectedVersion: createdModel.version,
        operationId: crypto.randomUUID(),
      },
    });
    expect(staleDelete.status).toBe(409);
    expect(await (await request("/gateway-custom-models")).json()).toMatchObject({
      models: [{ id: replacement.id, version: 1 }],
    });
  });

  test("rejects a fresh session when custom-model retirement wins before create commit", async () => {
    if (!shared || !publicApp || !grant) return;
    const upstreamModelId = `race/provider-model-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const created = await request("/gateway-custom-models", {
      method: "POST",
      body: { operationId: crypto.randomUUID(), upstreamModelId },
    });
    expect(created.status).toBe(201);
    const customModel = (await created.json()) as { id: string; version: number };
    const idempotencyKey = crypto.randomUUID();
    let createPromise: Promise<Response> | null = null;

    await shared.admin.begin(async (barrier) => {
      const [backend] = await barrier<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("database barrier has no backend pid");
      await barrier`
        select singleton
        from nested_agent_depth_configuration
        where singleton
        for update
      `;
      createPromise = request(
        "/sessions",
        {
          method: "POST",
          permissions: ["sessions:create"],
          body: {
            initialMessage: "Custom model retirement race",
            resources: [],
            model: productModelId,
            sandboxBackend: "none",
            idempotencyKey,
          },
        },
        publicApp,
      );
      await waitForBlockedBackend(backend.pid, "fresh custom-model session create");

      const removed = await request(`/gateway-custom-models/${customModel.id}`, {
        method: "DELETE",
        body: {
          expectedVersion: customModel.version,
          operationId: crypto.randomUUID(),
        },
      });
      expect(removed.status).toBe(204);
    });

    if (!createPromise) throw new Error("session create was not started");
    const response = await createPromise;
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(`model is not available: ${productModelId}`);
    const [stored] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from sessions
      where workspace_id = ${grant.workspaceId}::uuid
        and create_idempotency_key = ${idempotencyKey}
    `;
    expect(stored?.count).toBe(0);
  });

  test("repairs a keyed custom-model shell after the model is retired", async () => {
    if (!shared || !publicApp || !grant) return;
    const upstreamModelId = `race/keyed-shell-model-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const createdModelResponse = await request("/gateway-custom-models", {
      method: "POST",
      body: { operationId: crypto.randomUUID(), upstreamModelId },
    });
    expect(createdModelResponse.status).toBe(201);
    const customModel = (await createdModelResponse.json()) as {
      id: string;
      version: number;
    };
    const idempotencyKey = crypto.randomUUID();
    const shell = await createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Repair this custom-model session shell",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      subjectId: grant.subjectId,
      model: productModelId,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: idempotencyKey,
    });
    const removed = await request(`/gateway-custom-models/${customModel.id}`, {
      method: "DELETE",
      body: {
        expectedVersion: customModel.version,
        operationId: crypto.randomUUID(),
      },
    });
    expect(removed.status).toBe(204);

    const repaired = await request(
      "/sessions",
      {
        method: "POST",
        permissions: ["sessions:create"],
        body: {
          initialMessage: "Repair this custom-model session shell",
          resources: [],
          model: productModelId,
          sandboxBackend: "none",
          idempotencyKey,
        },
      },
      publicApp,
    );
    expect(repaired.status).toBe(202);
    expect(await repaired.json()).toMatchObject({ id: shell.id, model: productModelId });
    const [stored] = await shared.admin<Array<{ createdEvents: number; queuedTurns: number }>>`
      select
        (select count(*)::int
           from session_events
          where workspace_id = ${grant.workspaceId}::uuid
            and session_id = ${shell.id}::uuid
            and type = 'session.created') as "createdEvents",
        (select count(*)::int
           from session_turns
          where workspace_id = ${grant.workspaceId}::uuid
            and session_id = ${shell.id}::uuid) as "queuedTurns"
    `;
    expect(stored).toEqual({ createdEvents: 1, queuedTurns: 1 });
  });

  test("admits deployment-curated workspace Gateway models without a custom row", async () => {
    if (!publicApp || !grant) return;
    const curatedModelId = "workspace-gateway/deepseek-v4-flash-0731";

    const createdSessionResponse = await request(
      "/sessions",
      {
        method: "POST",
        permissions: ["sessions:create"],
        body: {
          initialMessage: "Use the curated workspace Gateway model",
          resources: [],
          model: curatedModelId,
          sandboxBackend: "none",
          idempotencyKey: crypto.randomUUID(),
        },
      },
      publicApp,
    );
    expect(createdSessionResponse.status).toBe(202);
    expect(await createdSessionResponse.json()).toMatchObject({
      model: curatedModelId,
    });

    const defaultSession = await createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Curated follow-up switch fixture",
      resources: [],
      metadata: {},
      model: settings.openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const switched = await publicApp.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${defaultSession.id}/events`,
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
            text: "Switch to the curated workspace Gateway model",
            resources: [],
            model: curatedModelId,
          },
        }),
      },
    );
    expect(switched.status).toBe(202);

    const scheduled = await request(
      "/scheduled-tasks",
      {
        method: "POST",
        permissions: ["scheduled_tasks:manage"],
        body: {
          name: `Curated Gateway schedule ${crypto.randomUUID()}`,
          schedule: { type: "manual" },
          runMode: "new_session_per_run",
          overlapPolicy: "allow_concurrent",
          status: "active",
          agentConfig: {
            prompt: "Run with the curated workspace Gateway model",
            model: curatedModelId,
            resources: [],
            tools: [],
            metadata: {},
          },
          metadata: {},
        },
      },
      publicApp,
    );
    expect(scheduled.status).toBe(201);
    expect(await scheduled.json()).toMatchObject({
      agentConfig: { model: curatedModelId },
    });

    const source = await createAutomationSourceFixture("Curated Gateway automation source");
    const trigger = await request(
      "/automations/triggers",
      {
        method: "POST",
        permissions: ["workspace:admin"],
        body: {
          sourceId: source.id,
          name: "Curated Gateway automation trigger",
          eventTypes: ["curated.gateway.event"],
          configuration: {},
          parameters: {},
          sessionTemplate: automationSessionTemplate(curatedModelId),
          status: "active",
          packInstallationId: null,
          packTemplateId: null,
        },
      },
      publicApp,
    );
    expect(trigger.status).toBe(201);
    expect(await trigger.json()).toMatchObject({
      sessionTemplate: { model: curatedModelId },
    });
  });

  test("rejects a follow-up switch when custom-model retirement wins before prompt commit", async () => {
    if (!shared || !publicApp || !grant) return;
    const upstreamModelId = `race/follow-up-model-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const created = await request("/gateway-custom-models", {
      method: "POST",
      body: { operationId: crypto.randomUUID(), upstreamModelId },
    });
    expect(created.status).toBe(201);
    const customModel = (await created.json()) as { id: string; version: number };
    const session = await createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Follow-up model retirement fixture",
      resources: [],
      metadata: {},
      model: settings.openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const clientEventId = crypto.randomUUID();
    let switchPromise: Promise<Response> | null = null;

    await shared.admin.begin(async (barrier) => {
      const [backend] = await barrier<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("database barrier has no backend pid");
      await barrier`
        select id
        from sessions
        where workspace_id = ${grant.workspaceId}::uuid
          and id = ${session.id}::uuid
        for update
      `;
      switchPromise = publicApp.request(
        `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/events`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(["sessions:control"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "user.message",
            clientEventId,
            payload: {
              text: "Switch to a model that is being retired",
              resources: [],
              model: productModelId,
            },
          }),
        },
      );
      await waitForBlockedBackend(backend.pid, "follow-up custom-model switch");

      const removed = await request(`/gateway-custom-models/${customModel.id}`, {
        method: "DELETE",
        body: {
          expectedVersion: customModel.version,
          operationId: crypto.randomUUID(),
        },
      });
      expect(removed.status).toBe(204);
    });

    if (!switchPromise) throw new Error("follow-up model switch was not started");
    const response = await switchPromise;
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(`model is not available: ${productModelId}`);
    const [stored] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from session_events
      where workspace_id = ${grant.workspaceId}::uuid
        and session_id = ${session.id}::uuid
        and client_event_id = ${clientEventId}
    `;
    expect(stored?.count).toBe(0);
  });

  test("rejects a scheduled-task create when custom-model retirement wins before commit", async () => {
    if (!shared || !publicApp || !grant) return;
    const upstreamModelId = `race/scheduled-create-model-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const created = await request("/gateway-custom-models", {
      method: "POST",
      body: { operationId: crypto.randomUUID(), upstreamModelId },
    });
    expect(created.status).toBe(201);
    const customModel = (await created.json()) as { id: string };
    const name = `Scheduled create retirement race ${crypto.randomUUID()}`;
    let createPromise: Promise<Response> | null = null;

    await shared.admin.begin(async (barrier) => {
      const [backend] = await barrier<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("database barrier has no backend pid");
      await barrier`
        select pg_advisory_xact_lock(
          hashtextextended(${"workspace-gateway-custom-models:" + grant.workspaceId}, 0)
        )
      `;
      createPromise = request(
        "/scheduled-tasks",
        {
          method: "POST",
          permissions: ["scheduled_tasks:manage"],
          body: {
            name,
            schedule: { type: "manual" },
            runMode: "new_session_per_run",
            overlapPolicy: "allow_concurrent",
            status: "active",
            agentConfig: {
              prompt: "Run only if the selected model remains active",
              model: productModelId,
              resources: [],
              tools: [],
              metadata: {},
            },
            metadata: {},
          },
        },
        publicApp,
      );
      await waitForBlockedBackend(backend.pid, "scheduled-task custom-model create");
      await barrier`
        update workspace_gateway_custom_models
        set retired_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = ${customModel.id}::uuid
      `;
    });

    if (!createPromise) throw new Error("scheduled-task create was not started");
    const response = await createPromise;
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(`model is not available: ${productModelId}`);
    const [stored] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from scheduled_tasks
      where workspace_id = ${grant.workspaceId}::uuid
        and name = ${name}
    `;
    expect(stored?.count).toBe(0);
  });

  test("rejects a paused scheduled-task resume after retirement but permits a name-only edit", async () => {
    if (!shared || !publicApp || !grant) return;
    const upstreamModelId = `race/scheduled-resume-model-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const createdModelResponse = await request("/gateway-custom-models", {
      method: "POST",
      body: { operationId: crypto.randomUUID(), upstreamModelId },
    });
    expect(createdModelResponse.status).toBe(201);
    const customModel = (await createdModelResponse.json()) as { id: string };
    const createdTaskResponse = await request(
      "/scheduled-tasks",
      {
        method: "POST",
        permissions: ["scheduled_tasks:manage"],
        body: {
          name: "Paused custom-model task",
          schedule: { type: "manual" },
          runMode: "new_session_per_run",
          overlapPolicy: "allow_concurrent",
          status: "active",
          agentConfig: {
            prompt: "Resume only while the selected model is active",
            model: productModelId,
            resources: [],
            tools: [],
            metadata: {},
          },
          metadata: {},
        },
      },
      publicApp,
    );
    expect(createdTaskResponse.status).toBe(201);
    const createdTask = (await createdTaskResponse.json()) as { id: string };
    const paused = await request(
      `/scheduled-tasks/${createdTask.id}/pause`,
      { method: "POST", permissions: ["scheduled_tasks:manage"] },
      publicApp,
    );
    expect(paused.status).toBe(200);
    let resumePromise: Promise<Response> | null = null;

    await shared.admin.begin(async (barrier) => {
      const [backend] = await barrier<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("database barrier has no backend pid");
      await barrier`
        select pg_advisory_xact_lock(
          hashtextextended(${"workspace-gateway-custom-models:" + grant.workspaceId}, 0)
        )
      `;
      resumePromise = request(
        `/scheduled-tasks/${createdTask.id}`,
        {
          method: "PATCH",
          permissions: ["scheduled_tasks:manage"],
          body: { status: "active" },
        },
        publicApp,
      );
      await waitForBlockedBackend(backend.pid, "scheduled-task custom-model resume");
      await barrier`
        update workspace_gateway_custom_models
        set retired_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = ${customModel.id}::uuid
      `;
    });

    if (!resumePromise) throw new Error("scheduled-task resume was not started");
    const resumed = await resumePromise;
    expect(resumed.status).toBe(422);
    expect(await resumed.text()).toContain(`model is not available: ${productModelId}`);
    const [stored] = await shared.admin<Array<{ status: string; name: string }>>`
      select status, name
      from scheduled_tasks
      where workspace_id = ${grant.workspaceId}::uuid
        and id = ${createdTask.id}::uuid
    `;
    expect(stored).toMatchObject({ status: "paused", name: "Paused custom-model task" });

    const renamed = await request(
      `/scheduled-tasks/${createdTask.id}`,
      {
        method: "PATCH",
        permissions: ["scheduled_tasks:manage"],
        body: { name: "Retired custom-model task renamed" },
      },
      publicApp,
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      name: "Retired custom-model task renamed",
      status: "paused",
    });
  });

  test("rejects an automation trigger create when custom-model retirement wins before commit", async () => {
    if (!shared || !publicApp || !grant) return;
    const upstreamModelId = `race/automation-create-model-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const createdModelResponse = await request("/gateway-custom-models", {
      method: "POST",
      body: { operationId: crypto.randomUUID(), upstreamModelId },
    });
    expect(createdModelResponse.status).toBe(201);
    const customModel = (await createdModelResponse.json()) as { id: string };
    const source = await createAutomationSourceFixture("Automation create race source");
    const name = `Automation create retirement race ${crypto.randomUUID()}`;
    let createPromise: Promise<Response> | null = null;

    await shared.admin.begin(async (barrier) => {
      const [backend] = await barrier<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("database barrier has no backend pid");
      await barrier`
        select pg_advisory_xact_lock(
          hashtextextended(${"workspace-gateway-custom-models:" + grant.workspaceId}, 0)
        )
      `;
      createPromise = request(
        "/automations/triggers",
        {
          method: "POST",
          permissions: ["workspace:admin"],
          body: {
            sourceId: source.id,
            name,
            eventTypes: ["automation.create.race"],
            configuration: {},
            parameters: {},
            sessionTemplate: automationSessionTemplate(productModelId),
            status: "active",
            packInstallationId: null,
            packTemplateId: null,
          },
        },
        publicApp,
      );
      await waitForBlockedBackend(backend.pid, "automation trigger custom-model create");
      await barrier`
        update workspace_gateway_custom_models
        set retired_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = ${customModel.id}::uuid
      `;
    });

    if (!createPromise) throw new Error("automation trigger create was not started");
    const response = await createPromise;
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(`model is not available: ${productModelId}`);
    const [stored] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from automation_triggers
      where workspace_id = ${grant.workspaceId}::uuid
        and name = ${name}
    `;
    expect(stored?.count).toBe(0);
  });

  test("rejects a material automation update after retirement but permits a name-only edit", async () => {
    if (!shared || !publicApp || !grant) return;
    const upstreamModelId = `race/automation-update-model-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const createdModelResponse = await request("/gateway-custom-models", {
      method: "POST",
      body: { operationId: crypto.randomUUID(), upstreamModelId },
    });
    expect(createdModelResponse.status).toBe(201);
    const customModel = (await createdModelResponse.json()) as { id: string };
    const source = await createAutomationSourceFixture("Automation update race source");
    const createdTriggerResponse = await request(
      "/automations/triggers",
      {
        method: "POST",
        permissions: ["workspace:admin"],
        body: {
          sourceId: source.id,
          name: "Automation update retirement race",
          eventTypes: ["automation.update.race"],
          configuration: {},
          parameters: {},
          sessionTemplate: automationSessionTemplate(productModelId),
          status: "active",
          packInstallationId: null,
          packTemplateId: null,
        },
      },
      publicApp,
    );
    expect(createdTriggerResponse.status).toBe(201);
    const trigger = (await createdTriggerResponse.json()) as {
      id: string;
      revision: number;
    };
    let updatePromise: Promise<Response> | null = null;

    await shared.admin.begin(async (barrier) => {
      const [backend] = await barrier<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("database barrier has no backend pid");
      await barrier`
        select pg_advisory_xact_lock(
          hashtextextended(${"workspace-gateway-custom-models:" + grant.workspaceId}, 0)
        )
      `;
      updatePromise = request(
        `/automations/triggers/${trigger.id}`,
        {
          method: "PATCH",
          permissions: ["workspace:admin"],
          body: {
            expectedRevision: trigger.revision,
            configuration: { material: true },
          },
        },
        publicApp,
      );
      await waitForBlockedBackend(backend.pid, "automation trigger custom-model update");
      await barrier`
        update workspace_gateway_custom_models
        set retired_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = ${customModel.id}::uuid
      `;
    });

    if (!updatePromise) throw new Error("automation trigger update was not started");
    const response = await updatePromise;
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(`model is not available: ${productModelId}`);
    const [stored] = await shared.admin<
      Array<{ currentRevision: number; configuration: Record<string, unknown> }>
    >`
      select
        trigger.current_revision as "currentRevision",
        revision.configuration
      from automation_triggers trigger
      join automation_trigger_revisions revision
        on revision.trigger_id = trigger.id
       and revision.revision = trigger.current_revision
      where trigger.workspace_id = ${grant.workspaceId}::uuid
        and trigger.id = ${trigger.id}::uuid
    `;
    expect(stored).toMatchObject({
      currentRevision: trigger.revision,
      configuration: {},
    });

    const renamed = await request(
      `/automations/triggers/${trigger.id}`,
      {
        method: "PATCH",
        permissions: ["workspace:admin"],
        body: {
          expectedRevision: trigger.revision,
          name: "Retired custom-model automation renamed",
        },
      },
      publicApp,
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      name: "Retired custom-model automation renamed",
      revision: trigger.revision + 1,
    });
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
        create_operation_id,
        create_request_hash,
        created_by_subject_id
      )
      select
        gen_random_uuid(),
        ${grant.accountId}::uuid,
        ${grant.workspaceId}::uuid,
        'limit/provider-model-' || ordinal::text,
        null,
        gen_random_uuid(),
        repeat('0', 64),
        ${grant.subjectId}
      from generate_series(1, ${MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS - 1}) as ordinal
    `;

    const results = await Promise.all(
      ["limit/provider-model-final-a", "limit/provider-model-final-b"].map(
        async (upstreamModelId) =>
          await request("/gateway-custom-models", {
            method: "POST",
            body: { operationId: crypto.randomUUID(), upstreamModelId },
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

  test("bounds retained custom-model generations", async () => {
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
        create_operation_id,
        create_request_hash,
        created_by_subject_id,
        retired_at
      )
      select
        gen_random_uuid(),
        ${grant.accountId}::uuid,
        ${grant.workspaceId}::uuid,
        'history/provider-model-' || ordinal::text,
        null,
        gen_random_uuid(),
        repeat('0', 64),
        ${grant.subjectId},
        clock_timestamp()
      from generate_series(1, ${MAX_WORKSPACE_GATEWAY_CUSTOM_MODEL_RECORDS}) as ordinal
    `;

    const overflow = await request("/gateway-custom-models", {
      method: "POST",
      body: {
        operationId: crypto.randomUUID(),
        upstreamModelId: "history/provider-model-overflow",
      },
    });
    expect(overflow.status).toBe(422);
    expect(await overflow.text()).toContain(
      `workspace Gateway custom model history limit reached (${MAX_WORKSPACE_GATEWAY_CUSTOM_MODEL_RECORDS})`,
    );
  });
});
