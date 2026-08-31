import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TurnExecutionPolicyV1 } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  createWorkspaceGatewayCustomModel,
  deleteWorkspaceGatewayCustomModel,
  getScheduledTaskRunAcceptedExecution,
  listSessions,
  listScheduledTaskRuns,
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
let client: DbClient;

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) {
    return await acquireSharedTestDatabase("worker-scheduled-model-catalog");
  }
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-model-catalog] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function waitForBlockedBackend(blockerPid: number, description: string): Promise<void> {
  if (!shared) throw new Error("scheduled-task model catalog fixture is unavailable");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin<Array<{ waiting: boolean }>>`
      select exists (
        select 1
        from pg_stat_activity activity
        where activity.datname = current_database()
          and activity.state = 'active'
          and activity.wait_event_type = 'Lock'
          and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      ) as waiting
    `;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`${description} did not block behind backend ${blockerPid}`);
}

function activities() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({
          databaseUrl: shared!.appUrl,
          sandboxBackend: "none",
        }),
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );
}

describe("scheduled-task model catalog retention (real PostgreSQL)", () => {
  test("keeps a retired custom Gateway model for an existing target session", async () => {
    if (!available) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `scheduled-model-account-${crypto.randomUUID()}`,
      accountName: "Scheduled model catalog account",
      workspaceExternalSource: "test",
      workspaceExternalId: `scheduled-model-workspace-${crypto.randomUUID()}`,
      workspaceName: "Scheduled model catalog workspace",
      subjectId: "user:scheduled-model-owner",
    });
    const grant = access.workspaceGrants[0]!;
    const upstreamModelId = "anthropic/claude-sonnet-4.6";
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const customModel = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      upstreamModelId,
      operationId: crypto.randomUUID(),
      requestHash: "1".repeat(64),
      createdBySubjectId: grant.subjectId,
    });
    if (!customModel) throw new Error("custom model create unexpectedly conflicted");
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Retired scheduled target model",
      resources: [],
      metadata: {},
      model: productModelId,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const task = await createScheduledTask(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      name: "Continue retired scheduled target",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-model-${crypto.randomUUID()}`,
      runMode: "existing_session",
      targetSessionId: session.id,
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Continue with the session's already accepted model",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    expect(
      await deleteWorkspaceGatewayCustomModel(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        customModelId: customModel.id,
        expectedVersion: customModel.version,
        operationId: crypto.randomUUID(),
        requestHash: "2".repeat(64),
      }),
    ).toMatchObject({ outcome: "success" });

    const result = await activities().dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `scheduled-model-${crypto.randomUUID()}`,
    });

    expect(result.action).toBe("signal");
    const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 10);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: grant.workspaceId,
      runId: run!.id,
    });
    expect(accepted?.targetSessionExecution?.model).toBe(productModelId);
    expect(TurnExecutionPolicyV1.parse(accepted?.turnExecutionPolicy)).toMatchObject({
      productModelId,
      modelSource: "session",
    });
  }, 60_000);

  test("rejects a fresh generated-session occurrence when custom-model retirement wins", async () => {
    if (!available) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `scheduled-model-race-account-${crypto.randomUUID()}`,
      accountName: "Scheduled model race account",
      workspaceExternalSource: "test",
      workspaceExternalId: `scheduled-model-race-workspace-${crypto.randomUUID()}`,
      workspaceName: "Scheduled model race workspace",
      subjectId: "user:scheduled-model-race-owner",
    });
    const grant = access.workspaceGrants[0]!;
    const upstreamModelId = `race/scheduled-occurrence-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const customModel = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      upstreamModelId,
      operationId: crypto.randomUUID(),
      requestHash: "3".repeat(64),
      createdBySubjectId: grant.subjectId,
    });
    if (!customModel) throw new Error("custom model create unexpectedly conflicted");
    const task = await createScheduledTask(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      name: "Fresh custom-model occurrence retirement race",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-model-race-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Run only while the selected custom model remains active",
        model: productModelId,
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const producerKey = `scheduled-model-race-${crypto.randomUUID()}`;
    let dispatchPromise: ReturnType<
      ReturnType<typeof activities>["dispatchScheduledTaskRun"]
    > | null = null;

    await shared!.admin.begin(async (barrier) => {
      const [backend] = await barrier<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("database barrier has no backend pid");
      await barrier`
        select pg_advisory_xact_lock(
          hashtextextended(${"workspace-gateway-custom-models:" + grant.workspaceId}, 0)
        )
      `;
      dispatchPromise = activities().dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey,
      });
      await waitForBlockedBackend(backend.pid, "fresh scheduled custom-model occurrence");
      await barrier`
        update workspace_gateway_custom_models
        set retired_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = ${customModel.id}::uuid
      `;
    });

    if (!dispatchPromise) throw new Error("scheduled occurrence dispatch was not started");
    expect(await dispatchPromise).toEqual({
      action: "blocked",
      reason: "scheduled_run_terminal",
    });
    expect(await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 10)).toHaveLength(0);
    expect(await listSessions(client.db, grant.workspaceId, 10)).toHaveLength(0);
  }, 60_000);

  test("replays an accepted generated-session occurrence after custom-model retirement", async () => {
    if (!available) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `scheduled-model-replay-account-${crypto.randomUUID()}`,
      accountName: "Scheduled model replay account",
      workspaceExternalSource: "test",
      workspaceExternalId: `scheduled-model-replay-workspace-${crypto.randomUUID()}`,
      workspaceName: "Scheduled model replay workspace",
      subjectId: "user:scheduled-model-replay-owner",
    });
    const grant = access.workspaceGrants[0]!;
    const upstreamModelId = `race/scheduled-replay-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const customModel = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      upstreamModelId,
      operationId: crypto.randomUUID(),
      requestHash: "4".repeat(64),
      createdBySubjectId: grant.subjectId,
    });
    if (!customModel) throw new Error("custom model create unexpectedly conflicted");
    const task = await createScheduledTask(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      name: "Accepted custom-model occurrence replay",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-model-replay-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Replay the already accepted occurrence",
        model: productModelId,
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const producerKey = `scheduled-model-replay-${crypto.randomUUID()}`;
    const scheduledActivities = activities();
    const first = await scheduledActivities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });
    expect(first.action).toBe("start");
    if (first.action !== "start") throw new Error("fresh scheduled occurrence was not accepted");

    expect(
      await deleteWorkspaceGatewayCustomModel(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        customModelId: customModel.id,
        expectedVersion: customModel.version,
        operationId: crypto.randomUUID(),
        requestHash: "5".repeat(64),
      }),
    ).toMatchObject({ outcome: "success" });

    const replay = await scheduledActivities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });
    expect(replay).toMatchObject({
      action: "start",
      sessionId: first.sessionId,
      triggerEventId: first.triggerEventId,
    });
    expect(await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 10)).toHaveLength(1);
  }, 60_000);
});
