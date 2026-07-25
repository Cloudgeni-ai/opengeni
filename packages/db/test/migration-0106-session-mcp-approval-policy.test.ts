import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0106_session_attempt_mcp_approval_policies.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0106-session-mcp-approval-policy");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0106] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("0106 session MCP approval-policy cutover (real PostgreSQL)", () => {
  test("rejects live attempts and preserves closed history with one inert snapshot", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      expect(migrationSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
      expect(migrationSql).not.toMatch(/\bupdate\s+session_turn_attempts\b/i);
      expect(migrationSql).toMatch(
        /add column "mcp_approval_policies" jsonb not null default '\{\}'::jsonb/i,
      );
      expect(migrationSql).toMatch(/alter column "mcp_approval_policies" drop default/i);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0106-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0106-workspace') returning id`;
      const sessionId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'cutover fixture',
          'test-model', 'none', ${sessionId}, ${`session-${sessionId}`}
        )`;
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, resources,
          tools, model, reasoning_effort, sandbox_backend, metadata, lineage,
          execution_generation
        ) values (
          ${turnId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${crypto.randomUUID()},
          ${`session-${sessionId}`}, 'completed', 'user', 1, 'old attempt',
          '[]'::jsonb, '[]'::jsonb, 'test-model', 'low', 'none',
          '{}'::jsonb, '{}'::jsonb, 1
        )`;
      await sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id,
          temporal_activity_id, verified_control_revision
        ) values (
          ${attemptId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
          'running', ${`session-${sessionId}`}, ${crypto.randomUUID()},
          ${crypto.randomUUID()}, 0
        )`;

      let cutoverError: unknown;
      try {
        await sql.unsafe(migrationSql);
      } catch (error) {
        cutoverError = error;
      }
      expect(cutoverError).toBeInstanceOf(Error);
      expect((cutoverError as Error).message).toContain(
        "live session turn attempts must be drained",
      );

      await sql`
        update session_turn_attempts
        set state = 'closed', outcome = 'completed', closed_at = now()
        where id = ${attemptId}`;
      await sql.unsafe(migrationSql);
      const [column] = await sql<Array<{ nullable: string; column_default: string | null }>>`
        select is_nullable as nullable, column_default
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'session_turn_attempts'
          and column_name = 'mcp_approval_policies'`;
      expect(column).toEqual({ nullable: "NO", column_default: null });
      const [historical] = await sql<Array<{ policies: Record<string, unknown> }>>`
        select mcp_approval_policies as policies
        from session_turn_attempts
        where id = ${attemptId}`;
      expect(historical?.policies).toEqual({});

      let missingSnapshotError: unknown;
      try {
        await sql`
          insert into session_turn_attempts (
            id, account_id, workspace_id, session_id, turn_id, execution_generation,
            state, outcome, temporal_workflow_id, temporal_workflow_run_id,
            temporal_activity_id, verified_control_revision, closed_at
          ) values (
            ${crypto.randomUUID()}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
            'closed', 'completed', ${`session-${sessionId}`}, ${crypto.randomUUID()},
            ${crypto.randomUUID()}, 0, now()
          )`;
      } catch (error) {
        missingSnapshotError = error;
      }
      expect((missingSnapshotError as { code?: string }).code).toBe("23502");

      const largePolicy = Object.fromEntries(
        Array.from({ length: 245 }, (_, index) => [`server_${index}`, [`write_${index}`]]),
      );
      await sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, outcome, temporal_workflow_id, temporal_workflow_run_id,
          temporal_activity_id, verified_control_revision, mcp_approval_policies, closed_at
        ) values (
          ${crypto.randomUUID()}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
          'closed', 'completed', ${`session-${sessionId}`}, ${crypto.randomUUID()},
          ${crypto.randomUUID()}, 0, ${sql.json(largePolicy)}, now()
        )`;
    } finally {
      await sql.end();
    }
  }, 300_000);
});
