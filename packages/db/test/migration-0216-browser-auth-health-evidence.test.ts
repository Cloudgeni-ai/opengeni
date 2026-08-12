import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0216_browser_auth_health_evidence.sql", import.meta.url);

describe("migration 0216 browser auth health evidence", () => {
  test("orders terminal evidence without coupling independent browser runs", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('row_number() OVER (ORDER BY "created_at", "id")');
    expect(source).toContain('"health_sequence" > 0');

    const blank = await acquireBlankTestDatabase("migration-0216-browser-auth-health-evidence");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const columns = await sql<Array<{ tableName: string; columnName: string; nullable: string }>>`
        select table_name as "tableName", column_name as "columnName", is_nullable as nullable
        from information_schema.columns
        where table_schema = current_schema()
          and (
            (table_name = 'site_auth_connections' and column_name in (
              'last_checked_at', 'next_check_at', 'health_sequence'
            )) or
            (table_name = 'auth_runs' and column_name in ('purpose', 'health_sequence'))
          )
        order by table_name, column_name`;
      expect(columns).toHaveLength(5);
      expect(columns.filter((column) => column.columnName === "health_sequence")).toEqual([
        { tableName: "auth_runs", columnName: "health_sequence", nullable: "NO" },
        { tableName: "site_auth_connections", columnName: "health_sequence", nullable: "NO" },
      ]);

      const constraints = await sql<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where connamespace = current_schema()::regnamespace
          and conname in (
            'auth_runs_health_evidence_check',
            'site_auth_connections_health_check'
          )
        order by conname`;
      expect(constraints.map((constraint) => constraint.name)).toEqual([
        "auth_runs_health_evidence_check",
        "site_auth_connections_health_check",
      ]);
      expect(constraints[1]?.definition).toContain("next_check_at");

      const [sequence] = await sql<Array<{ exists: boolean; publicUsage: boolean }>>`
        select
          to_regclass(current_schema() || '.auth_runs_health_sequence_seq') is not null as exists,
          has_sequence_privilege('public', current_schema() || '.auth_runs_health_sequence_seq', 'USAGE') as "publicUsage"`;
      expect(sequence).toEqual({ exists: true, publicUsage: false });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
