import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  appendSessionHistoryItems,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  forkSessionContent,
  getOrganizationPrivateSessionSettings,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  submitHumanPromptInTransaction,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  updateSessionVariableSets,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";

// Migration 0658: a tool receipt stranded by a completed turn must not block
// session tenancy changes forever. A live receipt still does.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0658-stranded-tool-receipts");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `stranded-receipt-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Stranded receipt owner",
  });
  const legacyWorkspaceId = context.defaultWorkspaceId!;
  const personal = context.workspaceGrants.find((grant) => grant.workspaceId !== legacyWorkspaceId);
  if (!personal?.workspaceId) throw new Error("managed human has no personal workspace");
  const accountId = personal.accountId;
  const workspaceId = personal.workspaceId;
  const privateSessions = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
  });
  if (!privateSessions.enabled) {
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: privateSessions.version,
      operationId: crypto.randomUUID(),
    });
  }
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const accepted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    workspaceId,
    subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId,
          workspaceId,
          sessionId: session.id,
          subjectId,
          actor: { type: "human", subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Run one tool, then answer",
          resources: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
      ),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed" || claimed.turn.id !== accepted.turnId) {
    throw new Error("turn was not claimed");
  }
  return {
    accountId,
    workspaceId,
    subjectId,
    sessionId: session.id,
    attemptId,
    turn: claimed.turn,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function receiptCount(f: Fixture): Promise<number> {
  const [row] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from session_pending_tool_calls where session_id = ${f.sessionId}`;
  return row!.count;
}

function transition(f: Fixture) {
  return transitionSessionVisibility(client.db, {
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    actorSubjectId: f.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `visibility-${crypto.randomUUID()}`,
  });
}

describe("tenancy quiescence and stranded tool receipts", () => {
  test("a receipt left by a completed turn no longer blocks access changes, whole-session forks or Variable Sets", async () => {
    const f = await fixture();
    const callId = `call-${crypto.randomUUID()}`;
    const identity = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      turnId: f.turn.id,
      executionGeneration: f.turn.executionGeneration,
      attemptId: f.attemptId,
      callId,
    };
    await registerPendingSessionToolCall(client.db, {
      ...identity,
      callType: "function_call",
      callItem: { type: "function_call", callId, name: "exec_command", arguments: "{}" },
    });
    // While the turn runs, access stays frozen; the earlier turn blocker
    // reports it before the receipt clause is reached.
    await expect(transition(f)).rejects.toMatchObject({
      name: "SessionTenancyConflictError",
      reason: "not_quiescent",
      blocker: "nonterminal_turn",
    });
    await recordPendingSessionToolCallResult(client.db, {
      ...identity,
      resultItem: {
        type: "function_call_result",
        callId,
        name: "exec_command",
        output: { type: "text", text: "done" },
      },
    });
    const [last] = await shared.admin<Array<{ position: number }>>`
      select coalesce(max(position), 0)::integer as position
      from session_history_items where session_id = ${f.sessionId}`;
    expect(
      await appendSessionHistoryItems(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        turnId: f.turn.id,
        expectedExecutionGeneration: f.turn.executionGeneration,
        expectedAttemptId: f.attemptId,
        items: [
          {
            position: last!.position + 1,
            item: { type: "function_call", callId, name: "exec_command", arguments: "{}" },
          },
          {
            position: last!.position + 2,
            item: {
              type: "function_call_result",
              callId,
              name: "exec_command",
              output: { type: "text", text: "done" },
            },
          },
        ],
      }),
    ).toBe(true);
    await applySessionTurnSettlement(client.db, f.workspaceId, {
      sessionId: f.sessionId,
      turnId: f.turn.id,
      triggerEventId: f.turn.triggerEventId,
      attemptId: f.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { output: "Answered" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    // Completion does not consume the receipt, so it is stranded: nothing can
    // resume it and the user has nothing to resolve.
    expect(await receiptCount(f)).toBe(1);

    expect(
      await updateSessionVariableSets(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        subjectId: f.subjectId,
        variableSets: [],
      }),
    ).toEqual({ status: "unchanged" });

    const fork = await forkSessionContent(client.db, {
      sourceWorkspaceId: f.workspaceId,
      sourceSessionId: f.sessionId,
      actorSubjectId: f.subjectId,
      destinationWorkspaceId: f.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey: `fork-${crypto.randomUUID()}`,
    });
    expect(fork.replay).toBe(false);
    expect(
      await shared.admin`select id from session_pending_tool_calls where session_id = ${fork.sessionId}`,
    ).toHaveLength(0);

    const result = await transition(f);
    expect(result.visibility).toBe("user_private");
    expect(await receiptCount(f)).toBe(1);
  }, 180_000);

  test("a receipt whose settled attempt still owes its interruption receipt keeps blocking", async () => {
    const f = await fixture();
    const callId = `call-${crypto.randomUUID()}`;
    await registerPendingSessionToolCall(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      turnId: f.turn.id,
      executionGeneration: f.turn.executionGeneration,
      attemptId: f.attemptId,
      callId,
      callType: "function_call",
      callItem: { type: "function_call", callId, name: "exec_command", arguments: "{}" },
    });
    await applySessionTurnSettlement(client.db, f.workspaceId, {
      sessionId: f.sessionId,
      turnId: f.turn.id,
      triggerEventId: f.turn.triggerEventId,
      attemptId: f.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: { output: "Answered" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(await receiptCount(f)).toBe(1);
    // A settled interruption whose physical quiescence receipt is still
    // missing: the attempt may still own tool effects, so the receipt is live.
    await shared.admin`update session_turn_attempts set quiesced_at = null where id = ${f.attemptId}`;
    const [operation] = await shared.admin<Array<{ id: string }>>`
      insert into session_command_receipts (account_id, workspace_id, actor_type,
        actor_subject_id, action, target_session_id, operation_key, canonical_request_hash)
      values (${f.accountId}, ${f.workspaceId}, 'human', ${f.subjectId}, 'session.steer',
        ${f.sessionId}, ${crypto.randomUUID()}, ${"0".repeat(64)})
      returning id`;
    await shared.admin`insert into session_attempt_interruptions
      (account_id, workspace_id, session_id, operation_id, attempt_id, kind, control_revision, state)
      values (${f.accountId}, ${f.workspaceId}, ${f.sessionId}, ${operation!.id},
        ${f.attemptId}, 'steer', 1, 'settled')`;
    await expect(transition(f)).rejects.toMatchObject({
      name: "SessionTenancyConflictError",
      reason: "not_quiescent",
      blocker: "pending_tool_receipt",
    });
    const variableSets = () =>
      updateSessionVariableSets(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        subjectId: f.subjectId,
        variableSets: [],
      });
    expect(await variableSets()).toEqual({ status: "blocked", reason: "turn_in_flight" });
    await shared.admin`update session_turn_attempts set quiesced_at = now() where id = ${f.attemptId}`;
    expect(await variableSets()).toEqual({ status: "unchanged" });
    expect((await transition(f)).visibility).toBe("user_private");
  }, 180_000);
});
