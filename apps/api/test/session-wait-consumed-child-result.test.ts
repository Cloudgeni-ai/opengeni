import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  addSessionSystemUpdateWithSourceMutation,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimPendingSessionSystemUpdateOutbox,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  listOutstandingSessionSystemUpdatesForAttempt,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  materializeGoalContinuation,
  peekSessionWork,
  sessionSystemUpdateOutboxKindPayload,
  setSessionGoalStatus,
  recordConsumedChildAnswers,
  settleSessionIdleWithParentOutbox,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const AGENT_PERMISSIONS: Permission[] = ["sessions:read", "sessions:control", "sessions:create"];

let shared: SharedTestDatabase;
let client: DbClient;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-wait-consumed-child-result");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Workspace = { accountId: string; workspaceId: string; subjectId: string };
type Attempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  triggerEventId: string;
};

function routeDeps(): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: testSettings({ databaseUrl: shared.appUrl }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

async function workspace(): Promise<Workspace> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "consumed-child-result",
    accountExternalId: `account-${suffix}`,
    accountName: "Consumed child result",
    workspaceExternalSource: "consumed-child-result",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Consumed child result",
    subjectId: `user:owner-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

async function start(
  ws: Workspace,
  message: string,
  parent?: Attempt,
  goal?: string,
): Promise<Attempt> {
  const session = await createSession(client.db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    ...(parent
      ? {
          parentSessionId: parent.sessionId,
          createdByActor: {
            type: "agent_attempt" as const,
            attemptId: parent.attemptId,
            sessionId: parent.sessionId,
            turnId: parent.turnId,
            executionGeneration: parent.executionGeneration,
          },
        }
      : {}),
    initialMessage: message,
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: ws.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: goal ? { text: goal, mutationPolicy: "preserve_intent" } : null,
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, ws.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  return {
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    triggerEventId: claimed.turn.triggerEventId,
  };
}

/** The child answers, reaches its idle boundary, and its result is delivered
 * into the parent's queue while the parent's own turn is still running. */
async function childAnswersIntoBusyParent(
  ws: Workspace,
  parent: Attempt,
  answer: string,
): Promise<Attempt> {
  const child = await start(ws, "Look this up.", parent);
  await answerAndDeliver(ws, child, answer);
  const pending = await listOutstandingSessionSystemUpdates(
    client.db,
    ws.workspaceId,
    parent.sessionId,
  );
  expect(pending.map((update) => update.kind)).toEqual(["child_terminal_result"]);
  return child;
}

/** The parent sends the idle child another task, which the child claims. */
async function nextChildTask(ws: Workspace, child: Attempt, prompt: string): Promise<Attempt> {
  await enqueueSessionTurn(client.db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    sessionId: child.sessionId,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: `session-${child.sessionId}`,
    source: "user",
    prompt,
    resources: [],
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "subject", subjectId: ws.subjectId },
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, ws.workspaceId, {
    sessionId: child.sessionId,
    workflowId: `session-${child.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("child turn was not claimed");
  return {
    sessionId: child.sessionId,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    triggerEventId: claimed.turn.triggerEventId,
  };
}

/** The child's claimed turn answers, and its idle result reaches the parent. */
async function answerAndDeliver(ws: Workspace, child: Attempt, answer: string): Promise<void> {
  await settleChildAnswer(ws, child, answer);
  await deliverIdleResult(ws, child);
}

async function settleChildAnswer(ws: Workspace, child: Attempt, answer: string): Promise<void> {
  const settled = await applySessionTurnSettlement(client.db, ws.workspaceId, {
    sessionId: child.sessionId,
    turnId: child.turnId,
    triggerEventId: child.triggerEventId,
    attemptId: child.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed" as const, payload: { output: answer } }],
  });
  expect(settled.action).toBe("settled");
}

/** A goal-owned child answers, then a turn that only continued its goal
 * completes the goal with a remark. Returns both answer sequences. */
async function answerThenCompleteGoal(
  ws: Workspace,
  child: Attempt,
  answer: string,
  remark: string,
): Promise<{ answer: number; remark: number }> {
  await settleChildAnswer(ws, child, answer);
  await continueGoalWithRemark(ws, child, remark);
  const answers = await shared.admin<Array<{ sequence: number }>>`
    select sequence from session_events
    where session_id = ${child.sessionId} and type = 'turn.completed' order by sequence`;
  return { answer: answers[0]!.sequence, remark: answers[1]!.sequence };
}

/** The goal-owned child's next turn only continues its goal and completes it. */
async function continueGoalWithRemark(ws: Workspace, child: Attempt, remark: string) {
  const materialized = await materializeGoalContinuation(client.db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    sessionId: child.sessionId,
    workflowId: `session-${child.sessionId}`,
    defaultMaxAutoContinuations: null,
    budgetBlocked: null,
    policy: {
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      tools: [],
      sandboxBackend: "none",
    },
    prompt: (goal, count) => `continue ${goal.text} (${count})`,
  });
  expect(materialized.action).toBe("continue");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, ws.workspaceId, {
    sessionId: child.sessionId,
    workflowId: `session-${child.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("goal continuation was not claimed");
  expect(claimed.turn.source).toBe("goal");
  await setSessionGoalStatus(client.db, ws.workspaceId, child.sessionId, {
    status: "completed",
    evidence: "The answer was delivered.",
  });
  await settleChildAnswer(
    ws,
    {
      sessionId: child.sessionId,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      triggerEventId: claimed.turn.triggerEventId,
    },
    remark,
  );
}

/** The child's idle boundary commits its result and delivers it to the parent. */
async function deliverIdleResult(ws: Workspace, child: Attempt): Promise<void> {
  await settleSessionIdleWithParentOutbox(client.db, ws.workspaceId, child.sessionId);
  for (const row of await claimPendingSessionSystemUpdateOutbox(client.db, 1_000)) {
    if (row.sourceSessionId !== child.sessionId) continue;
    await addSessionSystemUpdateWithSourceMutation(
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
}

function agentMcp(ws: Workspace, attempt: Attempt) {
  const grant: AccessGrant = {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: AGENT_PERMISSIONS,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: attempt.sessionId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    },
  };
  return buildOpenGeniMcpServer(routeDeps(), grant);
}

/** How the worker's gateway marks a direct model call to the first-party server. */
const MODEL_CALL = { _meta: { opengeniCaller: "model" } };

async function callTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
  extra: unknown = MODEL_CALL,
) {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = (await tool.handler(args, extra)) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
  return JSON.parse(result.content?.[0]?.text ?? "null") as Record<string, unknown>;
}

/** The parent's reading turn ends successfully, as the worker settles it. */
async function completeParentTurn(ws: Workspace, parent: Attempt): Promise<void> {
  const settled = await applySessionTurnSettlement(client.db, ws.workspaceId, {
    sessionId: parent.sessionId,
    turnId: parent.turnId,
    triggerEventId: parent.triggerEventId,
    attemptId: parent.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed" as const, payload: { output: "Integrated." } }],
  });
  expect(settled.action).toBe("settled");
}

async function failParentTurn(ws: Workspace, parent: Attempt): Promise<void> {
  const settled = await applySessionTurnSettlement(client.db, ws.workspaceId, {
    sessionId: parent.sessionId,
    turnId: parent.turnId,
    triggerEventId: parent.triggerEventId,
    attemptId: parent.attemptId,
    turnStatus: "failed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.failed", payload: { error: "expected test failure" } }],
  });
  expect(settled.action).toBe("settled");
}

async function consumedEvents(sessionId: string) {
  return await shared.admin<Array<{ payload: { reason: string; updateIds: string[] } }>>`
    select payload from session_events
    where session_id = ${sessionId} and type = 'system.update.cancelled'
      and payload ->> 'reason' = 'consumed_by_parent_read'`;
}

async function recordedAnswers(turnId: string) {
  const [turn] = await shared.admin<Array<{ metadata: Record<string, unknown> }>>`
    select metadata from session_turns where id = ${turnId}`;
  return turn?.metadata.consumedChildAnswers ?? [];
}

async function updateState(updateSessionId: string) {
  return await shared.admin<Array<{ state: string }>>`
    select state from session_system_updates
    where session_id = ${updateSessionId} and kind = 'child_terminal_result'`;
}

describe("a parent read that returns a child's whole answer consumes its pending result", () => {
  test("session_wait keeps the parent in its turn, and its completion consumes the result", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Find the user count.");
    const answer = "1,204 active users in the last 48 hours.";
    const child = await childAnswersIntoBusyParent(ws, parent, answer);

    const result = await callTool(agentMcp(ws, parent), "session_wait", {
      targets: [{ sessionId: child.sessionId, afterSequence: 0 }],
      waitFor: "completion",
      maxWaitSeconds: 1,
    });

    const changed = result.changed as Array<{ events: Array<{ type: string; text: string }> }>;
    expect(changed[0]!.events.map((event) => [event.type, event.text])).toContainEqual([
      "turn.completed",
      answer,
    ]);
    expect(result.ownPendingUpdates).toBe(0);
    expect(result.ownPendingImmediateUpdates).toBe(0);
    // The tool output is not durable history yet: nothing is superseded.
    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
    expect(
      await listOutstandingSessionSystemUpdatesForAttempt(
        client.db,
        ws.workspaceId,
        parent.sessionId,
        parent,
      ),
    ).toEqual([]);

    await completeParentTurn(ws, parent);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
    const [event] = await consumedEvents(parent.sessionId);
    expect(event?.payload).toMatchObject({ reason: "consumed_by_parent_read", count: 1 });
  });

  test("session_events results view consumes the same exact answer", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Summarize the audit.");
    const answer = `Audit: ${"all controls pass. ".repeat(200)}`;
    const child = await childAnswersIntoBusyParent(ws, parent, answer);

    await callTool(agentMcp(ws, parent), "session_events", {
      sessionId: child.sessionId,
      view: "results",
      after: 0,
    });
    await completeParentTurn(ws, parent);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
  });

  test("the result stays pending when the reading attempt fails after the read", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Find the owner.");
    const answer = "The owner is the platform team.";
    const child = await childAnswersIntoBusyParent(ws, parent, answer);

    await callTool(agentMcp(ws, parent), "session_wait", {
      targets: [{ sessionId: child.sessionId, afterSequence: 0 }],
      waitFor: "completion",
      maxWaitSeconds: 1,
    });
    // The read's tool output may never have become durable parent history.
    await failParentTurn(ws, parent);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
    expect(await consumedEvents(parent.sessionId)).toEqual([]);
  });

  test("a Codemode or unmarked read never counts as the model receiving the answer", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Find the owner.");
    const child = await childAnswersIntoBusyParent(ws, parent, "The owner is the platform team.");
    const read = { sessionId: child.sessionId, view: "results", after: 0 };

    // A script may return only a summary to the model, and an older worker
    // does not say which surface called.
    await callTool(agentMcp(ws, parent), "session_events", read, {
      _meta: { opengeniCaller: "codemode" },
    });
    await callTool(agentMcp(ws, parent), "session_events", read, {});
    expect(await recordedAnswers(parent.turnId)).toEqual([]);
    await completeParentTurn(ws, parent);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
  });

  test("a truncated wait summary, a stale attempt, or a non-parent reader keeps the input", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Collect the long report.");
    // Longer than the wait summary tier, so the returned text is not whole.
    const child = await childAnswersIntoBusyParent(ws, parent, "x".repeat(5_000));

    const truncated = await callTool(agentMcp(ws, parent), "session_wait", {
      targets: [{ sessionId: child.sessionId, afterSequence: 0 }],
      waitFor: "completion",
      maxWaitSeconds: 1,
    });
    expect(truncated.ownPendingUpdates).toBe(1);

    const stale = { ...parent, attemptId: crypto.randomUUID() };
    await expect(
      callTool(agentMcp(ws, stale), "session_events", {
        sessionId: child.sessionId,
        view: "results",
        after: 0,
      }),
    ).rejects.toThrow();

    const peer = await start(ws, "Unrelated peer.");
    await callTool(agentMcp(ws, peer), "session_events", {
      sessionId: child.sessionId,
      view: "results",
      after: 0,
    });
    expect(await recordedAnswers(parent.turnId)).toEqual([]);
    await completeParentTurn(ws, parent);
    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
  });

  test("the record itself fences the exact live attempt and a result-bearing answer", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Find the owner.");
    const child = await childAnswersIntoBusyParent(ws, parent, "The owner is the platform team.");
    const [answer] = await shared.admin<Array<{ sequence: number }>>`
      select sequence from session_events
      where session_id = ${child.sessionId} and type = 'turn.completed'`;
    const [other] = await shared.admin<Array<{ sequence: number }>>`
      select max(sequence)::int as sequence from session_events
      where session_id = ${child.sessionId} and type <> 'turn.completed'`;
    const input = {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      executionGeneration: parent.executionGeneration,
    };

    for (const rejected of [
      { ...input, attemptId: crypto.randomUUID() },
      { ...input, executionGeneration: parent.executionGeneration + 1 },
      { ...input, turnId: crypto.randomUUID() },
    ]) {
      const result = await recordConsumedChildAnswers(client.db, {
        ...rejected,
        children: [{ sessionId: child.sessionId, sequences: [answer!.sequence] }],
      });
      expect(result.recorded).toBe(0);
    }
    // A complete read of something other than the answer proves nothing.
    expect(
      (
        await recordConsumedChildAnswers(client.db, {
          ...input,
          children: [{ sessionId: child.sessionId, sequences: [other!.sequence] }],
        })
      ).recorded,
    ).toBe(0);
    expect(await recordedAnswers(parent.turnId)).toEqual([]);

    const accepted = await recordConsumedChildAnswers(client.db, {
      ...input,
      children: [{ sessionId: child.sessionId, sequences: [answer!.sequence] }],
    });
    expect(accepted.recorded).toBe(1);
    // A repeated read of an answer this attempt recorded writes nothing.
    const repeated = await recordConsumedChildAnswers(client.db, {
      ...input,
      children: [{ sessionId: child.sessionId, sequences: [answer!.sequence] }],
    });
    expect(repeated.recorded).toBe(0);
    expect(await recordedAnswers(parent.turnId)).toEqual([
      { childSessionId: child.sessionId, sequence: answer!.sequence, attemptId: parent.attemptId },
    ]);
    await completeParentTurn(ws, parent);
    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
  });

  test("reading a newer answer leaves an older unread result pending", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Run both checks.");
    const child = await childAnswersIntoBusyParent(ws, parent, "Check A passed.");
    await answerAndDeliver(
      ws,
      await nextChildTask(ws, child, "Now run check B."),
      "Check B failed on the replica.",
    );
    const results = async () =>
      await shared.admin<Array<{ sequence: number; state: string }>>`
        select (payload -> 'finalAnswer' ->> 'sequence')::int as sequence, state
        from session_system_updates
        where session_id = ${parent.sessionId} and kind = 'child_terminal_result'
        order by sequence`;
    const [first, second] = await results();
    expect([first?.state, second?.state]).toEqual(["pending", "pending"]);

    // The parent read only answer B (for example from a cursor past answer A).
    const read = await recordConsumedChildAnswers(client.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      executionGeneration: parent.executionGeneration,
      children: [{ sessionId: child.sessionId, sequences: [second!.sequence] }],
    });
    expect(read.recorded).toBe(1);
    await completeParentTurn(ws, parent);

    expect(await results()).toEqual([
      { sequence: first!.sequence, state: "pending" },
      { sequence: second!.sequence, state: "superseded" },
    ]);
  });

  test("a result with goal-continuation output is consumed only when every part was read", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Count the users.");
    const child = await start(ws, "Count them.", parent, "Count the users");
    const sequences = await answerThenCompleteGoal(
      ws,
      child,
      "28 distinct users in the window.",
      "The goal is complete. A fresh check confirmed 28 users.",
    );
    await deliverIdleResult(ws, child);
    const [pending] = await listOutstandingSessionSystemUpdates(
      client.db,
      ws.workspaceId,
      parent.sessionId,
    );
    expect(pending?.payload).toMatchObject({
      finalAnswer: {
        sequence: sequences.answer,
        goalContinuations: [{ sequence: sequences.remark }],
      },
    });
    const input = {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      executionGeneration: parent.executionGeneration,
    };
    const outstanding = async () =>
      (
        await listOutstandingSessionSystemUpdatesForAttempt(
          client.db,
          ws.workspaceId,
          parent.sessionId,
          parent,
        )
      ).map((update) => update.id);

    // The parent read the answer but not the later continuation output.
    await recordConsumedChildAnswers(client.db, {
      ...input,
      children: [{ sessionId: child.sessionId, sequences: [sequences.answer] }],
    });
    expect(await outstanding()).toEqual([pending!.id]);

    // A later read of the continuation completes what this attempt received.
    await recordConsumedChildAnswers(client.db, {
      ...input,
      children: [{ sessionId: child.sessionId, sequences: [sequences.remark] }],
    });
    expect(await outstanding()).toEqual([]);
    expect(await recordedAnswers(parent.turnId)).toEqual([
      { childSessionId: child.sessionId, sequence: sequences.answer, attemptId: parent.attemptId },
      { childSessionId: child.sessionId, sequence: sequences.remark, attemptId: parent.attemptId },
    ]);
    await completeParentTurn(ws, parent);
    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
  });

  test("a result read only in part stays pending after the reading turn completes", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Count the users.");
    const child = await start(ws, "Count them.", parent, "Count the users");
    const sequences = await answerThenCompleteGoal(
      ws,
      child,
      "28 distinct users in the window.",
      "The goal is complete. A fresh check confirmed 28 users.",
    );
    await deliverIdleResult(ws, child);
    await recordConsumedChildAnswers(client.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      executionGeneration: parent.executionGeneration,
      children: [{ sessionId: child.sessionId, sequences: [sequences.answer] }],
    });

    await completeParentTurn(ws, parent);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
  });
});

describe("a result committed after the parent already read the answer", () => {
  /** The child answers; its idle boundary has not committed a result yet. */
  async function childAnswered(ws: Workspace, parent: Attempt, answer: string) {
    const child = await start(ws, "Look this up.", parent);
    await settleChildAnswer(ws, child, answer);
    expect(
      await listOutstandingSessionSystemUpdates(client.db, ws.workspaceId, parent.sessionId),
    ).toEqual([]);
    return child;
  }

  async function joinChild(ws: Workspace, parent: Attempt, child: Attempt, answer: string) {
    const result = await callTool(agentMcp(ws, parent), "session_wait", {
      targets: [{ sessionId: child.sessionId, afterSequence: 0 }],
      waitFor: "completion",
      maxWaitSeconds: 1,
    });
    const changed = result.changed as Array<{ events: Array<{ type: string; text: string }> }>;
    expect(changed[0]!.events.map((event) => [event.type, event.text])).toContainEqual([
      "turn.completed",
      answer,
    ]);
  }

  test("arrives pending while the reading turn runs and is consumed when that turn completes", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Find the owner.");
    const answer = "The owner is the platform team.";
    const child = await childAnswered(ws, parent, answer);
    await joinChild(ws, parent, child, answer);

    await deliverIdleResult(ws, child);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
    // It is not input this attempt waits for or ends its turn to receive.
    expect(
      await listOutstandingSessionSystemUpdatesForAttempt(
        client.db,
        ws.workspaceId,
        parent.sessionId,
        parent,
      ),
    ).toEqual([]);

    await completeParentTurn(ws, parent);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
    expect(
      await listOutstandingSessionSystemUpdates(client.db, ws.workspaceId, parent.sessionId),
    ).toEqual([]);
    const [update] = await shared.admin<Array<{ id: string }>>`
      select id from session_system_updates
      where session_id = ${parent.sessionId} and kind = 'child_terminal_result'`;
    const events = await consumedEvents(parent.sessionId);
    expect(events.map((event) => event.payload.updateIds)).toEqual([[update!.id]]);
  });

  test("arrives already consumed after the reading turn completed, without waking the parent", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Find the owner and wait for the audit.");
    const answer = "The owner is the platform team.";
    const child = await childAnswered(ws, parent, answer);
    await joinChild(ws, parent, child, answer);
    // The parent integrates the answer and waits for other work.
    await callTool(agentMcp(ws, parent), "wait_for_input", {
      reason: "Waiting for the audit to finish.",
      timeoutSeconds: 600,
    });
    const settled = await applySessionTurnSettlement(client.db, ws.workspaceId, {
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      triggerEventId: parent.triggerEventId,
      attemptId: parent.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed" as const, payload: { output: "" } }],
    });
    expect(settled.action).toBe("settled");
    const wakeRevision = async () =>
      Number(
        (
          await shared.admin<Array<{ wake_revision: number }>>`
            select wake_revision from session_workflow_wake_outbox
            where session_id = ${parent.sessionId}`
        )[0]?.wake_revision ?? 0,
      );
    const before = await wakeRevision();

    await deliverIdleResult(ws, child);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
    const [session] = await shared.admin<Array<{ status: string }>>`
      select status from sessions where id = ${parent.sessionId}`;
    expect(session?.status).toBe("idle");
    expect(await wakeRevision()).toBe(before);
  });

  test("stays pending when the reading attempt did not survive", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Find the owner.");
    const answer = "The owner is the platform team.";
    const child = await childAnswered(ws, parent, answer);
    await joinChild(ws, parent, child, answer);
    // The read's tool output may never have become durable parent history.
    await applySessionTurnSettlement(client.db, ws.workspaceId, {
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      triggerEventId: parent.triggerEventId,
      attemptId: parent.attemptId,
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.failed", payload: { error: "expected test failure" } }],
    });

    await deliverIdleResult(ws, child);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
    expect(await consumedEvents(parent.sessionId)).toEqual([]);
  });

  test("stays pending when a goal continuation followed the answer the parent read", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Count the users.");
    const child = await start(ws, "Count them.", parent, "Count the users");
    const answer = "28 distinct users in the window.";
    await settleChildAnswer(ws, child, answer);
    await joinChild(ws, parent, child, answer);
    // Only after the join does the child run a turn that continues its goal.
    const [goal] = await shared.admin<Array<{ status: string }>>`
      select status from session_goals where session_id = ${child.sessionId}`;
    expect(goal?.status).toBe("active");
    await continueGoalWithRemark(ws, child, "The goal is complete. A fresh check confirmed it.");

    await deliverIdleResult(ws, child);
    await completeParentTurn(ws, parent);

    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
  });

  test("stays pending when the parent read an older answer than the one reported", async () => {
    const ws = await workspace();
    const parent = await start(ws, "Run both checks.");
    const first = "Check A passed.";
    const child = await childAnswered(ws, parent, first);
    await joinChild(ws, parent, child, first);
    await completeParentTurn(ws, parent);
    await deliverIdleResult(ws, child);
    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);

    await answerAndDeliver(
      ws,
      await nextChildTask(ws, child, "Now run check B."),
      "Check B failed on the replica.",
    );

    const states = await shared.admin<Array<{ state: string }>>`
      select state from session_system_updates
      where session_id = ${parent.sessionId} and kind = 'child_terminal_result'
      order by created_at`;
    expect(states).toEqual([{ state: "superseded" }, { state: "pending" }]);
  });
});

describe("a held wait and a goal-owned child's continuation", () => {
  async function claimParentQuestion(ws: Workspace, parent: Attempt): Promise<Attempt> {
    await enqueueSessionTurn(client.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sessionId: parent.sessionId,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${parent.sessionId}`,
      source: "user",
      prompt: "How is it going?",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: ws.subjectId },
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, ws.workspaceId, {
      sessionId: parent.sessionId,
      workflowId: `session-${parent.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`question not claimed: ${claimed.action}`);
    expect(claimed.turn.source).toBe("user");
    return {
      sessionId: parent.sessionId,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      triggerEventId: claimed.turn.triggerEventId,
    };
  }

  for (const order of ["after", "during"] as const) {
    test(`a status question that read the new continuation retires the wait (result ${order} it)`, async () => {
      const ws = await workspace();
      const parent = await start(ws, "Count the users.");
      const child = await start(ws, "Count them.", parent, "Count the users");
      const answer = "28 distinct users in the window.";
      await settleChildAnswer(ws, child, answer);
      // The parent joins the child's answer, then waits for it to finish its goal.
      const joined = await callTool(agentMcp(ws, parent), "session_wait", {
        targets: [{ sessionId: child.sessionId, afterSequence: 0 }],
        waitFor: "completion",
        maxWaitSeconds: 1,
      });
      expect(JSON.stringify(joined)).toContain(answer);
      await callTool(agentMcp(ws, parent), "wait_for_input", {
        reason: "Waiting for the worker to finish.",
        timeoutSeconds: 600,
      });
      await completeParentTurn(ws, parent);
      expect(await peekSessionWork(client.db, ws.workspaceId, parent.sessionId)).toMatchObject({
        kind: "input-wait",
        disposition: "held",
      });

      // The child's goal continuation finishes; a person asks for status.
      await continueGoalWithRemark(
        ws,
        child,
        "The goal is complete. A fresh check found 31 users.",
      );
      const question = await claimParentQuestion(ws, parent);
      if (order === "during") await deliverIdleResult(ws, child);
      const read = await callTool(agentMcp(ws, question), "session_events", {
        sessionId: child.sessionId,
        view: "results",
        after: 0,
      });
      expect(JSON.stringify(read)).toContain("31 users");
      await completeParentTurn(ws, question);
      if (order === "after") await deliverIdleResult(ws, child);

      // The result never wakes the parent, so the question that read the new
      // continuation ends the wait instead of its deadline.
      expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
      expect(await peekSessionWork(client.db, ws.workspaceId, parent.sessionId)).toMatchObject({
        kind: "input-wait",
        disposition: "superseded",
      });
    });
  }
});
