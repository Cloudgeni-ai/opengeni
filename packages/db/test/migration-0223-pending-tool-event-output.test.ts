import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0223_pending_tool_event_output.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0223 pending tool event output", () => {
  test("reconciles its constraint and trigger after SQL commits before the ledger marker", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain(
      "DROP CONSTRAINT IF EXISTS session_pending_tool_calls_event_output_codec_version_chk",
    );
    expect(source).toContain(
      "DROP TRIGGER IF EXISTS session_pending_tool_calls_event_output_delete_guard",
    );

    const blank = await acquireBlankTestDatabase("migration-0223-pending-tool-event-output");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await sql`insert into schema_migrations (name) values (${migrationName})`;
      await migrate(blank.databaseUrl);

      await sql`delete from schema_migrations where name = ${migrationName}`;
      await sql.unsafe(source);

      // Simulate process/connection loss after the migration transaction
      // committed but before the runner inserted schema_migrations. The next
      // process must reconcile the exact DDL and record the marker cleanly.
      await migrate(blank.databaseUrl);
      await migrate(blank.databaseUrl);

      const [marker] = await sql<{ count: number }[]>`
        select count(*)::integer as count
        from schema_migrations
        where name = ${migrationName}`;
      expect(marker?.count).toBe(1);

      const [constraint] = await sql<{ definition: string; validated: boolean }[]>`
        select pg_get_constraintdef(oid) as definition,
               convalidated as validated
        from pg_constraint
        where conrelid = 'session_pending_tool_calls'::regclass
          and conname = 'session_pending_tool_calls_event_output_codec_version_chk'`;
      expect(constraint?.definition).toContain("event_output_codec_version = 1");
      expect(constraint?.validated).toBe(true);

      const [trigger] = await sql<{ definition: string; enabled: string }[]>`
        select pg_get_triggerdef(oid) as definition,
               tgenabled as enabled
        from pg_trigger
        where tgrelid = 'session_pending_tool_calls'::regclass
          and tgname = 'session_pending_tool_calls_event_output_delete_guard'
          and not tgisinternal`;
      expect(trigger?.definition).toContain("BEFORE DELETE");
      expect(trigger?.definition).toContain("guard_pending_tool_event_output_delete");
      expect(trigger?.enabled).toBe("O");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
