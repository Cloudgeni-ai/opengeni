import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  type ScheduledTask,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdateWithSourceMutation,
  appendSessionEventsForTurnAttempt,
  applySessionTurnSettlement,
  bindScheduledTaskRunSessionInTransaction,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  getScheduledTargetSessionExecution,
  getScheduledTaskPersonalResourceAuthoritySubject,
  getScheduledTaskRevisionAuthority,
  getScheduledTaskRunAcceptedExecution,
  initializeSessionStartAtomically,
  listScheduledTaskAccessAttentionEvents,
  listScheduledTaskRunAuthNeededEvents,
  settleScheduledTaskRunInTransaction,
  submitHumanPromptInTransaction,
  updateScheduledTask,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-task-access-attention");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Fixture = Awaited<ReturnType<typeof idleSessionFixture>>;

async function idleSessionFixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "scheduled-access-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Scheduled access test",
    workspaceExternalSource: "scheduled-access-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Scheduled access test",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "start",
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const fixture = { grant, workspaceId, session };
  const initial = await claim(fixture);
  await settle(fixture, initial);
  return fixture;
}

async function claim(ctx: { workspaceId: string; session: { id: string } }) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, ctx.workspaceId, {
    sessionId: ctx.session.id,
    workflowId: `session-${ctx.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`expected a claim, got ${claimed.action}`);
  return { turn: claimed.turn, attemptId };
}

async function settle(
  ctx: { workspaceId: string; session: { id: string } },
  claimed: Awaited<ReturnType<typeof claim>>,
) {
  const settled = await applySessionTurnSettlement(client.db, ctx.workspaceId, {
    sessionId: ctx.session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

async function recordAuthNeeded(
  ctx: Fixture,
  claimed: Awaited<ReturnType<typeof claim>>,
  payloads: Record<string, unknown>[],
) {
  const appended = await appendSessionEventsForTurnAttempt(
    client.db,
    ctx.workspaceId,
    ctx.session.id,
    claimed.turn.id,
    claimed.turn.executionGeneration,
    claimed.attemptId,
    payloads.map((payload) => ({ type: "tool.auth_needed", payload })),
  );
  expect(appended.accepted).toBe(true);
}

async function scheduledTaskFor(ctx: Fixture, name = "Post the daily summary") {
  return await createScheduledTask(client.db, {
    accountId: ctx.grant.accountId,
    workspaceId: ctx.workspaceId,
    name,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-access-${crypto.randomUUID()}`,
    runMode: "existing_session",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "Post the summary", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    targetSessionId: ctx.session.id,
    metadata: {},
  });
}

/** Accept one occurrence exactly as the scheduler does, then run its turn. */
async function runOccurrence(ctx: Fixture, task: ScheduledTask) {
  const personalResourceAuthoritySubjectId = await getScheduledTaskPersonalResourceAuthoritySubject(
    client.db,
    {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
    },
  );
  const targetSessionExecution = await getScheduledTargetSessionExecution(
    client.db,
    task.workspaceId,
    ctx.session.id,
    personalResourceAuthoritySubjectId,
  );
  if (!targetSessionExecution) throw new Error("scheduled target execution is unavailable");
  const causalHumanAuthority = await getScheduledTaskRevisionAuthority(client.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
  });
  const runId = crypto.randomUUID();
  const run = await createScheduledTaskRun(client.db, {
    runId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
    taskExecutionDigest: task.executionDigest,
    triggerType: "scheduled",
    producerKey: `scheduled-access-run:${runId}`,
    acceptedExecutionSnapshot: {
      version: 1,
      task,
      resolvedModel: targetSessionExecution.model,
      resolvedReasoningEffort: targetSessionExecution.reasoningEffort,
      resolvedLatencyMode: targetSessionExecution.latencyMode,
      resolvedSandboxBackend: targetSessionExecution.sandboxBackend,
      resolvedSandboxOs: targetSessionExecution.sandboxOs,
      resolvedTools: targetSessionExecution.tools,
      resolvedFirstPartyMcpTools: targetSessionExecution.firstPartyMcpTools ?? [
        ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
      ],
      resolvedFirstPartyMcpPermissions: targetSessionExecution.firstPartyMcpPermissions ?? [
        ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
      ],
      resolvedVariableSet: null,
      resolvedRig: null,
      resolvedSlackBotConnection: null,
      targetSessionExecution,
      generatedSessionBinding: null,
      personalConnectionDelegations: [],
      personalResourceAuthoritySubjectId,
      causalHumanSubjectId:
        personalResourceAuthoritySubjectId ?? causalHumanAuthority?.subjectId ?? null,
      causalHumanAuthority,
      xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      claudeProviderAccountAuthoritySnapshot: { version: 1 as const, scope: "workspace" as const },
      claudeAuthoritySubjectId: null,
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: null,
      triggerInitiator: { kind: "service", subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    },
  });
  await bindScheduledTaskRunSessionInTransaction(client.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    runId: run.id,
    sessionId: ctx.session.id,
  });
  const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
    workspaceId: task.workspaceId,
    runId: run.id,
  });
  if (!accepted) throw new Error("scheduled run is missing its accepted execution");
  const added = await addSessionSystemUpdateWithSourceMutation(
    client.db,
    {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      sessionId: ctx.session.id,
      kind: "scheduled_occurrence",
      classification: "info",
      sourceId: run.id,
      dedupeKey: `scheduled-task-run:${run.id}`,
      summary: task.agentConfig.prompt,
      payload: {
        type: "scheduled_occurrence",
        text: task.agentConfig.prompt,
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
      },
      lineage: {
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
        causalHumanSubjectId: accepted.causalHumanSubjectId,
      },
      personalConnectionDelegations: accepted.personalConnectionDelegations,
      xaiProviderAccountAuthoritySnapshot: accepted.xaiProviderAccountAuthoritySnapshot,
      scheduledTaskRunId: run.id,
    },
    async (tx, wakeEventId) => {
      if (!wakeEventId) throw new Error("scheduled occurrence produced no wake event");
      await settleScheduledTaskRunInTransaction(tx, {
        workspaceId: task.workspaceId,
        runId: run.id,
        sessionId: ctx.session.id,
        triggerEventId: wakeEventId,
        status: "dispatched",
      });
    },
  );
  if (!added.added) throw new Error("scheduled occurrence was not inserted");
  const claimed = await claim(ctx);
  const [turn] = await shared.admin<{ scheduled_task_run_id: string | null }[]>`
    select scheduled_task_run_id from session_turns where id = ${claimed.turn.id}`;
  expect(turn?.scheduled_task_run_id).toBe(run.id);
  return { run, claimed };
}

const slackFailure = {
  serverId: "slack",
  providerDomain: "slack.com",
  reason: "personal_authority_unavailable",
  toolName: "slack_send_message",
};

describe("scheduled run access failures and the owner's attention list", () => {
  test("attributes only the run's own turn, and a later clean run clears the notice", async () => {
    const ctx = await idleSessionFixture();
    const task = await scheduledTaskFor(ctx);
    const first = await runOccurrence(ctx, task);
    await recordAuthNeeded(ctx, first.claimed, [slackFailure, slackFailure]);
    await settle(ctx, first.claimed);

    // A person's follow-up in the same session is not the scheduled run.
    await withWorkspaceSubjectRls(client.db, ctx.workspaceId, ctx.grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.workspaceId,
          sessionId: ctx.session.id,
          subjectId: ctx.grant.subjectId,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "why did you not post a slack message?",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const followUp = await claim(ctx);
    await recordAuthNeeded(ctx, followUp, [slackFailure]);
    await settle(ctx, followUp);

    const runEvents = await listScheduledTaskRunAuthNeededEvents(client.db, ctx.workspaceId, [
      first.run.id,
    ]);
    expect(runEvents.map((event) => event.runId)).toEqual([first.run.id, first.run.id]);
    expect(runEvents[0]!.payload).toMatchObject({
      serverId: "slack",
      reason: "personal_authority_unavailable",
    });

    // The task has no owner, so only people who manage schedules see it.
    const attention = await listScheduledTaskAccessAttentionEvents(client.db, ctx.workspaceId, {
      subjectId: ctx.grant.subjectId,
      includeOwnerless: true,
      taskLimit: 100,
    });
    expect(attention.map((event) => [event.taskId, event.taskName, event.runId])).toEqual([
      [task.id, "Post the daily summary", first.run.id],
      [task.id, "Post the daily summary", first.run.id],
    ]);
    expect(
      await listScheduledTaskAccessAttentionEvents(client.db, ctx.workspaceId, {
        subjectId: ctx.grant.subjectId,
        includeOwnerless: false,
        taskLimit: 100,
      }),
    ).toEqual([]);

    // A newer run whose turn could use every connector clears the notice.
    const second = await runOccurrence(ctx, task);
    await settle(ctx, second.claimed);
    expect(
      await listScheduledTaskAccessAttentionEvents(client.db, ctx.workspaceId, {
        subjectId: ctx.grant.subjectId,
        includeOwnerless: true,
        taskLimit: 100,
      }),
    ).toEqual([]);
    expect(
      await listScheduledTaskRunAuthNeededEvents(client.db, ctx.workspaceId, [second.run.id]),
    ).toEqual([]);
  }, 120_000);

  test("a paused schedule is not listed for attention", async () => {
    const ctx = await idleSessionFixture();
    const task = await scheduledTaskFor(ctx, "Paused digest");
    const run = await runOccurrence(ctx, task);
    await recordAuthNeeded(ctx, run.claimed, [slackFailure]);
    await settle(ctx, run.claimed);
    expect(
      (
        await listScheduledTaskAccessAttentionEvents(client.db, ctx.workspaceId, {
          subjectId: ctx.grant.subjectId,
          includeOwnerless: true,
          taskLimit: 100,
        })
      ).map((event) => event.taskId),
    ).toEqual([task.id]);
    await updateScheduledTask(client.db, ctx.workspaceId, task.id, { status: "paused" });
    expect(
      await listScheduledTaskAccessAttentionEvents(client.db, ctx.workspaceId, {
        subjectId: ctx.grant.subjectId,
        includeOwnerless: true,
        taskLimit: 100,
      }),
    ).toEqual([]);
  }, 120_000);
});
