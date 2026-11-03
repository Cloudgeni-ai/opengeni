import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  acceptSessionApprovalDecision,
  accountOwnerLabelForTurn,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionTurn,
  getToolActionReview,
  personalConnectionOwnerForTurn,
  prepareConnectorActionApproval,
  saveRunState,
  SessionApprovalForbiddenError,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal-connection-approval-owner");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

describe("whose account an approval runs on", () => {
  test("reads the owner from personal bindings and delegations, never shared ones", () => {
    const connectionId = crypto.randomUUID();
    expect(
      personalConnectionOwnerForTurn({
        connectionId,
        mcpAccountBindings: [
          { connectionId, subjectScope: "subject", ownerSubjectId: "user:alice" },
        ],
        personalConnectionDelegations: [],
      }),
    ).toBe("user:alice");
    expect(
      personalConnectionOwnerForTurn({
        connectionId,
        mcpAccountBindings: null,
        personalConnectionDelegations: [{ connectionId, ownerSubjectId: "user:alice" }],
      }),
    ).toBe("user:alice");
    expect(
      personalConnectionOwnerForTurn({
        connectionId,
        mcpAccountBindings: [{ connectionId, subjectScope: "workspace", ownerSubjectId: null }],
        personalConnectionDelegations: [
          { connectionId: crypto.randomUUID(), ownerSubjectId: "user:alice" },
        ],
      }),
    ).toBeNull();
    expect(
      personalConnectionOwnerForTurn({
        connectionId: "session-mcp:mail:synthetic",
        mcpAccountBindings: "corrupt",
        personalConnectionDelegations: { not: "a list" },
      }),
    ).toBeNull();
  });

  test("names the owner only from their own message, and says who can approve", () => {
    const context = { label: "Alice Example" };
    const own = {
      initiatorKind: "subject",
      initiatorSubjectId: "user:alice",
      initiatorContext: context,
    };
    expect(accountOwnerLabelForTurn("user:alice", own)).toBe("Alice Example");
    expect(accountOwnerLabelForTurn("user:bob", own)).toBeNull();
    // A bridge's or key's label is never presented as the person's name.
    expect(
      accountOwnerLabelForTurn("user:alice", {
        initiatorKind: "service",
        initiatorSubjectId: "user:alice",
        initiatorContext: { label: "Slack" },
      }),
    ).toBeNull();
    expect(
      new SessionApprovalForbiddenError({ subjectId: "user:alice", label: "Alice Example" })
        .message,
    ).toBe(
      "Only Alice Example can approve this action, because it runs on their own account. Ask them to approve it, or decline it.",
    );
  });
});

async function workspaceWithTwoPeople() {
  const sql = shared!.admin;
  const [account] =
    await sql`insert into managed_accounts (name) values ('approval owner') returning id`;
  const [workspace] =
    await sql`insert into workspaces (account_id, name) values (${account!.id}, 'shared') returning id`;
  const scope = { accountId: account!.id as string, workspaceId: workspace!.id as string };
  const alice = `user:${crypto.randomUUID()}`;
  const bob = `user:${crypto.randomUUID()}`;
  const connections: Record<string, string> = {};
  for (const subject of [alice, bob]) {
    const [personal] =
      await sql`insert into workspaces (account_id, name) values (${scope.accountId}, 'personal') returning id`;
    await sql`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${scope.accountId}, ${subject}, 'active', ${personal!.id})`;
    await sql`insert into workspace_memberships (account_id, workspace_id, subject_id) values (${scope.accountId}, ${scope.workspaceId}, ${subject})`;
    connections[subject] = await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${scope.accountId}, true), set_config('opengeni.workspace_id', ${scope.workspaceId}, true), set_config('opengeni.subject_id', ${subject}, true)`;
      const [connection] =
        await tx`insert into connections (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
        values (${scope.accountId}, ${scope.workspaceId}, ${subject}, 'mail.example.test', 'oauth2', 'fixture-ciphertext') returning id`;
      return connection!.id as string;
    });
  }
  await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
  const delegation = (subject: string) => ({
    serverId: "mail",
    connectionId: connections[subject]!,
    originWorkspaceId: scope.workspaceId,
    ownerSubjectId: subject,
    providerDomain: "mail.example.test",
    kind: "oauth2" as const,
  });
  const session = await createSession(client.db, {
    ...scope,
    subjectId: alice,
    createdBy: { kind: "subject", subjectId: alice },
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const send = (
    subject: string,
    text: string,
    personalConnectionDelegations: ReturnType<typeof delegation>[],
    expectedDraftRevision?: number,
  ) =>
    withWorkspaceSubjectSessionActivityRls(client.db, scope.workspaceId, subject, (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...scope,
        sessionId: session.id,
        subjectId: subject,
        actor: { type: "human", subjectId: subject },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text,
        resources: [],
        model: "test-model",
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
        personalConnectionDelegations,
        ...(expectedDraftRevision !== undefined ? { expectedDraftRevision } : {}),
      }),
    );
  const claim = async () => {
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.action}`);
    return { attemptId, turn: claimed.turn };
  };
  return { sql, scope, alice, bob, connections, delegation, session, send, claim };
}

test("only the owner of a personal account approves a call on it; anyone may decline", async () => {
  if (!shared) return;
  const { scope, alice, bob, connections, delegation, session, send, claim } =
    await workspaceWithTwoPeople();
  await send(alice, "Send the report from my mail", [delegation(alice)]);
  const { attemptId, turn: claimedTurn } = await claim();
  const turn = (await getSessionTurn(client.db, scope.workspaceId, claimedTurn.id))!;
  const identity = {
    ...scope,
    sessionId: session.id,
    turnId: claimedTurn.id,
    attemptId,
    executionGeneration: claimedTurn.executionGeneration,
    initiator: turn.initiator,
  };
  const personalCall = (approvalId: string) =>
    prepareConnectorActionApproval(client.db, identity, {
      approvalId,
      connectionId: connections[alice]!,
      serverId: "mail",
      toolName: "send_message",
      arguments: { to: "someone@example.test", body: "synthetic" },
      defaultDecision: "ask",
    });
  const approvedByOwner = crypto.randomUUID();
  const declinedByOther = crypto.randomUUID();
  const sharedAction = crypto.randomUUID();
  for (const approvalId of [approvedByOwner, declinedByOther]) {
    const prepared = await personalCall(approvalId);
    expect(prepared).toMatchObject({ managed: true, decision: "ask" });
  }
  // A session-level server is not anyone's own account.
  await prepareConnectorActionApproval(client.db, identity, {
    approvalId: sharedAction,
    connectionId: "session-mcp:mail:synthetic",
    serverId: "mail",
    toolName: "send_message",
    arguments: { to: "team@example.test" },
    approvalMode: "session_mcp",
  });
  await saveRunState(client.db, {
    ...identity,
    expectedExecutionGeneration: identity.executionGeneration,
    expectedAttemptId: attemptId,
    serializedRunState: "{}",
    pendingApprovals: [approvedByOwner, declinedByOther, sharedAction].map((id) => ({
      id,
      name: "mail__send_message",
    })),
  });
  await applySessionTurnSettlement(client.db, scope.workspaceId, {
    sessionId: session.id,
    turnId: claimedTurn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: claimedTurn.id,
    events: [],
  });

  const review = (approvalId: string, viewerSubjectId: string) =>
    getToolActionReview(client.db, {
      ...scope,
      sessionId: session.id,
      approvalId,
      viewerSubjectId,
    });
  const otherView = await review(approvedByOwner, bob);
  expect(otherView).toMatchObject({ availableActions: ["reject"], approvedBy: "account_owner" });
  // This turn froze no sender name, so none is invented.
  expect(otherView).not.toHaveProperty("accountOwnerLabel");
  const ownerView = await review(approvedByOwner, alice);
  expect(ownerView?.availableActions).toEqual(["approve", "reject"]);
  // A chat shared with the workspace tells the owner the decision is theirs.
  expect(ownerView?.approvedBy).toBe("you");
  const sharedView = await review(sharedAction, bob);
  expect(sharedView?.availableActions).toEqual(["approve", "reject"]);
  expect(sharedView).not.toHaveProperty("approvedBy");

  const decide = (subjectId: string, approvalId: string, decision: "approve" | "reject") =>
    acceptSessionApprovalDecision(client.db, {
      ...scope,
      sessionId: session.id,
      subjectId,
      payload: { approvalId, decision },
      clientEventId: crypto.randomUUID(),
    });
  // Another member, or a workspace key, cannot make it run as Alice.
  for (const subjectId of [bob, `api_key:${crypto.randomUUID()}`]) {
    const refused = decide(subjectId, approvedByOwner, "approve");
    await expect(refused).rejects.toBeInstanceOf(SessionApprovalForbiddenError);
    await expect(refused).rejects.toMatchObject({
      code: "APPROVAL_REQUIRES_ACCOUNT_OWNER",
      owner: { subjectId: alice, label: null },
      message: expect.stringContaining("Only the person whose own account runs this action"),
    });
  }
  expect(await decide(bob, sharedAction, "approve")).toMatchObject({ action: "accepted" });
  expect(await decide(bob, declinedByOther, "reject")).toMatchObject({ action: "accepted" });
  expect(await decide(alice, approvedByOwner, "approve")).toMatchObject({ action: "accepted" });
}, 180_000);
