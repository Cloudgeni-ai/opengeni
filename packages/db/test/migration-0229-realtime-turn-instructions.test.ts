import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0229_realtime_turn_instructions.sql", import.meta.url);

describe("migration 0229 realtime turn instructions", () => {
  test("adds bounded private guidance only to turn-bearing provider entries", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ADD COLUMN "turn_instructions" text');
    expect(source).toContain("\"direction\" = 'provider_in'");
    expect(source).toContain("'delegation_call', 'user_transcript', 'assistant_transcript'");
    expect(source).toContain('char_length("turn_instructions") BETWEEN 1 AND 32768');
    expect(source).toContain("NOT VALID");
    expect(source).toContain(
      'VALIDATE CONSTRAINT "session_realtime_entries_turn_instructions_check"',
    );

    const blank = await acquireBlankTestDatabase("migration-0229-realtime-turn-instructions");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [column] = await sql<Array<{ dataType: string; nullable: string }>>`
        select data_type as "dataType", is_nullable as nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'session_realtime_entries'
          and column_name = 'turn_instructions'`;
      expect(column).toEqual({ dataType: "text", nullable: "YES" });

      const [constraint] = await sql<Array<{ definition: string; validated: boolean }>>`
        select pg_get_constraintdef(oid) as definition, convalidated as validated
        from pg_constraint
        where connamespace = current_schema()::regnamespace
          and conname = 'session_realtime_entries_turn_instructions_check'`;
      expect(constraint?.validated).toBe(true);
      expect(constraint?.definition).toContain("provider_in");
      expect(constraint?.definition).toContain("delegation_call");
      expect(constraint?.definition).toContain("user_transcript");
      expect(constraint?.definition).toContain("assistant_transcript");
      expect(constraint?.definition).toContain("32768");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
