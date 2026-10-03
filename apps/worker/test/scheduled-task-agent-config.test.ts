import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_FIRST_PARTY_MCP_TOOLS } from "@opengeni/contracts";
import { resolveFirstPartyMcpToolPolicy } from "@opengeni/config";
import {
  bootstrapWorkspace,
  bindScheduledTaskRunSessionInTransaction,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  getScheduledTaskRunAcceptedExecution,
  getSession,
  listScheduledTaskRuns,
  type DbClient,
  type ScheduledTaskCreatorPolicy,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-agent-config");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("scheduled-task agent config tests require real PostgreSQL");
    }
    available = false;
    console.warn("[worker-scheduled-agent-config] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

function activities(settingsOverrides: Parameters<typeof testSettings>[0] = {}) {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    sandboxBackend: "none",
    ...settingsOverrides,
  });
  return {
    settings,
    activities: createScheduledTaskActivities(
      async () =>
        ({
          settings,
          db: client.db,
          bus: new MemoryEventBus(),
          wakeSessionWorkflow: async () => undefined,
        }) as unknown as ActivityServices,
    ),
  };
}

async function workspaceGrant() {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scheduled-creator-account-${crypto.randomUUID()}`,
    accountName: "Scheduled creator policy account",
    workspaceExternalSource: "test",
    workspaceExternalId: `scheduled-creator-workspace-${crypto.randomUUID()}`,
    workspaceName: "Scheduled creator policy workspace",
    subjectId: "user:scheduled-creator-owner",
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared!.admin`insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Personal schedule fixture') returning id`;
  await shared!.admin`insert into organization_memberships
    (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'active', ${personal!.id})`;
  return grant;
}

async function generatedTask(
  grant: Awaited<ReturnType<typeof workspaceGrant>>,
  creatorPolicy: ScheduledTaskCreatorPolicy | null,
  agent?: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
) {
  return await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: "Generated session creator policy",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-creator-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Run with the creator's boundary",
      resources: [],
      tools: [],
      metadata,
      ...(agent ? { agent } : {}),
    } as never,
    metadata: {},
    creatorPolicy,
  });
}

async function dispatchGeneratedSession(
  grant: Awaited<ReturnType<typeof workspaceGrant>>,
  taskId: string,
  settingsOverrides: Parameters<typeof testSettings>[0] = {},
  producerKey = `scheduled-agent-${crypto.randomUUID()}`,
) {
  const { settings, activities: scheduled } = activities(settingsOverrides);
  const result = await scheduled.dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey,
  });
  if (result.action !== "start" && result.action !== "signal") {
    const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, taskId, 10);
    throw new Error(
      `unexpected dispatch result: ${JSON.stringify({ result, status: run?.status, error: run?.error })}`,
    );
  }
  const session = await getSession(client.db, grant.workspaceId, result.sessionId);
  if (!session) throw new Error("generated session missing");
  const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, taskId, 10);
  const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
    workspaceId: grant.workspaceId,
    runId: run!.id,
  });
  return { settings, session, accepted };
}

async function queuedAgentRun(
  grant: Awaited<ReturnType<typeof workspaceGrant>>,
  accepted: NonNullable<Awaited<ReturnType<typeof getScheduledTaskRunAcceptedExecution>>>,
) {
  const runId = crypto.randomUUID();
  const producerKey = `scheduled-agent-recovery-${crypto.randomUUID()}`;
  const snapshot = {
    ...accepted,
    generatedSessionBinding: {
      ...accepted.generatedSessionBinding!,
      createIdempotencyKey: `scheduled-task-run:${runId}`,
    },
  };
  const run = await createScheduledTaskRun(client.db, {
    runId,
    workspaceId: grant.workspaceId,
    taskId: accepted.task.id,
    taskAuthorityRevision: accepted.task.authorityRevision,
    taskExecutionDigest: accepted.task.executionDigest,
    triggerType: "scheduled",
    producerKey,
    acceptedExecutionSnapshot: snapshot,
  });
  return { run, producerKey, snapshot };
}

// Scheduled tasks carry `agentConfig.agent`; dispatch resolves it once, writes
// it through to the generated session and freezes it in the accepted execution.

describe("scheduled-task agent configuration (real PostgreSQL)", () => {
  test("a task without agent resolves all with the default generated tools", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, null);
    const { settings, session, accepted } = await dispatchGeneratedSession(grant, task.id);
    expect(session.agent).toMatchObject({ from: "all", source: "deployment_default" });
    expect(accepted?.resolvedAgentConfig).toEqual(session.agent!);
    expect(session.firstPartyMcpTools).toEqual(resolveFirstPartyMcpToolPolicy(settings).default);
  }, 60_000);

  test("a task agent resolves at dispatch, narrows the scheduled baseline and is frozen", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, null, {
      capabilities: { from: "none", goals: true },
      identity: "Nightly reporter",
    });
    const { session, accepted } = await dispatchGeneratedSession(grant, task.id);
    expect(session.agent).toMatchObject({
      from: "none",
      identity: "Nightly reporter",
      source: "request",
    });
    expect(accepted?.resolvedAgentConfig).toEqual(session.agent!);
    expect([...session.firstPartyMcpTools].sort()).toEqual(
      [
        "command_read",
        "command_wait",
        "goal_complete",
        "goal_pause",
        "goal_progress",
        "goal_resume",
        "goal_set",
        "goal_update",
        "set_session_title",
        "wait_for_input",
      ].filter((tool) => DEFAULT_FIRST_PARTY_MCP_TOOLS.includes(tool as never)),
    );
    expect(accepted?.resolvedFirstPartyMcpTools).toEqual(session.firstPartyMcpTools);
  }, 60_000);

  test("configured dispatch canonicalizes creation metadata and replays its frozen instructions", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const identityKey = "_opengeni_session_create_agent_config_v1";
    const task = await generatedTask(
      grant,
      null,
      {
        capabilities: { from: "none", goals: true },
        identity: "Original reporter",
        instructions: "Report only the accepted task.",
      },
      { purpose: "nightly", [identityKey]: { spoof: true } },
    );
    const producerKey = `scheduled-agent-${crypto.randomUUID()}`;
    const first = await dispatchGeneratedSession(grant, task.id, {}, producerKey);
    const { source: _source, ...identity } = first.session.agent!;
    expect(first.session.metadata[identityKey]).toEqual(identity);
    expect(first.session.metadata.purpose).toBe("nightly");
    expect(first.session.instructions).toBe("Report only the accepted task.");
    expect(first.accepted?.resolvedAgentInstructions).toBe(first.session.instructions!);
    expect(first.accepted?.resolvedAgentConfig).toEqual(first.session.agent!);

    await shared!.admin`update scheduled_tasks
      set agent_config = jsonb_set(agent_config, '{agent,identity}', '"Updated reporter"'::jsonb)
      where id = ${task.id}`;
    const replay = await dispatchGeneratedSession(grant, task.id, {}, producerKey);
    expect(replay.session.id).toBe(first.session.id);
    expect(replay.session.agent).toEqual(first.session.agent);
    expect(replay.session.instructions).toBe(first.session.instructions);
    expect(replay.accepted).toEqual(first.accepted);
  }, 60_000);

  test("queued recovery preserves the complete agent and instructions", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, null, {
      capabilities: "none",
      identity: "Scheduled report writer",
      instructions: "Return the synthetic fixture report.",
    });
    const { session, accepted } = await dispatchGeneratedSession(grant, task.id);
    expect(session.instructions).toBe("Return the synthetic fixture report.");
    expect(accepted?.resolvedAgentInstructions).toBe(session.instructions);
    const { producerKey } = await queuedAgentRun(grant, accepted!);
    const { activities: scheduled } = activities();
    const input = {
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled" as const,
      producerKey,
    };
    const recovered = await scheduled.dispatchScheduledTaskRun(input);
    expect(recovered.action).toBe("start");
    if (recovered.action !== "start") throw new Error("queued recovery did not start");
    const stored = await getSession(client.db, grant.workspaceId, recovered.sessionId);
    expect(stored?.agent).toEqual(accepted!.resolvedAgentConfig);
    expect(stored?.instructions).toBe(accepted!.resolvedAgentInstructions);
    expect(stored?.metadata._opengeni_session_create_agent_config_v1).toMatchObject({
      identity: "Scheduled report writer",
    });
    const replayed = await scheduled.dispatchScheduledTaskRun(input);
    expect(replayed).toMatchObject({
      action: "start",
      sessionId: recovered.sessionId,
      triggerEventId: recovered.triggerEventId,
    });
  }, 60_000);

  test("queued recovery rejects identity drift even when capabilities are unchanged", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, null, {
      capabilities: "none",
      identity: "Accepted report writer",
    });
    const { accepted } = await dispatchGeneratedSession(grant, task.id);
    const { run, producerKey, snapshot } = await queuedAgentRun(grant, accepted!);
    const binding = snapshot.generatedSessionBinding;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: task.agentConfig.prompt,
      resources: task.agentConfig.resources,
      tools: snapshot.resolvedTools,
      firstPartyMcpTools: snapshot.resolvedFirstPartyMcpTools,
      firstPartyMcpPermissions: snapshot.resolvedFirstPartyMcpPermissions,
      agentConfig: snapshot.resolvedAgentConfig,
      model: snapshot.resolvedModel,
      reasoningEffort: snapshot.resolvedReasoningEffort,
      latencyMode: snapshot.resolvedLatencyMode,
      sandboxBackend: "none",
      metadata: {
        model: snapshot.resolvedModel,
        reasoningEffort: snapshot.resolvedReasoningEffort,
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
        scheduledTaskRunMode: task.runMode,
      },
      createdBy: { kind: "service", subjectId: "scheduler", label: "OpenGeni scheduler" },
      createdByContext: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
      createIdempotencyKey: binding.createIdempotencyKey,
      maxNestedAgentDepthOverride: null,
      frozenNestedAgentDepthPolicy: {
        effectiveMaxNestedAgentDepth: binding.effectiveMaxNestedAgentDepth,
        nestedAgentDepthPolicySource: binding.nestedAgentDepthPolicySource,
      },
      frozenCodexCompactionMode: binding.codexCompactionMode,
      beforeCreateCommit: async (tx, sessionId) => {
        await bindScheduledTaskRunSessionInTransaction(tx, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          runId: run.id,
          sessionId,
        });
      },
    });
    await shared!.admin`update sessions
      set agent_config = jsonb_set(agent_config, '{identity}', '"Changed report writer"'::jsonb)
      where id = ${session.id}`;
    const { activities: scheduled } = activities();
    expect(
      await scheduled.dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey,
      }),
    ).toMatchObject({ action: "blocked", reason: "scheduled_run_terminal" });
    const runs = await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 10);
    expect(runs.find((value) => value.id === run.id)).toMatchObject({
      status: "failed",
      error: "scheduled_generated_session_changed",
    });
  }, 60_000);

  test("the execution digest covers agentConfig.agent", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, null, { capabilities: "all" });
    const [before] = await shared!.admin<{ execution_digest: string }[]>`
      select execution_digest from scheduled_tasks where id = ${task.id}`;
    await shared!.admin`update scheduled_tasks
      set agent_config = jsonb_set(agent_config, '{agent}', '{"capabilities": "none"}'::jsonb)
      where id = ${task.id}`;
    const [after] = await shared!.admin<{ execution_digest: string }[]>`
      select execution_digest from scheduled_tasks where id = ${task.id}`;
    expect(before?.execution_digest).toBeTruthy();
    expect(after?.execution_digest).not.toBe(before?.execution_digest);
  }, 60_000);
});
