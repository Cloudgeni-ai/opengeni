import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  archiveTaskNote,
  activateWorkspaceLearningPolicyRevision,
  createWorkspaceLearningPolicyRevision,
  createDb,
  createSession,
  createTaskNote,
  ensureManagedAccessForUser,
  grantWorkspaceAccess,
  getOrCreateWorkspaceLearningPolicySnapshot,
  listTaskNotes,
  nestedPostgresSqlState,
  replaceTaskNote,
  transitionSessionVisibility,
  writeCompanyBrainGovernedProposal,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("task-notes-postgres");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[task-notes-postgres] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
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

async function fixture(options: { privateRoot?: boolean; child?: boolean } = {}) {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `task-note-owner-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Task note owner",
  });
  const grant = access.workspaceGrants[0]!;
  const root = await withSessionRlsActorContext(
    { subjectId: ownerSubjectId },
    async () =>
      await createSession(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: "root task",
        resources: [],
        metadata: {},
        model: "test-model",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: ownerSubjectId },
        createdByContext: {},
      }),
  );
  if (options.privateRoot) {
    await transitionSessionVisibility(client.db, {
      workspaceId: grant.workspaceId,
      sessionId: root.id,
      actorSubjectId: ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `private-${suffix}`,
    });
  }
  const child = options.child
    ? await withSessionRlsActorContext(
        { subjectId: ownerSubjectId },
        async () =>
          await createSession(client!.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            parentSessionId: root.id,
            initialMessage: "child task",
            resources: [],
            metadata: {},
            model: "test-model",
            sandboxBackend: "none",
            createdBy: { kind: "subject", subjectId: ownerSubjectId },
            createdByContext: {},
          }),
      )
    : null;
  return { grant, ownerSubjectId, root, child };
}

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  initiatorKind?: "subject" | "service";
  initiatorSubjectId?: string;
  initiatingHumanSubjectId?: string | null;
  generation?: number;
  turnId?: string;
}) {
  const turnId = input.turnId ?? crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const generation = input.generation ?? 1;
  const initiatorKind = input.initiatorKind ?? "subject";
  const initiatorSubjectId = input.initiatorSubjectId ?? "human:task-note-test";
  await shared!.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    if (input.turnId) {
      await sql`
        update session_turns set execution_generation = ${generation},
          active_attempt_id = null, status = 'recovering'
        where workspace_id = ${input.workspaceId} and id = ${turnId}
      `;
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
          ${crypto.randomUUID()}, ${`task-note-${turnId}`}, 'running', 'user', 1,
          'task note fixture', 'test-model', 'medium', 'none', ${generation},
          ${initiatorKind}, ${initiatorSubjectId}, '{}'::jsonb,
          ${input.initiatingHumanSubjectId ?? null}
        )
      `;
    }
    await sql`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
    `;
    await sql`
      update session_turns set active_attempt_id = ${attemptId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${turnId}
    `;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${turnId}, ${generation}, 'running', ${`task-note-${turnId}`},
        ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
  });
  return { ...input, turnId, attemptId, executionGeneration: generation };
}

function claims(attempt: Awaited<ReturnType<typeof seedAttempt>>) {
  return {
    accountId: attempt.accountId,
    workspaceId: attempt.workspaceId,
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
  };
}

describe("task-tree notes PostgreSQL authority", () => {
  test("denies Task-note promotion under the exact default-off learning snapshot", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const note = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "finding",
      text: "This note must remain transient while learning is off.",
      expiresInDays: 7,
    });
    const snapshot = await getOrCreateWorkspaceLearningPolicySnapshot(client.db, claims(attempt));
    expect(snapshot.workspaceMode).toBe("off");
    await expectSqlState(
      async () =>
        await writeCompanyBrainGovernedProposal(client!.db, {
          attempt: claims(attempt),
          request: {
            kind: "promote_task_note_knowledge",
            operationId: crypto.randomUUID(),
            noteId: note.note.id,
            expectedNoteVersion: 1,
            entityType: "company",
            normalizedKey: "transient",
            displayName: "Transient",
            predicateKey: "company.transient",
            confidenceBps: 5_000,
            reason: "Learning is disabled.",
          },
        }),
      "42501",
    );
  });

  test("promotes an active rooted note into proposed workspace Knowledge with replay-safe provenance", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const policy = await createWorkspaceLearningPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      workspaceMode: "suggest",
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
    });
    await activateWorkspaceLearningPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      revisionId: policy.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
      reason: "Enable governed Task-note promotion for this workspace.",
    });
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const note = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "finding",
      text: "Acme's enterprise renewal date is 2027-04-01.",
      expiresInDays: 7,
    });
    const operationId = crypto.randomUUID();
    const input = {
      attempt: claims(attempt),
      request: {
        kind: "promote_task_note_knowledge" as const,
        operationId,
        noteId: note.note.id,
        expectedNoteVersion: 1 as const,
        entityType: "company",
        normalizedKey: "acme",
        displayName: "Acme",
        predicateKey: "company.renewal-date",
        confidenceBps: 8_500,
        reason: "Promote the rooted finding for human Knowledge review.",
      },
    };
    await getOrCreateWorkspaceLearningPolicySnapshot(client.db, claims(attempt));
    const first = await writeCompanyBrainGovernedProposal(client.db, input);
    expect(first.destination).toBe("knowledge");
    expect(first.taskNoteSource).toEqual({
      noteId: note.note.id,
      rootSessionId: f.root.id,
      noteVersion: 1,
      textHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(first.effectiveBoundary).toBe("human_review_required");

    const unrelatedRoot = await withSessionRlsActorContext(
      { subjectId: f.ownerSubjectId },
      async () =>
        await createSession(client!.db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          initialMessage: "unrelated root",
          resources: [],
          metadata: {},
          model: "test-model",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: f.ownerSubjectId },
          createdByContext: {},
        }),
    );
    const unrelatedAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: unrelatedRoot.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    await expect(
      writeCompanyBrainGovernedProposal(client.db, {
        attempt: claims(unrelatedAttempt),
        request: { ...input.request, operationId: crypto.randomUUID() },
      }),
    ).rejects.toThrow();

    const forgedEvidenceOperationId = crypto.randomUUID();
    const forgedClaimOperationId = crypto.randomUUID();
    const forgedFactOperationId = crypto.randomUUID();
    const forgedActorSubjectId = `service:forged-task-note-promotion:${crypto.randomUUID()}`;
    const forgedFactText = "This unrelated statement was never present in the Task note.";
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        async () =>
          await app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
            await sql`select set_config('opengeni.initiating_human_subject_id', ${f.ownerSubjectId}, true)`;
            await sql`
              insert into knowledge_claim_evidence (
                account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
                claim_id, document_version_id, task_note_id, task_note_root_session_id,
                task_note_version, polarity, content_hash, operation_id, input_hash,
                actor_kind, actor_subject_id, initiating_human_subject_id
              )
              select account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
                claim_id, null, task_note_id, task_note_root_session_id,
                task_note_version, polarity, content_hash, ${crypto.randomUUID()},
                ${"1".repeat(64)}, actor_kind, actor_subject_id, initiating_human_subject_id
              from knowledge_claim_evidence where id = ${first.evidenceId}
            `;
          }),
        "42501",
      );
      await expectSqlState(
        async () =>
          await app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select * from task_note_replacement_receipts limit 1`;
          }),
        "42501",
      );
      await expectSqlState(
        async () =>
          await app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
            await sql`select set_config('opengeni.initiating_human_subject_id', ${f.ownerSubjectId}, true)`;
            const [source] = await sql<
              {
                note_id: string;
                root_session_id: string;
                note_version: number;
                note_text_hash: string;
              }[]
            >`
              select note_id, root_session_id, note_version, note_text_hash
              from resolve_task_note_knowledge_promotion_source(
                ${attempt.accountId}::uuid,
                ${attempt.workspaceId}::uuid,
                ${attempt.sessionId}::uuid,
                ${attempt.turnId}::uuid,
                ${attempt.attemptId}::uuid,
                ${attempt.executionGeneration}::integer,
                ${note.note.id}::uuid,
                1,
                ${forgedEvidenceOperationId}::text,
                ${forgedClaimOperationId}::text,
                ${forgedActorSubjectId}::text
              )
            `;
            if (!source) throw new Error("expected a Task-note promotion source");
            const [forgedFact] = await sql<{ id: string }[]>`
              insert into knowledge_facts (
                account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
                subject_entity_id, predicate_key, object_kind, object_entity_id, object_value,
                object_hash, operation_id, input_hash, actor_kind, actor_subject_id,
                initiating_human_subject_id
              )
              select fact.account_id, fact.scope_kind, fact.scope_workspace_id,
                fact.scope_subject_id, fact.scope_key, fact.subject_entity_id,
                'company.forged-task-note-fact', 'text', null,
                pg_catalog.to_jsonb(${forgedFactText}::text),
                encode(sha256(convert_to(${forgedFactText}, 'UTF8')), 'hex'),
                ${forgedFactOperationId}, ${"2".repeat(64)}, 'service',
                ${forgedActorSubjectId}, ${f.ownerSubjectId}
              from knowledge_claim_evidence evidence
              join knowledge_claims claim on claim.id = evidence.claim_id
              join knowledge_facts fact on fact.id = claim.fact_id
              where evidence.id = ${first.evidenceId}
              returning id
            `;
            if (!forgedFact) throw new Error("expected a forged fact fixture");
            const [forgedClaim] = await sql<{ id: string }[]>`
              insert into knowledge_claims (
                account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
                fact_id, origin, confidence_bps, effective_at, expires_at,
                extraction_method, extraction_metadata, model_provider, model_name,
                model_version, operation_id, input_hash, actor_kind, actor_subject_id,
                initiating_human_subject_id
              ) values (
                ${f.grant.accountId}, 'workspace', ${f.grant.workspaceId}, null,
                ${`workspace:${f.grant.workspaceId}:-`}, ${forgedFact.id}, 'inferred',
                8500, now(), null, 'task-note-promotion-v1',
                pg_catalog.jsonb_build_object(
                  'taskNoteId', ${source.note_id}::uuid,
                  'taskNoteRootSessionId', ${source.root_session_id}::uuid,
                  'taskNoteVersion', ${source.note_version}::integer,
                  'taskNoteTextHash', ${source.note_text_hash}::text
                ),
                null, null, null, ${forgedClaimOperationId}, ${"3".repeat(64)},
                'service', ${forgedActorSubjectId}, ${f.ownerSubjectId}
              ) returning id
            `;
            if (!forgedClaim) throw new Error("expected a forged claim fixture");
            await sql`
              insert into knowledge_claim_evidence (
                account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
                claim_id, document_version_id, task_note_id, task_note_root_session_id,
                task_note_version, polarity, document_chunk_id, chunk_index, locator,
                quote_hash, content_hash, operation_id, input_hash, actor_kind,
                actor_subject_id, initiating_human_subject_id
              ) values (
                ${f.grant.accountId}, 'workspace', ${f.grant.workspaceId}, null,
                ${`workspace:${f.grant.workspaceId}:-`}, ${forgedClaim.id}, null,
                ${source.note_id}, ${source.root_session_id}, ${source.note_version},
                'supports', null, null, null, null, ${source.note_text_hash},
                ${forgedEvidenceOperationId}, ${"4".repeat(64)}, 'service',
                ${forgedActorSubjectId}, ${f.ownerSubjectId}
              )
            `;
          }),
        "42501",
      );
    } finally {
      await app.end();
    }

    await archiveTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      noteId: note.note.id,
      expectedVersion: 1,
      reason: "Promotion completed.",
    });
    expect(await writeCompanyBrainGovernedProposal(client.db, input)).toEqual(first);

    const [stored] = await shared.admin<
      {
        evidence_id: string;
        task_note_id: string;
        document_version_id: string | null;
        object_value: unknown;
        review_state: string;
      }[]
    >`
      select evidence.id as evidence_id, evidence.task_note_id,
        evidence.document_version_id, fact.object_value, review.state as review_state
      from knowledge_claim_evidence evidence
      join knowledge_claims claim on claim.id = evidence.claim_id
      join knowledge_facts fact on fact.id = claim.fact_id
      join knowledge_claim_reviews review on review.claim_id = claim.id
      where evidence.id = ${first.evidenceId}
    `;
    expect(stored).toMatchObject({
      evidence_id: first.evidenceId,
      task_note_id: note.note.id,
      document_version_id: null,
      object_value: "Acme's enterprise renewal date is 2027-04-01.",
      review_state: "proposed",
    });

    await expect(
      writeCompanyBrainGovernedProposal(client.db, {
        ...input,
        request: { ...input.request, displayName: "Different immutable input" },
      }),
    ).rejects.toThrow("different immutable input");
  });

  test("atomically promotes exact Task-note bytes into inactive Ways proposals with archival replay", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const policy = await createWorkspaceLearningPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      workspaceMode: "suggest",
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
    });
    await activateWorkspaceLearningPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      revisionId: policy.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
      reason: "Allow rooted notes to become reviewable Ways proposals.",
    });
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    await getOrCreateWorkspaceLearningPolicySnapshot(client.db, claims(attempt));

    const preferenceText = "For implementation work, use Linear as the source of truth.";
    const preferenceNote = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "decision",
      text: preferenceText,
      expiresInDays: 7,
    });
    const preferenceInput = {
      attempt: claims(attempt),
      request: {
        kind: "promote_task_note_preference" as const,
        operationId: crypto.randomUUID(),
        noteId: preferenceNote.note.id,
        expectedNoteVersion: 1 as const,
        entityType: "ways-of-working",
        normalizedKey: "implementation-linear",
        displayName: "Implementation issue tracking",
        predicateKey: "ways.implementation-tracker",
        confidenceBps: 9_000,
        stableKey: `implementation.linear.${crypto.randomUUID().replaceAll("-", "")}`,
        title: "Use Linear for implementation",
        description: "Tracks the preferred implementation workflow.",
        precedenceRank: 10,
        conflictStrategy: "override" as const,
        conflictsWith: [],
        expiresAt: null,
        reason: "Promote the exact rooted decision for human review.",
      },
    };
    const [preferenceFirst, preferenceConcurrent] = await Promise.all([
      writeCompanyBrainGovernedProposal(client.db, preferenceInput),
      writeCompanyBrainGovernedProposal(client.db, preferenceInput),
    ]);
    expect(preferenceConcurrent).toEqual(preferenceFirst);
    expect(preferenceFirst).toMatchObject({
      destination: "preference",
      outcome: "proposed",
      effectiveBoundary: "human_review_required",
      taskNoteSource: {
        noteId: preferenceNote.note.id,
        rootSessionId: f.root.id,
        noteVersion: 1,
      },
    });
    const preferenceProposalId = preferenceFirst.destinationProposalId;
    const preferenceRevisionId = preferenceFirst.destinationRevisionId;
    if (!preferenceProposalId || !preferenceRevisionId) {
      throw new Error("preference promotion did not return exact destination lineage");
    }

    const [preferenceReceipt] = await shared.admin<
      Array<{ input_hash: string; knowledge_proposal_id: string }>
    >`
      select input_hash, knowledge_proposal_id
      from company_brain_preference_proposal_receipts
      where preference_id = ${preferenceProposalId}
    `;
    expect(preferenceReceipt).toBeDefined();
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      const [shadowSafeReplay] = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
        await sql`select set_config('opengeni.initiating_human_subject_id', ${f.ownerSubjectId}, true)`;
        await sql.unsafe("create temporary table workspaces (trap text) on commit drop");
        return await sql<Array<{ preference_id: string; revision_id: string }>>`
          select preference_id, revision_id
          from preference_registry_create_knowledge_proposal_for_attempt(
            ${attempt.accountId}::uuid,
            ${attempt.workspaceId}::uuid,
            ${attempt.sessionId}::uuid,
            ${attempt.turnId}::uuid,
            ${attempt.attemptId}::uuid,
            ${attempt.executionGeneration}::integer,
            ${preferenceInput.request.operationId}::uuid,
            ${preferenceReceipt!.input_hash}::text,
            ${preferenceReceipt!.knowledge_proposal_id}::uuid,
            ${preferenceInput.request.stableKey}::text,
            ${preferenceInput.request.title}::text,
            ${preferenceInput.request.description}::text,
            ${preferenceText}::text,
            ${preferenceInput.request.precedenceRank}::integer,
            ${preferenceInput.request.conflictStrategy}::text,
            ${sql.json(preferenceInput.request.conflictsWith)}::jsonb,
            ${preferenceInput.request.expiresAt}::timestamptz,
            ${preferenceInput.request.reason}::text
          )
        `;
      });
      expect(shadowSafeReplay).toEqual({
        preference_id: preferenceProposalId,
        revision_id: preferenceRevisionId,
      });
    } finally {
      await app.end();
    }

    const instructionText = "Never place secret values in public logs.";
    const instructionNote = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "decision",
      text: instructionText,
      expiresInDays: 7,
    });
    const instructionInput = {
      attempt: claims(attempt),
      request: {
        kind: "promote_task_note_instruction_policy" as const,
        operationId: crypto.randomUUID(),
        noteId: instructionNote.note.id,
        expectedNoteVersion: 1 as const,
        entityType: "ways-of-working",
        normalizedKey: "public-log-secrets",
        displayName: "Public log secret handling",
        predicateKey: "ways.security.public-logs",
        confidenceBps: 9_500,
        target: { kind: "policy" as const, scope: "global" as const, roleKey: null },
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        reason: "Promote the exact rooted security decision for human review.",
      },
    };
    const instructionFirst = await writeCompanyBrainGovernedProposal(client.db, instructionInput);
    expect(instructionFirst).toMatchObject({
      destination: "instruction_policy",
      outcome: "proposed",
      effectiveBoundary: "human_review_required",
      taskNoteSource: {
        noteId: instructionNote.note.id,
        rootSessionId: f.root.id,
        noteVersion: 1,
      },
    });

    const unrelatedRoot = await withSessionRlsActorContext(
      { subjectId: f.ownerSubjectId },
      async () =>
        await createSession(client!.db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          initialMessage: "unrelated Ways promotion",
          resources: [],
          metadata: {},
          model: "test-model",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: f.ownerSubjectId },
          createdByContext: {},
        }),
    );
    const unrelatedAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: unrelatedRoot.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    await expect(
      writeCompanyBrainGovernedProposal(client.db, {
        attempt: claims(unrelatedAttempt),
        request: { ...instructionInput.request, operationId: crypto.randomUUID() },
      }),
    ).rejects.toThrow();

    await archiveTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      noteId: preferenceNote.note.id,
      expectedVersion: 1,
      reason: "Preference proposal is durably recorded.",
    });
    await archiveTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      noteId: instructionNote.note.id,
      expectedVersion: 1,
      reason: "Instruction proposal is durably recorded.",
    });
    expect(await writeCompanyBrainGovernedProposal(client.db, preferenceInput)).toEqual(
      preferenceFirst,
    );
    expect(await writeCompanyBrainGovernedProposal(client.db, instructionInput)).toEqual(
      instructionFirst,
    );
    await expect(
      writeCompanyBrainGovernedProposal(client.db, {
        ...preferenceInput,
        request: { ...preferenceInput.request, title: "Different immutable input" },
      }),
    ).rejects.toThrow("different immutable input");

    const [preferenceStored] = await shared.admin<
      {
        status: string;
        active_revision_id: string | null;
        content: string;
        knowledge_content: string;
        event_count: number;
      }[]
    >`
      select preference.status, preference.active_revision_id, revision.content,
        change.content as knowledge_content,
        (select count(*)::int from preference_registry_events event
          where event.preference_id = preference.id) as event_count
      from preference_registry_preferences preference
      join preference_registry_revisions revision
        on revision.id = ${preferenceFirst.destinationRevisionId}
      join company_brain_preference_proposal_receipts receipt
        on receipt.preference_id = preference.id
      join knowledge_change_proposals change
        on change.id = receipt.knowledge_proposal_id
      where preference.id = ${preferenceFirst.destinationProposalId}
    `;
    expect(preferenceStored).toEqual({
      status: "proposed",
      active_revision_id: null,
      content: preferenceText,
      knowledge_content: expect.stringContaining(`"content":"${preferenceText}"`),
      event_count: 1,
    });

    const [instructionStored] = await shared.admin<
      {
        status: string;
        content: string;
        knowledge_content: string;
        active_head_count: number;
        activation_event_count: number;
      }[]
    >`
      select proposal.status, revision.content, change.content as knowledge_content,
        (select count(*)::int from workspace_instruction_policy_heads head
          where head.workspace_id = proposal.workspace_id and head.kind = proposal.kind
            and head.scope = proposal.scope
            and coalesce(head.role_key, '') = coalesce(proposal.role_key, '')) as active_head_count,
        (select count(*)::int from workspace_instruction_policy_activation_events event
          where event.workspace_id = proposal.workspace_id and event.kind = proposal.kind
            and event.scope = proposal.scope
            and coalesce(event.role_key, '') = coalesce(proposal.role_key, ''))
          as activation_event_count
      from workspace_instruction_policy_onboarding_proposals proposal
      join workspace_instruction_policy_revisions revision
        on revision.id = proposal.draft_revision_id
      join knowledge_change_proposals change
        on change.id = proposal.source_id::uuid
      where proposal.id = ${instructionFirst.destinationProposalId}
    `;
    expect(instructionStored).toEqual({
      status: "proposed",
      content: instructionText,
      knowledge_content: instructionText,
      active_head_count: 0,
      activation_event_count: 0,
    });
  });

  test("serializes distinct-root instruction promotions before Task-note session locks", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const policy = await createWorkspaceLearningPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      workspaceMode: "suggest",
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
    });
    await activateWorkspaceLearningPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      revisionId: policy.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
      reason: "Exercise concurrent rooted instruction proposals.",
    });
    const secondRoot = await withSessionRlsActorContext(
      { subjectId: f.ownerSubjectId },
      async () =>
        await createSession(client!.db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          initialMessage: "second independent instruction root",
          resources: [],
          metadata: {},
          model: "test-model",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: f.ownerSubjectId },
          createdByContext: {},
        }),
    );
    const [firstAttempt, secondAttempt] = await Promise.all([
      seedAttempt({
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        sessionId: f.root.id,
        initiatorSubjectId: f.ownerSubjectId,
        initiatingHumanSubjectId: f.ownerSubjectId,
      }),
      seedAttempt({
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        sessionId: secondRoot.id,
        initiatorSubjectId: f.ownerSubjectId,
        initiatingHumanSubjectId: f.ownerSubjectId,
      }),
    ]);
    await Promise.all([
      getOrCreateWorkspaceLearningPolicySnapshot(client.db, claims(firstAttempt)),
      getOrCreateWorkspaceLearningPolicySnapshot(client.db, claims(secondAttempt)),
    ]);
    const [firstNote, secondNote] = await Promise.all([
      createTaskNote(client.db, {
        ...claims(firstAttempt),
        operationId: crypto.randomUUID(),
        kind: "decision",
        text: "Concurrent workspace lock order: first rooted instruction.",
        expiresInDays: 7,
      }),
      createTaskNote(client.db, {
        ...claims(secondAttempt),
        operationId: crypto.randomUUID(),
        kind: "decision",
        text: "Concurrent workspace lock order: second rooted instruction.",
        expiresInDays: 7,
      }),
    ]);
    const inputs = [
      { attempt: firstAttempt, note: firstNote, key: "first" },
      { attempt: secondAttempt, note: secondNote, key: "second" },
    ].map(({ attempt, note, key }) => ({
      attempt: claims(attempt),
      request: {
        kind: "promote_task_note_instruction_policy" as const,
        operationId: crypto.randomUUID(),
        noteId: note.note.id,
        expectedNoteVersion: 1 as const,
        entityType: "ways-of-working",
        normalizedKey: `instruction-lock-order-${key}`,
        displayName: `Instruction lock order ${key}`,
        predicateKey: `ways.instruction-lock-order.${key}`,
        confidenceBps: 9_000,
        target: { kind: "policy" as const, scope: "global" as const, roleKey: null },
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        reason: `Promote the ${key} rooted instruction without lock inversion.`,
      },
    }));

    // Hold a test-only advisory barrier immediately before the destination
    // lifecycle call. With the old lock order, both roots reached this point
    // while holding workspace KEY SHARE and then deadlocked on the workspace
    // upgrade. The canonical workspace-first path permits only one waiter.
    const barrierKey = 2_240_260;
    const blocker = postgres(shared.adminUrl, { max: 1, prepare: false });
    let barrierHeld = false;
    try {
      await shared.admin.unsafe(`
        CREATE OR REPLACE FUNCTION task_note_instruction_promotion_test_barrier()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.target_kind = 'instruction_policy'
            AND NEW.content LIKE 'Concurrent workspace lock order:%'
          THEN
            PERFORM pg_advisory_xact_lock_shared(2240260);
          END IF;
          RETURN NEW;
        END;
        $$;
        DROP TRIGGER IF EXISTS task_note_instruction_promotion_test_barrier
          ON knowledge_change_proposals;
        CREATE TRIGGER task_note_instruction_promotion_test_barrier
          BEFORE INSERT ON knowledge_change_proposals
          FOR EACH ROW EXECUTE FUNCTION task_note_instruction_promotion_test_barrier();
      `);
      await blocker`select pg_advisory_lock(${barrierKey})`;
      barrierHeld = true;
      const pending = Promise.allSettled(
        inputs.map(async (input) => await writeCompanyBrainGovernedProposal(client!.db, input)),
      );
      let maxWaitingBarrierLocks = 0;
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && maxWaitingBarrierLocks < 2) {
        const [waiting] = await shared.admin<Array<{ count: number }>>`
          SELECT count(*)::integer AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = 0
            AND objid = ${barrierKey}::oid
            AND objsubid = 1
            AND NOT granted
        `;
        maxWaitingBarrierLocks = Math.max(maxWaitingBarrierLocks, waiting?.count ?? 0);
        if (maxWaitingBarrierLocks < 2) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(maxWaitingBarrierLocks).toBe(1);
      const [unlocked] = await blocker<Array<{ unlocked: boolean }>>`
        SELECT pg_advisory_unlock(${barrierKey}) AS unlocked
      `;
      expect(unlocked?.unlocked).toBe(true);
      barrierHeld = false;
      const results = await pending;
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
      const receipts = results
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof writeCompanyBrainGovernedProposal>>
          > => result.status === "fulfilled",
        )
        .map((result) => result.value);
      expect(new Set(receipts.map((receipt) => receipt.destinationProposalId)).size).toBe(2);

      const [durable] = await shared.admin<
        Array<{ proposalCount: number; headCount: number; activationCount: number }>
      >`
        SELECT
          (SELECT count(*)::integer
            FROM workspace_instruction_policy_onboarding_proposals proposal
            JOIN workspace_instruction_policy_revisions revision
              ON revision.id = proposal.draft_revision_id
            WHERE proposal.workspace_id = ${f.grant.workspaceId}
              AND revision.content LIKE 'Concurrent workspace lock order:%') AS "proposalCount",
          (SELECT count(*)::integer FROM workspace_instruction_policy_heads head
            WHERE head.workspace_id = ${f.grant.workspaceId}) AS "headCount",
          (SELECT count(*)::integer FROM workspace_instruction_policy_activation_events event
            WHERE event.workspace_id = ${f.grant.workspaceId}) AS "activationCount"
      `;
      expect(durable).toEqual({ proposalCount: 2, headCount: 0, activationCount: 0 });
    } finally {
      if (barrierHeld) {
        await blocker`select pg_advisory_unlock(${barrierKey})`.catch(() => undefined);
      }
      await blocker.end().catch(() => undefined);
      await shared.admin.unsafe(`
        DROP TRIGGER IF EXISTS task_note_instruction_promotion_test_barrier
          ON knowledge_change_proposals;
        DROP FUNCTION IF EXISTS task_note_instruction_promotion_test_barrier();
      `);
    }
  });

  test("gives the runtime role lifecycle functions but no direct table access", async () => {
    if (!shared) return;
    const f = await fixture();
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        async () =>
          await app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select * from task_notes limit 1`;
          }),
        "42501",
      );
      await expectSqlState(
        async () =>
          await app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`update task_notes set status = 'archived' where false`;
          }),
        "42501",
      );
      for (const table of [
        "company_brain_preference_proposal_receipts",
        "workspace_instruction_policy_activation_events",
        "preference_registry_events",
      ]) {
        await expectSqlState(
          async () =>
            await app.begin(async (sql) => {
              await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
              await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
              await sql.unsafe(`update ${table} set account_id = account_id where false`);
            }),
          "42501",
        );
      }
    } finally {
      await app.end();
    }
  });

  test("definer paths ignore caller temporary authority relations and keep durable tables closed", async () => {
    if (!shared || !client) return;
    const f = await fixture({ privateRoot: true });
    const policy = await createWorkspaceLearningPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      workspaceMode: "suggest",
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
    });
    await activateWorkspaceLearningPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      revisionId: policy.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
      reason: "Exercise the exact Task-note promotion authority under TEMP shadowing.",
    });
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    await getOrCreateWorkspaceLearningPolicySnapshot(client.db, claims(attempt));
    const note = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "decision",
      text: "Durable provenance must win over caller temporary relations.",
      expiresInDays: 7,
    });
    const targetRoot = await withSessionRlsActorContext(
      { subjectId: f.ownerSubjectId },
      async () =>
        await createSession(client!.db, {
          accountId: f.grant.accountId,
          workspaceId: f.grant.workspaceId,
          initialMessage: "private target root",
          resources: [],
          metadata: {},
          model: "test-model",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: f.ownerSubjectId },
          createdByContext: {},
        }),
    );
    await transitionSessionVisibility(client.db, {
      workspaceId: f.grant.workspaceId,
      sessionId: targetRoot.id,
      actorSubjectId: f.ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `private-target-${crypto.randomUUID()}`,
    });
    const targetAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: targetRoot.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    await getOrCreateWorkspaceLearningPolicySnapshot(client.db, claims(targetAttempt));
    const targetNote = await createTaskNote(client.db, {
      ...claims(targetAttempt),
      operationId: crypto.randomUUID(),
      kind: "decision",
      text: "A different private root must remain unavailable to the source attempt.",
      expiresInDays: 7,
    });
    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    let observedSource:
      | {
          note_id: string;
          root_session_id: string;
          note_version: number;
          note_text: string;
          note_text_hash: string;
        }
      | undefined;
    try {
      await expect(
        app.begin(async (sql) => {
          await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
          await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
          await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
          await sql`select set_config('opengeni.initiating_human_subject_id', ${f.ownerSubjectId}, true)`;
          await sql.unsafe("create temporary table workspaces (trap text) on commit drop");
          await sql.unsafe("create temporary table sessions (trap text) on commit drop");
          await sql.unsafe("create temporary table session_turns (trap text) on commit drop");
          await sql.unsafe(
            "create temporary table session_turn_attempts (trap text) on commit drop",
          );
          await sql.unsafe(
            "create temporary table session_attempt_interruptions (trap text) on commit drop",
          );
          await sql.unsafe(
            "create temporary table organization_memberships (trap text) on commit drop",
          );
          await sql.unsafe(
            "create temporary table workspace_memberships (trap text) on commit drop",
          );
          await sql.unsafe("create temporary table task_notes (trap text) on commit drop");
          await sql.unsafe("create temporary table task_note_events (trap text) on commit drop");
          await sql.unsafe(
            "create temporary table task_note_write_capabilities (trap text) on commit drop",
          );
          await sql.unsafe(
            "create temporary table workspace_learning_policy_snapshots (trap text) on commit drop",
          );
          await sql.unsafe(
            "create temporary table task_note_knowledge_promotion_capabilities (trap text) on commit drop",
          );
          [observedSource] = await sql<
            {
              note_id: string;
              root_session_id: string;
              note_version: number;
              note_text: string;
              note_text_hash: string;
            }[]
          >`
            select note_id, root_session_id, note_version, note_text, note_text_hash
            from resolve_task_note_knowledge_promotion_source(
              ${attempt.accountId}::uuid,
              ${attempt.workspaceId}::uuid,
              ${attempt.sessionId}::uuid,
              ${attempt.turnId}::uuid,
              ${attempt.attemptId}::uuid,
              ${attempt.executionGeneration}::integer,
              ${note.note.id}::uuid,
              1,
              ${crypto.randomUUID()}::text,
              ${crypto.randomUUID()}::text,
              ${`service:temp-shadow-regression:${crypto.randomUUID()}`}::text
            )
          `;
          throw new Error("rollback temp-shadow provenance probe");
        }),
      ).rejects.toThrow("rollback temp-shadow provenance probe");
      expect(observedSource).toMatchObject({
        note_id: note.note.id,
        root_session_id: f.root.id,
        note_version: 1,
        note_text: note.note.text,
        note_text_hash: createHash("sha256").update(note.note.text, "utf8").digest("hex"),
      });

      const [interruptionReceipt] = await shared.admin<{ id: string }[]>`
        insert into session_command_receipts (
          account_id, workspace_id, actor_type, actor_subject_id, action,
          target_session_id, target_turn_id, operation_key, canonical_request_hash
        ) values (
          ${attempt.accountId}, ${attempt.workspaceId}, 'human', ${f.ownerSubjectId},
          'session.queue.steer', ${attempt.sessionId}, ${attempt.turnId},
          ${crypto.randomUUID()}, ${`temp-shadow-interruption-${crypto.randomUUID()}`}
        ) returning id
      `;
      await shared.admin`
        insert into session_attempt_interruptions (
          account_id, workspace_id, session_id, operation_id, attempt_id,
          kind, control_revision
        ) values (
          ${attempt.accountId}, ${attempt.workspaceId}, ${attempt.sessionId},
          ${interruptionReceipt!.id}, ${attempt.attemptId}, 'steer', 1
        )
      `;

      const forgedSubjectId = `user:temp-shadow-${crypto.randomUUID()}`;
      const forgedMembershipId = crypto.randomUUID();
      await expectSqlState(
        async () =>
          await app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
            await sql`select set_config('opengeni.initiating_human_subject_id', ${f.ownerSubjectId}, true)`;
            await sql.unsafe(
              "create temporary table workspaces (account_id uuid, id uuid) on commit drop",
            );
            await sql.unsafe(
              "create temporary table sessions (account_id uuid, workspace_id uuid, id uuid, root_session_id uuid, active_turn_id uuid, visibility text, owner_organization_membership_id uuid, owner_subject_id text) on commit drop",
            );
            await sql.unsafe(
              "create temporary table session_turns (account_id uuid, workspace_id uuid, session_id uuid, id uuid, active_attempt_id uuid, execution_generation integer, status text, initiator_kind text, initiator_subject_id text, initiating_human_subject_id text) on commit drop",
            );
            await sql.unsafe(
              "create temporary table session_turn_attempts (account_id uuid, workspace_id uuid, session_id uuid, turn_id uuid, id uuid, execution_generation integer, state text) on commit drop",
            );
            await sql.unsafe(
              "create temporary table session_attempt_interruptions (workspace_id uuid, attempt_id uuid, state text) on commit drop",
            );
            await sql.unsafe(
              "create temporary table organization_memberships (account_id uuid, id uuid, subject_id text, status text) on commit drop",
            );
            await sql.unsafe(
              "create temporary table workspace_memberships (account_id uuid, workspace_id uuid, subject_id text) on commit drop",
            );
            await sql`
              insert into workspaces values (${attempt.accountId}, ${attempt.workspaceId})
            `;
            await sql`
              insert into sessions values
                (${attempt.accountId}, ${attempt.workspaceId}, ${attempt.sessionId},
                  ${targetRoot.id}, ${attempt.turnId}, 'user_private',
                  ${forgedMembershipId}, ${forgedSubjectId}),
                (${attempt.accountId}, ${attempt.workspaceId}, ${targetRoot.id},
                  ${targetRoot.id}, ${targetAttempt.turnId}, 'user_private',
                  ${forgedMembershipId}, ${forgedSubjectId})
            `;
            await sql`
              insert into session_turns values (
                ${attempt.accountId}, ${attempt.workspaceId}, ${attempt.sessionId},
                ${attempt.turnId}, ${attempt.attemptId}, ${attempt.executionGeneration},
                'running', 'subject', ${forgedSubjectId}, ${forgedSubjectId}
              )
            `;
            await sql`
              insert into session_turn_attempts values (
                ${attempt.accountId}, ${attempt.workspaceId}, ${attempt.sessionId},
                ${attempt.turnId}, ${attempt.attemptId}, ${attempt.executionGeneration}, 'running'
              )
            `;
            await sql`
              insert into organization_memberships values (
                ${attempt.accountId}, ${forgedMembershipId}, ${forgedSubjectId}, 'active'
              )
            `;
            await sql`
              insert into workspace_memberships values (
                ${attempt.accountId}, ${attempt.workspaceId}, ${forgedSubjectId}
              )
            `;
            await sql`
              select * from resolve_task_note_knowledge_promotion_source(
                ${attempt.accountId}::uuid,
                ${attempt.workspaceId}::uuid,
                ${attempt.sessionId}::uuid,
                ${attempt.turnId}::uuid,
                ${attempt.attemptId}::uuid,
                ${attempt.executionGeneration}::integer,
                ${targetNote.note.id}::uuid,
                1,
                ${crypto.randomUUID()}::text,
                ${crypto.randomUUID()}::text,
                ${`service:temp-shadow-forgery:${crypto.randomUUID()}`}::text
              )
            `;
          }),
        "42501",
      );

      await expectSqlState(
        async () =>
          await app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql.unsafe(
              "create temporary table task_note_replacement_receipts (trap text) on commit drop",
            );
            await sql`insert into public.task_note_replacement_receipts default values`;
          }),
        "42501",
      );
    } finally {
      await app.end();
    }
  });

  test("shares one root tree explicitly while private-root RLS rejects another human", async () => {
    if (!shared || !client) return;
    const f = await fixture({ privateRoot: true, child: true });
    const rootAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const created = await withSessionRlsActorContext(
      { subjectId: "worker:root", initiatingHumanSubjectId: f.ownerSubjectId },
      async () =>
        await createTaskNote(client!.db, {
          ...claims(rootAttempt),
          operationId: crypto.randomUUID(),
          kind: "finding",
          text: "The child should reuse this exact discovery.",
          expiresInDays: 1,
        }),
    );
    const childAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.child!.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const visible = await withSessionRlsActorContext(
      { subjectId: "worker:child", initiatingHumanSubjectId: f.ownerSubjectId },
      async () => await listTaskNotes(client!.db, claims(childAttempt)),
    );
    expect(visible.notes.map((note) => note.id)).toContain(created.note.id);
    expect(visible.notes[0]?.rootSessionId).toBe(f.root.id);

    const outsider = `user:task-note-outsider-${crypto.randomUUID()}`;
    await grantWorkspaceAccess(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      subjectId: outsider,
      permissions: ["sessions:read", "sessions:control"],
    });
    await shared.admin.begin(async (sql) => {
      await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
      await sql`
        update session_turn_attempts set state = 'closed', outcome = 'completed', closed_at = now()
        where id = ${childAttempt.attemptId}
      `;
      await sql`
        update session_turns set status = 'completed', active_attempt_id = null
        where id = ${childAttempt.turnId}
      `;
      await sql`
        update sessions set status = 'idle', active_turn_id = null
        where workspace_id = ${f.grant.workspaceId} and id = ${f.child!.id}
      `;
    });
    const outsiderAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.child!.id,
      initiatorSubjectId: outsider,
      initiatingHumanSubjectId: outsider,
    });
    await expectSqlState(
      async () =>
        await withSessionRlsActorContext(
          { subjectId: "worker:outsider", initiatingHumanSubjectId: outsider },
          async () => await listTaskNotes(client!.db, claims(outsiderAttempt)),
        ),
      "42501",
    );
  });

  test("replays only the exact original attempt/input and preserves service provenance", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorKind: "service",
      initiatorSubjectId: "service:goal-continuation",
      initiatingHumanSubjectId: null,
    });
    const operationId = crypto.randomUUID();
    const input = {
      ...claims(attempt),
      operationId,
      kind: "handoff" as const,
      text: "Service-originated handoff with no manufactured human authority.",
      expiresInDays: 1,
    };
    const first = await withSessionRlsActorContext(
      { subjectId: "worker:service" },
      async () => await createTaskNote(client!.db, input),
    );
    await Bun.sleep(25);
    const retry = await withSessionRlsActorContext(
      { subjectId: "worker:service" },
      async () => await createTaskNote(client!.db, input),
    );
    expect(first.replayed).toBe(false);
    expect(retry).toEqual({ note: first.note, replayed: true });
    expect(first.note.provenance.actorKind).toBe("service");

    const otherRoot = await createSession(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      initialMessage: "separate root task",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
      createdBy: { kind: "service", subjectId: "service:task-note-test" },
      createdByContext: {},
    });
    const otherTreeAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: otherRoot.id,
      initiatorKind: "service",
      initiatorSubjectId: "service:goal-continuation",
      initiatingHumanSubjectId: null,
    });
    await expectSqlState(
      async () =>
        await withSessionRlsActorContext(
          { subjectId: "worker:service" },
          async () =>
            await createTaskNote(client!.db, {
              ...input,
              ...claims(otherTreeAttempt),
            }),
        ),
      "23505",
    );

    await shared.admin.begin(async (sql) => {
      await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
      await sql`
        update session_turn_attempts set state = 'closed', outcome = 'interrupted_recoverable',
          closed_at = now() where id = ${attempt.attemptId}
      `;
    });
    const recovery = await seedAttempt({
      ...attempt,
      generation: 2,
      turnId: attempt.turnId,
    });
    await expectSqlState(
      async () =>
        await withSessionRlsActorContext(
          { subjectId: "worker:service" },
          async () => await createTaskNote(client!.db, { ...input, ...claims(recovery) }),
        ),
      "23505",
    );
  });

  test("archives once without overwriting the immutable create receipt", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const createOperationId = crypto.randomUUID();
    const created = await withSessionRlsActorContext(
      {
        subjectId: "worker:create",
        initiatingHumanSubjectId: f.ownerSubjectId,
      },
      async () =>
        await createTaskNote(client!.db, {
          ...claims(attempt),
          operationId: createOperationId,
          kind: "decision",
          text: "Keep the create receipt when this note is archived.",
          expiresInDays: 1,
        }),
    );
    const archiveInput = {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      noteId: created.note.id,
      expectedVersion: 1,
      reason: "The handoff is complete.",
    };
    const archived = await withSessionRlsActorContext(
      {
        subjectId: "worker:archive",
        initiatingHumanSubjectId: f.ownerSubjectId,
      },
      async () => await archiveTaskNote(client!.db, archiveInput),
    );
    const replay = await withSessionRlsActorContext(
      {
        subjectId: "worker:archive",
        initiatingHumanSubjectId: f.ownerSubjectId,
      },
      async () => await archiveTaskNote(client!.db, archiveInput),
    );
    expect(archived.note).toMatchObject({
      id: created.note.id,
      status: "archived",
      version: 2,
    });
    expect(replay).toEqual({ note: archived.note, replayed: true });

    const [durable] = await shared.admin<
      {
        create_operation_id: string;
        archive_operation_id: string;
        created_by_attempt_id: string;
        archived_by_attempt_id: string;
        event_count: number;
      }[]
    >`
      select note.create_operation_id, note.archive_operation_id,
        note.created_by_attempt_id, note.archived_by_attempt_id,
        (select count(*)::int from task_note_events event
          where event.workspace_id = note.workspace_id and event.note_id = note.id) as event_count
      from task_notes note where note.workspace_id = ${f.grant.workspaceId}
        and note.id = ${created.note.id}
    `;
    expect(durable).toEqual({
      create_operation_id: createOperationId,
      archive_operation_id: archiveInput.operationId,
      created_by_attempt_id: attempt.attemptId,
      archived_by_attempt_id: attempt.attemptId,
      event_count: 2,
    });
  });

  test("atomically replaces and reverts an exact note with immutable replay-safe lineage", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const original = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "finding",
      text: "The rollout begins on Monday.",
      expiresInDays: 7,
    });
    const operationId = crypto.randomUUID();
    const input = {
      ...claims(attempt),
      operationId,
      replacedNoteId: original.note.id,
      expectedReplacedVersion: 1,
      replacementKind: "decision" as const,
      replacementText: "The rollout begins on Tuesday.",
      replacementExpiresInDays: 5,
      reason: "Correct the rollout day while retaining the original note.",
    };
    const first = await replaceTaskNote(client.db, input);
    const retry = await replaceTaskNote(client.db, input);
    expect(first).toMatchObject({
      operationId,
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      replaces: { noteId: original.note.id, archivedVersion: 2 },
      replacement: {
        rootSessionId: f.root.id,
        kind: "decision",
        text: "The rollout begins on Tuesday.",
        status: "active",
        version: 1,
      },
      replayed: false,
    });
    expect(retry).toEqual({ ...first, replayed: true });
    await expectSqlState(
      async () =>
        await replaceTaskNote(client!.db, {
          ...input,
          replacementText: "A changed retry must not overwrite lineage.",
        }),
      "23505",
    );
    await expectSqlState(
      async () => await replaceTaskNote(client!.db, { ...input, operationId: crypto.randomUUID() }),
      "40001",
    );

    const reverted = await replaceTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      replacedNoteId: first.replacement.id,
      expectedReplacedVersion: 1,
      replacementKind: original.note.kind,
      replacementText: original.note.text,
      replacementExpiresInDays: 7,
      reason: "Revert the correction using the retained immutable original.",
    });
    expect(reverted).toMatchObject({
      replaces: { noteId: first.replacement.id, archivedVersion: 2 },
      replacement: {
        rootSessionId: f.root.id,
        kind: original.note.kind,
        text: original.note.text,
        status: "active",
        version: 1,
      },
    });

    const stored = await shared.admin<Array<{ id: string; status: string; version: number }>>`
      select id, status, version from task_notes
      where workspace_id = ${f.grant.workspaceId}
        and id in (${original.note.id}, ${first.replacement.id}, ${reverted.replacement.id})
    `;
    expect(stored).toContainEqual({ id: original.note.id, status: "archived", version: 2 });
    expect(stored).toContainEqual({ id: first.replacement.id, status: "archived", version: 2 });
    expect(stored).toContainEqual({ id: reverted.replacement.id, status: "active", version: 1 });
    const [receipt] = await shared.admin<
      Array<{ receipt_count: number; text_column_count: number }>
    >`
      select
        (select count(*)::int from task_note_replacement_receipts
          where workspace_id = ${f.grant.workspaceId} and root_session_id = ${f.root.id})
          as receipt_count,
        (select count(*)::int from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'task_note_replacement_receipts'
            and column_name in ('text', 'content', 'note_text', 'replacement_text'))
          as text_column_count
    `;
    expect(receipt).toEqual({ receipt_count: 2, text_column_count: 0 });

    await shared.admin.begin(async (sql) => {
      await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
      await sql`
        update session_turn_attempts set state = 'closed', outcome = 'interrupted_recoverable',
          closed_at = now() where id = ${attempt.attemptId}
      `;
    });
    const recovery = await seedAttempt({ ...attempt, generation: 2, turnId: attempt.turnId });
    await expectSqlState(
      async () => await replaceTaskNote(client!.db, { ...input, ...claims(recovery) }),
      "23505",
    );
  });

  test("serializes competing replacements so only one successor can become active", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const original = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "ownership",
      text: "One agent owns the deployment check.",
      expiresInDays: 1,
    });
    const results = await Promise.allSettled(
      ["Agent A owns the deployment check.", "Agent B owns the deployment check."].map(
        async (replacementText) =>
          await replaceTaskNote(client!.db, {
            ...claims(attempt),
            operationId: crypto.randomUUID(),
            replacedNoteId: original.note.id,
            expectedReplacedVersion: 1,
            replacementKind: "ownership",
            replacementText,
            replacementExpiresInDays: 1,
            reason: "Resolve the ownership record atomically.",
          }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect(nestedPostgresSqlState((rejected as PromiseRejectedResult).reason)).toBe("40001");
    const [durable] = await shared.admin<
      Array<{ receipt_count: number; active_successor_count: number }>
    >`
      select
        (select count(*)::int from task_note_replacement_receipts
          where workspace_id = ${f.grant.workspaceId}
            and replaced_note_id = ${original.note.id}) as receipt_count,
        (select count(*)::int from task_notes
          where workspace_id = ${f.grant.workspaceId} and root_session_id = ${f.root.id}
            and id <> ${original.note.id} and status = 'active') as active_successor_count
    `;
    expect(durable).toEqual({ receipt_count: 1, active_successor_count: 1 });
  });

  test("serializes sibling creates at the 500-active-note boundary", async () => {
    if (!shared || !client) return;
    const f = await fixture({ child: true });
    const rootAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const childAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.child!.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    await shared.admin.begin(async (sql) => {
      const capabilityId = crypto.randomUUID();
      await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true),
        set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
      await sql`insert into task_note_write_capabilities
        (backend_pid, transaction_id, capability_id)
        values (pg_backend_pid(), pg_current_xact_id(), ${capabilityId})`;
      await sql`select set_config('opengeni.task_note_write_capability', ${capabilityId}, true)`;
      await sql`
        insert into task_notes (
          account_id, workspace_id, root_session_id, kind, text, text_hash,
          expires_at, create_operation_id, create_input_hash,
          created_by_actor_kind, created_by_actor_subject_id,
          created_by_initiating_human_subject_id, created_by_session_id,
          created_by_turn_id, created_by_attempt_id, created_by_execution_generation
        )
        select ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.root.id}, 'finding',
          'seed-' || series::text,
          encode(sha256(convert_to('seed-' || series::text, 'UTF8')), 'hex'),
          now() + interval '1 day', gen_random_uuid(), repeat('a', 64),
          'human', ${f.ownerSubjectId}, ${f.ownerSubjectId}, ${f.root.id},
          ${rootAttempt.turnId}, ${rootAttempt.attemptId}, 1
        from generate_series(1, 499) series
      `;
    });
    const results = await Promise.allSettled([
      withSessionRlsActorContext(
        {
          subjectId: "worker:root",
          initiatingHumanSubjectId: f.ownerSubjectId,
        },
        async () =>
          await createTaskNote(client!.db, {
            ...claims(rootAttempt),
            operationId: crypto.randomUUID(),
            kind: "finding",
            text: "root boundary winner",
            expiresInDays: 1,
          }),
      ),
      withSessionRlsActorContext(
        {
          subjectId: "worker:child",
          initiatingHumanSubjectId: f.ownerSubjectId,
        },
        async () =>
          await createTaskNote(client!.db, {
            ...claims(childAttempt),
            operationId: crypto.randomUUID(),
            kind: "finding",
            text: "child boundary winner",
            expiresInDays: 1,
          }),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect(nestedPostgresSqlState((rejected as PromiseRejectedResult).reason)).toBe("54000");
  });

  test("rejects multibyte payloads beyond the 4096 UTF-8 byte contract", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    await expect(
      createTaskNote(client.db, {
        ...claims(attempt),
        operationId: crypto.randomUUID(),
        kind: "finding",
        text: "🧠".repeat(1_025),
        expiresInDays: 1,
      }),
    ).rejects.toThrow("4096 UTF-8 bytes");
  });
});
