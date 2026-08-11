import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0206_browser_sessions.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0206 browser sessions", () => {
  test("installs one exact durable BrowserSession and interaction-holder protocol", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('CREATE TABLE "browser_sessions"');
    expect(source).toContain('CREATE TABLE "browser_session_associations"');
    expect(source).toContain('CREATE TABLE "interaction_operations"');
    expect(source).toContain('CREATE TABLE "workspace_interaction_revisions"');
    expect(source).toContain("'interaction'");
    expect(source).toContain("p_interaction_holder_ttl_ms bigint");
    expect(source).toContain("controller_heartbeat_expired");
    expect(source).toContain("FORCE ROW LEVEL SECURITY");

    const blank = await acquireBlankTestDatabase("migration-0206");
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
          and c.relname in (
            'browser_sessions', 'browser_session_associations',
            'interaction_operations', 'workspace_interaction_revisions'
          )
        order by c.relname`;
      expect(tables).toHaveLength(4);
      for (const table of tables) {
        expect(table).toMatchObject({ rlsEnabled: true, rlsForced: true });
      }

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
        from unnest(array[
          'browser_sessions', 'browser_session_associations',
          'interaction_operations', 'workspace_interaction_revisions'
        ]) as name
        order by name`;
      expect([...grants]).toEqual([
        {
          name: "browser_session_associations",
          select: true,
          insert: true,
          update: true,
          delete: true,
        },
        { name: "browser_sessions", select: true, insert: true, update: true, delete: false },
        { name: "interaction_operations", select: true, insert: true, update: true, delete: false },
        {
          name: "workspace_interaction_revisions",
          select: true,
          insert: true,
          update: true,
          delete: false,
        },
      ]);

      const [holderConstraint] = await sql<Array<{ definition: string }>>`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname = 'sandbox_lease_holders_kind_check'`;
      expect(holderConstraint?.definition).toContain("'interaction'::text");

      const [reaper] = await sql<Array<{ fourArg: boolean; threeArg: boolean }>>`
        select
          to_regprocedure(
            'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'
          ) is not null as "fourArg",
          to_regprocedure(
            'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint)'
          ) is not null as "threeArg"`;
      expect(reaper).toEqual({ fourArg: true, threeArg: false });

      const [operationConstraint] = await sql<Array<{ definition: string }>>`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname = 'interaction_operations_lifecycle_check'`;
      expect(operationConstraint?.definition).toContain("outcome_unknown");

      const provenanceConstraints = await sql<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in (
          'browser_sessions_create_operation_fk',
          'browser_session_associations_turn_fk',
          'browser_session_associations_attempt_fk'
        )
        order by conname`;
      expect(provenanceConstraints).toHaveLength(3);
      expect(
        provenanceConstraints.find(
          (constraint) => constraint.name === "browser_session_associations_turn_fk",
        )?.definition,
      ).toContain("FOREIGN KEY (workspace_id, turn_id)");
      expect(
        provenanceConstraints.find(
          (constraint) => constraint.name === "browser_sessions_create_operation_fk",
        )?.definition,
      ).toContain("FOREIGN KEY (workspace_id, create_operation_id)");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
