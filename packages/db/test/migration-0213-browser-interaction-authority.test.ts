import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0213_browser_interaction_authority.sql", import.meta.url);

describe("migration 0213 browser interaction authority", () => {
  // A full-ledger replay against a fresh database, so its cost is the whole
  // migration history and its only variable is I/O contention. Every co-located
  // sibling that does the same (0184, 0186, 0188, 0203, 0206) carries `180_000`;
  // this one carried nothing and so inherited the 30 s cap that
  // `scripts/ci/run-unit-shard.ts` passes as `--timeout=30000`.
  //
  // That cap is not a guarantee about anything asserted here - the assertions are
  // on the migration source and the resulting columns - and it is not survivable
  // either. `deterministicShards` packs shards by source-file BYTE SIZE, which is
  // a poor proxy for a test whose cost is a 351-migration replay, so any file
  // added anywhere can re-cluster the six full-ledger replays into one shard.
  // That is what happened at d13a9849b: all six landed in shard 3, four ran
  // concurrently against the single shared container, each took roughly five
  // times its usual wall time, and this test was killed at 30000 ms after 6 of
  // its 9 assertions. Uncontended it takes about 4 s.
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
  }, 180_000);
});
