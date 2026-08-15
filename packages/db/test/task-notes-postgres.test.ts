import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  archiveTaskNote,
  createDb,
  createSession,
  createTaskNote,
  ensureManagedAccessForUser,
  grantWorkspaceAccess,
  listTaskNotes,
  nestedPostgresSqlState,
  transitionSessionVisibility,
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
          async () => await createTaskNote(client!.db, { ...input, ...claims(otherTreeAttempt) }),
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
    const recovery = await seedAttempt({ ...attempt, generation: 2, turnId: attempt.turnId });
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
      { subjectId: "worker:create", initiatingHumanSubjectId: f.ownerSubjectId },
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
      { subjectId: "worker:archive", initiatingHumanSubjectId: f.ownerSubjectId },
      async () => await archiveTaskNote(client!.db, archiveInput),
    );
    const replay = await withSessionRlsActorContext(
      { subjectId: "worker:archive", initiatingHumanSubjectId: f.ownerSubjectId },
      async () => await archiveTaskNote(client!.db, archiveInput),
    );
    expect(archived.note).toMatchObject({ id: created.note.id, status: "archived", version: 2 });
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
        { subjectId: "worker:root", initiatingHumanSubjectId: f.ownerSubjectId },
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
        { subjectId: "worker:child", initiatingHumanSubjectId: f.ownerSubjectId },
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
