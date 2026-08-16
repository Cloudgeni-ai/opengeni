import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  activateGovernedLearningDecision,
  activateWorkspaceInstructionPolicyRevision,
  activateWorkspaceLearningPolicyRevision,
  appendKnowledgeClaim,
  appendKnowledgeClaimEvidence,
  appendKnowledgeClaimReview,
  appendKnowledgeDocumentVersion,
  appendKnowledgeSourceAclVersion,
  archiveTaskNote,
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

async function fixture() {
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
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  const learningRevision = await createWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    workspaceMode: "automatic",
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
  return { grant, ownerSubjectId, session, writerAttempt, caller, snapshot };
}

async function decision(
  f: Awaited<ReturnType<typeof fixture>>,
  destination: "preference" | "instruction_policy",
) {
  const note = await createTaskNote(client!.db, {
    ...f.writerAttempt,
    operationId: crypto.randomUUID(),
    kind: "decision",
    text: `Activation source ${crypto.randomUUID()}`,
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
            target: { kind: "policy" as const, scope: "global" as const, roleKey: null },
            expectedCurrentRevisionId: null,
            expectedActivationVersion: 0,
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
  expect(receipt.automaticEligible).toBe(true);
  return { write, receipt };
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
  });

  test("restores a null instruction-policy head through append-only deactivation evidence", async () => {
    if (!shared || !client) return;
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
    const undo = await undoGovernedLearningActivation(client.db, {
      caller: f.caller,
      request: { operationId: crypto.randomUUID(), activationReceiptId: activation.id },
    });
    expect(undo).toMatchObject({
      destinationRestoredRevisionId: null,
      destinationOldVersion: 1,
      destinationNewVersion: 2,
    });
    const [head, event, entries] = await Promise.all([
      shared.admin<{ count: number }[]>`
        select count(*)::int as count from workspace_instruction_policy_heads
        where workspace_id = ${f.grant.workspaceId} and kind = 'policy' and scope = 'global'
      `,
      shared.admin<Array<{ type: string; new_revision_id: string | null }>>`
        select type, new_revision_id from workspace_instruction_policy_activation_events
        where id = ${undo.destinationEventId}
      `,
      shared.admin<Array<{ entries: unknown[] }>>`
        select workspace_instruction_policy_canonical_snapshot_entries(
          ${f.grant.accountId}::uuid, ${f.grant.workspaceId}::uuid, null,
          clock_timestamp() + interval '1 second'
        ) as entries
      `,
    ]);
    expect(head[0]?.count).toBe(0);
    expect(event[0]).toEqual({ type: "automatic_deactivate", new_revision_id: null });
    expect(entries[0]?.entries).toEqual([]);
  });

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
});
