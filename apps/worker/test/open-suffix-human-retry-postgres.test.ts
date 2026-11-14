import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  appendSessionEvents,
  applySessionTurnSettlement,
  attachOpenSuffixToPendingToolCalls,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionEvent,
  listTurnOpenSuffixToolCalls,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  retryFailedSessionInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { prepareRunInput, type OpenGeniRuntime } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { turnInput } from "../src/activities/run-input";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-open-suffix-human-retry");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const executionPolicy = resolveTurnExecutionPolicyV1(testSettings(), {
  modelId: "scripted-model",
  requestedModelId: null,
  modelSource: "session",
  reasoningEffort: "medium",
  reasoningSource: "explicit",
  latencyMode: "standard",
  latencyModeSource: "session",
});

/**
 * A turn paused for an approval, the person approved it, the resumed attempt
 * recorded the approved call's result, and the next model request failed the
 * turn terminally. Returns the failed turn's approval trigger.
 */
async function approvedTurnThatFailedTerminally() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "approval retry",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "approval retry",
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
  const scope = <T>(
    fn: (db: Parameters<typeof retryFailedSessionInTransaction>[0]) => Promise<T>,
  ) => withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, fn);
  await scope((db) =>
    submitHumanPromptInTransaction(db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Use the protected tool",
      resources: [],
      reasoningEffortFallback: "medium",
      source: "user",
    }),
  );
  const claim = async (trigger: Parameters<typeof claimSessionWorkForAttempt>[2]["trigger"]) => {
    const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger,
    });
    if (claimed.action !== "claimed") throw new Error(`not claimed: ${claimed.action}`);
    return claimed.turn;
  };
  const paused = await claim({ kind: "next" });
  const callId = `approval-${suffix}`;
  const callItem = {
    type: "function_call",
    name: "protected_tool",
    callId,
    status: "completed",
    arguments: "{}",
  };
  const identity = (turn: typeof paused) => ({
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    executionGeneration: turn.executionGeneration,
    attemptId: turn.activeAttemptId!,
  });
  await registerPendingSessionToolCall(client.db, {
    ...identity(paused),
    callId,
    callType: "function_call",
    callItem,
  });
  expect(
    await attachOpenSuffixToPendingToolCalls(client.db, {
      ...identity(paused),
      members: [{ callId, interruptionKind: "approval", reasoningItems: [] }],
    }),
  ).toEqual({ accepted: true, attached: 1 });
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: paused.id,
    triggerEventId: paused.triggerEventId,
    attemptId: paused.activeAttemptId!,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: paused.id,
    events: [{ type: "session.requiresAction", payload: { approvalId: callId } }],
  });
  const [approval] = await appendSessionEvents(client.db, workspaceId, session.id, [
    {
      type: "user.approvalDecision",
      turnId: paused.id,
      payload: { approvalId: callId, decision: "approve" },
    },
  ]);
  const resumed = await claim({ kind: "approval", triggerEventId: approval!.id });
  expect(resumed.id).toBe(paused.id);
  expect(
    await recordPendingSessionToolCallResult(client.db, {
      ...identity(resumed),
      callId,
      resultItem: {
        type: "function_call_result",
        name: "protected_tool",
        callId,
        status: "completed",
        output: { type: "text", text: "approved result" },
      },
    }),
  ).toEqual({ accepted: true, recorded: true });
  // The next model request fails terminally (automatic recovery exhausted).
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: resumed.id,
    triggerEventId: approval!.id,
    attemptId: resumed.activeAttemptId!,
    turnStatus: "failed",
    sessionStatus: "failed",
    activeTurnId: null,
    events: [
      { type: "turn.failed", payload: { error: "provider unavailable" } },
      { type: "session.status.changed", payload: { status: "failed" } },
    ],
  });
  const trigger = await getSessionEvent(client.db, workspaceId, approval!.id);
  return {
    grant,
    workspaceId,
    session,
    scope,
    claim,
    identity,
    callId,
    turnId: paused.id,
    trigger,
  };
}

function recordingRuntime() {
  const prepared: unknown[][] = [];
  const runtime = {
    prepareInput: async (agent, input) => {
      const result = await prepareRunInput(agent, input);
      prepared.push(result.input as unknown[]);
      return result;
    },
  } as OpenGeniRuntime;
  return { runtime, prepared };
}

describe("human Retry of a turn resumed by an approval", () => {
  test("continues from durable history once terminal failure settled the approved call", async () => {
    const f = await approvedTurnThatFailedTerminally();
    // Terminal settlement paired the approved call with its result in history
    // and removed every receipt of the turn.
    expect(
      await listTurnOpenSuffixToolCalls(client.db, f.workspaceId, f.session.id, f.turnId),
    ).toEqual([]);
    const failure = (
      await shared.admin<{ id: string }[]>`
        select id from session_events where session_id = ${f.session.id} and type = 'turn.failed'
        order by sequence desc limit 1`
    )[0]!;
    const retry = await f.scope((db) =>
      retryFailedSessionInTransaction(db, {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.session.id,
        subjectId: f.grant.subjectId,
        request: { clientEventId: crypto.randomUUID(), failureEventId: failure.id },
        executionPolicy,
      }),
    );
    expect(retry).toMatchObject({ outcome: "accepted", turnId: f.turnId });
    const retried = await f.claim({ kind: "next" });
    expect(retried.id).toBe(f.turnId);
    // The retried turn keeps its original trigger: the approval decision.
    expect(f.trigger?.type).toBe("user.approvalDecision");

    const { runtime, prepared } = recordingRuntime();
    const options = {
      turnId: f.turnId,
      providerApi: "responses" as const,
      fileAuthority: { accountId: f.grant.accountId, subjectId: f.grant.subjectId },
      recovering: true,
    };
    await turnInput(client.db, runtime, {}, f.trigger, options);
    const approvedItems = prepared[0]!.filter(
      (item) => (item as { callId?: unknown }).callId === f.callId,
    );
    // Exactly one call and its one result: nothing replayed or duplicated.
    expect(approvedItems).toMatchObject([
      { type: "function_call", callId: f.callId },
      { type: "function_call_result", callId: f.callId },
    ]);

    // A missing suffix while a receipt of the turn is still open stays an
    // inconsistent resume.
    await registerPendingSessionToolCall(client.db, {
      ...f.identity(retried),
      callId: `open-${f.callId}`,
      callType: "function_call",
      callItem: {
        type: "function_call",
        name: "other_tool",
        callId: `open-${f.callId}`,
        status: "completed",
        arguments: "{}",
      },
    });
    await expect(turnInput(client.db, runtime, {}, f.trigger, options)).rejects.toThrow(
      "Open suffix resume has no interruption rows",
    );
  });
});
