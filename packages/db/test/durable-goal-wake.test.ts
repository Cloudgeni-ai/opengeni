import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  armCodexCapacityWait,
  appendSessionEventsForTurnAttempt,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  clearSessionGoal,
  createDb,
  createSession,
  ensureCodexRotationSettings,
  getSessionGoalWithContinuation,
  initializeSessionStartAtomically,
  listSessionSystemUpdatesForTurn,
  materializeGoalContinuation,
  mutateSessionControlInTransaction,
  recoverSessionDispatch,
  setSessionGoalStatusWithEvent,
  submitHumanPromptInTransaction,
  updateCodexRotationSettings,
  updateSessionGoalWithEvent,
  upsertSessionGoalWithEvent,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("durable-goal-wake");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function runningGoalFixture(options: { withAncestor?: boolean } = {}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "goal-wake-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Goal wake test",
    workspaceExternalSource: "goal-wake-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Goal wake test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const ancestor = options.withAncestor
    ? await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "ancestor",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      })
    : null;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    ...(ancestor ? { parentSessionId: ancestor.id } : {}),
    initialMessage: "start",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const initialized = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: { text: "Finish the durable wake proof" },
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`Initial turn was not claimed`);
  return { grant, ancestor, session, initialized, turn: claimed.turn, attemptId };
}

type GoalFixture = Awaited<ReturnType<typeof runningGoalFixture>>;

async function beforeLockTimeout<T>(work: Promise<T>): Promise<T> {
  const timeout = Symbol("lock inversion timeout");
  const completed = await Promise.race([work, Bun.sleep(3_000).then(() => timeout)]);
  expect(completed).not.toBe(timeout);
  if (completed === timeout) throw new Error("goal mutation lock inversion timed out");
  return completed as T;
}

async function settleIdle(ctx: GoalFixture) {
  const settled = await applySessionTurnSettlement(client.db, ctx.grant.workspaceId!, {
    sessionId: ctx.session.id,
    turnId: ctx.turn.id,
    triggerEventId: ctx.turn.triggerEventId,
    attemptId: ctx.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

function materialize(ctx: GoalFixture) {
  return materializeGoalContinuation(client.db, {
    accountId: ctx.grant.accountId,
    workspaceId: ctx.grant.workspaceId!,
    sessionId: ctx.session.id,
    workflowId: `session-${ctx.session.id}`,
    defaultMaxAutoContinuations: null,
    noProgressLimit: 3,
    budgetBlocked: null,
    policy: {
      model: "scripted-model",
      reasoningEffort: "low",
      tools: [],
      sandboxBackend: "none",
    },
    prompt: (goal, count) => `continue ${goal.text} (${count})`,
  });
}

async function counts(ctx: GoalFixture) {
  const [goal] = await shared.admin`
    select auto_continuations, continuation_wake_revision, continuation_observed_revision
    from session_goals
    where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}`;
  const [updates] = await shared.admin`
    select count(*)::int as count from session_system_updates
    where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
      and kind = 'goal_continuation'`;
  const [usage] = await shared.admin`
    select count(*)::int as count from usage_events
    where workspace_id = ${ctx.grant.workspaceId!}
      and idempotency_key like 'agent_run.created:goal:%'`;
  const [events] = await shared.admin`
    select count(*)::int as count from session_events
    where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
      and type = 'goal.continuation'`;
  return {
    autoContinuations: Number(goal!.auto_continuations),
    wakeRevision: Number(goal!.continuation_wake_revision),
    observedRevision: Number(goal!.continuation_observed_revision),
    updates: Number(updates!.count),
    usage: Number(usage!.count),
    events: Number(events!.count),
  };
}

describe("durable active-goal wake", () => {
  test("terminal settlement atomically arms an admitted-idle goal and its workflow outbox", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);

    expect(await counts(ctx)).toMatchObject({
      wakeRevision: 1,
      observedRevision: 0,
      updates: 0,
      usage: 0,
      events: 0,
    });
    const projection = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    expect(projection?.continuation).toMatchObject({
      state: "scheduled",
      reason: "wake_pending",
      wakeRevision: 1,
      observedRevision: 0,
    });
    const [wake] = await shared.admin`
      select reason, wake_revision, delivered_revision
      from session_workflow_wake_outbox where session_id = ${ctx.session.id}`;
    expect(wake).toMatchObject({ reason: "goal_turn_settled" });
    expect(Number(wake!.wake_revision)).toBeGreaterThan(Number(wake!.delivered_revision));

    // A historical late failure attached to an already-delivered workflow
    // nudge does not describe the still-pending goal obligation.
    await shared.admin`
      update session_workflow_wake_outbox
      set delivered_revision = wake_revision, last_error = 'late duplicate failure'
      where session_id = ${ctx.session.id}`;
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation,
    ).toMatchObject({ state: "scheduled", reason: "wake_pending", lastError: null });
  });

  test("concurrent evaluators and a lost COMMIT response materialize one update, event, and usage row", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);

    const firstWave = await Promise.all(Array.from({ length: 8 }, () => materialize(ctx)));
    expect(firstWave.every((result) => result.action === "continue")).toBe(true);
    // The caller loses the successful response and retries the same obligation.
    expect((await materialize(ctx)).action).toBe("continue");
    expect(await counts(ctx)).toEqual({
      autoContinuations: 1,
      wakeRevision: 1,
      observedRevision: 1,
      updates: 1,
      usage: 1,
      events: 1,
    });
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation,
    ).toMatchObject({ state: "scheduled", reason: "continuation_pending" });
  });

  test("projects only a live goal attempt as running while worker recovery is scheduled", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    expect((await materialize(ctx)).action).toBe("continue");

    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("goal continuation was not claimed");
    expect(claimed.turn.source).toBe("goal");
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation,
    ).toMatchObject({ state: "running", reason: "goal_turn_running" });

    const recovered = await recoverSessionDispatch(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      attemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 3,
    });
    expect(recovered.action).toBe("recovering");
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation,
    ).toMatchObject({ state: "scheduled", reason: "continuation_pending" });
  });

  test("recursive Pause suppresses synthesis and Resume re-arms the same pending revision", async () => {
    const ctx = await runningGoalFixture({ withAncestor: true });
    if (!ctx.ancestor) throw new Error("ancestor fixture was not created");
    await settleIdle(ctx);

    const control = async (sessionId: string, action: "pause" | "resume") =>
      await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as typeof db, {
            accountId: ctx.grant.accountId,
            workspaceId: ctx.grant.workspaceId!,
            sessionId,
            actor: { type: "human", subjectId: ctx.grant.subjectId },
            operationKey: crypto.randomUUID(),
            action,
          }),
        ),
      );

    await control(ctx.ancestor.id, "pause");
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation,
    ).toMatchObject({
      state: "blocked",
      reason: "workstream_paused",
      wakeRevision: 1,
      observedRevision: 0,
    });
    expect((await materialize(ctx)).action).toBe("none");
    expect(await counts(ctx)).toEqual({
      autoContinuations: 0,
      wakeRevision: 1,
      observedRevision: 0,
      updates: 0,
      usage: 0,
      events: 0,
    });

    await control(ctx.session.id, "resume");
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation,
    ).toMatchObject({
      state: "scheduled",
      reason: "wake_pending",
      wakeRevision: 1,
      observedRevision: 0,
    });
    expect((await materialize(ctx)).action).toBe("continue");
    expect(await counts(ctx)).toEqual({
      autoContinuations: 1,
      wakeRevision: 1,
      observedRevision: 1,
      updates: 1,
      usage: 1,
      events: 1,
    });
  });

  test("provider capacity wait blocks synthesis and exposes its durable retry time", async () => {
    const ctx = await runningGoalFixture();
    await ensureCodexRotationSettings(client.db, ctx.grant.accountId, ctx.grant.workspaceId!);
    await updateCodexRotationSettings(client.db, ctx.grant.workspaceId!, {
      rotationEnabled: true,
    });
    const goal = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    if (!goal) throw new Error("goal fixture was not created");
    const resetAt = new Date(Date.now() + 5 * 60_000);
    const armed = await armCodexCapacityWait(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      attemptId: ctx.attemptId,
      workflowId: `session-${ctx.session.id}`,
      goalId: goal.id,
      goalVersion: 1,
      earliestResetAt: resetAt,
      resetKind: "authoritative",
      failurePayload: {
        error: "all connected Codex subscriptions are unavailable",
        code: "codex_usage_limit_reached",
      },
    });
    expect(armed.action).toBe("waiting");
    if (armed.action !== "waiting") throw new Error("capacity wait was not armed");

    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation,
    ).toMatchObject({
      state: "blocked",
      reason: "provider_backpressure",
      nextAttemptAt: armed.waiter.nextCheckAt.toISOString(),
    });
    expect((await materialize(ctx)).action).toBe("none");
    expect(await counts(ctx)).toEqual({
      autoContinuations: 0,
      wakeRevision: 0,
      observedRevision: 0,
      updates: 0,
      usage: 0,
      events: 0,
    });
  });

  test("cancelled and corrupt idle sessions report truth before refusing or repairing work", async () => {
    const cancelled = await runningGoalFixture();
    await settleIdle(cancelled);
    await shared.admin`
      update sessions set status = 'cancelled'
      where workspace_id = ${cancelled.grant.workspaceId!} and id = ${cancelled.session.id}`;
    expect(
      (
        await getSessionGoalWithContinuation(
          client.db,
          cancelled.grant.workspaceId!,
          cancelled.session.id,
        )
      )?.continuation,
    ).toMatchObject({ state: "blocked", reason: "session_cancelled" });
    expect((await materialize(cancelled)).action).toBe("none");
    expect(await counts(cancelled)).toMatchObject({ updates: 0, usage: 0, events: 0 });

    const corrupt = await runningGoalFixture();
    await settleIdle(corrupt);
    await shared.admin`
      update session_goals
      set continuation_observed_revision = continuation_wake_revision
      where workspace_id = ${corrupt.grant.workspaceId!} and session_id = ${corrupt.session.id}`;
    expect(
      (
        await getSessionGoalWithContinuation(
          client.db,
          corrupt.grant.workspaceId!,
          corrupt.session.id,
        )
      )?.continuation,
    ).toMatchObject({
      state: "invariant_broken",
      reason: "missing_obligation",
      wakeRevision: 1,
      observedRevision: 1,
    });
    expect((await materialize(corrupt)).action).toBe("continue");
    expect(await counts(corrupt)).toEqual({
      autoContinuations: 1,
      wakeRevision: 2,
      observedRevision: 2,
      updates: 1,
      usage: 1,
      events: 1,
    });
  });

  const faults = [
    {
      name: "evaluation mutation",
      table: "session_goals",
      timing: "before update",
      condition: "NEW.auto_continuations <> OLD.auto_continuations",
    },
    {
      name: "system update",
      table: "session_system_updates",
      timing: "before insert",
      condition: "NEW.kind = 'goal_continuation'",
    },
    {
      name: "event append",
      table: "session_events",
      timing: "before insert",
      condition: "NEW.type = 'goal.continuation'",
    },
    {
      name: "usage append",
      table: "usage_events",
      timing: "before insert",
      condition: "NEW.idempotency_key like 'agent_run.created:goal:%'",
    },
    {
      name: "goal observation",
      table: "session_goals",
      timing: "before update",
      condition: "NEW.continuation_observed_revision <> OLD.continuation_observed_revision",
    },
    {
      name: "workflow wake enqueue",
      table: "session_workflow_wake_outbox",
      timing: "before update",
      condition: "NEW.reason = 'internal_update_batch'",
    },
  ] as const;

  for (const fault of faults) {
    test(`rolls back the entire obligation at the ${fault.name} boundary`, async () => {
      const ctx = await runningGoalFixture();
      await settleIdle(ctx);
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const functionName = `ope59_fault_${suffix}`;
      const triggerName = `ope59_fault_${suffix}`;
      await shared.admin.unsafe(`
        create function ${functionName}() returns trigger language plpgsql as $$
        begin
          raise exception 'ope59 injected ${fault.name} failure';
        end $$;
        create trigger ${triggerName} ${fault.timing} on ${fault.table}
        for each row when (${fault.condition}) execute function ${functionName}();
      `);
      try {
        await expect(materialize(ctx)).rejects.toThrow();
      } finally {
        await shared.admin.unsafe(`
          drop trigger if exists ${triggerName} on ${fault.table};
          drop function if exists ${functionName}();
        `);
      }
      expect(await counts(ctx)).toEqual({
        autoContinuations: 0,
        wakeRevision: 1,
        observedRevision: 0,
        updates: 0,
        usage: 0,
        events: 0,
      });
      expect((await materialize(ctx)).action).toBe("continue");
      expect(await counts(ctx)).toMatchObject({
        autoContinuations: 1,
        observedRevision: 1,
        updates: 1,
        usage: 1,
        events: 1,
      });
    });
  }

  test("a racing human Send stays the next inference and consumes no separate goal turn", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    const send = withWorkspaceSubjectRls(
      client.db,
      ctx.grant.workspaceId!,
      ctx.grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as typeof db, {
            accountId: ctx.grant.accountId,
            workspaceId: ctx.grant.workspaceId!,
            sessionId: ctx.session.id,
            subjectId: ctx.grant.subjectId,
            actor: { type: "human", subjectId: ctx.grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "human direction wins",
            resources: [],
            tools: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
    );
    await Promise.all([send, materialize(ctx)]);
    const nextAttemptId = crypto.randomUUID();
    const next = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: nextAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(next.action).toBe("claimed");
    if (next.action !== "claimed") return;
    expect(next.turn.source).toBe("user");
    const [goalTurns] = await shared.admin`
      select count(*)::int as count from session_turns
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
        and source = 'goal'`;
    expect(Number(goalTurns!.count)).toBe(0);
  });

  test("a racing Steer remains the final authoritative direction in the coalesced goal turn", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    expect((await materialize(ctx)).action).toBe("continue");

    // PostgreSQL now() is the transaction start timestamp. Model the exact
    // race where Steer starts first, waits on materialization, then commits
    // second with an earlier created_at than the goal update.
    const operationId = crypto.randomUUID();
    await shared.admin`
      insert into session_system_updates (
        account_id, workspace_id, session_id, kind, classification, source_id,
        dedupe_key, summary, payload, lineage, state, created_at
      ) values (
        ${ctx.grant.accountId}, ${ctx.grant.workspaceId!}, ${ctx.session.id},
        'agent_steer_instruction', 'action_required', ${ctx.session.id},
        ${`ope59-steer:${operationId}`}, 'operator direction wins',
        ${shared.admin.json({
          type: "agent_steer_instruction",
          instruction: "operator direction wins",
          operationId,
        })},
        ${shared.admin.json({})}, 'pending', now() - interval '1 day'
      )`;

    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("coalesced Steer was not claimed");
    expect(claimed.turn.source).toBe("goal");
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      claimed.turn.id,
    );
    expect(delivered.map((update) => update.kind)).toEqual([
      "goal_continuation",
      "agent_steer_instruction",
    ]);
    expect(await counts(ctx)).toMatchObject({ autoContinuations: 1, updates: 1, usage: 1 });
  });

  test("active-turn event writes and agent goal mutations complete without workspace/session lock inversion", async () => {
    const ctx = await runningGoalFixture();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `ope59_slow_event_${suffix}`;
    const triggerName = `ope59_slow_event_${suffix}`;
    await shared.admin.unsafe(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        perform pg_sleep(0.35);
        return NEW;
      end $$;
      create trigger ${triggerName} before insert on session_events
      for each row when (NEW.type = 'agent.message.delta') execute function ${functionName}();
    `);
    try {
      const append = appendSessionEventsForTurnAttempt(
        client.db,
        ctx.grant.workspaceId!,
        ctx.session.id,
        ctx.turn.id,
        ctx.turn.executionGeneration,
        ctx.attemptId,
        [{ type: "agent.message.delta", payload: { text: "concurrent progress" } }],
      );
      await Bun.sleep(50);
      const mutate = updateSessionGoalWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
        progressNote: "still making progress",
        actor: "agent",
      });
      const completed = await beforeLockTimeout(Promise.all([append, mutate]));
      expect(completed[0].accepted).toBe(true);
      expect(completed[1].events).toHaveLength(1);

      const statusMutation = await setSessionGoalStatusWithEvent(
        client.db,
        ctx.grant.workspaceId!,
        ctx.session.id,
        {
          status: "completed",
          evidence: "concurrent mutation completed",
          event: { type: "goal.completed", evidence: "concurrent mutation completed" },
        },
      );
      expect(statusMutation.changed).toBe(true);
      expect(statusMutation.events).toHaveLength(1);

      const setAppend = appendSessionEventsForTurnAttempt(
        client.db,
        ctx.grant.workspaceId!,
        ctx.session.id,
        ctx.turn.id,
        ctx.turn.executionGeneration,
        ctx.attemptId,
        [{ type: "agent.message.delta", payload: { text: "concurrent goal set" } }],
      );
      await Bun.sleep(50);
      const [setAppendResult, setMutation] = await beforeLockTimeout(
        Promise.all([
          setAppend,
          upsertSessionGoalWithEvent(client.db, {
            accountId: ctx.grant.accountId,
            workspaceId: ctx.grant.workspaceId!,
            sessionId: ctx.session.id,
            text: "replacement goal after terminal mutation",
            createdBy: "agent",
            actor: "agent",
          }),
        ]),
      );
      expect(setAppendResult.accepted).toBe(true);
      expect(setMutation.replaced).toBe(true);
      expect(setMutation.events).toHaveLength(1);

      const clearAppend = appendSessionEventsForTurnAttempt(
        client.db,
        ctx.grant.workspaceId!,
        ctx.session.id,
        ctx.turn.id,
        ctx.turn.executionGeneration,
        ctx.attemptId,
        [{ type: "agent.message.delta", payload: { text: "concurrent goal clear" } }],
      );
      await Bun.sleep(50);
      const [clearAppendResult, clearMutation] = await beforeLockTimeout(
        Promise.all([
          clearAppend,
          clearSessionGoal(client.db, ctx.grant.workspaceId!, ctx.session.id),
        ]),
      );
      expect(clearAppendResult.accepted).toBe(true);
      expect(clearMutation.cleared).toBe(true);
      expect(clearMutation.event?.type).toBe("goal.cleared");
    } finally {
      await shared.admin.unsafe(`
        drop trigger if exists ${triggerName} on session_events;
        drop function if exists ${functionName}();
      `);
    }
  });
});
