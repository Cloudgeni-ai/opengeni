import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addSessionSystemUpdate,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  applyContextCompaction,
  applySessionTurnSettlement,
  appendSessionEvents,
  appendSessionHistoryItems,
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  cancelQueuedSessionTurnWithVersion,
  claimNextSessionExecution,
  createDb,
  createSession,
  enqueueSessionMessageAtomically,
  getSessionQueueSnapshot,
  getBillingBalance,
  getActiveSessionHistoryItems,
  getSession,
  getSessionTurn,
  listPendingSessionSystemUpdates,
  listUsageEvents,
  isSessionCompactionRequested,
  requestSessionCompaction,
  requestSessionControl,
  requestSessionTurnRecovery,
  registerPendingSessionToolCall,
  registerSessionTurnDispatch,
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

describe("clean session control plane", () => {
  test("recovery closes an in-flight tool call with explicit unknown outcome exactly once", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "change the external state");
    const turn = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const attemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
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
      reason: "worker_shutdown",
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
        recovery: { interrupted: true, outcome: "unknown", reason: "worker_shutdown" },
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

  test("recovery preserves a completed parallel result and interrupts only its unresolved sibling", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "run A and B in parallel");
    const turn = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const attemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
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
    const turn = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const firstAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId: firstAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
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
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: approval!.id,
      attemptId: resumedAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
    expect(
      await recordPendingSessionToolCallResult(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
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
    const turn = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const attemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
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
      await listPendingSessionSystemUpdates(client.db, grant.workspaceId!, session.id),
    ).toHaveLength(1);
    expect(
      (await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id))?.items,
    ).toHaveLength(0);
  });

  test("idle manual compaction is a born-running maintenance execution, never queue work", async () => {
    const { grant, session } = await fixture();
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);

    const compaction = await claimNextSessionExecution(
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
    const claimedPrompt = await claimNextSessionExecution(
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
    const claimedCompaction = await claimNextSessionExecution(
      client.db,
      updateCase.grant.workspaceId!,
      updateCase.session.id,
      `session-${updateCase.session.id}`,
    );
    expect(claimedCompaction?.source).toBe("compaction");
    expect(
      await listPendingSessionSystemUpdates(
        client.db,
        updateCase.grant.workspaceId!,
        updateCase.session.id,
      ),
    ).toHaveLength(1);
  });

  test("Pause fences an active compaction attempt without consuming its request", async () => {
    const { grant, session } = await fixture();
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const compaction = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const attemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: compaction!.id,
      triggerEventId: compaction!.triggerEventId,
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });

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
    const compaction = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const attemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: compaction!.id,
      triggerEventId: compaction!.triggerEventId,
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });

    const steered = await send(grant, session.id, "use this instead", "steer");
    expect(steered.shouldSignalControl).toBe(true);
    expect((await getSessionTurn(client.db, grant.workspaceId!, compaction!.id))?.status).toBe(
      "superseded",
    );
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    const next = await claimNextSessionExecution(
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
    const first = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const attemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: first!.id,
      triggerEventId: first!.triggerEventId,
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
    expect(
      await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: first!.id,
        triggerEventId: first!.triggerEventId,
        attemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });

    const recovered = await claimNextSessionExecution(
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
    const compaction = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const attemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: compaction!.id,
      triggerEventId: compaction!.triggerEventId,
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
    await send(grant, session.id, "wait for compaction");

    const settled = await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: compaction!.id,
      triggerEventId: compaction!.triggerEventId,
      attemptId,
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
      ),
    ).toEqual({ action: "stale", episodeKey: null, events: [] });
  });

  test("Pause blocks a racing terminal settlement and Resume admits a new attempt of the same turn", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "keep this inference resumable");
    const turn = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const firstAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId: firstAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
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
    const resumedTurn = await claimNextSessionExecution(
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
    expect(
      await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: turn!.id,
        triggerEventId: turn!.triggerEventId,
        attemptId: crypto.randomUUID(),
        dispatchId: `dispatch-${crypto.randomUUID()}`,
      }),
    ).toMatchObject({ action: "registered" });
  });

  test("Send cannot erase an unsettled Pause fence", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "running prompt");
    const running = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(running?.status).toBe("running");
    const attemptId = crypto.randomUUID();
    expect(
      await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: running!.id,
        triggerEventId: running!.triggerEventId,
        attemptId,
        dispatchId: `dispatch-${crypto.randomUUID()}`,
      }),
    ).toMatchObject({ action: "registered" });
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
    const first = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const firstAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: first!.id,
      triggerEventId: first!.triggerEventId,
      attemptId: firstAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
    expect(
      await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: first!.id,
        triggerEventId: first!.triggerEventId,
        attemptId: firstAttemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });
    const second = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const secondAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: second!.id,
      triggerEventId: second!.triggerEventId,
      attemptId: secondAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
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

  test("a replaced attempt cannot compact history or overwrite its token signal", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "build it");
    const first = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const firstAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: first!.id,
      triggerEventId: first!.triggerEventId,
      attemptId: firstAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
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
    const second = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const secondAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: second!.id,
      triggerEventId: second!.triggerEventId,
      attemptId: secondAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });

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

  test("a completed model call keeps usage truth when its attempt is replaced before signals", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "meter this completed call");
    const turn = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const attemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });

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
    const first = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const firstAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: first!.id,
      triggerEventId: first!.triggerEventId,
      attemptId: firstAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
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
    const second = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const secondAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: second!.id,
      triggerEventId: second!.triggerEventId,
      attemptId: secondAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
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
    const running = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    const firstAttemptId = crypto.randomUUID();
    await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: running!.id,
      triggerEventId: running!.triggerEventId,
      attemptId: firstAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
    });
    expect(
      await applySessionTurnSettlement(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: running!.id,
        triggerEventId: running!.triggerEventId,
        attemptId: firstAttemptId,
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
    expect(
      await registerSessionTurnDispatch(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: running!.id,
        triggerEventId: approval!.id,
        attemptId: approvalAttemptId,
        dispatchId: `dispatch-${crypto.randomUUID()}`,
      }),
    ).toMatchObject({ action: "registered" });
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
    const recovered = await claimNextSessionExecution(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(recovered?.id).toBe(running!.id);
    expect(recovered?.triggerEventId).toBe(approval!.id);
    expect(recovered?.executionGeneration).toBe(running!.executionGeneration + 1);
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
      await claimNextSessionExecution(
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
      await claimNextSessionExecution(
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
});
