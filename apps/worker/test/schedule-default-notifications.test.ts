import { afterAll, beforeAll, expect, test } from "bun:test";
import { type AccessGrant, type FirstPartyMcpToolName, type Permission } from "@opengeni/contracts";
import { requirePermission } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createSession,
  getScheduledTaskCreatorPolicy,
  getScheduledTaskRunAcceptedExecution,
  getSession,
  initializeSessionStartAtomically,
  listInboxItems,
  listScheduledTaskRuns,
  getSessionInboxRecipient,
  registerNativePushDevice,
  type SessionCommandActor,
} from "@opengeni/db";
import {
  acquireOwnerMigratedTestDatabase,
  MemoryEventBus,
  testSettings,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../../../packages/db/src/migrate";
import { provisionRoles } from "../../../packages/db/src/provision-roles";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanExactLoginBindingForAuthUser,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "../../../packages/db/src/canonical-human-identities";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import { registerNotificationTools } from "../../api/src/mcp/notification-tools";
import type { ActivityServices } from "../src/activities/types";

let owned: OwnerMigratedTestDatabase;
let client: ReturnType<typeof createDb>;
let appUrl: string;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("schedule-default-notifications");
  if (!acquired) throw new Error("PostgreSQL is required");
  owned = acquired;
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const url = new URL(owned.ownerUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  appUrl = url.toString();
  client = createDb(appUrl, { max: 4, searchPath: "public", rlsStrategy: "force" });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 60_000);

async function fixture(
  options: {
    tools?: FirstPartyMcpToolName[] | null;
    intent?: "workspace_default" | "explicit";
    runMode?: "existing_session" | "reusable_session" | "new_session_per_run";
    ownerless?: boolean;
    permissions?: Permission[];
  } = {},
) {
  const owner = `user:${crypto.randomUUID()}`;
  const other = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "schedule-default-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Test",
    workspaceExternalSource: "schedule-default-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Team",
    subjectId: owner,
  });
  const accountId = access.defaultAccountId!;
  const workspaceId = access.defaultWorkspaceId!;
  for (const subject of [owner, other]) {
    const [personal] =
      await owned.admin`insert into workspaces (account_id,name) values (${accountId},'Personal') returning id`;
    await owned.admin`insert into organization_memberships (account_id,subject_id,status,personal_workspace_id)
      values (${accountId},${subject},'active',${personal!.id})`;
  }
  await owned.admin`insert into workspace_memberships (account_id,workspace_id,subject_id,permissions)
    values (${accountId},${workspaceId},${other},'["sessions:read"]')`;
  const permissions = options.permissions ?? ["sessions:read", "sessions:control"];
  const makeSession = (subjectId: string, intent: "workspace_default" | "explicit") =>
    createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      firstPartyMcpTools: ["set_session_title"],
      firstPartyMcpPermissions: permissions,
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null, firstPartyMode: intent },
      createdBy: { kind: "subject", subjectId },
    });
  const source = await makeSession(owner, options.intent ?? "workspace_default");
  await initializeSessionStartAtomically(client.db, {
    accountId,
    workspaceId,
    sessionId: source.id,
    clientEventId: crypto.randomUUID(),
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const sourceAttemptId = crypto.randomUUID();
  const sourceClaim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: source.id,
    workflowId: `session-${source.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: sourceAttemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (sourceClaim.action !== "claimed") throw new Error("source claim failed");
  const actor: SessionCommandActor = {
    type: "agent_attempt",
    sessionId: source.id,
    turnId: sourceClaim.turn.id,
    attemptId: sourceAttemptId,
    executionGeneration: sourceClaim.turn.executionGeneration,
  };
  const target =
    options.runMode === "existing_session" ? await makeSession(other, "workspace_default") : null;
  const task = await createScheduledTask(client.db, {
    accountId,
    workspaceId,
    createdBy: options.ownerless
      ? { kind: "service", subjectId: "test-scheduler" }
      : { kind: "subject", subjectId: owner },
    ...(!options.ownerless ? { createdByActor: actor } : {}),
    name: "Check progress",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `test-${crypto.randomUUID()}`,
    runMode: options.runMode ?? "new_session_per_run",
    ...(target ? { targetSessionId: target.id } : {}),
    overlapPolicy: "allow_concurrent",
    metadata: {},
    agentConfig: {
      prompt: "Check progress",
      model: "scripted-model",
      tools: [],
      resources: [],
      metadata: {},
    },
    creatorPolicy: {
      firstPartyMcpTools: options.tools === undefined ? null : options.tools,
      firstPartyMcpPermissions: permissions,
      sessionPolicy: null,
    },
  });
  const bus = new MemoryEventBus();
  const settings = testSettings({ databaseUrl: appUrl, sandboxBackend: "none" });
  const activities = createScheduledTaskActivities(
    async () => ({ settings, db: client.db, bus }) as unknown as ActivityServices,
  );
  async function dispatch() {
    const producerKey = crypto.randomUUID();
    const input = { workspaceId, taskId: task.id, triggerType: "scheduled" as const, producerKey };
    const result = await activities.dispatchScheduledTaskRun(input);
    if (result.action !== "start" && result.action !== "signal") {
      throw new Error(
        JSON.stringify({
          result,
          runs: await listScheduledTaskRuns(client.db, workspaceId, task.id, 1),
        }),
      );
    }
    const [run] = await listScheduledTaskRuns(client.db, workspaceId, task.id, 1);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId,
      runId: run!.id,
    });
    const session = await getSession(client.db, workspaceId, result.sessionId);
    return { result, run: run!, accepted: accepted!, session: session!, input };
  }
  async function notifier(result: Awaited<ReturnType<typeof dispatch>>["result"]) {
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: result.sessionId,
      workflowId: result.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(JSON.stringify(claim));
    type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
    const handlers = new Map<string, Handler>();
    const grant: AccessGrant = {
      ...access.workspaceGrants[0]!,
      permissions,
      permissionMode: "explicit",
    };
    registerNotificationTools({
      server: {
        registerTool: (name: string, _schema: unknown, handler: Handler) =>
          handlers.set(name, handler),
      } as never,
      deps: { db: client.db, bus } as never,
      grant,
      sessionId: result.sessionId,
      authorize: async () => {
        requirePermission(grant, "sessions:control");
      },
      attempt: () => ({
        callerTurnId: claim.turn.id,
        callerAttemptId: attemptId,
        callerExecutionGeneration: claim.turn.executionGeneration,
      }),
      json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    });
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(
        (await handlers.get(name)!({ message: "", urgency: "normal", ...args })).content[0]!.text,
      );
    return { call, claim };
  }
  const inbox = (subjectId: string) => listInboxItems(client.db, { accountId, subjectId });
  return {
    accountId,
    workspaceId,
    owner,
    other,
    source,
    task,
    dispatch,
    notifier,
    inbox,
    settings,
    activities,
  };
}

test("default tools remain live on generated reusable chats; accepted occurrences stay frozen", async () => {
  const f = await fixture({ runMode: "reusable_session" });
  const first = await f.dispatch();
  expect(first.accepted.resolvedFirstPartyMcpTools).toContain("notify_user");
  expect(first.session.toolPolicy.firstPartyMode).toBe("workspace_default");
  expect(first.session.firstPartyMcpPermissions).toEqual(["sessions:read", "sessions:control"]);
  await owned.admin`update workspaces set settings = settings || '{"sessionToolDefaults":{"firstPartyMcpTools":["set_session_title"]}}'::jsonb where id = ${f.workspaceId}`;
  const second = await f.dispatch();
  expect(second.session.id).toBe(first.session.id);
  expect(second.accepted.targetSessionExecution?.effectiveFirstPartyMcpTools).toEqual([
    "set_session_title",
  ]);
  expect(
    (
      await getScheduledTaskRunAcceptedExecution(client.db, {
        workspaceId: f.workspaceId,
        runId: first.run.id,
      })
    )?.resolvedFirstPartyMcpTools,
  ).toEqual(first.accepted.resolvedFirstPartyMcpTools);
});

test.each([
  { tools: ["set_session_title"] as FirstPartyMcpToolName[] },
  { tools: [] as FirstPartyMcpToolName[] },
])("explicit tools stay fixed: %j", async ({ tools }) => {
  const f = await fixture({ tools, intent: "explicit" });
  const run = await f.dispatch();
  expect(run.accepted.resolvedFirstPartyMcpTools).toEqual(tools);
  expect(run.session.toolPolicy.firstPartyMode).not.toBe("workspace_default");
});

async function registerPhone(subjectId: string) {
  const userId = subjectId.slice(5);
  await owned.admin`insert into auth_users (id,name,email,email_verified)
    values (${userId},'Owner',${`${userId}@example.test`},true)`;
  await owned.admin`insert into auth_identities (id,user_id,account_id,provider_id,created_at,updated_at)
    values (${crypto.randomUUID()},${userId},${userId},'credential',now(),now())`;
  await ensureCanonicalHumanIdentityForAuthUser(client.db, userId);
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = await getCanonicalHumanExactLoginBindingForAuthUser(client.db, {
    authUserId: userId,
    providerId: "credential",
  });
  const authSessionId = crypto.randomUUID();
  await owned.admin`insert into auth_sessions
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

test("ordinary notify_user in another person's chat reaches the scheduled turn initiator once", async () => {
  const f = await fixture({ runMode: "existing_session" });
  const run = await f.dispatch();
  const { call, claim } = await f.notifier(run.result);
  const phone = await registerPhone(f.owner);
  expect(claim.turn.initiatingHumanSubjectId).toBe(f.owner);
  expect(
    await getSessionInboxRecipient(client.db, f.workspaceId, run.session.id, claim.turn.id),
  ).toMatchObject({ subjectId: f.owner });
  expect(await call("notify_user", { title: "Blocked", key: "blocked" })).toMatchObject({
    delivered: true,
    updatedInPlace: false,
  });
  expect(await call("notify_user", { title: "Still blocked", key: "blocked" })).toMatchObject({
    delivered: true,
    updatedInPlace: true,
  });
  expect((await f.inbox(f.owner)).filter((i) => i.kind === "notification")).toHaveLength(1);
  expect(await f.inbox(f.other)).toEqual([]);
  const deliveries =
    await owned.admin`select payload from opengeni_private.native_push_deliveries where auth_session_id=${phone}`;
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.payload).toMatchObject({
    subjectId: f.owner,
    sessionId: run.session.id,
    rule: "agent",
  });
  await call("notification_withdraw", { key: "blocked" });
  expect((await f.inbox(f.owner)).filter((i) => i.kind === "notification")).toEqual([]);
});

test("a turn without a human does not fall back to the destination chat creator", async () => {
  const f = await fixture({ ownerless: true, runMode: "existing_session" });
  const run = await f.dispatch();
  const { call } = await f.notifier(run.result);
  expect(await call("notify_user", { title: "Ready" })).toMatchObject({
    delivered: false,
    undeliveredReason: "no_human_recipient",
  });
  expect(await f.inbox(f.other)).toEqual([]);
});

test("tool intent does not grant notification permission", async () => {
  const f = await fixture({ permissions: ["sessions:read"] });
  const { call } = await f.notifier((await f.dispatch()).result);
  await expect(call("notify_user", { title: "Ready" })).rejects.toThrow();
});

test("legacy repair restores proven default intent, preserves explicit/empty choices, and repairs an untouched reusable chat", async () => {
  const defaults = await fixture({ tools: ["set_session_title"], runMode: "reusable_session" });
  const explicit = await fixture({ tools: ["set_session_title"], intent: "explicit" });
  const empty = await fixture({ tools: [] });
  const oldRun = await defaults.dispatch();
  const source = await Bun.file(
    new URL(
      "../../../packages/db/drizzle/0832_schedule_defaults_and_turn_notifications.sql",
      import.meta.url,
    ),
  ).text();
  const repair = source.slice(
    source.indexOf("SET LOCAL opengeni.session_variable_set_attachments_v1"),
  );
  const postgres = (await import("postgres")).default;
  const owner = postgres(owned.ownerUrl, { max: 1 });
  try {
    await owner.begin(async (tx) => {
      await tx.unsafe(repair);
    });
  } finally {
    await owner.end();
  }
  expect(
    (await getScheduledTaskCreatorPolicy(client.db, defaults.workspaceId, defaults.task.id))
      ?.firstPartyMcpTools,
  ).toBeNull();
  expect(
    (await getScheduledTaskCreatorPolicy(client.db, explicit.workspaceId, explicit.task.id))
      ?.firstPartyMcpTools,
  ).toEqual(["set_session_title"]);
  expect(
    (await getScheduledTaskCreatorPolicy(client.db, empty.workspaceId, empty.task.id))
      ?.firstPartyMcpTools,
  ).toEqual([]);
  expect(
    (await getSession(client.db, defaults.workspaceId, oldRun.session.id))?.toolPolicy
      .firstPartyMode,
  ).toBe("workspace_default");
  expect(
    (await defaults.dispatch()).accepted.targetSessionExecution?.effectiveFirstPartyMcpTools,
  ).toContain("notify_user");
});
