import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { migrate } from "../src/migrate";

const migrationName = "0211_editable_artifact_session_links.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0211 editable artifact session links", () => {
  test("installs one tenant-isolated association table", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('CREATE TABLE "editable_artifact_session_links"');
    expect(source).toContain(
      'ALTER TABLE "editable_artifact_session_links" FORCE ROW LEVEL SECURITY',
    );
    expect(source).toContain(
      'CREATE POLICY workspace_isolation ON "editable_artifact_session_links"',
    );

    const blank = await acquireBlankTestDatabase("migration-0211");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const tables = await sql<
        Array<{ rlsEnabled: boolean; rlsForced: boolean }>
      >`select c.relrowsecurity as "rlsEnabled", c.relforcerowsecurity as "rlsForced"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname = 'editable_artifact_session_links'`;
      expect(tables.map((table) => ({ ...table }))).toEqual([
        { rlsEnabled: true, rlsForced: true },
      ]);

      const constraints = await sql<Array<{ name: string }>>`
        select conname as name
        from pg_constraint
        where conname in (
          'editable_artifact_session_links_pk',
          'editable_artifact_session_links_workspace_fk',
          'editable_artifact_session_links_session_fk',
          'editable_artifact_session_links_artifact_fk',
          'editable_artifact_session_links_artifact_id_chk',
          'editable_artifact_session_links_time_chk'
        )
        order by conname`;
      expect(constraints).toHaveLength(6);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
