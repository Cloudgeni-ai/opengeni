import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0213_browser_interaction_authority.sql", import.meta.url);

describe("migration 0213 browser interaction authority", () => {
  test("snapshots routes and extends interventions without secret material", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('ADD COLUMN "network_route_version" bigint');
    expect(source).toContain('ADD COLUMN "originating_tool_call_id" text');
    expect(source).toContain('ADD COLUMN "metadata" jsonb');
    expect(source).not.toContain("credential_value");
    expect(source).not.toContain("secret_value");

    const blank = await acquireBlankTestDatabase("migration-0213-interaction-authority");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const routeColumns = await sql<Array<{ name: string }>>`
        select column_name as name from information_schema.columns
        where table_schema = current_schema() and table_name = 'browser_sessions'
          and column_name in (
            'network_route_version', 'network_route_configuration',
            'network_route_consistency', 'network_route_credential_version',
            'network_route_authority_digest'
          ) order by column_name`;
      expect(routeColumns.map((column) => column.name)).toEqual([
        "network_route_authority_digest",
        "network_route_configuration",
        "network_route_consistency",
        "network_route_credential_version",
        "network_route_version",
      ]);

      const indexes = await sql<Array<{ name: string }>>`
        select indexname as name from pg_indexes
        where schemaname = current_schema() and indexname in (
          'browser_sessions_workspace_network_route_idx',
          'interaction_interventions_originating_tool_call_uq'
        ) order by indexname`;
      expect(indexes.map((index) => index.name)).toEqual([
        "browser_sessions_workspace_network_route_idx",
        "interaction_interventions_originating_tool_call_uq",
      ]);

      const [metadata] = await sql<Array<{ defaultValue: string | null }>>`
        select column_default as "defaultValue" from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'interaction_resource_operations'
          and column_name = 'metadata'`;
      expect(metadata?.defaultValue).toContain("'{}'::jsonb");
    } finally {
      await sql.end();
      await blank.release();
    }
  });
});
