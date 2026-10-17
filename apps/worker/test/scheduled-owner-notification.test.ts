import { afterAll, beforeAll, expect, test } from "bun:test";
import { ScheduledTaskAgentConfig, type Permission } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createSession,
  freezeAgentLearningPolicy,
  getScheduledNotificationContext,
  getSession,
  listInboxItems,
  listSessionEvents,
  registerNativePushDevice,
  applySessionTurnSettlement,
  createSessionGoal,
  addSessionSystemUpdate,
  type KnowledgeContext,
} from "@opengeni/db";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanExactLoginBindingForAuthUser,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "../../../packages/db/src/canonical-human-identities";
import { prepareAgentTools } from "@opengeni/runtime";
import {
  acquireOwnerMigratedTestDatabase,
  MemoryEventBus,
  testSettings,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../../../packages/db/src/migrate";
import { provisionRoles } from "../../../packages/db/src/provision-roles";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import { createScheduledNotificationTools } from "../src/activities/agent-turn/scheduled-notification-tool";
import type { ActivityServices } from "../src/activities/types";

let shared: RestrictedRuntimeTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("scheduled-owner-notification");
  if (!acquired) throw new Error("PostgreSQL is required");
  const appUrl = new URL(acquired.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = acquired.appPassword;
  shared = { ...acquired, appUrl: appUrl.toString(), schema: "public" };
  await migrate(acquired.ownerUrl);
  await provisionRoles(acquired.adminUrl, {
    appPassword: acquired.appPassword,
    rlsStrategy: "force",
  });
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema, rlsStrategy: "force" });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(
  options: {
    permissions?: Permission[];
    ownerless?: boolean;
    existing?: boolean;
    reusable?: boolean;
  } = {},
) {
  const owner = `user:${crypto.randomUUID()}`;
  const other = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "scheduled-notification-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Notification test",
    workspaceExternalSource: "scheduled-notification-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Team",
    subjectId: owner,
  });
  const accountId = access.defaultAccountId!;
  const workspaceId = access.defaultWorkspaceId!;
  for (const subject of [owner, other]) {
    const [personal] = await shared.admin`insert into workspaces (account_id,name)
      values (${accountId},'Personal') returning id`;
    await shared.admin`insert into organization_memberships (account_id,subject_id,status,personal_workspace_id)
      values (${accountId},${subject},'active',${personal!.id})`;
  }
  await shared.admin`insert into workspace_memberships (account_id,workspace_id,subject_id,permissions)
    values (${accountId},${workspaceId},${other},'["sessions:read"]')`;
  const permissions = options.permissions ?? [];
  const settings = testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" });
  const bus = new MemoryEventBus();
  const target = options.existing
    ? await createSession(client.db, {
        accountId,
        workspaceId,
        initialMessage: "Shared chat",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        firstPartyMcpTools: [],
        firstPartyMcpPermissions: permissions,
        createdBy: { kind: "subject", subjectId: other },
      })
    : null;
  const task = await createScheduledTask(client.db, {
    accountId,
    workspaceId,
    createdBy: options.ownerless
      ? { kind: "service", subjectId: "test-scheduler" }
      : { kind: "subject", subjectId: owner },
    name: "Check progress",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `test-${crypto.randomUUID()}`,
    runMode: target
      ? "existing_session"
      : options.reusable
        ? "reusable_session"
        : "new_session_per_run",
    ...(target ? { targetSessionId: target.id } : {}),
    overlapPolicy: "skip",
    action: { kind: "agent_turn" },
    metadata: {},
    agentConfig: ScheduledTaskAgentConfig.parse({
      prompt: "Check progress",
      model: "scripted-model",
      tools: [],
    }),
    creatorPolicy: {
      firstPartyMcpTools: [],
      firstPartyMcpPermissions: permissions,
      sessionPolicy: null,
    },
  });
  const activities = createScheduledTaskActivities(
    async () => ({ settings, db: client.db, bus }) as unknown as ActivityServices,
  );
  const dispatched = await activities.dispatchScheduledTaskRun({
    workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey: crypto.randomUUID(),
  });
  if (dispatched.action !== "start" && dispatched.action !== "signal")
    throw new Error(JSON.stringify(dispatched));
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: dispatched.sessionId,
    attemptId,
    workflowId: dispatched.workflowId,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(JSON.stringify(claim));
  const scope = {
    accountId,
    workspaceId,
    sessionId: dispatched.sessionId,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
  const context: KnowledgeContext = { accountId, workspaceId, actor: { kind: "agent", ...scope } };
  await freezeAgentLearningPolicy(client.db, context);
  const definitions = await createScheduledNotificationTools({ db: client.db, bus, scope });
  const notify = async (args: Record<string, unknown>, operationId = crypto.randomUUID()) => {
    const result = await definitions[0]!.execute(args, {
      operationId,
      caller: { kind: "model", subjectId: "worker" },
    });
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  const inbox = (subjectId: string) => listInboxItems(client.db, { accountId, subjectId });
  return { owner, other, scope, definitions, notify, inbox, permissions, bus, settings, claim };
}

async function registerPhone(subjectId: string) {
  const userId = subjectId.slice(5);
  await shared.admin`insert into auth_users (id,name,email,email_verified)
    values (${userId},'Owner',${`${userId}@example.test`},true)`;
  await shared.admin`insert into auth_identities (id,user_id,account_id,provider_id,created_at,updated_at)
    values (${crypto.randomUUID()},${userId},${userId},'credential',now(),now())`;
  await ensureCanonicalHumanIdentityForAuthUser(client.db, userId);
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = await getCanonicalHumanExactLoginBindingForAuthUser(client.db, {
    authUserId: userId,
    providerId: "credential",
  });
  const authSessionId = crypto.randomUUID();
  await shared.admin`insert into auth_sessions
    (id,user_id,token,expires_at,user_agent,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values (${authSessionId},${userId},${crypto.randomUUID()},now()+interval '1 day','OpenGeni app (iOS)',
      ${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
  await registerNativePushDevice(client.db, {
    authSessionId,
    platform: "ios",
    appId: "ai.opengeni.app",
    environment: "development",
    token: crypto.randomUUID().replaceAll("-", "").repeat(2),
    rules: ["agent"],
  });
  return authSessionId;
}

test("one new owner notification enqueues one phone alert; reposting is silent", async () => {
  const f = await fixture({ existing: true });
  const phone = await registerPhone(f.owner);
  await f.notify({ title: "Blocked", key: "blocking-dependency" });
  await f.notify({ title: "Still blocked", key: "blocking-dependency" });
  const deliveries =
    await shared.admin`select payload from opengeni_private.native_push_deliveries where auth_session_id=${phone}`;
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.payload).toMatchObject({
    subjectId: f.owner,
    sessionId: f.scope.sessionId,
    rule: "agent",
  });
}, 120_000);

test("causal continuations keep the occurrence; unrelated turns cannot borrow it", async () => {
  const f = await fixture();
  const goal = await createSessionGoal(client.db, {
    ...f.scope,
    text: "Finish scheduled work",
    createdBy: "api",
  });
  await applySessionTurnSettlement(client.db, f.scope.workspaceId, {
    ...f.scope,
    triggerEventId: f.claim.turn.triggerEventId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  await addSessionSystemUpdate(client.db, {
    ...f.scope,
    kind: "goal_continuation",
    classification: "info",
    sourceId: goal.id,
    dedupeKey: crypto.randomUUID(),
    summary: "Continue",
    payload: {
      type: "goal_continuation",
      goalId: goal.id,
      goalVersion: goal.version,
      prompt: "Finish scheduled work",
    },
    lineage: { causalTurnId: f.scope.turnId },
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, f.scope.workspaceId, {
    sessionId: f.scope.sessionId,
    attemptId,
    workflowId: `session-${f.scope.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(JSON.stringify(claim));
  const scope = {
    ...f.scope,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
  const policy = await freezeAgentLearningPolicy(client.db, {
    ...scope,
    actor: { kind: "agent", ...scope },
  });
  const original = await getScheduledNotificationContext(client.db, f.scope);
  expect(policy.scheduledTaskRunId).toBe(original?.runId);
  const tools = await createScheduledNotificationTools({ db: client.db, bus: f.bus, scope });
  expect(tools).toHaveLength(1);
  expect(await getScheduledNotificationContext(client.db, scope)).toMatchObject({
    subjectId: f.owner,
    runId: original?.runId,
  });
  const other = await fixture();
  expect(
    await getScheduledNotificationContext(client.db, {
      ...scope,
      sessionId: other.scope.sessionId,
    }),
  ).toBeNull();
}, 120_000);

test.each(
  ([[], ["workspace:read"], ["sessions:read", "sessions:control"]] as Permission[][]).map(
    (permissions) => ({ permissions }),
  ),
)(
  "old schedules with permissions %j notify their owner without changing their snapshot",
  async ({ permissions }) => {
    const f = await fixture({ permissions });
    expect(f.definitions.map((tool) => tool.identity.toolName)).toEqual(["notify_user"]);
    expect(await f.notify({ title: "Blocked", key: "blocker" })).toMatchObject({
      delivered: true,
      updatedInPlace: false,
    });
    expect(await f.notify({ title: "Still blocked", key: "blocker" })).toMatchObject({
      delivered: true,
      updatedInPlace: true,
    });
    expect((await f.inbox(f.owner)).map((item) => item.title)).toEqual(["Still blocked"]);
    const session = await getSession(client.db, f.scope.workspaceId, f.scope.sessionId);
    expect(session?.firstPartyMcpPermissions).toEqual(permissions);
    expect(session?.firstPartyMcpTools).not.toContain("notify_user");
    await expect(f.notify({ title: "Wrong recipient", recipient: f.other })).rejects.toThrow();
    expect(await f.inbox(f.other)).toEqual([]);
  },
  120_000,
);

test("an existing chat reaches the schedule owner, never the chat creator", async () => {
  const f = await fixture({ existing: true });
  expect(await f.notify({ title: "Needs attention" })).toMatchObject({ delivered: true });
  expect(await f.inbox(f.owner)).toHaveLength(1);
  expect(await f.inbox(f.other)).toEqual([]);
}, 120_000);

test("a reusable schedule retains owner notification", async () => {
  const f = await fixture({ reusable: true });
  expect(await f.notify({ title: "Ready" })).toMatchObject({ delivered: true });
}, 120_000);

test("ownerless schedules disclose the missing recipient before any call", async () => {
  const f = await fixture({ ownerless: true, existing: true });
  expect(f.definitions[0]!.description).toContain("no human inbox recipient");
  expect(await f.notify({ title: "Cannot deliver" })).toMatchObject({
    delivered: false,
    undeliveredReason: "no_human_recipient",
  });
  expect(await f.inbox(f.other)).toEqual([]);
  expect(await f.inbox(f.owner)).toEqual([]);
}, 120_000);

test("zero-permission tools survive runtime preparation and appear in the attempt catalog", async () => {
  const f = await fixture();
  const prepared = await prepareAgentTools(f.settings, [], {
    ...f.scope,
    firstPartyPermissions: [],
    firstPartyTools: [],
    attemptToolDefinitions: f.definitions,
  });
  try {
    const ready = (await prepared.ready) ?? prepared;
    expect(
      ready.attemptToolEnvironment?.catalog.entries.some(
        (tool) => tool.identity.toolName === "notify_user",
      ),
    ).toBe(true);
    const result = await ready.attemptToolEnvironment!.callModel({
      modelName: "notify_user",
      arguments: { title: "Runtime call" },
      subjectId: "worker",
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      delivered: true,
    });
  } finally {
    await prepared.close();
  }
}, 120_000);

test("cross-session and stale-attempt calls cannot post", async () => {
  const f = await fixture();
  const other = await fixture();
  expect(
    await getScheduledNotificationContext(client.db, { ...f.scope, turnId: other.scope.turnId }),
  ).toBeNull();
  const stale = await createScheduledNotificationTools({
    db: client.db,
    bus: f.bus,
    scope: { ...f.scope, attemptId: crypto.randomUUID() },
  });
  await expect(
    stale[0]!.execute(
      { title: "Stale" },
      { operationId: crypto.randomUUID(), caller: { kind: "model", subjectId: "worker" } },
    ),
  ).rejects.toThrow("active attempt");
  expect(
    (await listSessionEvents(client.db, f.scope.workspaceId, f.scope.sessionId)).filter(
      (event) => event.type === "session.notification.posted",
    ),
  ).toEqual([]);
}, 120_000);
