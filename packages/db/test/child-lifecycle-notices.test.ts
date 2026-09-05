import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1 } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acceptSessionApprovalDecision,
  acceptSessionHumanInputResponse,
  addSessionSystemUpdateWithSourceMutation,
  applySessionTurnSettlement,
  armCodexCapacityWait,
  armXaiCapacityWait,
  bootstrapWorkspace,
  childWaitingCapacityDedupeKey,
  claimPendingSessionSystemUpdateOutbox,
  ensureCodexRotationSettings,
  failSessionWorkBeforeAttemptClaim,
  getSessionGoal,
  updateCodexRotationSettings,
  childPausedDedupeKey,
  childProgressDedupeKey,
  childRequiresActionDedupeKey,
  childRequiresActionResolvedDedupeKey,
  claimSessionWorkForAttempt,
  configureChildLifecycleNotices,
  createDb,
  createSession,
  getSessionSystemUpdateOutboxByDedupeKey,
  waitForSessionInputWithEvent,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  listSessionEvents,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  materializeGoalContinuation,
  mutateSessionControlInTransaction,
  peekSessionWork,
  recordSessionGoalProgressWithEvent,
  sessionSystemUpdateOutboxKindPayload,
  withWorkspaceSessionActivityRls,
  type SessionSystemUpdateOutboxDelivery,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("child-lifecycle-notices");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  configureChildLifecycleNotices({ enabled: true });
}, 180_000);

afterAll(async () => {
  configureChildLifecycleNotices({ enabled: false });
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = { accountId: string; workspaceId: string; subjectId: string };

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "child-lifecycle-notices",
    accountExternalId: `account-${suffix}`,
    accountName: "Child lifecycle notices",
    workspaceExternalSource: "child-lifecycle-notices",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Child lifecycle notices",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

async function startSession(
  grant: Grant,
  input: { parent?: Started; goal?: boolean; message: string },
) {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...(input.parent
      ? {
          parentSessionId: input.parent.session.id,
          createdByActor: {
            type: "agent_attempt" as const,
            attemptId: input.parent.attemptId,
            sessionId: input.parent.session.id,
            turnId: input.parent.turn.id,
            executionGeneration: input.parent.turn.executionGeneration,
          },
        }
      : {}),
    initialMessage: input.message,
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
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: input.goal
      ? { text: "Orchestrate the workers", mutationPolicy: "preserve_intent" }
      : null,
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  return { session, turn: claimed.turn, attemptId };
}

type Started = Awaited<ReturnType<typeof startSession>>;

const questions = [
  {
    id: "environment",
    kind: "single_select" as const,
    prompt: "Which environment should I deploy to?",
    options: [
      { id: "staging", label: "Staging" },
      { id: "production", label: "Production" },
    ],
    required: true,
    allowOther: false,
  },
];

async function freezeChild(
  grant: Grant,
  child: Started,
  options: { approvals?: unknown[]; requestId?: string; parallelRequestId?: string } = {},
) {
  const requestId = options.requestId ?? crypto.randomUUID();
  const parallelRequests = options.parallelRequestId
    ? [
        {
          id: options.parallelRequestId,
          toolCallId: "human-call-2",
          questions,
          allowSkip: false,
          expiresAt: null,
        },
      ]
    : [];
  const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId: child.session.id,
    turnId: child.turn.id,
    triggerEventId: child.turn.triggerEventId,
    attemptId: child.attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: child.turn.id,
    runState: {
      serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
      pendingApprovals: options.approvals ?? [],
      humanInputRequests: [
        { id: requestId, toolCallId: "human-call-1", questions, allowSkip: false, expiresAt: null },
        ...parallelRequests,
      ],
    },
    events: [
      {
        type: "session.humanInput.requested",
        payload: { request: { id: requestId, questions, allowSkip: false, expiresAt: null } },
      },
      ...parallelRequests.map((request) => ({
        type: "session.humanInput.requested" as const,
        payload: { request: { id: request.id, questions, allowSkip: false, expiresAt: null } },
      })),
      ...(options.approvals && options.approvals.length > 0
        ? [
            {
              type: "session.requiresAction" as const,
              payload: { approvals: options.approvals },
            },
          ]
        : []),
      { type: "session.status.changed" as const, payload: { status: "requires_action" } },
    ],
  });
  expect(settled.action).toBe("settled");
  return { requestId };
}

async function settleIdle(grant: Grant, started: Started) {
  const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId: started.session.id,
    turnId: started.turn.id,
    triggerEventId: started.turn.triggerEventId,
    attemptId: started.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

async function outbox(grant: Grant, dedupeKey: string) {
  return await getSessionSystemUpdateOutboxByDedupeKey(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    dedupeKey,
  });
}

/** What the worker's parent-wake delivery does with one committed outbox row. */
async function deliver(row: SessionSystemUpdateOutboxDelivery) {
  return await addSessionSystemUpdateWithSourceMutation(
    client.db,
    {
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId: row.targetSessionId,
      ...sessionSystemUpdateOutboxKindPayload(row),
      classification: row.classification,
      sourceId: row.sourceId,
      dedupeKey: row.dedupeKey,
      summary: row.summary,
      lineage: row.lineage,
      personalConnectionDelegations: row.personalConnectionDelegations,
      xaiProviderAccountAuthoritySnapshot: row.xaiProviderAccountAuthoritySnapshot,
    },
    async (tx) => {
      await markSessionSystemUpdateOutboxDeliveredInTransaction(tx, row);
    },
  );
}

async function pause(
  grant: Grant,
  sessionId: string,
  actor: Parameters<typeof mutateSessionControlInTransaction>[1]["actor"],
  reason?: string,
) {
  return await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      mutateSessionControlInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        actor,
        operationKey: crypto.randomUUID(),
        action: "pause",
        ...(reason ? { reason } : {}),
      }),
    ),
  );
}

function materialize(grant: Grant, sessionId: string, cap: number | null = null) {
  return materializeGoalContinuation(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    workflowId: `session-${sessionId}`,
    defaultMaxAutoContinuations: cap,
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

describe("child lifecycle notices", () => {
  test("a requires_action freeze enqueues one bounded child_requires_action row; no parent, no row", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, {
      parent,
      message: "work",
    });
    const root = await startSession(grant, { message: "standalone" });
    const { requestId } = await freezeChild(grant, child, {
      approvals: [{ id: "tool-call-1", rawItem: { name: "write_file", arguments: "secret" } }],
    });
    await freezeChild(grant, root);
    const dedupeKey = childRequiresActionDedupeKey({
      childSessionId: child.session.id,
      turnId: child.turn.id,
      turnGeneration: child.turn.executionGeneration,
    });
    const row = await outbox(grant, dedupeKey);
    expect(row).toMatchObject({
      status: "pending",
      kind: "child_requires_action",
      classification: "action_required",
      sourceSessionId: child.session.id,
      targetSessionId: parent.session.id,
      payload: {
        type: "child_requires_action",
        childSessionId: child.session.id,
        childTurnId: child.turn.id,
        childTurnGeneration: child.turn.executionGeneration,
        truncated: false,
        requests: [
          {
            kind: "human_input",
            requestId,
            questionCount: 1,
            firstQuestion: "Which environment should I deploy to?",
            allowSkip: false,
            expiresAt: null,
          },
          { kind: "approval", approvalId: "tool-call-1", toolName: "write_file" },
        ],
      },
      lineage: {
        childSessionId: child.session.id,
        parentSessionId: parent.session.id,
        parentTurnId: parent.turn.id,
        turnId: child.turn.id,
      },
    });
    expect(JSON.stringify(row!.payload)).not.toContain("secret");
    expect(row!.summary).toContain("needs input");
    expect(row!.summary).toContain("Which environment should I deploy to?");
    // A root session without a parent produces nothing.
    expect(
      await outbox(
        grant,
        childRequiresActionDedupeKey({
          childSessionId: root.session.id,
          turnId: root.turn.id,
          turnGeneration: root.turn.executionGeneration,
        }),
      ),
    ).toBeNull();
  });

  test("delivery wakes an idle parent only when its goal is active and the kind is immediate", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, {
      parent,
      message: "work",
    });
    await settleIdle(grant, parent);
    await freezeChild(grant, child);
    const row = (await outbox(
      grant,
      childRequiresActionDedupeKey({
        childSessionId: child.session.id,
        turnId: child.turn.id,
        turnGeneration: child.turn.executionGeneration,
      }),
    ))!;
    const delivered = await deliver(row);
    if (delivered.reason !== "added") throw new Error(`unexpected ${delivered.reason}`);
    expect(delivered.added).toBe(true);
    expect(delivered.workflowWakeRevision).not.toBeNull();
    expect(delivered.workflowWakeRevision).not.toBeNull();
    expect(delivered.events.map((event) => event.type)).toEqual(["system.update.pending"]);
    const pending = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect(pending.map((update) => update.kind)).toEqual(["child_requires_action"]);
    expect((await outbox(grant, row.dedupeKey))!.status).toBe("delivered");
    // Redelivery of the same row is a duplicate, not a second pending input.
    const again = await deliver(row);
    expect(again.reason).toBe("duplicate");

    // A parent without an active goal is not woken by a child notice.
    const noGoalParent = await startSession(grant, { message: "no goal" });
    const noGoalChild = await startSession(grant, {
      parent: noGoalParent,
      message: "work",
    });
    await settleIdle(grant, noGoalParent);
    await freezeChild(grant, noGoalChild);
    const quiet = await deliver(
      (await outbox(
        grant,
        childRequiresActionDedupeKey({
          childSessionId: noGoalChild.session.id,
          turnId: noGoalChild.turn.id,
          turnGeneration: noGoalChild.turn.executionGeneration,
        }),
      ))!,
    );
    if (quiet.reason !== "added") throw new Error(`unexpected ${quiet.reason}`);
    expect(quiet.shouldWake).toBe(false);
    expect(quiet.workflowWakeRevision).toBeNull();
  });

  test("child_progress is deferred: pending row without a wake, newer note supersedes older", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, {
      parent,
      message: "work",
      goal: true,
    });
    await settleIdle(grant, parent);
    const progress = async (note: string) =>
      await recordSessionGoalProgressWithEvent(client.db, grant.workspaceId, child.session.id, {
        progressNote: note,
        command: {
          accountId: grant.accountId,
          actor: {
            type: "agent_attempt",
            attemptId: child.attemptId,
            sessionId: child.session.id,
            turnId: child.turn.id,
            executionGeneration: child.turn.executionGeneration,
          },
          operationKey: crypto.randomUUID(),
        },
      });
    const first = await progress("one third done");
    const second = await progress("two thirds done");
    const firstRow = (await outbox(
      grant,
      childProgressDedupeKey({ childSessionId: child.session.id, receiptId: first.operationId }),
    ))!;
    const secondRow = (await outbox(
      grant,
      childProgressDedupeKey({ childSessionId: child.session.id, receiptId: second.operationId }),
    ))!;
    expect(firstRow).toMatchObject({
      kind: "child_progress",
      classification: "info",
      payload: { type: "child_progress", progressNote: "one third done" },
    });
    const deliveredFirst = await deliver(firstRow);
    if (deliveredFirst.reason !== "added") throw new Error("first progress not added");
    expect(deliveredFirst.shouldWake).toBe(false);
    expect(deliveredFirst.workflowWakeRevision).toBeNull();
    // Deferred: the parent stays idle (not flipped to queued) and the peek
    // without a hold still reports runnable because a pending row exists.
    expect(await peekSessionWork(client.db, grant.workspaceId, parent.session.id)).toEqual({
      kind: "runnable",
    });
    const deliveredSecond = await deliver(secondRow);
    if (deliveredSecond.reason !== "added") throw new Error("second progress not added");
    expect(deliveredSecond.events.map((event) => event.type)).toEqual([
      "system.update.pending",
      "system.update.cancelled",
    ]);
    expect(deliveredSecond.events[1]!.payload).toMatchObject({
      updateIds: [deliveredFirst.update.id],
      reason: "superseded_by_newer_progress",
      supersededByUpdateId: deliveredSecond.update.id,
    });
    const pending = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect(pending.map((update) => update.id)).toEqual([deliveredSecond.update.id]);
  });

  test("a resolution supersedes the pending child_requires_action of the same boundary", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, {
      parent,
      message: "work",
    });
    const { requestId } = await freezeChild(grant, child);
    const requiresActionRow = (await outbox(
      grant,
      childRequiresActionDedupeKey({
        childSessionId: child.session.id,
        turnId: child.turn.id,
        turnGeneration: child.turn.executionGeneration,
      }),
    ))!;
    const deliveredRequiresAction = await deliver(requiresActionRow);
    if (deliveredRequiresAction.reason !== "added") throw new Error("notice not added");
    // The parent is mid-turn: the row stays pending and no wake is registered.
    expect(deliveredRequiresAction.shouldWake).toBe(false);

    const answered = await acceptSessionHumanInputResponse(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: child.session.id,
      requestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "environment", values: ["staging"] }],
      },
      respondedBy: `agent_attempt:${parent.attemptId}`,
    });
    expect(answered.action).toBe("accepted");
    const resolvedRow = (await outbox(
      grant,
      childRequiresActionResolvedDedupeKey({
        childSessionId: child.session.id,
        turnId: child.turn.id,
        turnGeneration: child.turn.executionGeneration,
        requestId,
        approvalId: null,
      }),
    ))!;
    expect(resolvedRow).toMatchObject({
      kind: "child_requires_action_resolved",
      classification: "info",
      payload: {
        type: "child_requires_action_resolved",
        requestId,
        approvalId: null,
        outcome: "answered",
        respondedByKind: "agent_attempt",
      },
    });
    const deliveredResolved = await deliver(resolvedRow);
    if (deliveredResolved.reason !== "added") throw new Error("resolution not added");
    expect(deliveredResolved.shouldWake).toBe(false);
    expect(deliveredResolved.events.map((event) => event.type)).toEqual([
      "system.update.pending",
      "system.update.cancelled",
    ]);
    expect(deliveredResolved.events[1]!.payload).toMatchObject({
      updateIds: [deliveredRequiresAction.update.id],
      reason: "superseded_by_resolution",
    });
    const pending = await listOutstandingSessionSystemUpdates(
      client.db,
      grant.workspaceId,
      parent.session.id,
    );
    expect(pending.map((update) => update.kind)).toEqual(["child_requires_action_resolved"]);
  });

  test("approval decisions and terminal cancellation also resolve, with the parent locked", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const approvalChild = await startSession(grant, {
      parent,
      message: "approval",
    });
    await freezeChild(grant, approvalChild, { approvals: [{ id: "tool-call-9" }] });
    const decided = await acceptSessionApprovalDecision(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: approvalChild.session.id,
      subjectId: grant.subjectId,
      payload: { approvalId: "tool-call-9", decision: "approve" },
    });
    expect(decided.action).toBe("accepted");
    expect(
      await outbox(
        grant,
        childRequiresActionResolvedDedupeKey({
          childSessionId: approvalChild.session.id,
          turnId: approvalChild.turn.id,
          turnGeneration: approvalChild.turn.executionGeneration,
          requestId: null,
          approvalId: "tool-call-9",
        }),
      ),
    ).toMatchObject({
      kind: "child_requires_action_resolved",
      payload: { approvalId: "tool-call-9", outcome: "approved", respondedByKind: "human" },
    });

    const cancelledChild = await startSession(grant, {
      parent,
      message: "cancel me",
    });
    const { requestId } = await freezeChild(grant, cancelledChild);
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: cancelledChild.session.id,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "cancel",
        }),
      ),
    );
    expect(
      await outbox(
        grant,
        childRequiresActionResolvedDedupeKey({
          childSessionId: cancelledChild.session.id,
          turnId: cancelledChild.turn.id,
          turnGeneration: cancelledChild.turn.executionGeneration,
          requestId,
          approvalId: null,
        }),
      ),
    ).toMatchObject({
      kind: "child_requires_action_resolved",
      payload: { requestId, outcome: "cancelled", respondedByKind: "system" },
    });
    expect(
      await outbox(grant, `child-completion:${cancelledChild.session.id}:cancelled`),
    ).toMatchObject({ kind: "child_terminal_result" });
  });

  test("direct human pause notifies the parent; the parent's own attempt or an ancestor pause does not", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, {
      parent,
      message: "work",
    });
    const human = await pause(
      grant,
      child.session.id,
      { type: "human", subjectId: grant.subjectId },
      "needs a human look",
    );
    expect(
      await outbox(
        grant,
        childPausedDedupeKey({ childSessionId: child.session.id, receiptId: human.receipt.id }),
      ),
    ).toMatchObject({
      kind: "child_paused",
      classification: "action_required",
      payload: {
        type: "child_paused",
        actorKind: "human",
        reason: "needs a human look",
        operationId: human.receipt.id,
      },
    });

    // The parent's own live attempt pausing its child already knows: no notice.
    const second = await startSession(grant, {
      parent,
      message: "work two",
    });
    const byParent = await pause(grant, second.session.id, {
      type: "agent_attempt",
      attemptId: parent.attemptId,
      sessionId: parent.session.id,
      turnId: parent.turn.id,
      executionGeneration: parent.turn.executionGeneration,
    });
    expect(
      await outbox(
        grant,
        childPausedDedupeKey({ childSessionId: second.session.id, receiptId: byParent.receipt.id }),
      ),
    ).toBeNull();

    // Pausing the parent recursively holds its children but is a notice for
    // nobody: the parent has no parent, and the children were not targeted.
    const third = await startSession(grant, {
      parent,
      message: "work three",
    });
    const ancestor = await pause(grant, parent.session.id, {
      type: "human",
      subjectId: grant.subjectId,
    });
    expect(
      await outbox(
        grant,
        childPausedDedupeKey({ childSessionId: third.session.id, receiptId: ancestor.receipt.id }),
      ),
    ).toBeNull();
  });

  test("a no-goal session wait is ended only by immediate-class child input", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: false, message: "orchestrate" });
    const child = await startSession(grant, {
      parent,
      message: "work",
      goal: true,
    });
    const waiting = await waitForSessionInputWithEvent(
      client.db,
      grant.workspaceId,
      parent.session.id,
      {
        reason: "waiting for the worker",
        timeoutSeconds: 600,
        command: {
          accountId: grant.accountId,
          actor: {
            type: "agent_attempt",
            attemptId: parent.attemptId,
            sessionId: parent.session.id,
            turnId: parent.turn.id,
            executionGeneration: parent.turn.executionGeneration,
          },
          operationKey: crypto.randomUUID(),
        },
      },
    );
    await settleIdle(grant, parent);
    expect(await peekSessionWork(client.db, grant.workspaceId, parent.session.id)).toEqual({
      kind: "input-wait",
      disposition: "held",
      waitTurnId: parent.turn.id,
      deadlineAt: waiting.deadlineAt,
    });

    // A deferred child_progress leaves the hold in place.
    const progress = await recordSessionGoalProgressWithEvent(
      client.db,
      grant.workspaceId,
      child.session.id,
      {
        progressNote: "still working",
        command: {
          accountId: grant.accountId,
          actor: {
            type: "agent_attempt",
            attemptId: child.attemptId,
            sessionId: child.session.id,
            turnId: child.turn.id,
            executionGeneration: child.turn.executionGeneration,
          },
          operationKey: crypto.randomUUID(),
        },
      },
    );
    await deliver(
      (await outbox(
        grant,
        childProgressDedupeKey({
          childSessionId: child.session.id,
          receiptId: progress.operationId,
        }),
      ))!,
    );
    expect(await peekSessionWork(client.db, grant.workspaceId, parent.session.id)).toEqual({
      kind: "input-wait",
      disposition: "held",
      waitTurnId: parent.turn.id,
      deadlineAt: waiting.deadlineAt,
    });

    // An immediate child_requires_action ends it: the parent becomes runnable.
    await freezeChild(grant, child);
    const delivered = await deliver(
      (await outbox(
        grant,
        childRequiresActionDedupeKey({
          childSessionId: child.session.id,
          turnId: child.turn.id,
          turnGeneration: child.turn.executionGeneration,
        }),
      ))!,
    );
    if (delivered.reason !== "added") throw new Error("notice not added");
    expect(delivered.workflowWakeRevision).not.toBeNull();
    expect(await peekSessionWork(client.db, grant.workspaceId, parent.session.id)).toEqual({
      kind: "runnable",
    });
    const events = await listSessionEvents(client.db, grant.workspaceId, parent.session.id);
    expect(events.filter((event) => event.type === "system.update.pending")).toHaveLength(2);
  });

  test("codex and xai capacity waits enqueue child_waiting_capacity", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const codexChild = await startSession(grant, { parent, message: "codex work" });
    await ensureCodexRotationSettings(client.db, grant.accountId, grant.workspaceId);
    await updateCodexRotationSettings(client.db, grant.workspaceId, { rotationEnabled: true });
    const codex = await armCodexCapacityWait(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: codexChild.session.id,
      turnId: codexChild.turn.id,
      attemptId: codexChild.attemptId,
      workflowId: `session-${codexChild.session.id}`,
      earliestResetAt: new Date(Date.now() + 5 * 60_000),
      resetKind: "authoritative",
      failurePayload: { error: "all connected Codex subscriptions are unavailable" },
    });
    if (codex.action !== "waiting") throw new Error(`codex wait not armed: ${codex.action}`);
    expect(
      await outbox(
        grant,
        childWaitingCapacityDedupeKey({
          childSessionId: codexChild.session.id,
          waiterId: codex.waiter.id,
        }),
      ),
    ).toMatchObject({
      kind: "child_waiting_capacity",
      classification: "info",
      targetSessionId: parent.session.id,
      payload: {
        type: "child_waiting_capacity",
        childSessionId: codexChild.session.id,
        childTurnId: codexChild.turn.id,
        provider: "codex",
        nextCheckAt: codex.waiter.nextCheckAt.toISOString(),
      },
    });

    const xaiChild = await startSession(grant, { parent, message: "xai work" });
    const xai = await armXaiCapacityWait(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      sessionId: xaiChild.session.id,
      turnId: xaiChild.turn.id,
      attemptId: xaiChild.attemptId,
      workflowId: `session-${xaiChild.session.id}`,
      authoritySnapshot: WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
      earliestResetAt: null,
      failurePayload: { error: "all connected SuperGrok subscriptions are unavailable" },
    });
    if (xai.action !== "waiting") throw new Error(`xai wait not armed: ${xai.action}`);
    expect(
      await outbox(
        grant,
        childWaitingCapacityDedupeKey({
          childSessionId: xaiChild.session.id,
          waiterId: xai.waiter.id,
        }),
      ),
    ).toMatchObject({
      kind: "child_waiting_capacity",
      payload: { provider: "xai", childTurnId: xaiChild.turn.id },
    });
  });

  test("a child_requires_action auto-resumes a cap-paused parent goal and wakes it", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work" });
    await settleIdle(grant, parent);
    expect((await materialize(grant, parent.session.id, 1)).action).toBe("continue");
    const goalAttemptId = crypto.randomUUID();
    const goalClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: parent.session.id,
      workflowId: `session-${parent.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: goalAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (goalClaim.action !== "claimed") throw new Error("goal turn was not claimed");
    await settleIdle(grant, {
      session: parent.session,
      turn: goalClaim.turn,
      attemptId: goalAttemptId,
    });
    const paused = await materialize(grant, parent.session.id, 1);
    expect(paused.action).toBe("paused");
    expect(await getSessionGoal(client.db, grant.workspaceId, parent.session.id)).toMatchObject({
      status: "paused",
      pausedReason: "max_auto_continuations",
    });

    await freezeChild(grant, child);
    const delivered = await deliver(
      (await outbox(
        grant,
        childRequiresActionDedupeKey({
          childSessionId: child.session.id,
          turnId: child.turn.id,
          turnGeneration: child.turn.executionGeneration,
        }),
      ))!,
    );
    if (delivered.reason !== "added") throw new Error("notice not added");
    expect(delivered.events.map((event) => event.type)).toEqual([
      "system.update.pending",
      "goal.resumed",
    ]);
    expect(delivered.events[1]!.payload).toMatchObject({
      actor: "system",
      reason: "external_input",
      cause: { kind: "child_requires_action", updateId: delivered.update.id },
    });
    expect(delivered.workflowWakeRevision).not.toBeNull();
    expect(await getSessionGoal(client.db, grant.workspaceId, parent.session.id)).toMatchObject({
      status: "active",
    });
  });

  test("a delivered child_terminal_result supersedes progress but not a blocked-on-input notice", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work", goal: true });
    const progress = await recordSessionGoalProgressWithEvent(
      client.db,
      grant.workspaceId,
      child.session.id,
      {
        progressNote: "almost there",
        command: {
          accountId: grant.accountId,
          actor: {
            type: "agent_attempt",
            attemptId: child.attemptId,
            sessionId: child.session.id,
            turnId: child.turn.id,
            executionGeneration: child.turn.executionGeneration,
          },
          operationKey: crypto.randomUUID(),
        },
      },
    );
    const progressDelivered = await deliver(
      (await outbox(
        grant,
        childProgressDedupeKey({
          childSessionId: child.session.id,
          receiptId: progress.operationId,
        }),
      ))!,
    );
    if (progressDelivered.reason !== "added") throw new Error("progress not added");
    await freezeChild(grant, child);
    const blocked = await deliver(
      (await outbox(
        grant,
        childRequiresActionDedupeKey({
          childSessionId: child.session.id,
          turnId: child.turn.id,
          turnGeneration: child.turn.executionGeneration,
        }),
      ))!,
    );
    if (blocked.reason !== "added") throw new Error("notice not added");
    // Terminal delivery is unordered against notice creation (a stale idle
    // result may arrive late through the reaper), so it supersedes only the
    // progress/capacity notices; the blocked-on-input notice is superseded by
    // the exact (child, turn, generation) resolution every terminal path emits.
    const terminal = await addSessionSystemUpdateWithSourceMutation(
      client.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: parent.session.id,
        kind: "child_terminal_result",
        classification: "failure",
        sourceId: child.session.id,
        dedupeKey: `child-completion:${child.session.id}:turn:${child.turn.id}`,
        summary: "Child session failed",
        payload: {
          type: "child_terminal_result",
          childSessionId: child.session.id,
          status: "failed",
        },
      },
      async () => undefined,
    );
    if (terminal.reason !== "added") throw new Error("terminal result not added");
    expect(terminal.events.map((event) => event.type)).toEqual([
      "system.update.pending",
      "system.update.cancelled",
    ]);
    expect(terminal.events[1]!.payload).toMatchObject({
      updateIds: [progressDelivered.update.id],
      reason: "superseded_by_terminal",
    });
    expect(
      (
        await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId, parent.session.id)
      ).map((update) => update.id),
    ).toEqual([blocked.update.id, terminal.update.id]);
  });

  test("system resolutions keep their responder kind and pre-claim failure resolves leftovers", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const approvalChild = await startSession(grant, { parent, message: "approval" });
    await freezeChild(grant, approvalChild, { approvals: [{ id: "tool-call-x" }] });
    const decided = await acceptSessionApprovalDecision(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: approvalChild.session.id,
      subjectId: "system:expired",
      respondedByKind: "system",
      payload: { approvalId: "tool-call-x", decision: "reject" },
    });
    expect(decided.action).toBe("accepted");
    expect(
      await outbox(
        grant,
        childRequiresActionResolvedDedupeKey({
          childSessionId: approvalChild.session.id,
          turnId: approvalChild.turn.id,
          turnGeneration: approvalChild.turn.executionGeneration,
          requestId: null,
          approvalId: "tool-call-x",
        }),
      ),
    ).toMatchObject({ payload: { outcome: "rejected", respondedByKind: "system" } });

    const child = await startSession(grant, { parent, message: "two requests" });
    const parallelRequestId = crypto.randomUUID();
    const { requestId } = await freezeChild(grant, child, { parallelRequestId });
    const answered = await acceptSessionHumanInputResponse(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: child.session.id,
      requestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "environment", values: ["staging"] }],
      },
      respondedBy: grant.subjectId,
      respondedByKind: "api",
    });
    if (answered.action !== "accepted") throw new Error("answer was not accepted");
    expect(
      await outbox(
        grant,
        childRequiresActionResolvedDedupeKey({
          childSessionId: child.session.id,
          turnId: child.turn.id,
          turnGeneration: child.turn.executionGeneration,
          requestId,
          approvalId: null,
        }),
      ),
    ).toMatchObject({ payload: { outcome: "answered", respondedByKind: "api" } });
    // The approval-trigger admission fails permanently before any attempt
    // claims it: the leftover parallel request is cancelled and resolved.
    const failed = await failSessionWorkBeforeAttemptClaim(client.db, grant.workspaceId, {
      accountId: grant.accountId,
      sessionId: child.session.id,
      workflowId: `session-${child.session.id}`,
      trigger: { kind: "approval", triggerEventId: answered.event.id },
      error: "permanent admission failure",
    });
    expect(failed.action).toBe("failed");
    expect(failed.events).toContainEqual(
      expect.objectContaining({
        type: "user.humanInputResponse",
        payload: {
          requestId: parallelRequestId,
          response: { outcome: "cancelled" },
        },
      }),
    );
    expect(
      await outbox(
        grant,
        childRequiresActionResolvedDedupeKey({
          childSessionId: child.session.id,
          turnId: child.turn.id,
          turnGeneration: child.turn.executionGeneration,
          requestId: parallelRequestId,
          approvalId: null,
        }),
      ),
    ).toMatchObject({
      payload: { requestId: parallelRequestId, outcome: "cancelled", respondedByKind: "system" },
    });
    const replayed = await acceptSessionHumanInputResponse(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: child.session.id,
      requestId: parallelRequestId,
      response: { outcome: "skipped" },
      respondedBy: grant.subjectId,
    });
    expect(replayed).toMatchObject({
      action: "completed",
      request: { status: "cancelled", response: { outcome: "cancelled" } },
      events: [],
      workflowWakeRevision: null,
    });
  });

  test("an unparseable pending row is failed visibly at claim and a poison outbox row is dead-lettered", async () => {
    const grant = await workspace();
    const parent = await startSession(grant, { goal: true, message: "orchestrate" });
    const child = await startSession(grant, { parent, message: "work", goal: true });
    await settleIdle(grant, parent);
    const bogusId = crypto.randomUUID();
    await shared.admin`
      insert into session_system_updates
        (id, account_id, workspace_id, session_id, kind, classification, source_id, dedupe_key, summary, payload)
      values
        (${bogusId}, ${grant.accountId}, ${grant.workspaceId}, ${parent.session.id}, 'child_progress',
         'info', ${child.session.id}, ${`bogus:${bogusId}`}, 'payload from a newer image', '{"type":"child_progress"}'::jsonb)`;
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: parent.session.id,
      workflowId: `session-${parent.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).not.toBe("claimed");
    const [row] = await shared.admin<Array<{ state: string }>>`
      select state from session_system_updates where id = ${bogusId}`;
    expect(row?.state).toBe("failed");
    const events = await listSessionEvents(client.db, grant.workspaceId, parent.session.id);
    expect(
      events.some(
        (event) =>
          event.type === "system.update.cancelled" &&
          (event.payload as { reason?: string }).reason === "unrecognized_kind" &&
          ((event.payload as { updateIds?: string[] }).updateIds ?? []).includes(bogusId),
      ),
    ).toBe(true);

    const poisonId = crypto.randomUUID();
    await shared.admin`
      insert into session_system_update_outbox
        (id, account_id, workspace_id, source_session_id, target_session_id, dedupe_key, kind, classification, source_id, summary, payload)
      values
        (${poisonId}, ${grant.accountId}, ${grant.workspaceId}, ${child.session.id}, ${parent.session.id},
         ${`poison:${poisonId}`}, 'child_progress', 'info', ${child.session.id}, 'poison', '{"type":"child_progress"}'::jsonb)`;
    const progress = await recordSessionGoalProgressWithEvent(
      client.db,
      grant.workspaceId,
      child.session.id,
      {
        progressNote: "valid neighbour",
        command: {
          accountId: grant.accountId,
          actor: {
            type: "agent_attempt",
            attemptId: child.attemptId,
            sessionId: child.session.id,
            turnId: child.turn.id,
            executionGeneration: child.turn.executionGeneration,
          },
          operationKey: crypto.randomUUID(),
        },
      },
    );
    const validKey = childProgressDedupeKey({
      childSessionId: child.session.id,
      receiptId: progress.operationId,
    });
    const claimedOutbox = await claimPendingSessionSystemUpdateOutbox(client.db, 1_000);
    expect(claimedOutbox.some((delivery) => delivery.dedupeKey === validKey)).toBe(true);
    expect(claimedOutbox.some((delivery) => delivery.id === poisonId)).toBe(false);
    const [poison] = await shared.admin<Array<{ status: string; last_error: string | null }>>`
      select status, last_error from session_system_update_outbox where id = ${poisonId}`;
    expect(poison).toMatchObject({ status: "failed" });
    expect(poison?.last_error).toContain("unrecognized outbox row");
  });

  test("the rollout flag also gates progress, capacity, cancel, and terminal producers", async () => {
    configureChildLifecycleNotices({ enabled: false });
    try {
      const grant = await workspace();
      const parent = await startSession(grant, { goal: true, message: "orchestrate" });
      const child = await startSession(grant, { parent, message: "work", goal: true });
      const progress = await recordSessionGoalProgressWithEvent(
        client.db,
        grant.workspaceId,
        child.session.id,
        {
          progressNote: "quiet",
          command: {
            accountId: grant.accountId,
            actor: {
              type: "agent_attempt",
              attemptId: child.attemptId,
              sessionId: child.session.id,
              turnId: child.turn.id,
              executionGeneration: child.turn.executionGeneration,
            },
            operationKey: crypto.randomUUID(),
          },
        },
      );
      expect(
        await outbox(
          grant,
          childProgressDedupeKey({
            childSessionId: child.session.id,
            receiptId: progress.operationId,
          }),
        ),
      ).toBeNull();
      await ensureCodexRotationSettings(client.db, grant.accountId, grant.workspaceId);
      await updateCodexRotationSettings(client.db, grant.workspaceId, { rotationEnabled: true });
      const codex = await armCodexCapacityWait(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: child.session.id,
        turnId: child.turn.id,
        attemptId: child.attemptId,
        workflowId: `session-${child.session.id}`,
        earliestResetAt: null,
        resetKind: "authoritative",
        failurePayload: { error: "unavailable" },
      });
      if (codex.action !== "waiting") throw new Error("codex wait not armed");
      expect(
        await outbox(
          grant,
          childWaitingCapacityDedupeKey({
            childSessionId: child.session.id,
            waiterId: codex.waiter.id,
          }),
        ),
      ).toBeNull();
      const cancelled = await startSession(grant, { parent, message: "cancel me" });
      const { requestId } = await freezeChild(grant, cancelled);
      await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: cancelled.session.id,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "cancel",
          }),
        ),
      );
      expect(
        await outbox(
          grant,
          childRequiresActionResolvedDedupeKey({
            childSessionId: cancelled.session.id,
            turnId: cancelled.turn.id,
            turnGeneration: cancelled.turn.executionGeneration,
            requestId,
            approvalId: null,
          }),
        ),
      ).toBeNull();
      // Terminal results are not gated: the pre-existing child_terminal_result
      // still reaches the parent.
      expect(
        await outbox(grant, `child-completion:${cancelled.session.id}:cancelled`),
      ).toMatchObject({ kind: "child_terminal_result" });
      const failing = await startSession(grant, { parent, message: "fail me" });
      const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
        sessionId: failing.session.id,
        turnId: failing.turn.id,
        triggerEventId: failing.turn.triggerEventId,
        attemptId: failing.attemptId,
        turnStatus: "failed",
        sessionStatus: "failed",
        activeTurnId: null,
        events: [
          { type: "turn.failed", payload: { error: "boom" } },
          { type: "session.status.changed", payload: { status: "failed" } },
        ],
      });
      expect(settled.action).toBe("settled");
      expect(
        await outbox(grant, `child-completion:${failing.session.id}:turn:${failing.turn.id}`),
      ).toMatchObject({ kind: "child_terminal_result", payload: { status: "failed" } });
    } finally {
      configureChildLifecycleNotices({ enabled: true });
    }
  });

  test("the rollout flag gates every producer", async () => {
    configureChildLifecycleNotices({ enabled: false });
    try {
      const grant = await workspace();
      const parent = await startSession(grant, { goal: true, message: "orchestrate" });
      const child = await startSession(grant, {
        parent,
        message: "work",
      });
      const { requestId } = await freezeChild(grant, child);
      expect(
        await outbox(
          grant,
          childRequiresActionDedupeKey({
            childSessionId: child.session.id,
            turnId: child.turn.id,
            turnGeneration: child.turn.executionGeneration,
          }),
        ),
      ).toBeNull();
      const answered = await acceptSessionHumanInputResponse(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: child.session.id,
        requestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: "environment", values: ["staging"] }],
        },
        respondedBy: grant.subjectId,
      });
      expect(answered.action).toBe("accepted");
      expect(
        await outbox(
          grant,
          childRequiresActionResolvedDedupeKey({
            childSessionId: child.session.id,
            turnId: child.turn.id,
            turnGeneration: child.turn.executionGeneration,
            requestId,
            approvalId: null,
          }),
        ),
      ).toBeNull();
      const paused = await pause(grant, child.session.id, {
        type: "human",
        subjectId: grant.subjectId,
      });
      expect(
        await outbox(
          grant,
          childPausedDedupeKey({ childSessionId: child.session.id, receiptId: paused.receipt.id }),
        ),
      ).toBeNull();
    } finally {
      configureChildLifecycleNotices({ enabled: true });
    }
  });
});
