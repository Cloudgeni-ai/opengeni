import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0096_session_turn_initiators.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0096-session-turn-initiators");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0096] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0096 immutable session turn initiators (real PostgreSQL)", () => {
  test("backfills legacy rows, defaults rolling old-writer rows, and rejects mutation", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const migrationFile of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, migrationFile), "utf8"));
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0096-account') returning id`;
      if (!account) throw new Error("failed to create migration test account");
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account.id}, 'migration-0096-workspace') returning id`;
      if (!workspace) throw new Error("failed to create migration test workspace");
      const sessionId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model, sandbox_backend,
          sandbox_group_id
        ) values (
          ${sessionId}, ${account.id}, ${workspace.id}, 'legacy session',
          'scripted-model', 'none', ${sessionId}
        )`;
      const legacyTurnId = crypto.randomUUID();
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, sandbox_backend
        ) values (
          ${legacyTurnId}, ${account.id}, ${workspace.id}, ${sessionId},
          ${crypto.randomUUID()}, ${`session-${sessionId}`}, 'queued', 1,
          'legacy prompt', 'scripted-model', 'low', 'none'
        )`;

      await sql.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const [legacy] = await sql<
        Array<{
          createdByKind: string;
          createdBySubjectId: string;
          createdByContext: Record<string, unknown>;
          initiatorKind: string;
          initiatorSubjectId: string;
          initiatorContext: Record<string, unknown>;
        }>
      >`
        select
          s.created_by_kind as "createdByKind",
          s.created_by_subject_id as "createdBySubjectId",
          s.created_by_context as "createdByContext",
          t.initiator_kind as "initiatorKind",
          t.initiator_subject_id as "initiatorSubjectId",
          t.initiator_context as "initiatorContext"
        from sessions s
        join session_turns t on t.session_id = s.id
        where s.id = ${sessionId}`;
      expect(legacy).toEqual({
        createdByKind: "service",
        createdBySubjectId: "unattributed-legacy",
        createdByContext: { backfill: true },
        initiatorKind: "service",
        initiatorSubjectId: "unattributed-legacy",
        initiatorContext: { backfill: true },
      });

      const rollingSessionId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model, sandbox_backend,
          sandbox_group_id
        ) values (
          ${rollingSessionId}, ${account.id}, ${workspace.id}, 'old writer session',
          'scripted-model', 'none', ${rollingSessionId}
        )`;
      const [rolling] = await sql<Array<{ subjectId: string }>>`
        select created_by_subject_id as "subjectId"
        from sessions where id = ${rollingSessionId}`;
      expect(rolling?.subjectId).toBe("unattributed-legacy");

      let mutationError: unknown;
      try {
        await sql`
          update session_turns set initiator_subject_id = 'user:rewritten'
          where id = ${legacyTurnId}`;
      } catch (error) {
        mutationError = error;
      }
      expect(mutationError).toBeInstanceOf(Error);
      expect((mutationError as Error).message).toContain("session turn initiator is immutable");
    } finally {
      await sql.end();
    }
  }, 180_000);
});
