import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  RequestHumanInputToolInput,
  type CompanyProfileAgentReviewRequiredReceipt,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acceptSessionHumanInputResponse,
  activateWorkspaceLearningPolicyRevision,
  appendSessionEventsForTurnAttempt,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  confirmCompanyProfileForAgent,
  createDb,
  createSession,
  createWorkspaceLearningPolicyRevision,
  ensureManagedAccessForUser,
  getCompanyProfileAgentPolicy,
  initializeSessionStartAtomically,
  listCompanyProfile,
  nestedPostgresSqlState,
  proposeCompanyProfileForAgent,
  requestSessionTurnRecovery,
  updateCompanyProfileAgentPolicy,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("company-profile-agent-admin");
  if (!shared && requireRealDatabase) {
    throw new Error("company-profile agent administration requires PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type Attempt = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  agentSubjectId: string;
};

const agentSubjectId = "worker:company-profile-agent";

function attemptFromClaim(
  scope: { accountId: string; workspaceId: string; sessionId: string },
  attemptId: string,
  turn: { id: string; executionGeneration: number },
): Attempt {
  return {
    ...scope,
    turnId: turn.id,
    attemptId,
    executionGeneration: turn.executionGeneration,
    agentSubjectId,
  };
}

async function fixture(options: { initiatingSubjectId?: string } = {}) {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `profile-agent-owner-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
  const initiatingSubjectId = options.initiatingSubjectId ?? ownerSubjectId;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Profile agent owner",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'profile-agent-test')
    on conflict (account_id) do nothing`;
  const offRevision = await createWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    workspaceMode: "off",
    actorSubjectId: ownerSubjectId,
    principalKind: "human_session",
  });
  await activateWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    revisionId: offRevision.id,
    expectedCurrentRevisionId: null,
    expectedActivationVersion: 0,
    actorSubjectId: ownerSubjectId,
    principalKind: "human_session",
    reason: "Keep workspace learning disabled while testing explicit organization administration.",
  });
  const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Set our organization profile and strategic goals.",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: initiatingSubjectId },
      createdByContext: {},
    }),
  );
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial company-profile turn was not created");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: started.temporalWorkflowId,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") {
    throw new Error(`company-profile proposal attempt was not claimed: ${claimed.reason}`);
  }
  const attempt = attemptFromClaim(
    { accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id },
    attemptId,
    claimed.turn,
  );
  return { grant, ownerSubjectId, session, turn: claimed.turn, attempt };
}

function profile() {
  return {
    identity: "Acme builds reliable logistics software.",
    mission: "Make critical supply chains predictable.",
    products: [{ key: "control-tower", content: "A real-time logistics control tower." }],
    customers: [{ key: "operators", content: "Enterprise supply-chain operators." }],
    goals: [{ key: "north-star", content: "Reach 99.99% decision availability." }],
    constraints: [{ key: "safety", content: "Never trade safety for delivery speed." }],
  };
}

function reviewRequired(
  receipt: Awaited<ReturnType<typeof proposeCompanyProfileForAgent>>,
): CompanyProfileAgentReviewRequiredReceipt {
  expect(receipt.status).toBe("confirmation_required");
  if (receipt.status !== "confirmation_required") {
    throw new Error("expected a review-required company-profile proposal");
  }
  return receipt;
}

async function freezeProposal(
  f: Awaited<ReturnType<typeof fixture>>,
  proposal: CompanyProfileAgentReviewRequiredReceipt,
  attempt: Attempt = f.attempt,
): Promise<string> {
  if (!client) throw new Error("test database unavailable");
  const requestId = crypto.randomUUID();
  const questions = structuredClone(proposal.humanInput.questions);
  const settlement = await applySessionTurnSettlement(client.db, f.grant.workspaceId, {
    sessionId: f.session.id,
    turnId: attempt.turnId,
    triggerEventId: f.turn.triggerEventId,
    attemptId: attempt.attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: attempt.turnId,
    runState: {
      serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
      pendingApprovals: [],
      humanInputRequests: [
        {
          id: requestId,
          toolCallId: `company-profile-confirmation:${proposal.proposalReceiptId}`,
          questions,
          allowSkip: proposal.humanInput.allowSkip,
          expiresAt: null,
        },
      ],
    },
    events: [
      {
        type: "session.humanInput.requested",
        payload: {
          request: {
            id: requestId,
            questions,
            allowSkip: proposal.humanInput.allowSkip,
            expiresAt: null,
          },
        },
      },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  expect(settlement.action).toBe("settled");
  return requestId;
}

async function answerProposal(
  f: Awaited<ReturnType<typeof fixture>>,
  requestId: string,
  questionId: string,
  values: string[] = ["activate"],
): Promise<string> {
  if (!client) throw new Error("test database unavailable");
  const accepted = await acceptSessionHumanInputResponse(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    sessionId: f.session.id,
    requestId,
    response: {
      outcome: "answered",
      answers: [{ questionId, values }],
    },
    respondedBy: f.ownerSubjectId,
    clientEventId: crypto.randomUUID(),
  });
  if (accepted.action !== "accepted") {
    throw new Error(`company-profile answer was not accepted: ${accepted.action}`);
  }
  return accepted.event.id;
}

async function resumeAfterAnswer(
  f: Awaited<ReturnType<typeof fixture>>,
  triggerEventId: string,
): Promise<Attempt> {
  if (!client) throw new Error("test database unavailable");
  const attemptId = crypto.randomUUID();
  const resumed = await claimSessionWorkForAttempt(client.db, f.grant.workspaceId, {
    sessionId: f.session.id,
    workflowId: `session-${f.session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "approval", triggerEventId },
  });
  if (resumed.action !== "claimed") {
    throw new Error(`company-profile confirmation attempt was not claimed: ${resumed.reason}`);
  }
  return attemptFromClaim(
    {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
    },
    attemptId,
    resumed.turn,
  );
}

// Worker death: checkpoint the exact live attempt as recoverable, then let the
// workflow re-claim the same logical turn with a replacement attempt at G+1.
async function recoverAndReclaim(
  f: Awaited<ReturnType<typeof fixture>>,
  attempt: Attempt,
): Promise<Attempt> {
  if (!shared || !client) throw new Error("test database unavailable");
  const [turnRow] = await shared.admin<Array<{ triggerEventId: string }>>`
    select trigger_event_id as "triggerEventId" from session_turns
    where workspace_id = ${f.grant.workspaceId} and id = ${attempt.turnId}`;
  if (!turnRow) throw new Error("company-profile turn is unavailable");
  const recovery = await requestSessionTurnRecovery(client.db, f.grant.workspaceId, {
    sessionId: f.session.id,
    turnId: attempt.turnId,
    triggerEventId: turnRow.triggerEventId,
    attemptId: attempt.attemptId,
    reason: "worker_lost",
  });
  if (recovery.action !== "recovering") {
    throw new Error(`company-profile attempt did not enter recovery: ${recovery.action}`);
  }
  const replacementAttemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, f.grant.workspaceId, {
    sessionId: f.session.id,
    workflowId: `session-${f.session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId: replacementAttemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") {
    throw new Error(`company-profile replacement attempt was not claimed: ${claimed.reason}`);
  }
  const replacement = attemptFromClaim(
    { accountId: f.grant.accountId, workspaceId: f.grant.workspaceId, sessionId: f.session.id },
    replacementAttemptId,
    claimed.turn,
  );
  expect(replacement.turnId).toBe(attempt.turnId);
  expect(replacement.executionGeneration).toBe(attempt.executionGeneration + 1);
  return replacement;
}

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

describe("company-profile agent administration", () => {
  test("declares an explicit organization authority independent of governed learning", async () => {
    const migration = await readFile(
      new URL("../drizzle/0324_human_confirmed_company_profile_agent_admin.sql", import.meta.url),
      "utf8",
    );
    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    // The agent path carries exactly the manual route's authority: the organization owner
    // (`account:admin`), never a widened owner/admin set.
    expect(migration.match(/membership\.role = 'owner'/g)).toHaveLength(2);
    expect(migration).not.toContain("membership.role IN ('owner', 'admin')");
    // Receipts that reference sessions carry the restrictive session visibility policy.
    expect(
      migration.match(
        /CREATE POLICY session_visibility_isolation\n {2}ON company_profile_agent_\w+_receipts AS RESTRICTIVE/g,
      ),
    ).toHaveLength(2);
    // Lock order: no lock stronger than managed_accounts FOR KEY SHARE precedes the canonical
    // workspace/session prefix; the nested activation reaches the organization row after it.
    const proposeBody = migration.slice(
      migration.indexOf("CREATE FUNCTION propose_company_profile_for_attempt("),
      migration.indexOf("CREATE FUNCTION confirm_company_profile_for_attempt("),
    );
    const confirmBody = migration.slice(
      migration.indexOf("CREATE FUNCTION confirm_company_profile_for_attempt("),
      migration.indexOf("REVOKE ALL ON FUNCTION propose_company_profile_for_attempt("),
    );
    for (const body of [proposeBody, confirmBody]) {
      expect(body).not.toMatch(/FROM managed_accounts account[^;]*FOR UPDATE/);
      expect(body).not.toMatch(/organization_memberships membership[^;]*FOR (SHARE|UPDATE)/);
      const workspacePrefix = body.indexOf("FROM workspaces workspace");
      const membershipLock = body.indexOf("FROM organization_memberships membership");
      const sessionPrefix = body.indexOf("FOR SHARE OF session, turn, attempt");
      const accountTouch = body.indexOf("FROM managed_accounts account");
      expect(workspacePrefix).toBeGreaterThan(0);
      expect(membershipLock).toBeGreaterThan(workspacePrefix);
      expect(sessionPrefix).toBeGreaterThan(membershipLock);
      const statementsBeforeSessionPrefix = body.slice(body.indexOf("\nBEGIN\n"), sessionPrefix);
      expect(statementsBeforeSessionPrefix).not.toContain("managed_accounts");
      expect(statementsBeforeSessionPrefix).not.toContain("FROM company_profile_heads");
      if (accountTouch >= 0) expect(accountTouch).toBeGreaterThan(sessionPrefix);
    }
    expect(proposeBody).toMatch(
      /FROM managed_accounts account\n {2}WHERE account\.id = p_account_id FOR KEY SHARE;/,
    );
    expect(confirmBody).not.toContain("FROM managed_accounts account");
    expect(confirmBody.indexOf("company_profile_apply_activation(")).toBeGreaterThan(
      confirmBody.indexOf("FOR SHARE OF session, turn, attempt"),
    );
    expect(migration).toContain("company_profile_agent_confirmation_summary(p_content_json)");
    expect(migration).toContain("proposal.execution_generation <= request.turn_generation");
    expect(migration).toContain("request.turn_generation < p_execution_generation");
    expect(migration).not.toContain("receipt.execution_generation = p_execution_generation");
    expect(migration).not.toContain("request.turn_generation = p_execution_generation");
    expect(migration).not.toContain("proposal.execution_generation + 1");
    expect(migration).not.toContain("request.turn_generation + 1");
    expect(migration).toContain("request.responded_by = actor_membership.subject_id");
    expect(migration).toContain("request.questions = proposal.human_input->'questions'");
    expect(migration).toContain("answer.value->'values' = '[\"activate\"]'::jsonb");
    expect(migration).toContain("p_content_json, p_content_hash, 'agent_admin'");
    expect(migration).toContain("company_profile_apply_activation(");
    expect(migration.match(/FOREIGN KEY \(workspace_id, session_id\)/g)).toHaveLength(2);
    expect(migration.match(/REFERENCES sessions\(workspace_id, id\)/g)).toHaveLength(2);
    expect(migration).not.toContain("REFERENCES sessions(account_id, workspace_id, id)");
    expect(migration.match(/FOREIGN KEY \(workspace_id, turn_id\)/g)).toHaveLength(2);
    expect(migration.match(/REFERENCES session_turns\(workspace_id, id\)/g)).toHaveLength(2);
    expect(migration).not.toContain(
      "REFERENCES session_turns(account_id, workspace_id, session_id, id)",
    );
    expect(migration).not.toContain("workspace_learning_policy");
    expect(migration).not.toContain("governed_learning");
  });

  test("uses the canonical G to G+1 lifecycle, activates, records P <= R < L, and replays", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const request = {
      operationId: crypto.randomUUID(),
      profile: profile(),
      reason: "The organization owner explicitly asked to set this profile and strategic goal.",
    };
    const proposed = reviewRequired(
      await proposeCompanyProfileForAgent(client.db, {
        attempt: f.attempt,
        request,
      }),
    );
    expect(proposed).toMatchObject({
      status: "confirmation_required",
      confirmWith: "company_profile_confirm",
      replayed: false,
      revision: {
        intent: "proposal",
        profile: request.profile,
        provenance: { source: "agent_admin" },
      },
    });
    expect(proposed.humanInput.questions[0]).toMatchObject({
      id: `company-profile:${proposed.revision.id}`,
      kind: "single_select",
      prompt: "Activate this organization identity and retained legacy details?",
      label: "Organization identity",
      allowOther: true,
      options: [
        { id: "activate", label: "Activate" },
        { id: "skip", label: "Do not activate" },
      ],
    });
    expect(proposed.humanInput.questions[0]!.helpText).toContain(
      "Legacy Products (retained compatibility context)",
    );
    expect(proposed.humanInput.questions[0]!.helpText).toContain(
      "A real-time logistics control tower.",
    );
    const helpText = proposed.humanInput.questions[0]!.helpText ?? "";
    expect(helpText).toContain(
      `Revision ${proposed.revision.revision}; SHA-256 ${proposed.revision.contentHash}.`,
    );
    expect(helpText).toContain("Identity: Acme builds reliable logistics software.");
    expect(helpText).toContain("Mission: Make critical supply chains predictable.");
    expect(helpText).not.toContain("Products:");
    expect(helpText).not.toContain("Constraints:");
    expect(helpText).not.toContain('{"identity"');
    expect(helpText.length).toBeLessThanOrEqual(2048);
    expect(
      (
        await listCompanyProfile(client.db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          limit: 50,
        })
      ).current,
    ).toBeNull();
    // The returned prompt is exactly what the stock `request_human_input` schema
    // persists, so the confirmation's jsonb equality on the asked questions holds.
    expect(RequestHumanInputToolInput.parse(proposed.humanInput)).toEqual(proposed.humanInput);
    expect(await proposeCompanyProfileForAgent(client.db, { attempt: f.attempt, request })).toEqual(
      {
        ...proposed,
        replayed: true,
      },
    );
    // Worker death before the prompt was raised: the replacement attempt at G+1
    // re-issues the identical operation id and replays the same receipt.
    const replacementAttempt = await recoverAndReclaim(f, f.attempt);
    expect(
      await proposeCompanyProfileForAgent(client.db, { attempt: replacementAttempt, request }),
    ).toEqual({ ...proposed, replayed: true });
    await expect(
      proposeCompanyProfileForAgent(client.db, {
        attempt: replacementAttempt,
        request: { ...request, reason: `${request.reason} (changed)` },
      }),
    ).rejects.toMatchObject({ code: "operation_reused" });

    const humanInputRequestId = await freezeProposal(f, proposed, replacementAttempt);
    const answerEventId = await answerProposal(
      f,
      humanInputRequestId,
      proposed.humanInput.questions[0]!.id,
    );
    const resumedAttempt = await resumeAfterAnswer(f, answerEventId);
    expect(resumedAttempt.executionGeneration).toBe(replacementAttempt.executionGeneration + 1);
    const confirmRequest = {
      operationId: crypto.randomUUID(),
      proposalReceiptId: proposed.proposalReceiptId,
      humanInputRequestId,
    };

    await expect(
      confirmCompanyProfileForAgent(client.db, {
        attempt: {
          ...resumedAttempt,
          executionGeneration: replacementAttempt.executionGeneration,
        },
        request: confirmRequest,
      }),
    ).rejects.toMatchObject({ code: "confirmation_unavailable" });

    const confirmed = await confirmCompanyProfileForAgent(client.db, {
      attempt: resumedAttempt,
      request: confirmRequest,
    });
    expect(confirmed).toMatchObject({
      status: "activated",
      replayed: false,
      mutation: {
        revision: { id: proposed.revision.id, profile: request.profile },
        head: { revisionId: proposed.revision.id, activationVersion: 1 },
        event: { type: "activate", actorSubjectId: f.ownerSubjectId },
      },
    });
    expect(
      await confirmCompanyProfileForAgent(client.db, {
        attempt: resumedAttempt,
        request: confirmRequest,
      }),
    ).toEqual({ ...confirmed, replayed: true });
    // Worker death after activation: the replacement attempt at L+1 replays the
    // same operation id, and a retry under a fresh operation id replays the
    // existing confirmation for this proposal rather than reporting a conflict.
    const confirmReplacementAttempt = await recoverAndReclaim(f, resumedAttempt);
    expect(
      await confirmCompanyProfileForAgent(client.db, {
        attempt: confirmReplacementAttempt,
        request: confirmRequest,
      }),
    ).toEqual({ ...confirmed, replayed: true });
    const freshConfirmOperationId = crypto.randomUUID();
    expect(
      await confirmCompanyProfileForAgent(client.db, {
        attempt: confirmReplacementAttempt,
        request: { ...confirmRequest, operationId: freshConfirmOperationId },
      }),
    ).toEqual({ ...confirmed, operationId: freshConfirmOperationId, replayed: true });
    await expect(
      confirmCompanyProfileForAgent(client.db, {
        attempt: confirmReplacementAttempt,
        request: {
          ...confirmRequest,
          operationId: crypto.randomUUID(),
          humanInputRequestId: crypto.randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: "confirmation_unavailable" });
    expect(
      (
        await listCompanyProfile(client.db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          limit: 50,
        })
      ).current,
    ).toMatchObject({ revisionId: proposed.revision.id, activationVersion: 1 });
    const [confirmationCount] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from company_profile_agent_confirmation_receipts
      where proposal_receipt_id = ${proposed.proposalReceiptId}`;
    expect(confirmationCount?.count).toBe(1);

    const [receipt] = await shared.admin<
      Array<{
        proposalGeneration: number;
        proposalAttemptId: string;
        requestGeneration: number;
        requestAttemptId: string;
        liveGeneration: number;
        confirmationAttemptId: string;
        initiatingSubject: string;
        approverSubject: string;
        revisionId: string;
        eventId: string;
      }>
    >`
      select proposal.execution_generation as "proposalGeneration",
             proposal.creation_attempt_id as "proposalAttemptId",
             request.turn_generation as "requestGeneration",
             request.creation_attempt_id as "requestAttemptId",
             confirmation.execution_generation as "liveGeneration",
             confirmation.confirmation_attempt_id as "confirmationAttemptId",
             proposal.initiating_human_subject_id as "initiatingSubject",
             confirmation.approver_subject_id as "approverSubject",
             proposal.revision_id as "revisionId",
             confirmation.activation_event_id as "eventId"
      from company_profile_agent_proposal_receipts proposal
      join company_profile_agent_confirmation_receipts confirmation
        on confirmation.account_id = proposal.account_id
       and confirmation.proposal_receipt_id = proposal.id
      join session_human_input_requests request
        on request.id = confirmation.human_input_request_id
      where proposal.id = ${proposed.proposalReceiptId}`;
    if (!receipt) throw new Error("company-profile lifecycle receipts were not persisted");
    expect(receipt).toMatchObject({
      proposalGeneration: f.attempt.executionGeneration,
      proposalAttemptId: f.attempt.attemptId,
      requestGeneration: replacementAttempt.executionGeneration,
      requestAttemptId: replacementAttempt.attemptId,
      liveGeneration: resumedAttempt.executionGeneration,
      confirmationAttemptId: resumedAttempt.attemptId,
      initiatingSubject: f.ownerSubjectId,
      approverSubject: f.ownerSubjectId,
      revisionId: proposed.revision.id,
      eventId: confirmed.mutation.event!.id,
    });
    expect(receipt.proposalGeneration <= receipt.requestGeneration).toBe(true);
    expect(receipt.requestGeneration < receipt.liveGeneration).toBe(true);
  }, 180_000);

  test("activates under an owner-enabled automatic policy and blocks new proposals when off", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    expect(
      await getCompanyProfileAgentPolicy(client.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        actorSubjectId: f.ownerSubjectId,
      }),
    ).toMatchObject({ mode: "suggest", version: 0 });
    const policyOperationId = crypto.randomUUID();
    const automaticPolicy = await updateCompanyProfileAgentPolicy(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      actorSubjectId: f.ownerSubjectId,
      mode: "automatic",
      expectedVersion: 0,
      operationId: policyOperationId,
    });
    expect(automaticPolicy).toMatchObject({ mode: "automatic", version: 1, changed: true });
    expect(
      await updateCompanyProfileAgentPolicy(client.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        actorSubjectId: f.ownerSubjectId,
        mode: "automatic",
        expectedVersion: 0,
        operationId: policyOperationId,
      }),
    ).toEqual(automaticPolicy);
    await expect(
      updateCompanyProfileAgentPolicy(client.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        actorSubjectId: f.ownerSubjectId,
        mode: "suggest",
        expectedVersion: 0,
        operationId: policyOperationId,
      }),
    ).rejects.toMatchObject({ code: "operation_reused" });
    await expect(
      updateCompanyProfileAgentPolicy(client.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        actorSubjectId: f.ownerSubjectId,
        mode: "off",
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "policy_conflict" });
    const request = {
      operationId: crypto.randomUUID(),
      profile: profile(),
      reason: "The owner enabled autonomous organization identity updates.",
    };
    const activated = await proposeCompanyProfileForAgent(client.db, {
      attempt: f.attempt,
      request,
    });
    expect(activated).toMatchObject({
      status: "activated",
      policyMode: "automatic",
      replayed: false,
      mutation: {
        head: { activationVersion: 1 },
        event: {
          type: "activate",
          actorSubjectId: "service:company-profile-autonomy",
        },
      },
    });
    if (activated.status !== "activated") {
      throw new Error("automatic company-profile policy did not activate the proposal");
    }
    expect(await proposeCompanyProfileForAgent(client.db, { attempt: f.attempt, request })).toEqual(
      { ...activated, replayed: true },
    );
    const [automaticReceiptCount] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from company_profile_agent_automatic_activation_receipts
      where proposal_receipt_id = ${activated.proposalReceiptId}`;
    expect(automaticReceiptCount?.count).toBe(1);

    await updateCompanyProfileAgentPolicy(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      actorSubjectId: f.ownerSubjectId,
      mode: "off",
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    });
    const [before] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from company_profile_revisions
      where account_id = ${f.grant.accountId}`;
    await expect(
      proposeCompanyProfileForAgent(client.db, {
        attempt: f.attempt,
        request: {
          operationId: crypto.randomUUID(),
          profile: {
            ...profile(),
            mission: "This proposal must be blocked before it becomes durable.",
          },
          reason: "Policy-off proof.",
        },
      }),
    ).rejects.toMatchObject({ code: "policy_disabled" });
    const [after] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from company_profile_revisions
      where account_id = ${f.grant.accountId}`;
    expect(after?.count).toBe(before?.count);
  }, 180_000);

  test("keeps an owner rejection inactive through the canonical answer and resume lifecycle", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const proposed = reviewRequired(
      await proposeCompanyProfileForAgent(client.db, {
        attempt: f.attempt,
        request: {
          operationId: crypto.randomUUID(),
          profile: profile(),
          reason: "The organization owner will reject this staged profile.",
        },
      }),
    );
    const humanInputRequestId = await freezeProposal(f, proposed);
    const answerEventId = await answerProposal(
      f,
      humanInputRequestId,
      proposed.humanInput.questions[0]!.id,
      ["skip"],
    );
    const resumedAttempt = await resumeAfterAnswer(f, answerEventId);
    await expect(
      confirmCompanyProfileForAgent(client.db, {
        attempt: resumedAttempt,
        request: {
          operationId: crypto.randomUUID(),
          proposalReceiptId: proposed.proposalReceiptId,
          humanInputRequestId,
        },
      }),
    ).rejects.toMatchObject({ code: "confirmation_unavailable" });
    expect(
      (
        await listCompanyProfile(client.db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          limit: 50,
        })
      ).current,
    ).toBeNull();
  }, 180_000);

  test("fails closed for authority drift after resume, missing authority, and cross-organization ids", async () => {
    if (!shared || !client) return;
    const unauthorized = await fixture({
      initiatingSubjectId: `user:outsider-${crypto.randomUUID()}`,
    });
    await expect(
      proposeCompanyProfileForAgent(client.db, {
        attempt: unauthorized.attempt,
        request: {
          operationId: crypto.randomUUID(),
          profile: profile(),
          reason: "An outsider must not gain organization authority from a workspace session.",
        },
      }),
    ).rejects.toMatchObject({ code: "authority_unavailable" });

    const first = await fixture();
    const second = await fixture();
    // An organization admin holds no `account:admin`; the agent path is exactly as narrow as
    // the manual route and refuses the admin-initiated turn.
    await shared.admin`
      update organization_memberships set role = 'admin', authorization_revision = authorization_revision + 1
      where account_id = ${first.grant.accountId} and subject_id = ${first.ownerSubjectId}`;
    try {
      await expect(
        proposeCompanyProfileForAgent(client.db, {
          attempt: first.attempt,
          request: {
            operationId: crypto.randomUUID(),
            profile: profile(),
            reason: "An organization admin cannot administer the profile through an agent.",
          },
        }),
      ).rejects.toMatchObject({ code: "authority_unavailable" });
    } finally {
      await shared.admin`
        update organization_memberships set role = 'owner', authorization_revision = authorization_revision + 1
        where account_id = ${first.grant.accountId} and subject_id = ${first.ownerSubjectId}`;
    }
    await expect(
      proposeCompanyProfileForAgent(client.db, {
        attempt: {
          ...first.attempt,
          accountId: second.grant.accountId,
          workspaceId: second.grant.workspaceId,
        },
        request: {
          operationId: crypto.randomUUID(),
          profile: profile(),
          reason: "Cross-organization ids must not authorize a profile write.",
        },
      }),
    ).rejects.toMatchObject({ code: "authority_unavailable" });

    const proposal = reviewRequired(
      await proposeCompanyProfileForAgent(client.db, {
        attempt: first.attempt,
        request: {
          operationId: crypto.randomUUID(),
          profile: profile(),
          reason: "Authority will be revalidated after the human-input resume.",
        },
      }),
    );
    const humanInputRequestId = await freezeProposal(first, proposal);
    const answerEventId = await answerProposal(
      first,
      humanInputRequestId,
      proposal.humanInput.questions[0]!.id,
    );
    const resumedAttempt = await resumeAfterAnswer(first, answerEventId);
    await shared.admin`
      update organization_memberships set role = 'member', authorization_revision = authorization_revision + 1
      where account_id = ${first.grant.accountId} and subject_id = ${first.ownerSubjectId}`;
    try {
      await expect(
        confirmCompanyProfileForAgent(client.db, {
          attempt: resumedAttempt,
          request: {
            operationId: crypto.randomUUID(),
            proposalReceiptId: proposal.proposalReceiptId,
            humanInputRequestId,
          },
        }),
      ).rejects.toMatchObject({ code: "confirmation_unavailable" });
      expect(
        (
          await listCompanyProfile(client.db, {
            accountId: first.grant.accountId,
            workspaceId: first.grant.workspaceId,
            limit: 50,
          })
        ).current,
      ).toBeNull();
    } finally {
      await shared.admin`
        update organization_memberships set role = 'owner', authorization_revision = authorization_revision + 1
        where account_id = ${first.grant.accountId} and subject_id = ${first.ownerSubjectId}`;
    }
    await expect(
      confirmCompanyProfileForAgent(client.db, {
        attempt: second.attempt,
        request: {
          operationId: crypto.randomUUID(),
          proposalReceiptId: proposal.proposalReceiptId,
          humanInputRequestId,
        },
      }),
    ).rejects.toMatchObject({ code: "confirmation_unavailable" });
  }, 180_000);

  test("never takes an organization-row lock before the session prefix and coexists with same-session event writers", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const writer = postgres(shared.adminUrl, { max: 1, prepare: false });
    const monitor = postgres(shared.adminUrl, { max: 1, prepare: false });
    const waitForBlockedAppBackend = async (): Promise<number> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const [row] = await monitor<{ pid: number }[]>`
          select pid from pg_stat_activity
          where datname = current_database()
            and usename = 'opengeni_app'
            and wait_event_type = 'Lock'
          limit 1`;
        if (row) return row.pid;
        await Bun.sleep(10);
      }
      throw new Error("the agent-admin call never queued behind the session writer");
    };
    const heldOrganizationLocks = async (pid: number): Promise<string[]> => {
      const rows = await monitor<{ relation: string }[]>`
        select lock.relation::regclass::text as relation
        from pg_locks lock
        where lock.pid = ${pid} and lock.locktype = 'relation' and lock.granted
          and lock.relation in (
            'managed_accounts'::regclass, 'company_profile_heads'::regclass,
            'company_profile_revisions'::regclass
          )`;
      return rows.map((row) => row.relation).sort();
    };
    // The canonical event writer holds `sessions FOR NO KEY UPDATE` and then reaches
    // `managed_accounts FOR KEY SHARE` through the session_events account FK. Run that exact
    // shape around a blocked propose / confirm. With an organization-row FOR UPDATE taken
    // before the session prefix this is an ABBA deadlock (40P01); with the canonical order the
    // blocked call holds nothing on the organization tables and finishes once the writer commits.
    const raceAgainstSessionWriter = async <T>(call: () => Promise<T>): Promise<T> => {
      let pending!: Promise<T>;
      await writer.begin(async (tx) => {
        await tx`select 1 from sessions where id = ${f.session.id} for no key update`;
        pending = call();
        void pending.catch(() => undefined);
        const pid = await waitForBlockedAppBackend();
        expect(await heldOrganizationLocks(pid)).toEqual([]);
        await tx`select 1 from managed_accounts where id = ${f.grant.accountId} for key share`;
        expect(
          await Promise.race([
            pending.then(() => "resolved" as const),
            Bun.sleep(250).then(() => "blocked" as const),
          ]),
        ).toBe("blocked");
      });
      try {
        return await Promise.race([
          pending,
          Bun.sleep(10_000).then(() => {
            throw new Error("the agent-admin call did not finish after the writer committed");
          }),
        ]);
      } catch (error) {
        if (nestedPostgresSqlState(error) === "40P01") {
          throw new Error("agent administration deadlocked against the session event writer", {
            cause: error,
          });
        }
        throw error;
      }
    };
    try {
      const request = {
        operationId: crypto.randomUUID(),
        profile: profile(),
        reason: "Lock-order proof: propose against a concurrent same-session event writer.",
      };
      const proposed = reviewRequired(
        await raceAgainstSessionWriter(() =>
          proposeCompanyProfileForAgent(client!.db, { attempt: f.attempt, request }),
        ),
      );
      expect(proposed.status).toBe("confirmation_required");
      // A real same-turn event append proceeds once nothing is held.
      await appendSessionEventsForTurnAttempt(
        client.db,
        f.grant.workspaceId,
        f.session.id,
        f.attempt.turnId,
        f.attempt.executionGeneration,
        f.attempt.attemptId,
        [{ type: "agent.message.delta", payload: { text: "lock-order proof" } }],
      );

      const humanInputRequestId = await freezeProposal(f, proposed);
      const answerEventId = await answerProposal(
        f,
        humanInputRequestId,
        proposed.humanInput.questions[0]!.id,
      );
      const resumedAttempt = await resumeAfterAnswer(f, answerEventId);
      const confirmed = await raceAgainstSessionWriter(() =>
        confirmCompanyProfileForAgent(client!.db, {
          attempt: resumedAttempt,
          request: {
            operationId: crypto.randomUUID(),
            proposalReceiptId: proposed.proposalReceiptId,
            humanInputRequestId,
          },
        }),
      );
      expect(confirmed).toMatchObject({
        status: "activated",
        mutation: { head: { revisionId: proposed.revision.id, activationVersion: 1 } },
      });
    } finally {
      await writer.end().catch(() => undefined);
      await monitor.end().catch(() => undefined);
    }
  }, 180_000);

  test("keeps receipt tables non-readable and immutable for the runtime role", async () => {
    if (!shared) return;
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        () => app`select * from company_profile_agent_proposal_receipts limit 1`,
        "42501",
      );
      await expectSqlState(
        () => app`select * from company_profile_agent_confirmation_receipts limit 1`,
        "42501",
      );
      await expectSqlState(
        () => app`delete from company_profile_agent_proposal_receipts where false`,
        "42501",
      );
    } finally {
      await app.end();
    }
  }, 180_000);
});
