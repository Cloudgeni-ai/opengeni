import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { signDelegatedAccessToken, type AgentLearningContext } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createScheduledTask,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  saveAgentLearningSettings,
  withSessionRlsActorContext,
  type KnowledgeContext,
} from "@opengeni/db";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createWorkspaceIdResolver } from "../../../packages/sdk/src/tenant-workspaces";
import { registerKnowledgeRoutes } from "../src/routes/knowledge";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const delegationSecret = "member-learning-read-test-secret-at-least-32-bytes";
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("member-learning-read");
  if (!acquired) throw new Error("Member learning-read verification requires real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const [account] = await shared.admin`
    INSERT INTO managed_accounts(name) VALUES('Member learning-read fixture') RETURNING id`;
  const accountId = String(account!.id);
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "Fixture service",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin", "account:admin"],
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  const deps = {
    db: client.db,
    settings: testSettings({ productAccessMode: "configured", delegationSecret }),
    bus: new MemoryEventBus(),
  } as unknown as ApiRouteDeps;
  registerWorkspaceRoutes(app, deps);
  registerKnowledgeRoutes(app, deps);
  const service = new OpenGeniClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch: async (input, init) => app.request(input, init),
  });
  const source = `learning-test:${crypto.randomUUID()}`;
  const user = crypto.randomUUID();
  const workspaceId = await createWorkspaceIdResolver(service, {
    organizationId: accountId,
    source,
  })({ tenant: "customer", user }, { isolation: "user" });
  const actor = service.asUser(user, { source });
  const request = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({ mode: "external", identity: { externalId: user, source } }),
        ),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const identity = await ensureExternalIdentity(client.db, { accountId, source, externalId: user });
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: identity.subjectId,
      writeScopes: [],
      settingsScopes: ["workspace", "personal"],
      review: false,
    },
  };
  return { accountId, workspaceId, source, user, identity, actor, service, app, context, request };
}

async function chat(f: Awaited<ReturnType<typeof fixture>>, subjectId: string, personal: boolean) {
  return withSessionRlsActorContext({ subjectId }, () =>
    createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "Learning-read fixture",
      resources: [],
      metadata: {},
      memoryScope: personal ? "user" : "workspace",
      ...(personal ? { scopeSubjectId: subjectId } : {}),
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
}

async function settings(
  f: Awaited<ReturnType<typeof fixture>>,
  scope: "workspace" | "personal",
  source?: AgentLearningContext,
  subjectId = f.identity.subjectId,
) {
  return saveAgentLearningSettings(
    client.db,
    { ...f.context, actor: { ...f.context.actor, subjectId } } as KnowledgeContext,
    {
      scope,
      source,
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: source
        ? { knowledge: "off" }
        : { knowledge: "off", instructions: "review_first", skills: "off" },
    },
  );
}

test("the real SDK default isolated member reads defaults without acquiring document permissions", async () => {
  const f = await fixture();
  const grant = (await f.service.listWorkspaceMembers(f.workspaceId)).find(
    (member) => member.subjectId === f.identity.subjectId,
  )!;
  expect(grant.permissions).toContain("workspace:read");
  for (const permission of ["documents:search", "documents:manage", "workspace:admin"])
    expect(grant.permissions).not.toContain(permission);
  for (const scope of ["workspace", "personal"] as const) {
    const saved = await settings(f, scope);
    expect(saved).toEqual(await f.actor.getAgentLearningSettings(f.workspaceId, scope));
  }
  const response = await f.request("POST", `/v1/workspaces/${f.workspaceId}/agent-learning/read`, {
    scope: "workspace",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(
    (await f.service.listWorkspaceMembers(f.workspaceId)).find(
      (member) => member.subjectId === f.identity.subjectId,
    )!.permissions,
  ).toEqual(grant.permissions);
});

test("members read chat and task overrides only in the actual workspace or personal owner layer", async () => {
  const f = await fixture();
  const peer = await ensureExternalIdentity(client.db, {
    accountId: f.accountId,
    source: f.source,
    externalId: crypto.randomUUID(),
  });
  await f.service.addExternalWorkspaceMember(f.workspaceId, {
    identity: { source: f.source, externalId: peer.externalId },
    permissions: ["workspace:read", "sessions:read"],
    operationId: crypto.randomUUID(),
  });
  for (const [personal, subjectId] of [
    [false, f.identity.subjectId],
    [true, f.identity.subjectId],
    [true, peer.subjectId],
  ] as const) {
    const session = await chat(f, subjectId, personal);
    const task = await createScheduledTask(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      name: "Learning-read task",
      status: "paused",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "existing_session",
      targetSessionId: session.id,
      overlapPolicy: "allow_concurrent",
      createdBy: { kind: "subject", subjectId },
      agentConfig: { prompt: "Fixture", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    for (const source of [
      { kind: "chat" as const, id: session.id },
      { kind: "scheduled_task" as const, id: task.id },
    ]) {
      const scope = personal ? "personal" : "workspace";
      const saved = await settings(f, scope, source, subjectId);
      if (subjectId === f.identity.subjectId) {
        expect(saved).toEqual(
          await f.actor.getAgentLearningSettings(f.workspaceId, "context", source),
        );
        expect(saved).toEqual(await f.actor.getAgentLearningSettings(f.workspaceId, scope, source));
      } else {
        await expect(
          f.actor.getAgentLearningSettings(f.workspaceId, "context", source),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          f.actor.getAgentLearningSettings(f.workspaceId, "personal", source),
        ).rejects.toMatchObject({ status: 403 });
      }
      await expect(
        f.actor.getAgentLearningSettings(
          f.workspaceId,
          personal ? "workspace" : "personal",
          source,
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
  }
});

test("settings reads deny foreign workspaces, foreign sources, absent sources and forged owner input", async () => {
  const f = await fixture();
  const foreign = await fixture();
  const foreignChat = await chat(foreign, foreign.identity.subjectId, false);
  await expect(
    f.actor.getAgentLearningSettings(foreign.workspaceId, "workspace"),
  ).rejects.toMatchObject({ status: 403 });
  const unadmitted = await createWorkspace(client.db, {
    accountId: f.accountId,
    name: "Not admitted",
  });
  await expect(f.actor.getAgentLearningSettings(unadmitted.id, "workspace")).rejects.toMatchObject({
    status: 403,
  });
  for (const source of [
    { kind: "chat" as const, id: foreignChat.id },
    { kind: "chat" as const, id: crypto.randomUUID() },
    { kind: "scheduled_task" as const, id: crypto.randomUUID() },
  ])
    await expect(
      f.actor.getAgentLearningSettings(f.workspaceId, "context", source),
    ).rejects.toMatchObject({ status: 403 });
  await expect(f.actor.getAgentLearningSettings(f.workspaceId, "context")).rejects.toMatchObject({
    status: 403,
  });
  const forged = await f.request("POST", `/v1/workspaces/${f.workspaceId}/agent-learning/read`, {
    scope: "personal",
    subjectId: foreign.identity.subjectId,
  });
  expect(forged.status).toBe(422);
});

test("existing document-reader access is preserved, but membership reductions and removal deny reads", async () => {
  const f = await fixture();
  expect(await f.actor.getAgentLearningSettings(f.workspaceId, "workspace")).toMatchObject({
    version: 0,
  });
  await shared.admin`UPDATE workspace_memberships SET permissions='["documents:search"]'::jsonb
    WHERE workspace_id=${f.workspaceId} AND subject_id=${f.identity.subjectId}`;
  expect(await f.actor.getAgentLearningSettings(f.workspaceId, "workspace")).toMatchObject({
    version: 0,
  });
  await shared.admin`UPDATE workspace_memberships SET permissions='["sessions:read"]'::jsonb
    WHERE workspace_id=${f.workspaceId} AND subject_id=${f.identity.subjectId}`;
  await expect(f.actor.getAgentLearningSettings(f.workspaceId, "workspace")).rejects.toMatchObject({
    status: 403,
  });
  await f.service.removeWorkspaceMember(f.workspaceId, f.identity.subjectId);
  await expect(f.actor.getAgentLearningSettings(f.workspaceId, "workspace")).rejects.toMatchObject({
    status: 403,
  });
});

test("organization services and stale agent attempts cannot read settings or forge human service authority", async () => {
  const f = await fixture();
  await expect(
    f.service.getAgentLearningSettings(f.workspaceId, "workspace"),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    signDelegatedAccessToken(delegationSecret, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId: f.identity.subjectId,
      permissions: ["workspace:read"],
      exp: Math.floor(Date.now() / 1000) + 60,
      principalKind: "human_session",
      serviceInitiator: { kind: "service", subjectId: "learning-service" },
    }),
  ).rejects.toThrow("human_session principal cannot carry machine authority claims");
  for (const claims of [
    { principalKind: "service" as const },
    {
      principalKind: "service" as const,
      serviceInitiator: { kind: "service" as const, subjectId: "learning-service" },
    },
    {
      principalKind: "agent_attempt" as const,
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
    },
  ]) {
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId: f.identity.subjectId,
      permissions: ["workspace:read"],
      exp: Math.floor(Date.now() / 1000) + 60,
      ...claims,
    });
    const response = await f.app.request(`/v1/workspaces/${f.workspaceId}/agent-learning/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "personal" }),
    });
    expect(response.status).toBe(403);
  }
});

test("learning read does not widen Knowledge search, writes, overrides or administration", async () => {
  const f = await fixture();
  const [before] =
    await shared.admin`SELECT count(*)::int AS n FROM agent_learning_revisions WHERE account_id=${f.accountId}`;
  const base = `/v1/workspaces/${f.workspaceId}`;
  for (const [method, path, body] of [
    ["GET", "/knowledge/entries", undefined],
    ["POST", "/knowledge/entries/search", { mode: "keyword", query: "private" }],
    ["GET", `/knowledge/entries/${crypto.randomUUID()}`, undefined],
    [
      "POST",
      "/knowledge/entries",
      {
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        entry: { kind: "fact", title: "No write", content: "Denied" },
      },
    ],
    ["GET", "/agent-learning/overrides?scope=workspace", undefined],
    ["GET", "/agent-learning/instructions/reviews", undefined],
    [
      "POST",
      "/agent-learning",
      {
        scope: "workspace",
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        settings: { knowledge: "off", instructions: "off", skills: "off" },
      },
    ],
    ["PATCH", "/settings", { voiceInput: { enabled: false } }],
  ] as const) {
    const response = await f.request(method, `${base}${path}`, body);
    expect(response.status).toBe(403);
  }
  expect(await f.actor.getAgentLearningSettings(f.workspaceId, "workspace")).toMatchObject({
    version: 0,
  });
  const [after] =
    await shared.admin`SELECT count(*)::int AS n FROM agent_learning_revisions WHERE account_id=${f.accountId}`;
  expect(after).toEqual(before);
});
