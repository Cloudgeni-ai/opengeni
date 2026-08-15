import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
    await sql`
      update session_turns set active_attempt_id = ${attemptId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${turnId}
    `;
    await sql`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
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
