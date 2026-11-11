import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { OPEN_SUFFIX_RUN_STATE_BLOB, type SessionEvent } from "@opengeni/contracts";
import {
  acceptSessionApprovalDecision,
  applySessionTurnSettlement,
  attachOpenSuffixToPendingToolCalls,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionEvent,
  listTurnOpenSuffixToolCalls,
  peekSessionWork,
  registerPendingSessionToolCall,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  openSuffixApprovedCallIds,
  settleOpenSuffixResumeIfNeeded,
} from "../src/activities/open-suffix-resume";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-parallel-approval-resume");
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
    accountExternalId: suffix,
    accountName: "Parallel approvals",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Parallel approvals",
    subjectId: `user:parallel-approvals-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    sessionId: session.id,
  };
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    scope.workspaceId,
    scope.subjectId,
    (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        subjectId: scope.subjectId,
        actor: { type: "human", subjectId: scope.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Delete the three connections",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
  );
  return scope;
}

type Scope = Awaited<ReturnType<typeof fixture>>;
type Claimed = {
  attemptId: string;
  turn: { id: string; triggerEventId: string; executionGeneration: number };
};

async function claim(
  scope: Scope,
  trigger: { kind: "next" } | { kind: "approval"; triggerEventId: string },
): Promise<Claimed> {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: scope.sessionId,
    workflowId: `session-${scope.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger,
  });
  if (claimed.action !== "claimed") throw new Error(`Could not claim: ${claimed.reason}`);
  return { attemptId, turn: claimed.turn as Claimed["turn"] };
}

function settleFor(scope: Scope, claimed: Claimed) {
  const written: SessionEvent[] = [];
  return {
    written,
    settle: async (input: {
      events: Array<{ type: string; payload: unknown }>;
      turnStatus: "requires_action";
      sessionStatus: "requires_action";
      activeTurnId: string;
      runState: NonNullable<Parameters<typeof applySessionTurnSettlement>[2]["runState"]>;
    }) => {
      const result = await applySessionTurnSettlement(client.db, scope.workspaceId, {
        sessionId: scope.sessionId,
        turnId: claimed.turn.id,
        triggerEventId: claimed.turn.triggerEventId,
        attemptId: claimed.attemptId,
        turnStatus: input.turnStatus,
        sessionStatus: input.sessionStatus,
        activeTurnId: input.activeTurnId,
        events: input.events as never,
        runState: input.runState,
      });
      if (result.action !== "settled") return false;
      written.push(...(result.events as SessionEvent[]));
      return true;
    },
  };
}

const CALL_IDS = ["call-delete-a", "call-delete-b", "call-delete-c"];

/** The first pause: three parallel calls waiting for approval. */
async function pause(scope: Scope, claimed: Claimed) {
  for (const callId of CALL_IDS) {
    await registerPendingSessionToolCall(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      turnId: claimed.turn.id,
      executionGeneration: claimed.turn.executionGeneration,
      attemptId: claimed.attemptId,
      callId,
      callType: "function_call",
      callItem: {
        type: "function_call",
        callId,
        name: "delete_connection",
        arguments: JSON.stringify({ connection: callId }),
      },
    });
  }
  expect(
    await attachOpenSuffixToPendingToolCalls(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      turnId: claimed.turn.id,
      executionGeneration: claimed.turn.executionGeneration,
      attemptId: claimed.attemptId,
      members: CALL_IDS.map((callId) => ({
        callId,
        interruptionKind: "approval" as const,
        reasoningItems: [],
      })),
    }),
  ).toEqual({ accepted: true, attached: CALL_IDS.length });
  const { settle } = settleFor(scope, claimed);
  expect(
    await settle({
      events: [
        {
          type: "session.requiresAction",
          payload: { approvals: CALL_IDS.map((id) => ({ id })) },
        },
        { type: "session.status.changed", payload: { status: "requires_action" } },
      ],
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: claimed.turn.id,
      runState: {
        serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
        pendingApprovals: CALL_IDS.map((id) => ({ id })),
      },
    }),
  ).toBe(true);
}

function countingAgent() {
  const executed: string[] = [];
  const agent = new Agent({
    name: "parallel-approval-test",
    tools: [
      tool({
        name: "delete_connection",
        description: "Synthetic local invocation counter; no host or model is called.",
        parameters: z.object({ connection: z.string() }),
        errorFunction: null,
        execute: async (args) => {
          executed.push(args.connection);
          return `Deleted ${args.connection}.`;
        },
      }),
    ],
  });
  return { agent, executed };
}

async function resume(scope: Scope, triggerEventId: string, agent: Agent<any, any>) {
  const claimed = await claim(scope, { kind: "approval", triggerEventId });
  const trigger = await getSessionEvent(client.db, scope.workspaceId, triggerEventId);
  if (!trigger) throw new Error("resume trigger is missing");
  const approvedToolCallIds = await openSuffixApprovedCallIds({
    db: client.db,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: claimed.turn.id,
    trigger,
  });
  const { settle, written } = settleFor(scope, claimed);
  const outcome = await settleOpenSuffixResumeIfNeeded({
    db: client.db,
    agent,
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: claimed.turn.id,
    executionGeneration: claimed.turn.executionGeneration,
    attemptId: claimed.attemptId,
    trigger,
    humanInputResume: null,
    settle,
  });
  const rows = await listTurnOpenSuffixToolCalls(
    client.db,
    scope.workspaceId,
    scope.sessionId,
    claimed.turn.id,
  );
  return { outcome, written, rows, approvedToolCallIds };
}

describe("parallel approvals of one pause", () => {
  test("one resume applies every decision made before it; a later one resumes again", async () => {
    const scope = await fixture();
    await pause(scope, await claim(scope, { kind: "next" }));
    const decide = async (approvalId: string, decision: "approve" | "reject") => {
      const accepted = await acceptSessionApprovalDecision(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        subjectId: scope.subjectId,
        payload: { approvalId, decision },
        clientEventId: crypto.randomUUID(),
      });
      if (accepted.action !== "accepted") throw new Error(`${approvalId}: ${accepted.message}`);
      return accepted.event;
    };
    // Two quick decisions before the turn resumes.
    await decide("call-delete-a", "approve");
    const rejectB = await decide("call-delete-b", "reject");
    expect(await peekSessionWork(client.db, scope.workspaceId, scope.sessionId)).toMatchObject({
      kind: "approval-pending",
      triggerEventId: rejectB.id,
    });
    const { agent, executed } = countingAgent();

    // B's resume applies A's decision too, and pauses again only for C.
    const first = await resume(scope, rejectB.id, agent);

    expect(first.approvedToolCallIds).toEqual(["call-delete-a"]);
    expect(first.outcome).toEqual({ action: "requires_action" });
    expect(executed).toEqual(["call-delete-a"]);
    const resultOf = (rows: typeof first.rows, callId: string) =>
      rows.find((row) => row.callId === callId)?.resultItem;
    expect(resultOf(first.rows, "call-delete-a")).toMatchObject({
      output: { type: "text", text: "Deleted call-delete-a." },
    });
    expect(resultOf(first.rows, "call-delete-b")).toMatchObject({
      output: {
        type: "text",
        text: "Tool approval was rejected. This proposed tool call was not executed.",
      },
    });
    expect(resultOf(first.rows, "call-delete-c")).toBeNull();
    expect(
      first.written
        .filter((event) => event.type === "session.requiresAction")
        .map((event) => (event.payload as { approvals: Array<{ id: string }> }).approvals),
    ).toEqual([[expect.objectContaining({ id: "call-delete-c" })]]);

    // Deciding C resumes the turn once more, and nothing runs twice.
    const approveC = await decide("call-delete-c", "approve");
    expect(await peekSessionWork(client.db, scope.workspaceId, scope.sessionId)).toMatchObject({
      kind: "approval-pending",
      triggerEventId: approveC.id,
    });
    const second = await resume(scope, approveC.id, agent);
    expect(second.approvedToolCallIds).toEqual(["call-delete-c"]);
    expect(second.outcome).toEqual({ action: "continue" });
    expect(executed).toEqual(["call-delete-a", "call-delete-c"]);
    expect(second.rows.every((row) => row.resultItem != null)).toBe(true);
  });

  test("a decision recorded while the resume settles is never asked again", async () => {
    const scope = await fixture();
    await pause(scope, await claim(scope, { kind: "next" }));
    const decide = async (approvalId: string, decision: "approve" | "reject") => {
      const accepted = await acceptSessionApprovalDecision(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        subjectId: scope.subjectId,
        payload: { approvalId, decision },
        clientEventId: crypto.randomUUID(),
      });
      if (accepted.action !== "accepted") throw new Error(`${approvalId}: ${accepted.message}`);
      return accepted.event;
    };
    const approveA = await decide("call-delete-a", "approve");
    const claimed = await claim(scope, { kind: "approval", triggerEventId: approveA.id });
    // Decided while the turn is running, before it pauses again.
    const rejectB = await decide("call-delete-b", "reject");
    const trigger = await getSessionEvent(client.db, scope.workspaceId, approveA.id);
    const { agent, executed } = countingAgent();
    const { settle, written } = settleFor(scope, claimed);
    const outcome = await settleOpenSuffixResumeIfNeeded({
      db: client.db,
      agent,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      turnId: claimed.turn.id,
      executionGeneration: claimed.turn.executionGeneration,
      attemptId: claimed.attemptId,
      trigger: trigger!,
      humanInputResume: null,
      settle,
    });
    expect(outcome).toEqual({ action: "requires_action" });
    expect(executed).toEqual(["call-delete-a"]);
    // Only C is shown as waiting; B's recorded decision resumes the turn next.
    expect(
      written
        .filter((event) => event.type === "session.requiresAction")
        .map((event) =>
          (event.payload as { approvals: Array<{ id: string }> }).approvals.map(({ id }) => id),
        ),
    ).toEqual([["call-delete-c"]]);
    expect(await peekSessionWork(client.db, scope.workspaceId, scope.sessionId)).toMatchObject({
      kind: "approval-pending",
      triggerEventId: rejectB.id,
    });
  });
});
