import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0119_pending_tool_output_policy.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0119-pending-tool-output-policy");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0119] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0119 pending tool-output policy (real PostgreSQL)", () => {
  test("adds the nullable policy column and the migration ledger prevents replay", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, prepare: false });
    try {
      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      expect(migrationSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
      expect(migrationSql).toContain('ADD COLUMN "model_tool_output_truncation_tokens" integer;');
      expect(migrationSql).not.toMatch(/\b(?:DEFAULT|NOT NULL)\b/i);

      await sql.unsafe(`CREATE TABLE schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [before] = await sql<Array<{ count: number }>>`
        select count(*)::int as count
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'session_pending_tool_calls'
          and column_name = 'model_tool_output_truncation_tokens'`;
      expect(before?.count).toBe(0);

      await sql.unsafe(migrationSql);
      await sql`
        insert into schema_migrations (name) values (${migration})
        on conflict (name) do nothing`;

      const [column] = await sql<
        Array<{ nullable: string; dataType: string; columnDefault: string | null }>
      >`
        select
          is_nullable as "nullable",
          data_type as "dataType",
          column_default as "columnDefault"
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'session_pending_tool_calls'
          and column_name = 'model_tool_output_truncation_tokens'`;
      expect(column).toEqual({
        nullable: "YES",
        dataType: "integer",
        columnDefault: null,
      });

      await migrate(blank.databaseUrl);

      const [after] = await sql<Array<{ count: number }>>`
        select count(*)::int as count
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'session_pending_tool_calls'
          and column_name = 'model_tool_output_truncation_tokens'`;
      expect(after?.count).toBe(1);
    } finally {
      await sql.end();
    }
  }, 180_000);
});
