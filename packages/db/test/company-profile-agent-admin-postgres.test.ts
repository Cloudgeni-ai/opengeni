import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  activateWorkspaceLearningPolicyRevision,
  confirmCompanyProfileForAgent,
  createDb,
  createSession,
  createWorkspaceLearningPolicyRevision,
  ensureManagedAccessForUser,
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

async function fixture(options: { initiatingSubjectId?: string } = {}) {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `profile-agent-owner-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
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
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  const attempt = await seedAttempt({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    initiatingSubjectId: options.initiatingSubjectId ?? ownerSubjectId,
  });
  return { grant, ownerSubjectId, session, attempt };
}

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  initiatingSubjectId: string;
  turnId?: string;
}): Promise<Attempt> {
  if (!shared) throw new Error("test database unavailable");
  const turnId = input.turnId ?? crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const executionGeneration = 1;
  await shared.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    if (input.turnId) {
      await sql`
        update session_turn_attempts
        set state = 'closed', outcome = 'interrupted_recoverable', closed_at = now()
        where workspace_id = ${input.workspaceId} and turn_id = ${turnId}
          and state in ('claimed', 'running')`;
      await sql`
        update session_turns set active_attempt_id = null, status = 'recovering'
        where workspace_id = ${input.workspaceId} and id = ${turnId}`;
    } else {
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, execution_generation,
          initiator_kind, initiator_subject_id, initiator_context,
          initiating_human_subject_id
        ) values (
          ${turnId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
          ${crypto.randomUUID()}, ${`profile-agent-${turnId}`}, 'running', 'user', 1,
          'company profile fixture', 'test-model', 'medium', 'none', 1,
          'subject', ${input.initiatingSubjectId}, '{}'::jsonb, ${input.initiatingSubjectId}
        )`;
    }
    await sql`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}`;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, authority_epoch,
        authority_visibility, authority_owner_organization_membership_id,
        mcp_approval_policies
      ) values (
        ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${turnId}, 1, 'running', ${`profile-agent-${turnId}`}, ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0,
        (select authority_epoch from sessions where id = ${input.sessionId}),
        (select visibility from sessions where id = ${input.sessionId}),
        (select owner_organization_membership_id from sessions where id = ${input.sessionId}),
        '{}'::jsonb
      )`;
    await sql`
      update session_turns set active_attempt_id = ${attemptId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${turnId}`;
  });
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId,
    attemptId,
    executionGeneration,
    agentSubjectId: "worker:company-profile-agent",
  };
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

async function answerProposal(
  f: Awaited<ReturnType<typeof fixture>>,
  proposal: Awaited<ReturnType<typeof proposeCompanyProfileForAgent>>,
  values: string[] = ["activate"],
): Promise<string> {
  if (!shared) throw new Error("test database unavailable");
  const requestId = crypto.randomUUID();
  const questionId = proposal.humanInput.questions[0]!.id;
  await shared.admin`
    insert into session_human_input_requests (
      id, account_id, workspace_id, session_id, turn_id, turn_generation,
      creation_attempt_id, tool_call_id, status, questions, allow_skip,
      response, responded_by, responded_at
    ) values (
      ${requestId}, ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id},
      ${f.attempt.turnId}, 1, ${f.attempt.attemptId}, ${`call-${requestId}`}, 'answered',
      ${shared.admin.json(proposal.humanInput.questions)}::jsonb, false,
      ${shared.admin.json({
        outcome: "answered",
        answers: [{ questionId, values }],
      })}::jsonb,
      ${f.ownerSubjectId}, now()
    )`;
  return requestId;
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

  test("stages under learning-off, activates only after the bound owner answer, and replays", async () => {
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

    const rejectedInputId = await answerProposal(f, proposed, ["skip"]);
    await expect(
      confirmCompanyProfileForAgent(client.db, {
        attempt: f.attempt,
        request: {
          operationId: crypto.randomUUID(),
          proposalReceiptId: proposed.proposalReceiptId,
          humanInputRequestId: rejectedInputId,
        },
      }),
    ).rejects.toMatchObject({ code: "confirmation_unavailable" });

    const humanInputRequestId = await answerProposal(f, proposed);
    const resumedAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
      initiatingSubjectId: f.ownerSubjectId,
      turnId: f.attempt.turnId,
    });
    const confirmRequest = {
      operationId: crypto.randomUUID(),
      proposalReceiptId: proposed.proposalReceiptId,
      humanInputRequestId,
    };
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

    const [proposalReceipt, confirmationReceipt] = await Promise.all([
      shared.admin<Array<{ initiatingSubject: string; revisionId: string }>>`
        select initiating_human_subject_id as "initiatingSubject", revision_id as "revisionId"
        from company_profile_agent_proposal_receipts where id = ${proposed.proposalReceiptId}`,
      shared.admin<Array<{ approverSubject: string; eventId: string }>>`
        select approver_subject_id as "approverSubject", activation_event_id as "eventId"
        from company_profile_agent_confirmation_receipts
        where id = ${confirmed.confirmationReceiptId}`,
    ]);
    expect(proposalReceipt[0]).toEqual({
      initiatingSubject: f.ownerSubjectId,
      revisionId: proposed.revision.id,
    });
    expect(confirmationReceipt[0]).toEqual({
      approverSubject: f.ownerSubjectId,
      eventId: confirmed.mutation.event!.id,
    });
  }, 180_000);

  test("fails closed for missing org authority, authority drift, and cross-organization ids", async () => {
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
        reason: "Authority will be revalidated before activation.",
      },
    });
    const humanInputRequestId = await answerProposal(first, proposal);
    await shared.admin`
      update organization_memberships set role = 'member', authorization_revision = authorization_revision + 1
      where account_id = ${first.grant.accountId} and subject_id = ${first.ownerSubjectId}`;
    try {
      await expect(
        confirmCompanyProfileForAgent(client.db, {
          attempt: first.attempt,
          request: {
            operationId: crypto.randomUUID(),
            proposalReceiptId: proposal.proposalReceiptId,
            humanInputRequestId,
          },
        }),
      ).rejects.toMatchObject({ code: "confirmation_unavailable" });
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
