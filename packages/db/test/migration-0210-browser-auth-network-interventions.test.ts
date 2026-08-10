import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0210_browser_auth_network_interventions.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0210 browser auth, routes, and interventions", () => {
  test("installs secret-free authority, auth-run, and human-handoff resources", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    for (const table of [
      "network_routes",
      "site_auth_connections",
      "auth_runs",
      "interaction_interventions",
      "interaction_resource_operations",
    ]) {
      expect(source).toContain(`CREATE TABLE "${table}"`);
    }
    expect(source).toContain('"auth_runs_projection_check"');
    expect(source).toContain('"browser_sessions_network_route_fk"');
    expect(source).toContain('"auth_runs_active_browser_target_uq"');
    expect(source).not.toContain("credential_encrypted");
    expect(source).not.toContain("secret_value");

    const blank = await acquireBlankTestDatabase("migration-0210");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await migrate(blank.databaseUrl);
      const tables = await sql<Array<{ name: string; rlsEnabled: boolean; rlsForced: boolean }>>`
        select c.relname as name, c.relrowsecurity as "rlsEnabled",
          c.relforcerowsecurity as "rlsForced"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname in (
            'network_routes', 'site_auth_connections', 'auth_runs',
            'interaction_interventions', 'interaction_resource_operations'
          )
        order by c.relname`;
      expect(tables).toHaveLength(5);
      for (const table of tables) {
        expect(table).toMatchObject({ rlsEnabled: true, rlsForced: true });
      }

      const forbiddenColumns = await sql<Array<{ name: string }>>`
        select column_name as name
        from information_schema.columns
        where table_schema = current_schema()
          and table_name in ('network_routes', 'site_auth_connections', 'auth_runs')
          and column_name in (
            'credential', 'credential_encrypted', 'password', 'secret', 'secret_value', 'totp'
          )`;
      expect(forbiddenColumns).toHaveLength(0);

      const browserRouteColumns = await sql<Array<{ name: string }>>`
        select column_name as name
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'browser_sessions'
          and column_name in (
            'network_route_version', 'network_route_configuration',
            'network_route_consistency', 'network_route_credential_version',
            'network_route_authority_digest'
          )
        order by column_name`;
      expect(browserRouteColumns.map((column) => column.name)).toEqual([
        "network_route_authority_digest",
        "network_route_configuration",
        "network_route_consistency",
        "network_route_credential_version",
        "network_route_version",
      ]);

      const constraints = await sql<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in (
          'browser_sessions_network_route_fk',
          'site_auth_connections_identity_fk',
          'site_auth_connections_network_route_fk',
          'auth_runs_site_auth_connection_fk',
          'auth_runs_browser_session_fk',
          'auth_runs_intervention_fk',
          'interaction_interventions_auth_run_fk',
          'auth_runs_projection_check'
        )
        order by conname`;
      expect(constraints).toHaveLength(8);
      expect(
        constraints.find((constraint) => constraint.name === "auth_runs_projection_check")
          ?.definition,
      ).toContain("jsonb_array_length(choices)");

      const indexes = await sql<Array<{ name: string }>>`
        select indexname as name
        from pg_indexes
        where schemaname = current_schema()
          and indexname in (
            'auth_runs_active_browser_target_uq',
            'browser_sessions_workspace_network_route_idx',
            'interaction_interventions_originating_tool_call_uq',
            'interaction_interventions_open_target_kind_uq',
            'interaction_interventions_open_auth_run_uq'
          )
        order by indexname`;
      expect(indexes.map((index) => index.name)).toEqual([
        "auth_runs_active_browser_target_uq",
        "browser_sessions_workspace_network_route_idx",
        "interaction_interventions_open_auth_run_uq",
        "interaction_interventions_open_target_kind_uq",
        "interaction_interventions_originating_tool_call_uq",
      ]);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
