import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0205_attempt_tool_catalogs.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0205 attempt tool catalogs", () => {
  test("is bounded, immutable, exact-attempt-bound, and FORCE-RLS protected", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain(
      'ALTER TABLE "session_turns"\n  RENAME COLUMN "toolspace_call_count" TO "codemode_call_count"',
    );
    expect(source).toContain("SET LOCAL lock_timeout = '5s'");
    expect(source).toContain("SET LOCAL statement_timeout = '30s'");
    expect(source).toContain('CREATE TABLE "session_attempt_tool_catalogs"');
    expect(source).toContain('CONSTRAINT "session_attempt_tool_catalogs_attempt_owner_fk"');
    expect(source).toContain(
      'FOREIGN KEY ("account_id", "workspace_id", "session_id", "turn_id", "attempt_id")',
    );
    expect(source).toContain('REFERENCES "session_turn_attempts"(');
    expect(source).toContain("FORCE ROW LEVEL SECURITY");
    expect(source).toContain(
      "GRANT SELECT, INSERT ON TABLE %I.session_attempt_tool_catalogs TO opengeni_app",
    );
    expect(source).toContain(
      "REVOKE ALL ON TABLE %I.session_attempt_tool_catalogs FROM opengeni_app",
    );
    expect(source).not.toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE %I.session_attempt_tool_catalogs",
    );
    expect(source).toContain('CREATE TABLE "session_attempt_codemode_calls"');
    expect(source).toContain('CONSTRAINT "session_attempt_codemode_calls_catalog_fk"');
    expect(source).toContain(
      'CREATE UNIQUE INDEX "session_attempt_tool_catalogs_exact_authority_digest_uidx"',
    );
    expect(source).toContain(
      '"account_id", "workspace_id", "session_id", "turn_id", "attempt_id",\n      "execution_generation", "catalog_digest"',
    );
    expect(source).toContain('REFERENCES "session_attempt_tool_catalogs"(');
    expect(source).toContain('CREATE INDEX "session_attempt_codemode_calls_active_attempt_idx"');
    expect(source).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE %I.session_attempt_codemode_calls TO opengeni_app",
    );
    expect(source).toContain("jsonb_array_length(\"catalog\"->'entries') <= 4096");

    const blank = await acquireBlankTestDatabase("migration-0205");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [table] = await sql<
        Array<{ rlsEnabled: boolean; rlsForced: boolean; constraintNames: string[] }>
      >`
        select c.relrowsecurity as "rlsEnabled", c.relforcerowsecurity as "rlsForced",
          coalesce(array_agg(con.conname order by con.conname)
            filter (where con.conname is not null), '{}') as "constraintNames"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_constraint con on con.conrelid = c.oid
        where n.nspname = current_schema()
          and c.relname = 'session_attempt_tool_catalogs'
        group by c.relrowsecurity, c.relforcerowsecurity`;
      expect(table).toMatchObject({ rlsEnabled: true, rlsForced: true });
      expect(table!.constraintNames).toContain("session_attempt_tool_catalogs_attempt_owner_fk");
      expect(table!.constraintNames).toContain(
        "session_attempt_tool_catalogs_catalog_identity_check",
      );
      const [callsTable] = await sql<
        Array<{ rlsEnabled: boolean; rlsForced: boolean; constraintNames: string[] }>
      >`
        select c.relrowsecurity as "rlsEnabled", c.relforcerowsecurity as "rlsForced",
          coalesce(array_agg(con.conname order by con.conname)
            filter (where con.conname is not null), '{}') as "constraintNames"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_constraint con on con.conrelid = c.oid
        where n.nspname = current_schema()
          and c.relname = 'session_attempt_codemode_calls'
        group by c.relrowsecurity, c.relforcerowsecurity`;
      expect(callsTable).toMatchObject({ rlsEnabled: true, rlsForced: true });
      expect(callsTable!.constraintNames).toContain("session_attempt_codemode_calls_catalog_fk");
      expect(callsTable!.constraintNames).toContain(
        "session_attempt_codemode_calls_lifecycle_check",
      );

      const [role] = await sql<Array<{ exists: boolean }>>`
        select to_regrole('opengeni_app') is not null as exists`;
      if (role?.exists) {
        const [privileges] = await sql<
          Array<{ select: boolean; insert: boolean; update: boolean; delete: boolean }>
        >`
          select
            has_table_privilege('opengeni_app', 'session_attempt_tool_catalogs', 'SELECT') as select,
            has_table_privilege('opengeni_app', 'session_attempt_tool_catalogs', 'INSERT') as insert,
            has_table_privilege('opengeni_app', 'session_attempt_tool_catalogs', 'UPDATE') as update,
            has_table_privilege('opengeni_app', 'session_attempt_tool_catalogs', 'DELETE') as delete`;
        expect(privileges).toEqual({ select: true, insert: true, update: false, delete: false });
        const [callPrivileges] = await sql<
          Array<{ select: boolean; insert: boolean; update: boolean; delete: boolean }>
        >`
          select
            has_table_privilege('opengeni_app', 'session_attempt_codemode_calls', 'SELECT') as select,
            has_table_privilege('opengeni_app', 'session_attempt_codemode_calls', 'INSERT') as insert,
            has_table_privilege('opengeni_app', 'session_attempt_codemode_calls', 'UPDATE') as update,
            has_table_privilege('opengeni_app', 'session_attempt_codemode_calls', 'DELETE') as delete`;
        expect(callPrivileges).toEqual({ select: true, insert: true, update: true, delete: false });
      }
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
