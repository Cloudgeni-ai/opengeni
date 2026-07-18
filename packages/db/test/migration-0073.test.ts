import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0073");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0073] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0073 (durable goal wake)", () => {
  test("arms only idle legacy goals and preserves existing or blocked work", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((candidate) => candidate < "0073_")) {
        await applyFile(admin, file);
      }

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0073-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0073-workspace') returning id`;

      const insertGoalSession = async (text: string) => {
        const sessionId = crypto.randomUUID();
        await admin`
          insert into sessions (
            id, account_id, workspace_id, status, initial_message, model,
            sandbox_backend, sandbox_group_id, temporal_workflow_id
          ) values (
            ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', ${text},
            'scripted-model', 'none', ${sessionId}, ${`session-${sessionId}`}
          )`;
        const [goal] = await admin<{ id: string }[]>`
          insert into session_goals (account_id, workspace_id, session_id, text)
          values (${account!.id}, ${workspace!.id}, ${sessionId}, ${text}) returning id`;
        return { sessionId, goalId: goal!.id };
      };

      const idle = await insertGoalSession("idle legacy goal");
      const materialized = await insertGoalSession("already materialized goal");
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload
        ) values (
          ${account!.id}, ${workspace!.id}, ${materialized.sessionId}, 'goal_continuation',
          ${materialized.goalId}, 'legacy-goal-continuation', 'already pending',
          ${admin.json({
            type: "goal_continuation",
            goalId: materialized.goalId,
            goalVersion: 1,
            autoContinuation: 1,
            maxAutoContinuations: null,
            prompt: "continue",
            policy: {
              model: "scripted-model",
              reasoningEffort: "low",
              tools: [],
              sandboxBackend: "none",
            },
          })}
        )`;

      const humanQueued = await insertGoalSession("human queued goal");
      await admin`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt,
          model, reasoning_effort, sandbox_backend
        ) values (
          ${account!.id}, ${workspace!.id}, ${humanQueued.sessionId}, ${crypto.randomUUID()},
          ${`session-${humanQueued.sessionId}`}, 'queued', 'user', 1, 'human prompt',
          'scripted-model', 'low', 'none'
        )`;

      const capacityBlocked = await insertGoalSession("capacity blocked goal");
      const blockedTurnId = crypto.randomUUID();
      await admin`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt,
          model, reasoning_effort, sandbox_backend
        ) values (
          ${blockedTurnId}, ${account!.id}, ${workspace!.id}, ${capacityBlocked.sessionId},
          ${crypto.randomUUID()}, ${`session-${capacityBlocked.sessionId}`},
          'waiting_capacity', 'goal', 1, 'goal continuation',
          'scripted-model', 'low', 'none'
        )`;
      await admin`
        insert into codex_capacity_waiters (
          account_id, workspace_id, session_id, goal_id, blocked_turn_id,
          workflow_id, goal_version, next_check_at, reset_kind
        ) values (
          ${account!.id}, ${workspace!.id}, ${capacityBlocked.sessionId},
          ${capacityBlocked.goalId}, ${blockedTurnId}, ${`session-${capacityBlocked.sessionId}`},
          1, now() + interval '1 hour', 'authoritative'
        )`;

      await applyFile(admin, "0073_durable_goal_wake.sql");

      const goals = await admin<
        Array<{
          text: string;
          wake_revision: number;
          observed_revision: number;
        }>
      >`
        select text,
          continuation_wake_revision::integer as wake_revision,
          continuation_observed_revision::integer as observed_revision
        from session_goals order by text`;
      expect(
        goals.map(({ text, wake_revision, observed_revision }) => ({
          text,
          wake_revision,
          observed_revision,
        })),
      ).toEqual([
        { text: "already materialized goal", wake_revision: 1, observed_revision: 1 },
        { text: "capacity blocked goal", wake_revision: 0, observed_revision: 0 },
        { text: "human queued goal", wake_revision: 0, observed_revision: 0 },
        { text: "idle legacy goal", wake_revision: 1, observed_revision: 0 },
      ]);

      const wakes = await admin<
        Array<{ session_id: string; reason: string; wake_revision: number }>
      >`
        select session_id, reason, wake_revision::integer as wake_revision
        from session_workflow_wake_outbox order by session_id`;
      expect(
        wakes.map(({ session_id, reason, wake_revision }) => ({
          session_id,
          reason,
          wake_revision,
        })),
      ).toEqual([
        {
          session_id: idle.sessionId,
          reason: "goal_obligation_backfill",
          wake_revision: 1,
        },
      ]);

      let rejectedInvalidRevision = false;
      try {
        await admin`
          update session_goals
          set continuation_observed_revision = continuation_wake_revision + 1
          where id = ${idle.goalId}`;
      } catch {
        rejectedInvalidRevision = true;
      }
      expect(rejectedInvalidRevision).toBe(true);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 180_000);
});
