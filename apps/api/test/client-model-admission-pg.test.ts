import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as codex from "@opengeni/codex";
import postgres from "postgres";
import { z } from "zod";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import { ClientConfig, signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import {
  allWorkspacePermissions,
  bootstrapWorkspace,
  createConnection,
  createDb,
  createWorkspaceProviderCustomModel,
  getModelConnectionAccess,
  getCodexCredentialStatus,
  getBillingBalance,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  updateCodexRotationSettings,
  updateModelConnectionAccess,
  upsertCodexSubscriptionCredential,
  upsertWorkspaceModelPolicy,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const SECRET = "client-model-admission-parity-test-secret";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (adminUrl || appUrl) {
    if (!adminUrl || !appUrl) throw new Error("Both test PostgreSQL URLs are required");
    const admin = postgres(adminUrl, { max: 4 });
    shared = { admin, adminUrl, appUrl, release: async () => await admin.end() };
  } else {
    shared = await acquireSharedTestDatabase("client-model-admission");
  }
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Client model admission parity tests require real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(overrides: Parameters<typeof testSettings>[0] = {}) {
  if (!client || !shared) throw new Error("PostgreSQL fixture unavailable");
  const context = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test:client-model-admission",
    accountExternalId: crypto.randomUUID(),
    accountName: "Client model admission",
    workspaceExternalSource: "test:client-model-admission",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Client model admission",
    subjectId: `user:client-model-${crypto.randomUUID()}`,
  });
  const grant = context.workspaceGrants[0]!;
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${grant.accountId}, 'Personal') returning id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'owner', 'active', ${personal!.id})`;
  const app = createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      codexSubscriptionEnabled: true,
      sandboxBackend: "none",
      ...overrides,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
  });
  async function request(
    path: string,
    body?: unknown,
    actor: AccessGrant = grant,
    method?: "GET" | "POST" | "PUT",
  ): Promise<Response> {
    return app.request(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
          ...actor,
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1_000) + 3_600,
        })}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function config(actor: AccessGrant = grant) {
    const response = await request(
      `/v1/config/client?workspaceId=${grant.workspaceId}`,
      undefined,
      actor,
    );
    expect(response.status).toBe(200);
    const clientConfig = ClientConfig.parse(await response.json());
    if (clientConfig.models.length > 0) {
      expect(clientConfig.allowedModels).toEqual(clientConfig.models.map((model) => model.id));
      expect(clientConfig.legacyModelFallback).toBeUndefined();
    } else {
      expect(clientConfig.allowedModels).toEqual([clientConfig.legacyModelFallback!.id]);
      expect(clientConfig.legacyModelFallback!.availability).toMatchObject({
        status: "unavailable",
        selectable: false,
      });
    }
    return clientConfig;
  }
  async function parity(rejected: string[] = []) {
    const current = await config();
    for (const { id: model } of current.models) {
      const response = await request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
        model,
        initialMessage: "Test model selection",
        visibility: "workspace",
        tools: [],
      });
      if (response.status !== 202) {
        throw new Error(`Expected creatable model ${model}: ${await response.text()}`);
      }
      expect(response.status).toBe(202);
      expect((await response.json()).model).toBe(model);
    }
    for (const model of rejected) {
      expect(current.models.map((entry) => entry.id)).not.toContain(model);
      const response = await request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
        model,
        initialMessage: "Test model selection",
        visibility: "workspace",
        tools: [],
      });
      expect(response.status).toBe(422);
    }
    return current;
  }
  return { grant, request, config, parity };
}

test("PG: disconnected Codex is never advertised or freshly creatable", async () => {
  if (!client) return;
  const f = await fixture();
  const config = await f.parity(["codex/gpt-6-sol", "codex/invented-model"]);
  expect(config.allowedModels.length).toBeGreaterThan(0);
  expect(config.allowedModels.some((id) => id.startsWith("codex/"))).toBe(false);
  const implicit = await f.request("/v1/config/client");
  expect(ClientConfig.parse(await implicit.json()).allowedModels).toEqual(config.allowedModels);
  const readOnly = { ...f.grant, permissions: ["workspace:read"] as AccessGrant["permissions"] };
  const readOnlyConfig = await f.config(readOnly);
  expect(readOnlyConfig.models).toEqual([]);
  expect(readOnlyConfig.legacyModelFallback?.availability.reason).toBe("policy_blocked");
}, 180_000);

test("review: advertised default is also selected by an omitted model create", async () => {
  if (!client) throw new Error("Real PostgreSQL required");
  const f = await fixture({
    openaiModel: "codex/gpt-6-sol",
    openaiAllowedModels: "gpt-5.6-sol",
  });
  const config = await f.config();
  expect(config.defaultModel).toBe("gpt-5.6-sol");
  const response = await f.request(`/v1/workspaces/${f.grant.workspaceId}/sessions`, {
    initialMessage: "Use the default model",
    visibility: "workspace",
    tools: [],
  });
  expect(response.status).toBe(202);
  const created = await response.json();
  expect(created.model).toBe(config.defaultModel);
  expect(created.reasoningEffort).toBe(config.defaultReasoningEffort);
}, 180_000);

test("PG: policy fallback advertises the exact omitted-create model and reasoning", async () => {
  if (!client) return;
  const f = await fixture({ openaiModel: "gpt-5.6-sol", openaiReasoningEffort: "low" });
  await upsertWorkspaceModelPolicy(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    allowedProviders: null,
    allowedModels: ["gpt-5.6-luna"],
  });
  const result = await f.config();
  expect(result.defaultModel).toBe("gpt-5.6-luna");
  const response = await f.request(`/v1/workspaces/${f.grant.workspaceId}/sessions`, {
    initialMessage: "Use the policy fallback",
    visibility: "workspace",
    tools: [],
  });
  expect(response.status).toBe(202);
  const created = await response.json();
  expect(created.model).toBe(result.defaultModel);
  expect(created.reasoningEffort).toBe(result.defaultReasoningEffort);
}, 180_000);

test("PG: fallback reasoning comes from the admitted model, not the blocked deployment", async () => {
  if (!client) return;
  const capabilities = configuredModels(testSettings())[0]!.capabilities;
  const f = await fixture({
    openaiReasoningEffort: "low",
    modelProvidersJson: JSON.stringify([
      {
        id: "reasoning-fixture",
        kind: "anonymous",
        baseUrl: "https://reasoning.example.test/v1",
        models: [
          {
            id: "reasoning-fixture/model",
            capabilities: {
              ...capabilities,
              reasoning: { ...capabilities.reasoning, defaultEffort: "high" },
            },
          },
        ],
      },
    ]),
  });
  await upsertWorkspaceModelPolicy(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    allowedProviders: ["reasoning-fixture"],
    allowedModels: null,
  });
  const result = await f.config();
  expect(result.defaultModel).toBe("reasoning-fixture/model");
  expect(result.defaultReasoningEffort).toBe("high");
  const response = await f.request(`/v1/workspaces/${f.grant.workspaceId}/sessions`, {
    initialMessage: "Use the fallback reasoning",
    visibility: "workspace",
    tools: [],
  });
  expect(response.status).toBe(202);
  const created = await response.json();
  expect(created.model).toBe(result.defaultModel);
  expect(created.reasoningEffort).toBe(result.defaultReasoningEffort);
}, 180_000);

test("PG: ready Codex model permissions and workspace policy affect list and create identically", async () => {
  if (!client || !shared) return;
  const f = await fixture();
  const credential = await upsertCodexSubscriptionCredential(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    credentialEncrypted: "metadata-only-fake-secret",
    chatgptAccountId: crypto.randomUUID(),
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: null,
    lastRefreshAt: null,
  });
  await ensureCodexRotationSettings(client.db, f.grant.accountId, f.grant.workspaceId);
  await updateCodexRotationSettings(client.db, f.grant.workspaceId, { rotationEnabled: true });
  const codexTarget = { ...f.grant, kind: "codex" as const, connectionId: credential.id };
  const codexAccess = await getModelConnectionAccess(client.db, codexTarget);
  expect(codexAccess).not.toBeNull();
  expect(
    await updateModelConnectionAccess(client.db, codexTarget, {
      ...codexAccess!,
      allowedModels: ["codex/gpt-6-sol"],
    }),
  ).not.toBeNull();
  expect((await f.parity(["codex/gpt-6-astra", "codex/invented-model"])).allowedModels).toContain(
    "codex/gpt-6-sol",
  );
  await upsertWorkspaceModelPolicy(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    allowedProviders: ["openai"],
    allowedModels: ["gpt-5.6-sol"],
  });
  expect((await f.parity(["codex/gpt-6-sol", "gpt-5.6-luna"])).allowedModels).toEqual([
    "gpt-5.6-sol",
  ]);
}, 180_000);

test("PG: an explicit Codex draft creates with zero credits without refreshing its near-expiry token", async () => {
  if (!client || !shared) return;
  const encryptionKey = Buffer.alloc(32, 82);
  const f = await fixture({
    usageLimitsMode: "managed",
    environmentsEncryptionKey: encryptionKey.toString("base64"),
  });
  expect((await getBillingBalance(client.db, f.grant.accountId)).balanceMicros).toBe(0);
  await upsertCodexSubscriptionCredential(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    credentialEncrypted: encryptEnvironmentValue(
      encryptionKey,
      JSON.stringify({
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
        id_token: "synthetic-id-token",
      }),
    ),
    chatgptAccountId: crypto.randomUUID(),
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60_000),
    lastRefreshAt: new Date(),
  });
  await ensureCodexRotationSettings(client.db, f.grant.accountId, f.grant.workspaceId);
  await updateCodexRotationSettings(client.db, f.grant.workspaceId, { rotationEnabled: true });
  const refresh = spyOn(codex, "refreshCodexToken").mockRejectedValue(
    new codex.CodexReloginRequired("Synthetic refresh tokens are not provider credentials"),
  );
  const models = spyOn(codex, "fetchCodexModels").mockResolvedValue({
    ok: false,
    status: 503,
    slugs: [],
  });
  try {
    const draft = {
      expectedRevision: 0,
      text: "Use the chosen subscription without OpenGeni credits",
      resources: [],
      tools: [],
      toolsProvided: true,
      model: "codex/gpt-6-sol",
      modelProvided: true,
      reasoningEffort: "xhigh",
      latencyMode: "standard",
      options: { visibility: "workspace" },
    };
    const savedResponse = await f.request(
      `/v1/workspaces/${f.grant.workspaceId}/new-session-draft`,
      draft,
      f.grant,
      "PUT",
    );
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json();
    const response = await f.request(`/v1/workspaces/${f.grant.workspaceId}/sessions`, {
      initialMessage: draft.text,
      resources: draft.resources,
      tools: draft.tools,
      model: draft.model,
      reasoningEffort: draft.reasoningEffort,
      latencyMode: draft.latencyMode,
      visibility: "workspace",
      expectedNewSessionDraftRevision: saved.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      model: "codex/gpt-6-sol",
      reasoningEffort: "xhigh",
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
    expect(await getCodexCredentialStatus(client.db, f.grant.workspaceId)).toMatchObject({
      connected: true,
      status: "active",
    });
  } finally {
    refresh.mockRestore();
    models.mockRestore();
  }
}, 180_000);

test("PG: workspace Claude custom models use the same readiness and model permissions", async () => {
  if (!client || !shared) return;
  const f = await fixture();
  const connection = await createConnection(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    subjectId: null,
    providerDomain: "api.anthropic.com",
    kind: "api_key",
    credentialEncrypted: "metadata-only-fake-secret",
    metadata: { credentialRole: "anthropic" },
    createdBySubjectId: f.grant.subjectId,
  });
  const custom = await createWorkspaceProviderCustomModel(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    providerKind: "anthropic",
    upstreamModelId: "claude-fixture-model",
    label: "Fixture Claude",
    operationId: crypto.randomUUID(),
    requestHash: "a".repeat(64),
    createdBySubjectId: f.grant.subjectId,
  });
  expect(custom).not.toBeNull();
  expect((await f.parity()).allowedModels).toContain("workspace-anthropic/claude-fixture-model");
  const claudeTarget = { ...f.grant, kind: "anthropic" as const, connectionId: connection.id };
  const claudeAccess = await getModelConnectionAccess(client.db, claudeTarget);
  expect(claudeAccess).not.toBeNull();
  expect(
    await updateModelConnectionAccess(client.db, claudeTarget, {
      ...claudeAccess!,
      allowedModels: [],
    }),
  ).not.toBeNull();
  await f.parity(["workspace-anthropic/claude-fixture-model"]);
}, 180_000);

test("PG: no usable model yields empty lists, not a fabricated selectable default", async () => {
  if (!client) return;
  const f = await fixture({ openaiApiKey: undefined });
  const result = await f.parity(["gpt-5.6-sol", "codex/gpt-6-sol"]);
  expect(result.models).toEqual([]);
  expect(result.allowedModels).toHaveLength(1);
  expect(result.legacyModelFallback?.availability.reason).toBe("missing_credential");
  const legacyParser = ClientConfig.omit({ legacyModelFallback: true }).extend({
    allowedModels: z.array(z.string()).min(1),
  });
  expect(legacyParser.safeParse(result).success).toBe(true);
  const readOnly = { ...f.grant, permissions: ["workspace:read"] as AccessGrant["permissions"] };
  expect((await f.config(readOnly)).models).toEqual([]);
}, 180_000);

test("PG: workspace selector never borrows another caller's authority", async () => {
  if (!client) return;
  const f = await fixture();
  const other = await fixture();
  const forbidden = await f.request(
    `/v1/config/client?workspaceId=${other.grant.workspaceId}`,
    undefined,
    { ...f.grant, permissions: allWorkspacePermissions },
  );
  expect(forbidden.status).toBe(403);
}, 180_000);

test("PG: database catalog changes and retired Codex definitions apply to both list and create", async () => {
  if (!client || !shared) return;
  const capabilities = configuredModels(
    withCodexCatalogProvider(testSettings({ codexSubscriptionEnabled: true })),
  ).find((model) => model.id === "codex/gpt-6-sol")!.capabilities;
  const baseDocument = {
    schemaVersion: 1,
    defaultModel: "gpt-5.6-sol",
    builtInModels: ["gpt-5.6-sol"],
    codexModels: [
      { id: "codex/fixture-hot-model", upstreamModelId: "fixture-hot-model", capabilities },
    ],
  };
  // The integration database is an isolated test fixture, never a deployment.
  const prior = await shared.admin<{ document: unknown; version: number; updated_at: Date }[]>`
    select document, version, updated_at from deployment_model_catalog where singleton = true`;
  try {
    await shared.admin`
      insert into deployment_model_catalog (singleton, document)
      values (true, ${shared.admin.json(baseDocument)})
      on conflict (singleton) do update set document = excluded.document, version = deployment_model_catalog.version + 1`;
    const f = await fixture({ modelCatalogSource: "database" });
    await f.parity(["codex/fixture-hot-model", "codex/gpt-6-sol", "gpt-5.6-luna"]);
    await upsertCodexSubscriptionCredential(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      credentialEncrypted: "metadata-only-fake-secret",
      chatgptAccountId: crypto.randomUUID(),
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: null,
      lastRefreshAt: null,
    });
    await ensureCodexRotationSettings(client.db, f.grant.accountId, f.grant.workspaceId);
    await updateCodexRotationSettings(client.db, f.grant.workspaceId, { rotationEnabled: true });
    expect((await f.parity(["codex/gpt-6-sol"])).allowedModels).toContain(
      "codex/fixture-hot-model",
    );
    const retiredDocument = {
      ...baseDocument,
      codexModels: baseDocument.codexModels.map((model) => ({ ...model, retired: true })),
    };
    await shared.admin`
      update deployment_model_catalog set document = ${shared.admin.json(retiredDocument)}, version = version + 1
      where singleton = true`;
    expect((await f.parity(["codex/fixture-hot-model"])).allowedModels).toEqual(["gpt-5.6-sol"]);
  } finally {
    if (prior[0]) {
      await shared.admin`
        update deployment_model_catalog set document = ${shared.admin.json(prior[0].document as never)},
        version = ${prior[0].version}, updated_at = ${prior[0].updated_at} where singleton = true`;
    } else {
      await shared.admin`delete from deployment_model_catalog where singleton = true`;
    }
  }
}, 180_000);

test.each([
  { name: "Azure AD", azureOpenaiAdToken: "fixture-bearer-never-executed" },
  { name: "managed identity", azureOpenaiAdToken: undefined },
])(
  "PG: $name with no resolver observation remains listed and creatable",
  async (scenario) => {
    if (!client) return;
    const f = await fixture({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://fixture.openai.azure.com/openai/v1",
      azureOpenaiApiKey: undefined,
      azureOpenaiAdToken: scenario.azureOpenaiAdToken,
    });
    const result = await f.parity(["codex/gpt-6-sol"]);
    expect(result.allowedModels.length).toBeGreaterThan(0);
    for (const model of result.models) {
      expect(model.availability).toMatchObject({
        status: "unavailable",
        selectable: false,
        reason: "credential_not_ready",
      });
    }
  },
  180_000,
);

test("PG: provider_unhealthy xAI model remains listed and creatable with unavailable status", async () => {
  if (!client) return;
  const f = await fixture({
    modelProvidersJson: JSON.stringify([
      {
        id: "xai",
        apiKey: "fixture-key-never-executed",
        baseUrl: "https://api.x.ai/v1",
        models: [{ id: "xai/grok-4.5" }],
      },
    ]),
  });
  const result = await f.parity();
  expect(result.allowedModels).toContain("xai/grok-4.5");
  expect(result.models.find((model) => model.id === "xai/grok-4.5")?.availability).toEqual({
    status: "unavailable",
    selectable: false,
    reason: "provider_unhealthy",
    checkedAt: null,
  });
}, 180_000);
