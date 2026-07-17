import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let blank: BlankTestDatabase | null = null;
let available = true;

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

async function withPreMegaDatabase(
  label: string,
  callback: (sql: postgres.Sql) => Promise<void>,
): Promise<void> {
  const database = await acquireBlankTestDatabase(`session-control-mega-${label}`);
  if (!database) {
    if (requireRealDatabase)
      throw new Error("real PostgreSQL is required for mega migration proof");
    return;
  }
  const sql = postgres(database.databaseUrl, { max: 1 });
  try {
    const files = (await readdir(migrationsDir))
      .filter((migrationFile) => migrationFile.endsWith(".sql"))
      .sort();
    for (const migrationFile of files.filter((candidate) => candidate < "0063_")) {
      await applyFile(sql, migrationFile);
    }
    await callback(sql);
  } finally {
    await sql.end().catch(() => undefined);
    await database.release();
  }
}

async function seedAccountWorkspace(
  sql: postgres.Sql,
  suffix: string,
): Promise<{ accountId: string; workspaceId: string }> {
  const [{ id: accountId } = { id: "" }] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values (${`migration ${suffix}`}) returning id`;
  const [{ id: workspaceId } = { id: "" }] = await sql<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}, ${`migration ${suffix}`}) returning id`;
  return { accountId, workspaceId };
}

async function seedSession(
  sql: postgres.Sql,
  input: { accountId: string; workspaceId: string; parentSessionId?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    insert into sessions (
      id, account_id, workspace_id, parent_session_id, status, initial_message,
      model, sandbox_backend, sandbox_group_id, temporal_workflow_id
    ) values (
      ${id}, ${input.accountId}, ${input.workspaceId}, ${input.parentSessionId ?? null},
      'idle', 'migration fixture', 'codex/gpt-5.6-sol', 'none', ${id}, ${`session-${id}`}
    )`;
  return id;
}

async function expectMegaMigrationRollback(
  sql: postgres.Sql,
  expectedMessage: string,
): Promise<void> {
  let failure: unknown = null;
  try {
    const migration = await readFile(
      join(migrationsDir, "0063_session_control_mega_foundation.sql"),
      "utf8",
    );
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(expectedMessage);
  const [{ old_column: oldColumn, new_table: newTable } = { old_column: false, new_table: false }] =
    await sql<Array<{ old_column: boolean; new_table: boolean }>>`
      select
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'sessions' and column_name = 'control_state'
        ) as old_column,
        to_regclass(current_schema() || '.workspace_inference_controls') is not null as new_table`;
  expect(oldColumn).toBe(true);
  expect(newTable).toBe(false);
}

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("session-control-mega-migration");
  if (!blank) {
    if (requireRealDatabase)
      throw new Error("real PostgreSQL is required for mega migration proof");
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0063 session control mega migration", () => {
  test("reconstructs populated control, goal, attempt, and internal-update truth", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir))
        .filter((migrationFile) => migrationFile.endsWith(".sql"))
        .sort();
      for (const migrationFile of files.filter((candidate) => candidate < "0063_")) {
        await applyFile(sql, migrationFile);
      }

      const [{ id: accountId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('mega migration') returning id`;
      const [{ id: workspaceId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into workspaces (
          account_id, name, inference_state, inference_generation,
          inference_reason, inference_changed_by, inference_changed_at
        ) values (
          ${accountId}, 'mega migration', 'paused', 7,
          'maintenance test', 'migration-user', now()
        ) returning id`;
      const parentId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, parent_session_id, status, initial_message,
          model, sandbox_backend, sandbox_group_id, temporal_workflow_id,
          control_state, control_generation, control_reason, control_changed_by,
          control_changed_at, workspace_run_exception_generation
        ) values
          (${parentId}, ${accountId}, ${workspaceId}, null, 'paused', 'parent',
           'codex/gpt-5.6-sol', 'none', ${parentId}, ${`session-${parentId}`},
           'paused', 3, 'user_pause', 'migration-user', now(), null),
          (${childId}, ${accountId}, ${workspaceId}, ${parentId}, 'idle', 'child',
           'codex/gpt-5.6-sol', 'none', ${parentId}, ${`session-${childId}`},
           'active', 2, null, null, null, 7)`;
      await sql`
        update sessions
        set metadata = jsonb_build_object('childNotificationsMode', 'passive', 'retained', true)
        where id = ${parentId}`;

      const turnId = crypto.randomUUID();
      const triggerEventId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, execution_generation,
          active_attempt_id, started_at
        ) values (
          ${turnId}, ${accountId}, ${workspaceId}, ${parentId}, ${triggerEventId},
          ${`session-${parentId}`}, 'requires_action', 'user', 1, 'private prompt',
          'codex/gpt-5.6-sol', 'high', 'none', 4, ${attemptId}, now()
        )`;
      await sql`update sessions set active_turn_id = ${turnId} where id = ${parentId}`;
      const childQueuedTurnId = crypto.randomUUID();
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend
        ) values (
          ${childQueuedTurnId}, ${accountId}, ${workspaceId}, ${childId}, ${crypto.randomUUID()},
          ${`session-${childId}`}, 'queued', 'user', 1, 'queued child prompt',
          'codex/gpt-5.6-sol', 'high', 'none'
        )`;
      await sql`
        insert into session_events (
          account_id, workspace_id, session_id, turn_id, turn_generation,
          turn_attempt_id, turn_association, sequence, type, payload
        ) values (
          ${accountId}, ${workspaceId}, ${parentId}, ${turnId}, 4,
          ${attemptId}, 'current', 1, 'turn.started', '{}'::jsonb
        )`;
      await sql`
        insert into session_pending_tool_calls (
          account_id, workspace_id, session_id, turn_id, execution_generation,
          attempt_id, call_id, call_type, call_item
        ) values (
          ${accountId}, ${workspaceId}, ${parentId}, ${turnId}, 4,
          ${attemptId}, 'call-1', 'function_call',
          ${sql.json({ type: "function_call", callId: "call-1" })}
        )`;
      await sql`
        insert into session_goals (
          account_id, workspace_id, session_id, text, status, paused_reason,
          auto_continuations, no_progress_streak, last_continuation_turn_id,
          version_at_last_continuation
        ) values (
          ${accountId}, ${workspaceId}, ${parentId}, 'private goal', 'paused',
          'user_pause', 3, 2, ${turnId}, 1
        )`;

      const [{ id: taskId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into scheduled_tasks (
          account_id, workspace_id, name, schedule, temporal_schedule_id, agent_config
        ) values (
          ${accountId}, ${workspaceId}, 'task', ${sql.json({ type: "interval", everySeconds: 60 })},
          ${`schedule-${crypto.randomUUID()}`}, ${sql.json({ prompt: "run", resources: [], tools: [], metadata: {} })}
        ) returning id`;
      const scheduledTriggerId = crypto.randomUUID();
      const [{ id: runId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into scheduled_task_runs (
          account_id, workspace_id, task_id, trigger_type, session_id, trigger_event_id
        ) values (
          ${accountId}, ${workspaceId}, ${taskId}, 'schedule', ${parentId}, ${scheduledTriggerId}
        ) returning id`;
      const migratedScheduledTurnId = crypto.randomUUID();
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, finished_at
        ) values (
          ${migratedScheduledTurnId}, ${accountId}, ${workspaceId}, ${parentId},
          ${scheduledTriggerId}, ${`session-${parentId}`}, 'superseded', 'scheduled_task',
          2, 'scheduled private prompt', 'codex/gpt-5.6-sol', 'high', 'none', now()
        )`;
      await sql`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, classification, source_id,
          dedupe_key, summary, payload, lineage
        ) values
          (${accountId}, ${workspaceId}, ${parentId}, 'scheduled_wake', 'info',
           ${migratedScheduledTurnId}::text, ${`migrated-turn:${migratedScheduledTurnId}`},
           'scheduled private prompt',
           ${sql.json({ migratedTurnId: migratedScheduledTurnId, source: "scheduled_task" })},
           ${sql.json({ migratedTurnId: migratedScheduledTurnId })}),
          (${accountId}, ${workspaceId}, ${parentId}, 'runtime_notice', 'info',
           ${childId}::text, ${`session-message:${childId}:one`}, 'agent note',
           ${sql.json({ text: "agent note" })}, ${sql.json({ sourceSessionId: childId })}),
          (${accountId}, ${workspaceId}, ${parentId}, 'lifecycle_event', 'info',
           ${crypto.randomUUID()}::text, ${`goal-continuation:${crypto.randomUUID()}`}, 'continue',
           ${sql.json({ type: "goal_continuation", goalId: crypto.randomUUID(), goalVersion: 2, prompt: "continue" })},
           '{}'::jsonb),
          (${accountId}, ${workspaceId}, ${parentId}, 'child_session_update', 'success',
           ${childId}::text, ${`child-completion:${childId}:one`}, 'child done',
           ${sql.json({ childSessionId: childId, terminalStatus: "idle" })},
           ${sql.json({ childSessionId: childId, parentSessionId: parentId })})`;
      await sql`
        insert into session_system_update_outbox (
          account_id, workspace_id, source_session_id, target_session_id,
          dedupe_key, kind, classification, source_id, summary, payload, lineage
        ) values (
          ${accountId}, ${workspaceId}, ${childId}, ${parentId},
          ${`child-completion:${childId}:pending`}, 'child_session_update', 'success',
          ${childId}::text, 'pending child',
          ${sql.json({ childSessionId: childId, status: "idle" })},
          ${sql.json({ childSessionId: childId, parentSessionId: parentId })}
        )`;

      await applyFile(sql, "0063_session_control_mega_foundation.sql");

      const [parent] = await sql<
        Array<{ status: string; direct: string; override_revision: string | null }>
      >`select status, direct_control_state as direct,
               subtree_run_override_revision::text as override_revision
         from sessions where id = ${parentId}`;
      expect(parent).toEqual({
        status: "requires_action",
        direct: "paused",
        override_revision: null,
      });
      const [parentMetadata] = await sql<Array<{ metadata: Record<string, unknown> }>>`
        select metadata from sessions where id = ${parentId}`;
      expect(parentMetadata?.metadata).toEqual({ retained: true });
      const [child] = await sql<Array<{ direct: string; override_revision: string | null }>>`
        select direct_control_state as direct,
               subtree_run_override_revision::text as override_revision
        from sessions where id = ${childId}`;
      expect(child).toEqual({ direct: "active", override_revision: null });

      const [goal] = await sql<
        Array<{ status: string; paused_reason: string | null; auto: number }>
      >`
        select status, paused_reason, auto_continuations as auto
        from session_goals where session_id = ${parentId}`;
      expect(goal).toEqual({ status: "active", paused_reason: null, auto: 0 });
      const [attempt] = await sql<Array<{ state: string; outcome: string; turn_id: string }>>`
        select state, outcome, turn_id from session_turn_attempts where id = ${attemptId}`;
      expect(attempt).toEqual({ state: "closed", outcome: "pre_cutover_closed", turn_id: turnId });
      const [{ active_attempt_id: activeAttemptId } = { active_attempt_id: "missing" }] = await sql<
        Array<{ active_attempt_id: string | null }>
      >`
          select active_attempt_id from session_turns where id = ${turnId}`;
      expect(activeAttemptId).toBeNull();

      const updates = await sql<Array<{ kind: string; type: string }>>`
        select kind, payload ->> 'type' as type
        from session_system_updates where session_id = ${parentId} order by kind`;
      expect([...updates]).toEqual([
        { kind: "agent_message", type: "agent_message" },
        { kind: "child_terminal_result", type: "child_terminal_result" },
        { kind: "goal_continuation", type: "goal_continuation" },
        { kind: "scheduled_occurrence", type: "scheduled_occurrence" },
      ]);
      const [scheduled] = await sql<Array<{ task_id: string; run_id: string }>>`
        select payload ->> 'scheduledTaskId' as task_id,
               payload ->> 'scheduledTaskRunId' as run_id
        from session_system_updates where kind = 'scheduled_occurrence'`;
      expect(scheduled).toEqual({ task_id: taskId, run_id: runId });
      const [outbox] = await sql<Array<{ kind: string; type: string }>>`
        select kind, payload ->> 'type' as type from session_system_update_outbox`;
      expect(outbox).toEqual({ kind: "child_terminal_result", type: "child_terminal_result" });

      // Dropping the old exact workspace exception is deliberately hold-only:
      // the queued child is not wake-seeded until a real post-cutover Resume
      // creates a newer selected-branch override.
      const blockedContinuability = await sql<Array<{ session_id: string }>>`
        select session_id
        from opengeni_private.list_continuable_sessions(${workspaceId}, ${childId})`;
      expect([...blockedContinuability]).toEqual([]);
      const blockedWake = await sql<Array<{ session_id: string }>>`
        select session_id from session_workflow_wake_outbox where session_id = ${childId}`;
      expect([...blockedWake]).toEqual([]);
      await sql`update workspace_inference_controls set revision = 3 where workspace_id = ${workspaceId}`;
      await sql`
        update sessions
        set subtree_run_override_revision = 3, control_version = 3
        where id = ${childId}`;
      const resumedContinuability = await sql<Array<{ session_id: string; reasons: string[] }>>`
        select session_id, reasons
        from opengeni_private.list_continuable_sessions(${workspaceId}, ${childId})`;
      expect([...resumedContinuability]).toEqual([
        { session_id: childId, reasons: ["queued_human"] },
      ]);

      const audits = await sql<Array<{ action: string }>>`
        select action from audit_events
        where subject_id = 'control-mega-migration' order by action`;
      expect(audits.map((row) => row.action)).toContain(
        "session.control.migration.hold_only_delta",
      );
      expect(audits.map((row) => row.action)).toContain(
        "session.control.migration.workspace_exception_dropped",
      );
      expect(audits.map((row) => row.action)).toContain(
        "session.goal.migration.restored_from_session_pause",
      );

      // The migration rejects malformed ancestry before cutover, but a later
      // manual repair or corrupt write must not turn the live control query
      // into an unbounded recursive CTE. Hold the malformed branch fail-closed.
      const cyclicContinuability = await sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '1s'`;
        await transaction`
          update sessions set parent_session_id = ${childId} where id = ${parentId}`;
        return await transaction<Array<{ session_id: string }>>`
          select session_id
          from opengeni_private.list_continuable_sessions(${workspaceId}, ${parentId})`;
      });
      expect([...cyclicContinuability]).toEqual([]);
    } finally {
      await sql.end().catch(() => undefined);
    }
  }, 180_000);

  test("fails closed and rolls back an unknown legacy internal-update shape", async () => {
    await withPreMegaDatabase("unknown-update", async (sql) => {
      const { accountId, workspaceId } = await seedAccountWorkspace(sql, "unknown-update");
      const sessionId = await seedSession(sql, { accountId, workspaceId });
      await sql`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, classification, source_id,
          dedupe_key, summary, payload, lineage
        ) values (
          ${accountId}, ${workspaceId}, ${sessionId}, 'lifecycle_event', 'info',
          ${crypto.randomUUID()}::text, ${`unknown:${crypto.randomUUID()}`}, 'unknown',
          ${sql.json({ type: "unknown_pre_cutover_shape" })}, '{}'::jsonb
        )`;
      await expectMegaMigrationRollback(
        sql,
        "unclassified session_system_updates row blocks canonical cutover",
      );
    });
  }, 180_000);

  test("fails closed and rolls back when maintenance leaves a running turn", async () => {
    await withPreMegaDatabase("running-turn", async (sql) => {
      const { accountId, workspaceId } = await seedAccountWorkspace(sql, "running-turn");
      const sessionId = await seedSession(sql, { accountId, workspaceId });
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, execution_generation, started_at
        ) values (
          ${crypto.randomUUID()}, ${accountId}, ${workspaceId}, ${sessionId}, ${crypto.randomUUID()},
          ${`session-${sessionId}`}, 'running', 'user', 1, 'running',
          'codex/gpt-5.6-sol', 'high', 'none', 1, now()
        )`;
      await expectMegaMigrationRollback(sql, "running turn survived maintenance drain");
    });
  }, 180_000);

  test("fails closed and rolls back cross-workspace parentage", async () => {
    await withPreMegaDatabase("cross-workspace-parent", async (sql) => {
      const first = await seedAccountWorkspace(sql, "cross-parent-a");
      const [{ id: secondWorkspaceId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${first.accountId}, 'cross-parent-b') returning id`;
      const parentId = await seedSession(sql, first);
      await seedSession(sql, {
        accountId: first.accountId,
        workspaceId: secondWorkspaceId,
        parentSessionId: parentId,
      });
      await expectMegaMigrationRollback(sql, "cross-workspace parent link");
    });
  }, 180_000);

  test("fails closed and rolls back cyclic parentage", async () => {
    await withPreMegaDatabase("cyclic-parent", async (sql) => {
      const scope = await seedAccountWorkspace(sql, "cyclic-parent");
      const firstId = await seedSession(sql, scope);
      const secondId = await seedSession(sql, { ...scope, parentSessionId: firstId });
      await sql`update sessions set parent_session_id = ${secondId} where id = ${firstId}`;
      await expectMegaMigrationRollback(sql, "cyclic session ancestry");
    });
  }, 180_000);
});
