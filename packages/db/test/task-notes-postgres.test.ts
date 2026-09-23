import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  archiveTaskNote,
  saveAgentLearningSettings,
  promoteTaskNoteToKnowledge,
  getKnowledgeEntry,
  type KnowledgeContext,
  createDb,
  createSession,
  createTaskNote,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  grantWorkspaceAccess,
  listTaskNotes,
  nestedPostgresSqlState,
  replaceTaskNote,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
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
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const privateSessionSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
    enabled: true,
    expectedVersion: privateSessionSettings.version,
    operationId: crypto.randomUUID(),
  });
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
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: ownerSubjectId },
        createdByContext: {},
      }),
  );
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
            reasoningEffort: "medium" as const,
            latencyMode: "standard" as const,
            sandboxBackend: "none",
            createdBy: { kind: "subject", subjectId: ownerSubjectId },
            createdByContext: {},
          }),
      )
    : null;
  if (options.privateRoot) {
    await transitionSessionVisibility(client.db, {
      workspaceId: grant.workspaceId,
      sessionId: root.id,
      actorSubjectId: ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `private-root-${suffix}`,
    });
    if (child) {
      await transitionSessionVisibility(client.db, {
        workspaceId: grant.workspaceId,
        sessionId: child.id,
        actorSubjectId: ownerSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `private-child-${suffix}`,
      });
    }
  }
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
  test("Knowledge Off leaves task notes available but blocks durable promotion", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    await saveAgentLearningSettings(
      client.db,
      {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        actor: {
          kind: "human",
          principalKind: "human_session",
          subjectId: f.ownerSubjectId,
          writeScopes: ["workspace"],
          settingsScopes: ["workspace"],
          review: true,
        },
      },
      {
        scope: "workspace",
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        settings: { knowledge: "off", instructions: "review_first", skills: "review_first" },
      },
    );
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const { note } = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "finding",
      text: "Temporary coordination remains available.",
      expiresInDays: 7,
    });
    const context: KnowledgeContext = {
      accountId: attempt.accountId,
      workspaceId: attempt.workspaceId,
      actor: {
        kind: "agent",
        sessionId: attempt.sessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
    };
    await expectSqlState(
      () =>
        promoteTaskNoteToKnowledge(client!.db, context, {
          operationId: crypto.randomUUID(),
          entryId: crypto.randomUUID(),
          expectedVersion: 0,
          noteId: note.id,
          expectedNoteVersion: 1,
          title: "Finding",
        }),
      "42501",
    );
    expect(note.text).toBe("Temporary coordination remains available.");
  });

  test("native promotion ignores TEMP shadows and preserves exact note evidence", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const { note } = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "finding",
      text: "Use the durable note, never a caller's temporary table.",
      expiresInDays: 7,
    });
    const context: KnowledgeContext = {
      accountId: attempt.accountId,
      workspaceId: attempt.workspaceId,
      actor: {
        kind: "agent",
        sessionId: attempt.sessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
    };
    const saved = await client.db.transaction(async (tx) => {
      for (const table of [
        "sessions",
        "session_turns",
        "session_turn_attempts",
        "task_notes",
        "agent_learning_revisions",
        "agent_learning_snapshots",
        "knowledge_entries",
      ]) {
        await tx.execute(
          drizzleSql.raw(`CREATE TEMPORARY TABLE ${table} (trap text) ON COMMIT DROP`),
        );
      }
      return promoteTaskNoteToKnowledge(tx, context, {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        noteId: note.id,
        expectedNoteVersion: 1,
        title: "Retained finding",
      });
    });
    expect(saved.outcome).toBe("published");
    expect(
      (await getKnowledgeEntry(client.db, context, saved.entryId))?.revision.entry.content,
    ).toBe(note.text);
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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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

describe("task-tree notes expiry ceiling (widened to 90 days)", () => {
  test("createTaskNote accepts exactly 90 days and rejects 91", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      initiatorSubjectId: f.ownerSubjectId,
      initiatingHumanSubjectId: f.ownerSubjectId,
    });
    const accepted = await createTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      kind: "finding",
      text: "A note that should survive a long pause between sessions.",
      expiresInDays: 90,
    });
    const createdAt = new Date(accepted.note.createdAt).getTime();
    const expiresAt = new Date(accepted.note.expiresAt).getTime();
    expect(Math.round((expiresAt - createdAt) / (24 * 60 * 60 * 1000))).toBe(90);

    await expect(
      createTaskNote(client.db, {
        ...claims(attempt),
        operationId: crypto.randomUUID(),
        kind: "finding",
        text: "A note that asks for one day too many.",
        expiresInDays: 91,
      }),
    ).rejects.toThrow("Task note expiry must be 1-90 whole days");
  });

  test("replaceTaskNote accepts exactly 90 days and rejects 91", async () => {
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
      text: "The original note before a long-lived replacement.",
      expiresInDays: 7,
    });
    const replaced = await replaceTaskNote(client.db, {
      ...claims(attempt),
      operationId: crypto.randomUUID(),
      replacedNoteId: original.note.id,
      expectedReplacedVersion: 1,
      replacementKind: "decision",
      replacementText: "The replacement note that should survive 90 days.",
      replacementExpiresInDays: 90,
      reason: "Extend the note lifetime to 90 days.",
    });
    expect(replaced.replacement.status).toBe("active");

    await expect(
      replaceTaskNote(client.db, {
        ...claims(attempt),
        operationId: crypto.randomUUID(),
        replacedNoteId: replaced.replacement.id,
        expectedReplacedVersion: 1,
        replacementKind: "decision",
        replacementText: "A replacement that asks for one day too many.",
        replacementExpiresInDays: 91,
        reason: "Try to exceed the widened ceiling.",
      }),
    ).rejects.toThrow("Task-note replacement requires version 1 and a 1-90 day expiry");
  });
});
