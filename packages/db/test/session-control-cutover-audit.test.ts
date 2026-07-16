import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  captureSessionControlCutoverSnapshot,
  reconcileSessionControlCutover,
} from "../src/session-control-cutover-audit";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

function requiredRow<T>(rows: T[], description: string): T {
  const row = rows[0];
  if (!row) throw new Error(`missing ${description}`);
  return row;
}

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("session-control-cutover-audit");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[session-control-cutover-audit] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
    console.warn("[session-control-cutover-audit] postgres unavailable, skipping");
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("session-control production cutover audit", () => {
  test("proves the one-way migration without exporting model or user content", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const oldFiles = files.filter((file) => file < "0057_");
      await sql.unsafe(
        `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
      );
      for (const file of oldFiles) {
        await applyFile(sql, file);
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const accountId = requiredRow(
        await sql<{ id: string }[]>`
            insert into managed_accounts (name) values ('cutover audit account') returning id`,
        "cutover audit account",
      ).id;
      const workspaceId = requiredRow(
        await sql<{ id: string }[]>`
            insert into workspaces (account_id, name)
            values (${accountId}, 'cutover audit workspace') returning id`,
        "cutover audit workspace",
      ).id;
      const sessionId = crypto.randomUUID();
      const recoverySessionId = crypto.randomUUID();
      await sql`
          insert into sessions (
            id, account_id, workspace_id, status, initial_message, model,
            sandbox_backend, sandbox_group_id, temporal_workflow_id
          ) values
            (${sessionId}, ${accountId}, ${workspaceId}, 'running', 'SECRET_INITIAL_MESSAGE',
             'codex/gpt-5.6-sol', 'modal', ${sessionId}, ${`session-${sessionId}`}),
            (${recoverySessionId}, ${accountId}, ${workspaceId}, 'queued', 'SECRET_RECOVERY_MESSAGE',
             'codex/gpt-5.6-sol', 'modal', ${recoverySessionId}, ${`session-${recoverySessionId}`})`;

      const runningTurnId = crypto.randomUUID();
      const queuedUserTurnId = crypto.randomUUID();
      const scheduledTurnId = crypto.randomUUID();
      const goalTurnId = crypto.randomUUID();
      const drainedTurnId = crypto.randomUUID();
      const turnIds = [runningTurnId, queuedUserTurnId, scheduledTurnId, goalTurnId, drainedTurnId];
      const triggerIds = turnIds.map(() => crypto.randomUUID());
      await sql`
          insert into session_turns (
            id, account_id, workspace_id, session_id, trigger_event_id,
            temporal_workflow_id, status, source, position, prompt, model,
            reasoning_effort, sandbox_backend, started_at
          ) values
            (${runningTurnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${triggerIds[0]!},
             ${`session-${sessionId}`}, 'running', 'user', 1, 'SECRET_RUNNING_PROMPT',
             'codex/gpt-5.6-sol', 'high', 'modal', now()),
            (${queuedUserTurnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${triggerIds[1]!},
             ${`session-${sessionId}`}, 'queued', 'user', 2, 'SECRET_QUEUED_PROMPT',
             'codex/gpt-5.6-sol', 'high', 'modal', null),
            (${scheduledTurnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${triggerIds[2]!},
             ${`session-${sessionId}`}, 'queued', 'scheduled_task', 3, 'SECRET_SCHEDULED_PROMPT',
             'codex/gpt-5.6-sol', 'high', 'modal', null),
            (${goalTurnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${triggerIds[3]!},
             ${`session-${sessionId}`}, 'queued', 'goal', 4, 'SECRET_GOAL_PROMPT',
             'codex/gpt-5.6-sol', 'high', 'modal', null),
            (${drainedTurnId}, ${accountId}, ${workspaceId}, ${recoverySessionId}, ${triggerIds[4]!},
             ${`session-${recoverySessionId}`}, 'queued', 'user', 1, 'SECRET_DRAINED_PROMPT',
             'codex/gpt-5.6-sol', 'high', 'modal', now())`;
      await sql`update sessions set active_turn_id = ${runningTurnId} where id = ${sessionId}`;

      const eventIds = turnIds.map(() => crypto.randomUUID());
      await sql`
          insert into session_events (
            id, account_id, workspace_id, session_id, turn_id, sequence, type, payload
          ) values
            (${eventIds[0]!}, ${accountId}, ${workspaceId}, ${sessionId}, ${runningTurnId}, 1,
             'turn.started', ${sql.json({ secret: "SECRET_EVENT_PAYLOAD" })}),
            (${eventIds[1]!}, ${accountId}, ${workspaceId}, ${recoverySessionId}, ${drainedTurnId}, 1,
             'turn.started', ${sql.json({ secret: "SECRET_RECOVERY_EVENT" })})`;

      const goalId = requiredRow(
        await sql<{ id: string }[]>`
            insert into session_goals (account_id, workspace_id, session_id, text)
            values (${accountId}, ${workspaceId}, ${sessionId}, 'SECRET_GOAL_TEXT') returning id`,
        "cutover audit goal",
      ).id;
      await sql`
          insert into codex_capacity_waiters (
            account_id, workspace_id, session_id, goal_id, blocked_turn_id, workflow_id,
            status, goal_version, next_check_at, reset_kind, resumed_turn_id
          ) values (
            ${accountId}, ${workspaceId}, ${sessionId}, ${goalId}, ${runningTurnId},
            ${`session-${sessionId}`}, 'resumed', 1, now(), 'bounded_refresh', ${runningTurnId}
          )`;
      await sql`
          insert into session_history_items (
            account_id, workspace_id, session_id, turn_id, position, item
          ) values (
            ${accountId}, ${workspaceId}, ${sessionId}, ${runningTurnId}, 1,
            ${sql.json({ role: "user", content: "SECRET_MODEL_HISTORY" })}
          )`;
      await sql`
          insert into agent_run_states (
            account_id, workspace_id, session_id, turn_id, state_version,
            serialized_run_state, pending_approvals
          ) values (
            ${accountId}, ${workspaceId}, ${sessionId}, ${runningTurnId}, 1,
            ${JSON.stringify({ $schemaVersion: "1.12", secret: "SECRET_RUN_STATE" })},
            ${sql.json([{ id: "approval-with-secret" }])}
          )`;
      await sql`
          insert into sandbox_leases (
            account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at
          ) values (${accountId}, ${workspaceId}, ${sessionId}, 'warm', 'modal', now() + interval '1 hour')`;

      const baseline = await captureSessionControlCutoverSnapshot(
        sql,
        "baseline",
        "2026-07-14T10:00:00.000Z",
      );
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      const app = postgres(appUrl.toString(), { max: 1 });
      try {
        await expect(
          captureSessionControlCutoverSnapshot(app, "baseline", "2026-07-14T10:00:00.000Z"),
        ).rejects.toThrow("requires a superuser or BYPASSRLS role");
      } finally {
        await app.end().catch(() => undefined);
      }
      const serialized = JSON.stringify(baseline);
      for (const secret of [
        "SECRET_INITIAL_MESSAGE",
        "SECRET_RECOVERY_MESSAGE",
        "SECRET_RUNNING_PROMPT",
        "SECRET_QUEUED_PROMPT",
        "SECRET_SCHEDULED_PROMPT",
        "SECRET_GOAL_PROMPT",
        "SECRET_DRAINED_PROMPT",
        "SECRET_EVENT_PAYLOAD",
        "SECRET_RECOVERY_EVENT",
        "SECRET_GOAL_TEXT",
        "SECRET_MODEL_HISTORY",
        "SECRET_RUN_STATE",
      ]) {
        expect(serialized).not.toContain(secret);
      }

      await applyFile(sql, "0057_durable_queue_control.sql");
      await sql`
          insert into schema_migrations (name)
          values ('0057_durable_queue_control.sql') on conflict do nothing`;

      const migrated0057 = await captureSessionControlCutoverSnapshot(
        sql,
        "migrated",
        "2026-07-14T10:00:30.000Z",
        baseline,
      );
      const migrated0057Result = reconcileSessionControlCutover(
        baseline,
        migrated0057,
        "migration",
      );
      expect(migrated0057Result.errors).toEqual([]);
      expect(migrated0057Result.ok).toBe(true);

      // A historical capacity settlement could leave one terminal owner while
      // tool receipts from several activity attempts accumulated on the same
      // logical turn. The repair closes the whole turn lineage, not only the
      // receipt whose attempt happens to match the retained owner.
      const capacitySessionId = crypto.randomUUID();
      const capacityTurnId = crypto.randomUUID();
      const capacityAttemptId = crypto.randomUUID();
      const previousCapacityAttemptId = crypto.randomUUID();
      await sql`
          insert into sessions (
            id, account_id, workspace_id, status, initial_message, model,
            sandbox_backend, sandbox_group_id, temporal_workflow_id, last_sequence
          ) values (
            ${capacitySessionId}, ${accountId}, ${workspaceId}, 'idle', 'capacity residue',
            'codex/gpt-5.6-sol', 'modal', ${capacitySessionId},
            ${`session-${capacitySessionId}`}, 1
          )`;
      await sql`
          insert into session_turns (
            id, account_id, workspace_id, session_id, trigger_event_id,
            temporal_workflow_id, status, source, position, prompt, model,
            reasoning_effort, sandbox_backend, started_at, finished_at,
            execution_generation, active_attempt_id
          ) values (
            ${capacityTurnId}, ${accountId}, ${workspaceId}, ${capacitySessionId},
            ${crypto.randomUUID()}, ${`session-${capacitySessionId}`}, 'failed', 'user', 1,
            'capacity residue', 'codex/gpt-5.6-sol', 'high', 'modal', now(), now(),
            4, ${capacityAttemptId}
          )`;
      await sql`
          insert into session_events (
            account_id, workspace_id, session_id, turn_id, sequence, type, payload
          ) values (
            ${accountId}, ${workspaceId}, ${capacitySessionId}, ${capacityTurnId}, 1,
            'turn.failed', ${sql.json({ code: "codex_usage_limit_reached" })}
          )`;
      await sql`
          insert into session_pending_tool_calls (
            account_id, workspace_id, session_id, turn_id, execution_generation,
            attempt_id, call_id, call_type, call_item
          ) values
            (${accountId}, ${workspaceId}, ${capacitySessionId}, ${capacityTurnId}, 3,
             ${previousCapacityAttemptId}, 'previous-attempt-call', 'function_call',
             ${sql.json({ type: "function_call", callId: "previous-attempt-call" })}),
            (${accountId}, ${workspaceId}, ${capacitySessionId}, ${capacityTurnId}, 4,
             ${capacityAttemptId}, 'current-attempt-call', 'function_call',
             ${sql.json({ type: "function_call", callId: "current-attempt-call" })})`;

      const usageEventIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      await sql`
          insert into session_events (
            id, account_id, workspace_id, session_id, turn_id, turn_generation,
            turn_association, sequence, type, payload
          ) values
            (${usageEventIds[0]!}, ${accountId}, ${workspaceId}, ${sessionId}, ${runningTurnId}, 1,
             'current', 35, 'agent.model.usage', ${sql.json({ sourceKey: "response-duplicate" })}),
            (${usageEventIds[1]!}, ${accountId}, ${workspaceId}, ${sessionId}, ${runningTurnId}, 1,
             'current', 36, 'agent.model.usage', ${sql.json({ sourceKey: "response-duplicate" })}),
            (${usageEventIds[2]!}, ${accountId}, ${workspaceId}, ${sessionId}, ${runningTurnId}, 1,
             'current', 37, 'agent.model.usage', ${sql.json({ sourceKey: "response-duplicate" })})`;

      const remediationBaseline = await captureSessionControlCutoverSnapshot(
        sql,
        "baseline",
        "2026-07-14T10:00:45.000Z",
      );

      await applyFile(sql, "0058_turn_admission_usage_enrollment.sql");
      await sql`
          insert into schema_migrations (name)
          values ('0058_turn_admission_usage_enrollment.sql') on conflict do nothing`;

      await sql`delete from session_pending_tool_calls where turn_id = ${capacityTurnId}`;
      await sql`
          update session_turns set active_attempt_id = null where id = ${capacityTurnId}`;
      await sql`
          insert into session_events (
            account_id, workspace_id, session_id, turn_id, turn_generation,
            turn_attempt_id, turn_association, sequence, type, payload
          ) values
            (${accountId}, ${workspaceId}, ${capacitySessionId}, ${capacityTurnId}, 3,
             ${previousCapacityAttemptId}, 'current', 2, 'agent.toolCall.output',
             ${sql.json({ recovery: { outcome: "unknown" } })}),
            (${accountId}, ${workspaceId}, ${capacitySessionId}, ${capacityTurnId}, 4,
             ${capacityAttemptId}, 'current', 3, 'agent.toolCall.output',
             ${sql.json({ recovery: { outcome: "unknown" } })})`;
      await sql`
          insert into session_history_items (
            account_id, workspace_id, session_id, turn_id, position, item
          ) values
            (${accountId}, ${workspaceId}, ${capacitySessionId}, ${capacityTurnId}, 1,
             ${sql.json({ type: "function_call_result", status: "incomplete" })}),
            (${accountId}, ${workspaceId}, ${capacitySessionId}, ${capacityTurnId}, 2,
             ${sql.json({ type: "function_call_result", status: "incomplete" })})`;
      await sql`
          update sessions set last_sequence = 3 where id = ${capacitySessionId}`;

      const classifiedUsage = await sql<
        Array<{
          id: string;
          turn_association: string;
          duplicate_of_event_id: string | null;
          duplicate_reason: string | null;
        }>
      >`
          select id, turn_association, duplicate_of_event_id, duplicate_reason
          from session_events
          where id in (${usageEventIds[0]!}, ${usageEventIds[1]!}, ${usageEventIds[2]!})
          order by sequence`;
      expect([...classifiedUsage]).toEqual([
        {
          id: usageEventIds[0]!,
          turn_association: "current",
          duplicate_of_event_id: null,
          duplicate_reason: null,
        },
        {
          id: usageEventIds[1]!,
          turn_association: "duplicate",
          duplicate_of_event_id: usageEventIds[0]!,
          duplicate_reason: "duplicate_provider_response_usage",
        },
        {
          id: usageEventIds[2]!,
          turn_association: "duplicate",
          duplicate_of_event_id: usageEventIds[0]!,
          duplicate_reason: "duplicate_provider_response_usage",
        },
      ]);
      const enrollable = await sql<Array<{ session_id: string }>>`
          select session_id
          from opengeni_private.list_enrollable_sessions(10000)
          order by session_id`;
      expect(enrollable.map((row) => row.session_id)).toEqual(
        [sessionId, recoverySessionId].sort(),
      );

      // Maintenance repair is allowed to append explicit evidence/model truth,
      // but the complete baseline prefix must remain byte-for-byte preserved.
      await sql`
          insert into session_events (
            account_id, workspace_id, session_id, turn_id, sequence, type, payload
          ) values (
            ${accountId}, ${workspaceId}, ${sessionId}, ${runningTurnId}, 38,
            'agent.toolCall.output', ${sql.json({ recovery: { outcome: "unknown" } })}
          )`;
      await sql`
          insert into session_history_items (
            account_id, workspace_id, session_id, turn_id, position, item
          ) values (
            ${accountId}, ${workspaceId}, ${sessionId}, ${runningTurnId}, 2,
            ${sql.json({ type: "function_call_result", status: "incomplete" })}
          )`;

      const migrated = await captureSessionControlCutoverSnapshot(
        sql,
        "migrated",
        "2026-07-14T10:01:00.000Z",
        remediationBaseline,
      );
      const result = reconcileSessionControlCutover(remediationBaseline, migrated, "migration");
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(
        migrated.sessions.find((session) => session.id === capacitySessionId)?.pendingToolCalls,
      ).toEqual([]);

      const main = migrated.sessions.find((session) => session.id === sessionId);
      if (!main) throw new Error("migrated session is missing");
      expect(main.turns.find((turn) => turn.id === runningTurnId)?.status).toBe("recovering");
      expect(main.turns.find((turn) => turn.id === queuedUserTurnId)?.status).toBe("queued");
      expect(main.turns.find((turn) => turn.id === scheduledTurnId)?.status).toBe("superseded");
      expect(main.turns.find((turn) => turn.id === goalTurnId)?.status).toBe("superseded");
      expect(main.systemUpdates.some((update) => update.sourceId === scheduledTurnId)).toBe(true);
      const recovery = migrated.sessions.find((session) => session.id === recoverySessionId);
      if (!recovery) throw new Error("migrated recovery session is missing");
      expect(recovery.turns.find((turn) => turn.id === drainedTurnId)?.status).toBe("recovering");

      const damaged = structuredClone(migrated);
      const damagedMain = damaged.sessions.find((session) => session.id === sessionId);
      if (!damagedMain) throw new Error("migrated session is missing");
      damagedMain.historyProof.preservedStableSha256 = "0".repeat(64);
      const rejected = reconcileSessionControlCutover(remediationBaseline, damaged, "migration");
      expect(rejected.ok).toBe(false);
      expect(rejected.errors.some((error) => error.includes("history changed"))).toBe(true);

      await sql`
          insert into session_events (
            account_id, workspace_id, session_id, turn_id, sequence, type, payload
          ) values (
            ${accountId}, ${workspaceId}, ${sessionId}, ${queuedUserTurnId}, 39,
            'agent.message', ${sql.json({ text: "POST_CUTOVER_EVENT" })}
          )`;
      await sql`
          insert into session_history_items (
            account_id, workspace_id, session_id, turn_id, position, item
          ) values (
            ${accountId}, ${workspaceId}, ${sessionId}, ${queuedUserTurnId}, 3,
            ${sql.json({ role: "assistant", content: "POST_CUTOVER_HISTORY" })}
          )`;
      const final = await captureSessionControlCutoverSnapshot(
        sql,
        "final",
        "2026-07-14T10:02:00.000Z",
        remediationBaseline,
      );
      const finalResult = reconcileSessionControlCutover(remediationBaseline, final, "final-fate");
      expect(finalResult.errors).toEqual([]);
      expect(finalResult.ok).toBe(true);
      expect(final.sessions.find((session) => session.id === sessionId)?.eventProof.count).toBe(6);
    } finally {
      await sql.end().catch(() => undefined);
    }
  }, 180_000);
});
