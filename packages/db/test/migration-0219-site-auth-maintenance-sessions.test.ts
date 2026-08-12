import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0219_site_auth_maintenance_sessions.sql", import.meta.url);

describe("migration 0218 site auth maintenance sessions", () => {
  test("installs hidden, reclaimable maintenance authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain("FOR UPDATE OF C SKIP LOCKED");
    expect(source).toContain("maintenance_started_at IS NULL");

    const blank = await acquireBlankTestDatabase("migration-0219-site-auth-maintenance-sessions");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await migrate(blank.databaseUrl);
      const columns = await sql<Array<{ tableName: string; columnName: string }>>`
        select table_name as "tableName", column_name as "columnName"
        from information_schema.columns
        where table_schema = current_schema()
          and (
            (table_name = 'site_auth_connections' and column_name like 'maintenance_%')
            or (table_name = 'auth_runs' and column_name = 'maintenance_operation_id')
          )
        order by table_name, column_name`;
      expect(columns).toHaveLength(7);

      const constraints = await sql<Array<{ name: string }>>`
        select conname as name
        from pg_constraint
        where connamespace = current_schema()::regnamespace
          and conname in (
            'site_auth_connections_maintenance_check',
            'auth_runs_maintenance_check'
          )
        order by conname`;
      expect(constraints.map((constraint) => constraint.name)).toEqual([
        "auth_runs_maintenance_check",
        "site_auth_connections_maintenance_check",
      ]);

      const [maintenanceIndex] = await sql<Array<{ unique: boolean }>>`
        select i.indisunique as unique
        from pg_index i
        join pg_class c on c.oid = i.indexrelid
        where c.relnamespace = current_schema()::regnamespace
          and c.relname = 'auth_runs_workspace_maintenance_operation_uq'`;
      expect(maintenanceIndex).toEqual({ unique: true });

      const [claimFunction] = await sql<Array<{ exists: boolean; publicExecute: boolean }>>`
        select
          to_regprocedure(
            'opengeni_private.claim_site_auth_maintenance(bigint,integer)'
          ) is not null as exists,
          has_function_privilege(
            'public',
            'opengeni_private.claim_site_auth_maintenance(bigint,integer)',
            'EXECUTE'
          ) as "publicExecute"`;
      expect(claimFunction).toEqual({ exists: true, publicExecute: false });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
