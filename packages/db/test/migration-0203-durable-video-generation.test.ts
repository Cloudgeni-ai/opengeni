import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0203_durable_video_generation.sql", import.meta.url);

describe("migration 0203 durable video generation", () => {
  test("is rolling, tenant isolated, and installs the recovery claim", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('CREATE TABLE "video_generation_operations"');
    expect(source).toContain('CREATE TABLE "generated_video_artifacts"');
    expect(source).toContain('ON DELETE SET NULL ("session_id")');
    expect(source).toContain("claim_video_generation_operations");
    expect(source).toContain("FORCE ROW LEVEL SECURITY");
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/iu);

    const blank = await acquireBlankTestDatabase("migration-0203-video-generation");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const tables = await sql<
        Array<{ tableName: string; rlsEnabled: boolean; rlsForced: boolean }>
      >`
        select c.relname as "tableName", c.relrowsecurity as "rlsEnabled",
          c.relforcerowsecurity as "rlsForced"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname in (
            'generated_video_artifacts', 'video_generation_operations',
            'video_generation_references', 'workspace_video_generation_policies',
            'workspace_video_generation_quotas'
          )
        order by c.relname`;
      expect(tables).toHaveLength(5);
      expect(tables.every((table) => table.rlsEnabled && table.rlsForced)).toBe(true);

      const [kindConstraint] = await sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname = 'system_updates_kind_check'`;
      expect(kindConstraint?.definition).toContain("media_generation_result");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
