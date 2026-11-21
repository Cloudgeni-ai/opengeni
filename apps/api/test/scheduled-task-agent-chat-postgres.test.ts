import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SCHEDULED_TASK_AGENT_CHAT_CHANGE_METADATA_KEY } from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  createAgent,
  createDb,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

// An agent's automation in one chat (real PostgreSQL): its own chat with the
// agent, replaced when the agent changes, and an existing chat only when that
// chat is the agent's and the owner can use it.

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-task-agent-chat");
  if (!acquired) throw new Error("Agent automation chat tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const memberPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "scheduled_tasks:run",
  "scheduled_tasks:manage",
];

type Json = Record<string, any>;

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Agent automation chat') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [...memberPermissions, "workspace:admin", "members:manage", "account:admin"],
  });
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async () => {
    const identity = await ensureExternalIdentity(db.db, {
      accountId,
      source,
      externalId: crypto.randomUUID(),
    });
    const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source, externalId: identity.externalId },
        permissions: memberPermissions,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    return {
      subjectId: identity.subjectId,
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const owner = await person();
  const other = await person();
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'scheduled-task-agent-chat-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const root = `/v1/workspaces/${workspace.id}`;
  const call = async (
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json }> => {
    const response = await app.request(`${root}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : {} };
  };
  const agent = async (name: string): Promise<string> => {
    const created = await call(owner.headers, "POST", "/agents", { name });
    expect(created.status).toBe(201);
    return created.json.agent.id as string;
  };
  /** A chat of the owner's, bound to `agentId` when given. */
  const chat = async (
    agentId: string | null,
    visibility: "workspace_shared" | "user_private" = "workspace_shared",
  ) =>
    await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
      createSession(db.db, {
        accountId,
        workspaceId: workspace.id,
        initialMessage: "Work",
        resources: [],
        metadata: {},
        ...(visibility === "user_private" ? { visibility } : {}),
        createdBy: { kind: "subject", subjectId: owner.subjectId },
        subjectId: owner.subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        ...(agentId ? { agent: { id: agentId, subjectId: owner.subjectId } } : {}),
      }),
    );
  const agentConfig = (agentId: string) => ({
    agentId,
    prompt: "Plan the day",
    resources: [],
    tools: [],
    metadata: {},
    sandboxBackend: "none",
  });
  return { accountId, workspace, owner, other, call, agent, chat, agentConfig };
}

const schedule = { type: "interval", everySeconds: 3600 };

test("an agent's own chat is replaced, and the change recorded, when its agent changes", async () => {
  const f = await fixture();
  const planner = await f.agent("Planner");
  const reviewer = await f.agent("Reviewer");
  const created = await f.call(f.owner.headers, "POST", "/scheduled-tasks", {
    name: "Daily plan",
    schedule,
    runMode: "reusable_session",
    agentConfig: f.agentConfig(planner),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json).toMatchObject({ runMode: "reusable_session", reusableSessionId: null });
  expect(created.json.agentConfig.agentId).toBe(planner);

  // Its first run started the automation's chat with the agent.
  const first = await f.chat(planner);
  await shared.admin`update scheduled_tasks set reusable_session_id = ${first.id}
    where id = ${created.json.id}`;
  const materialized = await f.call(f.owner.headers, "GET", `/scheduled-tasks/${created.json.id}`);
  expect(materialized.json.reusableSessionId).toBe(first.id);

  // Another prompt keeps the chat.
  const reworded = await f.call(f.owner.headers, "PATCH", `/scheduled-tasks/${created.json.id}`, {
    expectedExecutionDigest: materialized.json.executionDigest,
    prompt: "Plan the whole day",
  });
  expect(reworded.status, JSON.stringify(reworded.json)).toBe(200);
  expect(reworded.json.reusableSessionId).toBe(first.id);

  // A new agent: the chat stays with Planner, and the next run starts one with Reviewer.
  const moved = await f.call(f.owner.headers, "PATCH", `/scheduled-tasks/${created.json.id}`, {
    expectedExecutionDigest: reworded.json.executionDigest,
    agentConfig: f.agentConfig(reviewer),
  });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  expect(moved.json).toMatchObject({ runMode: "reusable_session", reusableSessionId: null });
  expect(moved.json.agentConfig.agentId).toBe(reviewer);
  expect(moved.json.metadata[SCHEDULED_TASK_AGENT_CHAT_CHANGE_METADATA_KEY]).toMatchObject({
    sessionId: first.id,
    agentId: planner,
  });
  const audit = await shared.admin<{ metadata: Json }[]>`
    select metadata from audit_events
    where action = 'scheduled_task.agent_chat_changed' and target_id = ${created.json.id}`;
  expect(audit).toHaveLength(1);
  expect(audit[0]!.metadata).toMatchObject({
    previousSessionId: first.id,
    previousAgentId: planner,
    agentId: reviewer,
  });

  // An agent nobody here can use is still refused.
  const missing = await f.call(f.owner.headers, "PATCH", `/scheduled-tasks/${created.json.id}`, {
    expectedExecutionDigest: moved.json.executionDigest,
    agentConfig: f.agentConfig(crypto.randomUUID()),
  });
  expect(missing.status).toBe(422);
  expect(missing.json.error.message).toBe("That agent is not available in this workspace.");
});

test("an agent's automation uses an existing chat only when it is that agent's and the owner's", async () => {
  const f = await fixture();
  const planner = await f.agent("Planner");
  const reviewer = await f.agent("Reviewer");
  const plannerChat = await f.chat(planner);
  const plainChat = await f.chat(null);
  const create = async (
    headers: Record<string, string>,
    targetSessionId: string,
    agentId: string,
  ) =>
    await f.call(headers, "POST", "/scheduled-tasks", {
      name: "Morning check-in",
      schedule,
      runMode: "existing_session",
      targetSessionId,
      agentConfig: { agentId, prompt: "Check in", resources: [], tools: [], metadata: {} },
    });

  const created = await create(f.owner.headers, plannerChat.id, planner);
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json).toMatchObject({
    runMode: "existing_session",
    targetSessionId: plannerChat.id,
  });
  expect(created.json.agentConfig.agentId).toBe(planner);

  for (const [target, agentId] of [
    [plainChat.id, planner],
    [plannerChat.id, reviewer],
  ] as const) {
    const refused = await create(f.owner.headers, target, agentId);
    expect(refused.status).toBe(422);
    expect(refused.json.error.message).toBe(
      "That chat isn't with this agent. Choose one of the agent's chats.",
    );
  }
  // Someone who can't open the chat can't point an automation at it.
  const privateChat = await f.chat(planner, "user_private");
  const foreign = await create(f.other.headers, privateChat.id, planner);
  expect(foreign.status).toBe(404);

  // Edits keep the chat's agent: another agent or a chat without one is refused.
  const path = `/scheduled-tasks/${created.json.id}`;
  const otherAgent = await f.call(f.owner.headers, "PATCH", path, {
    expectedExecutionDigest: created.json.executionDigest,
    agentConfig: { agentId: reviewer, prompt: "Check in", resources: [], tools: [], metadata: {} },
  });
  expect(otherAgent.status).toBe(422);
  const retarget = await f.call(f.owner.headers, "PATCH", path, {
    expectedExecutionDigest: created.json.executionDigest,
    targetSessionId: plainChat.id,
  });
  expect(retarget.status).toBe(422);
  expect(retarget.json.error.message).toBe(
    "That chat isn't with this agent. Choose one of the agent's chats.",
  );
  const reworded = await f.call(f.owner.headers, "PATCH", path, {
    expectedExecutionDigest: created.json.executionDigest,
    prompt: "Check in early",
  });
  expect(reworded.status, JSON.stringify(reworded.json)).toBe(200);
  expect(reworded.json.agentConfig).toMatchObject({ agentId: planner, prompt: "Check in early" });

  // Moving it to a new chat each run keeps the agent.
  const ownChats = await f.call(f.owner.headers, "PATCH", path, {
    expectedExecutionDigest: reworded.json.executionDigest,
    runMode: "new_session_per_run",
    targetSessionId: null,
    agentConfig: f.agentConfig(planner),
  });
  expect(ownChats.status, JSON.stringify(ownChats.json)).toBe(200);
  expect(ownChats.json.agentConfig.agentId).toBe(planner);
});

test("agentConfigPatch changes or removes an automation's agent without replacing its config", async () => {
  const f = await fixture();
  const planner = await f.agent("Planner");
  const reviewer = await f.agent("Reviewer");
  const created = await f.call(f.owner.headers, "POST", "/scheduled-tasks", {
    name: "Daily plan",
    schedule,
    runMode: "reusable_session",
    agentConfig: f.agentConfig(planner),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const first = await f.chat(planner);
  await shared.admin`update scheduled_tasks set reusable_session_id = ${first.id}
    where id = ${created.json.id}`;
  const path = `/scheduled-tasks/${created.json.id}`;
  const materialized = await f.call(f.owner.headers, "GET", path);

  // Another agent: its own chat is replaced at the next run, the prompt kept.
  const moved = await f.call(f.owner.headers, "PATCH", path, {
    expectedExecutionDigest: materialized.json.executionDigest,
    agentConfigPatch: { agentId: reviewer },
  });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  expect(moved.json).toMatchObject({ reusableSessionId: null });
  expect(moved.json.agentConfig).toMatchObject({ agentId: reviewer, prompt: "Plan the day" });
  expect(moved.json.metadata[SCHEDULED_TASK_AGENT_CHAT_CHANGE_METADATA_KEY]).toMatchObject({
    sessionId: first.id,
    agentId: planner,
  });

  // An agent nobody here can use is refused.
  const missing = await f.call(f.owner.headers, "PATCH", path, {
    expectedExecutionDigest: moved.json.executionDigest,
    agentConfigPatch: { agentId: crypto.randomUUID() },
  });
  expect(missing.status).toBe(422);
  expect(missing.json.error.message).toBe("That agent is not available in this workspace.");

  // null runs it without an agent.
  const cleared = await f.call(f.owner.headers, "PATCH", path, {
    expectedExecutionDigest: moved.json.executionDigest,
    agentConfigPatch: { agentId: null },
  });
  expect(cleared.status, JSON.stringify(cleared.json)).toBe(200);
  expect(cleared.json.agentConfig.agentId).toBeUndefined();
  expect(cleared.json.agentConfig.prompt).toBe("Plan the day");

  // An existing-chat automation moves to another agent with one of that agent's chats.
  const plannerChat = await f.chat(planner);
  const reviewerChat = await f.chat(reviewer);
  const inChat = await f.call(f.owner.headers, "POST", "/scheduled-tasks", {
    name: "Morning check-in",
    schedule,
    runMode: "existing_session",
    targetSessionId: plannerChat.id,
    agentConfig: { agentId: planner, prompt: "Check in", resources: [], tools: [], metadata: {} },
  });
  expect(inChat.status, JSON.stringify(inChat.json)).toBe(201);
  const chatPath = `/scheduled-tasks/${inChat.json.id}`;
  const notTheAgentsChat = await f.call(f.owner.headers, "PATCH", chatPath, {
    expectedExecutionDigest: inChat.json.executionDigest,
    agentConfigPatch: { agentId: reviewer },
  });
  expect(notTheAgentsChat.status).toBe(422);
  const retargeted = await f.call(f.owner.headers, "PATCH", chatPath, {
    expectedExecutionDigest: inChat.json.executionDigest,
    targetSessionId: reviewerChat.id,
    agentConfigPatch: { agentId: reviewer },
  });
  expect(retargeted.status, JSON.stringify(retargeted.json)).toBe(200);
  expect(retargeted.json).toMatchObject({ targetSessionId: reviewerChat.id });
  expect(retargeted.json.agentConfig).toMatchObject({ agentId: reviewer, prompt: "Check in" });
});

test("agentConfigPatch never gives an automation an agent its owner can't use there", async () => {
  const f = await fixture();
  const planner = await f.agent("Planner");
  const ownOnlyMe = await f.call(f.owner.headers, "POST", "/agents", {
    name: "My notes",
    visibility: "private",
  });
  expect(ownOnlyMe.status, JSON.stringify(ownOnlyMe.json)).toBe(201);
  const othersOnlyMe = await f.call(f.other.headers, "POST", "/agents", {
    name: "Their notes",
    visibility: "private",
  });
  expect(othersOnlyMe.status, JSON.stringify(othersOnlyMe.json)).toBe(201);
  const created = await f.call(f.owner.headers, "POST", "/scheduled-tasks", {
    name: "Daily plan",
    schedule,
    runMode: "new_session_per_run",
    agentConfig: f.agentConfig(planner),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const path = `/scheduled-tasks/${created.json.id}`;
  const patch = async (headers: Record<string, string>, agentId: string) =>
    await f.call(headers, "PATCH", path, {
      expectedExecutionDigest: created.json.executionDigest,
      agentConfigPatch: { agentId },
    });

  // Someone else's Only me agent isn't available to the owner.
  const foreign = await patch(f.owner.headers, othersOnlyMe.json.agent.id);
  expect(foreign.status).toBe(422);
  expect(foreign.json.error.message).toBe("That agent is not available in this workspace.");
  // The owner's own Only me agent needs an Only me automation.
  const onShared = await patch(f.owner.headers, ownOnlyMe.json.agent.id);
  expect(onShared.status).toBe(422);
  expect(onShared.json.error.message).toBe(
    "This agent is Only me, so its automations are Only me too.",
  );
  // Another workspace's agent isn't available here.
  const elsewhere = await createWorkspace(db.db, {
    accountId: f.accountId,
    name: "Other workspace",
  });
  const { agent: foreignAgent } = await createAgent(
    db.db,
    { accountId: f.accountId, workspaceId: elsewhere.id },
    {
      visibility: "workspace",
      ownerSubjectId: null,
      name: "Elsewhere",
      description: "",
      avatar: null,
      instructions: "",
      firstMessage: "",
      memoryEnabled: false,
      origin: "app",
      sourceSessionId: null,
      createdBySubjectId: f.owner.subjectId,
      maxPerWorkspace: 500,
    },
  );
  const otherWorkspace = await patch(f.owner.headers, foreignAgent.id);
  expect(otherWorkspace.status).toBe(422);
  // Someone who isn't the owner can't change it at all.
  const notOwner = await patch(f.other.headers, planner);
  expect([403, 404]).toContain(notOwner.status);
  const unchanged = await f.call(f.owner.headers, "GET", path);
  expect(unchanged.json.agentConfig.agentId).toBe(planner);
});
