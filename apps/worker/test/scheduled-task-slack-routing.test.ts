import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  CreateScheduledTaskRequest,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  UpdateScheduledTaskRequest,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  createValidatedScheduledTask,
  validatedScheduledTaskUpdate,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import {
  createConnection,
  createDb,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  getSession,
  listScheduledTaskRuns,
  listSessionEvents,
  revokeConnection,
  recordUsageEvent,
  updateScheduledTask,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

type SlackBotIdentity = {
  slackTeamId: string;
  slackTeamName: string;
  botUserId: string;
  botId: string;
};

function slackBotIdentity(slackTeamName = "Scheduled test workspace"): SlackBotIdentity {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  return {
    slackTeamId: `T${suffix}`,
    slackTeamName,
    botUserId: `U${suffix}`,
    botId: `B${suffix}`,
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-slack-routing");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-slack-routing] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function workspaceFixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('worker scheduled Slack bot') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'worker scheduled Slack bot') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    slackBotIdentity: slackBotIdentity(),
  };
}

async function botConnection(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  identity = workspace.slackBotIdentity,
) {
  const connection = await createConnection(client.db, {
    ...workspace,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: randomBytes(48).toString("base64"),
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    verifiedInstallAt: new Date(0),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      ...identity,
      botDisplayName: "OpenGeni",
      verifiedAt: new Date(0).toISOString(),
    },
    createdBySubjectId: "subject-a",
  });
  return { connection, identity };
}

async function personalSlackConnection(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  subjectId = "subject-a",
) {
  return await createConnection(client.db, {
    ...workspace,
    subjectId,
    providerDomain: "slack.com",
    kind: "oauth2",
    credentialEncrypted: "fixture-personal-slack",
    metadata: { mcpUrl: "https://mcp.slack.com/mcp" },
    createdBySubjectId: subjectId,
  });
}

function activities(settings: Parameters<typeof testSettings>[0] = {}) {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({
          databaseUrl: shared!.appUrl,
          sandboxBackend: "none",
          ...settings,
        }),
        db: client.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

async function taskFixture(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  connectionId: string,
  runMode: "new_session_per_run" | "reusable_session",
  slackBotChannelId?: string,
) {
  return await createScheduledTask(client.db, {
    ...workspace,
    name: `scheduled Slack routing ${runMode}`,
    status: "active",
    schedule: { type: "interval", everySeconds: 3_600 },
    temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
    runMode,
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Use the explicitly selected OpenGeni Slack bot",
      resources: [],
      tools: [],
      metadata: {},
      slackBotConnectionId: connectionId,
      ...(slackBotChannelId ? { slackBotChannelId } : {}),
    },
    metadata: {},
  });
}

describe("scheduled OpenGeni Slack bot routing", () => {
  test("binds the exact connection with safe creation evidence and revalidates revocation", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection, identity } = await botConnection(workspace);
    const task = await taskFixture(workspace, connection.id, "new_session_per_run");
    const worker = activities();

    const first = await worker.dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `slack-routing-${crypto.randomUUID()}`,
    });
    expect(first.action).toBe("start");
    const session = await getSession(client.db, workspace.workspaceId, first.sessionId);
    expect(session?.metadata[OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]).toBe(connection.id);

    const events = await listSessionEvents(
      client.db,
      workspace.workspaceId,
      first.sessionId,
      0,
      20,
    );
    const created = events.find((event) => event.type === "session.created");
    const payload = created?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({
      slackBotConnection: {
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
        connectionId: connection.id,
        slackTeamId: identity.slackTeamId,
      },
    });
    expect(
      Object.keys((payload?.slackBotConnection ?? {}) as Record<string, unknown>).sort(),
    ).toEqual(["connectionId", "credentialLabel", "credentialRole", "slackTeamId"]);

    await revokeConnection(client.db, workspace.workspaceId, connection.id, "subject-a");
    await expect(
      worker.dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `slack-routing-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow("not active (revoked)");
    expect(await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10)).toHaveLength(
      1,
    );
  });

  test("only a task with a person-chosen channel gets the two bot posting tools", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection } = await botConnection(workspace);
    const worker = activities();
    const dispatch = async (taskId: string) => {
      const run = await worker.dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId,
        triggerType: "scheduled",
        producerKey: `slack-routing-${crypto.randomUUID()}`,
      });
      expect(run.action).toBe("start");
      if (run.action !== "start") throw new Error("expected a started run");
      return (await getSession(client.db, workspace.workspaceId, run.sessionId))!;
    };

    const posting = await dispatch(
      (await taskFixture(workspace, connection.id, "new_session_per_run", "C0SCHED01")).id,
    );
    expect(posting.firstPartyMcpTools).toEqual(
      expect.arrayContaining(["slack_bot_prepare_message", "slack_bot_send_prepared_message"]),
    );
    expect(posting.firstPartyMcpTools).not.toContain("slack_bot_post_message");
    expect(posting.firstPartyMcpTools).not.toContain("slack_bot_list_channels");

    const readOnly = await dispatch(
      (await taskFixture(workspace, connection.id, "new_session_per_run")).id,
    );
    expect(readOnly.firstPartyMcpTools).not.toContain("slack_bot_prepare_message");
    expect(readOnly.firstPartyMcpTools).not.toContain("slack_bot_send_prepared_message");
    expect([...posting.firstPartyMcpTools!].sort()).toEqual(
      [
        ...readOnly.firstPartyMcpTools!,
        "slack_bot_prepare_message",
        "slack_bot_send_prepared_message",
      ].sort(),
    );

    // An operator who disallows the posting tools keeps them off.
    const ceilingTask = await taskFixture(
      workspace,
      connection.id,
      "new_session_per_run",
      "C0SCHED01",
    );
    const capped = await activities({
      allowedFirstPartyMcpTools: readOnly.firstPartyMcpTools!,
    }).dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: ceilingTask.id,
      triggerType: "scheduled",
      producerKey: `slack-routing-${crypto.randomUUID()}`,
    });
    if (capped.action !== "start") throw new Error("expected a started run");
    const cappedSession = await getSession(client.db, workspace.workspaceId, capped.sessionId);
    expect(cappedSession?.firstPartyMcpTools).not.toContain("slack_bot_prepare_message");
  });

  test("a person fixes the channel at setup; later edits keep it and an agent cannot choose one", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection } = await botConnection(workspace);
    const settings = testSettings({ sandboxBackend: "none" });
    const permissions: Permission[] = [
      "scheduled_tasks:manage",
      "scheduled_tasks:run",
      "connections:read",
      "connections:write",
    ];
    const personGrant: AccessGrant = {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      permissions,
      principalKind: "human_session",
      metadata: {},
    };
    const person: AccessGrantAuthorization = {
      grant: personGrant,
      accountGrant: null,
      authenticatedSubjectId: "subject-a",
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
      canonicalLocalHumanSession: false,
    };
    const verified: { connectionId: string; channelId: string }[] = [];
    const verifySlackChannel = async (input: { connectionId: string; channelId: string }) => {
      verified.push(input);
    };
    const task = await createValidatedScheduledTask({
      settings,
      db: client.db,
      objectStorage: null,
      grant: personGrant,
      authorization: person,
      toolsProvided: true,
      verifySlackChannel,
      payload: CreateScheduledTaskRequest.parse({
        name: "daily Slack summary",
        schedule: { type: "manual" },
        agentConfig: {
          prompt: "Post the daily summary",
          tools: [],
          slackBotConnectionId: connection.id,
          slackBotChannelId: "C0SCHED01",
        },
      }),
    });
    expect(task.agentConfig.slackBotChannelId).toBe("C0SCHED01");
    expect(verified).toEqual([{ connectionId: connection.id, channelId: "C0SCHED01" }]);

    // Editing other fields keeps the channel without a new check. A live agent
    // attempt choosing a channel is refused before anything is verified.
    const agentGrant: AccessGrant = {
      ...personGrant,
      subjectId: "worker:first-party-mcp",
      principalKind: "agent_attempt",
      metadata: { sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() },
    };
    const kept = await validatedScheduledTaskUpdate({
      settings,
      db: client.db,
      objectStorage: null,
      grant: personGrant,
      existing: task,
      toolsProvided: true,
      payload: UpdateScheduledTaskRequest.parse({
        agentConfig: { ...task.agentConfig, prompt: "Post a shorter summary" },
      }),
    });
    expect(kept.agentConfig?.slackBotChannelId).toBe("C0SCHED01");
    await expect(
      validatedScheduledTaskUpdate({
        settings,
        db: client.db,
        objectStorage: null,
        grant: agentGrant,
        existing: task,
        toolsProvided: true,
        verifySlackChannel,
        payload: UpdateScheduledTaskRequest.parse({
          agentConfig: { ...task.agentConfig, slackBotChannelId: "C0OTHER01" },
        }),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createValidatedScheduledTask({
        settings,
        db: client.db,
        objectStorage: null,
        grant: agentGrant,
        toolsProvided: true,
        verifySlackChannel,
        payload: CreateScheduledTaskRequest.parse({
          name: "agent-chosen channel",
          schedule: { type: "manual" },
          agentConfig: {
            prompt: "Post somewhere",
            tools: [],
            slackBotConnectionId: connection.id,
            slackBotChannelId: "C0OTHER01",
          },
        }),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(verified).toHaveLength(1);

    expect(
      (await getScheduledTask(client.db, workspace.workspaceId, task.id))?.agentConfig,
    ).toMatchObject({ slackBotConnectionId: connection.id, slackBotChannelId: "C0SCHED01" });
  });

  test("a person can always stop a reusable chat's posts, and restart them only where the chat can post", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection } = await botConnection(workspace);
    const settings = testSettings({ sandboxBackend: "none" });
    const personGrant: AccessGrant = {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      permissions: ["scheduled_tasks:manage", "connections:read", "connections:write"],
      principalKind: "human_session",
      metadata: {},
    };
    const person: AccessGrantAuthorization = {
      grant: personGrant,
      accountGrant: null,
      authenticatedSubjectId: "subject-a",
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
      canonicalLocalHumanSession: false,
    };
    const verifySlackChannel = async () => undefined;
    const worker = activities();
    const materialize = async (slackBotChannelId?: string) => {
      const task = await taskFixture(
        workspace,
        connection.id,
        "reusable_session",
        slackBotChannelId,
      );
      const run = await worker.dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `slack-routing-${crypto.randomUUID()}`,
      });
      expect(run.action).toBe("start");
      const live = (await getScheduledTask(client.db, workspace.workspaceId, task.id))!;
      expect(live.reusableSessionId).not.toBeNull();
      return live;
    };
    const update = (existing: Awaited<ReturnType<typeof materialize>>, channel?: string) => {
      const agentConfig = { ...existing.agentConfig };
      delete agentConfig.slackBotChannelId;
      return validatedScheduledTaskUpdate({
        settings,
        db: client.db,
        objectStorage: null,
        grant: personGrant,
        authorization: person,
        existing,
        toolsProvided: true,
        verifySlackChannel,
        payload: UpdateScheduledTaskRequest.parse({
          agentConfig: { ...agentConfig, ...(channel ? { slackBotChannelId: channel } : {}) },
        }),
      });
    };

    // The chat was created with the posting tools: clearing the channel is the
    // safe direction and never needs the task to be recreated.
    const posting = await materialize("C0SCHED01");
    const cleared = await update(posting);
    expect(cleared.agentConfig).not.toHaveProperty("slackBotChannelId");
    await updateScheduledTask(client.db, workspace.workspaceId, posting.id, cleared);
    const off = (await getScheduledTask(client.db, workspace.workspaceId, posting.id))!;
    // That chat still has the tools, so a person can turn posting back on.
    expect((await update(off, "C0OTHER01")).agentConfig?.slackBotChannelId).toBe("C0OTHER01");

    // A chat created without the tools cannot start posting.
    const silent = await materialize();
    await expect(update(silent, "C0SCHED01")).rejects.toMatchObject({ status: 409 });
  });

  test("rejects personal and cross-workspace connection IDs for scheduled shared-bot routing", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const personal = await personalSlackConnection(workspace);
    const personalTask = await taskFixture(workspace, personal.id, "new_session_per_run");
    const worker = activities();
    await expect(
      worker.dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: personalTask.id,
        triggerType: "scheduled",
        producerKey: `slack-routing-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow("OpenGeni Slack bot connection");

    const otherWorkspace = await workspaceFixture();
    const { connection: otherBot } = await botConnection(otherWorkspace);
    const crossWorkspaceTask = await taskFixture(workspace, otherBot.id, "new_session_per_run");
    await expect(
      worker.dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: crossWorkspaceTask.id,
        triggerType: "scheduled",
        producerKey: `slack-routing-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow("OpenGeni Slack bot connection");
  });

  test("a new bot installation never silently rebinds an existing scheduled task", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection: original } = await botConnection(workspace);
    const task = await taskFixture(workspace, original.id, "new_session_per_run");
    const { connection: separate } = await botConnection(
      workspace,
      slackBotIdentity("Separate scheduled test workspace"),
    );
    expect(separate.id).not.toBe(original.id);

    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `slack-routing-${crypto.randomUUID()}`,
    });
    expect(dispatched.action).toBe("start");
    const session = await getSession(client.db, workspace.workspaceId, dispatched.sessionId);
    expect(session?.metadata[OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]).toBe(original.id);
    expect(session?.metadata[OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]).not.toBe(separate.id);
  });

  test("fails a reusable run when the durable task and session bindings diverge", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection } = await botConnection(workspace);
    const task = await taskFixture(workspace, connection.id, "reusable_session");
    const worker = activities();

    const first = await worker.dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `slack-routing-${crypto.randomUUID()}`,
    });
    expect(first.action).toBe("start");

    const unboundAgentConfig = { ...task.agentConfig };
    delete unboundAgentConfig.slackBotConnectionId;
    await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
      agentConfig: unboundAgentConfig,
    });
    // A diverged binding is a deterministic terminal outcome for that
    // occurrence: no retry loop, no delivery into the wrong session.
    expect(
      await worker.dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `slack-routing-${crypto.randomUUID()}`,
      }),
    ).toEqual({ action: "blocked", reason: "scheduled_run_terminal" });

    const runs = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    expect(runs.map((run) => run.status).sort()).toEqual(["dispatched", "failed"]);
    expect(runs.find((run) => run.status === "failed")?.error).toBe(
      "scheduled_reusable_binding_changed",
    );
  });

  test("completes an already-fired workflow after its task was deleted", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection } = await botConnection(workspace);
    const task = await taskFixture(workspace, connection.id, "new_session_per_run");
    await deleteScheduledTask(client.db, workspace.workspaceId, task.id);

    expect(
      await activities().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `slack-routing-${crypto.randomUUID()}`,
      }),
    ).toEqual({ action: "deleted" });
  });

  test("settles a replayed malformed manual trigger before usage or task lookup", async () => {
    if (!available) return;
    expect(
      await activities().dispatchScheduledTaskRun({
        workspaceId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        triggerType: "manual",
        agentRunUsageIdempotencyKey: "historical-missing-initiator",
      } as never),
    ).toEqual({ action: "blocked", reason: "malformed_manual_trigger" });
  });

  test("manual dispatch reuses the API charge identity without an idempotency conflict", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection } = await botConnection(workspace);
    const task = await taskFixture(workspace, connection.id, "new_session_per_run");
    const idempotencyKey = `manual-trigger-${crypto.randomUUID()}`;
    const initiator = { kind: "subject" as const, subjectId: "subject-a" };
    await recordUsageEvent(client.db, {
      ...workspace,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "scheduled_task",
      sourceResourceId: task.id,
      initiator,
      idempotencyKey,
    });

    const result = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "manual",
      agentRunUsageIdempotencyKey: idempotencyKey,
      initiator,
    });
    expect(result.action).toBe("start");
  });

  test("settles a permanently blocked schedule occurrence instead of retrying forever", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const { connection } = await botConnection(workspace);
    const task = await taskFixture(workspace, connection.id, "new_session_per_run");

    expect(
      await activities({
        billingMode: "stripe",
        usageLimitsMode: "managed",
      }).dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `slack-routing-${crypto.randomUUID()}`,
      }),
    ).toEqual({ action: "blocked", reason: "insufficient_credits" });
  });
});
