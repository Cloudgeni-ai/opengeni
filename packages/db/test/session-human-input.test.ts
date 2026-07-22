import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  HumanInputResponseValidationError,
  acceptSessionApprovalDecision,
  acceptSessionHumanInputResponse,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  expireSessionHumanInputRequest,
  getHumanInputResumeForEvent,
  getSessionHumanInputRequest,
  peekSessionWork,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-human-input");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function createFixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `human-input-account-${suffix}`,
    accountName: "Human input test",
    workspaceExternalSource: "test",
    workspaceExternalId: `human-input-workspace-${suffix}`,
    workspaceName: "Human input test",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "Ask me before proceeding",
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
  return await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery,
        text,
        resources: [],
        tools: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
}

async function freezeRequest(options: { expiresAt?: Date | null; parallel?: boolean } = {}) {
  const { grant, session } = await createFixture();
  await send(grant, session.id, "continue with my decision");
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`could not claim fixture: ${claim.reason}`);
  const turn = claim.turn;
  const requestId = crypto.randomUUID();
  const parallelRequestId = options.parallel ? crypto.randomUUID() : null;
  const questions = [
    {
      id: "environment",
      kind: "single_select" as const,
      prompt: "Which environment?",
      options: [
        { id: "staging", label: "Staging" },
        { id: "production", label: "Production" },
      ],
      required: true,
      allowOther: false,
    },
  ];
  const expiresAt = options.expiresAt ?? null;
  const humanInputRequests = [
    {
      id: requestId,
      toolCallId: "human-call-1",
      questions,
      allowSkip: false,
      expiresAt,
    },
    ...(parallelRequestId
      ? [
          {
            id: parallelRequestId,
            toolCallId: "human-call-2",
            questions,
            allowSkip: false,
            expiresAt,
          },
        ]
      : []),
  ];
  const settlement = await applySessionTurnSettlement(client.db, grant.workspaceId!, {
    sessionId: session.id,
    turnId: turn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: turn.id,
    runState: {
      serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
      pendingApprovals: [{ id: "ordinary-call" }],
      humanInputRequests,
    },
    events: [
      ...humanInputRequests.map((request) => ({
        type: "session.humanInput.requested" as const,
        payload: { request },
      })),
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  expect(settlement.action).toBe("settled");
  return { grant, session, turn, attemptId, requestId, parallelRequestId, questions };
}

describe("durable structured human input", () => {
  test("atomically freezes, survives a workflow restart, validates, and resumes the same turn", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const fixture = await freezeRequest({ expiresAt });
    const request = await getSessionHumanInputRequest(
      client.db,
      fixture.grant.workspaceId!,
      fixture.session.id,
      fixture.requestId,
    );
    expect(request).toMatchObject({
      id: fixture.requestId,
      turnId: fixture.turn.id,
      turnGeneration: fixture.turn.executionGeneration,
      creationAttemptId: fixture.attemptId,
      toolCallId: "human-call-1",
      status: "pending",
    });
    if (!request?.expiresAt) throw new Error("fixture request did not retain its deadline");
    // A fresh workflow obtains all wait state from Postgres, including the timer.
    expect(
      await peekSessionWork(client.db, fixture.grant.workspaceId!, fixture.session.id),
    ).toEqual({
      kind: "approval-wait",
      humanInputRequestId: fixture.requestId,
      expiresAt: request.expiresAt,
    });

    await expect(
      acceptSessionHumanInputResponse(client.db, {
        accountId: fixture.grant.accountId,
        workspaceId: fixture.grant.workspaceId!,
        sessionId: fixture.session.id,
        requestId: fixture.requestId,
        response: { outcome: "answered", answers: [] },
        respondedBy: fixture.grant.subjectId,
      }),
    ).rejects.toBeInstanceOf(HumanInputResponseValidationError);

    const accepted = await acceptSessionHumanInputResponse(client.db, {
      accountId: fixture.grant.accountId,
      workspaceId: fixture.grant.workspaceId!,
      sessionId: fixture.session.id,
      requestId: fixture.requestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "environment", values: ["staging"] }],
      },
      respondedBy: fixture.grant.subjectId,
      clientEventId: crypto.randomUUID(),
    });
    expect(accepted.action).toBe("accepted");
    if (accepted.action !== "accepted") throw new Error("response was not accepted");
    expect(
      await getHumanInputResumeForEvent(
        client.db,
        fixture.grant.workspaceId!,
        fixture.session.id,
        accepted.event,
      ),
    ).toEqual({
      requestId: fixture.requestId,
      toolCallId: "human-call-1",
      response: {
        outcome: "answered",
        answers: [{ questionId: "environment", values: ["staging"] }],
      },
    });
    expect(
      await peekSessionWork(client.db, fixture.grant.workspaceId!, fixture.session.id),
    ).toEqual({
      kind: "approval-pending",
      triggerEventId: accepted.event.id,
    });

    const resumedAttemptId = crypto.randomUUID();
    const resumed = await claimSessionWorkForAttempt(client.db, fixture.grant.workspaceId!, {
      sessionId: fixture.session.id,
      workflowId: `session-${fixture.session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: resumedAttemptId,
      trigger: { kind: "approval", triggerEventId: accepted.event.id },
    });
    expect(resumed).toMatchObject({
      action: "claimed",
      turn: {
        id: fixture.turn.id,
        activeAttemptId: resumedAttemptId,
        executionGeneration: fixture.turn.executionGeneration + 1,
      },
    });
  });

  test("answer and early-expiry racers have one winner, while a passed deadline expires", async () => {
    const future = await freezeRequest({ expiresAt: new Date(Date.now() + 60_000) });
    const [answer, earlyExpiry] = await Promise.all([
      acceptSessionHumanInputResponse(client.db, {
        accountId: future.grant.accountId,
        workspaceId: future.grant.workspaceId!,
        sessionId: future.session.id,
        requestId: future.requestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: "environment", values: ["production"] }],
        },
        respondedBy: future.grant.subjectId,
      }),
      expireSessionHumanInputRequest(client.db, {
        accountId: future.grant.accountId,
        workspaceId: future.grant.workspaceId!,
        sessionId: future.session.id,
        requestId: future.requestId,
      }),
    ]);
    expect(answer.action).toBe("accepted");
    expect(earlyExpiry.action).toBe("conflict");
    expect(
      await getSessionHumanInputRequest(
        client.db,
        future.grant.workspaceId!,
        future.session.id,
        future.requestId,
      ),
    ).toMatchObject({ status: "answered" });

    const past = await freezeRequest({ expiresAt: new Date(Date.now() - 1_000) });
    const expired = await acceptSessionHumanInputResponse(client.db, {
      accountId: past.grant.accountId,
      workspaceId: past.grant.workspaceId!,
      sessionId: past.session.id,
      requestId: past.requestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "environment", values: ["staging"] }],
      },
      respondedBy: past.grant.subjectId,
    });
    expect(expired.action).toBe("conflict");
    if (expired.action === "not_found") throw new Error("expired request disappeared");
    expect(expired).toMatchObject({
      request: { status: "expired", response: { outcome: "expired" } },
    });
    expect(expired.events).toHaveLength(1);
  });

  test("admits only one response across parallel human and ordinary approval interruptions", async () => {
    const frozen = await freezeRequest({ parallel: true });
    if (!frozen.parallelRequestId) throw new Error("parallel request was not frozen");
    const parallelRequestId = frozen.parallelRequestId;
    const first = await acceptSessionHumanInputResponse(client.db, {
      accountId: frozen.grant.accountId,
      workspaceId: frozen.grant.workspaceId!,
      sessionId: frozen.session.id,
      requestId: frozen.requestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "environment", values: ["staging"] }],
      },
      respondedBy: frozen.grant.subjectId,
    });
    expect(first.action).toBe("accepted");

    const second = await acceptSessionHumanInputResponse(client.db, {
      accountId: frozen.grant.accountId,
      workspaceId: frozen.grant.workspaceId!,
      sessionId: frozen.session.id,
      requestId: parallelRequestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "environment", values: ["production"] }],
      },
      respondedBy: frozen.grant.subjectId,
    });
    expect(second).toMatchObject({
      action: "conflict",
      request: { id: parallelRequestId, status: "pending" },
    });
    expect(
      await acceptSessionApprovalDecision(client.db, {
        accountId: frozen.grant.accountId,
        workspaceId: frozen.grant.workspaceId!,
        sessionId: frozen.session.id,
        payload: { approvalId: "ordinary-call", decision: "approve" },
      }),
    ).toMatchObject({ action: "conflict" });

    if (first.action !== "accepted") throw new Error("first response was not accepted");
    const resumedAttemptId = crypto.randomUUID();
    const resumed = await claimSessionWorkForAttempt(client.db, frozen.grant.workspaceId!, {
      sessionId: frozen.session.id,
      workflowId: `session-${frozen.session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: resumedAttemptId,
      trigger: { kind: "approval", triggerEventId: first.event.id },
    });
    if (resumed.action !== "claimed") throw new Error(`resume claim failed: ${resumed.reason}`);
    const reFreeze = async (questions: typeof frozen.questions) =>
      await applySessionTurnSettlement(client.db, frozen.grant.workspaceId!, {
        sessionId: frozen.session.id,
        turnId: resumed.turn.id,
        triggerEventId: resumed.turn.triggerEventId,
        attemptId: resumedAttemptId,
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: resumed.turn.id,
        runState: {
          serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
          pendingApprovals: [],
          humanInputRequests: [
            {
              id: parallelRequestId,
              toolCallId: "human-call-2",
              questions,
              allowSkip: false,
              expiresAt: null,
            },
          ],
        },
        events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
      });
    await expect(
      reFreeze(
        frozen.questions.map((question) => ({ ...question, prompt: `${question.prompt} changed` })),
      ),
    ).rejects.toThrow(/changed contract/i);
    const reFrozen = await reFreeze(frozen.questions);
    expect(reFrozen.action).toBe("settled");
    expect(
      await acceptSessionHumanInputResponse(client.db, {
        accountId: frozen.grant.accountId,
        workspaceId: frozen.grant.workspaceId!,
        sessionId: frozen.session.id,
        requestId: parallelRequestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: "environment", values: ["production"] }],
        },
        respondedBy: frozen.grant.subjectId,
      }),
    ).toMatchObject({ action: "accepted" });

    const ordinaryFirst = await freezeRequest();
    expect(
      await acceptSessionApprovalDecision(client.db, {
        accountId: ordinaryFirst.grant.accountId,
        workspaceId: ordinaryFirst.grant.workspaceId!,
        sessionId: ordinaryFirst.session.id,
        payload: { approvalId: "ordinary-call", decision: "approve" },
      }),
    ).toMatchObject({ action: "accepted" });
    expect(
      await acceptSessionHumanInputResponse(client.db, {
        accountId: ordinaryFirst.grant.accountId,
        workspaceId: ordinaryFirst.grant.workspaceId!,
        sessionId: ordinaryFirst.session.id,
        requestId: ordinaryFirst.requestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: "environment", values: ["staging"] }],
        },
        respondedBy: ordinaryFirst.grant.subjectId,
      }),
    ).toMatchObject({
      action: "conflict",
      request: { id: ordinaryFirst.requestId, status: "pending" },
    });

    const concurrent = await freezeRequest({ parallel: true });
    if (!concurrent.parallelRequestId) throw new Error("parallel request was not frozen");
    const concurrentAnswer = (requestId: string, value: string) =>
      acceptSessionHumanInputResponse(client.db, {
        accountId: concurrent.grant.accountId,
        workspaceId: concurrent.grant.workspaceId!,
        sessionId: concurrent.session.id,
        requestId,
        response: {
          outcome: "answered" as const,
          answers: [{ questionId: "environment", values: [value] }],
        },
        respondedBy: concurrent.grant.subjectId,
      });
    const raced = await Promise.all([
      concurrentAnswer(concurrent.requestId, "staging"),
      concurrentAnswer(concurrent.parallelRequestId, "production"),
    ]);
    expect(raced.map((result) => result.action).sort()).toEqual(["accepted", "conflict"]);
  });

  test("Steer closes a pending request and emits explicit cancelled tool input", async () => {
    const frozen = await freezeRequest();
    await send(frozen.grant, frozen.session.id, "replace that question", "steer");
    expect(
      await getSessionHumanInputRequest(
        client.db,
        frozen.grant.workspaceId!,
        frozen.session.id,
        frozen.requestId,
      ),
    ).toMatchObject({
      status: "cancelled",
      response: { outcome: "cancelled" },
    });
    expect(await peekSessionWork(client.db, frozen.grant.workspaceId!, frozen.session.id)).toEqual({
      kind: "runnable",
    });
  });
});
