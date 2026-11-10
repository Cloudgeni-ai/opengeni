import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
  type AccessGrant,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import { requirePermission, type SessionWorkflowClient } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  getScheduledTaskRunAcceptedExecution,
  getSession,
  listScheduledTaskRuns,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../../api/src/app";
import { registerNotificationTools } from "../../api/src/mcp/notification-tools";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

// The chats the scheduler starts get the Opengeni tools and permissions the
// task's creator chose over the API, and reach the task's owner; a chat with
// nobody to reach is not offered the tools that notify or call a person.

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-run-creator-selection");
  if (!acquired) throw new Error("PostgreSQL is required");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 900_000);
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
  "goals:manage",
  "scheduled_tasks:run",
  "scheduled_tasks:manage",
];
const personTools = Object.entries(FIRST_PARTY_MCP_TOOL_CAPABILITIES)
  .filter(([, owner]) => owner === "notifications")
  .map(([tool]) => tool as FirstPartyMcpToolName);

async function host() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Scheduled host') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Host",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [...memberPermissions, "workspace:admin", "members:manage", "account:admin"],
  });
  const bus = new MemoryEventBus();
  const app = createApp({
    db: db.db,
    bus,
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
      startSessionWorkflow: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
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
  const asUser = {
    ...service,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source, externalId: identity.externalId } }),
    ),
  };
  const tasksUrl = `/v1/workspaces/${workspace.id}/scheduled-tasks`;
  const create = (headers: Record<string, string>, agentConfig: Record<string, unknown> = {}) =>
    app.request(tasksUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Daily check",
        runMode: "new_session_per_run",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: {
          prompt: "Check the open orders",
          resources: [],
          tools: [],
          metadata: {},
          sandboxBackend: "none",
          agent: { capabilities: { from: "all", browser: false } },
          ...agentConfig,
        },
      }),
    });
  const activities = createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" }),
        db: db.db,
        bus,
      }) as unknown as ActivityServices,
  );
  async function run(taskId: string) {
    const result = await activities.dispatchScheduledTaskRun({
      workspaceId: workspace.id,
      taskId,
      triggerType: "scheduled",
      producerKey: crypto.randomUUID(),
    });
    if (result.action !== "start") throw new Error(JSON.stringify(result));
    const [taskRun] = await listScheduledTaskRuns(db.db, workspace.id, taskId, 1);
    const accepted = await getScheduledTaskRunAcceptedExecution(db.db, {
      workspaceId: workspace.id,
      runId: taskRun!.id,
    });
    const session = await getSession(db.db, workspace.id, result.sessionId);
    return { result, accepted: accepted!, session: session! };
  }
  async function notifyFromRun(started: Awaited<ReturnType<typeof run>>) {
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(db.db, workspace.id, {
      sessionId: started.session.id,
      workflowId: started.result.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(JSON.stringify(claim));
    type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
    const handlers = new Map<string, Handler>();
    const grant = {
      accountId,
      workspaceId: workspace.id,
      subjectId: "worker:first-party-mcp",
      permissions: started.session.firstPartyMcpPermissions,
      permissionMode: "explicit",
      principalKind: "agent_attempt",
      metadata: {},
    } as unknown as AccessGrant;
    registerNotificationTools({
      server: {
        registerTool: (name: string, _schema: unknown, handler: Handler) =>
          handlers.set(name, handler),
      } as never,
      deps: { db: db.db, bus } as never,
      grant,
      sessionId: started.session.id,
      authorize: async () => requirePermission(grant, "sessions:control"),
      attempt: () => ({
        callerTurnId: claim.turn.id,
        callerAttemptId: attemptId,
        callerExecutionGeneration: claim.turn.executionGeneration,
      }),
      json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    });
    const out = await handlers.get("notify_user")!({
      title: "Orders checked",
      message: "",
      urgency: "normal",
    });
    return JSON.parse(out.content[0]!.text) as { delivered?: boolean };
  }
  return { app, tasksUrl, service, asUser, identity, create, run, notifyFromRun };
}

async function storedTask(taskId: string) {
  const [row] = await shared.admin`
    select owner_subject_id, creator_first_party_mcp_tools, creator_first_party_mcp_permissions, agent_config
    from scheduled_tasks where id = ${taskId}`;
  return row as {
    owner_subject_id: string | null;
    creator_first_party_mcp_tools: string[] | null;
    creator_first_party_mcp_permissions: string[] | null;
    agent_config: Record<string, unknown>;
  };
}

test("an app's chosen tools and permissions reach each run, and its notifications reach the owner", async () => {
  const { create, run, notifyFromRun, asUser, identity } = await host();
  const curated: FirstPartyMcpToolName[] = [
    "set_session_title",
    "notify_user",
    "goal_set",
    "goal_complete",
    "scheduled_tasks_list",
  ];
  const permissions = ["sessions:read", "sessions:control", "goals:manage"];
  const created = await create(asUser, {
    firstPartyMcpTools: curated,
    firstPartyMcpPermissions: permissions,
  });
  expect(created.status).toBe(201);
  const task = (await created.json()) as { id: string; agentConfig: Record<string, unknown> };
  expect(task.agentConfig).not.toHaveProperty("firstPartyMcpTools");
  const stored = await storedTask(task.id);
  expect(stored.owner_subject_id).toBe(identity.subjectId);
  expect(stored.creator_first_party_mcp_tools).toEqual(curated);
  expect(stored.creator_first_party_mcp_permissions).toEqual(permissions);
  expect(stored.agent_config).not.toHaveProperty("firstPartyMcpTools");
  expect(stored.agent_config).not.toHaveProperty("firstPartyMcpPermissions");

  const started = await run(task.id);
  expect([...started.session.firstPartyMcpTools].sort()).toEqual([...curated].sort());
  expect(started.session.toolPolicy.firstPartyMode).toBeUndefined();
  expect([...(started.session.firstPartyMcpPermissions ?? [])].sort()).toEqual(
    [...permissions].sort(),
  );
  expect([...started.accepted.resolvedFirstPartyMcpTools].sort()).toEqual([...curated].sort());
  expect(started.accepted.causalHumanSubjectId).toBe(identity.subjectId);
  expect((await notifyFromRun(started)).delivered).toBe(true);
}, 120_000);

test("a task that names no selection keeps following the defaults", async () => {
  const { create, run, notifyFromRun, asUser } = await host();
  const created = await create(asUser);
  expect(created.status).toBe(201);
  const task = (await created.json()) as { id: string };
  const stored = await storedTask(task.id);
  expect(stored.creator_first_party_mcp_tools).toBeNull();
  const started = await run(task.id);
  expect(started.session.toolPolicy.firstPartyMode).toBe("workspace_default");
  expect(started.session.firstPartyMcpTools).toContain("notify_user");
  expect(started.session.firstPartyMcpTools).toContain("goal_set");
  expect((await notifyFromRun(started)).delivered).toBe(true);
}, 120_000);

test("a run nobody owns is not offered the tools that reach a person", async () => {
  const { create, run, service } = await host();
  for (const agentConfig of [{}, { firstPartyMcpTools: ["notify_user", "goal_set"] }]) {
    const created = await create(service, agentConfig);
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };
    expect((await storedTask(task.id)).owner_subject_id).toBeNull();
    const started = await run(task.id);
    expect(started.accepted.causalHumanSubjectId ?? null).toBeNull();
    for (const tool of personTools) {
      expect(started.session.firstPartyMcpTools).not.toContain(tool);
      expect(started.accepted.resolvedFirstPartyMcpTools).not.toContain(tool);
    }
    expect(started.session.firstPartyMcpTools).toContain("goal_set");
    // The session keeps that list rather than following the defaults again.
    expect(started.session.toolPolicy.firstPartyMode).toBeUndefined();
  }
}, 120_000);

test("the selection is set at creation, within the creator's own access", async () => {
  const { app, tasksUrl, create, asUser } = await host();
  const beyond = await create(asUser, { firstPartyMcpPermissions: ["workspace:admin"] });
  expect(beyond.status).toBe(403);
  const unknownTool = await create(asUser, { firstPartyMcpTools: ["not_a_tool"] });
  expect(unknownTool.status).toBeGreaterThanOrEqual(400);
  expect(unknownTool.status).toBeLessThan(500);

  const created = await create(asUser, { firstPartyMcpTools: ["goal_set"] });
  expect(created.status).toBe(201);
  const task = (await created.json()) as { id: string; agentConfig: Record<string, unknown> };
  const update = await app.request(`${tasksUrl}/${task.id}`, {
    method: "PATCH",
    headers: asUser,
    body: JSON.stringify({
      agentConfig: { ...task.agentConfig, firstPartyMcpTools: ["goal_set", "notify_user"] },
    }),
  });
  expect(update.status).toBeGreaterThanOrEqual(400);
  expect(update.status).toBeLessThan(500);
  expect(await update.text()).toContain("firstPartyMcpTools");
  expect((await storedTask(task.id)).creator_first_party_mcp_tools).toEqual(["goal_set"]);
}, 120_000);
