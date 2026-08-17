import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  activateWorkspaceLearningPolicyRevision,
  createDb,
  createSession,
  createTaskNote,
  createWorkspaceLearningPolicyRevision,
  ensureManagedAccessForUser,
  listGovernedLearningActivationHistory,
  listGovernedLearningDecisionReceipts,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createCompanyBrainLearningPolicyRouter } from "../src/domain/company-brain-governed-writes";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-company-brain-learning-router");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL is unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture(mode: "suggest" | "automatic") {
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

async function noteRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  destination: "preference" | "knowledge" | "instruction_policy",
) {
  const note = await createTaskNote(client!.db, {
    ...f.attempt,
    operationId: crypto.randomUUID(),
    kind: "decision",
    text: `Router source ${crypto.randomUUID()}`,
    expiresInDays: 7,
  });
  const common = {
    operationId: crypto.randomUUID(),
    noteId: note.note.id,
    expectedNoteVersion: 1 as const,
    entityType: "ways-of-working",
    normalizedKey: crypto.randomUUID(),
    displayName: "Router fixture",
    predicateKey: "ways.router-fixture",
    confidenceBps: 9_000,
    reason: "Route the exact note through the frozen learning policy.",
  };
  return destination === "preference"
    ? {
        ...common,
        kind: "promote_task_note_preference" as const,
        stableKey: `router.${crypto.randomUUID().replaceAll("-", "")}`,
        title: "Router fixture",
        description: "A governed learning router fixture.",
        precedenceRank: 0,
        conflictStrategy: "override" as const,
        conflictsWith: [],
        expiresAt: null,
      }
    : destination === "instruction_policy"
      ? {
          ...common,
          kind: "promote_task_note_instruction_policy" as const,
          target: { kind: "policy" as const, scope: "global" as const, roleKey: null },
          expectedCurrentRevisionId: null,
          expectedActivationVersion: 0,
        }
      : { ...common, kind: "promote_task_note_knowledge" as const };
}

describe("Company Brain learning-policy router (real PostgreSQL)", () => {
  test("automatic evaluates and activates a preference through the destination lifecycle, with convergent replay", async () => {
    if (!shared || !client) return;
    const f = await fixture("automatic");
    const router = createCompanyBrainLearningPolicyRouter({ db: client.db });
    const request = await noteRequest(f, "preference");
    const first = await router.write({ attempt: f.attempt, request });
    expect(first.decision).toBe("activated");
    expect(first.learning).toMatchObject({ outcome: "automatic", automaticEligible: true });
    expect(first.learningFailure).toBeNull();
    expect(first.activation).toMatchObject({
      requested: true,
      activated: true,
      boundary: "activated",
      destination: "preference",
    });
    expect(first.activation.receiptId).not.toBeNull();
    expect(first.activation.destinationRevisionId).not.toBeNull();

    // An exact retry of the same operation converges on the same receipts.
    const replay = await router.write({ attempt: f.attempt, request });
    expect(replay).toEqual(first);

    const history = await listGovernedLearningActivationHistory(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      principalKind: "human_session",
      limit: 10,
    });
    expect(history.activations.map((row) => row.id)).toEqual([first.activation.receiptId!]);
    expect(history.activations[0]).toMatchObject({
      decisionReceiptId: first.learning!.receiptId,
      initiatingHumanSubjectId: f.ownerSubjectId,
      destination: "preference",
      destinationRevisionId: first.activation.destinationRevisionId,
    });
  }, 180_000);

  test("suggest records the decision receipt and leaves the proposal for human review", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const router = createCompanyBrainLearningPolicyRouter({ db: client.db });
    const result = await router.write({
      attempt: f.attempt,
      request: await noteRequest(f, "preference"),
    });
    expect(result.decision).toBe("proposal_created");
    expect(result.learning).toMatchObject({
      outcome: "suggest",
      automaticEligible: false,
      reasons: ["policy_suggest"],
    });
    expect(result.activation).toMatchObject({
      requested: false,
      activated: false,
      boundary: "human_review",
      receiptId: null,
    });
    const decisions = await listGovernedLearningDecisionReceipts(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      principalKind: "human_session",
      limit: 10,
    });
    expect(decisions.receipts.map((row) => row.id)).toEqual([result.learning!.receiptId]);
    const history = await listGovernedLearningActivationHistory(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      principalKind: "human_session",
      limit: 10,
    });
    expect(history.activations).toEqual([]);
  }, 180_000);

  test("automatic records an instruction-policy decision but leaves activation to a human", async () => {
    if (!shared || !client) return;
    const f = await fixture("automatic");
    const router = createCompanyBrainLearningPolicyRouter({ db: client.db });
    const result = await router.write({
      attempt: f.attempt,
      request: await noteRequest(f, "instruction_policy"),
    });
    expect(result.decision).toBe("activation_requested");
    expect(result.write?.destination).toBe("instruction_policy");
    expect(result.learning).toMatchObject({ outcome: "automatic", automaticEligible: true });
    expect(result.activation).toMatchObject({
      requested: true,
      activated: false,
      boundary: "human_activation_required",
      receiptId: null,
    });
    const history = await listGovernedLearningActivationHistory(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      principalKind: "human_session",
      limit: 10,
    });
    expect(history.activations).toEqual([]);
  }, 180_000);

  test("Knowledge promotions are proposal-only even under automatic", async () => {
    if (!shared || !client) return;
    const f = await fixture("automatic");
    const router = createCompanyBrainLearningPolicyRouter({ db: client.db });
    const result = await router.write({
      attempt: f.attempt,
      request: await noteRequest(f, "knowledge"),
    });
    expect(result.decision).toBe("activation_requested");
    expect(result.write?.destination).toBe("knowledge");
    expect(result.write?.knowledgeChangeProposalId).toBeNull();
    expect(result.learning).toBeNull();
    expect(result.learningFailure).toBeNull();
    expect(result.activation.activated).toBe(false);
    const decisions = await listGovernedLearningDecisionReceipts(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      principalKind: "human_session",
      limit: 10,
    });
    expect(decisions.receipts).toEqual([]);
  }, 180_000);
});
