import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TurnExecutionPolicyV1 } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  createWorkspaceGatewayCustomModel,
  deleteWorkspaceGatewayCustomModel,
  getScheduledTaskRunByProducerKey,
  getScheduledTaskRunAcceptedExecution,
  listSessions,
  listScheduledTaskRuns,
  lockActiveWorkspaceGatewayCustomModelForAdmission,
  type DbClient,
  updateScheduledTask,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

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
    if (requireRealDatabase) {
      throw new Error("scheduled-task model catalog tests require real PostgreSQL");
    }
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

async function waitForBackendBlockedBy(blockerPid: number, description: string): Promise<number> {
  if (!shared) throw new Error("scheduled-task model catalog fixture is unavailable");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin<Array<{ pid: number }>>`
      select activity.pid::int as pid
      from pg_stat_activity activity
      where activity.datname = current_database()
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      order by activity.pid
      limit 1
    `;
    if (row) return row.pid;
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

  test("orders fresh occurrence admission before the task row behind a queued retirement", async () => {
    if (!available) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `scheduled-model-lock-order-account-${crypto.randomUUID()}`,
      accountName: "Scheduled model lock order account",
      workspaceExternalSource: "test",
      workspaceExternalId: `scheduled-model-lock-order-workspace-${crypto.randomUUID()}`,
      workspaceName: "Scheduled model lock order workspace",
      subjectId: "user:scheduled-model-lock-order-owner",
    });
    const grant = access.workspaceGrants[0]!;
    const upstreamModelId = `race/scheduled-lock-order-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const customModel = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      upstreamModelId,
      operationId: crypto.randomUUID(),
      requestHash: "6".repeat(64),
      createdBySubjectId: grant.subjectId,
    });
    if (!customModel) throw new Error("custom model create unexpectedly conflicted");
    const task = await createScheduledTask(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      name: "Custom-model lock-order occurrence",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-model-lock-order-${crypto.randomUUID()}`,
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

    let releaseUpdate!: () => void;
    const updateRelease = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let markUpdateReady!: () => void;
    const updateReady = new Promise<void>((resolve) => {
      markUpdateReady = resolve;
    });
    let updateBackendPid: number | null = null;
    const updatePromise = updateScheduledTask(client.db, grant.workspaceId, task.id, {
      name: "Custom-model lock-order occurrence updated",
      beforeUpdateCommit: async (tx) => {
        const active = await lockActiveWorkspaceGatewayCustomModelForAdmission(tx, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          upstreamModelId,
        });
        if (!active) throw new Error("custom model disappeared before the lock-order fixture");
        const rows = await tx.execute(sql<{ pid: number }>`select pg_backend_pid()::int as pid`);
        updateBackendPid = rows[0]?.pid ?? null;
        if (!updateBackendPid) throw new Error("task updater has no backend pid");
        markUpdateReady();
        await updateRelease;
      },
    });

    try {
      await updateReady;
      const blockerPid = updateBackendPid;
      if (!blockerPid) throw new Error("task updater did not expose its backend pid");

      const retirementPromise = deleteWorkspaceGatewayCustomModel(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        customModelId: customModel.id,
        expectedVersion: customModel.version,
        operationId: crypto.randomUUID(),
        requestHash: "7".repeat(64),
      });
      const retirementBackendPid = await waitForBackendBlockedBy(
        blockerPid,
        "queued custom-model retirement",
      );

      const dispatchPromise = activities().dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `scheduled-model-lock-order-${crypto.randomUUID()}`,
      });
      await waitForBackendBlockedBy(
        retirementBackendPid,
        "fresh scheduled occurrence behind queued custom-model retirement",
      );

      releaseUpdate();
      const [updated, retired, dispatch] = await Promise.all([
        updatePromise,
        retirementPromise,
        dispatchPromise,
      ]);
      expect(updated.name).toBe("Custom-model lock-order occurrence updated");
      expect(retired).toMatchObject({ outcome: "success" });
      expect(dispatch).toEqual({
        action: "blocked",
        reason: "scheduled_run_terminal",
      });
      expect(await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 10)).toHaveLength(
        0,
      );
      expect(await listSessions(client.db, grant.workspaceId, 10)).toHaveLength(0);
    } finally {
      releaseUpdate();
      await updatePromise.catch(() => undefined);
    }
  }, 60_000);

  test("replays an overlapping producer accepted before retirement wins", async () => {
    if (!available) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `scheduled-model-overlap-account-${crypto.randomUUID()}`,
      accountName: "Scheduled model overlap account",
      workspaceExternalSource: "test",
      workspaceExternalId: `scheduled-model-overlap-workspace-${crypto.randomUUID()}`,
      workspaceName: "Scheduled model overlap workspace",
      subjectId: "user:scheduled-model-overlap-owner",
    });
    const grant = access.workspaceGrants[0]!;
    const upstreamModelId = `race/scheduled-overlap-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const customModel = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      upstreamModelId,
      operationId: crypto.randomUUID(),
      requestHash: "8".repeat(64),
      createdBySubjectId: grant.subjectId,
    });
    if (!customModel) throw new Error("custom model create unexpectedly conflicted");
    const task = await createScheduledTask(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      name: "Overlapping producer replay",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-model-overlap-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Replay the winner when retirement overtakes an overlapping retry",
        model: productModelId,
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const producerKey = `scheduled-model-overlap-race-${crypto.randomUUID()}`;
    const scheduledActivities = activities();
    let winnerPromise: ReturnType<typeof scheduledActivities.dispatchScheduledTaskRun> | null =
      null;
    let retirementPromise: ReturnType<typeof deleteWorkspaceGatewayCustomModel> | null = null;
    let retryPromise: ReturnType<typeof scheduledActivities.dispatchScheduledTaskRun> | null = null;

    await shared!.admin.begin(async (taskBarrier) => {
      const [backend] = await taskBarrier<Array<{ pid: number }>>`
        select pg_backend_pid()::int as pid
      `;
      if (!backend) throw new Error("task-row barrier has no backend pid");
      await taskBarrier`
        select 1 from scheduled_tasks where id = ${task.id}::uuid for update
      `;

      winnerPromise = scheduledActivities.dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey,
      });
      const winnerBackendPid = await waitForBackendBlockedBy(
        backend.pid,
        "producer winner behind the task-row barrier",
      );
      retirementPromise = deleteWorkspaceGatewayCustomModel(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        customModelId: customModel.id,
        expectedVersion: customModel.version,
        operationId: crypto.randomUUID(),
        requestHash: "9".repeat(64),
      });
      const retirementBackendPid = await waitForBackendBlockedBy(
        winnerBackendPid,
        "queued custom-model retirement behind producer winner",
      );
      retryPromise = scheduledActivities.dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey,
      });
      await waitForBackendBlockedBy(
        retirementBackendPid,
        "overlapping producer retry behind queued retirement",
      );
    });

    if (!winnerPromise || !retirementPromise || !retryPromise) {
      throw new Error("overlapping scheduled producer race was not fully started");
    }
    const [winner, retired, replay] = await Promise.all([
      winnerPromise,
      retirementPromise,
      retryPromise,
    ]);
    expect(retired).toMatchObject({ outcome: "success" });
    expect(winner.action).toBe("start");
    if (winner.action !== "start") throw new Error("producer winner did not start a session");
    expect(["start", "signal"]).toContain(replay.action);
    if (replay.action !== "start" && replay.action !== "signal") {
      throw new Error("producer replay did not converge on the accepted session");
    }
    expect(replay.sessionId).toBe(winner.sessionId);
    expect(replay.triggerEventId).toBe(winner.triggerEventId);
    const persistedRun = await getScheduledTaskRunByProducerKey(client.db, {
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });
    expect(persistedRun).not.toBeNull();
    expect(persistedRun?.sessionId).toBe(winner.sessionId);
    expect(persistedRun?.triggerEventId).toBe(winner.triggerEventId);
    expect(await listSessions(client.db, grant.workspaceId, 10)).toHaveLength(1);
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
