import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bindScheduledTaskRunSessionInTransaction,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  failScheduledGeneratedSessionRoute,
  getNestedAgentDepthDeploymentPolicy,
  getScheduledTaskRunByProducerKey,
  listSessionEvents,
  requireSession,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-generated-route-failure");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "scheduled-generated-route-failure-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Scheduled route failure test",
    workspaceExternalSource: "scheduled-generated-route-failure-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Scheduled route failure test",
    subjectId: `user:creator-${suffix}`,
    subjectLabel: "Creator",
  });
  const grant = access.workspaceGrants[0]!;
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    name: "machine-targeted task",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-route-failure-${suffix}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Run on the selected machine",
      resources: [],
      tools: [],
      metadata: {},
    },
    createdBy: { kind: "service", subjectId: "scheduler" },
    metadata: {},
  });
  const depthPolicy = await getNestedAgentDepthDeploymentPolicy(client.db);
  const runId = crypto.randomUUID();
  const producerKey = `scheduled-route-failure:${runId}`;
  const acceptedExecution = {
    version: 1 as const,
    task,
    resolvedModel: "scripted-model",
    resolvedReasoningEffort: "medium" as const,
    resolvedLatencyMode: "standard" as const,
    resolvedSandboxBackend: "selfhosted" as const,
    resolvedSandboxOs: "linux" as const,
    resolvedTools: [],
    resolvedFirstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    resolvedFirstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
    resolvedVariableSet: null,
    resolvedRig: null,
    resolvedSlackBotConnection: null,
    targetSessionExecution: null,
    generatedSessionBinding: {
      createIdempotencyKey: `scheduled-task-run:${runId}`,
      effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
      nestedAgentDepthPolicySource: depthPolicy.policySource,
      codexCompactionMode: "portable" as const,
    },
    personalConnectionDelegations: [],
    personalResourceAuthoritySubjectId: null,
    causalHumanSubjectId: null,
    causalHumanAuthority: null,
    xaiProviderAccountAuthoritySnapshot: { version: 1 as const, scope: "workspace" as const },
    xaiAuthoritySubjectId: null,
    connectionAuthoritySubjectId: null,
    triggerInitiator: { kind: "service" as const, subjectId: "scheduler" },
    agentRunUsageIdempotencyKey: null,
    incidentPreflightRequired: false,
    alertOccurrenceLabels: null,
  };
  const run = await createScheduledTaskRun(client.db, {
    runId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
    taskExecutionDigest: task.executionDigest,
    triggerType: "scheduled",
    producerKey,
    acceptedExecutionSnapshot: acceptedExecution,
  });
  const session = await createSession(client.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    initialMessage: task.agentConfig.prompt,
    resources: [],
    tools: [],
    firstPartyMcpTools: acceptedExecution.resolvedFirstPartyMcpTools,
    firstPartyMcpPermissions: acceptedExecution.resolvedFirstPartyMcpPermissions,
    metadata: {
      model: acceptedExecution.resolvedModel,
      reasoningEffort: acceptedExecution.resolvedReasoningEffort,
      scheduledTaskId: task.id,
      scheduledTaskRunId: run.id,
      scheduledTaskRunMode: task.runMode,
    },
    createdBy: {
      kind: "service",
      subjectId: "scheduler",
      label: "OpenGeni scheduler",
    },
    createdByContext: {
      scheduledTaskId: task.id,
      scheduledTaskRunId: run.id,
    },
    model: acceptedExecution.resolvedModel,
    reasoningEffort: acceptedExecution.resolvedReasoningEffort,
    latencyMode: acceptedExecution.resolvedLatencyMode,
    sandboxBackend: acceptedExecution.resolvedSandboxBackend,
    sandboxOs: acceptedExecution.resolvedSandboxOs,
    initialXaiProviderAccountAuthoritySnapshot:
      acceptedExecution.xaiProviderAccountAuthoritySnapshot,
    maxNestedAgentDepthOverride: null,
    frozenNestedAgentDepthPolicy: {
      effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
      nestedAgentDepthPolicySource: depthPolicy.policySource,
    },
    frozenCodexCompactionMode: "portable",
    allowNestedAgentDepthIncrease: true,
    subjectId: `scheduled_task:${task.id}`,
    createIdempotencyKey: acceptedExecution.generatedSessionBinding.createIdempotencyKey,
  });
  await bindScheduledTaskRunSessionInTransaction(client.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    runId: run.id,
    sessionId: session.id,
  });
  return { task, run, session, producerKey };
}

describe("scheduled generated-session route failure", () => {
  test("fails the run and reclaims its unstarted generated session atomically", async () => {
    const { task, run, session, producerKey } = await fixture();
    const failed = await failScheduledGeneratedSessionRoute(client.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      sessionId: session.id,
      error: "scheduled_machine_unavailable",
    });

    expect(failed).toMatchObject({
      action: "failed",
      sessionReclaimed: true,
      error: "scheduled_machine_unavailable",
    });
    expect(failed.events).toHaveLength(1);
    expect(failed.events[0]).toMatchObject({
      type: "session.status.changed",
      payload: { status: "failed", code: "scheduled_machine_unavailable" },
    });
    expect((await requireSession(client.db, task.workspaceId, session.id)).status).toBe("failed");
    expect(
      await getScheduledTaskRunByProducerKey(client.db, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey,
      }),
    ).toMatchObject({ status: "failed", error: "scheduled_machine_unavailable" });
    expect(await listSessionEvents(client.db, task.workspaceId, session.id)).toEqual(failed.events);

    const replay = await failScheduledGeneratedSessionRoute(client.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      sessionId: session.id,
      error: "scheduled_machine_unavailable",
    });
    expect(replay).toMatchObject({
      action: "terminal",
      status: "failed",
      error: "scheduled_machine_unavailable",
      events: [],
    });
    expect(await listSessionEvents(client.db, task.workspaceId, session.id)).toHaveLength(1);
  });

  test("keeps a concurrent user cancellation while settling the run as a machine failure", async () => {
    const { task, run, session, producerKey } = await fixture();
    await withWorkspaceSessionActivityRls(client.db, task.workspaceId, async (tx) => {
      await tx
        .update(schema.sessions)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.workspaceId, task.workspaceId),
            eq(schema.sessions.id, session.id),
          ),
        );
    });

    const failed = await failScheduledGeneratedSessionRoute(client.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      sessionId: session.id,
      error: "scheduled_machine_unavailable",
    });
    expect(failed).toMatchObject({
      action: "failed",
      sessionReclaimed: false,
      error: "scheduled_machine_unavailable",
      events: [],
    });
    expect((await requireSession(client.db, task.workspaceId, session.id)).status).toBe(
      "cancelled",
    );
    expect(
      await getScheduledTaskRunByProducerKey(client.db, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey,
      }),
    ).toMatchObject({ status: "failed", error: "scheduled_machine_unavailable" });
  });
});
