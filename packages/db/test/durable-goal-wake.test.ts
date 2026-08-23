import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  SESSION_GOAL_CONTEXT_LABEL,
  SESSION_GOAL_TEXT_MAX_BYTES,
  type McpPersonalConnectionDelegation,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate,
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
  holdSessionGoalContinuationWithEvent,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  listSessionGoalRevisions,
  listSessionSystemUpdatesForTurn,
  materializeGoalContinuation,
  mutateSessionControlInTransaction,
  projectSessionGoalPromptField,
  recoverSessionDispatch,
  recordSessionGoalProgressWithEvent,
  sendAgentMessageInTransaction,
  setSessionGoalStatusWithEvent,
  steerAgentSessionInTransaction,
  submitHumanPromptInTransaction,
  updateCodexRotationSettings,
  updateSessionGoalWithEvent,
  upsertSessionGoalWithEvent,
  withWorkspaceSessionActivityRls as withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
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

async function runningGoalFixture(
  options: {
    withAncestor?: boolean;
    mutationPolicy?: "review_changes" | "preserve_intent" | "autonomous_adaptation";
    personalConnectionDelegations?:
      | McpPersonalConnectionDelegation[]
      | ((subjectId: string) => McpPersonalConnectionDelegation[]);
  } = {},
) {
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
  const personalConnectionDelegations =
    typeof options.personalConnectionDelegations === "function"
      ? options.personalConnectionDelegations(grant.subjectId)
      : (options.personalConnectionDelegations ?? []);
  const ancestor = options.withAncestor
    ? await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "ancestor",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
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
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    personalConnectionDelegations,
  });
  const initialized = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: {
      text: "Finish the durable wake proof",
      mutationPolicy: options.mutationPolicy ?? "preserve_intent",
    },
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
  return {
    grant,
    ancestor,
    session,
    initialized,
    turn: claimed.turn,
    attemptId,
  };
}

type GoalFixture = Awaited<ReturnType<typeof runningGoalFixture>>;

function goalCommand(
  ctx: GoalFixture,
  input: {
    attemptId: string;
    executionGeneration: number;
    operationKey: string;
  },
) {
  return {
    accountId: ctx.grant.accountId,
    actor: {
      type: "agent_attempt" as const,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      attemptId: input.attemptId,
      executionGeneration: input.executionGeneration,
    },
    operationKey: input.operationKey,
  };
}

async function beforeLockTimeout<T>(work: Promise<T>): Promise<T> {
  const timeout = Symbol("lock inversion timeout");
  const completed = await Promise.race([work, Bun.sleep(3_000).then(() => timeout)]);
  expect(completed).not.toBe(timeout);
  if (completed === timeout) throw new Error("goal mutation lock inversion timed out");
  return completed as T;
}

async function expectRejectionContaining(
  work: PromiseLike<unknown>,
  expectedMessage: string,
): Promise<void> {
  let rejection: unknown;
  try {
    await work;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(expectedMessage);
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
    budgetBlocked: null,
    policy: {
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard" as const,
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
  test("agent goal_set rejects live goals and replaces completed goals", async () => {
    const ctx = await runningGoalFixture();
    await expect(
      upsertSessionGoalWithEvent(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId!,
        sessionId: ctx.session.id,
        text: "Agent must not replace this goal",
        createdBy: "agent",
        actor: "agent",
      }),
    ).rejects.toThrow("agent goal_set cannot replace a goal while it is active");
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.text,
    ).toBe("Finish the durable wake proof");

    await setSessionGoalStatusWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "completed",
      evidence: "The original objective is done",
      event: { type: "goal.completed", evidence: "The original objective is done" },
    });
    const replacement = await upsertSessionGoalWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      text: "Pursue the next durable objective",
      createdBy: "agent",
      actor: "agent",
    });
    expect(replacement.replaced).toBe(true);
    expect(replacement.goal).toMatchObject({
      status: "active",
      text: "Pursue the next durable objective",
      evidence: null,
      objectiveRevision: 2,
    });
    expect(replacement.events.map((event) => event.type)).toEqual(["goal.set"]);
  });

  test("accepted turns freeze exact goal or no-goal authority and recovery reuses it", async () => {
    const ctx = await runningGoalFixture();
    expect(ctx.turn.goalSnapshot).toMatchObject({
      state: "active",
      text: "Finish the durable wake proof",
      objectiveRevision: 1,
      mutationPolicy: "preserve_intent",
    });
    const initialHistory = await shared.admin<Array<{ item: Record<string, unknown> }>>`
      select item from session_history_items
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and turn_id = ${ctx.turn.id}
      order by position`;
    expect(JSON.stringify(initialHistory[0]?.item)).toContain(SESSION_GOAL_CONTEXT_LABEL);
    expect(JSON.stringify(initialHistory[0]?.item)).toContain("Finish the durable wake proof");

    await withWorkspaceSubjectRls(client.db, ctx.grant.workspaceId!, ctx.grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          subjectId: ctx.grant.subjectId,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "additional context that must not redirect the goal",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const current = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    if (!current) throw new Error("goal fixture missing");
    await updateSessionGoalWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      text: "Redirected after both turns were accepted",
      changeKind: "replacement",
      rationale: "explicit API redirect",
      expectedObjectiveRevision: current.objectiveRevision,
      actor: "api",
    });

    const queued = await shared.admin<Array<{ goal_snapshot: Record<string, unknown> }>>`
      select goal_snapshot from session_turns
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
        and status = 'queued'
      order by position limit 1`;
    expect(queued[0]?.goal_snapshot).toMatchObject({
      state: "active",
      text: "Finish the durable wake proof",
      objectiveRevision: 1,
    });

    expect(
      (
        await recoverSessionDispatch(client.db, ctx.grant.workspaceId!, {
          sessionId: ctx.session.id,
          attemptId: ctx.attemptId,
          timeoutType: "HEARTBEAT",
          maxRedispatches: 3,
        })
      ).action,
    ).toBe("recovering");
    const recovered = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(recovered.action).toBe("claimed");
    if (recovered.action !== "claimed") throw new Error("recovery was not claimed");
    expect(recovered.turn.goalSnapshot).toMatchObject({
      text: "Finish the durable wake proof",
      objectiveRevision: 1,
    });
    const recoveredHistory = await shared.admin<Array<{ item: Record<string, unknown> }>>`
      select item from session_history_items
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and turn_id = ${ctx.turn.id}
      order by position`;
    expect(recoveredHistory).toEqual(initialHistory);
  });

  test("a goal created after a no-goal turn is queued cannot leak into that turn", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "goal-snapshot-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Goal snapshot test",
      workspaceExternalSource: "goal-snapshot-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Goal snapshot test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "queue without a standing goal",
      resources: [],
      tools: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    const initialized = await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    if (!initialized.turn) throw new Error("initial turn missing");
    await upsertSessionGoalWithEvent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      text: "Created only after acceptance",
      createdBy: "api",
      actor: "api",
    });
    const [row] = await shared.admin<Array<{ goal_snapshot: Record<string, unknown> }>>`
      select goal_snapshot from session_turns where id = ${initialized.turn.id}`;
    expect(row?.goal_snapshot).toMatchObject({ state: "none" });
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("no-goal turn was not claimed");
    expect(claimed.turn.goalSnapshot).toMatchObject({ state: "none" });
  });

  test("legacy null snapshots reconstruct resumed lifecycle with the prior full objective", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    await setSessionGoalStatusWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "paused",
      rationale: "test pause",
      pausedReason: "api",
      event: { type: "goal.paused", actor: "api", reason: "api" },
    });
    await setSessionGoalStatusWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "active",
      event: { type: "goal.resumed", actor: "api" },
    });
    await withWorkspaceSubjectRls(client.db, ctx.grant.workspaceId!, ctx.grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          subjectId: ctx.grant.subjectId,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "work accepted after resume",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const [queued] = await shared.admin<Array<{ id: string }>>`
      select id from session_turns
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
        and status = 'queued'
      order by created_at desc limit 1`;
    if (!queued) throw new Error("post-resume turn missing");
    await shared.admin`alter table session_turns disable trigger session_turns_goal_snapshot_immutable`;
    try {
      await shared.admin`update session_turns set goal_snapshot = null where id = ${queued.id}`;
    } finally {
      await shared.admin`alter table session_turns enable trigger session_turns_goal_snapshot_immutable`;
    }
    const recovered = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(recovered.action).toBe("claimed");
    if (recovered.action !== "claimed") throw new Error("legacy turn was not reclaimed");
    expect(recovered.turn.goalSnapshot).toMatchObject({
      state: "active",
      text: "Finish the durable wake proof",
      objectiveRevision: 1,
    });
  });

  test("oversized legacy goals remain lifecycle-safe and freeze one bounded exact projection", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    const legacyText = `legacy-${"🙂".repeat(3_000)}`;
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        update session_goals set text = ${legacyText}
        where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}`;
    });

    await setSessionGoalStatusWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "paused",
      rationale: "legacy lifecycle update remains legal",
      pausedReason: "api",
      event: { type: "goal.paused", actor: "api", reason: "api" },
    });
    await setSessionGoalStatusWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "active",
      event: { type: "goal.resumed", actor: "api" },
    });
    await withWorkspaceSubjectRls(client.db, ctx.grant.workspaceId!, ctx.grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          subjectId: ctx.grant.subjectId,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "accept a turn against the legacy goal",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const [queued] = await shared.admin<Array<{ id: string; goal_snapshot: { text: string } }>>`
      select id, goal_snapshot from session_turns
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
        and status = 'queued'
      order by created_at desc limit 1`;
    if (!queued) throw new Error("legacy projection turn missing");
    const expected = projectSessionGoalPromptField(legacyText, SESSION_GOAL_TEXT_MAX_BYTES);
    const [sqlProjection] = await shared.admin<Array<{ value: string }>>`
      select session_goal_prompt_projection(${legacyText}, ${SESSION_GOAL_TEXT_MAX_BYTES}) as value`;
    expect(sqlProjection?.value).toBe(expected);
    expect(queued.goal_snapshot.text).toBe(expected);
    expect(Buffer.byteLength(queued.goal_snapshot.text, "utf8")).toBeLessThanOrEqual(
      SESSION_GOAL_TEXT_MAX_BYTES,
    );
    expect(Buffer.byteLength(queued.goal_snapshot.text, "utf8")).toBeGreaterThan(
      SESSION_GOAL_TEXT_MAX_BYTES - 4,
    );
    expect(queued.goal_snapshot.text).toContain(
      `[truncated; original UTF-8 bytes=${Buffer.byteLength(legacyText, "utf8")}]`,
    );
    const [canonical] = await shared.admin<Array<{ text: string }>>`
      select text from session_goals where session_id = ${ctx.session.id}`;
    expect(canonical?.text).toBe(legacyText);

    const legacyAttemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: legacyAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("legacy projection turn was not claimed");
    expect(claimed.turn.goalSnapshot).toMatchObject({ text: expected });
    expect(
      (
        await recoverSessionDispatch(client.db, ctx.grant.workspaceId!, {
          sessionId: ctx.session.id,
          attemptId: legacyAttemptId,
          timeoutType: "HEARTBEAT",
          maxRedispatches: 3,
        })
      ).action,
    ).toBe("recovering");
    const recovered = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(recovered.action).toBe("claimed");
    if (recovered.action !== "claimed") throw new Error("legacy projection recovery failed");
    expect(recovered.turn.goalSnapshot).toMatchObject({ text: expected });

    await expectRejectionContaining(
      shared.admin`
        update session_goals set text = ${`${legacyText}x`}
        where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}`,
      "goal text exceeds 8192 UTF-8 bytes",
    );
  });

  test("API redirect wakes an idle goal while policy-controlled agent changes remain fenced", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    const original = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    if (!original) throw new Error("goal fixture missing");
    const redirected = await upsertSessionGoalWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      text: "Explicit human redirect",
      successCriteria: "The redirected objective is pursued",
      mutationPolicy: "review_changes",
      expectedObjectiveRevision: original.objectiveRevision,
      changeKind: "replacement",
      changeRationale: "user changed direction",
      createdBy: "api",
      actor: "api",
    });
    expect(redirected).toMatchObject({
      replaced: true,
      goal: { objectiveRevision: 2, mutationPolicy: "review_changes" },
    });
    expect(redirected.workflowWakeRevision).toBeNumber();
    expect((await materialize(ctx)).action).toBe("continue");

    const attempt = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(attempt.action).toBe("claimed");
    if (attempt.action !== "claimed") throw new Error("redirect wake was not claimable");
    const proposed = await updateSessionGoalWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        text: "Agent replacement awaiting review",
        changeKind: "replacement",
        rationale: "new evidence suggests a different objective",
        expectedObjectiveRevision: redirected.goal.objectiveRevision,
        actor: "agent",
        command: {
          accountId: ctx.grant.accountId,
          actor: {
            type: "agent_attempt",
            sessionId: ctx.session.id,
            turnId: attempt.turn.id,
            attemptId: attempt.turn.activeAttemptId!,
            executionGeneration: attempt.turn.executionGeneration,
          },
          operationKey: crypto.randomUUID(),
        },
      },
    );
    expect(proposed).toMatchObject({
      outcome: "proposed",
      goal: { text: "Explicit human redirect", objectiveRevision: 2 },
    });
    expect(proposed.proposalId).toBeTruthy();
    const revisions = await listSessionGoalRevisions(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    const proposal = revisions.find((revision) => revision.id === proposed.proposalId);
    expect(proposal).toMatchObject({
      disposition: "proposed",
      text: "Agent replacement awaiting review",
      baseObjectiveRevision: 2,
    });
    if (!proposal) throw new Error("persisted proposal missing");
    const applied = await upsertSessionGoalWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      text: proposal.text,
      successCriteria: proposal.successCriteria,
      mutationPolicy: proposal.mutationPolicy,
      expectedObjectiveRevision: 2,
      expectedGoalId: proposal.goalId,
      changeKind: proposal.changeKind,
      changeRationale: "user accepted the reviewed proposal",
      sourceProposalId: proposal.id,
      createdBy: "api",
      actor: "api",
    });
    expect(applied.goal).toMatchObject({
      text: "Agent replacement awaiting review",
      objectiveRevision: 3,
    });
    const afterApply = await listSessionGoalRevisions(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    expect(afterApply).toContainEqual(
      expect.objectContaining({
        disposition: "applied",
        resultObjectiveRevision: 3,
        proposalId: proposal.id,
      }),
    );
    expect(afterApply.find((revision) => revision.id === proposal.id)?.disposition).toBe(
      "proposed",
    );
    await expectRejectionContaining(
      shared.admin`update session_goal_revisions set rationale = 'mutated' where id = ${proposal.id}`,
      "session goal revisions are immutable",
    );
    await expectRejectionContaining(
      shared.admin`delete from session_goal_revisions where id = ${proposal.id}`,
      "session goal revisions are immutable",
    );
    await expect(
      upsertSessionGoalWithEvent(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId!,
        sessionId: ctx.session.id,
        text: proposal.text,
        successCriteria: proposal.successCriteria,
        mutationPolicy: proposal.mutationPolicy,
        expectedObjectiveRevision: 2,
        expectedGoalId: proposal.goalId,
        changeKind: proposal.changeKind,
        changeRationale: "stale duplicate apply",
        sourceProposalId: proposal.id,
        createdBy: "api",
        actor: "api",
      }),
    ).rejects.toThrow("expected 2, current 3");
  });

  test("goal progress is idempotent and does not mutate semantic or wake revisions", async () => {
    const ctx = await runningGoalFixture();
    const before = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    if (!before) throw new Error("goal fixture missing");
    const operationKey = crypto.randomUUID();
    const progress = await recordSessionGoalProgressWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        progressNote: "Implemented and verified one concrete slice",
        command: goalCommand(ctx, {
          attemptId: ctx.attemptId,
          executionGeneration: ctx.turn.executionGeneration,
          operationKey,
        }),
      },
    );
    expect(progress).toMatchObject({
      replay: false,
      goal: { version: before.version },
    });
    expect(progress.goal.objectiveRevision).toBe(before.objectiveRevision);
    const replay = await recordSessionGoalProgressWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        progressNote: "Implemented and verified one concrete slice",
        command: goalCommand(ctx, {
          attemptId: ctx.attemptId,
          executionGeneration: ctx.turn.executionGeneration,
          operationKey,
        }),
      },
    );
    expect(replay).toMatchObject({ replay: true, events: [] });
  });

  test("preserve-intent refinements and autonomous adaptations apply without proposal", async () => {
    const ctx = await runningGoalFixture();
    const refined = await updateSessionGoalWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        text: "Finish the durable wake proof with focused verification",
        changeKind: "refinement",
        rationale: "clarifies the unchanged delivery intent",
        expectedObjectiveRevision: 1,
        actor: "agent",
        command: goalCommand(ctx, {
          attemptId: ctx.attemptId,
          executionGeneration: ctx.turn.executionGeneration,
          operationKey: crypto.randomUUID(),
        }),
      },
    );
    expect(refined).toMatchObject({
      outcome: "applied",
      goal: { objectiveRevision: 2 },
    });

    const autonomous = await upsertSessionGoalWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      text: refined.goal.text,
      successCriteria: refined.goal.successCriteria,
      mutationPolicy: "autonomous_adaptation",
      expectedObjectiveRevision: 2,
      changeKind: "refinement",
      changeRationale: "user enables autonomous adaptation",
      createdBy: "api",
      actor: "api",
    });
    const adapted = await updateSessionGoalWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        text: "Adapt autonomously to prove the alternate durable wake path",
        changeKind: "adaptation",
        rationale: "the primary path is unavailable and equivalent evidence is available",
        expectedObjectiveRevision: autonomous.goal.objectiveRevision,
        actor: "agent",
        command: goalCommand(ctx, {
          attemptId: ctx.attemptId,
          executionGeneration: ctx.turn.executionGeneration,
          operationKey: crypto.randomUUID(),
        }),
      },
    );
    expect(adapted).toMatchObject({
      outcome: "applied",
      goal: { objectiveRevision: 4 },
    });
  });

  test("goal continuation freezes the exact finished causal turn authority and lineage", async () => {
    const connectionId = crypto.randomUUID();
    const ctx = await runningGoalFixture({
      personalConnectionDelegations: (subjectId) => [
        {
          serverId: "linear",
          connectionId,
          ownerSubjectId: subjectId,
          providerDomain: "linear.app",
          kind: "oauth2",
        },
      ],
    });
    const personalGitHubDelegation: McpPersonalConnectionDelegation = {
      serverId: "github:personal",
      connectionId: crypto.randomUUID(),
      originWorkspaceId: crypto.randomUUID(),
      ownerSubjectId: ctx.grant.subjectId,
      providerDomain: "github.com",
      kind: "oauth2",
      connectionType: "github_personal",
      userDelegation: {
        organizationId: crypto.randomUUID(),
        authorityId: crypto.randomUUID(),
        authorityGeneration: 1,
        workspaceId: crypto.randomUUID(),
        sessionId: null,
        action: "connection.use",
        mode: "always",
        context: "workspace_shared",
        authorityEpoch: null,
        grantId: crypto.randomUUID(),
        grantGeneration: 1,
      },
      personalGitHubRepositorySelection: {
        credentialBindingId: crypto.randomUUID(),
        connectionAuthorityGeneration: 1,
        selectionGeneration: 1,
        repositories: [
          {
            repositoryId: "9007199254740993123",
            fullName: "octocat/private-repository",
            canonicalUrl: "https://github.com/octocat/private-repository",
            ref: "main",
            access: "read",
            selectionGeneration: 1,
          },
        ],
      },
    };
    const delegations = [...ctx.turn.personalConnectionDelegations, personalGitHubDelegation];
    // Simulate a snapshot written by the future personal-GitHub lifecycle without
    // asking today's capture trigger to re-admit authority that the machine-input
    // phase has not activated. The behavior under test is successor projection.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        update session_turns
        set personal_connection_delegations = ${tx.json(delegations)}::jsonb
        where workspace_id = ${ctx.grant.workspaceId!}
          and session_id = ${ctx.session.id}
          and id = ${ctx.turn.id}
      `;
    });
    const successorDelegations = delegations.filter(
      (delegation) => delegation.connectionType !== "github_personal",
    );
    await settleIdle(ctx);

    expect((await materialize(ctx)).action).toBe("continue");
    const [materialized] = await shared.admin<
      Array<{
        personal_connection_delegations: McpPersonalConnectionDelegation[];
        lineage: Record<string, unknown>;
      }>
    >`
      select personal_connection_delegations, lineage
      from session_system_updates
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and kind = 'goal_continuation'
    `;
    expect(materialized?.personal_connection_delegations).toEqual(successorDelegations);
    expect(materialized?.lineage).toMatchObject({ causalTurnId: ctx.turn.id });

    const replacementDelegations: McpPersonalConnectionDelegation[] = [
      {
        ...delegations[0]!,
        connectionId: crypto.randomUUID(),
      },
    ];
    await withWorkspaceSubjectRls(client.db, ctx.grant.workspaceId!, ctx.grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          subjectId: ctx.grant.subjectId,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "new unrelated human work",
          resources: [],
          model: "scripted-model",
          reasoningEffort: "low",
          reasoningEffortFallback: "low",
          source: "user",
          personalConnectionDelegations: replacementDelegations,
        }),
      ),
    );
    const [afterUnrelatedTurn] = await shared.admin<
      Array<{
        personal_connection_delegations: McpPersonalConnectionDelegation[];
      }>
    >`
      select personal_connection_delegations
      from session_system_updates
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and kind = 'goal_continuation'
    `;
    expect(afterUnrelatedTurn?.personal_connection_delegations).toEqual(successorDelegations);
  });

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
    ).toMatchObject({
      state: "scheduled",
      reason: "wake_pending",
      lastError: null,
    });
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

  test("quarantines malformed legacy versions and materializes valid work exactly once", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    const [goal] = await shared.admin<{ id: string }[]>`
      select id
      from session_goals
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}`;
    if (!goal) throw new Error("goal fixture was not created");
    const malformedPrefix = `malformed-goal-continuation:${crypto.randomUUID()}:`;
    const malformedCases = [
      { label: "absent", goalVersion: undefined },
      { label: "json-null", goalVersion: null },
      { label: "non-number", goalVersion: "not-an-integer" },
      { label: "non-positive", goalVersion: 0 },
      { label: "mismatched", goalVersion: 2 },
    ] as const;
    for (const malformed of malformedCases) {
      await shared.admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload
        ) values (
          ${ctx.grant.accountId}, ${ctx.grant.workspaceId!}, ${ctx.session.id},
          'goal_continuation', ${goal.id},
          ${`${malformedPrefix}${malformed.label}`}, 'legacy malformed continuation',
          ${shared.admin.json({
            type: "goal_continuation",
            goalId: goal.id,
            ...(malformed.goalVersion === undefined ? {} : { goalVersion: malformed.goalVersion }),
            prompt: "continue from the legacy obligation",
            policy: {
              model: "scripted-model",
              reasoningEffort: "low",
              tools: [],
              sandboxBackend: "none",
            },
          })}
        )`;
    }

    // The read path ignores the malformed row rather than casting it or
    // reporting a false continuation_pending state.
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation,
    ).toMatchObject({ state: "scheduled", reason: "wake_pending" });

    expect((await materialize(ctx)).action).toBe("continue");
    expect((await materialize(ctx)).action).toBe("continue");

    const quarantined = await shared.admin<
      Array<{
        dedupe_key: string;
        state: string;
        classification: string;
        summary: string;
        payload: Record<string, unknown>;
        lineage: Record<string, unknown>;
        raw_goal_version: string | null;
      }>
    >`
      select dedupe_key, state, classification, summary, payload, lineage,
        payload -> 'quarantine' ->> 'rawGoalVersion' as raw_goal_version
      from session_system_updates
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
        and dedupe_key like ${`${malformedPrefix}%`}
      order by dedupe_key`;
    expect(quarantined).toHaveLength(malformedCases.length);
    expect(
      quarantined.map(({ dedupe_key, raw_goal_version }) => [
        dedupe_key.slice(malformedPrefix.length),
        raw_goal_version,
      ]),
    ).toEqual([
      ["absent", null],
      ["json-null", null],
      ["mismatched", "2"],
      ["non-number", "not-an-integer"],
      ["non-positive", "0"],
    ]);
    for (const row of quarantined) {
      expect(row).toMatchObject({
        state: "failed",
        classification: "failure",
        summary: "Malformed goal continuation quarantined: malformed_goal_version",
        payload: {
          type: "goal_continuation",
          goalId: goal.id,
          goalVersion: 1,
          prompt: "continue from the legacy obligation",
          quarantine: {
            reason: "malformed_goal_version",
            expectedGoalVersion: 1,
          },
        },
        lineage: {
          quarantine: {
            reason: "malformed_goal_version",
            expectedGoalVersion: 1,
          },
        },
      });
    }

    const outstanding = await listOutstandingSessionSystemUpdates(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]).toMatchObject({
      state: "pending",
      payload: { type: "goal_continuation", goalId: goal.id, goalVersion: 1 },
    });
    expect(await counts(ctx)).toEqual({
      autoContinuations: 1,
      wakeRevision: 1,
      observedRevision: 1,
      updates: malformedCases.length + 1,
      usage: 1,
      events: 1,
    });
  });

  test("a recovered attempt reconciles an ambiguously committed goal update without overwriting newer truth", async () => {
    const ctx = await runningGoalFixture({ mutationPolicy: "autonomous_adaptation" });
    const firstKey = crypto.randomUUID();
    const secondKey = crypto.randomUUID();

    await expect(
      (async () => {
        await updateSessionGoalWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
          text: "Committed before the caller lost its response",
          progressNote: "first attempt persisted",
          changeKind: "refinement",
          rationale: "preserve the accepted objective while recording recovery evidence",
          expectedObjectiveRevision: 1,
          actor: "agent",
          command: goalCommand(ctx, {
            attemptId: ctx.attemptId,
            executionGeneration: ctx.turn.executionGeneration,
            operationKey: firstKey,
          }),
        });
        throw new Error("simulated caller-visible response loss after commit");
      })(),
    ).rejects.toThrow("simulated caller-visible response loss after commit");

    const recovered = await recoverSessionDispatch(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      attemptId: ctx.attemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 3,
    });
    expect(recovered.action).toBe("recovering");

    const replacementAttemptId = crypto.randomUUID();
    const replacement = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: replacementAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(replacement.action).toBe("claimed");
    if (replacement.action !== "claimed") throw new Error("replacement attempt was not claimed");
    expect(replacement.turn.id).toBe(ctx.turn.id);
    expect(replacement.turn.executionGeneration).toBe(ctx.turn.executionGeneration + 1);

    const replayed = await updateSessionGoalWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        text: "Committed before the caller lost its response",
        progressNote: "first attempt persisted",
        changeKind: "refinement",
        rationale: "preserve the accepted objective while recording recovery evidence",
        expectedObjectiveRevision: 1,
        actor: "agent",
        command: goalCommand(ctx, {
          attemptId: replacementAttemptId,
          executionGeneration: replacement.turn.executionGeneration,
          operationKey: firstKey,
        }),
      },
    );
    expect(replayed).toMatchObject({
      replay: true,
      events: [],
      goal: { version: 2 },
    });
    expect(replayed.operationId).toBeTruthy();

    const newer = await updateSessionGoalWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        text: "Newer recovered-attempt direction remains authoritative",
        progressNote: "replacement attempt advanced the goal",
        changeKind: "adaptation",
        rationale: "the recovered attempt received newer authoritative direction",
        expectedObjectiveRevision: 2,
        actor: "agent",
        command: goalCommand(ctx, {
          attemptId: replacementAttemptId,
          executionGeneration: replacement.turn.executionGeneration,
          operationKey: secondKey,
        }),
      },
    );
    expect(newer).toMatchObject({ replay: false, goal: { version: 3 } });
    expect(newer.operationId).not.toBe(replayed.operationId);
    if (!replayed.operationId || !newer.operationId) {
      throw new Error("receipted goal updates must return operation IDs");
    }

    const oldReplay = await updateSessionGoalWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        text: "Committed before the caller lost its response",
        progressNote: "first attempt persisted",
        changeKind: "refinement",
        rationale: "preserve the accepted objective while recording recovery evidence",
        expectedObjectiveRevision: 1,
        actor: "agent",
        command: goalCommand(ctx, {
          attemptId: replacementAttemptId,
          executionGeneration: replacement.turn.executionGeneration,
          operationKey: firstKey,
        }),
      },
    );
    expect(oldReplay).toMatchObject({
      replay: true,
      operationId: replayed.operationId,
      events: [],
      goal: {
        version: 2,
        text: "Committed before the caller lost its response",
      },
    });
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.version,
    ).toBe(3);

    await expect(
      updateSessionGoalWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
        text: "Conflicting reuse must not apply",
        changeKind: "replacement",
        rationale: "exercise conflicting receipt reuse",
        expectedObjectiveRevision: 3,
        actor: "agent",
        command: goalCommand(ctx, {
          attemptId: replacementAttemptId,
          executionGeneration: replacement.turn.executionGeneration,
          operationKey: firstKey,
        }),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const receipts = await shared.admin<
      Array<{
        id: string;
        operationKey: string;
        actorAttemptId: string;
        goalVersion: number;
      }>
    >`
      select id, operation_key as "operationKey", actor_attempt_id as "actorAttemptId",
             (result ->> 'goalVersion')::int as "goalVersion"
      from session_command_receipts
      where workspace_id = ${ctx.grant.workspaceId!}
        and target_session_id = ${ctx.session.id}
        and action = 'goal.update'
      order by created_at, id`;
    expect([...receipts]).toEqual([
      {
        id: replayed.operationId,
        operationKey: firstKey,
        actorAttemptId: ctx.attemptId,
        goalVersion: 2,
      },
      {
        id: newer.operationId,
        operationKey: secondKey,
        actorAttemptId: replacementAttemptId,
        goalVersion: 3,
      },
    ]);
    const [eventCount] = await shared.admin`
      select count(*)::int as count
      from session_events
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and type = 'goal.updated'`;
    expect(Number(eventCount!.count)).toBe(2);

    const settled = await applySessionTurnSettlement(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      turnId: replacement.turn.id,
      triggerEventId: replacement.turn.triggerEventId,
      attemptId: replacementAttemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
    expect((await materialize(ctx)).action).toBe("continue");
    const [continuation] = await shared.admin<{ payload: { goalVersion?: number } }[]>`
      select payload
      from session_system_updates
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and kind = 'goal_continuation'`;
    expect(continuation?.payload.goalVersion).toBe(3);
  });

  test("projects only a live goal attempt as running while worker recovery is scheduled", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    expect((await materialize(ctx)).action).toBe("continue");
    const [pendingContinuation] = await shared.admin<
      Array<{ summary: string; payload: { prompt?: string } }>
    >`
      select summary, payload from session_system_updates
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and kind = 'goal_continuation'
        and state = 'pending'`;
    expect(pendingContinuation).toMatchObject({
      summary: "Continue active session goal",
      payload: { prompt: "continue Finish the durable wake proof (1)" },
    });

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
    expect(claimed.turn.initiator).toMatchObject({
      kind: "service",
      subjectId: "goal-continuation",
    });
    expect(claimed.turn.initiatingHumanSubjectId).toBe(ctx.grant.subjectId);
    const continuationHistory = await shared.admin<Array<{ item: Record<string, unknown> }>>`
      select item from session_history_items
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and turn_id = ${claimed.turn.id}
      order by position`;
    expect(continuationHistory[0]?.item).toMatchObject({ type: "message", role: "user" });
    const continuationModelInput = JSON.stringify(continuationHistory[0]?.item);
    expect(continuationModelInput).toContain(SESSION_GOAL_CONTEXT_LABEL);
    expect(continuationModelInput).toContain("continue Finish the durable wake proof (1)");
    expect(continuationModelInput).not.toContain("[OpenGeni internal updates]");
    expect(
      continuationModelInput.match(/continue Finish the durable wake proof \(1\)/g) ?? [],
    ).toHaveLength(1);
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

  test("reserves running for the active goal attempt while human work remains authoritative", async () => {
    const human = await runningGoalFixture();
    expect(
      (await getSessionGoalWithContinuation(client.db, human.grant.workspaceId!, human.session.id))
        ?.continuation,
    ).toMatchObject({ state: "blocked", reason: "human_turn_running" });

    const recovered = await recoverSessionDispatch(client.db, human.grant.workspaceId!, {
      sessionId: human.session.id,
      attemptId: human.attemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 3,
    });
    expect(recovered.action).toBe("recovering");
    expect(
      (await getSessionGoalWithContinuation(client.db, human.grant.workspaceId!, human.session.id))
        ?.continuation,
    ).toMatchObject({ state: "scheduled", reason: "human_work_pending" });

    const goal = await runningGoalFixture();
    await settleIdle(goal);
    expect((await materialize(goal)).action).toBe("continue");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, goal.grant.workspaceId!, {
      sessionId: goal.session.id,
      workflowId: `session-${goal.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("goal continuation was not claimed");
    expect(claimed.turn.source).toBe("goal");

    await withWorkspaceSubjectRls(client.db, goal.grant.workspaceId!, goal.grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: goal.grant.accountId,
          workspaceId: goal.grant.workspaceId!,
          sessionId: goal.session.id,
          subjectId: goal.grant.subjectId,
          actor: { type: "human", subjectId: goal.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "authoritative next human direction",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const openTurns = await shared.admin<
      Array<{ source: string; status: string; position: number }>
    >`
      select source, status, position
      from session_turns
      where workspace_id = ${goal.grant.workspaceId!} and session_id = ${goal.session.id}
        and status in ('queued', 'running')
      order by position`;
    expect(openTurns.map(({ source, status }) => ({ source, status }))).toEqual([
      { source: "user", status: "queued" },
      { source: "goal", status: "running" },
    ]);
    expect(Number(openTurns[0]!.position)).toBeLessThan(Number(openTurns[1]!.position));
    expect(
      (await getSessionGoalWithContinuation(client.db, goal.grant.workspaceId!, goal.session.id))
        ?.continuation,
    ).toMatchObject({ state: "running", reason: "goal_turn_running" });
  });

  test("keeps coalesced machine context inside the canonical user-role continuation", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    expect((await materialize(ctx)).action).toBe("continue");
    const contextUpdate = await addSessionSystemUpdate(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `goal-context-${crypto.randomUUID()}`,
      summary: "New execution evidence",
      payload: {
        type: "agent_message",
        text: "New execution evidence",
        operationId: crypto.randomUUID(),
      },
    });
    if (!contextUpdate.added) throw new Error("context update was not inserted");

    const claimed = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("goal continuation was not claimed");
    expect(claimed.turn.source).toBe("goal");

    const [history] = await shared.admin<Array<{ item: Record<string, unknown> }>>`
      select item from session_history_items
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and turn_id = ${claimed.turn.id}`;
    expect(history?.item).toMatchObject({ type: "message", role: "user" });
    const input = JSON.stringify(history?.item);
    expect(input).toContain("[Application context attached to this user message]");
    expect(input).toContain("New execution evidence");
    expect(input).toContain("continue Finish the durable wake proof (1)");
    expect(input).not.toContain("goal_continuation");
  });

  test("recursive Pause suppresses synthesis and Resume re-arms the same pending revision", async () => {
    const ctx = await runningGoalFixture({ withAncestor: true });
    if (!ctx.ancestor) throw new Error("ancestor fixture was not created");
    await settleIdle(ctx);

    const control = async (sessionId: string, action: "pause" | "resume") =>
      await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as typeof db, {
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

  test("terminal and corrupt idle sessions refuse or repair goal work", async () => {
    const failed = await runningGoalFixture();
    await settleIdle(failed);
    await shared.admin`
      update sessions set status = 'failed'
      where workspace_id = ${failed.grant.workspaceId!} and id = ${failed.session.id}`;
    expect((await materialize(failed)).action).toBe("none");
    expect(await counts(failed)).toMatchObject({ updates: 0, usage: 0, events: 0 });

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
    expect(await counts(cancelled)).toMatchObject({
      updates: 0,
      usage: 0,
      events: 0,
    });

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
      const functionName = `durable_goal_wake_fault_${suffix}`;
      const triggerName = `durable_goal_wake_fault_${suffix}`;
      await shared.admin.unsafe(`
        create function ${functionName}() returns trigger language plpgsql as $$
        begin
          raise exception 'injected durable goal wake ${fault.name} failure';
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

  test("a human Send supersedes a materialized continuation before claim", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    expect((await materialize(ctx)).action).toBe("continue");
    const [pending] = await shared.admin<Array<{ id: string }>>`
      select id from session_system_updates
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and kind = 'goal_continuation'
        and state = 'pending'`;
    if (!pending) throw new Error("materialized continuation missing");
    const submitted = await withWorkspaceSubjectRls(
      client.db,
      ctx.grant.workspaceId!,
      ctx.grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            accountId: ctx.grant.accountId,
            workspaceId: ctx.grant.workspaceId!,
            sessionId: ctx.session.id,
            subjectId: ctx.grant.subjectId,
            actor: { type: "human", subjectId: ctx.grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "human direction wins",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
    );
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
    expect(next.turn.id).toBe(submitted.turn.id);
    const [goalTurns] = await shared.admin`
      select count(*)::int as count from session_turns
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
        and source = 'goal'`;
    expect(Number(goalTurns!.count)).toBe(0);
    const [superseded] = await shared.admin<
      Array<{ state: string; delivered_turn_id: string | null }>
    >`
      select state, delivered_turn_id
      from session_system_updates
      where id = ${pending.id}`;
    expect(superseded).toEqual({ state: "superseded", delivered_turn_id: null });
    const [cancelled] = await shared.admin<
      Array<{ turn_id: string | null; turn_attempt_id: string | null }>
    >`
      select turn_id, turn_attempt_id
      from session_events
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and type = 'system.update.cancelled'
        and payload ->> 'reason' = 'superseded_by_authoritative_input'
      order by sequence desc
      limit 1`;
    expect(cancelled).toEqual({ turn_id: next.turn.id, turn_attempt_id: nextAttemptId });
    expect(await counts(ctx)).toMatchObject({ autoContinuations: 0 });
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        ctx.grant.workspaceId!,
        ctx.session.id,
        next.turn.id,
      ),
    ).toEqual([]);
  });

  test("a realtime-delegated human turn supersedes only the pending continuation", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    expect((await materialize(ctx)).action).toBe("continue");
    const [pendingGoal] = await shared.admin<Array<{ id: string }>>`
      select id from session_system_updates
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and kind = 'goal_continuation'
        and state = 'pending'`;
    if (!pendingGoal) throw new Error("materialized continuation missing");
    const other = await addSessionSystemUpdate(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `realtime-context-${crypto.randomUUID()}`,
      summary: "Already projected to realtime",
      payload: {
        type: "agent_message",
        text: "Already projected to realtime",
        operationId: crypto.randomUUID(),
      },
    });
    if (!other.added) throw new Error("context update was not inserted");
    const submitted = await withWorkspaceSubjectRls(
      client.db,
      ctx.grant.workspaceId!,
      ctx.grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            accountId: ctx.grant.accountId,
            workspaceId: ctx.grant.workspaceId!,
            sessionId: ctx.session.id,
            subjectId: ctx.grant.subjectId,
            actor: { type: "human", subjectId: ctx.grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "provider-delegated human direction",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
    );
    await shared.admin`
      update session_turns
      set metadata = jsonb_build_object(
        'realtimeDelegation', jsonb_build_object(
          'realtimeId', ${crypto.randomUUID()}::text,
          'connectionEpoch', 1,
          'delegationItemId', ${crypto.randomUUID()}::text,
          'ledgerEntryId', ${crypto.randomUUID()}::text
        )
      )
      where id = ${submitted.turn.id}`;

    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed).toMatchObject({ action: "claimed", turn: { id: submitted.turn.id } });
    const updates = await shared.admin<Array<{ id: string; state: string }>>`
      select id, state from session_system_updates
      where id in (${pendingGoal.id}, ${other.update.id})
      order by id`;
    expect(updates.find((update) => update.id === pendingGoal.id)?.state).toBe("superseded");
    expect(updates.find((update) => update.id === other.update.id)?.state).toBe("pending");
    expect(await counts(ctx)).toMatchObject({ autoContinuations: 0 });
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        ctx.grant.workspaceId!,
        ctx.session.id,
        submitted.turn.id,
      ),
    ).toEqual([]);
  });

  test("a racing Steer supersedes the materialized continuation", async () => {
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
        ${`durable-goal-wake-steer:${operationId}`}, 'operator direction wins',
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
    expect(claimed.turn.source).toBe("system");
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      claimed.turn.id,
    );
    expect(delivered.map((update) => update.kind)).toEqual(["agent_steer_instruction"]);
    const [superseded] = await shared.admin<Array<{ state: string }>>`
      select state from session_system_updates
      where workspace_id = ${ctx.grant.workspaceId!}
        and session_id = ${ctx.session.id}
        and kind = 'goal_continuation'`;
    expect(superseded?.state).toBe("superseded");
    expect(await counts(ctx)).toMatchObject({
      autoContinuations: 0,
      updates: 1,
      usage: 1,
    });
  });

  test("active-turn event writes and agent goal mutations complete without workspace/session lock inversion", async () => {
    const ctx = await runningGoalFixture();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `durable_goal_wake_slow_event_${suffix}`;
    const triggerName = `durable_goal_wake_slow_event_${suffix}`;
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
        [
          {
            type: "agent.message.delta",
            payload: { text: "concurrent progress" },
          },
        ],
      );
      await Bun.sleep(50);
      const mutate = updateSessionGoalWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
        progressNote: "still making progress",
        actor: "agent",
        command: goalCommand(ctx, {
          attemptId: ctx.attemptId,
          executionGeneration: ctx.turn.executionGeneration,
          operationKey: crypto.randomUUID(),
        }),
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
          event: {
            type: "goal.completed",
            evidence: "concurrent mutation completed",
          },
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
        [
          {
            type: "agent.message.delta",
            payload: { text: "concurrent goal set" },
          },
        ],
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
            createdBy: "api",
            actor: "api",
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
        [
          {
            type: "agent.message.delta",
            payload: { text: "concurrent goal clear" },
          },
        ],
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

describe("agent goal_wait continuation hold", () => {
  async function holdColumns(ctx: GoalFixture) {
    const [row] = await shared.admin<
      Array<{
        continuation_hold_turn_id: string | null;
        continuation_hold_until: Date | null;
        continuation_hold_reason: string | null;
        continuation_hold_set_at: Date | null;
      }>
    >`
      select continuation_hold_turn_id, continuation_hold_until,
             continuation_hold_reason, continuation_hold_set_at
      from session_goals
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}`;
    return row!;
  }

  async function outboxRow(ctx: GoalFixture) {
    const [row] = await shared.admin<
      Array<{
        reason: string;
        wake_revision: number | string;
        delivered_revision: number | string;
        next_attempt_at: Date;
      }>
    >`
      select reason, wake_revision, delivered_revision, next_attempt_at
      from session_workflow_wake_outbox where session_id = ${ctx.session.id}`;
    return row ?? null;
  }

  function hold(
    ctx: GoalFixture,
    input: { untilSeconds: number; reason?: string; operationKey?: string },
  ) {
    return holdSessionGoalContinuationWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      reason: input.reason ?? "waiting for two child sessions to report",
      untilSeconds: input.untilSeconds,
      command: goalCommand(ctx, {
        attemptId: ctx.attemptId,
        executionGeneration: ctx.turn.executionGeneration,
        operationKey: input.operationKey ?? crypto.randomUUID(),
      }),
    });
  }

  async function settleClaimedIdle(
    ctx: GoalFixture,
    claimed: { turn: { id: string; triggerEventId: string } },
    attemptId: string,
  ) {
    const settled = await applySessionTurnSettlement(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
  }

  test("a current hold returns held, leaves the obligation armed, and arms the deadline wake", async () => {
    const ctx = await runningGoalFixture();
    const operationKey = crypto.randomUUID();
    const held = await hold(ctx, { untilSeconds: 600, operationKey });
    expect(held.replay).toBe(false);
    expect(held.holdTurnId).toBe(ctx.turn.id);
    expect(held.events.map((event) => event.type)).toEqual(["goal.held"]);
    expect(held.events[0]!.payload).toMatchObject({
      goalId: held.goal.id,
      turnId: ctx.turn.id,
      untilAt: held.untilAt,
      reason: "waiting for two child sessions to report",
    });
    // Same target-scoped operation key: replay, no second event or hold.
    const replay = await hold(ctx, { untilSeconds: 600, operationKey });
    expect(replay).toMatchObject({ replay: true, events: [], untilAt: held.untilAt });
    const columns = await holdColumns(ctx);
    expect(columns.continuation_hold_turn_id).toBe(ctx.turn.id);
    expect(columns.continuation_hold_until?.toISOString()).toBe(held.untilAt);
    expect(columns.continuation_hold_reason).toBe("waiting for two child sessions to report");
    expect(columns.continuation_hold_set_at).not.toBeNull();

    await settleIdle(ctx);
    const before = await counts(ctx);
    expect(before).toMatchObject({ wakeRevision: 1, observedRevision: 0, updates: 0 });

    const first = await materialize(ctx);
    expect(first.action).toBe("held");
    if (first.action !== "held") return;
    expect(first.holdTurnId).toBe(ctx.turn.id);
    expect(first.holdUntil.toISOString()).toBe(held.untilAt);
    // No continuation, no consumed revision, no usage/event rows.
    expect(await counts(ctx)).toMatchObject({
      wakeRevision: 1,
      observedRevision: 0,
      updates: 0,
      usage: 0,
      events: 0,
    });
    const wake = await outboxRow(ctx);
    expect(wake).not.toBeNull();
    // The settlement wake is still undelivered, so the earlier deadline wins the
    // coalesced `least(...)`; once every prior revision is delivered the
    // re-armed deadline row must sit exactly at the hold deadline.
    expect(wake!.reason).toBe("goal_hold_deadline");
    await shared.admin`
      update session_workflow_wake_outbox
      set delivered_revision = wake_revision
      where session_id = ${ctx.session.id}`;
    const second = await materialize(ctx);
    expect(second.action).toBe("held");
    const rearmed = await outboxRow(ctx);
    expect(rearmed!.reason).toBe("goal_hold_deadline");
    expect(Number(rearmed!.wake_revision)).toBeGreaterThan(Number(rearmed!.delivered_revision));
    expect(rearmed!.next_attempt_at.toISOString()).toBe(held.untilAt);
    expect(await counts(ctx)).toMatchObject({ wakeRevision: 1, observedRevision: 0, updates: 0 });

    const projection = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    expect(projection?.continuation).toMatchObject({
      state: "blocked",
      reason: "held_for_input",
      wakeRevision: 1,
      observedRevision: 0,
      nextAttemptAt: held.untilAt,
      holdReason: "waiting for two child sessions to report",
    });
  });

  test("pending machine input wins over the hold, and the delivering turn retires it", async () => {
    const ctx = await runningGoalFixture();
    await hold(ctx, { untilSeconds: 3600 });
    await settleIdle(ctx);
    expect((await materialize(ctx)).action).toBe("held");

    const childResult = await addSessionSystemUpdate(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-result-${crypto.randomUUID()}`,
      summary: "Child finished",
      payload: {
        type: "agent_message",
        text: "Child finished: PR opened",
        operationId: crypto.randomUUID(),
      },
    });
    if (!childResult.added) throw new Error("child result was not inserted");
    // The hold is still current, but pending machine input is real model input.
    expect((await materialize(ctx)).action).toBe("queue");
    expect(await counts(ctx)).toMatchObject({ observedRevision: 0, updates: 0 });
    // Hold untouched until a newer turn actually finishes.
    expect((await holdColumns(ctx)).continuation_hold_turn_id).toBe(ctx.turn.id);

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
    if (claimed.action !== "claimed") return;
    expect(claimed.turn.source).toBe("system");
    await settleClaimedIdle(ctx, claimed, attemptId);

    // The declaring turn is no longer the latest finished turn: the hold is
    // retired in the same transaction and the continuation runs as before.
    const next = await materialize(ctx);
    expect(next.action).toBe("continue");
    expect(await holdColumns(ctx)).toEqual({
      continuation_hold_turn_id: null,
      continuation_hold_until: null,
      continuation_hold_reason: null,
      continuation_hold_set_at: null,
    });
    expect(await counts(ctx)).toMatchObject({ updates: 1, events: 1 });
  });

  test("an expired deadline clears the hold and continues", async () => {
    const ctx = await runningGoalFixture();
    await hold(ctx, { untilSeconds: 60 });
    await settleIdle(ctx);
    await shared.admin`
      update session_goals
      set continuation_hold_until = now() - interval '1 second'
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}`;
    const projection = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    expect(projection?.continuation).toMatchObject({ state: "scheduled", reason: "wake_pending" });
    expect((await materialize(ctx)).action).toBe("continue");
    expect((await holdColumns(ctx)).continuation_hold_turn_id).toBeNull();
    expect(await counts(ctx)).toMatchObject({ observedRevision: 1, updates: 1 });
  });

  test("human goal control clears the hold inside its own transaction", async () => {
    const ctx = await runningGoalFixture();
    await hold(ctx, { untilSeconds: 3600 });
    expect((await holdColumns(ctx)).continuation_hold_turn_id).toBe(ctx.turn.id);
    const paused = await setSessionGoalStatusWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      {
        status: "paused",
        rationale: "operator pause",
        pausedReason: "api",
        event: { type: "goal.paused", actor: "api", reason: "api", rationale: "operator pause" },
      },
    );
    expect(paused.changed).toBe(true);
    expect((await holdColumns(ctx)).continuation_hold_turn_id).toBeNull();
    // A paused goal cannot declare a wait.
    await expectRejectionContaining(
      hold(ctx, { untilSeconds: 3600 }),
      "session goal is not active",
    );
    const resumed = await setSessionGoalStatusWithEvent(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      { status: "active", event: { type: "goal.resumed", actor: "api" } },
    );
    expect(resumed.changed).toBe(true);
    await hold(ctx, { untilSeconds: 3600 });
    expect((await holdColumns(ctx)).continuation_hold_turn_id).toBe(ctx.turn.id);
    // A direct human/API redirect also retires it.
    const redirected = await upsertSessionGoalWithEvent(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      text: "Redirected by the operator",
      successCriteria: null,
      maxAutoContinuations: null,
      createdBy: "api",
      actor: "api",
    });
    expect(redirected.replaced).toBe(true);
    expect((await holdColumns(ctx)).continuation_hold_turn_id).toBeNull();
  });

  test("rejects deadlines outside the 30 s to 7 day window", async () => {
    const ctx = await runningGoalFixture();
    await expectRejectionContaining(hold(ctx, { untilSeconds: 10 }), "untilSeconds");
    await expectRejectionContaining(
      hold(ctx, { untilSeconds: 7 * 24 * 60 * 60 + 1 }),
      "untilSeconds",
    );
    await expectRejectionContaining(hold(ctx, { untilSeconds: 90.5 }), "untilSeconds");
    expect((await holdColumns(ctx)).continuation_hold_turn_id).toBeNull();
  });
});

describe("input-aware continuation cap and idle backoff", () => {
  function materializeWith(
    ctx: GoalFixture,
    overrides: {
      defaultMaxAutoContinuations?: number | null;
      idleBackoff?: { scheduleMs: readonly number[]; maxMs: number } | null;
    } = {},
  ) {
    return materializeGoalContinuation(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      defaultMaxAutoContinuations: overrides.defaultMaxAutoContinuations ?? null,
      budgetBlocked: null,
      ...(overrides.idleBackoff !== undefined ? { idleBackoff: overrides.idleBackoff } : {}),
      policy: {
        model: "scripted-model",
        reasoningEffort: "low",
        latencyMode: "standard" as const,
        tools: [],
        sandboxBackend: "none",
      },
      prompt: (goal, count) => `continue ${goal.text} (${count})`,
    });
  }

  async function goalRow(ctx: GoalFixture) {
    const [row] = await shared.admin<
      Array<{
        status: string;
        paused_reason: string | null;
        auto_continuations: number;
        version: number;
        continuation_wake_revision: number | string;
        continuation_observed_revision: number | string;
        last_continuation_turn_id: string | null;
      }>
    >`
      select status, paused_reason, auto_continuations, version,
             continuation_wake_revision, continuation_observed_revision,
             last_continuation_turn_id
      from session_goals
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}`;
    return {
      ...row!,
      continuation_wake_revision: Number(row!.continuation_wake_revision),
      continuation_observed_revision: Number(row!.continuation_observed_revision),
    };
  }

  async function outboxRow(ctx: GoalFixture) {
    const [row] = await shared.admin<
      Array<{
        reason: string;
        wake_revision: number | string;
        delivered_revision: number | string;
        next_attempt_at: Date;
      }>
    >`
      select reason, wake_revision, delivered_revision, next_attempt_at
      from session_workflow_wake_outbox where session_id = ${ctx.session.id}`;
    return row ?? null;
  }

  async function markOutboxDelivered(ctx: GoalFixture) {
    await shared.admin`
      update session_workflow_wake_outbox
      set delivered_revision = wake_revision
      where session_id = ${ctx.session.id}`;
  }

  async function claimAndSettle(ctx: GoalFixture) {
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
    if (claimed.action !== "claimed") throw new Error("turn was not claimed");
    const settled = await applySessionTurnSettlement(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
    const [turn] = await shared.admin<Array<{ finished_at: Date }>>`
      select finished_at from session_turns where id = ${claimed.turn.id}`;
    return { turn: claimed.turn, finishedAt: turn!.finished_at };
  }

  function childResult(ctx: GoalFixture) {
    return addSessionSystemUpdate(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-terminal-${crypto.randomUUID()}`,
      summary: "Child finished",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    });
  }

  /** Drive the goal to a `max_auto_continuations` pause with cap 1. */
  async function pauseByCap(ctx: GoalFixture) {
    await settleIdle(ctx);
    expect((await materializeWith(ctx, { defaultMaxAutoContinuations: 1 })).action).toBe(
      "continue",
    );
    await claimAndSettle(ctx);
    const paused = await materializeWith(ctx, { defaultMaxAutoContinuations: 1 });
    expect(paused.action).toBe("paused");
    expect(paused.events.map((event) => event.type)).toEqual(["goal.paused"]);
    expect(await goalRow(ctx)).toMatchObject({
      status: "paused",
      paused_reason: "max_auto_continuations",
      auto_continuations: 1,
    });
    await markOutboxDelivered(ctx);
  }

  test("a goal turn whose batch coalesced external input resets the no-input streak at claim", async () => {
    const ctx = await runningGoalFixture();
    await settleIdle(ctx);
    expect((await materializeWith(ctx)).action).toBe("continue");
    expect(await goalRow(ctx)).toMatchObject({ auto_continuations: 1 });
    const result = await childResult(ctx);
    if (!result.added) throw new Error("child result was not inserted");
    // An active goal is never auto-resumed; the arrival only wakes it.
    expect(result.events.map((event) => event.type)).toEqual(["system.update.pending"]);

    const { turn } = await claimAndSettle(ctx);
    expect(turn.source).toBe("goal");
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      turn.id,
    );
    expect(delivered.map((update) => update.kind).sort()).toEqual([
      "child_terminal_result",
      "goal_continuation",
    ]);
    // The claim bound the exact batch: this goal turn consumed external input,
    // so the streak restarts while the continuation pointer still advances.
    expect(await goalRow(ctx)).toMatchObject({
      auto_continuations: 0,
      last_continuation_turn_id: turn.id,
    });

    // A pure continuation keeps the evaluator's count.
    expect((await materializeWith(ctx)).action).toBe("continue");
    const pure = await claimAndSettle(ctx);
    expect(pure.turn.source).toBe("goal");
    expect(await goalRow(ctx)).toMatchObject({
      auto_continuations: 1,
      last_continuation_turn_id: pure.turn.id,
    });
  });

  test("a child result auto-resumes a cap-paused goal and arms the wake", async () => {
    const ctx = await runningGoalFixture();
    await pauseByCap(ctx);
    const before = await goalRow(ctx);

    const result = await childResult(ctx);
    if (!result.added) throw new Error("child result was not inserted");
    expect(result.events.map((event) => event.type)).toEqual([
      "system.update.pending",
      "goal.resumed",
    ]);
    const resumed = result.events[1]!;
    expect(resumed.payload).toMatchObject({
      actor: "system",
      reason: "external_input",
      cause: { kind: "child_terminal_result", updateId: result.update.id },
      version: before.version + 1,
    });
    expect(resumed.sequence).toBe(result.events[0]!.sequence + 1);
    // The late child result revives the parent: same commit resumes the goal
    // and wakes the idle session.
    expect(result.shouldWake).toBe(true);
    expect(result.workflowWakeRevision).not.toBeNull();
    expect(await goalRow(ctx)).toMatchObject({
      status: "active",
      paused_reason: null,
      auto_continuations: 0,
      version: before.version + 1,
      continuation_wake_revision: before.continuation_wake_revision + 1,
      continuation_observed_revision: before.continuation_observed_revision,
      last_continuation_turn_id: null,
    });
    const wake = await outboxRow(ctx);
    expect(Number(wake!.wake_revision)).toBeGreaterThan(Number(wake!.delivered_revision));
    expect(wake!.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    // The pending child result is real model input: the next evaluation
    // delivers it instead of synthesizing another continuation.
    expect((await materializeWith(ctx, { defaultMaxAutoContinuations: 1 })).action).toBe("queue");
  });

  test("a human prompt auto-resumes a cap-paused goal in the same commit", async () => {
    const ctx = await runningGoalFixture();
    await pauseByCap(ctx);
    const before = await goalRow(ctx);
    const submitted = await withWorkspaceSubjectRls(
      client.db,
      ctx.grant.workspaceId!,
      ctx.grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            accountId: ctx.grant.accountId,
            workspaceId: ctx.grant.workspaceId!,
            sessionId: ctx.session.id,
            subjectId: ctx.grant.subjectId,
            actor: { type: "human", subjectId: ctx.grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "keep going",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
    );
    const types = submitted.events.map((event) => event.type);
    expect(types).toContain("goal.resumed");
    expect(types.indexOf("goal.resumed")).toBeGreaterThan(types.indexOf("turn.queued"));
    const resumed = submitted.events.find((event) => event.type === "goal.resumed")!;
    expect(resumed.payload).toMatchObject({
      actor: "system",
      reason: "external_input",
      cause: { kind: "human_prompt", turnId: submitted.turnId },
    });
    expect(await goalRow(ctx)).toMatchObject({
      status: "active",
      paused_reason: null,
      auto_continuations: 0,
      version: before.version + 1,
      continuation_wake_revision: before.continuation_wake_revision + 1,
    });
    // The session sequence advanced past every appended event, so later
    // writers cannot collide with the resume fact.
    const [session] = await shared.admin<Array<{ last_sequence: number | string }>>`
      select last_sequence from sessions where id = ${ctx.session.id}`;
    expect(Number(session!.last_sequence)).toBe(
      Math.max(...submitted.events.map((event) => event.sequence)),
    );
  });

  test("only the continuation ceiling is auto-resumed; intent pauses stay paused", async () => {
    for (const pausedReason of ["user_pause", "api", "limits", "agent"] as const) {
      const ctx = await runningGoalFixture();
      await settleIdle(ctx);
      await setSessionGoalStatusWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
        status: "paused",
        rationale: `paused: ${pausedReason}`,
        pausedReason,
        event: { type: "goal.paused", actor: "api", reason: pausedReason },
      });
      const before = await goalRow(ctx);
      const result = await childResult(ctx);
      if (!result.added) throw new Error("child result was not inserted");
      expect(result.events.map((event) => event.type)).toEqual(["system.update.pending"]);
      // A paused goal is settled authority for a late child: no wake.
      expect(result.shouldWake).toBe(false);
      expect(await goalRow(ctx)).toMatchObject({
        status: "paused",
        paused_reason: pausedReason,
        version: before.version,
      });
      const [resumedEvents] = await shared.admin`
        select count(*)::int as count from session_events
        where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
          and type = 'goal.resumed'`;
      expect(Number(resumedEvents!.count)).toBe(0);
    }
  });

  test("consecutive no-input continuations back off, re-arm the delayed wake, and yield to new input", async () => {
    const ctx = await runningGoalFixture();
    // Wide delays so the assertions never race the wall clock in CI.
    const idleBackoff = { scheduleMs: [60_000, 120_000], maxMs: 90_000 };
    await settleIdle(ctx);
    // First continuation after external input (the initial human turn) is immediate.
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("continue");
    const first = await claimAndSettle(ctx);
    expect(first.turn.source).toBe("goal");
    const armed = await counts(ctx);
    expect(armed).toMatchObject({ autoContinuations: 1, updates: 1, usage: 1, events: 1 });
    expect(armed.wakeRevision).toBeGreaterThan(armed.observedRevision);

    // Second consecutive no-input continuation: deferred 60 s after the first finished.
    const deferred = await materializeWith(ctx, { idleBackoff });
    expect(deferred.action).toBe("deferred");
    if (deferred.action !== "deferred") return;
    expect(deferred.notBefore.getTime()).toBe(first.finishedAt.getTime() + 60_000);
    // Nothing consumed: ledger, updates, usage, and events untouched.
    expect(await counts(ctx)).toEqual(armed);
    let wake = await outboxRow(ctx);
    expect(wake!.reason).toBe("goal_idle_backoff");
    // The settlement wake was still undelivered, so it coalesced with
    // `least(...)`; once delivered, the re-armed row sits exactly at the deadline.
    await markOutboxDelivered(ctx);
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("deferred");
    wake = await outboxRow(ctx);
    expect(wake!.reason).toBe("goal_idle_backoff");
    expect(Number(wake!.wake_revision)).toBeGreaterThan(Number(wake!.delivered_revision));
    expect(wake!.next_attempt_at.getTime()).toBe(first.finishedAt.getTime() + 60_000);
    expect(await counts(ctx)).toEqual(armed);
    const projection = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    expect(projection?.continuation).toMatchObject({
      state: "scheduled",
      reason: "backoff_pending",
      wakeRevision: armed.wakeRevision,
      observedRevision: armed.observedRevision,
      nextAttemptAt: new Date(first.finishedAt.getTime() + 60_000).toISOString(),
    });

    // The deadline passes (shift every finished turn into the past together so
    // finish ordering is preserved): the continuation materializes as before.
    await shared.admin`
      update session_turns set finished_at = finished_at - interval '70 seconds'
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
        and finished_at is not null`;
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("continue");
    const second = await claimAndSettle(ctx);
    expect(await goalRow(ctx)).toMatchObject({
      auto_continuations: 2,
      last_continuation_turn_id: second.turn.id,
    });
    // Third consecutive: schedule says 120 s, the ceiling caps it at 90 s.
    await markOutboxDelivered(ctx);
    const capped = await materializeWith(ctx, { idleBackoff });
    expect(capped.action).toBe("deferred");
    if (capped.action !== "deferred") return;
    expect(capped.notBefore.getTime()).toBe(second.finishedAt.getTime() + 90_000);
    wake = await outboxRow(ctx);
    expect(wake!.next_attempt_at.getTime()).toBe(second.finishedAt.getTime() + 90_000);

    // New input mid-backoff pulls the delayed wake to now and wins the next
    // evaluation as ordinary pending machine input.
    const message = await addSessionSystemUpdate(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `backoff-message-${crypto.randomUUID()}`,
      summary: "Peer update",
      payload: {
        type: "agent_message",
        text: "Peer update",
        operationId: crypto.randomUUID(),
      },
    });
    if (!message.added) throw new Error("agent message was not inserted");
    wake = await outboxRow(ctx);
    expect(wake!.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(Number(wake!.wake_revision)).toBeGreaterThan(Number(wake!.delivered_revision));
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("queue");
    // No continuation was materialized while deferred, so the message is
    // delivered on an ordinary system turn. That turn is newer external input:
    // the next evaluation restarts the streak and continues immediately.
    const mixed = await claimAndSettle(ctx);
    expect(mixed.turn.source).toBe("system");
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("continue");
    expect(await goalRow(ctx)).toMatchObject({ auto_continuations: 1 });
  });

  test("a human turn after a continuation restarts the streak without backoff", async () => {
    const ctx = await runningGoalFixture();
    const idleBackoff = { scheduleMs: [60_000], maxMs: 60_000 };
    await settleIdle(ctx);
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("continue");
    await claimAndSettle(ctx);
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("deferred");
    await withWorkspaceSubjectRls(client.db, ctx.grant.workspaceId!, ctx.grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          subjectId: ctx.grant.subjectId,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "human direction",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const human = await claimAndSettle(ctx);
    expect(human.turn.source).toBe("user");
    // Latest finished turn is human work: no pacing, the streak restarts.
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("continue");
    expect(await goalRow(ctx)).toMatchObject({ auto_continuations: 1 });
  });

  /** A live peer agent attempt in the same workspace (the production caller shape). */
  async function agentCallerIn(ctx: GoalFixture) {
    const session = await createSession(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      initialMessage: "caller",
      resources: [],
      tools: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: ctx.grant.subjectId },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("caller turn was not claimed");
    return {
      type: "agent_attempt" as const,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    };
  }

  async function eventsById(ctx: GoalFixture, ids: string[]) {
    const rows = await shared.admin<
      Array<{ type: string; payload: Record<string, unknown>; sequence: number | string }>
    >`
      select type, payload, sequence from session_events
      where workspace_id = ${ctx.grant.workspaceId!} and session_id = ${ctx.session.id}
        and id = any(${ids}::uuid[])
      order by sequence asc`;
    return rows.map((row) => ({ ...row, sequence: Number(row.sequence) }));
  }

  test("an Agent message (production producer) auto-resumes a cap-paused goal and wakes it", async () => {
    const ctx = await runningGoalFixture();
    await pauseByCap(ctx);
    const before = await goalRow(ctx);
    const caller = await agentCallerIn(ctx);
    const message = await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        sendAgentMessageInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          targetSessionId: ctx.session.id,
          actor: caller,
          operationKey: crypto.randomUUID(),
          text: "worker finished the batch",
        }),
      ),
    );
    expect(message.replay).toBe(false);
    const events = await eventsById(ctx, message.eventIds);
    expect(events.map((event) => event.type)).toEqual(["system.update.pending", "goal.resumed"]);
    expect(events[1]!.sequence).toBe(events[0]!.sequence + 1);
    expect(events[1]!.payload).toMatchObject({
      actor: "system",
      reason: "external_input",
      cause: { kind: "agent_message", updateId: message.updateId },
      version: before.version + 1,
    });
    // The same commit resumed the goal and woke the idle session.
    expect(message.shouldSignal).toBe(true);
    expect(message.wakeRevision).not.toBeNull();
    expect(await goalRow(ctx)).toMatchObject({
      status: "active",
      paused_reason: null,
      auto_continuations: 0,
      version: before.version + 1,
      continuation_wake_revision: before.continuation_wake_revision + 1,
      last_continuation_turn_id: null,
    });
    const [session] = await shared.admin<Array<{ last_sequence: number | string }>>`
      select last_sequence from sessions where id = ${ctx.session.id}`;
    expect(Number(session!.last_sequence)).toBe(events[1]!.sequence);
    // The pending message is real model input for the next evaluation.
    expect((await materializeWith(ctx, { defaultMaxAutoContinuations: 1 })).action).toBe("queue");
  });

  test("an Agent Steer (production producer) auto-resumes a cap-paused goal before superseding", async () => {
    const ctx = await runningGoalFixture();
    await pauseByCap(ctx);
    const before = await goalRow(ctx);
    const caller = await agentCallerIn(ctx);
    const steer = await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        steerAgentSessionInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          targetSessionId: ctx.session.id,
          actor: caller,
          operationKey: crypto.randomUUID(),
          instruction: "Re-check the workers and report",
        }),
      ),
    );
    expect(steer.replay).toBe(false);
    const events = await eventsById(ctx, steer.eventIds);
    const types = events.map((event) => event.type);
    expect(types).toContain("system.update.pending");
    expect(types[types.length - 1]).toBe("goal.resumed");
    expect(events[events.length - 1]!.payload).toMatchObject({
      actor: "system",
      reason: "external_input",
      cause: { kind: "agent_steer_instruction", updateId: steer.updateId },
      version: before.version + 1,
    });
    expect(steer.wakeRevision).toBeGreaterThan(0);
    expect(await goalRow(ctx)).toMatchObject({
      status: "active",
      paused_reason: null,
      auto_continuations: 0,
      version: before.version + 1,
      continuation_wake_revision: before.continuation_wake_revision + 1,
      last_continuation_turn_id: null,
    });
    const [session] = await shared.admin<Array<{ last_sequence: number | string }>>`
      select last_sequence from sessions where id = ${ctx.session.id}`;
    expect(Number(session!.last_sequence)).toBe(events[events.length - 1]!.sequence);
    // The Steer is the authoritative next direction; no continuation is synthesized beside it.
    expect((await materializeWith(ctx, { defaultMaxAutoContinuations: 1 })).action).toBe("queue");
  });

  test("a human turn finishing after a goal_wait turn retires the hold everywhere", async () => {
    const ctx = await runningGoalFixture();
    await holdSessionGoalContinuationWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      reason: "waiting for the workers",
      untilSeconds: 3600,
      command: goalCommand(ctx, {
        attemptId: ctx.attemptId,
        executionGeneration: ctx.turn.executionGeneration,
        operationKey: crypto.randomUUID(),
      }),
    });
    await settleIdle(ctx);
    expect((await materializeWith(ctx)).action).toBe("held");
    expect(
      (await getSessionGoalWithContinuation(client.db, ctx.grant.workspaceId!, ctx.session.id))
        ?.continuation.reason,
    ).toBe("held_for_input");

    // The human prompt is queued at a LOW normalized position but finishes later.
    await withWorkspaceSubjectRls(client.db, ctx.grant.workspaceId!, ctx.grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          subjectId: ctx.grant.subjectId,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "new direction",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const human = await claimAndSettle(ctx);
    expect(human.turn.source).toBe("user");
    const [positions] = await shared.admin<
      Array<{ human_position: number; goal_position: number }>
    >`
      select
        (select position from session_turns where id = ${human.turn.id}) as human_position,
        (select position from session_turns where id = ${ctx.turn.id}) as goal_position`;
    expect(Number(positions!.human_position)).toBeLessThanOrEqual(Number(positions!.goal_position));

    // Projection and materializer agree: the newer human turn retired the hold.
    const projection = await getSessionGoalWithContinuation(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
    );
    expect(projection?.continuation.reason).not.toBe("held_for_input");
    expect((await materializeWith(ctx)).action).toBe("continue");
    const [hold] = await shared.admin<Array<{ continuation_hold_turn_id: string | null }>>`
      select continuation_hold_turn_id from session_goals where session_id = ${ctx.session.id}`;
    expect(hold!.continuation_hold_turn_id).toBeNull();
  });

  test("an expired goal_wait deadline is due now and skips the idle backoff once", async () => {
    const ctx = await runningGoalFixture();
    const idleBackoff = { scheduleMs: [60_000], maxMs: 60_000 };
    await settleIdle(ctx);
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("continue");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("goal turn was not claimed");
    expect(claimed.turn.source).toBe("goal");
    // The continuation turn itself declares a short hold, then ends.
    await holdSessionGoalContinuationWithEvent(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      reason: "workers report within half a minute",
      untilSeconds: 30,
      command: {
        accountId: ctx.grant.accountId,
        actor: {
          type: "agent_attempt",
          sessionId: ctx.session.id,
          turnId: claimed.turn.id,
          attemptId,
          executionGeneration: claimed.turn.executionGeneration,
        },
        operationKey: crypto.randomUUID(),
      },
    });
    const settled = await applySessionTurnSettlement(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
    expect(await goalRow(ctx)).toMatchObject({
      auto_continuations: 1,
      last_continuation_turn_id: claimed.turn.id,
    });
    // While current, the hold wins over pacing.
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("held");
    // The agent's stated deadline passes: the next evaluation is due now even
    // though the 60 s pacing delay since the continuation finished has not
    // elapsed. The streak keeps counting afterwards.
    await shared.admin`
      update session_goals set continuation_hold_until = now() - interval '1 second'
      where session_id = ${ctx.session.id}`;
    expect((await materializeWith(ctx, { idleBackoff })).action).toBe("continue");
    expect(await goalRow(ctx)).toMatchObject({ auto_continuations: 2 });
    const [hold] = await shared.admin<Array<{ continuation_hold_turn_id: string | null }>>`
      select continuation_hold_turn_id from session_goals where session_id = ${ctx.session.id}`;
    expect(hold!.continuation_hold_turn_id).toBeNull();
  });
});
