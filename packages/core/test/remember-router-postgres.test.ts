import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  activateWorkspaceInstructionPolicyRevision,
  activateWorkspaceLearningPolicyRevision,
  createWorkspaceInstructionPolicyDraft,
  createDb,
  createSession,
  createWorkspaceLearningPolicyRevision,
  ensureManagedAccessForUser,
  getWorkspaceInstructionPolicyBaseline,
  listGovernedLearningActivationHistory,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  RememberError,
  createRememberRouter,
  rememberConfirmationLabel,
} from "../src/domain/remember";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-remember-router");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL is unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture(mode: "off" | "suggest" | "automatic") {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `learning-router-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Learning router owner",
  });
  const grant = access.workspaceGrants[0]!;
  const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "route governed learning",
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
  const revision = await createWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    workspaceMode: mode,
    actorSubjectId: ownerSubjectId,
    principalKind: "human_session",
  });
  await activateWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    revisionId: revision.id,
    expectedCurrentRevisionId: null,
    expectedActivationVersion: 0,
    actorSubjectId: ownerSubjectId,
    principalKind: "human_session",
    reason: `Enable ${mode} learning in this fixture.`,
  });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    await sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        initiator_kind, initiator_subject_id, initiator_context,
        initiating_human_subject_id
      ) values (
        ${turnId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
        ${crypto.randomUUID()}, ${`learning-router-${turnId}`}, 'running', 'user', 1,
        'route', 'test-model', 'medium', 'none', 1, 'subject',
        ${ownerSubjectId}, '{}'::jsonb, ${ownerSubjectId}
      )
    `;
    await sql`update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${grant.workspaceId} and id = ${session.id}`;
    await sql`update session_turns set active_attempt_id = ${attemptId}
      where workspace_id = ${grant.workspaceId} and id = ${turnId}`;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
        ${turnId}, 1, 'running', ${`learning-router-${turnId}`}, ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
  });
  const attempt = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
  return { grant, ownerSubjectId, session, attempt };
}

/** The canonical prompt is lane-specific, so the fixture can derive the lane. */
function laneFromPrompt(prompt: string): "preference" | "instruction_policy" | "knowledge" {
  if (prompt.includes("mandatory workspace rule")) return "instruction_policy";
  if (prompt.includes("workspace knowledge")) return "knowledge";
  return "preference";
}

async function answeredRememberInput(
  f: Awaited<ReturnType<typeof fixture>>,
  targetId: string,
  content: string,
  answer: string[] = ["save"],
  prompt = "Save this as a workspace preference for everyone in this workspace?",
): Promise<string> {
  const id = crypto.randomUUID();
  const questionId = `remember:${targetId}`;
  await shared!.admin`
    insert into session_human_input_requests (
      id, account_id, workspace_id, session_id, turn_id, turn_generation,
      creation_attempt_id, tool_call_id, status, questions, allow_skip,
      response, responded_by, responded_at
    ) values (
      ${id}, ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id},
      ${f.attempt.turnId}, 1, ${f.attempt.attemptId}, ${`call-${id}`}, 'answered',
      ${shared!.admin.json([
        {
          id: questionId,
          kind: "single_select",
          prompt,
          // The exact label production produces, so this proves the real
          // card text still satisfies the human-confirmed capability.
          label: rememberConfirmationLabel({
            lane: laneFromPrompt(prompt),
            contentChars: Array.from(content).length,
          }),
          helpText: content,
          options: [
            { id: "save", label: "Save" },
            { id: "skip", label: "Don't save" },
          ],
          required: true,
          allowOther: false,
        },
      ])}::jsonb,
      false,
      ${shared!.admin.json({ outcome: "answered", answers: [{ questionId, values: answer }] })}::jsonb,
      ${f.ownerSubjectId}, now()
    )
  `;
  return id;
}

function preferenceRequest(operationId = crypto.randomUUID()) {
  return {
    operationId,
    lane: "preference" as const,
    scope: "workspace" as const,
    content: "Always deploy staging from the main branch before tagging a release.",
    reason: "The user asked to remember this for the workspace.",
    stableKey: `remember.${crypto.randomUUID().replaceAll("-", "")}`,
    title: "Deploy staging from main",
    description: "User-directed deployment preference.",
  };
}

describe("remember router (real PostgreSQL)", () => {
  test("activates immediately under automatic learning", async () => {
    if (!shared || !client) return;
    const f = await fixture("automatic");
    const router = createRememberRouter({ db: client.db });
    const receipt = await router.remember({ attempt: f.attempt, request: preferenceRequest() });
    expect(receipt.status).toBe("activated");
    if (receipt.status !== "activated") return;
    expect(receipt.activation).toMatchObject({
      destination: "preference",
      authorityKind: "automatic",
      undo: "learning_history",
    });
    expect(receipt.learning?.automaticEligible).toBe(true);
    // The automatic path keeps its exact legacy review wording.
    const [automaticReview] = await shared.admin<Array<{ state: string; reason: string }>>`
      select review.state, review.reason from knowledge_claim_reviews review
      join knowledge_change_proposals proposal on proposal.claim_id = review.claim_id
      where proposal.id = ${receipt.proposalId} order by review.review_revision desc limit 1
    `;
    expect(automaticReview).toMatchObject({
      state: "approved",
      reason: "Automatic governed-learning activation.",
    });
  }, 180_000);

  test("requires one bound human confirmation under suggest, then activates with human authority", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const router = createRememberRouter({ db: client.db });
    const request = preferenceRequest();
    const receipt = await router.remember({ attempt: f.attempt, request });
    expect(receipt.status).toBe("confirmation_required");
    if (receipt.status !== "confirmation_required") return;
    expect(receipt.humanInput.questions[0]).toMatchObject({
      id: `remember:${receipt.proposalId!}`,
      kind: "single_select",
      options: [
        { id: "save", label: "Save" },
        { id: "skip", label: "Don't save" },
      ],
    });
    expect(receipt.humanInput.questions[0]!.helpText).toBe(request.content);
    // The card names the cost before a human agrees to it.
    expect(receipt.humanInput.questions[0]!.label).toBe(
      rememberConfirmationLabel({ lane: "preference", contentChars: request.content.length }),
    );
    expect(receipt.learning?.outcome).toBe("suggest");
    // Replaying the same remember converges on the same proposal.
    const replay = await router.remember({ attempt: f.attempt, request });
    expect(replay).toEqual(receipt);

    const decisionReceiptId = receipt.learning!.receiptId;
    // A "don't save" answer cannot activate.
    const skipped = await answeredRememberInput(f, receipt.proposalId!, request.content, ["skip"]);
    await expect(
      router.confirm({
        attempt: f.attempt,
        request: {
          target: "proposal",
          operationId: crypto.randomUUID(),
          proposalId: receipt.proposalId!,
          decisionReceiptId,
          humanInputRequestId: skipped,
        },
      }),
    ).rejects.toThrow();
    // A different proposal id cannot be confirmed with this answer.
    const answered = await answeredRememberInput(f, receipt.proposalId!, request.content);
    await expect(
      router.confirm({
        attempt: f.attempt,
        request: {
          target: "proposal",
          operationId: crypto.randomUUID(),
          proposalId: crypto.randomUUID(),
          decisionReceiptId,
          humanInputRequestId: answered,
        },
      }),
    ).rejects.toBeInstanceOf(RememberError);
    // A foreign decision receipt id cannot be confirmed with this answer.
    await expect(
      router.confirm({
        attempt: f.attempt,
        request: {
          target: "proposal",
          operationId: crypto.randomUUID(),
          proposalId: receipt.proposalId!,
          decisionReceiptId: crypto.randomUUID(),
          humanInputRequestId: answered,
        },
      }),
    ).rejects.toThrow();

    const confirmRequest = {
      target: "proposal" as const,
      operationId: crypto.randomUUID(),
      proposalId: receipt.proposalId!,
      decisionReceiptId,
      humanInputRequestId: answered,
    };
    const confirmed = await router.confirm({ attempt: f.attempt, request: confirmRequest });
    expect(confirmed).toMatchObject({
      status: "activated",
      proposalId: receipt.proposalId,
      decisionReceiptId,
      activation: {
        destination: "preference",
        authorityKind: "human_confirmed",
        undo: "learning_history",
      },
    });
    const confirmReplay = await router.confirm({ attempt: f.attempt, request: confirmRequest });
    expect(confirmReplay).toEqual(confirmed);
    // The human-confirmed activation records a truthful review reason, not the
    // automatic wording.
    const [confirmedReview] = await shared.admin<Array<{ state: string; reason: string }>>`
      select review.state, review.reason from knowledge_claim_reviews review
      join knowledge_change_proposals proposal on proposal.claim_id = review.claim_id
      where proposal.id = ${receipt.proposalId} order by review.review_revision desc limit 1
    `;
    expect(confirmedReview).toMatchObject({
      state: "approved",
      reason: "Approved by the exact initiating human through human-confirmed learning activation.",
    });
    const history = await listGovernedLearningActivationHistory(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      principalKind: "human_session",
      limit: 10,
    });
    expect(history.activations).toHaveLength(1);
    expect(history.activations[0]).toMatchObject({
      id: confirmed.activation.receiptId,
      authorityKind: "human_confirmed",
      humanInputRequestId: answered,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    // The proposal is consumed; confirming again is not possible.
    await expect(
      router.confirm({
        attempt: f.attempt,
        request: { ...confirmRequest, operationId: crypto.randomUUID() },
      }),
    ).rejects.toThrow();
  }, 180_000);

  test("mandatory rules always need the human even under automatic; knowledge needs it too; off blocks", async () => {
    if (!shared || !client) return;
    const automatic = await fixture("automatic");
    const router = createRememberRouter({ db: client.db });
    const rule = await router.remember({
      attempt: automatic.attempt,
      request: {
        operationId: crypto.randomUUID(),
        lane: "instruction_policy",
        scope: "workspace",
        content: "Never push directly to main.",
        reason: "The user said this is a hard rule.",
      },
    });
    expect(rule.status).toBe("confirmation_required");
    if (rule.status === "confirmation_required") {
      expect(rule.learning?.automaticEligible).toBe(true);
      expect(rule.humanInput.questions[0]!.prompt).toContain("mandatory workspace rule");
    }
    const fact = await router.remember({
      attempt: automatic.attempt,
      request: {
        operationId: crypto.randomUUID(),
        lane: "knowledge",
        scope: "workspace",
        content: "Acme's largest customer is Globex.",
        reason: "The user stated a company fact.",
        subject: "Acme",
      },
    });
    expect(fact.status).toBe("confirmation_required");
    if (fact.status === "confirmation_required") {
      expect(fact.proposalId).toBeNull();
      expect(fact.humanInput.questions[0]).toMatchObject({
        id: `remember:${fact.claimId}`,
        prompt: "Save this as workspace knowledge for everyone in this workspace?",
      });
    }

    const off = await fixture("off");
    const blocked = await router.remember({ attempt: off.attempt, request: preferenceRequest() });
    expect(blocked).toMatchObject({ status: "blocked", reason: "learning_policy_off" });
  }, 180_000);

  test("knowledge facts approve through the review lifecycle only after the bound human answer", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const router = createRememberRouter({ db: client.db });
    const content = "Acme's largest customer is Globex.";
    const receipt = await router.remember({
      attempt: f.attempt,
      request: {
        operationId: crypto.randomUUID(),
        lane: "knowledge",
        scope: "workspace",
        content,
        reason: "The user stated a company fact.",
        subject: "Acme",
      },
    });
    expect(receipt.status).toBe("confirmation_required");
    if (receipt.status !== "confirmation_required") return;
    const knowledgePrompt = "Save this as workspace knowledge for everyone in this workspace?";
    // Misleading prompt or a preference-shaped question cannot confirm a fact.
    const misleading = await answeredRememberInput(
      f,
      receipt.claimId,
      content,
      ["save"],
      "Continue?",
    );
    const wrongLane = await answeredRememberInput(f, receipt.claimId, content);
    for (const humanInputRequestId of [misleading, wrongLane, crypto.randomUUID()]) {
      await expect(
        router.confirm({
          attempt: f.attempt,
          request: {
            target: "knowledge_claim",
            operationId: crypto.randomUUID(),
            claimId: receipt.claimId,
            humanInputRequestId,
          },
        }),
      ).rejects.toThrow();
    }
    const answered = await answeredRememberInput(
      f,
      receipt.claimId,
      content,
      ["save"],
      knowledgePrompt,
    );
    const confirmRequest = {
      target: "knowledge_claim" as const,
      operationId: crypto.randomUUID(),
      claimId: receipt.claimId,
      humanInputRequestId: answered,
    };
    const confirmed = await router.confirm({ attempt: f.attempt, request: confirmRequest });
    expect(confirmed).toMatchObject({
      status: "activated",
      proposalId: null,
      claimId: receipt.claimId,
      activation: {
        destination: "knowledge",
        claimId: receipt.claimId,
        authorityKind: "human_confirmed",
        undo: "knowledge_review",
      },
    });
    const replay = await router.confirm({ attempt: f.attempt, request: confirmRequest });
    expect(replay).toEqual(confirmed);
    const [latestReview] = await shared.admin<
      Array<{ state: string; actor_kind: string; reason: string }>
    >`
      select state, actor_kind, reason from knowledge_claim_reviews
      where claim_id = ${receipt.claimId} order by review_revision desc limit 1
    `;
    expect(latestReview).toMatchObject({
      state: "approved",
      actor_kind: "service",
      // The bound human confirmation records its truthful reason, not the
      // automatic wording.
      reason: "Approved by the exact initiating human through the bound remember confirmation.",
    });
    // A second confirmation of an approved claim conflicts.
    await expect(
      router.confirm({
        attempt: f.attempt,
        request: { ...confirmRequest, operationId: crypto.randomUUID() },
      }),
    ).rejects.toThrow();
  }, 180_000);

  test("a user-directed rule binds to the workspace's current active policy head", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    // Most real workspaces already have an active global policy.
    const existing = await createWorkspaceInstructionPolicyDraft(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "Existing human policy.",
      provenanceSource: "human",
      provenanceSourceId: null,
      supersedesRevisionId: null,
      createdBySubjectId: f.ownerSubjectId,
    });
    await activateWorkspaceInstructionPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      revisionId: existing.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: f.ownerSubjectId,
      reason: "Seed an active head.",
    });
    const router = createRememberRouter({ db: client.db });
    const rule = await router.remember({
      attempt: f.attempt,
      request: {
        operationId: crypto.randomUUID(),
        lane: "instruction_policy",
        scope: "workspace",
        content: "Never push directly to main.",
        reason: "Hard rule stated by the user.",
      },
    });
    expect(rule.status).toBe("confirmation_required");
    if (rule.status !== "confirmation_required") return;
    expect(rule.proposalId).not.toBeNull();
    expect(rule.humanInput.questions[0]!.prompt).toContain("mandatory workspace rule");

    // The bug this covers is "the rule cannot be saved", so drive it all the way
    // through activation: the confirmation re-checks the stored baseline against
    // the live head, and the head must advance past the seeded revision.
    const humanInputRequestId = await answeredRememberInput(
      f,
      rule.proposalId!,
      "Never push directly to main.",
      ["save"],
      "Save this as a mandatory workspace rule for everyone in this workspace?",
    );
    const confirmed = await router.confirm({
      attempt: f.attempt,
      request: {
        target: "proposal",
        operationId: crypto.randomUUID(),
        proposalId: rule.proposalId!,
        decisionReceiptId: rule.learning!.receiptId,
        humanInputRequestId,
      },
    });
    expect(confirmed.status).toBe("activated");
    if (confirmed.status !== "activated") return;
    expect(confirmed.activation).toMatchObject({
      destination: "instruction_policy",
      authorityKind: "human_confirmed",
    });
    const head = await getWorkspaceInstructionPolicyBaseline(client.db, {
      workspaceId: f.grant.workspaceId,
      target: { kind: "policy", scope: "global", roleKey: null },
    });
    expect(head.expectedActivationVersion).toBe(2);
    expect(head.expectedCurrentRevisionId).not.toBe(existing.id);
  }, 180_000);
});
