import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { OPEN_SUFFIX_RUN_STATE_BLOB } from "@opengeni/contracts";
import {
  acceptSessionApprovalDecision,
  appendSessionEvents,
  applySessionTurnSettlement,
  attachOpenSuffixToPendingToolCalls,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionEvent,
  listSessionEvents,
  listTurnOpenSuffixToolCalls,
  peekSessionWork,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  openSuffixApprovedCallIds,
  settleOpenSuffixResumeIfNeeded,
} from "../src/activities/open-suffix-resume";
import { turnExecutionInterrupted } from "../src/activities/run-input";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-cross-turn-approval-resume");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/**
 * The staging incident of 25 Nov 2026 (session 1e0d4cf5): a message sent
 * while turn A runs queues turn B; A then pauses for an approval. The person
 * approves A's call, A finishes, and B pauses for its own approval. A's
 * decision is newer than B's trigger message, but it belongs to A.
 */
async function queuedTurnPausedAfterEarlierApproval(options: { reuseCallId?: boolean } = {}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "cross-turn approval",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "cross-turn approval",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const send = (text: string) =>
    withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text,
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
  const claim = (trigger: Parameters<typeof claimSessionWorkForAttempt>[2]["trigger"]) =>
    claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger,
    });
  const claimed = async (trigger: Parameters<typeof claim>[0]) => {
    const result = await claim(trigger);
    if (result.action !== "claimed") throw new Error(`not claimed: ${JSON.stringify(result)}`);
    return result.turn;
  };
  type Turn = Awaited<ReturnType<typeof claimed>>;
  const identity = (turn: Turn) => ({
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    executionGeneration: turn.executionGeneration,
    attemptId: turn.activeAttemptId!,
  });
  const callItem = (callId: string) => ({
    type: "function_call",
    name: "gmail_update_draft",
    callId,
    status: "completed",
    arguments: "{}",
  });
  /** The turn pauses for one Gmail-style approval, as the worker records it. */
  const pauseForApproval = async (turn: Turn, callId: string) => {
    await registerPendingSessionToolCall(client.db, {
      ...identity(turn),
      callId,
      callType: "function_call",
      callItem: callItem(callId),
    });
    expect(
      await attachOpenSuffixToPendingToolCalls(client.db, {
        ...identity(turn),
        members: [{ callId, interruptionKind: "approval", reasoningItems: [] }],
      }),
    ).toEqual({ accepted: true, attached: 1 });
    const approval = { id: callId, name: "gmail_update_draft", rawItem: callItem(callId) };
    await applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: session.id,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId: turn.activeAttemptId!,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: turn.id,
      events: [
        { type: "session.requiresAction", payload: { approvals: [approval] } },
        { type: "session.status.changed", payload: { status: "requires_action" } },
      ],
      runState: {
        serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
        pendingApprovals: [approval],
      },
    });
  };
  const approve = async (callId: string) => {
    const accepted = await acceptSessionApprovalDecision(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      payload: { approvalId: callId, decision: "approve" },
    });
    if (accepted.action !== "accepted")
      throw new Error(`decision refused: ${JSON.stringify(accepted)}`);
    return accepted.event;
  };

  await send("Update the draft");
  const turnA = await claimed({ kind: "next" });
  // While A runs, the person sends another message: it queues turn B.
  await send('Rename "match" to "score"');
  const callA = `call-a-${suffix}`;
  await pauseForApproval(turnA, callA);
  const decisionA = await approve(callA);
  expect(decisionA.turnId).toBe(turnA.id);
  const resumedA = await claimed({ kind: "approval", triggerEventId: decisionA.id });
  expect(resumedA.id).toBe(turnA.id);
  expect(
    await recordPendingSessionToolCallResult(client.db, {
      ...identity(resumedA),
      callId: callA,
      resultItem: {
        type: "function_call_result",
        name: "gmail_update_draft",
        callId: callA,
        status: "completed",
        output: { type: "text", text: "draft updated" },
      },
    }),
  ).toEqual({ accepted: true, recorded: true });
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: resumedA.id,
    triggerEventId: decisionA.id,
    attemptId: resumedA.activeAttemptId!,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [
      { type: "turn.completed", payload: { output: "done" } },
      { type: "session.status.changed", payload: { status: "idle" } },
    ],
  });
  const turnB = await claimed({ kind: "next" });
  expect(turnB.id).not.toBe(turnA.id);
  // Models can repeat a call id in a later turn.
  const callB = options.reuseCallId ? callA : `call-b-${suffix}`;
  await pauseForApproval(turnB, callB);
  return {
    workspaceId,
    session,
    grant,
    send,
    claim,
    claimed,
    approve,
    identity,
    turnB,
    callB,
    decisionA,
  };
}

test("an earlier turn's approval never resumes a later paused turn", async () => {
  const world = await queuedTurnPausedAfterEarlierApproval();
  const { workspaceId, session } = world;

  // The scheduler sees no answer for B: A's decision is not B's.
  const peek = await peekSessionWork(client.db, workspaceId, session.id);
  expect(peek.kind).not.toBe("approval-pending");
  // A wake carrying A's decision (an older scheduler, a duplicate signal) is stale.
  expect(await world.claim({ kind: "approval", triggerEventId: world.decisionA.id })).toEqual({
    action: "unclaimed",
    reason: "stale-approval",
  });

  // B's own decision still resumes B.
  const decisionB = await world.approve(world.callB);
  const answered = await peekSessionWork(client.db, workspaceId, session.id);
  expect(answered).toMatchObject({ kind: "approval-pending", triggerEventId: decisionB.id });
  const resumedB = await world.claimed({ kind: "approval", triggerEventId: decisionB.id });
  expect(resumedB.id).toBe(world.turnB.id);
});

test("resuming from an answered approval is not told an execution was interrupted", async () => {
  // Staging, 26 Nov 2026 (session a7bb0c8f): the recovery note on an approval
  // resume made the model repeat a completed listing to "check state".
  const world = await queuedTurnPausedAfterEarlierApproval();
  expect(world.turnB.resumedFromPause).toBeUndefined();
  expect(turnExecutionInterrupted(world.turnB)).toBe(false);
  const decisionB = await world.approve(world.callB);
  const resumedB = await world.claimed({ kind: "approval", triggerEventId: decisionB.id });
  expect(resumedB.executionGeneration).toBe(world.turnB.executionGeneration + 1);
  expect(resumedB.resumedFromPause).toBe(true);
  expect(turnExecutionInterrupted(resumedB)).toBe(false);
});

test("a re-claim after a cut-off execution is still told to check before repeating", () => {
  expect(turnExecutionInterrupted({ executionGeneration: 1 })).toBe(false);
  expect(turnExecutionInterrupted({ executionGeneration: 2 })).toBe(true);
  expect(turnExecutionInterrupted({ executionGeneration: 3, resumedFromPause: undefined })).toBe(
    true,
  );
});

test("an answer recorded for no turn never resumes a paused turn", async () => {
  // Opengeni's own approval cards (secret use) are answered without a turn.
  const world = await queuedTurnPausedAfterEarlierApproval();
  const [turnless] = await appendSessionEvents(client.db, world.workspaceId, world.session.id, [
    {
      type: "user.humanInputResponse",
      payload: { requestId: crypto.randomUUID(), response: { outcome: "accepted" } },
    },
  ]);
  expect(turnless!.turnId).toBeNull();
  const peek = await peekSessionWork(client.db, world.workspaceId, world.session.id);
  expect(peek.kind).not.toBe("approval-pending");
  expect(await world.claim({ kind: "approval", triggerEventId: turnless!.id })).toEqual({
    action: "unclaimed",
    reason: "stale-approval",
  });
});

test("a resume whose answer matches no open call keeps waiting instead of failing", async () => {
  // A worker reached with a stale answer (for example from a scheduler that
  // predates the turn-scoped rule) settles nothing and asks again.
  const world = await queuedTurnPausedAfterEarlierApproval();
  const trigger = await getSessionEvent(client.db, world.workspaceId, world.decisionA.id);
  const settles: unknown[] = [];
  const outcome = await settleOpenSuffixResumeIfNeeded({
    db: client.db,
    agent: undefined as never,
    ...world.identity(world.turnB),
    trigger: trigger!,
    humanInputResume: null,
    settle: async (input) => {
      settles.push(input);
      return true;
    },
  });
  expect(outcome).toEqual({ action: "requires_action" });
  expect(settles).toHaveLength(1);
  expect(settles[0]).toMatchObject({
    turnStatus: "requires_action",
    events: [
      { type: "session.requiresAction", payload: { approvals: [{ id: world.callB }] } },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  const rows = await listTurnOpenSuffixToolCalls(
    client.db,
    world.workspaceId,
    world.session.id,
    world.turnB.id,
  );
  expect(rows.map((row) => [row.callId, row.resultItem])).toEqual([[world.callB, null]]);
});

test("another turn's approval never runs this turn's call with the same id", async () => {
  const world = await queuedTurnPausedAfterEarlierApproval({ reuseCallId: true });
  const trigger = await getSessionEvent(client.db, world.workspaceId, world.decisionA.id);
  expect(trigger!.turnId).not.toBe(world.turnB.id);
  expect((trigger!.payload as { approvalId: string }).approvalId).toBe(world.callB);
  // The agent is never built with the call pre-approved.
  expect(
    await openSuffixApprovedCallIds({
      db: client.db,
      ...world.identity(world.turnB),
      trigger: trigger!,
    }),
  ).toEqual([]);
  const settles: unknown[] = [];
  const outcome = await settleOpenSuffixResumeIfNeeded({
    db: client.db,
    agent: undefined as never,
    ...world.identity(world.turnB),
    trigger: trigger!,
    humanInputResume: null,
    settle: async (input) => {
      settles.push(input);
      return true;
    },
  });
  // The call is asked again, never run on the earlier turn's approval.
  expect(outcome).toEqual({ action: "requires_action" });
  expect(settles[0]).toMatchObject({
    events: [
      { type: "session.requiresAction", payload: { approvals: [{ id: world.callB }] } },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  const rows = await listTurnOpenSuffixToolCalls(
    client.db,
    world.workspaceId,
    world.session.id,
    world.turnB.id,
  );
  expect(rows.map((row) => [row.callId, row.resultItem])).toEqual([[world.callB, null]]);
});

test("a call still waiting for approval when its turn ends settles as never run", async () => {
  const world = await queuedTurnPausedAfterEarlierApproval();
  // A new message while B waits replaces B's pause; B's call never ran.
  await world.send("Never mind, leave the draft");
  const events = await listSessionEvents(client.db, world.workspaceId, world.session.id);
  const output = events.find(
    (event) =>
      event.type === "agent.toolCall.output" &&
      (event.payload as { id?: unknown }).id === world.callB,
  );
  expect(output?.payload).toMatchObject({
    output: {
      isError: true,
      content: [
        {
          type: "text",
          text: "This call was waiting for approval when the turn ended, so it never ran.",
        },
      ],
    },
    recovery: { outcome: "not_started", interrupted: true },
  });
});
