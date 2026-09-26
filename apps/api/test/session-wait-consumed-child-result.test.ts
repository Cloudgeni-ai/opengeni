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
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  sessionSystemUpdateOutboxKindPayload,
  settleSessionIdleWithParentOutbox,
  supersedeConsumedChildTerminalResults,
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

async function start(ws: Workspace, message: string, parent?: Attempt): Promise<Attempt> {
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
    goal: null,
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

async function callTool(server: unknown, name: string, args: Record<string, unknown>) {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = (await tool.handler(args, {})) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
  return JSON.parse(result.content?.[0]?.text ?? "null") as Record<string, unknown>;
}

async function updateState(updateSessionId: string) {
  return await shared.admin<Array<{ state: string }>>`
    select state from session_system_updates
    where session_id = ${updateSessionId} and kind = 'child_terminal_result'`;
}

describe("a parent read that returns a child's whole answer consumes its pending result", () => {
  test("session_wait supersedes the pending result and stops asking the parent to end its turn", async () => {
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
    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
    const [event] = await shared.admin<Array<{ payload: { reason: string; count: number } }>>`
      select payload from session_events
      where session_id = ${parent.sessionId} and type = 'system.update.cancelled'`;
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

    expect(await updateState(parent.sessionId)).toEqual([{ state: "superseded" }]);
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
    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);

    const stale = { ...parent, attemptId: crypto.randomUUID() };
    await expect(
      callTool(agentMcp(ws, stale), "session_events", {
        sessionId: child.sessionId,
        view: "results",
        after: 0,
      }),
    ).rejects.toThrow();
    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);

    const peer = await start(ws, "Unrelated peer.");
    await callTool(agentMcp(ws, peer), "session_events", {
      sessionId: child.sessionId,
      view: "results",
      after: 0,
    });
    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);
  });

  test("the supersession itself fences the exact live attempt and a result-bearing answer", async () => {
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
      const result = await supersedeConsumedChildTerminalResults(client.db, {
        ...rejected,
        children: [{ sessionId: child.sessionId, sequences: [answer!.sequence] }],
      });
      expect(result.supersededUpdateIds).toEqual([]);
    }
    // A complete read of something other than the answer proves nothing.
    expect(
      (
        await supersedeConsumedChildTerminalResults(client.db, {
          ...input,
          children: [{ sessionId: child.sessionId, sequences: [other!.sequence] }],
        })
      ).supersededUpdateIds,
    ).toEqual([]);
    expect(await updateState(parent.sessionId)).toEqual([{ state: "pending" }]);

    const accepted = await supersedeConsumedChildTerminalResults(client.db, {
      ...input,
      children: [{ sessionId: child.sessionId, sequences: [answer!.sequence] }],
    });
    expect(accepted.supersededUpdateIds).toHaveLength(1);
    expect(accepted.events.map((event) => event.type)).toEqual(["system.update.cancelled"]);
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
    const read = await supersedeConsumedChildTerminalResults(client.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      executionGeneration: parent.executionGeneration,
      children: [{ sessionId: child.sessionId, sequences: [second!.sequence] }],
    });

    expect(read.supersededUpdateIds).toHaveLength(1);
    expect(await results()).toEqual([
      { sequence: first!.sequence, state: "pending" },
      { sequence: second!.sequence, state: "superseded" },
    ]);
  });
});
