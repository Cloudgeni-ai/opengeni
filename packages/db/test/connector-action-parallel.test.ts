import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendSessionEventsForTurnAttempt,
  beginConnectorActionExecution,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeConnectorActionExecution,
  createDb,
  createSession,
  appendSessionHistoryItems,
  nextSessionHistoryPosition,
  prepareConnectorActionApproval,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  submitHumanPromptInTransaction,
  upsertConnectorActionPolicy,
  withWorkspaceSubjectSessionActivityRls,
} from "../src";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(120_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("connector-action-parallel");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function claimedAttempt() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Parallel connector calls",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Parallel connector calls",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "run parallel tools",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    grant.workspaceId!,
    grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `send-${crypto.randomUUID()}`,
          delivery: "send",
          text: "search everything at once",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
  const connectionId = `connection-${crypto.randomUUID()}`;
  const serverId = "pm";
  // An explicit rule keeps every call on the durable ledger; a recommended
  // Allow writes nothing and could not exercise its lock order. The attempt
  // freezes its policy snapshot at claim.
  await upsertConnectorActionPolicy(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    connectionId,
    serverId,
    toolName: "*",
    actionName: "*",
    policy: "allow",
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`claim failed: ${claim.reason}`);
  return {
    connectionId,
    serverId,
    identity: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
      initiator: claim.turn.initiator,
    },
  };
}

describe("parallel connector-backed tool calls", () => {
  test("a parallel tool batch with its post-batch settlement never deadlocks against event writers", async () => {
    const { identity, connectionId, serverId } = await claimedAttempt();
    const appendFor = async (
      callId: string,
      type: "agent.toolCall.created" | "agent.toolCall.output",
    ) => {
      const appended = await appendSessionEventsForTurnAttempt(
        client.db,
        identity.workspaceId,
        identity.sessionId,
        identity.turnId,
        identity.executionGeneration,
        identity.attemptId,
        [{ type, payload: { callId, name: `${serverId}__search` } }],
      );
      expect(appended.accepted).toBe(true);
    };
    const toolCall = async (callId: string, toolName: string) => {
      const call = {
        approvalId: callId,
        connectionId,
        serverId,
        toolName,
        arguments: { query: callId },
        defaultDecision: "allow" as const,
      };
      const scope = {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        executionGeneration: identity.executionGeneration,
        attemptId: identity.attemptId,
        callId,
      };
      const callItem = {
        type: "function_call",
        callId,
        name: `${serverId}__${toolName}`,
        arguments: JSON.stringify({ query: callId }),
      };
      expect(
        await registerPendingSessionToolCall(client.db, {
          ...scope,
          callType: "function_call",
          callItem,
        }),
      ).toEqual({ accepted: true, registered: true });
      await appendFor(callId, "agent.toolCall.created");
      expect(await prepareConnectorActionApproval(client.db, identity, call)).toMatchObject({
        managed: true,
        decision: "allow",
      });
      const admission = await beginConnectorActionExecution(client.db, identity, call);
      if (!admission.allowed || !admission.managed) throw new Error("explicit Allow was denied");
      await completeConnectorActionExecution(client.db, {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        requestId: admission.requestId,
        attemptId: identity.attemptId,
        outcome: "completed",
      });
      const resultItem = {
        type: "function_call_result",
        callId,
        name: `${serverId}__${toolName}`,
        output: { type: "text", text: `result for ${callId}` },
      };
      expect(
        await recordPendingSessionToolCallResult(client.db, {
          ...scope,
          resultItem,
          eventOutput: resultItem.output,
        }),
      ).toEqual({ accepted: true, recorded: true });
      await appendFor(callId, "agent.toolCall.output");
      return [callItem, resultItem];
    };
    // Unrelated raw writers keep the session's event cursor hot throughout.
    const streaming = new AbortController();
    const deltas = (async () => {
      while (!streaming.signal.aborted) await appendFor("stream", "agent.toolCall.created");
    })();
    try {
      for (let round = 0; round < 12; round += 1) {
        const pairs = await Promise.all(
          Array.from({ length: 9 }, (_, index) =>
            toolCall(`call-${round}-${index}`, index % 2 === 0 ? "search_issues" : "query"),
          ),
        );
        // Post-batch settlement: the reconciled call/result pairs land in history.
        const position = await nextSessionHistoryPosition(
          client.db,
          identity.workspaceId,
          identity.sessionId,
        );
        expect(
          await appendSessionHistoryItems(client.db, {
            accountId: identity.accountId,
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            turnId: identity.turnId,
            expectedExecutionGeneration: identity.executionGeneration,
            expectedAttemptId: identity.attemptId,
            items: pairs.flat().map((item, offset) => ({ position: position + offset, item })),
          }),
        ).toBe(true);
      }
    } finally {
      streaming.abort();
      await deltas;
    }
    const [row] = await shared.admin<Array<{ count: string }>>`
      select count(*)::text as count from connector_action_requests
      where turn_id = ${identity.turnId} and status = 'completed'`;
    expect(Number(row?.count)).toBe(12 * 9);
  });

  test("settlement retries its idempotent transaction after a deadlock", async () => {
    const { identity, connectionId, serverId } = await claimedAttempt();
    const call = {
      approvalId: "deadlocked-settlement",
      connectionId,
      serverId,
      toolName: "search_issues",
      arguments: { query: "deadlock" },
      defaultDecision: "allow" as const,
    };
    const admission = await beginConnectorActionExecution(client.db, identity, call);
    if (!admission.allowed || !admission.managed) throw new Error("explicit Allow was denied");
    let completion: Promise<void> | undefined;
    // A foreign writer holds the ledger row, then wants the attempt that the
    // settlement's canonical prefix already holds: a genuine 40P01 cycle.
    await shared.admin.begin(async (sql) => {
      await sql`select id from connector_action_requests where id = ${admission.requestId} for update`;
      completion = completeConnectorActionExecution(client.db, {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        requestId: admission.requestId,
        attemptId: identity.attemptId,
        outcome: "completed",
      });
      await Bun.sleep(300);
      await sql`select id from session_turn_attempts where id = ${identity.attemptId} for update`;
    });
    await completion;
    const [row] = await shared.admin<Array<{ status: string }>>`
      select status from connector_action_requests where id = ${admission.requestId}`;
    expect(row?.status).toBe("completed");
  });
});
