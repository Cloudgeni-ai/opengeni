import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0209_computer_sessions.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0209 computer sessions", () => {
  test("installs one durable ComputerSession and shared interaction-holder protocol", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('CREATE TABLE "computer_sessions"');
    expect(source).toContain('CREATE TABLE "computer_session_associations"');
    expect(source).toContain('"computer_sessions_native_binding_check"');
    expect(source).toContain('"browser_sessions_linked_computer_session_fk"');
    expect(source).toContain("'computer-session:' || computer.id::text");
    expect(source).toContain("CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases");
    expect(source).toContain("FORCE ROW LEVEL SECURITY");

    const blank = await acquireBlankTestDatabase("migration-0209");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const tables = await sql<Array<{ name: string; rlsEnabled: boolean; rlsForced: boolean }>>`
        select c.relname as name, c.relrowsecurity as "rlsEnabled",
          c.relforcerowsecurity as "rlsForced"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname in ('computer_sessions', 'computer_session_associations')
        order by c.relname`;
      expect([...tables]).toEqual([
        { name: "computer_session_associations", rlsEnabled: true, rlsForced: true },
        { name: "computer_sessions", rlsEnabled: true, rlsForced: true },
      ]);

      const grants = await sql<
        Array<{
          name: string;
          select: boolean;
          insert: boolean;
          update: boolean;
          delete: boolean;
        }>
      >`
        select name,
          has_table_privilege('opengeni_app', name, 'select') as select,
          has_table_privilege('opengeni_app', name, 'insert') as insert,
          has_table_privilege('opengeni_app', name, 'update') as update,
          has_table_privilege('opengeni_app', name, 'delete') as delete
        from unnest(array['computer_sessions', 'computer_session_associations']) as name
        order by name`;
      expect([...grants]).toEqual([
        {
          name: "computer_session_associations",
          select: true,
          insert: true,
          update: true,
          delete: true,
        },
        { name: "computer_sessions", select: true, insert: true, update: true, delete: false },
      ]);

      const constraints = await sql<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in (
          'computer_sessions_create_operation_fk',
          'computer_sessions_native_binding_check',
          'computer_sessions_active_binding_check',
          'computer_session_associations_resource_fk',
          'computer_session_associations_session_fk',
          'computer_session_associations_turn_fk',
          'computer_session_associations_attempt_fk',
          'browser_sessions_linked_computer_session_fk'
        )
        order by conname`;
      expect(constraints).toHaveLength(8);
      expect(
        constraints.find(
          (constraint) => constraint.name === "browser_sessions_linked_computer_session_fk",
        )?.definition,
      ).toContain("ON DELETE SET NULL (linked_computer_session_id)");
      expect(
        constraints.find(
          (constraint) => constraint.name === "computer_sessions_native_binding_check",
        )?.definition,
      ).toContain("capabilities IS NULL");

      const [reaper] = await sql<Array<{ definition: string }>>`
        select pg_get_functiondef(
          'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'::regprocedure
        ) as definition`;
      expect(reaper?.definition).toContain("computer_sessions computer");
      expect(reaper?.definition).toContain("computer-session:");
      expect(reaper?.definition).toContain("browser-session:");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
