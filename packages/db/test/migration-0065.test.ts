import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0065");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0065] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0065/0066 (attempt quiescence)", () => {
  test("backfills closed interrupted attempts and installs the rolling lookup index", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const migration0065 = await readFile(
        join(migrationsDir, "0065_session_attempt_quiescence.sql"),
        "utf8",
      );
      expect(migration0065.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
      const pre0065 = files.filter((file) => file < "0065_");
      await admin.unsafe(
        "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const file of pre0065) {
        await admin.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0065-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0065-workspace') returning id`;
      const sessionId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'migration fixture',
          'scripted-model', 'none', ${sessionId}, ${`session-${sessionId}`}
        )`;
      const interruptedAttemptId = crypto.randomUUID();
      const ordinaryAttemptId = crypto.randomUUID();
      const turnIds = [crypto.randomUUID(), crypto.randomUUID()];
      for (let index = 0; index < turnIds.length; index += 1) {
        const [event] = await admin<{ id: string }[]>`
          insert into session_events
            (account_id, workspace_id, session_id, sequence, type, payload)
          values
            (${account!.id}, ${workspace!.id}, ${sessionId}, ${index + 1},
             'user.message', ${JSON.stringify({ text: `turn-${index}` })}::jsonb)
          returning id`;
        await admin`
          insert into session_turns
            (id, account_id, workspace_id, session_id, trigger_event_id,
             temporal_workflow_id, status, source, position, prompt, resources,
             tools, model, reasoning_effort, sandbox_backend, metadata, lineage,
             execution_generation)
          values
            (${turnIds[index]!}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${event!.id},
             ${`session-${sessionId}`}, 'completed', 'user', ${index + 1}, ${`turn-${index}`},
             '[]'::jsonb, '[]'::jsonb, 'scripted-model', 'low', 'none',
             '{}'::jsonb, '{}'::jsonb, 1)`;
      }
      await admin`
        update sessions set last_sequence = 2
        where workspace_id = ${workspace!.id} and id = ${sessionId}`;
      await admin`
        insert into session_turn_attempts
          (id, account_id, workspace_id, session_id, turn_id, execution_generation,
           state, outcome, temporal_workflow_id, temporal_workflow_run_id,
           temporal_activity_id, verified_control_revision, closed_at)
        values
          (${interruptedAttemptId}, ${account!.id}, ${workspace!.id}, ${sessionId},
           ${turnIds[0]!}, 1, 'closed', 'superseded', ${`session-${sessionId}`},
           'migration-run-interrupted', 'migration-activity-interrupted', 1, now() - interval '1 minute'),
          (${ordinaryAttemptId}, ${account!.id}, ${workspace!.id}, ${sessionId},
           ${turnIds[1]!}, 1, 'closed', 'completed', ${`session-${sessionId}`},
           'migration-run-ordinary', 'migration-activity-ordinary', 1, now() - interval '1 minute')`;
      const [receipt] = await admin<{ id: string }[]>`
        insert into session_command_receipts
          (account_id, workspace_id, actor_type, actor_subject_id, action,
           target_session_id, target_turn_id, operation_key, canonical_request_hash)
        values
          (${account!.id}, ${workspace!.id}, 'human', 'migration-0065',
           'session.queue.steer', ${sessionId}, ${turnIds[0]!}, ${crypto.randomUUID()},
           'migration-0065-control')
        returning id`;
      await admin`
        insert into session_attempt_interruptions
          (account_id, workspace_id, session_id, operation_id, attempt_id, kind,
           control_revision, state, settled_at)
        values
          (${account!.id}, ${workspace!.id}, ${sessionId}, ${receipt!.id},
           ${interruptedAttemptId}, 'steer', 1, 'settled', now())`;

      await migrate(blank.databaseUrl);

      const attempts = await admin<
        Array<{ id: string; quiesced_at: Date | null }>
      >`select id, quiesced_at from session_turn_attempts
        where id in (${interruptedAttemptId}, ${ordinaryAttemptId})
        order by id`;
      expect(
        attempts.find((attempt) => attempt.id === interruptedAttemptId)?.quiesced_at,
      ).toBeInstanceOf(Date);
      expect(attempts.find((attempt) => attempt.id === ordinaryAttemptId)?.quiesced_at).toBeNull();
      const [index] = await admin<{ valid: boolean; ready: boolean }[]>`
        select indisvalid as valid, indisready as ready
        from pg_index
        where indexrelid = 'session_attempt_interruptions_attempt_lookup_idx'::regclass`;
      expect(index).toEqual({ valid: true, ready: true });
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 300_000);
});
