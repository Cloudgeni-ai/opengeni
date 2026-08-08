import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0189_retained_session_image_formats.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0189 retained session image formats", () => {
  test("is rolling and replaces the PNG-only constraint with the shared raster set", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("SET LOCAL lock_timeout = '5s'");
    expect(source).toContain("NOT VALID");
    expect(source).toContain("VALIDATE CONSTRAINT");
    expect(source).toContain("'image/png', 'image/jpeg', 'image/webp'");
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/i);

    const blank = await acquireBlankTestDatabase("migration-0189");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const constraints = await sql<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conrelid = 'retained_screenshot_artifacts'::regclass
          and conname like 'retained_screenshot_artifacts_media_type%'
        order by conname`;
      expect([...constraints]).toEqual([
        {
          name: "retained_screenshot_artifacts_media_type_v2_chk",
          definition:
            "CHECK ((media_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])))",
        },
      ]);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
