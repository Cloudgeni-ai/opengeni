import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { HumanInputQuestion } from "@opengeni/contracts";
import {
  HumanInputResponseValidationError,
  ApprovalRunStateLimitExceededError,
  APPROVAL_RUN_STATE_MAX_JSON_BYTES,
  acceptSessionApprovalDecision,
  acceptSessionHumanInputResponse,
  applySessionTurnSettlement,
  attachOpenSuffixToPendingToolCalls,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  expireSessionHumanInputRequest,
  getHumanInputResumeForEvent,
  getSessionHumanInputRequest,
  listSessionHumanInputRequests,
  listTurnOpenSuffixToolCalls,
  peekSessionWork,
  registerPendingSessionToolCall,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
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
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
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
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery,
        text,
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
}

async function freezeRequest(
  options: {
    expiresAt?: Date | null;
    parallel?: boolean;
    allowSkip?: boolean;
    optionalText?: boolean;
  } = {},
) {
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
  const questions: HumanInputQuestion[] = options.optionalText
    ? [
        {
          id: "note",
          kind: "text" as const,
          prompt: "Anything else?",
          options: [],
          required: false,
          allowOther: false,
        },
      ]
    : [
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
  const allowSkip = options.allowSkip ?? false;
  const humanInputRequests = [
    {
      id: requestId,
      toolCallId: "human-call-1",
      questions,
      allowSkip,
      expiresAt,
    },
    ...(parallelRequestId
      ? [
          {
            id: parallelRequestId,
            toolCallId: "human-call-2",
            questions,
            allowSkip,
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
        payload: {
          request: {
            id: request.id,
            questions: request.questions,
            allowSkip: request.allowSkip,
            expiresAt: request.expiresAt?.toISOString() ?? null,
          },
        },
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
      questions: [{ id: "environment", allowOther: true }],
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
        answers: [
          {
            questionId: "environment",
            values: [],
            other: "Customer sandbox eu-42",
          },
        ],
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
        answers: [
          {
            questionId: "environment",
            values: [],
            other: "Customer sandbox eu-42",
          },
        ],
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

  test("accepts an empty optional answer and a permitted Skip without weakening required validation", async () => {
    const optional = await freezeRequest({ optionalText: true });
    const empty = await acceptSessionHumanInputResponse(client.db, {
      accountId: optional.grant.accountId,
      workspaceId: optional.grant.workspaceId!,
      sessionId: optional.session.id,
      requestId: optional.requestId,
      response: { outcome: "answered", answers: [] },
      respondedBy: optional.grant.subjectId,
    });
    expect(empty).toMatchObject({
      action: "accepted",
      request: { status: "answered", response: { outcome: "answered", answers: [] } },
    });

    const skippable = await freezeRequest({ allowSkip: true });
    expect(
      await acceptSessionHumanInputResponse(client.db, {
        accountId: skippable.grant.accountId,
        workspaceId: skippable.grant.workspaceId!,
        sessionId: skippable.session.id,
        requestId: skippable.requestId,
        response: { outcome: "skipped" },
        respondedBy: skippable.grant.subjectId,
      }),
    ).toMatchObject({
      action: "accepted",
      request: { status: "skipped", response: { outcome: "skipped" } },
    });

    const required = await freezeRequest();
    await expect(
      acceptSessionHumanInputResponse(client.db, {
        accountId: required.grant.accountId,
        workspaceId: required.grant.workspaceId!,
        sessionId: required.session.id,
        requestId: required.requestId,
        response: { outcome: "answered", answers: [] },
        respondedBy: required.grant.subjectId,
      }),
    ).rejects.toBeInstanceOf(HumanInputResponseValidationError);
    await expect(
      acceptSessionHumanInputResponse(client.db, {
        accountId: required.grant.accountId,
        workspaceId: required.grant.workspaceId!,
        sessionId: required.session.id,
        requestId: required.requestId,
        response: { outcome: "skipped" },
        respondedBy: required.grant.subjectId,
      }),
    ).rejects.toMatchObject({ code: "SKIP_NOT_ALLOWED" });
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
    expect(["completed", "conflict"]).toContain(earlyExpiry.action);
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
    expect(expired.action).toBe("accepted");
    if (expired.action === "not_found") throw new Error("expired request disappeared");
    expect(expired).toMatchObject({
      request: { status: "expired", response: { outcome: "expired" } },
    });
    expect(expired.events).toHaveLength(1);

    const repeated = await acceptSessionHumanInputResponse(client.db, {
      accountId: past.grant.accountId,
      workspaceId: past.grant.workspaceId!,
      sessionId: past.session.id,
      requestId: past.requestId,
      response: { outcome: "skipped" },
      respondedBy: past.grant.subjectId,
    });
    expect(repeated).toMatchObject({
      action: "completed",
      request: { status: "expired", response: { outcome: "expired" } },
      events: [],
      workflowWakeRevision: null,
    });
    if (expired.action !== "accepted" || repeated.action !== "completed") {
      throw new Error("expiry did not produce accepted and completed results");
    }
    expect(repeated.event.id).toBe(expired.event.id);
  });

  test("repairs an eventless cancelled terminal row once without waking terminal work", async () => {
    const frozen = await freezeRequest();
    const cancelledAt = new Date();
    await shared.admin`
      update session_human_input_requests
      set status = 'cancelled', response = '{"outcome":"cancelled"}'::jsonb,
        responded_by = 'system:legacy_cancel', responded_at = ${cancelledAt},
        updated_at = ${cancelledAt}
      where workspace_id = ${frozen.grant.workspaceId!}
        and session_id = ${frozen.session.id}
        and id = ${frozen.requestId}`;

    const repaired = await acceptSessionHumanInputResponse(client.db, {
      accountId: frozen.grant.accountId,
      workspaceId: frozen.grant.workspaceId!,
      sessionId: frozen.session.id,
      requestId: frozen.requestId,
      response: { outcome: "skipped" },
      respondedBy: frozen.grant.subjectId,
    });
    expect(repaired).toMatchObject({
      action: "completed",
      request: { status: "cancelled", response: { outcome: "cancelled" } },
      events: [{ type: "user.humanInputResponse" }],
      workflowWakeRevision: null,
    });
    if (repaired.action !== "completed") throw new Error("cancelled request was not repaired");

    const replayed = await acceptSessionHumanInputResponse(client.db, {
      accountId: frozen.grant.accountId,
      workspaceId: frozen.grant.workspaceId!,
      sessionId: frozen.session.id,
      requestId: frozen.requestId,
      response: { outcome: "answered", answers: [] },
      respondedBy: frozen.grant.subjectId,
    });
    expect(replayed).toMatchObject({
      action: "completed",
      request: { status: "cancelled", response: { outcome: "cancelled" } },
      events: [],
      workflowWakeRevision: null,
    });
    if (replayed.action !== "completed") throw new Error("cancelled request did not replay");
    expect(replayed.event.id).toBe(repaired.event.id);

    const [evidence] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from session_events
      where workspace_id = ${frozen.grant.workspaceId!}
        and session_id = ${frozen.session.id}
        and type = 'user.humanInputResponse'
        and payload ->> 'requestId' = ${frozen.requestId}`;
    expect(evidence?.count).toBe(1);
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

    expect(
      await listSessionHumanInputRequests(client.db, frozen.grant.workspaceId!, frozen.session.id, {
        status: "pending",
      }),
    ).toEqual([]);

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
        subjectId: frozen.grant.subjectId,
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
      await listSessionHumanInputRequests(client.db, frozen.grant.workspaceId!, frozen.session.id, {
        status: "pending",
      }),
    ).toMatchObject([{ id: parallelRequestId, status: "pending" }]);
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
        subjectId: ordinaryFirst.grant.subjectId,
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

  test("attaches open-suffix reasoning onto the pending interruption receipt", async () => {
    const { grant, session } = await createFixture();
    await send(grant, session.id, "ask before continuing");
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
    expect(
      await registerPendingSessionToolCall(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId,
        callId: "human-call-1",
        callType: "function_call",
        callItem: {
          type: "function_call",
          callId: "human-call-1",
          name: "request_human_input",
          arguments: "{}",
        },
      }),
    ).toEqual({ accepted: true, registered: true });
    const reasoning = [
      { type: "reasoning", id: "rs_open", content: [{ type: "input_text", text: "ask" }] },
    ];
    expect(
      await attachOpenSuffixToPendingToolCalls(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId,
        members: [
          {
            callId: "human-call-1",
            interruptionKind: "human_input",
            reasoningItems: reasoning,
          },
        ],
      }),
    ).toEqual({ accepted: true, attached: 1 });
    expect(
      await listTurnOpenSuffixToolCalls(client.db, grant.workspaceId!, session.id, turn.id),
    ).toMatchObject([
      {
        callId: "human-call-1",
        interruptionKind: "human_input",
        tiedReasoningItems: reasoning,
        resultItem: null,
      },
    ]);
  });

  test("requires_action settlement rejects leftover run state above the envelope", async () => {
    const { grant, session } = await createFixture();
    await send(grant, session.id, "ask before continuing");
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
    await expect(
      applySessionTurnSettlement(client.db, grant.workspaceId!, {
        sessionId: session.id,
        turnId: claim.turn.id,
        triggerEventId: claim.turn.triggerEventId,
        attemptId,
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: claim.turn.id,
        runState: {
          serializedRunState: JSON.stringify({
            pad: "x".repeat(APPROVAL_RUN_STATE_MAX_JSON_BYTES),
          }),
          pendingApprovals: [],
        },
        events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
      }),
    ).rejects.toMatchObject({
      name: "ApprovalRunStateLimitExceededError",
      code: "approval_run_state_too_large",
    });
    expect(ApprovalRunStateLimitExceededError).toBeDefined();
  });
});
