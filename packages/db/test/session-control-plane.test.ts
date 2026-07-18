import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
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
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionGoal,
  evaluateSessionControl,
  evaluateSessionControls,
  evaluateGoalContinuation,
  getSessionQueueSnapshot,
  getBillingBalance,
  getActiveSessionHistoryItems,
  getSession,
  getSessionGoal,
  getSessionTurn,
  listOutstandingSessionSystemUpdates,
  listSessionDiscoverySummaries,
  listSessionSystemUpdatesForTurn,
  listUsageEvents,
  listWorkspaceControlEvents,
  isSessionCompactionRequested,
  markSessionAttemptQuiesced,
  insertRecording,
  getRecording,
  peekSessionWork,
  recoverSessionDispatch,
  requestSessionCompaction,
  requestSessionTurnRecovery,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  registerPendingSessionToolCall,
  recordPendingSessionToolCallResult,
  recordUsageEvent,
  recordSkippedContextCompaction,
  setSessionLastInputTokensForTurnAttempt,
  settleSessionIdleWithParentOutbox,
  settleSessionAttemptInterruptions,
  submitHumanPromptInTransaction,
  deleteSessionQueueItemInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
} from "../src/index";
import * as schema from "../src/schema";
import { and, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

// This file exercises the real PostgreSQL control plane. Under the repository-wide
// test run, concurrent database suites can legitimately push a case beyond Bun's
// five-second unit default. Keep a finite, file-scoped ceiling so contention cannot
// create a timeout cascade while genuine lock leaks still fail closed.
setDefaultTimeout(30_000);

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
  delivery: "send" | "steer" = "send",
) {
  const accepted = await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `${delivery}-${text}-${crypto.randomUUID()}`,
          delivery,
          text,
          resources: [],
          tools: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
  const turn = await getSessionTurn(client.db, grant.workspaceId, accepted.turnId);
  if (!turn) throw new Error(`Accepted turn missing: ${accepted.turnId}`);
  return { ...accepted, turn };
}

async function controlSession(
  grant: { accountId: string; workspaceId: string; subjectId: string },
  sessionId: string,
  action: "pause" | "resume",
) {
  return await withWorkspaceRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      mutateSessionControlInTransaction(tx as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action,
      }),
    ),
  );
}

async function controlWorkspace(
  grant: { accountId: string; workspaceId: string; subjectId: string },
  action: "pause" | "resume",
  reason = "test",
) {
  return await withWorkspaceRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      mutateWorkspaceControlInTransaction(tx as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action,
        reason,
      }),
    ),
  );
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
    workflowRunId: crypto.randomUUID(),
    attemptId: options.attemptId ?? crypto.randomUUID(),
    dispatchId: options.dispatchId ?? `dispatch-${crypto.randomUUID()}`,
    trigger: options.trigger ?? { kind: "next" },
  });
  return result.action === "claimed" ? result.turn : null;
}

describe("clean session control plane", () => {
  test("session discovery is compact-by-query and cursor-stable", async () => {
    const { grant, session: first } = await fixture();
    const second = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "second",
      resources: [],
      metadata: { mustNeverLeak: "x".repeat(100_000) },
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const third = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "third",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionEvents(client.db, grant.workspaceId!, second.id, [
      { type: "user.message", payload: { text: "p".repeat(20_000) } },
    ]);

    const all = await listSessionDiscoverySummaries(client.db, grant.workspaceId!, {
      limit: 3,
      includeLastMessage: true,
    });
    const projectedSecond = all.sessions.find((entry) => entry.id === second.id)!;
    expect(projectedSecond.latestMessage?.preview).toHaveLength(1_200);
    expect(JSON.stringify(projectedSecond)).not.toContain("mustNeverLeak");

    const pageOne = await listSessionDiscoverySummaries(client.db, grant.workspaceId!, {
      limit: 2,
    });
    expect(pageOne).toMatchObject({ total: 3, hasMore: true });
    expect(pageOne.sessions).toHaveLength(2);
    expect(pageOne.nextCursor).toBeTruthy();

    const pageTwo = await listSessionDiscoverySummaries(client.db, grant.workspaceId!, {
      limit: 2,
      cursor: pageOne.nextCursor!,
    });
    expect(pageTwo.sessions).toHaveLength(1);
    expect(pageTwo.hasMore).toBe(false);
    expect(new Set([...pageOne.sessions, ...pageTwo.sessions].map((entry) => entry.id))).toEqual(
      new Set([first.id, second.id, third.id]),
    );
  });

  test("canonical history bounds tool output while the pending receipt keeps raw recovery evidence", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "inspect a very large result");
    const attemptId = crypto.randomUUID();
    const turn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId },
    );
    const huge = "x".repeat(500_000);
    expect(
      await appendSessionHistoryItems(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        expectedExecutionGeneration: turn!.executionGeneration,
        expectedAttemptId: attemptId,
        modelToolOutputTruncationTokens: 100,
        items: [
          {
            position: 0,
            item: {
              type: "function_call",
              callId: "canonical-call",
              name: "sessions_list",
              arguments: "{}",
            },
          },
          {
            position: 1,
            item: {
              type: "function_call_result",
              callId: "canonical-call",
              output: { type: "text", text: huge },
            },
          },
        ],
      }),
    ).toBe(true);
    const canonical = await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id);
    const canonicalText = (canonical[1]!.item.output as { text: string }).text;
    expect(canonicalText).toContain("tokens truncated");
    expect(canonicalText.length).toBeLessThan(1_000);

    expect(
      await registerPendingSessionToolCall(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
        attemptId,
        callId: "pending-call",
        callType: "function_call",
        callItem: {
          type: "function_call",
          callId: "pending-call",
          name: "raw_tool",
          arguments: "{}",
        },
      }),
    ).toEqual({ accepted: true, registered: true });
    await recordPendingSessionToolCallResult(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: turn!.id,
      executionGeneration: turn!.executionGeneration,
      attemptId,
      callId: "pending-call",
      resultItem: {
        type: "function_call_result",
        callId: "pending-call",
        output: { type: "text", text: huge },
      },
    });
    const [pending] = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ resultItem: schema.sessionPendingToolCalls.resultItem })
        .from(schema.sessionPendingToolCalls)
        .where(eq(schema.sessionPendingToolCalls.callId, "pending-call")),
    );
    expect(((pending!.resultItem as any).output as { text: string }).text).toBe(huge);

    const recovery = await requestSessionTurnRecovery(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: turn!.id,
      triggerEventId: turn!.triggerEventId,
      attemptId,
      reason: "worker_shutdown",
    });
    expect(recovery).toMatchObject({ action: "recovering" });
    const recoveredHistory = await getActiveSessionHistoryItems(
      client.db,
      grant.workspaceId!,
      session.id,
    );
    const recoveredResult = recoveredHistory
      .map((row) => row.item)
      .find(
        (item) =>
          item.type === "function_call_result" &&
          (item as { callId?: unknown }).callId === "pending-call",
      ) as { output: { text: string } };
    expect(recoveredResult.output.text).toContain("tokens truncated");
    expect(recoveredResult.output.text.length).toBeLessThan(50_000);
    const recoveryOutput = recovery.events.find(
      (event) =>
        event.type === "agent.toolCall.output" &&
        (event.payload as { id?: unknown }).id === "pending-call",
    )?.payload as { output: { text: string } };
    expect(recoveryOutput.output.text).toBe(huge);
  });

  test("bulk control projection accepts an empty session page", async () => {
    const { grant } = await fixture();
    expect(
      await evaluateSessionControls(client.db, grant.workspaceId!, [], {
        lock: "share",
      }),
    ).toEqual(new Map());
  });

  test("bulk control projection reuses shared ancestors without changing per-session truth", async () => {
    const { grant, session: root } = await fixture();
    const child = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: root.id,
    });
    await controlSession(grant, root.id, "pause");

    const projected = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      evaluateSessionControls(db, grant.workspaceId!, [root.id, child.id, child.id], {
        lock: "share",
      }),
    );
    expect(projected.size).toBe(2);
    expect(projected.get(root.id)).toEqual(
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        evaluateSessionControl(db, grant.workspaceId!, root.id),
      ),
    );
    expect(projected.get(child.id)).toEqual(
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        evaluateSessionControl(db, grant.workspaceId!, child.id),
      ),
    );
    expect(projected.get(child.id)).toMatchObject({
      state: "paused",
      primaryBlocker: { kind: "session", sessionId: root.id },
    });
  });

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
          arguments: JSON.stringify({
            token: "model-truth-must-not-be-redacted",
          }),
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
        arguments: JSON.stringify({
          token: "model-truth-must-not-be-redacted",
        }),
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
      {
        id: "call-b",
        recovery: { interrupted: false, outcome: "durable_result_found" },
      },
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
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: turn!.id,
      events: [
        {
          type: "session.requiresAction",
          payload: { approvalId: "approval-call" },
        },
      ],
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
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: turn!.id,
      events: [
        {
          type: "session.requiresAction",
          payload: { approvalId: "pause-approval-call" },
        },
      ],
    });

    const paused = await controlSession(grant, session.id, "pause");
    expect(paused.interruptionCount).toBe(0);
    expect(paused.control.state).toBe("paused");
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
      }),
    ).toMatchObject({
      action: "recovering",
      turnId: first.id,
      redispatches: 1,
    });

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
    const result = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        deleteSessionQueueItemInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          turnId: queued.turn.id,
          expectedTurnVersion: queued.turn.version,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          reason: "changed my mind",
        }),
      ),
    );
    expect(result.items).toHaveLength(0);
    expect(await getSessionTurn(client.db, grant.workspaceId!, queued.turn.id)).toMatchObject({
      status: "cancelled",
      cancelReason: "changed my mind",
    });
  });

  test("internal updates dedupe and never appear in the prompt queue", async () => {
    const { grant, session } = await fixture();
    const input = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "child_terminal_result" as const,
      classification: "success" as const,
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "Child completed",
      payload: {
        type: "child_terminal_result" as const,
        childSessionId: crypto.randomUUID(),
        status: "idle" as const,
      },
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
      kind: "child_terminal_result",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "Child completed",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
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
      kind: "child_terminal_result",
      classification: "failure",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "First child failed",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "failed",
      },
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
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.failed", payload: { error: "provider unavailable" } }],
    });

    const second = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "child_terminal_result",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "Second child completed",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    });
    if (!second.added) throw new Error("second system update was not inserted");
    const retryTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
    );
    expect(retryTurn).toMatchObject({
      source: "system",
      metadata: { internalUpdateCount: 2 },
    });
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
      kind: "goal_continuation",
      classification: "info",
      sourceId: goal.id,
      dedupeKey: `goal-continuation:${goal.id}:${goal.version}:1`,
      summary: "Continue the goal",
      payload: {
        type: "goal_continuation",
        goalId: goal.id,
        goalVersion: goal.version,
        autoContinuation: 1,
        prompt: "Continue the goal",
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

  test("a compaction failure blocks autonomous goal retry until newer finished-turn truth exists", async () => {
    const { grant, session } = await fixture();
    const goal = await createSessionGoal(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      text: "Finish without compaction churn",
      createdBy: "api",
    });
    const firstDecision = await evaluateGoalContinuation(client.db, {
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      noProgressLimit: 3,
    });
    expect(firstDecision).toMatchObject({ decision: "continue", autoContinuation: 1 });
    if (firstDecision.decision !== "continue") throw new Error("goal did not continue");
    const update = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "goal_continuation",
      classification: "info",
      sourceId: goal.id,
      dedupeKey: `goal-continuation:${goal.id}:${goal.version}:1`,
      summary: "Continue the goal",
      payload: {
        type: "goal_continuation",
        goalId: goal.id,
        goalVersion: goal.version,
        autoContinuation: 1,
        prompt: "Continue the goal",
      },
    });
    if (!update.added) throw new Error("goal continuation update was not inserted");
    const failedAttemptId = crypto.randomUUID();
    const failedTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: failedAttemptId },
    );
    expect(failedTurn).toMatchObject({ source: "goal", status: "running" });
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: failedTurn!.id,
      triggerEventId: failedTurn!.triggerEventId,
      attemptId: failedAttemptId,
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        {
          type: "turn.failed",
          payload: {
            error: "checkpoint provider failed",
            code: "context_compaction_failed",
            retryable: false,
            recovery: "user_message",
          },
        },
      ],
    });

    expect(
      await evaluateGoalContinuation(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        noProgressLimit: 3,
      }),
    ).toEqual({ decision: "none" });
    expect(await getSessionGoal(client.db, grant.workspaceId!, session.id)).toMatchObject({
      status: "active",
      autoContinuations: 1,
      noProgressStreak: 0,
    });

    const human = await send(grant, session.id, "Retry from the preserved history");
    expect(
      await evaluateGoalContinuation(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        noProgressLimit: 3,
      }),
    ).toEqual({ decision: "queue" });
    const humanAttemptId = crypto.randomUUID();
    const humanTurn = await claimTestSessionWork(
      client.db,
      grant.workspaceId!,
      session.id,
      `session-${session.id}`,
      { attemptId: humanAttemptId },
    );
    expect(humanTurn?.id).toBe(human.turn.id);
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: session.id,
      turnId: humanTurn!.id,
      triggerEventId: humanTurn!.triggerEventId,
      attemptId: humanAttemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { output: "continued" } }],
    });
    expect(
      await evaluateGoalContinuation(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        noProgressLimit: 3,
      }),
    ).toMatchObject({ decision: "continue", autoContinuation: 1 });
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
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `notice-${crypto.randomUUID()}`,
      summary: "background update",
      payload: {
        type: "agent_message",
        text: "background update",
        operationId: crypto.randomUUID(),
      },
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

    const paused = await controlSession(grant, session.id, "pause");
    expect(paused.interruptionCount).toBe(1);
    expect(paused.wakeCount).toBe(1);
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

    await expect(
      markSessionAttemptQuiesced(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        attemptId,
        temporalWorkflowId: `session-${session.id}`,
      }),
    ).rejects.toThrow(/without its interruption/);
    expect(
      await markSessionAttemptQuiesced(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        attemptId,
        temporalWorkflowId: `session-${session.id}`,
        allowUninterrupted: true,
      }),
    ).toEqual([]);

    const steered = await send(grant, session.id, "use this instead", "steer");
    expect(steered.interruptionCount).toBe(1);
    const stopping = await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id);
    expect(stopping?.stoppingPreviousAttempt).toBe(true);
    expect(stopping?.items[0]).toMatchObject({
      id: steered.turn.id,
      metadata: {
        delivery: "steer",
        replacedTurnId: compaction!.id,
        replacedAttemptId: attemptId,
        interruptionCount: 1,
      },
    });
    expect((await getSessionTurn(client.db, grant.workspaceId!, compaction!.id))?.status).toBe(
      "running",
    );
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    const quiescenceEvents = await markSessionAttemptQuiesced(client.db, {
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      attemptId,
      temporalWorkflowId: `session-${session.id}`,
    });
    await settleSessionAttemptInterruptions(client.db, grant.workspaceId!, session.id, attemptId);
    expect(
      (await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id))
        ?.stoppingPreviousAttempt,
    ).toBe(false);
    expect(quiescenceEvents).toEqual([
      expect.objectContaining({
        type: "session.queue.changed",
        turnId: compaction!.id,
        turnAttemptId: attemptId,
        turnAssociation: null,
        payload: {
          operation: "attempt_quiesced",
          attemptId,
          queueVersion: stopping!.version + 1,
        },
      }),
    ]);
    expect(
      await markSessionAttemptQuiesced(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        attemptId,
        temporalWorkflowId: `session-${session.id}`,
      }),
    ).toEqual(quiescenceEvents);
    expect(await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id)).toMatchObject({
      version: stopping!.version + 1,
      stoppingPreviousAttempt: false,
    });
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
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        {
          type: "turn.completed",
          payload: { maintenance: "context_compaction" },
        },
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
    const paused = await controlSession(grant, session.id, "pause");
    expect(paused.control.state).toBe("paused");
    expect((await getSession(client.db, grant.workspaceId!, session.id))?.status).toBe("queued");
    const resumed = await controlSession(grant, session.id, "resume");
    expect(resumed.control.state).toBe("active");
  });

  test("a human send through Pause writes one automatic Resume invalidation", async () => {
    const { grant, session } = await fixture();
    const paused = await controlWorkspace(grant, "pause", "maintenance");
    const accepted = await send(grant, session.id, "continue through the pause");
    expect(accepted.workspaceControlEventId).toEqual(expect.any(String));
    const events = await listWorkspaceControlEvents(client.db, grant.workspaceId!, 0, 10);
    expect(events).toEqual([
      expect.objectContaining({
        revision: paused.revision,
        scope: "workspace",
        rootSessionId: null,
        action: "pause",
        automatic: false,
      }),
      expect.objectContaining({
        revision: paused.revision + 1,
        scope: "session",
        rootSessionId: session.id,
        action: "resume",
        automatic: true,
        reason: "human_send",
      }),
    ]);
  });

  test("idle settlement cannot cross a session or workspace Pause gate", async () => {
    const sessionPause = await fixture();
    await controlSession(sessionPause.grant, sessionPause.session.id, "pause");
    expect(
      await settleSessionIdleWithParentOutbox(
        client.db,
        sessionPause.grant.workspaceId!,
        sessionPause.session.id,
      ),
    ).toEqual({ action: "stale", episodeKey: null, events: [] });

    const workspacePause = await fixture();
    await controlWorkspace(workspacePause.grant, "pause", "test workspace Pause gate");
    expect(
      await settleSessionIdleWithParentOutbox(
        client.db,
        workspacePause.grant.workspaceId!,
        workspacePause.session.id,
      ),
    ).toEqual({ action: "stale", episodeKey: null, events: [] });
  });

  test("every child terminal path durably produces one parent update", async () => {
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
          .select({
            id: schema.sessionSystemUpdateOutbox.id,
            dedupeKey: schema.sessionSystemUpdateOutbox.dedupeKey,
            payload: schema.sessionSystemUpdateOutbox.payload,
            lineage: schema.sessionSystemUpdateOutbox.lineage,
          })
          .from(schema.sessionSystemUpdateOutbox)
          .where(eq(schema.sessionSystemUpdateOutbox.sourceSessionId, childSessionId)),
      );

    const idleChild = await createIdleReadyChild("idle child");
    expect(
      await settleSessionIdleWithParentOutbox(client.db, grant.workspaceId!, idleChild.id),
    ).toMatchObject({ action: "settled" });
    expect(await getSession(client.db, grant.workspaceId!, idleChild.id)).toMatchObject({
      status: "idle",
    });
    expect(await childOutboxes(idleChild.id)).toHaveLength(1);

    const failedChild = await createChild("failed child");
    const { attemptId: failedAttemptId, turn: failedTurn } = await claimChild(failedChild);
    expect(
      await applySessionTurnSettlement(client.db, grant.workspaceId!, {
        sessionId: failedChild.id,
        turnId: failedTurn.id,
        triggerEventId: failedTurn.triggerEventId,
        attemptId: failedAttemptId,
        turnStatus: "failed",
        sessionStatus: "failed",
        activeTurnId: null,
        events: [{ type: "turn.failed", payload: { error: "expected test failure" } }],
      }),
    ).toMatchObject({ action: "settled" });
    expect(await getSession(client.db, grant.workspaceId!, failedChild.id)).toMatchObject({
      status: "failed",
    });
    expect(await childOutboxes(failedChild.id)).toEqual([
      expect.objectContaining({
        dedupeKey: `child-completion:${failedChild.id}:turn:${failedTurn.id}`,
        payload: expect.objectContaining({
          type: "child_terminal_result",
          childSessionId: failedChild.id,
          status: "failed",
          turnId: failedTurn.id,
        }),
        lineage: expect.objectContaining({
          childSessionId: failedChild.id,
          parentSessionId: parent.id,
          turnId: failedTurn.id,
        }),
      }),
    ]);

    const exhaustedChild = await createChild("worker-death child");
    const { attemptId: exhaustedAttemptId, turn: exhaustedTurn } = await claimChild(exhaustedChild);
    const exhausted = await recoverSessionDispatch(client.db, grant.workspaceId!, {
      sessionId: exhaustedChild.id,
      attemptId: exhaustedAttemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 0,
    });
    expect(exhausted).toMatchObject({ action: "exceeded", turnId: exhaustedTurn.id });
    expect(await getSession(client.db, grant.workspaceId!, exhaustedChild.id)).toMatchObject({
      status: "failed",
    });
    expect(await childOutboxes(exhaustedChild.id)).toEqual([
      expect.objectContaining({
        dedupeKey: `child-completion:${exhaustedChild.id}:turn:${exhaustedTurn.id}`,
        payload: expect.objectContaining({ turnId: exhaustedTurn.id }),
        lineage: expect.objectContaining({ turnId: exhaustedTurn.id }),
      }),
    ]);
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
    const paused = await controlSession(grant, session.id, "pause");
    expect(paused.interruptionCount).toBe(1);
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

    const control = await settleSessionAttemptInterruptions(
      client.db,
      grant.workspaceId!,
      session.id,
      firstAttemptId,
    );
    expect(control).toMatchObject({ action: "paused", turnId: turn!.id });
    await markSessionAttemptQuiesced(client.db, {
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      attemptId: firstAttemptId,
      temporalWorkflowId: `session-${session.id}`,
    });
    const resumed = await controlSession(grant, session.id, "resume");
    expect(resumed.wakeCount).toBeGreaterThanOrEqual(1);
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

  test("Send reopens admission without erasing an unsettled Pause interruption", async () => {
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
    const paused = await controlSession(grant, session.id, "pause");
    expect(paused.interruptionCount).toBe(1);

    await send(grant, session.id, "wait behind pause");

    const [after] = await withWorkspaceRls(
      client.db,
      grant.workspaceId!,
      async (db) =>
        await db
          .select({
            attemptId: schema.sessionAttemptInterruptions.attemptId,
            kind: schema.sessionAttemptInterruptions.kind,
            state: schema.sessionAttemptInterruptions.state,
          })
          .from(schema.sessionAttemptInterruptions)
          .where(
            and(
              eq(schema.sessionAttemptInterruptions.workspaceId, grant.workspaceId!),
              eq(schema.sessionAttemptInterruptions.sessionId, session.id),
              eq(schema.sessionAttemptInterruptions.attemptId, attemptId),
            ),
          ),
    );
    expect(after).toMatchObject({
      attemptId,
      kind: "session_pause",
      state: "pending",
    });
    expect(
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        evaluateSessionControl(db, grant.workspaceId!, session.id),
      ),
    ).toMatchObject({
      state: "active",
      settlement: { state: "stopping", attemptCount: 1 },
    });
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
      const result = await controlWorkspace(grant, "pause", "concurrency test");
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
    expect(await pause).toMatchObject({
      workspaceState: "paused",
      revision: 1,
    });
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
      summaryItem: {
        type: "message",
        role: "user",
        content: "current summary",
      },
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
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: running!.id,
        events: [
          {
            type: "session.requiresAction",
            payload: { approvalId: "approval-1" },
          },
        ],
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
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: turn.id,
      events: [
        {
          type: "session.requiresAction",
          payload: { approvalId: "approval-race" },
        },
      ],
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

  test("a committed session control command replays before its stale control fence is checked", async () => {
    const { grant, session } = await fixture();
    const before = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      evaluateSessionControl(db, grant.workspaceId!, session.id),
    );
    const operationKey = crypto.randomUUID();
    const mutate = async () =>
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            sessionId: session.id,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey,
            action: "pause",
            reason: "idempotent session retry",
            expectedControlEtag: before.controlEtag,
          }),
        ),
      );

    const first = await mutate();
    expect(first.replay).toBe(false);
    const replay = await mutate();
    expect(replay).toMatchObject({
      replay: true,
      workspaceControlEventId: first.workspaceControlEventId,
      control: { state: "paused" },
    });
    expect(replay.receipt.id).toBe(first.receipt.id);
    expect(await listWorkspaceControlEvents(client.db, grant.workspaceId!, 0, 10)).toHaveLength(1);
  });

  test("a committed workspace control command replays before its stale revision is checked", async () => {
    const { grant } = await fixture();
    const operationKey = crypto.randomUUID();
    const mutate = async () =>
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          mutateWorkspaceControlInTransaction(tx as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey,
            action: "pause",
            reason: "idempotent workspace retry",
            expectedRevision: 0,
          }),
        ),
      );

    const first = await mutate();
    expect(first).toMatchObject({
      replay: false,
      revision: 1,
      workspaceState: "paused",
    });
    const replay = await mutate();
    expect(replay).toMatchObject({
      replay: true,
      revision: 1,
      workspaceState: "paused",
      workspaceControlEventId: first.workspaceControlEventId,
    });
    expect(replay.receipt.id).toBe(first.receipt.id);
    expect(await listWorkspaceControlEvents(client.db, grant.workspaceId!, 0, 10)).toHaveLength(1);
  });

  test("a selected branch override is invalidated by the next workspace Pause", async () => {
    const { grant, session } = await fixture();
    const paused = await controlWorkspace(grant, "pause", "maintenance");
    const resumed = await controlSession(grant, session.id, "resume");
    expect(resumed.control.state).toBe("active");
    expect(resumed.control.override?.rootSessionId).toBe(session.id);
    const pausedAgain = await controlWorkspace(grant, "pause", "override exceptions");
    expect(pausedAgain.revision).toBe(paused.revision + 2);
    expect(
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        evaluateSessionControl(db, grant.workspaceId!, session.id),
      ),
    ).toMatchObject({
      state: "paused",
      primaryBlocker: { kind: "workspace" },
    });
  });

  test("Resume can run one session inside a paused workspace until the next workspace Pause", async () => {
    const { grant, session } = await fixture();
    await send(grant, session.id, "run only this session");
    const pauseWorkspace = async (reason: string) =>
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        mutateWorkspaceControlInTransaction(db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
          reason,
        }),
      );
    const paused = await pauseWorkspace("workspace maintenance");
    expect(paused.wakeCount).toBe(0);
    expect(
      await claimTestSessionWork(
        client.db,
        grant.workspaceId!,
        session.id,
        `session-${session.id}`,
      ),
    ).toBeNull();

    const resumed = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      mutateSessionControlInTransaction(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action: "resume",
      }),
    );
    expect(resumed.wakeCount).toBe(1);
    expect(resumed.control).toMatchObject({
      state: "active",
      override: { rootSessionId: session.id },
    });

    const pausedAgain = await pauseWorkspace("override every explicit session run");
    expect(pausedAgain.revision).toBeGreaterThan(paused.revision);
    expect(
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        evaluateSessionControl(db, grant.workspaceId!, session.id),
      ),
    ).toMatchObject({ state: "paused", primaryBlocker: { kind: "workspace" } });
    expect(
      await claimTestSessionWork(
        client.db,
        grant.workspaceId!,
        session.id,
        `session-${session.id}`,
      ),
    ).toBeNull();

    const [row] = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ status: schema.sessions.status })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, session.id)),
    );
    expect(row?.status).toBe("queued");
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
    expect(settled).toMatchObject({
      action: "settled",
      recordingMutationApplied: true,
    });
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
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: approvalTurn.id,
      recording: { action: "discard", recordingId: discardedRecordingId },
      events: [{ type: "session.requiresAction", payload: { approvals: [] } }],
    });
    expect(suspended).toMatchObject({
      action: "settled",
      recordingMutationApplied: true,
    });
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
