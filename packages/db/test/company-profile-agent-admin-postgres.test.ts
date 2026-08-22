import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acceptSessionHumanInputResponse,
  activateWorkspaceLearningPolicyRevision,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  confirmCompanyProfileForAgent,
  createDb,
  createSession,
  createWorkspaceLearningPolicyRevision,
  ensureManagedAccessForUser,
  initializeSessionStartAtomically,
  listCompanyProfile,
  nestedPostgresSqlState,
  proposeCompanyProfileForAgent,
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

async function freezeProposal(
  f: Awaited<ReturnType<typeof fixture>>,
  proposal: Awaited<ReturnType<typeof proposeCompanyProfileForAgent>>,
): Promise<string> {
  if (!client) throw new Error("test database unavailable");
  const requestId = crypto.randomUUID();
  const questions = structuredClone(proposal.humanInput.questions);
  const settlement = await applySessionTurnSettlement(client.db, f.grant.workspaceId, {
    sessionId: f.session.id,
    turnId: f.attempt.turnId,
    triggerEventId: f.turn.triggerEventId,
    attemptId: f.attempt.attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: f.attempt.turnId,
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
      new URL("../drizzle/0318_human_confirmed_company_profile_agent_admin.sql", import.meta.url),
      "utf8",
    );
    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain("membership.role IN ('owner', 'admin')");
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
    const proposed = await proposeCompanyProfileForAgent(client.db, {
      attempt: f.attempt,
      request,
    });
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
      allowOther: true,
      options: [
        { id: "activate", label: "Activate" },
        { id: "skip", label: "Do not activate" },
      ],
    });
    expect(
      (
        await listCompanyProfile(client.db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          limit: 50,
        })
      ).current,
    ).toBeNull();
    expect(await proposeCompanyProfileForAgent(client.db, { attempt: f.attempt, request })).toEqual(
      {
        ...proposed,
        replayed: true,
      },
    );

    const humanInputRequestId = await freezeProposal(f, proposed);
    const answerEventId = await answerProposal(
      f,
      humanInputRequestId,
      proposed.humanInput.questions[0]!.id,
    );
    const resumedAttempt = await resumeAfterAnswer(f, answerEventId);
    expect(resumedAttempt.executionGeneration).toBe(f.attempt.executionGeneration + 1);
    const confirmRequest = {
      operationId: crypto.randomUUID(),
      proposalReceiptId: proposed.proposalReceiptId,
      humanInputRequestId,
    };

    await expect(
      confirmCompanyProfileForAgent(client.db, {
        attempt: {
          ...resumedAttempt,
          executionGeneration: f.attempt.executionGeneration,
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
      requestGeneration: f.attempt.executionGeneration,
      requestAttemptId: f.attempt.attemptId,
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

  test("keeps an owner rejection inactive through the canonical answer and resume lifecycle", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const proposed = await proposeCompanyProfileForAgent(client.db, {
      attempt: f.attempt,
      request: {
        operationId: crypto.randomUUID(),
        profile: profile(),
        reason: "The organization owner will reject this staged profile.",
      },
    });
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

    const proposal = await proposeCompanyProfileForAgent(client.db, {
      attempt: first.attempt,
      request: {
        operationId: crypto.randomUUID(),
        profile: profile(),
        reason: "Authority will be revalidated after the human-input resume.",
      },
    });
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
