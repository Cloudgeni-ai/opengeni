import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  type BlankTestDatabase,
} from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  captureSessionControlCutoverSnapshot,
  reconcileSessionControlCutover,
} from "../src/session-control-cutover-audit";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);
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
    console.warn(
      "[session-control-cutover-audit] postgres unavailable, skipping",
    );
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
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql"))
        .sort();
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
      const turnIds = [
        runningTurnId,
        queuedUserTurnId,
        scheduledTurnId,
        goalTurnId,
        drainedTurnId,
      ];
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
          captureSessionControlCutoverSnapshot(
            app,
            "baseline",
            "2026-07-14T10:00:00.000Z",
          ),
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
      const migrated = await captureSessionControlCutoverSnapshot(
        sql,
        "migrated",
        "2026-07-14T10:01:00.000Z",
      );
      const result = reconcileSessionControlCutover(
        baseline,
        migrated,
        "migration",
      );
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);

      const main = migrated.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!main) throw new Error("migrated session is missing");
      expect(main.turns.find((turn) => turn.id === runningTurnId)?.status).toBe(
        "recovering",
      );
      expect(
        main.turns.find((turn) => turn.id === queuedUserTurnId)?.status,
      ).toBe("queued");
      expect(
        main.turns.find((turn) => turn.id === scheduledTurnId)?.status,
      ).toBe("superseded");
      expect(main.turns.find((turn) => turn.id === goalTurnId)?.status).toBe(
        "superseded",
      );
      expect(
        main.systemUpdates.some(
          (update) => update.sourceId === scheduledTurnId,
        ),
      ).toBe(true);
      const recovery = migrated.sessions.find(
        (session) => session.id === recoverySessionId,
      );
      if (!recovery) throw new Error("migrated recovery session is missing");
      expect(
        recovery.turns.find((turn) => turn.id === drainedTurnId)?.status,
      ).toBe("recovering");

      const damaged = structuredClone(migrated);
      const damagedMain = damaged.sessions.find(
        (session) => session.id === sessionId,
      );
      const damagedHistory = damagedMain?.history[0];
      if (!damagedHistory) throw new Error("migrated history row is missing");
      damagedHistory.active = false;
      const rejected = reconcileSessionControlCutover(
        baseline,
        damaged,
        "migration",
      );
      expect(rejected.ok).toBe(false);
      expect(
        rejected.errors.some((error) => error.includes("history row")),
      ).toBe(true);
    } finally {
      await sql.end().catch(() => undefined);
    }
  }, 180_000);
});
