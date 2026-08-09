import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0190_timeline_annotations.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0190 timeline annotations", () => {
  test("is rolling and adds bounded JSON arrays to drafts and turns", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("SET LOCAL lock_timeout = '5s'");
    expect(source).toContain("NOT VALID");
    expect(source).toContain("VALIDATE CONSTRAINT");
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/i);

    const blank = await acquireBlankTestDatabase("migration-0190");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const columns = await sql<
        Array<{ tableName: string; defaultValue: string; nullable: string }>
      >`
        select table_name as "tableName", column_default as "defaultValue", is_nullable as nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name in ('composer_drafts', 'session_turns')
          and column_name = 'annotations'
        order by table_name`;
      expect([...columns]).toEqual([
        { tableName: "composer_drafts", defaultValue: "'[]'::jsonb", nullable: "NO" },
        { tableName: "session_turns", defaultValue: "'[]'::jsonb", nullable: "NO" },
      ]);
      const constraints = await sql<Array<{ name: string; validated: boolean }>>`
        select conname as name, convalidated as validated
        from pg_constraint
        where conname in (
          'composer_drafts_annotations_check',
          'session_turns_annotations_check'
        )
        order by conname`;
      expect([...constraints]).toEqual([
        { name: "composer_drafts_annotations_check", validated: true },
        { name: "session_turns_annotations_check", validated: true },
      ]);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
