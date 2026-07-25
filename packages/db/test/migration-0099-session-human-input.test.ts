import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0100_session_human_input_requests.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0099-session-human-input");
  if (!blank) {
    if (requireRealDatabase) throw new Error("[migration-0099] real PostgreSQL is unavailable");
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 60_000);

describe("0099/0100 durable structured human input (real PostgreSQL)", () => {
  test("installs the strong attempt owner, bounds, RLS, and populated cascade path", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0099-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0099-workspace') returning id`;
      const sessionId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'migration fixture',
          'scripted-model', 'none', ${sessionId}, ${`session-${sessionId}`}
        )`;
      const [trigger] = await sql<{ id: string }[]>`
        insert into session_events
          (account_id, workspace_id, session_id, sequence, type, payload)
        values
          (${account!.id}, ${workspace!.id}, ${sessionId}, 1, 'user.message', '{"text":"ask"}'::jsonb)
        returning id`;
      const turnId = crypto.randomUUID();
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, resources,
          tools, model, reasoning_effort, sandbox_backend, metadata, lineage,
          execution_generation
        ) values (
          ${turnId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${trigger!.id},
          ${`session-${sessionId}`}, 'completed', 'user', 1, 'ask', '[]'::jsonb,
          '[]'::jsonb, 'scripted-model', 'low', 'none', '{}'::jsonb, '{}'::jsonb, 1
        )`;
      const attemptId = crypto.randomUUID();
      await sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, outcome, temporal_workflow_id, temporal_workflow_run_id,
          temporal_activity_id, verified_control_revision, closed_at
        ) values (
          ${attemptId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
          'closed', 'completed', ${`session-${sessionId}`}, ${crypto.randomUUID()},
          ${crypto.randomUUID()}, 0, now()
        )`;

      await sql.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const requestId = crypto.randomUUID();
      await sql`
        insert into session_human_input_requests (
          id, account_id, workspace_id, session_id, turn_id, turn_generation,
          creation_attempt_id, tool_call_id, questions
        ) values (
          ${requestId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
          ${attemptId}, 'migration-human-call',
          '[{"id":"q","kind":"text","prompt":"Why?","options":[],"required":true,"allowOther":false}]'::jsonb
        )`;
      const [stored] = await sql<Array<{ status: string }>>`
        select status from session_human_input_requests where id = ${requestId}`;
      expect(stored).toEqual({ status: "pending" });

      let foreignKeyError: unknown;
      try {
        await sql`
          insert into session_human_input_requests (
            account_id, workspace_id, session_id, turn_id, turn_generation,
            creation_attempt_id, tool_call_id, questions
          ) values (
            ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
            ${crypto.randomUUID()}, 'foreign-attempt', '[]'::jsonb
          )`;
      } catch (error) {
        foreignKeyError = error;
      }
      expect(foreignKeyError).toBeInstanceOf(Error);

      const [rls] = await sql<Array<{ enabled: boolean; forced: boolean }>>`
        select relrowsecurity as enabled, relforcerowsecurity as forced
        from pg_class where oid = 'session_human_input_requests'::regclass`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const [policy] = await sql<Array<{ name: string }>>`
        select policyname as name from pg_policies
        where schemaname = current_schema()
          and tablename = 'session_human_input_requests'
          and policyname = 'workspace_isolation'`;
      expect(policy).toEqual({ name: "workspace_isolation" });

      await sql`delete from session_turn_attempts where id = ${attemptId}`;
      const [remaining] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from session_human_input_requests where id = ${requestId}`;
      expect(remaining).toEqual({ count: 0 });
    } finally {
      await sql.end();
    }
  }, 300_000);
});
