import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  secretUseApprovalHumanInput,
  secretUseApprovalQuestionId,
  type HumanInputQuestion,
} from "@opengeni/contracts";
import {
  HumanInputResponseValidationError,
  acceptSessionHumanInputResponse,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("secret-use-approval-response");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const TARGET = {
  vaultId: crypto.randomUUID(),
  itemId: crypto.randomUUID(),
  fieldKey: "password",
  vaultName: "Private",
  itemName: "GitHub",
  fieldName: "password",
};

/**
 * A run blocked on a marked secret: the stored request row, and an agent card
 * whose text was changed on the way to request_human_input.
 */
async function freezeApprovalCard() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `secret-approval-account-${suffix}`,
    accountName: "Secret approval test",
    workspaceExternalSource: "test",
    workspaceExternalId: `secret-approval-workspace-${suffix}`,
    workspaceName: "Secret approval test",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "Log in to GitHub",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectRls(client.db, workspaceId, grant.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "continue",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`could not claim fixture: ${claim.reason}`);
  const turn = claim.turn;

  const approvalId = crypto.randomUUID();
  await shared.admin`
    insert into secret_use_approvals
      (id, account_id, workspace_id, session_id, approver_subject_id, targets,
       surface, tool_name, destination)
    values (${approvalId}::uuid, ${grant.accountId}::uuid, ${workspaceId}::uuid,
      ${session.id}::uuid, ${grant.subjectId}, ${shared.admin.json([TARGET])},
      'browser', 'browser_act', 'github.com')`;

  const requestId = crypto.randomUUID();
  const tampered: HumanInputQuestion = {
    id: secretUseApprovalQuestionId(approvalId),
    kind: "single_select",
    prompt: "Allow the agent to check the weather?",
    options: [
      { id: "window", label: "Sure" },
      { id: "deny", label: "No" },
    ],
    required: true,
    allowOther: true,
  };
  const settlement = await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: turn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: turn.id,
    runState: {
      serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
      pendingApprovals: [],
      humanInputRequests: [
        {
          id: requestId,
          toolCallId: "approval-call-1",
          questions: [tampered],
          allowSkip: true,
          expiresAt: null,
        },
      ],
    },
    events: [
      {
        type: "session.humanInput.requested" as const,
        payload: {
          request: { id: requestId, questions: [tampered], allowSkip: true, expiresAt: null },
        },
      },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  expect(settlement.action).toBe("settled");
  const canonical = secretUseApprovalHumanInput({
    id: approvalId,
    targets: [TARGET],
    surface: "browser",
    toolName: "browser_act",
    destination: "github.com",
  }).questions[0]!;
  return { grant, workspaceId, session, requestId, approvalId, questionId: tampered.id, canonical };
}

type Fixture = Awaited<ReturnType<typeof freezeApprovalCard>>;

function respond(
  fixture: Fixture,
  input: {
    values?: string[];
    other?: string;
    respondedBy?: string;
    respondedByKind?: "human" | "api" | "agent_attempt" | "system";
    personSignedIn?: boolean;
    skip?: boolean;
  },
) {
  return acceptSessionHumanInputResponse(client.db, {
    accountId: fixture.grant.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.session.id,
    requestId: fixture.requestId,
    response: input.skip
      ? { outcome: "skipped" }
      : {
          outcome: "answered",
          answers: [
            {
              questionId: fixture.questionId,
              values: input.values ?? [],
              ...(input.other ? { other: input.other } : {}),
            },
          ],
        },
    respondedBy: input.respondedBy ?? fixture.grant.subjectId,
    ...(input.respondedByKind ? { respondedByKind: input.respondedByKind } : {}),
    canonicalHumanSession: true,
    personSignedIn: input.personSignedIn ?? true,
  });
}

async function approvalRow(fixture: Fixture) {
  const [row] = await shared.admin<
    Array<{
      status: string;
      scope: string | null;
      expires_at: Date | null;
      decided_by_subject_id: string | null;
    }>
  >`
    select status, scope, expires_at, decided_by_subject_id
    from secret_use_approvals where id = ${fixture.approvalId}::uuid`;
  return row!;
}

describe("secret approval cards", () => {
  test("the stored question and its event carry the host's card, not the agent's text", async () => {
    const fixture = await freezeApprovalCard();
    const [stored] = await shared.admin<
      Array<{ questions: HumanInputQuestion[]; allow_skip: boolean }>
    >`
      select questions, allow_skip from session_human_input_requests
      where id = ${fixture.requestId}::uuid`;
    expect(stored?.allow_skip).toBe(false);
    expect(stored?.questions).toHaveLength(1);
    expect(stored?.questions[0]).toMatchObject({
      kind: "single_select",
      allowOther: false,
      prompt: "Allow the agent to use GitHub › password in the browser on github.com?",
    });
    expect(stored?.questions[0]?.id).toBe(fixture.canonical.id);
    expect(stored?.questions[0]?.options.map((option) => option.id)).toEqual([
      "once",
      "session",
      "window",
      "deny",
    ]);

    const [event] = await shared.admin<Array<{ request: Record<string, unknown> }>>`
      select payload -> 'request' as request from session_events
      where session_id = ${fixture.session.id}::uuid and type = 'session.humanInput.requested'`;
    expect(event?.request.allowSkip).toBe(false);
    expect(event?.request.questions).toEqual(stored?.questions);
    expect(JSON.stringify(event?.request)).not.toContain("weather");
  });

  test("only the person the run acts for can answer, as a human", async () => {
    const fixture = await freezeApprovalCard();
    await expect(
      respond(fixture, { values: ["session"], respondedBy: `user:${crypto.randomUUID()}` }),
    ).rejects.toMatchObject({ code: "HUMAN_AUTH_REQUIRED" });
    await expect(
      respond(fixture, { values: ["session"], respondedByKind: "api" }),
    ).rejects.toMatchObject({ code: "HUMAN_AUTH_REQUIRED" });
    await expect(
      respond(fixture, {
        values: ["session"],
        respondedBy: `agent_attempt:${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_AUTH_REQUIRED" });
    // An agent or personal key acting as the person carries their subject but
    // is not their own sign-in.
    await expect(
      respond(fixture, { values: ["session"], personSignedIn: false }),
    ).rejects.toMatchObject({ code: "HUMAN_AUTH_REQUIRED" });
    // The system may only deny (a scheduled run's timeout), never allow.
    await expect(
      respond(fixture, {
        values: ["window"],
        respondedBy: "system:scheduled-approval-timeout",
        respondedByKind: "system",
        personSignedIn: false,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_AUTH_REQUIRED" });
    expect((await approvalRow(fixture)).status).toBe("pending");

    const timedOut = await freezeApprovalCard();
    const denied = await respond(timedOut, {
      values: ["deny"],
      respondedBy: "system:scheduled-approval-timeout",
      respondedByKind: "system",
      personSignedIn: false,
    });
    expect(denied.action).toBe("accepted");
    expect(await approvalRow(timedOut)).toMatchObject({
      status: "denied",
      decided_by_subject_id: "system:scheduled-approval-timeout",
    });
  });

  test("the answer must be one of the card's own choices and cannot be skipped", async () => {
    const fixture = await freezeApprovalCard();
    await expect(respond(fixture, { values: ["forever"] })).rejects.toBeInstanceOf(
      HumanInputResponseValidationError,
    );
    await expect(
      respond(fixture, { values: ["once"], other: "and every other secret" }),
    ).rejects.toBeInstanceOf(HumanInputResponseValidationError);
    await expect(respond(fixture, { values: ["once", "window"] })).rejects.toBeInstanceOf(
      HumanInputResponseValidationError,
    );
    await expect(respond(fixture, { skip: true })).rejects.toBeInstanceOf(
      HumanInputResponseValidationError,
    );
    expect((await approvalRow(fixture)).status).toBe("pending");
  });

  test("the approver's choice becomes the grant in the same transaction", async () => {
    const fixture = await freezeApprovalCard();
    const accepted = await respond(fixture, { values: ["session"] });
    expect(accepted.action).toBe("accepted");
    expect(await approvalRow(fixture)).toMatchObject({
      status: "approved",
      scope: "session",
      expires_at: null,
      decided_by_subject_id: fixture.grant.subjectId,
    });

    const denied = await freezeApprovalCard();
    expect((await respond(denied, { values: ["deny"] })).action).toBe("accepted");
    expect(await approvalRow(denied)).toMatchObject({ status: "denied", scope: null });

    const windowed = await freezeApprovalCard();
    const before = Date.now();
    expect((await respond(windowed, { values: ["window"] })).action).toBe("accepted");
    const windowRow = await approvalRow(windowed);
    expect(windowRow).toMatchObject({ status: "approved", scope: "window" });
    const ends = new Date(windowRow.expires_at!).getTime();
    expect(ends).toBeGreaterThan(before + 59 * 60 * 1000);
    expect(ends).toBeLessThan(Date.now() + 61 * 60 * 1000);
  });
});
