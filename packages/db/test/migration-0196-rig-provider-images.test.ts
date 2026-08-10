import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0196_rig_provider_images.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0196 rig provider images", () => {
  test("adds bounded operational metadata without rewriting immutable rig definitions", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain("ADD COLUMN provider_images jsonb NOT NULL DEFAULT '{}'::jsonb");
    expect(migration).toContain("CHECK (jsonb_typeof(provider_images) = 'object')");
    expect(migration).not.toMatch(/UPDATE\s+rig_versions/iu);
    expect(migration).not.toMatch(/ACCESS\s+EXCLUSIVE/iu);

    const blank = await acquireBlankTestDatabase("migration-0196");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "OPENGENI_REQUIRE_REAL_DB=1 but the migration 0196 PostgreSQL harness is unavailable",
        );
      }
      return;
    }
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await migrate(blank.databaseUrl);
      const [column] = await sql<
        Array<{ dataType: string; nullable: string; defaultValue: string }>
      >`
        select
          data_type as "dataType",
          is_nullable as nullable,
          column_default as "defaultValue"
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'rig_versions'
          and column_name = 'provider_images'`;
      expect(column).toEqual({
        dataType: "jsonb",
        nullable: "NO",
        defaultValue: "'{}'::jsonb",
      });
      const [constraint] = await sql<Array<{ validated: boolean; definition: string }>>`
        select
          convalidated as validated,
          pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname = 'rig_versions_provider_images_object_chk'`;
      expect(constraint?.validated).toBe(true);
      expect(constraint?.definition).toContain("jsonb_typeof(provider_images) = 'object'::text");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
