import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { secretUseApprovalQuestionId, type HumanInputQuestion } from "@opengeni/contracts";
import {
  HumanInputResponseValidationError,
  acceptSessionHumanInputResponse,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  listSessionHumanInputRequests,
  postSecretUseApprovalCard,
  requestSecretUseApproval,
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

/** A run blocked on a marked secret, with Opengeni's card posted for it. */
async function blockedUse() {
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
    createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
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
  const use = {
    sessionId: session.id,
    approverSubjectId: grant.subjectId,
    targets: [TARGET],
    surface: "browser",
    toolName: "browser_act",
    destination: "github.com",
  };
  const scope = { accountId: grant.accountId, workspaceId };
  const approval = await requestSecretUseApproval(client.db, scope, use);
  const post = () =>
    postSecretUseApprovalCard(client.db, {
      workspaceId,
      sessionId: session.id,
      turnId: turn.id,
      attemptId,
      executionGeneration: turn.executionGeneration,
      approval,
    });
  const card = await post();
  if (!card.requestId) throw new Error("no card was posted");
  return {
    grant,
    workspaceId,
    session,
    turn,
    attemptId,
    approval,
    approvalId: approval.id,
    requestId: card.requestId,
    card,
    questionId: secretUseApprovalQuestionId(approval.id),
    blockAgain: () => requestSecretUseApproval(client.db, scope, use),
    post,
  };
}

type Fixture = Awaited<ReturnType<typeof blockedUse>>;

function respond(
  fixture: Fixture,
  input: {
    values?: string[];
    other?: string;
    respondedBy?: string;
    respondedByKind?: "human" | "api" | "agent_attempt" | "system";
    personSignedIn?: boolean;
    skip?: boolean;
    clientEventId?: string;
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
    ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
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

async function cardRows(fixture: Fixture) {
  return await shared.admin<
    Array<{
      id: string;
      origin: string;
      status: string;
      allow_skip: boolean;
      expires_at: Date | null;
      questions: HumanInputQuestion[];
    }>
  >`
    select id::text, origin, status, allow_skip, expires_at, questions
    from session_human_input_requests
    where session_id = ${fixture.session.id}::uuid
    order by created_at`;
}

async function inboxQuestion(fixture: Fixture) {
  const rows = await shared.admin<Array<{ status: string; title: string; recipient: string }>>`
    select status, title, recipient_subject_id as recipient
    from opengeni_private.inbox_items
    where session_id = ${fixture.session.id}::uuid
      and kind = 'question' and source_key = ${fixture.requestId}`;
  return [...rows];
}

async function decisionUpdates(fixture: Fixture) {
  const rows = await shared.admin<
    Array<{ kind: string; classification: string; state: string; source_id: string }>
  >`
    select kind, classification, state, source_id
    from session_system_updates
    where session_id = ${fixture.session.id}::uuid and kind = 'secret_use_approval_decided'`;
  return [...rows];
}

async function completeTurn(fixture: Fixture) {
  const settled = await applySessionTurnSettlement(client.db, fixture.workspaceId, {
    sessionId: fixture.session.id,
    turnId: fixture.turn.id,
    triggerEventId: fixture.turn.triggerEventId,
    attemptId: fixture.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

describe("Opengeni's secret approval cards", () => {
  test("a blocked use posts the host's card once, in the chat and the person's inbox", async () => {
    const fixture = await blockedUse();
    expect(fixture.card.asked).toBe(true);
    expect(fixture.card.events.map((event) => event.type)).toEqual([
      "session.humanInput.requested",
    ]);
    const [row] = await cardRows(fixture);
    expect(row).toMatchObject({
      id: fixture.requestId,
      origin: "secret_use_approval",
      status: "pending",
      allow_skip: false,
      expires_at: null,
    });
    expect(row?.questions).toHaveLength(1);
    expect(row?.questions[0]).toMatchObject({
      id: fixture.questionId,
      kind: "single_select",
      allowOther: false,
      prompt: "Allow the agent to use GitHub › password in the browser on github.com?",
    });
    expect(row?.questions[0]?.options.map((option) => option.id)).toEqual([
      "once",
      "session",
      "window",
      "deny",
    ]);
    const [event] = await shared.admin<Array<{ request: Record<string, unknown> }>>`
      select payload -> 'request' as request from session_events
      where session_id = ${fixture.session.id}::uuid and type = 'session.humanInput.requested'`;
    expect(event?.request).toMatchObject({
      id: fixture.requestId,
      origin: "secret_use_approval",
      allowSkip: false,
      expiresAt: null,
    });
    expect(event?.request.questions).toEqual(row?.questions);
    expect(await inboxQuestion(fixture)).toEqual([
      {
        status: "open",
        title: "Allow the agent to use GitHub › password in the browser on github.com?",
        recipient: fixture.grant.subjectId,
      },
    ]);

    // The identical use, blocked again, reuses the request and its card.
    const again = await fixture.blockAgain();
    expect(again.id).toBe(fixture.approvalId);
    const reposted = await fixture.post();
    expect(reposted).toEqual({ asked: true, requestId: fixture.requestId, events: [] });
    expect(await cardRows(fixture)).toHaveLength(1);
    const [requested] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from session_events
      where session_id = ${fixture.session.id}::uuid and type = 'session.humanInput.requested'`;
    expect(requested?.count).toBe(1);
  });

  test("the card outlives the turn that was blocked", async () => {
    const fixture = await blockedUse();
    await completeTurn(fixture);
    expect((await cardRows(fixture))[0]?.status).toBe("pending");
    expect((await inboxQuestion(fixture))[0]?.status).toBe("open");
    const pending = await listSessionHumanInputRequests(
      client.db,
      fixture.workspaceId,
      fixture.session.id,
      { status: "pending" },
    );
    expect(pending.map((request) => [request.id, request.origin])).toEqual([
      [fixture.requestId, "secret_use_approval"],
    ]);

    const accepted = await respond(fixture, { values: ["once"] });
    expect(accepted.action).toBe("accepted");
    // The chat is idle now, so the answer wakes it for the agent.
    if (accepted.action !== "accepted") throw new Error("not accepted");
    expect(accepted.workflowWakeRevision).not.toBeNull();
    expect(accepted.events.map((event) => event.type)).toContain("user.humanInputResponse");
    expect((await approvalRow(fixture)).status).toBe("approved");
    expect((await inboxQuestion(fixture))[0]?.status).toBe("resolved");
  });

  test("only the person the run acts for can answer, signed in themselves", async () => {
    const fixture = await blockedUse();
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
    await expect(
      respond(fixture, {
        values: ["deny"],
        respondedBy: "system:scheduled-approval-timeout",
        respondedByKind: "system",
        personSignedIn: false,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_AUTH_REQUIRED" });
    expect((await approvalRow(fixture)).status).toBe("pending");
    expect((await cardRows(fixture))[0]?.status).toBe("pending");
    expect(await decisionUpdates(fixture)).toEqual([]);
  });

  test("the answer must be one of the card's own choices and cannot be skipped", async () => {
    const fixture = await blockedUse();
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

  test("an answer becomes the grant and an update that tells the agent", async () => {
    const fixture = await blockedUse();
    const clientEventId = crypto.randomUUID();
    const accepted = await respond(fixture, { values: ["session"], clientEventId });
    expect(accepted.action).toBe("accepted");
    if (accepted.action !== "accepted") throw new Error("not accepted");
    // The blocked turn is still running: the update waits for the next turn
    // claim instead of a new wake.
    expect(accepted.workflowWakeRevision).toBeNull();
    expect(accepted.event.type).toBe("user.humanInputResponse");
    expect(accepted.event.turnId ?? null).toBeNull();
    expect(await approvalRow(fixture)).toMatchObject({
      status: "approved",
      scope: "session",
      expires_at: null,
      decided_by_subject_id: fixture.grant.subjectId,
    });
    expect((await cardRows(fixture))[0]?.status).toBe("answered");
    expect(await decisionUpdates(fixture)).toEqual([
      {
        kind: "secret_use_approval_decided",
        classification: "action_required",
        state: "pending",
        source_id: fixture.approvalId,
      },
    ]);
    const [update] = await shared.admin<Array<{ payload: Record<string, unknown> }>>`
      select payload from session_system_updates
      where session_id = ${fixture.session.id}::uuid and kind = 'secret_use_approval_decided'`;
    expect(update?.payload).toMatchObject({
      type: "secret_use_approval_decided",
      approvalId: fixture.approvalId,
      requestId: fixture.requestId,
      decision: "session",
      secrets: ["GitHub › password"],
      surface: "browser",
      toolName: "browser_act",
      destination: "github.com",
    });
    expect(JSON.stringify(update?.payload)).not.toContain(TARGET.itemId);

    // The same submission replays; a later answer finds the card settled.
    const replay = await respond(fixture, { values: ["session"], clientEventId });
    expect(replay).toMatchObject({ action: "completed", settledBy: "same_submission" });
    const later = await respond(fixture, { values: ["deny"] });
    expect(later).toMatchObject({ action: "completed", settledBy: "earlier_response" });
    expect((await approvalRow(fixture)).status).toBe("approved");
    expect(await decisionUpdates(fixture)).toHaveLength(1);

    // A decided request is never asked about again.
    expect(await fixture.post()).toEqual({ asked: false, requestId: null, events: [] });
  });

  test("a denial is recorded and tells the agent not to retry", async () => {
    const fixture = await blockedUse();
    expect((await respond(fixture, { values: ["deny"] })).action).toBe("accepted");
    expect(await approvalRow(fixture)).toMatchObject({ status: "denied", scope: null });
    expect(await decisionUpdates(fixture)).toMatchObject([
      { kind: "secret_use_approval_decided", classification: "info", state: "pending" },
    ]);

    const windowed = await blockedUse();
    const before = Date.now();
    expect((await respond(windowed, { values: ["window"] })).action).toBe("accepted");
    const windowRow = await approvalRow(windowed);
    expect(windowRow).toMatchObject({ status: "approved", scope: "window" });
    const ends = new Date(windowRow.expires_at!).getTime();
    expect(ends).toBeGreaterThan(before + 59 * 60 * 1000);
    expect(ends).toBeLessThan(Date.now() + 61 * 60 * 1000);
  });
});
