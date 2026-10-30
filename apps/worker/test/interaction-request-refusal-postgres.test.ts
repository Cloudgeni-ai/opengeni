import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Agent } from "@openai/agents";
import { OPEN_SUFFIX_RUN_STATE_BLOB, type SessionEvent } from "@opengeni/contracts";
import {
  activateBrowserSession,
  applySessionTurnSettlement,
  attachOpenSuffixToPendingToolCalls,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  dispatchBrowserSessionOperation,
  getInteractionIntervention,
  InteractionResourceNotFoundError,
  listTurnOpenSuffixToolCalls,
  peekSessionWork,
  prepareBrowserSessionCreate,
  registerPendingSessionToolCall,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import type { InteractionRequestTargetReader } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  interactionInterventionRequestsForPause,
  recordedInteractionRequestCalls,
  type InteractionPauseCall,
} from "../src/activities/agent-turn/interaction-pause";
import { settleOpenSuffixResumeIfNeeded } from "../src/activities/open-suffix-resume";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-interaction-request-refusal");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const OBSERVE =
  "Observe the tab or window again, then call interaction_request_human again if a person still needs to act there.";
const LEAVE_OUT =
  "Call interaction_request_human again and leave out expectedControllerGeneration, expectedTargetGeneration and expectedDocumentGeneration; they are read from the tab or window when the turn pauses.";

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Interaction refusal",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Interaction refusal",
    subjectId: `user:interaction-refusal-${suffix}`,
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
    actorSubjectId: grant.subjectId,
    sessionId: session.id,
  };
  const operationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(client.db, {
    ...scope,
    operationId,
    associatedSessionId: session.id,
    name: `Browser ${operationId.slice(0, 8)}`,
    initialUrl: "https://example.com/login",
    placement: { kind: "sandbox_group" as const, sandboxGroupId: session.sandboxGroupId },
    driverId: "opengeni.cdp.v1",
    engine: "chromium" as const,
    headless: true,
    identityId: null,
    baseRevisionId: null,
  });
  const controllerGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(client.db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controllerGeneration,
  });
  await activateBrowserSession(client.db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.0",
  });
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    scope.workspaceId,
    scope.actorSubjectId,
    (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        subjectId: scope.actorSubjectId,
        actor: { type: "human", subjectId: scope.actorSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Sign in to the protected page",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
  );
  return { ...scope, browserSessionId: prepared.session.id, controllerGeneration };
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

function request(scope: Scope, targetId: string, extra: Record<string, unknown> = {}) {
  return {
    operation: "request" as const,
    resourceKind: "browser_session" as const,
    resourceId: scope.browserSessionId,
    targetId,
    kind: "mfa" as const,
    reason: "Approve the sign-in on your phone.",
    expiresInSeconds: 900,
    ...extra,
  };
}

/** The worker's settle, bound to one claimed attempt; keeps what it wrote. */
function settleFor(scope: Scope, claimed: Claimed) {
  const written: SessionEvent[][] = [];
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
      written.push(result.events as SessionEvent[]);
      return true;
    },
  };
}

/** The first pause, as the worker writes it: suffix receipts, then the settlement. */
async function pause(
  scope: Scope,
  claimed: Claimed,
  calls: InteractionPauseCall[],
  readTarget: InteractionRequestTargetReader,
) {
  for (const call of calls) {
    const registered = await registerPendingSessionToolCall(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      turnId: claimed.turn.id,
      executionGeneration: claimed.turn.executionGeneration,
      attemptId: claimed.attemptId,
      callId: call.toolCallId,
      callType: "function_call",
      callItem: {
        type: "function_call",
        callId: call.toolCallId,
        name: "interaction_request_human",
        arguments: JSON.stringify(call.input),
      },
    });
    expect(registered).toEqual({ accepted: true, registered: true });
  }
  expect(
    await attachOpenSuffixToPendingToolCalls(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      turnId: claimed.turn.id,
      executionGeneration: claimed.turn.executionGeneration,
      attemptId: claimed.attemptId,
      members: calls.map((call) => ({
        callId: call.toolCallId,
        interruptionKind: "interaction_intervention" as const,
        reasoningItems: [],
      })),
    }),
  ).toEqual({ accepted: true, attached: calls.length });
  const { settle, written } = settleFor(scope, claimed);
  const interactionInterventionRequests = await interactionInterventionRequestsForPause({
    sessionId: scope.sessionId,
    turnId: claimed.turn.id,
    calls,
    readTarget,
  });
  expect(
    await settle({
      events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: claimed.turn.id,
      runState: {
        serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
        pendingApprovals: calls.map((call) => ({ id: call.toolCallId })),
        interactionInterventionRequests,
      },
    }),
  ).toBe(true);
  return { events: written.flat(), interactionInterventionRequests };
}

function refusalsIn(events: SessionEvent[]) {
  return events
    .filter((event) => event.type === "user.approvalDecision")
    .map((event) => ({ id: event.id, payload: event.payload as Record<string, unknown> }));
}

/** A claimed refusal, resumed the way the worker resumes it. */
async function resumeRefusal(
  scope: Scope,
  refusal: { id: string; payload: Record<string, unknown> },
  readTarget: InteractionRequestTargetReader,
) {
  const claimed = await claim(scope, { kind: "approval", triggerEventId: refusal.id });
  const { settle, written } = settleFor(scope, claimed);
  const reopened: InteractionPauseCall[][] = [];
  const outcome = await settleOpenSuffixResumeIfNeeded({
    db: client.db,
    agent: {} as Agent<any, any>,
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: claimed.turn.id,
    executionGeneration: claimed.turn.executionGeneration,
    attemptId: claimed.attemptId,
    trigger: { type: "user.approvalDecision", payload: refusal.payload },
    humanInputResume: null,
    settle,
    interactionRequests: {
      build: async (calls) =>
        await interactionInterventionRequestsForPause({
          sessionId: scope.sessionId,
          turnId: claimed.turn.id,
          calls,
          readTarget,
        }),
      recorded: async (calls) => {
        reopened.push(calls);
      },
    },
  });
  const rows = await listTurnOpenSuffixToolCalls(
    client.db,
    scope.workspaceId,
    scope.sessionId,
    claimed.turn.id,
  );
  return { outcome, events: written.flat(), rows, reopened };
}

describe("interaction_request_human calls refused at a pause", () => {
  test("two refused calls in one step each get their own refusal and the turn continues", async () => {
    const scope = await fixture();
    const first = await claim(scope, { kind: "next" });
    const gone: InteractionRequestTargetReader = async (input) =>
      `browser tab ${input.targetId} was not found`;
    const calls = [
      { toolCallId: "call-request-a", input: request(scope, "tab-a") },
      { toolCallId: "call-request-b", input: request(scope, "tab-b") },
    ];
    const paused = await pause(scope, first, calls, gone);
    // One decision resumes a pause, so the first refusal goes alone.
    const [refusalA, ...others] = refusalsIn(paused.events);
    expect(others).toEqual([]);
    expect(refusalA?.payload).toEqual({
      approvalId: "call-request-a",
      decision: "reject",
      refusal: `Nothing was requested: browser tab tab-a was not found. ${OBSERVE}`,
    });

    // Resuming A answers A and re-freezes on B, which is refused as its own
    // result instead of waiting for a person who was never asked.
    const resumedA = await resumeRefusal(scope, refusalA!, gone);
    expect(resumedA.outcome).toEqual({ action: "requires_action" });
    expect(resumedA.rows.find((row) => row.callId === "call-request-a")?.resultItem).toMatchObject({
      output: { type: "text", text: refusalA!.payload.refusal },
    });
    const [refusalB, ...more] = refusalsIn(resumedA.events);
    expect(more).toEqual([]);
    expect(refusalB?.payload).toEqual({
      approvalId: "call-request-b",
      decision: "reject",
      refusal: `Nothing was requested: browser tab tab-b was not found. ${OBSERVE}`,
    });
    expect(await peekSessionWork(client.db, scope.workspaceId, scope.sessionId)).toMatchObject({
      kind: "approval-pending",
      triggerEventId: refusalB!.id,
    });

    // Resuming B answers B; nothing is left, so the turn continues.
    const resumedB = await resumeRefusal(scope, refusalB!, gone);
    expect(resumedB.outcome).toEqual({ action: "continue" });
    expect(resumedB.rows.find((row) => row.callId === "call-request-b")?.resultItem).toMatchObject({
      output: { type: "text", text: refusalB!.payload.refusal },
    });
    // Neither refused call opened anything.
    expect(resumedA.reopened).toEqual([[calls[1]]]);
    expect(
      await recordedInteractionRequestCalls(client.db, {
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        turnId: first.turn.id,
        calls,
      }),
    ).toEqual([]);
    for (const requested of paused.interactionInterventionRequests) {
      await expect(
        getInteractionIntervention(client.db, { ...scope, interventionId: requested.id }),
      ).rejects.toBeInstanceOf(InteractionResourceNotFoundError);
    }
  });

  test("a recorded and a refused call: the refusal answers its call and the person is still asked", async () => {
    const scope = await fixture();
    const first = await claim(scope, { kind: "next" });
    const current = {
      controllerGeneration: scope.controllerGeneration,
      targetGeneration: "target-generation-now",
      documentGeneration: "document-generation-now",
    };
    const reads: string[] = [];
    const readTarget: InteractionRequestTargetReader = async (input) => {
      reads.push(input.targetId);
      return current;
    };
    const calls = [
      // Leaves its generations out: recorded from the tab as it is now.
      { toolCallId: "call-request-recorded", input: request(scope, "tab-a") },
      // Guessed its generations: refused, and told to leave them out.
      {
        toolCallId: "call-request-guessed",
        input: request(scope, "tab-b", {
          expectedControllerGeneration: "unknown",
          expectedTargetGeneration: "unknown",
          expectedDocumentGeneration: "unknown",
        }),
      },
    ];
    const paused = await pause(scope, first, calls, readTarget);
    // Both requests name no auth run, so both tabs were read at the pause.
    expect(reads.sort()).toEqual(["tab-a", "tab-b"]);
    const [refusal, ...others] = refusalsIn(paused.events);
    expect(others).toEqual([]);
    expect(refusal?.payload).toEqual({
      approvalId: "call-request-guessed",
      decision: "reject",
      refusal: `Nothing was requested: the expected generation values given do not match the tab or window as it is now. ${LEAVE_OUT}`,
    });
    const recorded = paused.interactionInterventionRequests[0]!;
    expect(
      await getInteractionIntervention(client.db, { ...scope, interventionId: recorded.id }),
    ).toMatchObject({ status: "open", targetId: "tab-a", ...current });
    // Only the recorded request counts as opened.
    expect(
      await recordedInteractionRequestCalls(client.db, {
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        turnId: first.turn.id,
        calls,
      }),
    ).toEqual([calls[0]]);

    // The refusal answers its own call; the re-freeze keeps waiting for the
    // person on the recorded request without recording it again.
    const resumed = await resumeRefusal(scope, refusal!, readTarget);
    expect(resumed.outcome).toEqual({ action: "requires_action" });
    expect(resumed.reopened).toEqual([]);
    expect(refusalsIn(resumed.events)).toEqual([]);
    expect(
      resumed.rows.find((row) => row.callId === "call-request-guessed")?.resultItem,
    ).toMatchObject({ output: { type: "text", text: refusal!.payload.refusal } });
    expect(
      resumed.rows.find((row) => row.callId === "call-request-recorded")?.resultItem ?? null,
    ).toBeNull();
    expect(await peekSessionWork(client.db, scope.workspaceId, scope.sessionId)).toMatchObject({
      kind: "approval-wait",
      interactionInterventionId: recorded.id,
    });
  });
});
