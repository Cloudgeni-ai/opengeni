import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  GovernedLearningActivationAuthorityError,
  activateGovernedLearningDecision,
  activateHumanConfirmedLearningDecision,
  activateWorkspaceInstructionPolicyRevision,
  activateWorkspaceLearningPolicyRevision,
  appendKnowledgeClaim,
  appendKnowledgeClaimEvidence,
  appendKnowledgeClaimReview,
  appendKnowledgeDocumentVersion,
  appendKnowledgeSourceAclVersion,
  archiveTaskNote,
  confirmRememberKnowledgeClaim,
  createKnowledgeChangeProposal,
  createDb,
  createSession,
  createTaskNote,
  createWorkspaceInstructionPolicyKnowledgeProposal,
  createWorkspaceInstructionPolicyDraft,
  createWorkspaceLearningPolicyRevision,
  deauthorizeKnowledgeSourceRetrieval,
  ensureManagedAccessForUser,
  evaluateGovernedLearningProposal,
  getOrCreateWorkspaceLearningPolicySnapshot,
  listGovernedLearningActivationHistory,
  listWorkspaceInstructionPolicyRevisions,
  nestedPostgresSqlState,
  undoGovernedLearningActivation,
  upsertKnowledgeEntity,
  upsertKnowledgeFact,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  upsertKnowledgeSourceObject,
  withSessionRlsActorContext,
  writeCompanyBrainGovernedProposal,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("governed-learning-activation-postgres");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL is unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 12 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

async function fixture(mode: "off" | "suggest" | "automatic" = "automatic") {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `learning-activation-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Governed learning activation owner",
  });
  const grant = access.workspaceGrants[0]!;
  const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "activate governed learning",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  const learningRevision = await createWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    workspaceMode: mode,
    actorSubjectId: ownerSubjectId,
    principalKind: "human_session",
  });
  await activateWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    revisionId: learningRevision.id,
    expectedCurrentRevisionId: null,
    expectedActivationVersion: 0,
    actorSubjectId: ownerSubjectId,
    principalKind: "human_session",
    reason: "Enable governed automatic learning in this fixture.",
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
        ${crypto.randomUUID()}, ${`activation-${turnId}`}, 'running', 'user', 1,
        'activate', 'test-model', 'medium', 'none', 1, 'subject',
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
        ${turnId}, 1, 'running', ${`activation-${turnId}`}, ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
  });
  const writerAttempt = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
  const caller = { workspaceId: grant.workspaceId, subjectId: ownerSubjectId };
  const snapshot = await getOrCreateWorkspaceLearningPolicySnapshot(client.db, writerAttempt);
  return { grant, ownerSubjectId, session, writerAttempt, caller, snapshot, mode };
}

async function decision(
  f: Awaited<ReturnType<typeof fixture>>,
  destination: "preference" | "instruction_policy",
  instructionTarget: {
    kind: "policy";
    scope: "global" | "role";
    roleKey: string | null;
  } = { kind: "policy", scope: "global", roleKey: null },
  expectedInstructionActivationVersion = 0,
) {
  const noteText = `Activation source ${crypto.randomUUID()}`;
  const note = await createTaskNote(client!.db, {
    ...f.writerAttempt,
    operationId: crypto.randomUUID(),
    kind: "decision",
    text: noteText,
    expiresInDays: 7,
  });
  const common = {
    operationId: crypto.randomUUID(),
    noteId: note.note.id,
    expectedNoteVersion: 1 as const,
    entityType: "ways-of-working",
    normalizedKey: crypto.randomUUID(),
    displayName: "Activation fixture",
    predicateKey: "ways.activation-fixture",
    confidenceBps: 9_000,
    reason: "Create an exact inactive automatic-learning proposal.",
  };
  const write = await writeCompanyBrainGovernedProposal(client!.db, {
    attempt: f.writerAttempt,
    request:
      destination === "preference"
        ? {
            ...common,
            kind: "promote_task_note_preference" as const,
            stableKey: `activation.${crypto.randomUUID().replaceAll("-", "")}`,
            title: "Activation fixture",
            description: "A governed activation fixture.",
            precedenceRank: 0,
            conflictStrategy: "override" as const,
            conflictsWith: [],
            expiresAt: null,
          }
        : {
            ...common,
            kind: "promote_task_note_instruction_policy" as const,
            target: instructionTarget,
            expectedCurrentRevisionId: null,
            expectedActivationVersion: expectedInstructionActivationVersion,
          },
  });
  if (!write.knowledgeChangeProposalId) throw new Error("missing change proposal");
  const receipt = await evaluateGovernedLearningProposal(client!.db, {
    attempt: {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      sessionId: f.session.id,
      turnId: f.writerAttempt.turnId,
      attemptId: f.writerAttempt.attemptId,
      executionGeneration: 1,
    },
    request: {
      operationId: crypto.randomUUID(),
      policySnapshotId: f.snapshot.id,
      proposalId: write.knowledgeChangeProposalId,
      claimId: write.claimId,
      evidenceId: write.evidenceId,
    },
  });
  expect(receipt.automaticEligible).toBe(f.mode === "automatic");
  return { write, receipt, noteText };
}

async function answeredRememberInput(
  f: Awaited<ReturnType<typeof fixture>>,
  proposalId: string,
  content: string,
  overrides: {
    respondedBy?: string;
    answer?: string[];
    questionId?: string;
    status?: string;
    turnGeneration?: number;
    prompt?: string;
    helpText?: string;
    options?: Array<{ id: string; label: string }>;
    lane?: "preference" | "instruction_policy";
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const questionId = overrides.questionId ?? `remember:${proposalId}`;
  const what =
    (overrides.lane ?? "preference") === "preference"
      ? "workspace preference"
      : "mandatory workspace rule";
  const questions = [
    {
      id: questionId,
      kind: "single_select",
      prompt: overrides.prompt ?? `Save this as a ${what} for everyone in this workspace?`,
      // `packages/db` cannot import the core label builder, and the point
      // stands better this way: the capability reconstructs and byte-checks
      // `prompt`, `helpText`, and `options` but deliberately never `label`,
      // so an unrelated label must still authorize the activation.
      label: "a label the capability does not constrain",
      helpText: overrides.helpText ?? content,
      options: overrides.options ?? [
        { id: "save", label: "Save" },
        { id: "skip", label: "Don't save" },
      ],
      required: true,
      allowOther: false,
    },
  ];
  const status = overrides.status ?? "answered";
  const response =
    status === "answered"
      ? {
          outcome: "answered",
          answers: [{ questionId, values: overrides.answer ?? ["save"] }],
        }
      : null;
  await shared!.admin`
    insert into session_human_input_requests (
      id, account_id, workspace_id, session_id, turn_id, turn_generation,
      creation_attempt_id, tool_call_id, status, questions, allow_skip,
      response, responded_by, responded_at
    ) values (
      ${id}, ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id},
      ${f.writerAttempt.turnId}, ${overrides.turnGeneration ?? 1},
      ${f.writerAttempt.attemptId}, ${`call-${id}`}, ${status},
      ${shared!.admin.json(questions)}::jsonb, false,
      ${response ? shared!.admin.json(response) : null}::jsonb,
      ${status === "answered" ? (overrides.respondedBy ?? f.ownerSubjectId) : null},
      ${status === "answered" ? new Date() : null}
    )
  `;
  return id;
}

/**
 * Model exactly what `claimSessionWorkForAttempt` does when a `requires_action`
 * human-input pause resumes: the minting attempt is closed, the logical turn's
 * execution generation advances by one, and a new attempt at that generation
 * becomes the turn's active attempt.
 */
async function resumeTurnOntoNextGeneration(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { closedAttemptId: string; nextGeneration: number },
): Promise<{ attemptId: string; executionGeneration: number }> {
  const resumedAttemptId = crypto.randomUUID();
  await shared!.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    await sql`update session_turn_attempts set state = 'closed', outcome = 'requires_action',
      closed_at = now() where workspace_id = ${f.grant.workspaceId} and id = ${options.closedAttemptId}`;
    await sql`update session_turns
      set active_attempt_id = ${resumedAttemptId}, status = 'running',
        execution_generation = ${options.nextGeneration}
      where workspace_id = ${f.grant.workspaceId} and id = ${f.writerAttempt.turnId}`;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, authority_epoch,
        authority_visibility, authority_owner_organization_membership_id,
        mcp_approval_policies
      ) values (
        ${resumedAttemptId}, ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id},
        ${f.writerAttempt.turnId}, ${options.nextGeneration}, 'running',
        ${`activation-${f.writerAttempt.turnId}`},
        ${`run-${resumedAttemptId}`}, ${`activity-${resumedAttemptId}`}, 0,
        (select authority_epoch from sessions where id = ${f.session.id}),
        (select visibility from sessions where id = ${f.session.id}),
        (select owner_organization_membership_id from sessions where id = ${f.session.id}),
        '{}'::jsonb
      )
    `;
  });
  return { attemptId: resumedAttemptId, executionGeneration: options.nextGeneration };
}

/** Start a different logical turn in the same session and make it the active turn. */
async function activateDifferentTurn(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared!.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    // Only one current inference turn exists per session: the earlier turn
    // finished before the later one started.
    await sql`update session_turn_attempts set state = 'closed', outcome = 'completed',
      closed_at = now() where workspace_id = ${f.grant.workspaceId} and id = ${f.writerAttempt.attemptId}`;
    await sql`update session_turns
      set status = 'completed', active_attempt_id = null, finished_at = now()
      where workspace_id = ${f.grant.workspaceId} and id = ${f.writerAttempt.turnId}`;
    await sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        initiator_kind, initiator_subject_id, initiator_context,
        initiating_human_subject_id
      ) values (
        ${turnId}, ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id},
        ${crypto.randomUUID()}, ${`activation-${turnId}`}, 'running', 'user', 2,
        'activate again', 'test-model', 'medium', 'none', 2, 'subject',
        ${f.ownerSubjectId}, '{}'::jsonb, ${f.ownerSubjectId}
      )
    `;
    await sql`update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${f.grant.workspaceId} and id = ${f.session.id}`;
    await sql`update session_turns set active_attempt_id = ${attemptId}
      where workspace_id = ${f.grant.workspaceId} and id = ${turnId}`;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, authority_epoch,
        authority_visibility, authority_owner_organization_membership_id,
        mcp_approval_policies
      ) values (
        ${attemptId}, ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id},
        ${turnId}, 2, 'running', ${`activation-${turnId}`}, ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0,
        (select authority_epoch from sessions where id = ${f.session.id}),
        (select visibility from sessions where id = ${f.session.id}),
        (select owner_organization_membership_id from sessions where id = ${f.session.id}),
        '{}'::jsonb
      )
    `;
  });
  return turnId;
}

async function documentDecision(f: Awaited<ReturnType<typeof fixture>>) {
  const scope = { kind: "workspace" as const, workspaceId: f.grant.workspaceId, subjectId: null };
  const actor = {
    kind: "service" as const,
    subjectId: f.ownerSubjectId,
    initiatingHumanSubjectId: f.ownerSubjectId,
  };
  const provider = await upsertKnowledgeProvider(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    scope,
    operationId: crypto.randomUUID(),
    actor,
    providerKey: `activation-provider-${crypto.randomUUID()}`,
    externalTenantId: `activation-tenant-${crypto.randomUUID()}`,
  });
  const source = await upsertKnowledgeSource(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    scope,
    operationId: crypto.randomUUID(),
    actor,
    providerId: provider.id,
    externalSourceId: `activation-source-${crypto.randomUUID()}`,
    sourceKind: "test",
  });
  const acl = await appendKnowledgeSourceAclVersion(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    operationId: crypto.randomUUID(),
    actor,
    sourceId: source.id,
    audience: scope,
    expectedSourceLifecycleGeneration: source.lifecycleGeneration,
    expectedAclGeneration: 0,
    aclVersion: "v1",
    agentAccess: true,
    reasonCode: "activation-fixture",
  });
  const object = await upsertKnowledgeSourceObject(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    operationId: crypto.randomUUID(),
    actor,
    sourceId: source.id,
    externalObjectId: `activation-object-${crypto.randomUUID()}`,
  });
  const contentHash = createHash("sha256").update(crypto.randomUUID()).digest("hex");
  const version = await appendKnowledgeDocumentVersion(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    operationId: crypto.randomUUID(),
    actor,
    objectId: object.id,
    expectedSourceLifecycleGeneration: source.lifecycleGeneration,
    expectedObjectLifecycleGeneration: object.lifecycleGeneration,
    expectedVersionGeneration: 0,
    externalVersionId: "v1",
    contentSha256: contentHash,
    ingestionKey: `activation-ingestion-${crypto.randomUUID()}`,
    aclVersionId: acl.id,
    aclGeneration: acl.generation,
    reasonCode: "activation-fixture",
  });
  const entity = await upsertKnowledgeEntity(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    scope,
    operationId: crypto.randomUUID(),
    actor,
    entityType: "ways-of-working",
    normalizedKey: crypto.randomUUID(),
    displayName: "Document activation fixture",
  });
  const fact = await upsertKnowledgeFact(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    operationId: crypto.randomUUID(),
    actor,
    subjectEntityId: entity.id,
    predicateKey: "ways.document-activation",
    object: { kind: "text", value: "Document-backed activation fixture" },
  });
  const claim = await appendKnowledgeClaim(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    operationId: crypto.randomUUID(),
    actor,
    factId: fact.id,
    origin: "inferred",
    confidenceBps: 9_000,
    effectiveAt: new Date(Date.now() - 1_000).toISOString(),
    extractionMethod: "test",
  });
  const evidence = await appendKnowledgeClaimEvidence(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    operationId: crypto.randomUUID(),
    actor,
    claimId: claim.id,
    documentVersionId: version.id,
    polarity: "supports",
    contentHash,
  });
  await appendKnowledgeClaimReview(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    operationId: crypto.randomUUID(),
    actor,
    claimId: claim.id,
    state: "proposed",
    reason: "Evaluate this exact document-backed proposal.",
  });
  const proposal = await createKnowledgeChangeProposal(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    operationId: crypto.randomUUID(),
    actor,
    claimId: claim.id,
    evidenceId: evidence.id,
    targetKind: "instruction_policy",
    targetScope: "global",
    targetKey: null,
    content: "Use the exact document-backed activation process.",
  });
  await withSessionRlsActorContext(
    { subjectId: f.ownerSubjectId, initiatingHumanSubjectId: f.ownerSubjectId },
    async () =>
      await createWorkspaceInstructionPolicyKnowledgeProposal(client!.db, {
        operationId: crypto.randomUUID(),
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        kind: "policy",
        scope: "global",
        roleKey: null,
        content: "Use the exact document-backed activation process.",
        knowledgeProposalId: proposal.id,
        knowledgeProposalContentHash: proposal.contentHash,
        confidenceBps: 9_000,
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        createdBySubjectId: f.ownerSubjectId,
      }),
  );
  const receipt = await evaluateGovernedLearningProposal(client!.db, {
    attempt: {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      sessionId: f.session.id,
      turnId: f.writerAttempt.turnId,
      attemptId: f.writerAttempt.attemptId,
      executionGeneration: 1,
    },
    request: {
      operationId: crypto.randomUUID(),
      policySnapshotId: f.snapshot.id,
      proposalId: proposal.id,
      claimId: claim.id,
      evidenceId: evidence.id,
    },
  });
  expect(receipt).toMatchObject({
    automaticEligible: true,
    sourceKind: "scoped-knowledge-evidence",
  });
  return { receipt, source, scope, actor };
}

describe("governed-learning activation PostgreSQL authority", () => {
  test("activates and exactly undoes a preference with convergent replay", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const d = await decision(f, "preference");
    const request = { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id };
    const [activation, replay] = await Promise.all([
      activateGovernedLearningDecision(client.db, { caller: f.caller, request }),
      activateGovernedLearningDecision(client.db, { caller: f.caller, request }),
    ]);
    expect(replay).toEqual(activation);
    expect(activation).toMatchObject({
      destination: "preference",
      outcome: "activated",
      initiatingHumanSubjectId: f.ownerSubjectId,
      destinationOldRevisionId: null,
      destinationNewVersion: 1,
    });
    expect(activation.serviceActorSubjectId).not.toBe(f.ownerSubjectId);
    await expect(
      activateGovernedLearningDecision(client.db, {
        caller: f.caller,
        request: { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id },
      }),
    ).rejects.toThrow("conflicted");
    const undoRequest = { operationId: crypto.randomUUID(), activationReceiptId: activation.id };
    const undo = await undoGovernedLearningActivation(client.db, {
      caller: f.caller,
      request: undoRequest,
    });
    expect(
      await undoGovernedLearningActivation(client.db, { caller: f.caller, request: undoRequest }),
    ).toEqual(undo);
    expect(undo).toMatchObject({
      outcome: "undone",
      destination: "preference",
      destinationRestoredRevisionId: null,
      destinationOldVersion: 1,
      destinationNewVersion: 2,
      superseded: false,
    });
    expect(
      await listGovernedLearningActivationHistory(client.db, {
        workspaceId: f.grant.workspaceId,
        subjectId: f.ownerSubjectId,
        principalKind: "human_session",
        limit: 10,
      }),
    ).toMatchObject({
      activations: [{ id: activation.id }],
      undos: [{ id: undo.id, activationReceiptId: activation.id }],
      truncated: false,
    });
  });

  test("keeps a monotonic null instruction-policy boundary and reactivates with exact CAS", async () => {
    if (!shared || !client) return;
    const db = client.db;
    const admin = shared.admin;
    const f = await fixture();
    const d = await decision(f, "instruction_policy");
    const activation = await activateGovernedLearningDecision(client.db, {
      caller: f.caller,
      request: { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id },
    });
    expect(activation).toMatchObject({
      destination: "instruction_policy",
      destinationOldRevisionId: null,
      destinationOldVersion: 0,
      destinationNewVersion: 1,
    });
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
            await sql`select set_config('opengeni.governed_learning_deactivation_operation', ${crypto.randomUUID()}, true)`;
            await sql`
              delete from workspace_instruction_policy_heads
              where workspace_id = ${f.grant.workspaceId}
                and kind = 'policy' and scope = 'global'
            `;
          }),
        "42501",
      );
    } finally {
      await app.end();
    }
    const undo = await undoGovernedLearningActivation(client.db, {
      caller: f.caller,
      request: { operationId: crypto.randomUUID(), activationReceiptId: activation.id },
    });
    expect(undo).toMatchObject({
      destinationRestoredRevisionId: null,
      destinationOldVersion: 1,
      destinationNewVersion: 2,
    });
    const [legacyVisibleHeads, event, entries] = await Promise.all([
      admin<Array<{ revision_id: string; activation_version: number }>>`
        select revision_id, activation_version::int as activation_version
        from workspace_instruction_policy_heads
        where workspace_id = ${f.grant.workspaceId} and kind = 'policy' and scope = 'global'
      `,
      admin<Array<{ type: string; new_revision_id: string | null }>>`
        select type, null::uuid as new_revision_id
        from workspace_instruction_policy_deactivation_events
        where id = ${undo.destinationEventId}
      `,
      admin<Array<{ entries: unknown[] }>>`
        select workspace_instruction_policy_canonical_snapshot_entries(
          ${f.grant.accountId}::uuid, ${f.grant.workspaceId}::uuid, null,
          clock_timestamp() + interval '1 second'
        ) as entries
      `,
    ]);
    // This is the exact predecessor list/read query: a rolling-old binary sees
    // no active head, never a nullable row that violates its required contract.
    expect(legacyVisibleHeads).toHaveLength(0);
    expect(event[0]).toEqual({ type: "automatic_deactivate", new_revision_id: null });
    expect(entries[0]?.entries).toEqual([]);

    const legacyDraft = await createWorkspaceInstructionPolicyDraft(db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "A rolling-old writer must not reactivate from a lost generation.",
      provenanceSource: "human",
      provenanceSourceId: null,
      supersedesRevisionId: null,
      createdBySubjectId: f.ownerSubjectId,
    });
    await expectSqlState(
      () => admin`
        insert into workspace_instruction_policy_activation_events (
          operation_id, request_fingerprint, account_id, workspace_id,
          kind, scope, role_key, type, activation_version,
          old_revision_id, old_revision, old_content_hash,
          new_revision_id, new_revision, new_content_hash,
          actor_subject_id, reason
        ) values (
          ${crypto.randomUUID()}::uuid, ${"e".repeat(64)}, ${f.grant.accountId}::uuid,
          ${f.grant.workspaceId}::uuid, 'policy', 'global', null, 'activate', 1,
          null, null, null, ${legacyDraft.id}::uuid, ${legacyDraft.revision},
          ${legacyDraft.contentHash}, ${f.ownerSubjectId},
          'Simulated pre-0269 changeActiveRevision without an activation-version expectation.'
        )
      `,
      "23505",
    );
    const [headCountAfterLegacyWrite] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from workspace_instruction_policy_heads
      where workspace_id = ${f.grant.workspaceId} and kind = 'policy' and scope = 'global'
    `;
    expect(headCountAfterLegacyWrite?.count).toBe(0);

    const nextAutomaticDecision = await decision(
      f,
      "instruction_policy",
      { kind: "policy", scope: "global", roleKey: null },
      2,
    );
    const nextAutomaticActivation = await activateGovernedLearningDecision(db, {
      caller: f.caller,
      request: {
        operationId: crypto.randomUUID(),
        decisionReceiptId: nextAutomaticDecision.receipt.id,
      },
    });
    expect(nextAutomaticActivation).toMatchObject({
      destination: "instruction_policy",
      destinationOldRevisionId: null,
      destinationOldVersion: 2,
      destinationNewVersion: 3,
    });
    const nextAutomaticUndo = await undoGovernedLearningActivation(db, {
      caller: f.caller,
      request: {
        operationId: crypto.randomUUID(),
        activationReceiptId: nextAutomaticActivation.id,
      },
    });
    expect(nextAutomaticUndo).toMatchObject({
      destinationRestoredRevisionId: null,
      destinationOldVersion: 3,
      destinationNewVersion: 4,
    });

    const unrelatedDecision = await decision(f, "instruction_policy", {
      kind: "policy",
      scope: "role",
      roleKey: `overflow-${crypto.randomUUID().slice(0, 8)}`,
    });
    const unrelatedActivation = await activateGovernedLearningDecision(db, {
      caller: f.caller,
      request: {
        operationId: crypto.randomUUID(),
        decisionReceiptId: unrelatedDecision.receipt.id,
      },
    });
    const unrelatedUndo = await undoGovernedLearningActivation(db, {
      caller: f.caller,
      request: { operationId: crypto.randomUUID(), activationReceiptId: unrelatedActivation.id },
    });
    const boundedGlobal = await listWorkspaceInstructionPolicyRevisions(db, f.grant.workspaceId, {
      kind: "policy",
      scope: "global",
      roleKey: null,
      limit: 1,
    });
    expect(boundedGlobal.deactivationEvents[0]?.id).toBe(unrelatedUndo.destinationEventId);
    expect(boundedGlobal.inactiveHeads).toEqual([
      expect.objectContaining({
        kind: "policy",
        scope: "global",
        roleKey: null,
        activationVersion: 4,
      }),
    ]);
    expect(boundedGlobal.inactiveHeadsTruncated).toBe(false);

    const drafts = await Promise.all(
      ["First human reactivation.", "Concurrent human reactivation."].map((content) =>
        createWorkspaceInstructionPolicyDraft(db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          kind: "policy",
          scope: "global",
          roleKey: null,
          content,
          provenanceSource: "human",
          provenanceSourceId: null,
          supersedesRevisionId: null,
          createdBySubjectId: f.ownerSubjectId,
        }),
      ),
    );
    const firstHuman = drafts[0]!;
    await expect(
      activateWorkspaceInstructionPolicyRevision(db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        revisionId: firstHuman.id,
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        actorSubjectId: f.ownerSubjectId,
        reason: "A stale never-active CAS must not erase the tombstone generation.",
      }),
    ).rejects.toThrow("changed in another request");

    const reactivations = await Promise.allSettled(
      drafts.map((draft) =>
        activateWorkspaceInstructionPolicyRevision(db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          revisionId: draft.id,
          expectedCurrentRevisionId: null,
          expectedActivationVersion: 4,
          actorSubjectId: f.ownerSubjectId,
          reason: "Reactivate from the exact durable inactive boundary.",
        }),
      ),
    );
    expect(reactivations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(reactivations.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = reactivations.find((result) => result.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("missing reactivation winner");
    expect(winner.value.head.activationVersion).toBe(5);
    expect(winner.value.event.oldRevision).toBeNull();
    const [reactivatedEntries] = await admin<Array<{ entries: unknown[] }>>`
      select workspace_instruction_policy_canonical_snapshot_entries(
        ${f.grant.accountId}::uuid, ${f.grant.workspaceId}::uuid, null,
        clock_timestamp() + interval '1 second'
      ) as entries
    `;
    expect(reactivatedEntries?.entries).toHaveLength(1);
  }, 15_000);

  test("denies stale destination CAS, cross-subject reuse, and direct receipt DML", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const d = await decision(f, "instruction_policy");
    const competing = await createWorkspaceInstructionPolicyDraft(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "Competing human policy.",
      provenanceSource: "human",
      provenanceSourceId: null,
      supersedesRevisionId: null,
      createdBySubjectId: f.ownerSubjectId,
    });
    await activateWorkspaceInstructionPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      revisionId: competing.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: f.ownerSubjectId,
      reason: "Race the automatic destination CAS.",
    });
    await expect(
      activateGovernedLearningDecision(client.db, {
        caller: f.caller,
        request: { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id },
      }),
    ).rejects.toThrow("conflicted");
    await expect(
      activateGovernedLearningDecision(client.db, {
        caller: { ...f.caller, subjectId: `user:other-${crypto.randomUUID()}` },
        request: { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id },
      }),
    ).rejects.toThrow("unavailable");
    const otherTenant = await fixture();
    await expect(
      activateGovernedLearningDecision(client.db, {
        caller: otherTenant.caller,
        request: { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id },
      }),
    ).rejects.toThrow("unavailable");
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        () => app`select id from governed_learning_activation_receipts`,
        "42501",
      );
      await expectSqlState(
        () =>
          app`insert into governed_learning_activation_receipts (id) values (${crypto.randomUUID()})`,
        "42501",
      );
    } finally {
      await app.end();
    }
  });

  test("rechecks source revocation and a changed learning-policy head", async () => {
    if (!client) return;
    const revokedFixture = await fixture();
    const revoked = await decision(revokedFixture, "preference");
    await archiveTaskNote(client.db, {
      ...revokedFixture.writerAttempt,
      operationId: crypto.randomUUID(),
      noteId: revoked.write.taskNoteSource!.noteId,
      expectedVersion: 1,
      reason: "Revoke the evaluated source before activation.",
    });
    await expect(
      activateGovernedLearningDecision(client.db, {
        caller: revokedFixture.caller,
        request: { operationId: crypto.randomUUID(), decisionReceiptId: revoked.receipt.id },
      }),
    ).rejects.toThrow("unavailable");

    const policyFixture = await fixture();
    const changed = await decision(policyFixture, "preference");
    const nextPolicy = await createWorkspaceLearningPolicyRevision(client.db, {
      accountId: policyFixture.grant.accountId,
      workspaceId: policyFixture.grant.workspaceId,
      workspaceMode: "suggest",
      supersedesRevisionId: changed.receipt.policyRevisionId,
      actorSubjectId: policyFixture.ownerSubjectId,
      principalKind: "human_session",
    });
    await activateWorkspaceLearningPolicyRevision(client.db, {
      accountId: policyFixture.grant.accountId,
      workspaceId: policyFixture.grant.workspaceId,
      revisionId: nextPolicy.id,
      expectedCurrentRevisionId: changed.receipt.policyRevisionId,
      expectedActivationVersion: changed.receipt.policyActivationVersion,
      actorSubjectId: policyFixture.ownerSubjectId,
      principalKind: "human_session",
      reason: "Disable automatic activation after evaluation.",
    });
    await expect(
      activateGovernedLearningDecision(client.db, {
        caller: policyFixture.caller,
        request: { operationId: crypto.randomUUID(), decisionReceiptId: changed.receipt.id },
      }),
    ).rejects.toThrow("conflicted");
  });

  test("rechecks the current Document ACL after a final automatic verdict", async () => {
    if (!client) return;
    const f = await fixture();
    const d = await documentDecision(f);
    await deauthorizeKnowledgeSourceRetrieval(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      operationId: crypto.randomUUID(),
      actor: d.actor,
      sourceId: d.source.id,
      audience: d.scope,
      reasonCode: "activation-acl-revoked",
    });
    await expect(
      activateGovernedLearningDecision(client.db, {
        caller: f.caller,
        request: { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id },
      }),
    ).rejects.toThrow("unavailable");
  });

  test("denies undo after a human supersedes the automatic destination head", async () => {
    if (!client) return;
    const f = await fixture();
    const d = await decision(f, "instruction_policy");
    const activation = await activateGovernedLearningDecision(client.db, {
      caller: f.caller,
      request: { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id },
    });
    const competing = await createWorkspaceInstructionPolicyDraft(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "A newer human-authorized policy.",
      provenanceSource: "human",
      provenanceSourceId: null,
      supersedesRevisionId: activation.destinationRevisionId,
      createdBySubjectId: f.ownerSubjectId,
    });
    await activateWorkspaceInstructionPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      revisionId: competing.id,
      expectedCurrentRevisionId: activation.destinationRevisionId,
      expectedActivationVersion: activation.destinationNewVersion,
      actorSubjectId: f.ownerSubjectId,
      reason: "Supersede the automatic head before undo.",
    });
    await expect(
      undoGovernedLearningActivation(client.db, {
        caller: f.caller,
        request: { operationId: crypto.randomUUID(), activationReceiptId: activation.id },
      }),
    ).rejects.toThrow("conflicted");
  });

  test("ignores TEMP shadows at the app-role capability boundary", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const d = await decision(f, "preference");
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      const [row] = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
        await sql.unsafe("create temporary table knowledge_claims (trap text) on commit drop");
        await sql.unsafe(
          "create temporary table governed_learning_activation_receipts (trap text) on commit drop",
        );
        return await sql<Array<{ destination: string }>>`
          select destination from activate_governed_learning_decision(
            ${f.grant.accountId}::uuid, ${f.grant.workspaceId}::uuid,
            ${crypto.randomUUID()}::uuid, ${d.receipt.id}::uuid
          )
        `;
      });
      expect(row?.destination).toBe("preference");
    } finally {
      await app.end();
    }
  });

  test("denies a runtime caller that spoofs the service-review GUCs", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const d = await decision(f, "preference");
    const [review] = await shared.admin<
      Array<{
        id: string;
        claim_id: string;
        review_revision: number;
        scope_key: string;
      }>
    >`
      select id, claim_id, review_revision, scope_key
      from knowledge_claim_reviews
      where account_id = ${f.grant.accountId} and claim_id = ${d.write.claimId}
      order by review_revision desc limit 1
    `;
    if (!review) throw new Error("missing proposed review");
    const operationId = crypto.randomUUID();
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
            await sql`select set_config('opengeni.governed_learning_review_operation', ${operationId}, true)`;
            await sql`select set_config('opengeni.governed_learning_review_claim', ${review.claim_id}, true)`;
            await sql`
              insert into knowledge_claim_reviews (
                account_id, scope_kind, scope_workspace_id, scope_subject_id,
                scope_key, claim_id, state, reason, operation_id, input_hash,
                actor_kind, actor_subject_id, initiating_human_subject_id
              ) values (
                ${f.grant.accountId}, 'workspace', ${f.grant.workspaceId}, null,
                ${review.scope_key}, ${review.claim_id}, 'approved',
                'Spoofed automatic activation.', ${operationId}, ${"a".repeat(64)},
                'service', ${`service:governed-learning-activation:${operationId}`},
                ${f.ownerSubjectId}
              )
            `;
          }),
        "42501",
      );
    } finally {
      await app.end();
    }
  });
  test("human confirmation survives the human-input resume onto a new attempt of the same turn", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const d = await decision(f, "preference");
    const answered = await answeredRememberInput(f, d.write.knowledgeChangeProposalId!, d.noteText);
    // Simulate the worker closing the minting attempt for human input and
    // claiming a new attempt on the same turn and execution generation.
    const resumedAttemptId = crypto.randomUUID();
    await shared.admin.begin(async (sql) => {
      await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
      await sql`update session_turn_attempts set state = 'closed', outcome = 'interrupted_recoverable',
        closed_at = now() where workspace_id = ${f.grant.workspaceId} and id = ${f.writerAttempt.attemptId}`;
      await sql`update session_turns set active_attempt_id = ${resumedAttemptId}, status = 'running'
        where workspace_id = ${f.grant.workspaceId} and id = ${f.writerAttempt.turnId}`;
      await sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id,
          temporal_activity_id, verified_control_revision, authority_epoch,
          authority_visibility, authority_owner_organization_membership_id,
          mcp_approval_policies
        ) values (
          ${resumedAttemptId}, ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id},
          ${f.writerAttempt.turnId}, 1, 'running', ${`activation-${f.writerAttempt.turnId}`},
          ${`run-${resumedAttemptId}`}, ${`activity-${resumedAttemptId}`}, 0,
          (select authority_epoch from sessions where id = ${f.session.id}),
          (select visibility from sessions where id = ${f.session.id}),
          (select owner_organization_membership_id from sessions where id = ${f.session.id}),
          '{}'::jsonb
        )
      `;
    });
    // The automatic controller still requires the exact minting attempt.
    const activation = await activateHumanConfirmedLearningDecision(client.db, {
      caller: f.caller,
      request: {
        operationId: crypto.randomUUID(),
        decisionReceiptId: d.receipt.id,
        humanInputRequestId: answered,
      },
    });
    expect(activation).toMatchObject({
      authorityKind: "human_confirmed",
      humanInputRequestId: answered,
      destination: "preference",
    });
  });

  test("activates a suggest-mode preference only with the exact human's bound `save` answer", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const d = await decision(f, "preference");
    expect(d.receipt.outcome).toBe("suggest");
    const proposalId = d.write.knowledgeChangeProposalId!;
    // The automatic controller refuses a non-final receipt.
    await expect(
      activateGovernedLearningDecision(client.db, {
        caller: f.caller,
        request: { operationId: crypto.randomUUID(), decisionReceiptId: d.receipt.id },
      }),
    ).rejects.toThrow();

    const wrongSubject = await answeredRememberInput(f, proposalId, d.noteText, {
      respondedBy: "user:someone-else",
    });
    const skipped = await answeredRememberInput(f, proposalId, d.noteText, { answer: ["skip"] });
    const otherProposal = await answeredRememberInput(f, proposalId, d.noteText, {
      questionId: `remember:${crypto.randomUUID()}`,
    });
    const pending = await answeredRememberInput(f, proposalId, d.noteText, { status: "pending" });
    // The human must have seen the canonical prompt, the exact content, and
    // the fixed options; a misleading agent-authored question cannot confirm.
    const misleadingPrompt = await answeredRememberInput(f, proposalId, d.noteText, {
      prompt: "Continue setup?",
    });
    const hiddenContent = await answeredRememberInput(f, proposalId, d.noteText, {
      helpText: "Nothing important.",
    });
    const relabeledOptions = await answeredRememberInput(f, proposalId, d.noteText, {
      options: [
        { id: "save", label: "Yes" },
        { id: "skip", label: "No" },
      ],
    });
    const wrongLane = await answeredRememberInput(f, proposalId, d.noteText, {
      lane: "instruction_policy",
    });
    for (const humanInputRequestId of [
      wrongSubject,
      skipped,
      otherProposal,
      pending,
      misleadingPrompt,
      hiddenContent,
      relabeledOptions,
      wrongLane,
      crypto.randomUUID(),
    ]) {
      await expect(
        activateHumanConfirmedLearningDecision(client!.db, {
          caller: f.caller,
          request: {
            operationId: crypto.randomUUID(),
            decisionReceiptId: d.receipt.id,
            humanInputRequestId,
          },
        }),
      ).rejects.toBeInstanceOf(GovernedLearningActivationAuthorityError);
    }
    // Another human's session context cannot consume the owner's answer.
    const answered = await answeredRememberInput(f, proposalId, d.noteText);
    await expect(
      activateHumanConfirmedLearningDecision(client!.db, {
        caller: { workspaceId: f.grant.workspaceId, subjectId: "user:someone-else" },
        request: {
          operationId: crypto.randomUUID(),
          decisionReceiptId: d.receipt.id,
          humanInputRequestId: answered,
        },
      }),
    ).rejects.toBeInstanceOf(GovernedLearningActivationAuthorityError);

    const request = {
      operationId: crypto.randomUUID(),
      decisionReceiptId: d.receipt.id,
      humanInputRequestId: answered,
    };
    const [activation, replay] = await Promise.all([
      activateHumanConfirmedLearningDecision(client.db, { caller: f.caller, request }),
      activateHumanConfirmedLearningDecision(client.db, { caller: f.caller, request }),
    ]);
    expect(replay).toEqual(activation);
    expect(activation).toMatchObject({
      destination: "preference",
      outcome: "activated",
      authorityKind: "human_confirmed",
      humanInputRequestId: answered,
      initiatingHumanSubjectId: f.ownerSubjectId,
      destinationNewVersion: 1,
    });
    // A second confirmation of the same decision conflicts; undo still works.
    await expect(
      activateHumanConfirmedLearningDecision(client.db, {
        caller: f.caller,
        request: { ...request, operationId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("conflicted");
    const undo = await undoGovernedLearningActivation(client.db, {
      caller: f.caller,
      request: { operationId: crypto.randomUUID(), activationReceiptId: activation.id },
    });
    expect(undo.outcome).toBe("undone");
    expect(
      await listGovernedLearningActivationHistory(client.db, {
        workspaceId: f.grant.workspaceId,
        subjectId: f.ownerSubjectId,
        principalKind: "human_session",
        limit: 10,
      }),
    ).toMatchObject({
      activations: [{ id: activation.id, authorityKind: "human_confirmed" }],
      undos: [{ id: undo.id }],
    });
  });

  test("human confirmation survives the human-input resume onto the next execution generation", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const d = await decision(f, "preference");
    // The bound question was asked and answered at execution generation 1.
    const answered = await answeredRememberInput(f, d.write.knowledgeChangeProposalId!, d.noteText);
    // Resuming the requires_action turn claims a new attempt at generation 2.
    const resumed = await resumeTurnOntoNextGeneration(f, {
      closedAttemptId: f.writerAttempt.attemptId,
      nextGeneration: 2,
    });
    expect(resumed.executionGeneration).toBe(2);
    const activation = await activateHumanConfirmedLearningDecision(client.db, {
      caller: f.caller,
      request: {
        operationId: crypto.randomUUID(),
        decisionReceiptId: d.receipt.id,
        humanInputRequestId: answered,
      },
    });
    expect(activation).toMatchObject({
      authorityKind: "human_confirmed",
      humanInputRequestId: answered,
      destination: "preference",
      outcome: "activated",
    });
    // The answered row itself may carry a later generation of the same turn:
    // a recovery re-claim between `remember` and the pause, or a different
    // interruption answered first, re-freezes the pending row under the next
    // generation. It still confirms the gen-1 decision on this turn.
    const f2 = await fixture("suggest");
    const d2 = await decision(f2, "preference");
    const resumedAnswer = await answeredRememberInput(
      f2,
      d2.write.knowledgeChangeProposalId!,
      d2.noteText,
      { turnGeneration: 2 },
    );
    await resumeTurnOntoNextGeneration(f2, {
      closedAttemptId: f2.writerAttempt.attemptId,
      nextGeneration: 2,
    });
    const laterRowActivation = await activateHumanConfirmedLearningDecision(client.db, {
      caller: f2.caller,
      request: {
        operationId: crypto.randomUUID(),
        decisionReceiptId: d2.receipt.id,
        humanInputRequestId: resumedAnswer,
      },
    });
    expect(laterRowActivation).toMatchObject({
      authorityKind: "human_confirmed",
      humanInputRequestId: resumedAnswer,
      destination: "preference",
      outcome: "activated",
    });
  });

  test("human confirmation never widens to a different logical turn", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const d = await decision(f, "preference");
    const answered = await answeredRememberInput(f, d.write.knowledgeChangeProposalId!, d.noteText);
    // A later turn of the same session is live at a higher generation; the
    // decision and its answer belong to the earlier turn.
    const otherTurnId = await activateDifferentTurn(f);
    expect(otherTurnId).not.toBe(f.writerAttempt.turnId);
    await expect(
      activateHumanConfirmedLearningDecision(client.db, {
        caller: f.caller,
        request: {
          operationId: crypto.randomUUID(),
          decisionReceiptId: d.receipt.id,
          humanInputRequestId: answered,
        },
      }),
    ).rejects.toBeInstanceOf(GovernedLearningActivationAuthorityError);
  });

  test("knowledge-claim confirmation survives the human-input resume onto the next execution generation", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const noteText = `Knowledge source ${crypto.randomUUID()}`;
    const note = await createTaskNote(client.db, {
      ...f.writerAttempt,
      operationId: crypto.randomUUID(),
      kind: "decision",
      text: noteText,
      expiresInDays: 7,
    });
    const write = await writeCompanyBrainGovernedProposal(client.db, {
      attempt: f.writerAttempt,
      request: {
        operationId: crypto.randomUUID(),
        noteId: note.note.id,
        expectedNoteVersion: 1 as const,
        kind: "promote_task_note_knowledge" as const,
        entityType: "user-directed",
        normalizedKey: crypto.randomUUID(),
        displayName: "Knowledge fixture",
        predicateKey: "remember.fact",
        confidenceBps: 10_000,
        reason: "Create an exact user-directed Knowledge claim awaiting confirmation.",
      },
    });
    expect(write.knowledgeChangeProposalId).toBeNull();
    const claimId = write.claimId;
    const knowledgeQuestion = {
      questionId: `remember:${claimId}`,
      prompt: "Save this as workspace knowledge for everyone in this workspace?",
    };
    // Asked and answered at generation 1, then resumed onto generation 2.
    const answered = await answeredRememberInput(f, claimId, noteText, knowledgeQuestion);
    const laterThanLive = await answeredRememberInput(f, claimId, noteText, {
      ...knowledgeQuestion,
      turnGeneration: 3,
    });
    const resumed = await resumeTurnOntoNextGeneration(f, {
      closedAttemptId: f.writerAttempt.attemptId,
      nextGeneration: 2,
    });
    const liveCaller = {
      ...f.caller,
      sessionId: f.session.id,
      turnId: f.writerAttempt.turnId,
      executionGeneration: resumed.executionGeneration,
    };
    // The live turn/attempt generation stays exact: the minting generation no
    // longer describes the live attempt.
    await expect(
      confirmRememberKnowledgeClaim(client.db, {
        caller: { ...liveCaller, executionGeneration: 1 },
        request: {
          operationId: crypto.randomUUID(),
          claimId,
          humanInputRequestId: answered,
        },
      }),
    ).rejects.toBeInstanceOf(GovernedLearningActivationAuthorityError);
    // An answer stamped beyond the live generation cannot confirm.
    await expect(
      confirmRememberKnowledgeClaim(client.db, {
        caller: liveCaller,
        request: {
          operationId: crypto.randomUUID(),
          claimId,
          humanInputRequestId: laterThanLive,
        },
      }),
    ).rejects.toBeInstanceOf(GovernedLearningActivationAuthorityError);
    const receipt = await confirmRememberKnowledgeClaim(client.db, {
      caller: liveCaller,
      request: {
        operationId: crypto.randomUUID(),
        claimId,
        humanInputRequestId: answered,
      },
    });
    expect(receipt).toMatchObject({
      claimId,
      humanInputRequestId: answered,
      executionGeneration: 2,
      initiatingHumanSubjectId: f.ownerSubjectId,
      taskNoteId: note.note.id,
    });
  });
});
