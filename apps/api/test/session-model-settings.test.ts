import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AccessGrant, Permission, SessionAuthorizationPort } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  armSubscriptionCoreCapacityWait,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createApiKey,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  getSession,
  getSessionTurn,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  updateOrganizationPrivateSessionSettings,
  upsertWorkspaceModelPolicy,
  withWorkspaceSessionActivityRls,
  type SessionCreateInput,
} from "@opengeni/db";
import { setSessionModel, type ApiRouteDeps } from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { createApp } from "../src/app";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const delegationSecret = "model-settings-test-delegation-secret";
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-model-settings");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function deps(port?: SessionAuthorizationPort) {
  return {
    db: client.db,
    settings: testSettings(),
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    sessionAuthorization: port,
  } as unknown as ApiRouteDeps;
}
function tools(grant: AccessGrant, port?: SessionAuthorizationPort) {
  return (
    buildOpenGeniMcpServer(deps(port), grant) as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> }
      >;
    }
  )._registeredTools;
}
async function call(
  grant: AccessGrant,
  args: Record<string, unknown>,
  port?: SessionAuthorizationPort,
) {
  const result = await tools(grant, port).session_set_model!.handler(args, {});
  return JSON.parse(result.content[0]!.text);
}
function request(sessionId: string) {
  return {
    sessionId,
    model: "scripted-model",
    reasoningEffort: "high",
    idempotencyKey: crypto.randomUUID(),
  };
}
async function fixture(overrides: Partial<SessionCreateInput> = {}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Model settings",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Model settings",
    subjectId: `user:${suffix}`,
  });
  const grant: AccessGrant = {
    ...access.workspaceGrants[0]!,
    principalKind: "human_session",
    permissions: ["sessions:read", "sessions:control"],
  };
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "test",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    ...overrides,
  });
  return { grant, session };
}

async function workspaceKey(grant: AccessGrant, permissions: Permission[]) {
  const token = `ogk_${crypto.randomUUID()}`;
  await createApiKey(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: "Model defaults integration",
    prefix: token.slice(0, 12),
    keyHash: createHash("sha256").update(token).digest("hex"),
    credentialKind: "workspace",
    permissions,
  });
  return token;
}

function http(value: Awaited<ReturnType<typeof fixture>>, port?: SessionAuthorizationPort) {
  const app = createApp({
    ...deps(port),
    settings: testSettings({ productAccessMode: "managed", delegationSecret }),
  });
  return (token: string | null, body: unknown, sessionId = value.session.id) =>
    app.request(`/v1/workspaces/${value.grant.workspaceId}/sessions/${sessionId}/model-settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
}

function modelDefaults() {
  return {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    latencyMode: "fast",
    idempotencyKey: crypto.randomUUID(),
  };
}

test("HTTP model settings require session control and a workspace key is scoped to its workspace", async () => {
  const value = await fixture();
  const other = await fixture();
  const [control, readOnly, otherKey] = await Promise.all([
    workspaceKey(value.grant, ["sessions:control"]),
    workspaceKey(value.grant, ["sessions:read"]),
    workspaceKey(other.grant, ["sessions:control"]),
  ]);
  const put = http(value);
  const input = modelDefaults();
  expect((await put(null, input)).status).toBe(401);
  expect((await put(readOnly, input)).status).toBe(403);
  expect((await put(otherKey, input)).status).toBe(403);
  expect((await put(control, input, other.session.id)).status).toBe(404);
  expect(
    (
      await http(value, {
        authorizeSession: async () => ({ allowed: false, reason: "forbidden" }),
      })(control, input)
    ).status,
  ).toBe(404);
  const applied = await put(control, input);
  expect(applied.status).toBe(200);
  expect(await applied.json()).toEqual({
    sessionId: value.session.id,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    latencyMode: input.latencyMode,
    effectiveFrom: "future_turns",
    releasedCapacityWaitTurnId: null,
  });
});

test("HTTP model settings validate policy and do not clamp the desired settings", async () => {
  const value = await fixture({ latencyMode: "ultrafast" });
  const put = http(value);
  const token = await workspaceKey(value.grant, ["sessions:control"]);
  const input = modelDefaults();
  const before = await shared.admin`select * from sessions where id = ${value.session.id}`;
  for (const [change, message] of [
    [{ latencyMode: undefined }, "Invalid session model settings request"],
    [{ expected: { typo: "high" } }, "Invalid session model settings request"],
    [{ latencyMode: "ultrafast" }, "latency mode ultrafast is not runnable"],
    [{ reasoningEffort: "minimal" }, "Reasoning effort minimal is not runnable"],
    [{ model: "not-configured" }, "not available"],
  ] as const) {
    const response = await put(token, { ...input, ...change });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(message);
  }
  await upsertWorkspaceModelPolicy(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    allowedProviders: null,
    allowedModels: ["scripted-model"],
  });
  const denied = await put(token, input);
  expect(denied.status).toBe(400);
  expect((await denied.json()).error.message).toContain("workspace's model policy");
  expect(await shared.admin`select * from sessions where id = ${value.session.id}`).toEqual(before);
  const applied = await put(token, { ...input, model: "scripted-model", latencyMode: "standard" });
  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({ latencyMode: "standard" });
});

test("HTTP model settings compare atomically and replay the original result without overwriting a newer choice", async () => {
  const value = await fixture();
  const put = http(value);
  const token = await workspaceKey(value.grant, ["sessions:control"]);
  const before = await footprint(value.session.id);
  const expected = { model: "scripted-model", reasoningEffort: "medium", latencyMode: "standard" };
  const inputs = [
    { ...modelDefaults(), expected },
    { ...modelDefaults(), model: "gpt-5.6-terra", expected },
  ];
  // Verify every supplied field can veto a write, not just the model.
  for (const stale of [
    { model: "gpt-5.6-sol" },
    { reasoningEffort: "high" },
    { latencyMode: "fast" },
  ]) {
    const response = await put(token, { ...modelDefaults(), expected: stale });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "conflict",
        details: { reason: "model_settings_mismatch", current: expected },
      },
    });
  }
  const results = await Promise.all(
    inputs.map(async (input) => {
      const response = await put(token, input);
      return { input, status: response.status, body: await response.json() };
    }),
  );
  expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
  const winner = results.find(({ status }) => status === 200)!;
  expect(results.find(({ status }) => status === 409)!.body).toMatchObject({
    error: {
      details: {
        current: { model: winner.input.model, reasoningEffort: "high", latencyMode: "fast" },
      },
    },
  });
  const newer = await put(token, {
    ...modelDefaults(),
    model: "scripted-model",
    latencyMode: "standard",
    expected: { latencyMode: "fast" },
  });
  expect(newer.status).toBe(200);
  await upsertWorkspaceModelPolicy(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    allowedProviders: null,
    allowedModels: ["scripted-model"],
  });
  const replay = await put(token, winner.input);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(winner.body);
  for (const change of [{ latencyMode: "standard" }, { expected: { model: "scripted-model" } }]) {
    const conflict = await put(token, { ...winner.input, ...change });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
  }
  expect(await getSession(client.db, value.grant.workspaceId, value.session.id)).toMatchObject({
    model: "scripted-model",
    reasoningEffort: "high",
    latencyMode: "standard",
  });
  expect(await footprint(value.session.id)).toEqual(before);
  expect(
    await shared.admin`select id from session_events where session_id = ${value.session.id} and type = 'session.model_settings.updated'`,
  ).toHaveLength(2);
  expect(
    await shared.admin`select id from session_command_receipts where target_session_id = ${value.session.id}`,
  ).toHaveLength(2);
});

test("HTTP model settings leave an already running turn and its execution policy alone", async () => {
  const value = await fixture();
  const active = await agent(value);
  const agentToken = await signDelegatedAccessToken(delegationSecret, {
    accountId: active.accountId,
    workspaceId: active.workspaceId,
    subjectId: active.subjectId,
    permissions: active.permissions,
    principalKind: "agent_attempt",
    ...active.metadata,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  expect((await http(value)(agentToken, modelDefaults())).status).toBe(403);
  const token = await workspaceKey(value.grant, ["sessions:control"]);
  const before =
    await shared.admin`select * from session_turns where id = ${active.metadata.turnId}`;
  const response = await http(value)(token, modelDefaults());
  expect(response.status).toBe(200);
  expect(
    await shared.admin`select * from session_turns where id = ${active.metadata.turnId}`,
  ).toEqual(before);
  expect(await getSession(client.db, value.grant.workspaceId, value.session.id)).toMatchObject({
    model: "gpt-5.6-sol",
    latencyMode: "fast",
  });
});

test("HTTP compares before validating a capacity-wait model switch and can release it with explicit latency", async () => {
  const value = await fixture();
  const attempt = await agent(value);
  const { turnId, attemptId } = attempt.metadata;
  const armed = await armSubscriptionCoreCapacityWait(client.db, "codex", {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    turnId,
    attemptId,
    waitReason: "no_eligible_capacity",
    earliestResetAt: new Date(Date.now() + 24 * 60 * 60_000),
    failurePayload: { error: "No subscription capacity" },
  });
  expect(armed.action).toBe("waiting");
  const put = http(value);
  const token = await workspaceKey(value.grant, ["sessions:control"]);
  const input = modelDefaults();
  expect((await put(token, { ...input, model: "not-configured" })).status).toBe(400);
  expect((await put(token, { ...input, latencyMode: "ultrafast" })).status).toBe(400);
  expect(
    (await put(token, { ...input, model: "not-configured", expected: { latencyMode: "fast" } }))
      .status,
  ).toBe(409);
  expect(await getSessionTurn(client.db, value.grant.workspaceId, turnId)).toMatchObject({
    model: "scripted-model",
    status: "waiting_capacity",
  });

  const applied = await put(token, input);
  expect(applied.status).toBe(200);
  const body = await applied.json();
  expect(body).toMatchObject({ releasedCapacityWaitTurnId: turnId, latencyMode: "fast" });
  expect(await getSessionTurn(client.db, value.grant.workspaceId, turnId)).toMatchObject({
    model: input.model,
    latencyMode: "fast",
    status: "recovering",
  });
  expect(await (await put(token, input)).json()).toEqual(body);
});
async function footprint(sessionId: string) {
  const [result] = await shared.admin`select status, active_turn_id, direct_control_state,
    queue_version, queue_head_position, queue_tail_position, metadata, tools,
    (select count(*) from session_turns where session_id = ${sessionId}) as turns,
    (select count(*) from session_workflow_wake_outbox where session_id = ${sessionId}) as wakes,
    (select count(*) from session_attempt_interruptions where session_id = ${sessionId}) as interruptions
    from sessions where id = ${sessionId}`;
  return result;
}
async function agent(value: Awaited<ReturnType<typeof fixture>>) {
  await initializeSessionStartAtomically(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
    sessionId: value.session.id,
    workflowId: `session-${value.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fixture agent not claimed");
  return {
    ...value.grant,
    principalKind: "agent_attempt" as const,
    metadata: {
      sessionId: value.session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      firstPartyMcpTools: ["session_set_model"],
    },
  };
}

test("model settings tool uses existing permission and exact signed tool selection", async () => {
  const { grant } = await fixture();
  expect(tools(grant).session_set_model).toBeDefined();
  expect(tools({ ...grant, permissions: ["sessions:read"] }).session_set_model).toBeUndefined();
  const agentGrant: AccessGrant = {
    ...grant,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      firstPartyMcpTools: ["session_set_model"],
    },
  };
  expect(tools(agentGrant).session_set_model).toBeDefined();
  expect(
    tools({ ...agentGrant, metadata: { ...agentGrant.metadata, firstPartyMcpTools: [] } })
      .session_set_model,
  ).toBeUndefined();
});

test("model settings preserves pause, queues and latency with exact retry receipts", async () => {
  const value = await fixture({ metadata: { retained: "value" } });
  await withWorkspaceSessionActivityRls(client.db, value.grant.workspaceId, (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.session.id,
      actor: { type: "human", subjectId: value.grant.subjectId },
      operationKey: crypto.randomUUID(),
      action: "pause",
    }),
  );
  const before = await footprint(value.session.id);
  const input = request(value.session.id);
  const first = await call(value.grant, input);
  expect(first).toMatchObject({
    receiptVersion: "mcp-mutation-receipt.v1",
    committed: true,
    facts: {
      model: "scripted-model",
      reasoningEffort: "high",
      latencyMode: "standard",
      effectiveFrom: "future_turns",
    },
    idempotency: { status: "applied" },
  });
  const replay = {
    ...first,
    changed: false,
    outcome: "replayed",
    idempotency: { status: "replayed" },
  };
  expect(await call(value.grant, input)).toEqual(replay);
  await expect(call(value.grant, { ...input, reasoningEffort: "low" })).rejects.toThrow(
    "operation key was already used",
  );
  expect(await footprint(value.session.id)).toEqual(before);
  expect(await getSession(client.db, value.grant.workspaceId, value.session.id)).toMatchObject({
    reasoningEffort: "high",
    effectiveControl: { state: "paused" },
  });
  const events =
    await shared.admin`select id from session_events where session_id = ${value.session.id} and type = 'session.model_settings.updated'`;
  expect(events).toHaveLength(1);
  // Replaying the first write after a later choice does not reset the defaults.
  await call(value.grant, {
    ...input,
    reasoningEffort: "low",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(await call(value.grant, input)).toEqual(replay);
  expect(await getSession(client.db, value.grant.workspaceId, value.session.id)).toMatchObject({
    reasoningEffort: "low",
  });
});

test("model settings validates input and workspace/provider policy without writes", async () => {
  const value = await fixture();
  const input = request(value.session.id);
  const before = await shared.admin`select * from sessions where id = ${value.session.id}`;
  for (const change of [
    { model: "not-configured" },
    { reasoningEffort: "imaginary" },
    { latencyMode: "fast" },
  ]) {
    await expect(call(value.grant, { ...input, ...change })).rejects.toThrow();
  }
  await expect(
    setSessionModel(deps(), { ...value.grant, permissions: [] }, value.session.id, {
      model: input.model,
      reasoningEffort: "high",
      idempotencyKey: input.idempotencyKey,
    }),
  ).rejects.toThrow();
  await upsertWorkspaceModelPolicy(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    allowedProviders: null,
    allowedModels: ["gpt-5.6-sol"],
  });
  await expect(call(value.grant, input)).rejects.toThrow("workspace's model policy");
  expect(await shared.admin`select * from sessions where id = ${value.session.id}`).toEqual(before);
  // A Codex remote-compaction chat switches models in place; its next turn
  // rebuilds the context for the new model.
  const remote = await fixture({ frozenCodexCompactionMode: "remote_v2" });
  await call(remote.grant, request(remote.session.id));
  expect(await getSession(client.db, remote.grant.workspaceId, remote.session.id)).toMatchObject({
    model: "scripted-model",
    codexCompactionMode: "remote_v2",
  });
});

test("model settings authorizes the exact target and first-party surface once", async () => {
  const value = await fixture();
  const calls: string[] = [];
  const port: SessionAuthorizationPort = {
    authorizeSession: async ({ target, operation, surface }) => {
      calls.push(`${target.sessionId}:${operation}:${surface}`);
      return { allowed: false, reason: "forbidden" };
    },
  };
  await expect(call(value.grant, request(value.session.id), port)).rejects.toThrow("access denied");
  expect(calls).toEqual([`${value.session.id}:session.model.write:first_party_mcp`]);
  const other = await fixture();
  await expect(call(value.grant, request(other.session.id))).rejects.toThrow("access denied");
  expect(
    await shared.admin`select id from session_command_receipts where target_session_id = ${value.session.id}`,
  ).toHaveLength(0);
});

test("live agent model settings retain accepted policy and reject a stale caller at the write fence", async () => {
  const value = await fixture();
  const grant = await agent(value);
  const before =
    await shared.admin`select * from session_turns where id = ${grant.metadata.turnId}`;
  await call(grant, request(value.session.id));
  expect(
    await shared.admin`select * from session_turns where id = ${grant.metadata.turnId}`,
  ).toEqual(before);
  const port: SessionAuthorizationPort = {
    authorizeSession: async () => {
      // Lose the attempt after the preflight resolved it but before the write lock.
      await shared.admin`update session_turn_attempts set state = 'closed', outcome = 'completed', closed_at = now() where id = ${grant.metadata.attemptId}`;
      return { allowed: true };
    },
  };
  await expect(
    call(grant, { ...request(value.session.id), reasoningEffort: "low" }, port),
  ).rejects.toThrow("no longer owns");
  expect(await getSession(client.db, value.grant.workspaceId, value.session.id)).toMatchObject({
    reasoningEffort: "high",
  });
});

test("private session settings remain owner-scoped even when a host allows the target", async () => {
  const userId = `settings-${crypto.randomUUID()}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Settings owner",
  });
  const grant: AccessGrant = {
    ...context.workspaceGrants[0]!,
    subjectId: `user:${userId}`,
    principalKind: "human_session",
    permissions: ["sessions:read", "sessions:control"],
  };
  await shared.admin`insert into session_tenancy_activations(account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'test') on conflict (account_id) do nothing`;
  const current = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: grant.subjectId,
  });
  if (!current.enabled)
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: grant.subjectId,
      enabled: true,
      expectedVersion: current.version,
      operationId: crypto.randomUUID(),
    });
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    visibility: "user_private",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    subjectId: grant.subjectId,
    initialMessage: "private work",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const port: SessionAuthorizationPort = { authorizeSession: async () => ({ allowed: true }) };
  await expect(
    call({ ...grant, subjectId: "different-user" }, request(session.id), port),
  ).rejects.toThrow("access denied");
  expect(await call(grant, request(session.id), port)).toMatchObject({
    facts: { reasoningEffort: "high" },
  });
});

test("switching a chat's model moves its capacity-waiting turn onto the new model", async () => {
  const value = await fixture();
  await initializeSessionStartAtomically(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
    sessionId: value.session.id,
    workflowId: `session-${value.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn not claimed");
  const armed = await armSubscriptionCoreCapacityWait(client.db, "codex", {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    turnId: claimed.turn.id,
    attemptId,
    waitReason: "no_eligible_capacity",
    earliestResetAt: new Date(Date.now() + 4 * 24 * 60 * 60_000),
    failurePayload: { error: "No Codex subscription has capacity for this turn right now." },
  });
  expect(armed.action).toBe("waiting");

  const receipt = await call(value.grant, {
    ...request(value.session.id),
    model: "gpt-5.6-sol",
  });
  expect(receipt.facts).toMatchObject({
    model: "gpt-5.6-sol",
    capacityWaitingTurnContinuesNow: claimed.turn.id,
  });
  expect(await getSessionTurn(client.db, value.grant.workspaceId, claimed.turn.id)).toMatchObject({
    status: "recovering",
    model: "gpt-5.6-sol",
  });
  const resumed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
    sessionId: value.session.id,
    workflowId: `session-${value.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (resumed.action !== "claimed") throw new Error(`not claimed: ${resumed.action}`);
  expect(resumed.turn).toMatchObject({ id: claimed.turn.id, model: "gpt-5.6-sol" });
});
