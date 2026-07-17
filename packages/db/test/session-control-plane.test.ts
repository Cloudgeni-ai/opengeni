import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addSessionSystemUpdate,
  acceptSessionApprovalDecision,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  applyContextCompaction,
  applySessionTurnSettlement,
  abandonRecordingForTurnAttempt,
  appendSessionEvents,
  appendSessionHistoryItems,
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  cancelQueuedSessionTurnWithVersion,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionGoal,
  enqueueSessionMessageAtomically,
  getSessionQueueSnapshot,
  getBillingBalance,
  getActiveSessionHistoryItems,
  getSession,
  getSessionTurn,
  listOutstandingSessionSystemUpdates,
  listSessionSystemUpdatesForTurn,
  listUsageEvents,
  isSessionCompactionRequested,
  insertRecording,
  getRecording,
  peekSessionWork,
  recoverSessionDispatch,
  reparkOrphanedSessionTurn,
  requestSessionCompaction,
  requestSessionControl,
  requestSessionTurnRecovery,
  registerPendingSessionToolCall,
  recordPendingSessionToolCallResult,
  recordUsageEvent,
  recordSkippedContextCompaction,
  setWorkspaceInferenceControl,
  setSessionLastInputTokensForTurnAttempt,
  settleSessionIdleWithParentOutbox,
  settlePendingSessionControl,
  withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";
import { and, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-control-plane");
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
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session control test",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session control test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  return { grant, session };
}

async function send(
  grant: { accountId: string; workspaceId: string; subjectId: string },
  sessionId: string,
  text: string,
  delivery: "queue" | "steer" = "queue",
) {
  return await enqueueSessionMessageAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    actor: grant.subjectId,
    origin: "human",
    text,
    resources: [],
    tools: [],
    clientEventId: `${delivery}-${text}-${crypto.randomUUID()}`,
    delivery,
    reasoningEffortFallback: "low",
  });
}

async function claimTestSessionWork(
  db: Parameters<typeof claimSessionWorkForAttempt>[0],
  workspaceId: string,
  sessionId: string,
  workflowId: string,
  options: {
    attemptId?: string;
    dispatchId?: string;
    trigger?: Parameters<typeof claimSessionWorkForAttempt>[2]["trigger"];
  } = {},
) {
  const result = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId,
    workflowId,
    attemptId: options.attemptId ?? crypto.randomUUID(),
    dispatchId: options.dispatchId ?? `dispatch-${crypto.randomUUID()}`,
    trigger: options.trigger ?? { kind: "next" },
  });
  return result.action === "claimed" ? result.turn : null;
}

describe("clean session control plane", () => {
  test("recovery closes an in-flight tool call with explicit unknown outcome exactly once", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "change the external state");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    expect(
      await registerPendingSessionToolCall(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
        attemptId,
        callId: "call-interrupted",
        callType: "function_call",
        callItem: {
          type: "function_call",
          name: "mutate_state",
          callId: "call-interrupted",
          status: "in_progress",
          arguments: JSON.stringify({ token: "model-truth-must-not-be-redacted" }),
        },
      }),
    ).toEqual({ accepted: true, registered: true });

    const recovery = await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      reason: "provider_unavailable",
      detail: {
        code: "provider_unavailable",
        retryable: true,
        error: "503 upstream connection termination",
        continueDelayMs: 60_000,
      },
    });
    expect(recovery.action).toBe("recovering");
    expect(recovery.events.map((event) => event.type)).toEqual([
      "agent.toolCall.output",
      "turn.recovery.requested",
      "session.status.changed",
    ]);
    expect(recovery.events[0]).toMatchObject({
      turnId: turn!.id,
      turnGeneration: turn!.executionGeneration,
      turnAttemptId: attemptId,
      payload: {
        id: "call-interrupted",
        recovery: { interrupted: true, outcome: "unknown", reason: "provider_unavailable" },
      },
    });
    expect(recovery.events[1]).toMatchObject({
      type: "turn.recovery.requested",
      payload: {
        reason: "provider_unavailable",
        code: "provider_unavailable",
        retryable: true,
        error: "503 upstream connection termination",
        continueDelayMs: 60_000,
      },
    });
    const history = await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id);
    expect(history.map((row) => row.item)).toEqual([
      { type: "message", role: "user", content: "change the external state" },
      {
        type: "function_call",
        name: "mutate_state",
        callId: "call-interrupted",
        status: "in_progress",
        arguments: JSON.stringify({ token: "model-truth-must-not-be-redacted" }),
      },
      {
        type: "function_call_result",
        name: "mutate_state",
        callId: "call-interrupted",
        status: "incomplete",
        output: {
          type: "text",
          text: expect.stringContaining("side-effect outcome is unknown"),
        },
      },
    ]);
    expect(
      await withWorkspaceRls(client.db, grant.workspaceId!, async (db) =>
        db
          .select()
          .from(schema.sessionPendingToolCalls)
          .where(eq(schema.sessionPendingToolCalls.sessionId, session.id)),
      ),
    ).toHaveLength(0);
    expect(
      await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: turn!.id,
        triggerEventId: turn!.triggerEventId,
        attemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "stale", events: [] });
  });

  test("cutover repark clears only the exact orphaned owner without creating queue work", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "continue after the production cutover");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    await registerPendingSessionToolCall(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: turn!.id,
      executionGeneration: turn!.executionGeneration,
      attemptId,
      callId: "cutover-call",
      callType: "function_call",
      callItem: {
        type: "function_call",
        name: "external_mutation",
        callId: "cutover-call",
        status: "in_progress",
        arguments: "{}",
      },
    });

    const result = await reparkOrphanedSessionTurn(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      reason: "production_cutover",
    });
    expect(result).toMatchObject({
      action: "recovering",
      sessionStatus: "recovering",
      closedToolCalls: 1,
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "agent.toolCall.output",
      "turn.recovery.requested",
      "session.status.changed",
    ]);
    expect(await getSessionTurn(client.db, grant.workspaceId!, turn!.id)).toMatchObject({
      id: turn!.id,
      status: "recovering",
      activeAttemptId: null,
      position: turn!.position,
    });
    expect(await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id)).toMatchObject({
      items: [],
    });
    expect(
      await reparkOrphanedSessionTurn(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: turn!.id,
        attemptId,
        reason: "production_cutover",
      }),
    ).toMatchObject({ action: "stale", events: [], activeAttemptId: null });
  });

  test("cutover repark recovers a partially applied 0057 turn with no attempt owner", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "continue after the interrupted schema cutover");
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db
        .update(schema.sessionTurns)
        .set({ activeAttemptId: null })
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, grant.workspaceId!),
            eq(schema.sessionTurns.id, turn!.id),
          ),
        );
    });

    const result = await reparkOrphanedSessionTurn(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      attemptId: null,
      reason: "production_cutover_partial_0057",
    });
    expect(result).toMatchObject({
      action: "recovering",
      sessionStatus: "recovering",
      closedToolCalls: 0,
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "turn.recovery.requested",
      "session.status.changed",
    ]);
    expect(result.events.every((event) => event.turnAttemptId === null)).toBe(true);
    expect(await getSessionTurn(client.db, grant.workspaceId!, turn!.id)).toMatchObject({
      status: "recovering",
      activeAttemptId: null,
    });
    expect(await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id)).toMatchObject({
      items: [],
    });
  });

  test("recovery preserves a completed parallel result and interrupts only its unresolved sibling", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "run A and B in parallel");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    for (const callId of ["call-a", "call-b"]) {
      await registerPendingSessionToolCall(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
        attemptId,
        callId,
        callType: "function_call",
        callItem: {
          type: "function_call",
          name: `tool_${callId}`,
          callId,
          status: "in_progress",
          arguments: "{}",
        },
      });
    }
    expect(
      await recordPendingSessionToolCallResult(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
        attemptId,
        callId: "call-b",
        resultItem: {
          type: "function_call_result",
          name: "tool_call-b",
          callId: "call-b",
          status: "completed",
          output: { type: "text", text: "B completed" },
        },
      }),
    ).toEqual({ accepted: true, recorded: true, allResultsRecorded: false });

    const recovery = await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      reason: "worker_shutdown",
    });
    expect(recovery.action).toBe("recovering");
    expect(recovery.events.slice(0, 2).map((event) => event.payload)).toMatchObject([
      { id: "call-b", recovery: { interrupted: false, outcome: "durable_result_found" } },
      { id: "call-a", recovery: { interrupted: true, outcome: "unknown" } },
    ]);
    const history = await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id);
    expect(history.slice(1).map((row) => [row.item.type, row.item.callId])).toEqual([
      ["function_call", "call-a"],
      ["function_call", "call-b"],
      ["function_call_result", "call-b"],
      ["function_call_result", "call-a"],
    ]);
    expect(history[3]?.item).toMatchObject({
      status: "completed",
      output: { text: "B completed" },
    });
    expect(history[4]?.item).toMatchObject({ status: "incomplete" });
  });

  test("a pending approval tool receipt follows the logical turn into its next attempt", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "use the protected tool");
    const firstAttemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: firstAttemptId },
    );
    await registerPendingSessionToolCall(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: turn!.id,
      executionGeneration: turn!.executionGeneration,
      attemptId: firstAttemptId,
      callId: "approval-call",
      callType: "function_call",
      callItem: {
        type: "function_call",
        name: "protected_tool",
        callId: "approval-call",
        status: "in_progress",
        arguments: "{}",
      },
    });
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId: firstAttemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: turn!.id,
      events: [{ type: "session.requiresAction", payload: { approvalId: "approval-call" } }],
    });
    const [approval] = await appendSessionEvents(client.db, grant.workspaceId!, session.id, [
      {
        type: "user.approvalDecision",
        turnId: turn!.id,
        payload: { approvalId: "approval-call", decision: "approve" },
      },
    ]);
    const resumedAttemptId = crypto.randomUUID();
    const resumedTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      {
        attemptId: resumedAttemptId,
        trigger: { kind: "approval", triggerEventId: approval!.id },
      },
    );
    expect(resumedTurn?.id).toBe(turn!.id);
    expect(
      await recordPendingSessionToolCallResult(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: resumedTurn!.executionGeneration,
        attemptId: resumedAttemptId,
        callId: "approval-call",
        resultItem: {
          type: "function_call_result",
          name: "protected_tool",
          callId: "approval-call",
          status: "completed",
          output: { type: "text", text: "approved result" },
        },
      }),
    ).toEqual({ accepted: true, recorded: true, allResultsRecorded: true });
    const recovery = await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: approval!.id,
      attemptId: resumedAttemptId,
      reason: "worker_shutdown",
    });
    expect(recovery.events[0]).toMatchObject({
      turnAttemptId: firstAttemptId,
      payload: {
        id: "approval-call",
        recovery: { interrupted: false, outcome: "durable_result_found" },
      },
    });
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id))
        .slice(-2)
        .map((row) => row.item.type),
    ).toEqual(["function_call", "function_call_result"]);
  });

  test("Pause preserves a pending approval, while Steer permanently closes it", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "ask before running");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    await registerPendingSessionToolCall(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: turn!.id,
      executionGeneration: turn!.executionGeneration,
      attemptId,
      callId: "pause-approval-call",
      callType: "function_call",
      callItem: {
        type: "function_call",
        name: "approval_tool",
        callId: "pause-approval-call",
        arguments: "{}",
      },
    });
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: turn!.id,
      events: [{ type: "session.requiresAction", payload: { approvalId: "pause-approval-call" } }],
    });

    const paused = await requestSessionControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actor: grant.subjectId,
      mode: "pause",
      clientEventId: `pause-${crypto.randomUUID()}`,
    });
    expect(paused.shouldSignalControl).toBe(false);
    expect(paused.events.map((event) => event.type)).toEqual([
      "user.pause",
      "session.control.paused",
      "session.status.changed",
    ]);
    expect(
      await withWorkspaceRls(client.db, grant.workspaceId!, async (db) =>
        db
          .select()
          .from(schema.sessionPendingToolCalls)
          .where(eq(schema.sessionPendingToolCalls.turnId, turn!.id)),
      ),
    ).toHaveLength(1);

    await send(grant, session.id, "replace the pending approval", "steer");
    expect(
      await withWorkspaceRls(client.db, grant.workspaceId!, async (db) =>
        db
          .select()
          .from(schema.sessionPendingToolCalls)
          .where(eq(schema.sessionPendingToolCalls.turnId, turn!.id)),
      ),
    ).toHaveLength(0);
    expect(await getSessionTurn(client.db, grant.workspaceId!, turn!.id)).toMatchObject({
      status: "superseded",
      cancelReason: "steer",
    });
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).slice(-1)[0]
        ?.item,
    ).toMatchObject({
      type: "function_call_result",
      callId: "pause-approval-call",
      status: "incomplete",
    });
  });

  test("Send appends, Steer head-inserts, and the snapshot is server order", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "first");
    await send(grant, session.id, "second");
    await send(grant, session.id, "urgent", "steer");

    const queue = await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id);
    expect(queue?.items.map((turn) => turn.prompt)).toEqual(["urgent", "first", "second"]);
    expect(queue?.items.every((turn) => ["user", "api"].includes(turn.source))).toBe(true);
  });

  test("workflow enrollment never marks a queued prompt running before turn capacity accepts it", async () => {
    const { grant, session } = await fixture();
    const queued = await send(grant, session.id, "wait for a bounded turn slot");

    expect(await peekSessionWork(client.db, grant.workspaceId!, session.id)).toEqual({
      kind: "runnable",
    });
    const before = await getSession(client.db, grant.workspaceId!, session.id);
    expect(before).toMatchObject({ status: "queued", activeTurnId: null });
    expect(await getSessionTurn(client.db, grant.workspaceId!, queued.turn.id)).toMatchObject({
      status: "queued",
      activeAttemptId: null,
      executionGeneration: 0,
    });

    const neverStartedAttemptId = crypto.randomUUID();
    expect(
      await recoverSessionDispatch(client.db, grant.workspaceId!, {
        sessionId: session.id,
        attemptId: neverStartedAttemptId,
        timeoutType: "SCHEDULE_TO_START",
        maxRedispatches: 3,
        childCompletionParentWakeEnabled: false,
      }),
    ).toEqual({ action: "unclaimed", events: [] });
    expect(await getSessionTurn(client.db, grant.workspaceId!, queued.turn.id)).toMatchObject({
      status: "queued",
      activeAttemptId: null,
      executionGeneration: 0,
    });
  });

  test("heartbeat recovery reparks only the exact owning attempt", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "survive a worker loss");
    const firstAttemptId = crypto.randomUUID();
    const first = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: firstAttemptId },
    );
    if (!first) throw new Error("first recovery attempt was not claimed");
    expect(
      await recoverSessionDispatch(client.db, grant.workspaceId!, {
        sessionId: session.id,
        attemptId: firstAttemptId,
        timeoutType: "HEARTBEAT",
        maxRedispatches: 3,
        childCompletionParentWakeEnabled: false,
      }),
    ).toMatchObject({ action: "recovering", turnId: first.id, redispatches: 1 });

    const secondAttemptId = crypto.randomUUID();
    const second = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: secondAttemptId },
    );
    expect(second).toMatchObject({
      id: first.id,
      status: "running",
      activeAttemptId: secondAttemptId,
      executionGeneration: first.executionGeneration + 1,
    });
    expect(
      await recoverSessionDispatch(client.db, grant.workspaceId!, {
        sessionId: session.id,
        attemptId: firstAttemptId,
        timeoutType: "HEARTBEAT",
        maxRedispatches: 3,
        childCompletionParentWakeEnabled: false,
      }),
    ).toMatchObject({ action: "stale", activeTurnId: first.id });
    expect(await getSessionTurn(client.db, grant.workspaceId!, first.id)).toMatchObject({
      status: "running",
      activeAttemptId: secondAttemptId,
    });
  });

  test("a waiting prompt can only be deleted with exact queue and row versions", async () => {
    const { grant, session } = await fixture();
    const queued = await send(grant, session.id, "delete me");
    const snapshot = await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id);
    const result = await cancelQueuedSessionTurnWithVersion(
      client.db,
      grant.workspaceId!,
      session.id,
      queued.turn.id,
      snapshot!.version,
      queued.turn.version,
      grant.subjectId,
      "changed my mind",
    );
    expect(result.snapshot.items).toHaveLength(0);
    expect(result.events.map((event) => event.type)).toEqual(["session.queue.prompt.cancelled"]);
  });

  test("internal updates dedupe and never appear in the prompt queue", async () => {
    const { grant, session } = await fixture();
    const input = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "child_session_update" as const,
      classification: "success" as const,
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "Child completed",
      payload: { status: "completed" },
    };
    const first = await addSessionSystemUpdate(client.db, input);
    const duplicate = await addSessionSystemUpdate(client.db, input);
    expect(first.reason).toBe("added");
    expect(duplicate.reason).toBe("duplicate");
    expect(
      await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId!, session.id),
    ).toHaveLength(1);
    expect(
      (await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id))?.items,
    ).toHaveLength(0);
  });

  test("failed internal-only inference defers updates until a real prompt", async () => {
    const { grant, session } = await fixture();
    const update = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "child_session_update",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "Child completed",
      payload: { status: "completed" },
    });
    if (!update.added) throw new Error("system update was not inserted");

    const failedAttemptId = crypto.randomUUID();
    const internalTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: failedAttemptId },
    );
    expect(internalTurn).toMatchObject({ source: "system", status: "running" });
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: internalTurn!.id,
      triggerEventId: internalTurn!.triggerEventId,
      attemptId: failedAttemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.failed", payload: { error: "provider unavailable" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });

    expect(
      await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId!, session.id),
    ).toMatchObject([{ id: update.update.id, state: "deferred", deliveredTurnId: null }]);
    expect(await peekSessionWork(client.db, grant.workspaceId!, session.id)).toEqual({
      kind: "idle",
    });
    const prompt = await send(grant, session.id, "Use the child result now");
    const promptTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(promptTurn?.id).toBe(prompt.turn.id);
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        grant.workspaceId!,
        session.id,
        promptTurn!.id,
      ),
    ).toMatchObject([{ id: update.update.id, state: "delivered" }]);
  });

  test("a new internal update collapses deferred updates into one inference", async () => {
    const { grant, session } = await fixture();
    const first = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "child_session_update",
      classification: "failure",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "First child failed",
      payload: { status: "failed" },
    });
    if (!first.added) throw new Error("first system update was not inserted");
    const failedAttemptId = crypto.randomUUID();
    const failedTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: failedAttemptId },
    );
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: failedTurn!.id,
      triggerEventId: failedTurn!.triggerEventId,
      attemptId: failedAttemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.failed", payload: { error: "provider unavailable" } }],
    });

    const second = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "child_session_update",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "Second child completed",
      payload: { status: "completed" },
    });
    if (!second.added) throw new Error("second system update was not inserted");
    const retryTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(retryTurn).toMatchObject({ source: "system", metadata: { internalUpdateCount: 2 } });
    expect(
      (
        await listSessionSystemUpdatesForTurn(
          client.db,
          grant.workspaceId!,
          session.id,
          retryTurn!.id,
        )
      ).map((entry) => entry.id),
    ).toEqual(expect.arrayContaining([first.update.id, second.update.id]));
  });

  test("a failed goal-continuation notice is terminal instead of replayable", async () => {
    const { grant, session } = await fixture();
    const goal = await createSessionGoal(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      text: "Finish the task",
      createdBy: "api",
    });
    const update = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "lifecycle_event",
      classification: "info",
      sourceId: goal.id,
      dedupeKey: `goal-continuation:${goal.id}:${goal.version}:1`,
      summary: "Continue the goal",
      payload: {
        type: "goal_continuation",
        goalId: goal.id,
        goalVersion: goal.version,
        autoContinuation: 1,
      },
    });
    if (!update.added) throw new Error("goal update was not inserted");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.failed", payload: { error: "policy blocked" } }],
    });
    const [stored] = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) =>
      db
        .select({ state: schema.sessionSystemUpdates.state })
        .from(schema.sessionSystemUpdates)
        .where(eq(schema.sessionSystemUpdates.id, update.update.id)),
    );
    expect(stored?.state).toBe("failed");
    expect(
      await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId!, session.id),
    ).toEqual([]);
  });

  test("idle manual compaction is a born-running maintenance execution, never queue work", async () => {
    const { grant, session } = await fixture();
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);

    const compaction = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(compaction).toMatchObject({
      source: "compaction",
      status: "running",
      prompt: "",
      metadata: { executionKind: "context_compaction" },
    });
    expect(
      (await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id))?.items,
    ).toEqual([]);
  });

  test("waiting prompts beat maintenance compaction, which beats internal updates", async () => {
    const promptCase = await fixture();
    await requestSessionCompaction(client.db, promptCase.grant.workspaceId!, promptCase.session.id);
    const prompt = await send(promptCase.grant, promptCase.session.id, "answer me first");
    const claimedPrompt = await claimTestSessionWork(
      client.db,
      promptCase.grant.workspaceId!,
      promptCase.session.id,
      `session-${promptCase.session.id}`,
    );
    expect(claimedPrompt?.id).toBe(prompt.turn.id);
    expect(claimedPrompt?.source).toBe("user");

    const updateCase = await fixture();
    await addSessionSystemUpdate(client.db, {
      accountId: updateCase.grant.accountId,
      workspaceId: updateCase.grant.workspaceId!,
      sessionId: updateCase.session.id,
      kind: "runtime_notice",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `notice-${crypto.randomUUID()}`,
      summary: "background update",
      payload: { type: "runtime_notice" },
    });
    await requestSessionCompaction(client.db, updateCase.grant.workspaceId!, updateCase.session.id);
    const claimedCompaction = await claimTestSessionWork(
      client.db,
      updateCase.grant.workspaceId!,
      updateCase.session.id,
      `session-${updateCase.session.id}`,
    );
    expect(claimedCompaction?.source).toBe("compaction");
    expect(
      await listOutstandingSessionSystemUpdates(
        client.db,
        updateCase.grant.workspaceId!,
        updateCase.session.id,
      ),
    ).toHaveLength(1);
  });

  test("Pause fences an active compaction attempt without consuming its request", async () => {
    const { grant, session } = await fixture();
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const compaction = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );

    const paused = await requestSessionControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actor: grant.subjectId,
      mode: "pause",
      clientEventId: `pause-${crypto.randomUUID()}`,
    });
    expect(paused.shouldSignalControl).toBe(true);
    expect(
      await recordSkippedContextCompaction(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: compaction!.id,
        expectedExecutionGeneration: compaction!.executionGeneration,
        expectedAttemptId: attemptId,
        reason: "no_history",
      }),
    ).toMatchObject({ recorded: false, reason: "session_paused" });
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
  });

  test("Steer supersedes maintenance compaction and leaves the request for the new prompt", async () => {
    const { grant, session } = await fixture();
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const compaction = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );

    const steered = await send(grant, session.id, "use this instead", "steer");
    expect(steered.shouldSignalControl).toBe(true);
    expect((await getSessionTurn(client.db, grant.workspaceId!, compaction!.id))?.status).toBe(
      "superseded",
    );
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    await settlePendingSessionControl(
      client.db,
      grant.workspaceId!,
      session.id,
      steered.controlEvent!.id,
    );
    const next = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(next?.id).toBe(steered.turn.id);
    expect(next?.source).toBe("user");
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
  });

  test("worker death recovers the same compaction execution without entering the queue", async () => {
    const { grant, session } = await fixture();
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const first = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    expect(
      await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: first!.id,
        triggerEventId: first!.triggerEventId,
        attemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });

    const recovered = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(recovered).toMatchObject({
      id: first!.id,
      source: "compaction",
      status: "running",
      executionGeneration: first!.executionGeneration + 1,
    });
    expect(
      (await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id))?.items,
    ).toEqual([]);
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
  });

  test("a prompt queued during compaction makes settlement publish queued, not idle", async () => {
    const { grant, session } = await fixture();
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const compaction = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    await send(grant, session.id, "wait for compaction");

    const settled = await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: compaction!.id,
      triggerEventId: compaction!.triggerEventId,
      attemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { maintenance: "context_compaction" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(settled).toMatchObject({ action: "settled" });
    if (settled.action === "settled") {
      expect(settled.events.at(-1)).toMatchObject({
        type: "session.status.changed",
        payload: { status: "queued" },
      });
    }
  });

  test("Pause and Resume are the only session lifecycle controls", async () => {
    const { grant, session } = await fixture();
    const paused = await requestSessionControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actor: grant.subjectId,
      mode: "pause",
      clientEventId: `pause-${crypto.randomUUID()}`,
    });
    expect(paused.controlState).toBe("paused");
    const resumed = await requestSessionControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actor: grant.subjectId,
      mode: "resume",
      clientEventId: `resume-${crypto.randomUUID()}`,
      expectedControlState: "paused",
      expectedControlGeneration: paused.controlGeneration,
    });
    expect(resumed.controlState).toBe("active");
  });

  test("idle settlement cannot cross a session or workspace Pause gate", async () => {
    const sessionPause = await fixture();
    await requestSessionControl(client.db, {
      accountId: sessionPause.grant.accountId,
      workspaceId: sessionPause.grant.workspaceId!,
      sessionId: sessionPause.session.id,
      actor: sessionPause.grant.subjectId,
      mode: "pause",
      clientEventId: `pause-${crypto.randomUUID()}`,
    });
    expect(
      await settleSessionIdleWithParentOutbox(
        client.db,
        sessionPause.grant.workspaceId!,
        sessionPause.session.id,
        false,
      ),
    ).toEqual({ action: "stale", episodeKey: null, events: [] });

    const workspacePause = await fixture();
    await setWorkspaceInferenceControl(client.db, {
      accountId: workspacePause.grant.accountId,
      workspaceId: workspacePause.grant.workspaceId!,
      actor: workspacePause.grant.subjectId,
      state: "paused",
      reason: "test workspace Pause gate",
      clientEventId: `workspace-pause-${crypto.randomUUID()}`,
      expectedState: "active",
      expectedGeneration: 0,
      exceptSessionIds: [],
    });
    expect(
      await settleSessionIdleWithParentOutbox(
        client.db,
        workspacePause.grant.workspaceId!,
        workspacePause.session.id,
        false,
      ),
    ).toEqual({ action: "stale", episodeKey: null, events: [] });
  });

  test("child terminal settlement keeps child truth and gates every parent outbox producer", async () => {
    const { grant, session: parent } = await fixture();
    const createChild = async (label: string) => {
      const child = await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: label,
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
        parentSessionId: parent.id,
      });
      await send(grant, child.id, label);
      return child;
    };
    const claimChild = async (child: Awaited<ReturnType<typeof createChild>>) => {
      const attemptId = crypto.randomUUID();
      const turn = await claimTestSessionWork(
        client.db,
        grant.workspaceId!,
        child.id,
        `session-${child.id}`,
        { attemptId },
      );
      if (!turn) throw new Error(`child turn was not claimed: ${child.id}`);
      return { attemptId, turn };
    };
    const createIdleReadyChild = async (label: string) => {
      const child = await createChild(label);
      const { attemptId, turn } = await claimChild(child);
      expect(
        await applySessionTurnSettlement(client.db, grant.workspaceId!, {
          sessionId: child.id,
          turnId: turn.id,
          triggerEventId: turn.triggerEventId,
          attemptId,
          childCompletionParentWakeEnabled: false,
          turnStatus: "completed",
          sessionStatus: "idle",
          activeTurnId: null,
          events: [],
        }),
      ).toMatchObject({ action: "settled" });
      return child;
    };
    const childOutboxes = async (childSessionId: string) =>
      await withWorkspaceRls(client.db, grant.workspaceId!, async (db) =>
        db
          .select({ id: schema.sessionSystemUpdateOutbox.id })
          .from(schema.sessionSystemUpdateOutbox)
          .where(eq(schema.sessionSystemUpdateOutbox.sourceSessionId, childSessionId)),
      );

    const idleChild = await createIdleReadyChild("disabled idle child");
    expect(
      await settleSessionIdleWithParentOutbox(client.db, grant.workspaceId!, idleChild.id, false),
    ).toMatchObject({ action: "settled" });
    expect(await getSession(client.db, grant.workspaceId!, idleChild.id)).toMatchObject({
      status: "idle",
    });
    expect(await childOutboxes(idleChild.id)).toHaveLength(0);

    const failedChild = await createChild("disabled failed child");
    const { attemptId: failedAttemptId, turn: failedTurn } = await claimChild(failedChild);
    expect(
      await applySessionTurnSettlement(client.db, grant.workspaceId!, {
        sessionId: failedChild.id,
        turnId: failedTurn.id,
        triggerEventId: failedTurn.triggerEventId,
        attemptId: failedAttemptId,
        childCompletionParentWakeEnabled: false,
        turnStatus: "failed",
        sessionStatus: "failed",
        activeTurnId: null,
        events: [{ type: "turn.failed", payload: { error: "expected test failure" } }],
      }),
    ).toMatchObject({ action: "settled" });
    expect(await getSession(client.db, grant.workspaceId!, failedChild.id)).toMatchObject({
      status: "failed",
    });
    expect(await childOutboxes(failedChild.id)).toHaveLength(0);

    const exhaustedChild = await createChild("disabled worker-death child");
    const { attemptId: exhaustedAttemptId } = await claimChild(exhaustedChild);
    expect(
      await recoverSessionDispatch(client.db, grant.workspaceId!, {
        sessionId: exhaustedChild.id,
        attemptId: exhaustedAttemptId,
        timeoutType: "HEARTBEAT",
        maxRedispatches: 0,
        childCompletionParentWakeEnabled: false,
      }),
    ).toMatchObject({ action: "exceeded" });
    expect(await getSession(client.db, grant.workspaceId!, exhaustedChild.id)).toMatchObject({
      status: "failed",
    });
    expect(await childOutboxes(exhaustedChild.id)).toHaveLength(0);

    const enabledIdleChild = await createIdleReadyChild("enabled idle child");
    expect(
      await settleSessionIdleWithParentOutbox(
        client.db,
        grant.workspaceId!,
        enabledIdleChild.id,
        true,
      ),
    ).toMatchObject({ action: "settled" });
    expect(await childOutboxes(enabledIdleChild.id)).toHaveLength(1);

    const enabledFailedChild = await createChild("enabled failed child");
    const { attemptId: enabledFailedAttemptId, turn: enabledFailedTurn } =
      await claimChild(enabledFailedChild);
    expect(
      await applySessionTurnSettlement(client.db, grant.workspaceId!, {
        sessionId: enabledFailedChild.id,
        turnId: enabledFailedTurn.id,
        triggerEventId: enabledFailedTurn.triggerEventId,
        attemptId: enabledFailedAttemptId,
        childCompletionParentWakeEnabled: true,
        turnStatus: "failed",
        sessionStatus: "failed",
        activeTurnId: null,
        events: [{ type: "turn.failed", payload: { error: "expected enabled test failure" } }],
      }),
    ).toMatchObject({ action: "settled" });
    expect(await childOutboxes(enabledFailedChild.id)).toHaveLength(1);

    const enabledExhaustedChild = await createChild("enabled worker-death child");
    const { attemptId: enabledExhaustedAttemptId } = await claimChild(enabledExhaustedChild);
    expect(
      await recoverSessionDispatch(client.db, grant.workspaceId!, {
        sessionId: enabledExhaustedChild.id,
        attemptId: enabledExhaustedAttemptId,
        timeoutType: "HEARTBEAT",
        maxRedispatches: 0,
        childCompletionParentWakeEnabled: true,
      }),
    ).toMatchObject({ action: "exceeded" });
    expect(await childOutboxes(enabledExhaustedChild.id)).toHaveLength(1);
  });

  test("Pause blocks a racing terminal settlement and Resume admits a new attempt of the same turn", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "keep this inference resumable");
    const firstAttemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: firstAttemptId },
    );
    const paused = await requestSessionControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actor: grant.subjectId,
      mode: "pause",
      clientEventId: `pause-${crypto.randomUUID()}`,
    });
    expect(paused.shouldSignalControl).toBe(true);
    expect(
      await applySessionTurnSettlement(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: turn!.id,
        triggerEventId: turn!.triggerEventId,
        attemptId: firstAttemptId,
        childCompletionParentWakeEnabled: false,
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        events: [{ type: "turn.completed", payload: { late: true } }],
      }),
    ).toMatchObject({ action: "stale", events: [] });

    const control = await settlePendingSessionControl(
      client.db,
      grant.workspaceId!,
      session.id,
      paused.event.id,
    );
    expect(control.recoveringTurnId).toBe(turn!.id);
    const resumed = await requestSessionControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actor: grant.subjectId,
      mode: "resume",
      clientEventId: `resume-${crypto.randomUUID()}`,
    });
    expect(resumed.shouldWake).toBe(true);
    const resumedTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(resumedTurn).toMatchObject({
      id: turn!.id,
      status: "running",
      executionGeneration: turn!.executionGeneration + 1,
    });
  });

  test("Send cannot erase an unsettled Pause fence", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "running prompt");
    const attemptId = crypto.randomUUID();
    const running = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    expect(running?.status).toBe("running");
    const paused = await requestSessionControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actor: grant.subjectId,
      mode: "pause",
      clientEventId: `pause-${crypto.randomUUID()}`,
    });
    expect(paused.shouldSignalControl).toBe(true);

    await send(grant, session.id, "wait behind pause");

    const [after] = await withWorkspaceRls(
      client.db,
      grant.workspaceId!,
      async (db) =>
        await db
          .select({
            pendingControlEventId: schema.sessions.pendingControlEventId,
            pendingControlKind: schema.sessions.pendingControlKind,
            pendingControlExpectedTurnId: schema.sessions.pendingControlExpectedTurnId,
            pendingControlExpectedAttemptId: schema.sessions.pendingControlExpectedAttemptId,
            controlState: schema.sessions.controlState,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, grant.workspaceId!),
              eq(schema.sessions.id, session.id),
            ),
          ),
    );
    expect(after).toBeDefined();
    expect(after!.pendingControlEventId).toBe(paused.deliveryEventId);
    expect(after!.pendingControlKind).toBe("pause");
    expect(after!.pendingControlExpectedTurnId).toBe(running!.id);
    expect(after!.pendingControlExpectedAttemptId).toBe(attemptId);
    expect(after!.controlState).toBe("paused");
  });

  test("a replaced attempt keeps late evidence but cannot publish it as current truth", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "do work");
    const firstAttemptId = crypto.randomUUID();
    const first = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: firstAttemptId },
    );
    expect(
      await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: first!.id,
        triggerEventId: first!.triggerEventId,
        attemptId: firstAttemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });
    const secondAttemptId = crypto.randomUUID();
    await claimTestSessionWork(client.db, grant.workspaceId!, session.id, `session-${session.id}`, {
      attemptId: secondAttemptId,
    });

    const rejected = await appendSessionEventsForTurnAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      first!.id,
      first!.executionGeneration,
      firstAttemptId,
      [{ type: "agent.message.completed", payload: { text: "zombie result" } }],
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.events).toHaveLength(1);
    expect(rejected.events[0]).toMatchObject({
      type: "turn.event.rejected_late",
      turnId: first!.id,
      turnGeneration: first!.executionGeneration,
      turnAttemptId: firstAttemptId,
      turnAssociation: "late_rejected",
      payload: {
        rejectedType: "agent.message.completed",
        rejectedPayload: { text: "zombie result" },
        currentAttemptId: secondAttemptId,
      },
    });
  });

  test("attempt writes run concurrently across sessions while workspace control stays exclusive", async () => {
    const { grant, session: firstSession } = await fixture();
    const secondSession = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "second session",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await send(grant, firstSession.id, "first session work");
    await send(grant, secondSession.id, "second session work");
    const firstAttemptId = crypto.randomUUID();
    const secondAttemptId = crypto.randomUUID();
    const firstTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      firstSession.id,
      `session-${firstSession.id}`,
      { attemptId: firstAttemptId },
    );
    const secondTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      secondSession.id,
      `session-${secondSession.id}`,
      { attemptId: secondAttemptId },
    );
    if (!firstTurn || !secondTurn) throw new Error("both test turns must be running");

    let releaseFirstWrite!: () => void;
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteAdmitted!: () => void;
    const firstWriteAdmission = new Promise<void>((resolve) => {
      firstWriteAdmitted = resolve;
    });
    const heldFirstWrite = withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.transaction(async (tx) => {
        await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, grant.workspaceId!))
          .for("share")
          .limit(1);
        await tx
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.id, firstSession.id))
          .for("update")
          .limit(1);
        await tx
          .select({ id: schema.sessionTurns.id })
          .from(schema.sessionTurns)
          .where(eq(schema.sessionTurns.id, firstTurn.id))
          .for("update")
          .limit(1);
        firstWriteAdmitted();
        await firstWriteReleased;
      });
    });
    await firstWriteAdmission;

    const appendTimedOut = Symbol("append timed out behind another session");
    const secondAppend = appendSessionEventsForTurnAttempt(
      client.db,
      grant.workspaceId!,
      secondSession.id,
      secondTurn.id,
      secondTurn.executionGeneration,
      secondAttemptId,
      [{ type: "agent.message.delta", payload: { text: "independent" } }],
    );
    const appendResult = await Promise.race([
      secondAppend,
      Bun.sleep(2_000).then(() => appendTimedOut),
    ]);

    let pauseSettled = false;
    const pause = (async () => {
      const result = await setWorkspaceInferenceControl(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        actor: grant.subjectId,
        state: "paused",
        reason: "concurrency test",
        clientEventId: `workspace-pause-${crypto.randomUUID()}`,
        expectedState: "active",
        expectedGeneration: 0,
        exceptSessionIds: [],
      });
      pauseSettled = true;
      return result;
    })();
    await Bun.sleep(100);

    try {
      expect(appendResult).not.toBe(appendTimedOut);
      expect(appendResult).toMatchObject({ accepted: true });
      expect(pauseSettled).toBe(false);
    } finally {
      releaseFirstWrite();
      await heldFirstWrite;
    }
    expect(await pause).toMatchObject({ state: "paused", generation: 1 });
  });

  test("a replaced attempt cannot compact history or overwrite its token signal", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "build it");
    const firstAttemptId = crypto.randomUUID();
    const first = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: firstAttemptId },
    );
    expect(
      await appendSessionHistoryItems(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: first!.id,
        expectedExecutionGeneration: first!.executionGeneration,
        expectedAttemptId: firstAttemptId,
        items: [
          {
            position: 0,
            item: { type: "message", role: "user", content: "original truth" },
          },
        ],
      }),
    ).toBe(true);
    await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: first!.id,
      triggerEventId: first!.triggerEventId,
      attemptId: firstAttemptId,
      reason: "worker_shutdown",
    });
    const secondAttemptId = crypto.randomUUID();
    const second = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: secondAttemptId },
    );

    const staleCompaction = await applyContextCompaction(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: first!.id,
      expectedExecutionGeneration: first!.executionGeneration,
      expectedAttemptId: firstAttemptId,
      replacementItems: [{ type: "message", role: "user", content: "stale rewrite" }],
      summaryItem: { type: "message", role: "user", content: "stale summary" },
      replacementInputTokens: 1,
    });
    expect(staleCompaction).toMatchObject({ applied: false });
    expect(
      await setSessionLastInputTokensForTurnAttempt(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: first!.id,
        expectedExecutionGeneration: first!.executionGeneration,
        expectedAttemptId: firstAttemptId,
        lastInputTokens: 1,
      }),
    ).toBe(false);
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual([{ type: "message", role: "user", content: "build it" }]);

    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const currentCompaction = await applyContextCompaction(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: second!.id,
      expectedExecutionGeneration: second!.executionGeneration,
      expectedAttemptId: secondAttemptId,
      replacementItems: [{ type: "message", role: "user", content: "retained request" }],
      summaryItem: { type: "message", role: "user", content: "current summary" },
      replacementInputTokens: 42,
      clearRequestedCompaction: true,
      eventPayload: {
        trigger: "operator",
        estimatedTokensBefore: 100,
        estimatedTokensAfter: 42,
      },
    });
    expect(currentCompaction).toMatchObject({ applied: true });
    if (currentCompaction.applied) {
      expect(currentCompaction.events).toHaveLength(1);
      expect(currentCompaction.events[0]).toMatchObject({
        type: "session.context.compacted",
        turnId: second!.id,
        turnAttemptId: secondAttemptId,
        payload: {
          trigger: "operator",
          estimatedTokensBefore: 100,
          estimatedTokensAfter: 42,
        },
      });
    }
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      false,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual([
      { type: "message", role: "user", content: "retained request" },
      { type: "message", role: "user", content: "current summary" },
    ]);
  });

  test("one provider response has one current usage event and auditable duplicates", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "meter one provider response");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    if (!turn) throw new Error("usage test turn was not claimed");
    const sourceKey = `response-${crypto.randomUUID()}`;

    const firstBatch = await appendSessionEventsForTurnAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      turn.id,
      turn.executionGeneration,
      attemptId,
      [
        { type: "agent.model.usage", payload: { sourceKey, totalTokens: 100 } },
        { type: "agent.model.usage", payload: { sourceKey, totalTokens: 100 } },
      ],
    );
    expect(firstBatch.accepted).toBe(true);
    expect(firstBatch.events).toHaveLength(2);
    expect(firstBatch.events[0]).toMatchObject({
      turnAssociation: "current",
      duplicateOfEventId: null,
      duplicateReason: null,
    });
    expect(firstBatch.events[1]).toMatchObject({
      turnAssociation: "duplicate",
      duplicateOfEventId: firstBatch.events[0]!.id,
      duplicateReason: "duplicate_provider_response_usage",
    });

    const later = await appendSessionEventsForTurnAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      turn.id,
      turn.executionGeneration,
      attemptId,
      [{ type: "agent.model.usage", payload: { sourceKey, totalTokens: 100 } }],
    );
    expect(later).toMatchObject({
      accepted: true,
      events: [
        {
          turnAssociation: "duplicate",
          duplicateOfEventId: firstBatch.events[0]!.id,
          duplicateReason: "duplicate_provider_response_usage",
        },
      ],
    });
  });

  test("a completed model call keeps usage truth when its attempt is replaced before signals", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "meter this completed call");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );

    await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      reason: "worker_shutdown",
    });

    const sourceKey = `response-${crypto.randomUUID()}`;
    await recordUsageEvent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      eventType: "model.tokens",
      quantity: 321,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${turn!.id}:${sourceKey}`,
      idempotencyKey: `usage:model.tokens:${turn!.id}:${sourceKey}`,
    });
    expect(
      await setSessionLastInputTokensForTurnAttempt(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        expectedExecutionGeneration: turn!.executionGeneration,
        expectedAttemptId: attemptId,
        lastInputTokens: 321,
      }),
    ).toBe(false);
    const rejected = await appendSessionEventsForTurnAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      turn!.id,
      turn!.executionGeneration,
      attemptId,
      [{ type: "agent.model.usage", payload: { sourceKey, totalTokens: 321 } }],
    );

    expect(
      (
        await listUsageEvents(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
        })
      ).filter((event) => event.idempotencyKey === `usage:model.tokens:${turn!.id}:${sourceKey}`),
    ).toHaveLength(1);
    expect((await getSession(client.db, grant.workspaceId!, session.id))?.lastInputTokens).not.toBe(
      321,
    );
    expect(rejected).toMatchObject({
      accepted: false,
      events: [
        {
          type: "turn.event.rejected_late",
          payload: { rejectedType: "agent.model.usage" },
        },
      ],
    });
  });

  test("model credit debit retries return zero and charge the ledger exactly once", async () => {
    const { grant } = await fixture();
    const before = await getBillingBalance(client.db, grant.accountId);
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      type: "test_credit_grant",
      amountMicros: 1_000,
      idempotencyKey: `grant:${crypto.randomUUID()}`,
    });
    const idempotencyKey = `credit:model_usage_debit:${crypto.randomUUID()}`;
    const input = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      type: "model_usage_debit",
      requestedAmountMicros: 400,
      sourceType: "model_response",
      sourceId: crypto.randomUUID(),
      idempotencyKey,
    };

    const first = await applyCreditDebitUpToBalance(client.db, input);
    const duplicate = await applyCreditDebitUpToBalance(client.db, input);
    expect(first.debitedMicros).toBe(400);
    expect(duplicate.debitedMicros).toBe(0);
    expect(duplicate.balance.balanceMicros).toBe(before.balanceMicros + 600);
    const rows = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) =>
      db
        .select()
        .from(schema.creditLedgerEntries)
        .where(
          and(
            eq(schema.creditLedgerEntries.accountId, grant.accountId),
            eq(schema.creditLedgerEntries.idempotencyKey, idempotencyKey),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
  });

  test("only the current attempt can consume an empty manual compaction request", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "first inference");
    const firstAttemptId = crypto.randomUUID();
    const first = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: firstAttemptId },
    );
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    expect(
      await recordSkippedContextCompaction(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: first!.id,
        expectedExecutionGeneration: first!.executionGeneration,
        expectedAttemptId: firstAttemptId,
        reason: "no_history",
      }),
    ).toMatchObject({
      recorded: true,
      events: [expect.objectContaining({ type: "session.context.compaction.skipped" })],
    });
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      false,
    );

    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: first!.id,
      triggerEventId: first!.triggerEventId,
      attemptId: firstAttemptId,
      reason: "worker_shutdown",
    });
    const secondAttemptId = crypto.randomUUID();
    await claimTestSessionWork(client.db, grant.workspaceId!, session.id, `session-${session.id}`, {
      attemptId: secondAttemptId,
    });
    expect(
      await recordSkippedContextCompaction(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: first!.id,
        expectedExecutionGeneration: first!.executionGeneration,
        expectedAttemptId: firstAttemptId,
        reason: "no_history",
      }),
    ).toMatchObject({ recorded: false, reason: "generation_changed" });
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
  });

  test("approval dispatch advances the same turn's recovery trigger", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "use the protected tool");
    const firstAttemptId = crypto.randomUUID();
    const running = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: firstAttemptId },
    );
    expect(
      await applySessionTurnSettlement(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: running!.id,
        triggerEventId: running!.triggerEventId,
        attemptId: firstAttemptId,
        childCompletionParentWakeEnabled: false,
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: running!.id,
        events: [{ type: "session.requiresAction", payload: { approvalId: "approval-1" } }],
      }),
    ).toMatchObject({ action: "settled" });
    const [approval] = await appendSessionEvents(client.db, grant.workspaceId!, session.id, [
      {
        type: "user.approvalDecision",
        payload: { approvalId: "approval-1", decision: "approve" },
      },
    ]);
    const approvalAttemptId = crypto.randomUUID();
    const approvalTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      {
        attemptId: approvalAttemptId,
        trigger: { kind: "approval", triggerEventId: approval!.id },
      },
    );
    expect(approvalTurn?.id).toBe(running!.id);
    expect((await getSessionTurn(client.db, grant.workspaceId!, running!.id))?.triggerEventId).toBe(
      approval!.id,
    );

    expect(
      await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: running!.id,
        triggerEventId: approval!.id,
        attemptId: approvalAttemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });
    const recovered = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(recovered?.id).toBe(running!.id);
    expect(recovered?.triggerEventId).toBe(approval!.id);
    expect(recovered?.executionGeneration).toBe(approvalTurn!.executionGeneration + 1);
  });

  test("approval acceptance is single-winner and restores its durable wait after workflow loss", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "wait for approval");
    const firstAttemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: firstAttemptId },
    );
    if (!turn) throw new Error("approval test turn was not claimed");
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId: firstAttemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: turn.id,
      events: [{ type: "session.requiresAction", payload: { approvalId: "approval-race" } }],
    });
    expect(await peekSessionWork(client.db, grant.workspaceId!, session.id)).toEqual({
      kind: "approval-wait",
    });

    const decisions = await Promise.all([
      acceptSessionApprovalDecision(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        payload: { approvalId: "approval-race", decision: "approve" },
        clientEventId: `approval-a-${crypto.randomUUID()}`,
      }),
      acceptSessionApprovalDecision(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        payload: { approvalId: "approval-race", decision: "reject" },
        clientEventId: `approval-b-${crypto.randomUUID()}`,
      }),
    ]);
    expect(decisions.map((decision) => decision.action).sort()).toEqual(["accepted", "conflict"]);
    const accepted = decisions.find((decision) => decision.action === "accepted");
    if (!accepted || accepted.action !== "accepted") throw new Error("approval had no winner");
    expect(await peekSessionWork(client.db, grant.workspaceId!, session.id)).toEqual({
      kind: "approval-pending",
      triggerEventId: accepted.event.id,
    });

    const resumedAttemptId = crypto.randomUUID();
    const resumed = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      {
        attemptId: resumedAttemptId,
        trigger: { kind: "approval", triggerEventId: accepted.event.id },
      },
    );
    expect(resumed).toMatchObject({
      id: turn.id,
      status: "running",
      activeAttemptId: resumedAttemptId,
      triggerEventId: accepted.event.id,
      executionGeneration: turn.executionGeneration + 1,
    });
  });

  test("a workspace pause exception is generation-bound", async () => {
    const { grant, session } = await fixture();
    const paused = await setWorkspaceInferenceControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      actor: grant.subjectId,
      state: "paused",
      reason: "maintenance",
      clientEventId: `workspace-pause-${crypto.randomUUID()}`,
      expectedState: "active",
      expectedGeneration: 0,
      exceptSessionIds: [session.id],
    });
    expect(paused.exceptionSessionIds).toEqual([session.id]);
    const pausedAgain = await setWorkspaceInferenceControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      actor: grant.subjectId,
      state: "paused",
      reason: "override exceptions",
      clientEventId: `workspace-pause-${crypto.randomUUID()}`,
      expectedState: "paused",
      expectedGeneration: paused.generation,
      exceptSessionIds: [],
    });
    expect(pausedAgain.generation).toBe(paused.generation + 1);
    expect(pausedAgain.exceptionSessionIds).toEqual([]);
  });

  test("Resume can run one session inside a paused workspace until the next workspace Pause", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "run only this session");
    const paused = await setWorkspaceInferenceControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      actor: grant.subjectId,
      state: "paused",
      reason: "workspace maintenance",
      clientEventId: `workspace-pause-${crypto.randomUUID()}`,
      expectedState: "active",
      expectedGeneration: 0,
      exceptSessionIds: [],
    });
    expect(
      await claimTestSessionWork(
        client.db,
        grant.workspaceId!,
        session.id,
        `session-${session.id}`,
      ),
    ).toBeNull();

    const resumed = await requestSessionControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actor: grant.subjectId,
      mode: "resume",
      clientEventId: `session-resume-${crypto.randomUUID()}`,
      expectedWorkspaceInferenceGeneration: paused.generation,
    });
    expect(resumed.shouldWake).toBe(true);
    let snapshot = await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id);
    expect(snapshot?.workspaceRunExceptionGeneration).toBe(paused.generation);

    const pausedAgain = await setWorkspaceInferenceControl(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      actor: grant.subjectId,
      state: "paused",
      reason: "override every explicit session run",
      clientEventId: `workspace-pause-${crypto.randomUUID()}`,
      expectedState: "paused",
      expectedGeneration: paused.generation,
      exceptSessionIds: [],
    });
    snapshot = await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id);
    expect(snapshot?.workspaceInferenceGeneration).toBe(pausedAgain.generation);
    expect(snapshot?.workspaceRunExceptionGeneration).toBeNull();
    expect(
      await claimTestSessionWork(
        client.db,
        grant.workspaceId!,
        session.id,
        `session-${session.id}`,
      ),
    ).toBeNull();

    const [row] = await withWorkspaceRls(
      client.db,
      grant.workspaceId!,
      async (db) =>
        await db
          .select({ status: schema.sessions.status })
          .from(schema.sessions)
          .where(eq(schema.sessions.id, session.id)),
    );
    expect(row?.status).toBe("paused");
  });

  test("atomically commits an available recording before terminal turn events", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "record this turn");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    if (!turn) throw new Error("recording turn was not claimed");
    const recordingId = crypto.randomUUID();
    await insertRecording(client.db, {
      id: recordingId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: turn.id,
      mode: "on-turn",
      codec: "h264-mp4",
      width: 1280,
      height: 800,
    });

    const settled = await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      recording: {
        action: "available",
        recordingId,
        storageKey: `recordings/${recordingId}.mp4`,
        sizeBytes: 42_000,
        durationSeconds: 3,
        producerId: "recording-test",
        producerSeq: 1,
      },
      events: [{ type: "turn.completed", payload: { output: "done" } }],
    });
    expect(settled).toMatchObject({ action: "settled", recordingMutationApplied: true });
    if (settled.action !== "settled") throw new Error("recording settlement became stale");
    expect(settled.events.map((event) => event.type)).toEqual([
      "recording.available",
      "turn.completed",
    ]);
    expect(settled.events[0]).toMatchObject({
      turnId: turn.id,
      turnGeneration: turn.executionGeneration,
      turnAttemptId: attemptId,
      payload: {
        recordingId,
        storageKey: `recordings/${recordingId}.mp4`,
        sizeBytes: 42_000,
        dimensions: [1280, 800],
      },
    });
    expect(await getRecording(client.db, grant.workspaceId!, recordingId)).toMatchObject({
      state: "available",
      storageKey: `recordings/${recordingId}.mp4`,
      sizeBytes: 42_000,
    });
  });

  test("settles recording failure with turn truth and discards approval-suspension phantoms", async () => {
    const failed = await fixture();
    await send(failed.grant, failed.session.id, "fail recording upload");
    const failedAttemptId = crypto.randomUUID();
    const failedTurn = await claimTestSessionWork(
      client.db,
      failed.grant.workspaceId!,
      failed.session.id,
      `session-${failed.session.id}`,
      { attemptId: failedAttemptId },
    );
    if (!failedTurn) throw new Error("failed-recording turn was not claimed");
    const failedRecordingId = crypto.randomUUID();
    await insertRecording(client.db, {
      id: failedRecordingId,
      accountId: failed.grant.accountId,
      workspaceId: failed.grant.workspaceId!,
      sessionId: failed.session.id,
      turnId: failedTurn.id,
      mode: "on-turn",
      codec: "h264-mp4",
      width: 1280,
      height: 800,
    });
    const failedSettlement = await applySessionTurnSettlement(
      client.db,
      failed.grant.workspaceId!,
      {
        sessionId: failed.session.id,
        turnId: failedTurn.id,
        triggerEventId: failedTurn.triggerEventId,
        attemptId: failedAttemptId,
        childCompletionParentWakeEnabled: false,
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        recording: {
          action: "failed",
          recordingId: failedRecordingId,
          reason: "upload-failed",
          detail: "bounded upload timeout",
        },
        events: [{ type: "turn.completed", payload: { output: "done anyway" } }],
      },
    );
    expect(failedSettlement).toMatchObject({
      action: "settled",
      recordingMutationApplied: true,
    });
    if (failedSettlement.action === "settled") {
      expect(failedSettlement.events.map((event) => event.type)).toEqual([
        "recording.failed",
        "turn.completed",
      ]);
    }
    expect(
      await getRecording(client.db, failed.grant.workspaceId!, failedRecordingId),
    ).toMatchObject({ state: "failed", reason: "bounded upload timeout" });

    const approval = await fixture();
    await send(approval.grant, approval.session.id, "request approval without computer use");
    const approvalAttemptId = crypto.randomUUID();
    const approvalTurn = await claimTestSessionWork(
      client.db,
      approval.grant.workspaceId!,
      approval.session.id,
      `session-${approval.session.id}`,
      { attemptId: approvalAttemptId },
    );
    if (!approvalTurn) throw new Error("approval turn was not claimed");
    const discardedRecordingId = crypto.randomUUID();
    await insertRecording(client.db, {
      id: discardedRecordingId,
      accountId: approval.grant.accountId,
      workspaceId: approval.grant.workspaceId!,
      sessionId: approval.session.id,
      turnId: approvalTurn.id,
      mode: "on-turn",
      codec: "h264-mp4",
      width: 1280,
      height: 800,
    });
    const suspended = await applySessionTurnSettlement(client.db, approval.grant.workspaceId!, {
      sessionId: approval.session.id,
      turnId: approvalTurn.id,
      triggerEventId: approvalTurn.triggerEventId,
      attemptId: approvalAttemptId,
      childCompletionParentWakeEnabled: false,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: approvalTurn.id,
      recording: { action: "discard", recordingId: discardedRecordingId },
      events: [{ type: "session.requiresAction", payload: { approvals: [] } }],
    });
    expect(suspended).toMatchObject({ action: "settled", recordingMutationApplied: true });
    expect(await getRecording(client.db, approval.grant.workspaceId!, discardedRecordingId)).toBe(
      null,
    );
    if (suspended.action === "settled") {
      expect(suspended.events.map((event) => event.type)).toEqual(["session.requiresAction"]);
    }
  });

  test("a stale attempt cannot mutate recording truth and cleanup requires its exact start receipt", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "race recording settlement");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    if (!turn) throw new Error("stale-recording turn was not claimed");
    const recordingId = crypto.randomUUID();
    await insertRecording(client.db, {
      id: recordingId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: turn.id,
      mode: "on-turn",
      codec: "h264-mp4",
      width: 1280,
      height: 800,
    });
    const wrongAttemptId = crypto.randomUUID();
    expect(
      await applySessionTurnSettlement(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: turn.id,
        triggerEventId: turn.triggerEventId,
        attemptId: wrongAttemptId,
        childCompletionParentWakeEnabled: false,
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        recording: {
          action: "available",
          recordingId,
          storageKey: "recordings/stale.mp4",
          sizeBytes: 1,
          durationSeconds: 1,
        },
        events: [{ type: "turn.completed", payload: {} }],
      }),
    ).toEqual({
      action: "stale",
      events: [],
      turnStatus: "running",
      activeTurnId: turn.id,
    });
    expect(await getRecording(client.db, grant.workspaceId!, recordingId)).toMatchObject({
      state: "recording",
      storageKey: null,
    });
    expect(
      await abandonRecordingForTurnAttempt(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId: wrongAttemptId,
        recordingId,
        disposition: "failed",
        reason: "wrong owner",
      }),
    ).toBe(false);
    await appendSessionEventsForTurnAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      turn.id,
      turn.executionGeneration,
      attemptId,
      [
        {
          type: "recording.started",
          payload: {
            recordingId,
            turnId: turn.id,
            mode: "on-turn",
            codec: "h264-mp4",
            dimensions: [1280, 800],
            framerate: 15,
            startedAt: new Date().toISOString(),
            reason: null,
          },
        },
      ],
    );
    expect(
      await abandonRecordingForTurnAttempt(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId,
        recordingId,
        disposition: "failed",
        reason: "exact owner cleanup",
      }),
    ).toBe(true);
    expect(await getRecording(client.db, grant.workspaceId!, recordingId)).toMatchObject({
      state: "failed",
      reason: "exact owner cleanup",
    });

    const discardId = crypto.randomUUID();
    await insertRecording(client.db, {
      id: discardId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: turn.id,
      mode: "on-turn",
      codec: "h264-mp4",
      width: 1280,
      height: 800,
    });
    await appendSessionEventsForTurnAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      turn.id,
      turn.executionGeneration,
      attemptId,
      [
        {
          type: "recording.started",
          payload: {
            recordingId: discardId,
            turnId: turn.id,
            mode: "on-turn",
            codec: "h264-mp4",
            dimensions: [1280, 800],
            framerate: 15,
            startedAt: new Date().toISOString(),
            reason: null,
          },
        },
      ],
    );
    expect(
      await abandonRecordingForTurnAttempt(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId,
        recordingId: discardId,
        disposition: "discard",
        reason: "no computer use",
      }),
    ).toBe(true);
    expect(await getRecording(client.db, grant.workspaceId!, discardId)).toBeNull();
  });
});
