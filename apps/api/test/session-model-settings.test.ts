import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessGrant, SessionAuthorizationPort } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  getSession,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  updateOrganizationPrivateSessionSettings,
  upsertWorkspaceModelPolicy,
  withWorkspaceSessionActivityRls,
  type SessionCreateInput,
} from "@opengeni/db";
import { setSessionModel, type ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
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
  const locked = await fixture({ frozenCodexCompactionMode: "remote_v2" });
  await expect(call(locked.grant, request(locked.session.id))).rejects.toThrow("locked to Codex");
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
