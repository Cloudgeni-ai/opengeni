import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  activateWorkspaceLearningPolicyRevision,
  appendKnowledgeClaimReview,
  archiveTaskNote,
  createDb,
  createSession,
  createTaskNote,
  createWorkspaceLearningPolicyRevision,
  ensureManagedAccessForUser,
  evaluateGovernedLearningProposal,
  getOrCreateWorkspaceLearningPolicySnapshot,
  linkKnowledgeClaims,
  listGovernedLearningDecisionReceipts,
  nestedPostgresSqlState,
  writeCompanyBrainGovernedProposal,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("governed-learning-evaluator-postgres");
  if (!shared && requireRealDatabase) {
    throw new Error("[governed-learning-evaluator-postgres] PostgreSQL is unavailable");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
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

async function fixture(workspaceMode: "suggest" | "automatic" = "automatic") {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `learning-evaluator-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Governed learning evaluator owner",
  });
  const grant = access.workspaceGrants[0]!;
  const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "evaluate governed learning",
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
  const revision = await createWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    workspaceMode,
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
    reason: "Exercise the inert evaluator.",
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
        ${crypto.randomUUID()}, ${`learning-${turnId}`}, 'running', 'user', 1,
        'evaluate', 'test-model', 'medium', 'none', 1, 'subject',
        ${ownerSubjectId}, '{}'::jsonb, ${ownerSubjectId}
      )
    `;
    await sql`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${grant.workspaceId} and id = ${session.id}
    `;
    await sql`
      update session_turns set active_attempt_id = ${attemptId}
      where workspace_id = ${grant.workspaceId} and id = ${turnId}
    `;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
        ${turnId}, 1, 'running', ${`learning-${turnId}`}, ${`run-${attemptId}`},
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
  const evaluatorAttempt = {
    workspaceId: grant.workspaceId,
    subjectId: ownerSubjectId,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
  const snapshot = await getOrCreateWorkspaceLearningPolicySnapshot(client.db, writerAttempt);
  return { grant, ownerSubjectId, session, writerAttempt, evaluatorAttempt, snapshot };
}

async function proposal(f: Awaited<ReturnType<typeof fixture>>, confidenceBps = 9_000) {
  const note = await createTaskNote(client!.db, {
    ...f.writerAttempt,
    operationId: crypto.randomUUID(),
    kind: "decision",
    text: `Bounded evaluator source ${crypto.randomUUID()}`,
    expiresInDays: 7,
  });
  const write = await writeCompanyBrainGovernedProposal(client!.db, {
    attempt: f.writerAttempt,
    request: {
      kind: "promote_task_note_preference",
      operationId: crypto.randomUUID(),
      noteId: note.note.id,
      expectedNoteVersion: 1,
      entityType: "ways-of-working",
      normalizedKey: crypto.randomUUID(),
      displayName: "Governed evaluator fixture",
      predicateKey: "ways.evaluator-fixture",
      confidenceBps,
      stableKey: `evaluator.${crypto.randomUUID().replaceAll("-", "")}`,
      title: "Evaluator fixture",
      description: "An inert evaluator fixture.",
      precedenceRank: 0,
      conflictStrategy: "override",
      conflictsWith: [],
      expiresAt: null,
      reason: "Create reviewable evidence without activation.",
    },
  });
  if (!write.knowledgeChangeProposalId) throw new Error("missing Knowledge proposal lineage");
  return {
    note,
    destinationProposalId: write.destinationProposalId,
    request: {
      operationId: crypto.randomUUID(),
      policySnapshotId: f.snapshot.id,
      proposalId: write.knowledgeChangeProposalId,
      claimId: write.claimId,
      evidenceId: write.evidenceId,
    },
  };
}

describe("governed-learning evaluator PostgreSQL authority", () => {
  test("preserves a frozen suggest policy as a non-automatic verdict", async () => {
    if (!client) return;
    const f = await fixture("suggest");
    const p = await proposal(f);
    const receipt = await evaluateGovernedLearningProposal(client.db, {
      attempt: f.evaluatorAttempt,
      request: p.request,
    });
    expect(receipt).toMatchObject({
      outcome: "suggest",
      reasons: ["policy_suggest"],
      automaticEligible: false,
    });
    const history = await listGovernedLearningDecisionReceipts(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      principalKind: "human_session",
      limit: 10,
    });
    expect(history).toMatchObject({ receipts: [{ id: receipt.id }], truncated: false });
    await expect(
      listGovernedLearningDecisionReceipts(client.db, {
        workspaceId: f.grant.workspaceId,
        subjectId: f.ownerSubjectId,
        principalKind: "service",
        limit: 10,
      }),
    ).rejects.toThrow(/authenticated human/i);
    const otherSubject = await listGovernedLearningDecisionReceipts(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: `user:other-${crypto.randomUUID()}`,
      principalKind: "human_session",
      limit: 10,
    });
    expect(otherSubject.receipts).toEqual([]);
  });

  test("converges exact concurrent replay, denies changed input, and never activates a destination", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const p = await proposal(f);
    const [first, replay] = await Promise.all([
      evaluateGovernedLearningProposal(client.db, {
        attempt: f.evaluatorAttempt,
        request: p.request,
      }),
      evaluateGovernedLearningProposal(client.db, {
        attempt: f.evaluatorAttempt,
        request: p.request,
      }),
    ]);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      sourceKind: "task-note",
      sourceId: p.note.note.id,
      outcome: "automatic",
      reasons: ["policy_automatic"],
      automaticEligible: true,
    });
    await expect(
      evaluateGovernedLearningProposal(client.db, {
        attempt: f.evaluatorAttempt,
        request: { ...p.request, claimId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("conflicted");
    const [activePreference] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from preference_registry_events where type = 'activated'
        and preference_id = ${p.destinationProposalId}
    `;
    expect(activePreference?.count).toBe(0);
  });

  test("derives current confidence, conflict, and stale outcomes in deterministic order", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const low = await proposal(f, 8_499);
    const lowReceipt = await evaluateGovernedLearningProposal(client.db, {
      attempt: f.evaluatorAttempt,
      request: low.request,
    });
    expect(lowReceipt).toMatchObject({ outcome: "confidence", automaticEligible: false });
    expect(lowReceipt.reasons).toEqual(["confidence_below_floor", "policy_automatic"]);

    const conflicted = await proposal(f);
    const peer = await proposal(f);
    await linkKnowledgeClaims(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      operationId: crypto.randomUUID(),
      actor: {
        kind: "human",
        subjectId: f.ownerSubjectId,
        initiatingHumanSubjectId: f.ownerSubjectId,
      },
      relationType: "conflicts_with",
      fromClaimId: conflicted.request.claimId,
      toClaimId: peer.request.claimId,
    });
    const conflictReceipt = await evaluateGovernedLearningProposal(client.db, {
      attempt: f.evaluatorAttempt,
      request: conflicted.request,
    });
    expect(conflictReceipt).toMatchObject({ outcome: "conflict", conflictCount: 1 });
    expect(conflictReceipt.reasons).toEqual(["evidence_conflict", "policy_automatic"]);

    await appendKnowledgeClaimReview(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      operationId: crypto.randomUUID(),
      actor: {
        kind: "human",
        subjectId: f.ownerSubjectId,
        initiatingHumanSubjectId: f.ownerSubjectId,
      },
      claimId: peer.request.claimId,
      state: "rejected",
      reason: "Make the proposed claim stale before evaluation.",
    });
    const staleReceipt = await evaluateGovernedLearningProposal(client.db, {
      attempt: f.evaluatorAttempt,
      request: peer.request,
    });
    expect(staleReceipt).toMatchObject({ outcome: "stale", reviewState: "rejected" });
    expect(staleReceipt.reasons).toEqual([
      "proposal_stale",
      "evidence_conflict",
      "policy_automatic",
    ]);
  });

  test("rechecks revocation, fences subject/tenant, blocks direct DML, and ignores TEMP shadows", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const p = await proposal(f);
    await archiveTaskNote(client.db, {
      ...f.writerAttempt,
      operationId: crypto.randomUUID(),
      noteId: p.note.note.id,
      expectedVersion: 1,
      reason: "Revoke before evaluation.",
    });
    const receipt = await evaluateGovernedLearningProposal(client.db, {
      attempt: f.evaluatorAttempt,
      request: p.request,
    });
    expect(receipt).toMatchObject({ outcome: "revoked", automaticEligible: false });
    expect(receipt.reasons).toEqual(["evidence_revoked", "policy_automatic"]);

    await expect(
      evaluateGovernedLearningProposal(client.db, {
        attempt: { ...f.evaluatorAttempt, subjectId: `user:other-${crypto.randomUUID()}` },
        request: p.request,
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      evaluateGovernedLearningProposal(client.db, {
        attempt: { ...f.evaluatorAttempt, workspaceId: crypto.randomUUID() },
        request: p.request,
      }),
    ).rejects.toThrow();
    await expect(
      evaluateGovernedLearningProposal(client.db, {
        attempt: { ...f.evaluatorAttempt, sessionId: crypto.randomUUID() },
        request: p.request,
      }),
    ).rejects.toThrow();

    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        () => app`select id from governed_learning_decision_receipts limit 1`,
        "42501",
      );
      await expectSqlState(
        () =>
          app`insert into governed_learning_decision_receipts (id) values (${crypto.randomUUID()})`,
        "42501",
      );
      const [shadowReplay] = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
        await sql.unsafe(
          "create temporary table governed_learning_decision_receipts (trap text) on commit drop",
        );
        await sql.unsafe("create temporary table knowledge_claims (trap text) on commit drop");
        return await sql<Array<{ receipt_id: string; outcome: string }>>`
          select receipt_id, outcome from evaluate_governed_learning_proposal(
            ${f.grant.accountId}::uuid, ${f.grant.workspaceId}::uuid,
            ${f.session.id}::uuid, ${f.evaluatorAttempt.turnId}::uuid,
            ${f.evaluatorAttempt.attemptId}::uuid, 1, ${p.request.operationId}::uuid,
            ${f.snapshot.id}::uuid, ${p.request.proposalId}::uuid,
            ${p.request.claimId}::uuid, ${p.request.evidenceId}::uuid
          )
        `;
      });
      expect(shadowReplay).toEqual({ receipt_id: receipt.id, outcome: "revoked" });
    } finally {
      await app.end();
    }
  });
});
