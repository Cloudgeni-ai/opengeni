import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  claimNextQueuedTurn,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createApiKey,
  createSession,
  createSessionGoal,
  createTurn,
  dbSql,
  enableCapabilityInstallation,
  enqueueSessionTurn,
  evaluateGoalContinuation,
  finishTurn,
  findActiveApiKeyByHash,
  getLatestRunState,
  getSession,
  getSessionGoal,
  setSessionGoalLastContinuationTurn,
  setSessionGoalStatus,
  updateSessionGoal,
  upsertSessionGoal,
  listEnabledMcpCapabilityServers,
  listScheduledTaskRuns,
  listScheduledTasks,
  getSessionTurn,
  listSessionEvents,
  requeuePreemptedTurn,
  saveRunState,
  setSessionStatus,
  updateScheduledTask,
  updateScheduledTaskRun,
  withRlsContext,
  upsertCapabilityCatalogItem,
} from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import { expectContiguousSequences, startTestServices, type TestServices } from "@opengeni/testing";

describe("DB integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("migrates, creates sessions, and replays ordered events", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "inspect this",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const events = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "session.created" },
      { type: "user.message", payload: { text: "inspect this" }, clientEventId: "client-1" },
      { type: "session.status.changed", payload: { status: "queued" } },
    ]);
    expectContiguousSequences(events);
    expect(await listSessionEvents(dbClient.db, grant.workspaceId, session.id)).toHaveLength(3);
    expect(await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 1)).toHaveLength(2);
  });

  test("serializes concurrent event appends into contiguous sequence numbers", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "concurrency",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{
        type: "agent.message.delta",
        payload: { text: String(index) },
        producerId: "producer",
        producerSeq: index,
      }])
    ));
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 20);
    expect(events).toHaveLength(10);
    expectContiguousSequences(events);
  });

  test("enforces client and producer idempotency constraints", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "dedupe",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "one" }, clientEventId: "same-client" },
      { type: "agent.message.delta", payload: { text: "a" }, producerId: "p", producerSeq: 1 },
    ]);
    await expect(appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "two" }, clientEventId: "same-client" },
    ])).rejects.toThrow();
    await expect(appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "agent.message.delta", payload: { text: "b" }, producerId: "p", producerSeq: 1 },
    ])).rejects.toThrow();
  });

  test("persists run state versions and turn status transitions", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "turns",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "turns" } },
    ]);
    const turnId = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: "workflow",
    });
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId,
      serializedRunState: "state-1",
      pendingApprovals: [],
    });
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId,
      serializedRunState: "state-2",
      pendingApprovals: [{ id: "approval" }],
    });
    const latest = await getLatestRunState(dbClient.db, grant.workspaceId, session.id);
    expect(latest?.serializedRunState).toBe("state-2");
    await finishTurn(dbClient.db, grant.workspaceId, turnId, "idle");
    await setSessionStatus(dbClient.db, grant.workspaceId, session.id, "idle", null);
  });

  test("requeues a preempted running turn behind a swapped trigger event", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "long task",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger, resumeTrigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "user.message", payload: { text: "long task" } },
      { type: "turn.preempted", payload: { reason: "worker_shutdown", text: "resume" } },
    ]);
    const turn = await enqueueSessionTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: "wf-preempt-db",
      source: "user",
      prompt: "long task",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low",
      sandboxBackend: "none",
      metadata: {},
    });
    const claimed = await claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "wf-preempt-db");
    expect(claimed?.id).toBe(turn.id);

    await requeuePreemptedTurn(dbClient.db, grant.workspaceId, turn.id, resumeTrigger!.id);
    const requeued = await getSessionTurn(dbClient.db, grant.workspaceId, turn.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.triggerEventId).toBe(resumeTrigger!.id);
    expect(requeued?.startedAt).toBeNull();

    // The next claim re-dispatches the same turn through the resume trigger.
    const reclaimed = await claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "wf-preempt-db-2");
    expect(reclaimed?.id).toBe(turn.id);
    expect(reclaimed?.triggerEventId).toBe(resumeTrigger!.id);

    // An approval rerun re-dispatches the same turn without a fresh claim, so
    // a shutdown there preempts a turn still marked requires_action.
    await finishTurn(dbClient.db, grant.workspaceId, turn.id, "requires_action");
    await requeuePreemptedTurn(dbClient.db, grant.workspaceId, turn.id, trigger!.id);
    const requeuedFromApproval = await getSessionTurn(dbClient.db, grant.workspaceId, turn.id);
    expect(requeuedFromApproval?.status).toBe("queued");
    expect(requeuedFromApproval?.triggerEventId).toBe(trigger!.id);

    // Terminal turns cannot be preempt-requeued.
    await finishTurn(dbClient.db, grant.workspaceId, turn.id, "idle");
    await expect(requeuePreemptedTurn(dbClient.db, grant.workspaceId, turn.id, resumeTrigger!.id)).rejects.toThrow("Preemptible session turn not found");
  });

  test("persists scheduled tasks and run history", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createScheduledTask(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "daily",
      status: "active",
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "run",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const updated = await updateScheduledTask(dbClient.db, grant.workspaceId, task.id, { status: "paused" });
    expect(updated.status).toBe("paused");
    expect((await listScheduledTasks(dbClient.db, grant.workspaceId)).some((item) => item.id === task.id)).toBe(true);

    const run = await createScheduledTaskRun(dbClient.db, {
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "manual",
      scheduledAt: null,
    });
    await updateScheduledTaskRun(dbClient.db, grant.workspaceId, run.id, { status: "failed", error: "no worker" });
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toBe("no worker");
  });

  test("session goal lifecycle: set, revise, complete, replace", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal lifecycle",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    expect(await getSessionGoal(dbClient.db, grant.workspaceId, session.id)).toBeNull();
    const created = await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "ship the deploy pipeline",
      successCriteria: "CI green on main",
      createdBy: "api",
    });
    expect(created.status).toBe("active");
    expect(created.version).toBe(1);

    const revised = await updateSessionGoal(dbClient.db, grant.workspaceId, session.id, { text: "ship the deploy pipeline v2" });
    expect(revised.version).toBe(2);
    expect(revised.status).toBe("active");

    const paused = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "paused", rationale: "blocked", pausedReason: "agent" });
    expect(paused.changed).toBe(true);
    expect(paused.goal.pausedReason).toBe("agent");
    const pausedAgain = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "paused", pausedReason: "agent" });
    expect(pausedAgain.changed).toBe(false);

    const resumed = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "active" });
    expect(resumed.goal.pausedReason).toBeNull();
    expect(resumed.goal.rationale).toBeNull();
    expect(resumed.goal.autoContinuations).toBe(0);

    const completed = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "completed", evidence: "pipeline live, CI green" });
    expect(completed.goal.evidence).toBe("pipeline live, CI green");
    await expect(setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, { status: "active" })).rejects.toThrow("completed");

    const replaced = await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "now keep it healthy",
      createdBy: "agent",
    });
    expect(replaced.replaced).toBe(true);
    expect(replaced.goal.status).toBe("active");
    expect(replaced.goal.evidence).toBeNull();
    expect(replaced.goal.autoContinuations).toBe(0);
    expect(replaced.goal.version).toBeGreaterThan(completed.goal.version);
  });

  test("evaluateGoalContinuation honors queue, approvals, progress, and caps", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal loop",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const guards = { defaultMaxAutoContinuations: 5, noProgressLimit: 2 };
    const enqueueGoalTurn = async () => {
      const [goalTrigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "goal.continuation", payload: { text: "continue" } }]);
      return await enqueueSessionTurn(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: goalTrigger!.id,
        temporalWorkflowId: "wf-goal-db",
        source: "goal",
        prompt: "continue",
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "low",
        sandboxBackend: "none",
        metadata: {},
      });
    };

    // No goal yet.
    expect(await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards })).toEqual({ decision: "none" });

    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "keep working",
      createdBy: "api",
    });

    // Queued work always wins.
    const [trigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "user.message", payload: { text: "go" } }]);
    const queuedUserTurn = await enqueueSessionTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: "wf-goal-db",
      source: "user",
      prompt: "go",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low",
      sandboxBackend: "none",
      metadata: {},
    });
    expect((await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards })).decision).toBe("queue");

    // A non-terminal requires_action turn (pending approval) blocks continuation.
    await finishTurn(dbClient.db, grant.workspaceId, queuedUserTurn.id, "requires_action");
    expect((await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards })).decision).toBe("none");
    await finishTurn(dbClient.db, grant.workspaceId, queuedUserTurn.id, "completed");

    // First continuation.
    const first = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(first).toMatchObject({ decision: "continue", autoContinuation: 1, cap: 5 });

    // A continuation turn that finishes without tool calls or a goal revision
    // increments the no-progress streak; noProgressLimit 2 pauses the goal.
    for (let round = 1; round <= 2; round += 1) {
      const continuationTurn = await enqueueGoalTurn();
      await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, continuationTurn.id);
      await finishTurn(dbClient.db, grant.workspaceId, continuationTurn.id, "completed");
      const next = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
      if (round < 2) {
        expect(next.decision).toBe("continue");
      } else {
        expect(next).toMatchObject({ decision: "paused", reason: "no_progress" });
      }
    }
    expect((await getSessionGoal(dbClient.db, grant.workspaceId, session.id))?.pausedReason).toBe("no_progress");

    // Replacing the goal re-arms it; the per-goal cap is enforced.
    await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "one more push",
      maxAutoContinuations: 1,
      createdBy: "agent",
    });
    const capped = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(capped).toMatchObject({ decision: "continue", autoContinuation: 1, cap: 1 });
    // Mark progress in that continuation so the cap (not no-progress) triggers.
    const capTurn = await enqueueGoalTurn();
    await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, capTurn.id);
    await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "agent.toolCall.created", turnId: capTurn.id, payload: {} }]);
    await finishTurn(dbClient.db, grant.workspaceId, capTurn.id, "completed");
    const atCap = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(atCap).toMatchObject({ decision: "paused", reason: "max_auto_continuations" });
  });

  test("provider backpressure turns freeze the no-progress streak", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal loop",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const guards = { defaultMaxAutoContinuations: 10, noProgressLimit: 2 };
    const enqueueGoalTurn = async () => {
      const [goalTrigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "goal.continuation", payload: { text: "continue" } }]);
      return await enqueueSessionTurn(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: goalTrigger!.id,
        temporalWorkflowId: "wf-goal-backpressure",
        source: "goal",
        prompt: "continue",
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "low",
        sandboxBackend: "none",
        metadata: {},
      });
    };
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "outlast the rate limiter",
      createdBy: "api",
    });
    const first = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(first).toMatchObject({ decision: "continue", autoContinuation: 1 });

    // Three consecutive rate-limited continuations (no tool calls) exceed
    // noProgressLimit 2, but backpressure failures must not advance the
    // streak: the goal keeps continuing instead of pausing as no_progress.
    for (let round = 1; round <= 3; round += 1) {
      const turn = await enqueueGoalTurn();
      await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, turn.id);
      await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{
        type: "turn.failed",
        turnId: turn.id,
        payload: { code: "provider_rate_limited", retryable: true, recovery: "goal_continuation", runStateSaved: false },
      }]);
      await finishTurn(dbClient.db, grant.workspaceId, turn.id, "failed");
      const next = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
      expect(next).toMatchObject({ decision: "continue", autoContinuation: 1 + round });
    }

    // Ordinary empty continuations still count: two of them pause the goal.
    for (let round = 1; round <= 2; round += 1) {
      const turn = await enqueueGoalTurn();
      await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, turn.id);
      await finishTurn(dbClient.db, grant.workspaceId, turn.id, "completed");
      const next = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
      if (round < 2) {
        expect(next.decision).toBe("continue");
      } else {
        expect(next).toMatchObject({ decision: "paused", reason: "no_progress" });
      }
    }
  });

  test("goals are uncapped by count when no default cap is configured", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "multi-day goal",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // No deployment default: length is governed by progress/budget guards only.
    const guards = { defaultMaxAutoContinuations: null, noProgressLimit: 2 };
    const enqueueGoalTurn = async () => {
      const [goalTrigger] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "goal.continuation", payload: { text: "continue" } }]);
      return await enqueueSessionTurn(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: goalTrigger!.id,
        temporalWorkflowId: "wf-goal-uncapped",
        source: "goal",
        prompt: "continue",
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "low",
        sandboxBackend: "none",
        metadata: {},
      });
    };
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "keep going for days",
      createdBy: "api",
    });
    // Run well past the old default cap of 20; with progress every round the
    // loop must keep continuing, with a null cap throughout.
    let decision = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(decision).toMatchObject({ decision: "continue", autoContinuation: 1, cap: null });
    for (let round = 2; round <= 25; round += 1) {
      const turn = await enqueueGoalTurn();
      await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, turn.id);
      await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "agent.toolCall.created", turnId: turn.id, payload: {} }]);
      await finishTurn(dbClient.db, grant.workspaceId, turn.id, "completed");
      decision = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
      expect(decision).toMatchObject({ decision: "continue", autoContinuation: round, cap: null });
    }
    // A per-goal cap still applies on its own, without any deployment default.
    await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "bounded push",
      maxAutoContinuations: 1,
      createdBy: "agent",
    });
    const bounded = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(bounded).toMatchObject({ decision: "continue", autoContinuation: 1, cap: 1 });
    const boundedTurn = await enqueueGoalTurn();
    await setSessionGoalLastContinuationTurn(dbClient.db, grant.workspaceId, session.id, boundedTurn.id);
    await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [{ type: "agent.toolCall.created", turnId: boundedTurn.id, payload: {} }]);
    await finishTurn(dbClient.db, grant.workspaceId, boundedTurn.id, "completed");
    const atCap = await evaluateGoalContinuation(dbClient.db, { workspaceId: grant.workspaceId, sessionId: session.id, ...guards });
    expect(atCap).toMatchObject({ decision: "paused", reason: "max_auto_continuations" });
  });

  test("RLS policies isolate session goal rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      const sessionB = await createSession(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        initialMessage: "workspace b goal",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      await createSessionGoal(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        sessionId: sessionB.id,
        text: "workspace b objective",
        createdBy: "api",
      });

      const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from session_goals`);
      expect(Number(hidden[0]?.count ?? 0)).toBe(0);

      const sessionA = await createSession(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        initialMessage: "workspace a goal",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      await createSessionGoal(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        sessionId: sessionA.id,
        text: "workspace a objective",
        createdBy: "api",
      });
      const visible = await withRlsContext(appDbClient.db, grantA, async (db) =>
        await db.execute(dbSql<{ workspace_id: string }>`select workspace_id::text from session_goals`)
      );
      expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);

      await expect(withRlsContext(appDbClient.db, grantA, async (db) => {
        await db.execute(dbSql`
          insert into session_goals (account_id, workspace_id, session_id, text)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${sessionB.id}, 'mismatched goal')
        `);
      })).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  test("RLS policies isolate workspace-owned rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await createSession(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        initialMessage: "workspace b",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });

      const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from sessions`);
      expect(Number(hidden[0]?.count ?? 0)).toBe(0);

      const created = await createSession(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        initialMessage: "workspace a",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      expect(created.workspaceId).toBe(grantA.workspaceId);
      expect((await getSession(appDbClient.db, grantA.workspaceId, created.id))?.id).toBe(created.id);

      const visible = await withRlsContext(appDbClient.db, grantA, async (db) =>
        await db.execute(dbSql<{ id: string; workspace_id: string }>`select id, workspace_id::text from sessions order by created_at asc`)
      );
      expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);

      await expect(createSession(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantB.workspaceId,
        initialMessage: "mismatched account workspace",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      })).rejects.toThrow();

      const keyHash = crypto.randomUUID();
      const apiKey = await createApiKey(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        name: "RLS key",
        prefix: "og_test",
        keyHash,
        permissions: ["sessions:create"],
      });
      expect((await findActiveApiKeyByHash(appDbClient.db, keyHash))?.id).toBe(apiKey.id);
    } finally {
      await appDbClient.close();
    }
  });

  test("RLS policies isolate capability, pack, and social rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await seedCapabilityPackAndSocialRows(dbClient.db, grantB);

      for (const table of newCapabilityTables) {
        const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from ${dbSql.raw(table)}`);
        expect(Number(hidden[0]?.count ?? 0)).toBe(0);
      }

      await withRlsContext(appDbClient.db, grantA, async (db) => {
        await seedCapabilityPackAndSocialRows(db, grantA);
      });

      for (const table of newCapabilityTables) {
        const visible = await withRlsContext(appDbClient.db, grantA, async (db) =>
          await db.execute(dbSql<{ workspace_id: string }>`select workspace_id::text from ${dbSql.raw(table)} order by workspace_id asc`)
        );
        expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);
      }

      await expect(withRlsContext(appDbClient.db, grantA, async (db) => {
        await db.execute(dbSql`
          insert into pack_installations (account_id, workspace_id, pack_id)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${`mismatched-${crypto.randomUUID()}`})
        `);
      })).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  test("RLS policies isolate workspace environment rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await seedWorkspaceEnvironmentRows(dbClient.db, grantB);

      for (const table of ["workspace_environments", "workspace_environment_variables"]) {
        const hidden = await appDbClient.db.execute(dbSql<{ count: string }>`select count(*)::text as count from ${dbSql.raw(table)}`);
        expect(Number(hidden[0]?.count ?? 0)).toBe(0);
      }

      await withRlsContext(appDbClient.db, grantA, async (db) => {
        await seedWorkspaceEnvironmentRows(db, grantA);
      });

      for (const table of ["workspace_environments", "workspace_environment_variables"]) {
        const visible = await withRlsContext(appDbClient.db, grantA, async (db) =>
          await db.execute(dbSql<{ workspace_id: string }>`select workspace_id::text from ${dbSql.raw(table)}`)
        );
        expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);
      }

      await expect(withRlsContext(appDbClient.db, grantA, async (db) => {
        await db.execute(dbSql`
          insert into workspace_environments (account_id, workspace_id, name)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${`mismatched-${crypto.randomUUID()}`})
        `);
      })).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  test("exports only runtime-ready enabled MCP capability servers", async () => {
    const grant = await testGrant(dbClient.db);
    const otherGrant = await testGrant(dbClient.db);
    const capabilityId = `mcp:test-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: capabilityId,
      kind: "mcp",
      source: "manual",
      name: "Test MCP",
      endpointUrl: "https://example.com/mcp",
      metadata: { mcpServerId: "cap-test-ready" },
    });
    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: {},
    });
    expect((await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some((server) => server.capabilityId === capabilityId)).toBe(false);

    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: { mcpConnectivity: { status: "ok", checkedAt: new Date().toISOString(), toolCount: 1 } },
    });
    expect((await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some((server) => server.capabilityId === capabilityId)).toBe(true);
    expect((await listEnabledMcpCapabilityServers(dbClient.db, otherGrant.workspaceId)).some((server) => server.capabilityId === capabilityId)).toBe(false);

    const gatedCapabilityId = `mcp:gated-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: gatedCapabilityId,
      kind: "mcp",
      source: "manual",
      name: "Gated MCP",
      endpointUrl: "https://secure.example/mcp",
      authModel: "credential_ref",
      metadata: { mcpServerId: "cap-test-gated" },
    });
    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId: gatedCapabilityId,
      kind: "mcp",
      metadata: { mcpConnectivity: { status: "ok", checkedAt: new Date().toISOString(), toolCount: 1 } },
    });
    expect((await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some((server) => server.capabilityId === gatedCapabilityId)).toBe(false);
  });
});

const newCapabilityTables = [
  "pack_installations",
  "capability_catalog_items",
  "capability_installations",
  "social_connections",
  "social_posts",
];

async function seedCapabilityPackAndSocialRows(db: ReturnType<typeof createDb>["db"], grant: AccessGrant): Promise<void> {
  const suffix = crypto.randomUUID();
  const capabilityId = `mcp:rls-${suffix}`;
  const connectionId = crypto.randomUUID();
  await db.execute(dbSql`
    insert into pack_installations (account_id, workspace_id, pack_id)
    values (${grant.accountId}, ${grant.workspaceId}, ${`pack-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into capability_catalog_items (id, account_id, workspace_id, kind, source, name, endpoint_url)
    values (${capabilityId}, ${grant.accountId}, ${grant.workspaceId}, 'mcp', 'manual', ${`RLS MCP ${suffix}`}, 'https://example.com/mcp')
  `);
  await db.execute(dbSql`
    insert into capability_installations (account_id, workspace_id, capability_id, kind)
    values (${grant.accountId}, ${grant.workspaceId}, ${capabilityId}, 'mcp')
  `);
  await db.execute(dbSql`
    insert into social_connections (id, account_id, workspace_id, provider, account_handle)
    values (${connectionId}, ${grant.accountId}, ${grant.workspaceId}, 'linkedin', ${`handle-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into social_posts (account_id, workspace_id, connection_id, provider, external_post_id, text, published_at)
    values (${grant.accountId}, ${grant.workspaceId}, ${connectionId}, 'linkedin', ${`post-${suffix}`}, 'RLS post', now())
  `);
}

async function seedWorkspaceEnvironmentRows(db: ReturnType<typeof createDb>["db"], grant: AccessGrant): Promise<void> {
  const suffix = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  await db.execute(dbSql`
    insert into workspace_environments (id, account_id, workspace_id, name)
    values (${environmentId}, ${grant.accountId}, ${grant.workspaceId}, ${`rls-environment-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into workspace_environment_variables (account_id, workspace_id, environment_id, name, value_encrypted)
    values (${grant.accountId}, ${grant.workspaceId}, ${environmentId}, 'RLS_TOKEN', 'v1:placeholder:placeholder')
  `);
}

async function testGrant(db: ReturnType<typeof createDb>["db"]): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:db",
    accountExternalId: `account:${id}`,
    accountName: "DB integration account",
    workspaceExternalSource: "test:db",
    workspaceExternalId: `workspace:${id}`,
    workspaceName: "DB integration workspace",
    subjectId: `test:db:${id}`,
    subjectLabel: "DB integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("DB test did not create a workspace grant");
  }
  return grant;
}

async function createRlsAppRole(db: ReturnType<typeof createDb>["db"], ownerUrl: string): Promise<string> {
  const role = `opengeni_rls_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const password = `pw_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.execute(dbSql.raw(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`));
  await db.execute(dbSql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`));
  await db.execute(dbSql.raw(`GRANT USAGE ON SCHEMA opengeni_private TO "${role}"`));
  await db.execute(dbSql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`));
  await db.execute(dbSql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO "${role}"`));
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
