import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0240_model_context_user_messages.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0240 model context user messages", () => {
  test("hard-fences old writers and installs the generic message-context columns", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain("all opengeni_app sessions to be stopped");
    expect(source).toContain("legacy context-bearing live turns to settle or be superseded");
    expect(source).toContain(
      'RENAME COLUMN "initial_turn_instructions" TO "initial_model_context"',
    );
    expect(source).toContain('RENAME COLUMN "turn_instructions" TO "model_context"');
    expect(source).toContain('ADD COLUMN "model_context" text');
    expect(source).toContain("Completed historical turns retain their original conversation truth");
    expect(source).not.toContain('UPDATE "session_history_items"');
    expect(source).toContain(
      "\"kind\" IN ('delegation_call', 'user_transcript', 'assistant_transcript')",
    );
    expect(source).not.toContain("sessions:turn_instructions");

    const blank = await acquireBlankTestDatabase("migration-0240");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0240-model-context] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const columns = await sql<Array<{ tableName: string; columnName: string }>>`
        select table_name as "tableName", column_name as "columnName"
        from information_schema.columns
        where table_schema = current_schema()
          and (
            (table_name = 'sessions' and column_name in ('initial_model_context', 'initial_turn_instructions'))
            or (table_name = 'session_turns' and column_name in ('model_context', 'turn_instructions'))
            or (table_name = 'session_realtime_entries' and column_name = 'model_context')
          )
        order by table_name, column_name`;
      expect([...columns]).toEqual([
        { tableName: "session_realtime_entries", columnName: "model_context" },
        { tableName: "session_turns", columnName: "model_context" },
        { tableName: "sessions", columnName: "initial_model_context" },
      ]);

      const constraints = await sql<Array<{ name: string; validated: boolean }>>`
        select conname as name, convalidated as validated
        from pg_constraint
        where conname = 'session_realtime_entries_model_context_check'`;
      expect([...constraints]).toEqual([
        { name: "session_realtime_entries_model_context_check", validated: true },
      ]);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
