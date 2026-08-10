import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0203_video_generation_funding.sql", import.meta.url);

describe("migration 0203 video generation funding", () => {
  test("is rolling and adds an explicit frozen funding state", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ADD COLUMN "funding_source"');
    expect(source).toContain("NOT VALID");
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/iu);

    const blank = await acquireBlankTestDatabase("migration-0203-video-funding");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const columns = await sql<Array<{ tableName: string; columnName: string }>>`
        select table_name as "tableName", column_name as "columnName"
        from information_schema.columns
        where table_schema = current_schema()
          and ((table_name = 'workspace_video_generation_policies' and column_name = 'funding_source')
            or (table_name = 'video_generation_operations'
              and column_name in ('funding_source', 'priced_cost_micros', 'credit_state')))
        order by table_name, column_name`;
      expect([...columns]).toEqual([
        { tableName: "video_generation_operations", columnName: "credit_state" },
        { tableName: "video_generation_operations", columnName: "funding_source" },
        { tableName: "video_generation_operations", columnName: "priced_cost_micros" },
        { tableName: "workspace_video_generation_policies", columnName: "funding_source" },
      ]);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
