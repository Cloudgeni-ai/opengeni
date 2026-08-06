import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationName = "0065_enrollment_credential_generation.sql";

let blank: BlankTestDatabase | null = null;

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0065-enrollment-generation");
  if (!blank) {
    throw new Error(
      "[migration-0065-enrollment-generation] real PostgreSQL is required; migration proof cannot skip",
    );
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0065 enrollment credential generation migration (real PostgreSQL)", () => {
  test("follows current 0064 and defaults every legacy enrollment to generation 1", async () => {
    if (!blank) {
      throw new Error("real PostgreSQL fixture was not initialized");
    }
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      expect(files).toContain(migrationName);
      expect(files.indexOf(migrationName)).toBeGreaterThan(
        files.indexOf("0064_rotation_strategy_sharded_backfill.sql"),
      );

      await admin.unsafe(
        `CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const file of files.filter((candidate) => candidate.localeCompare(migrationName) < 0)) {
        await applyFile(admin, file);
        await admin`insert into schema_migrations (name) values (${file})`;
      }

      const accountId = (
        await admin<
          { id: string }[]
        >`insert into managed_accounts (name) values ('0065 legacy account') returning id`
      )[0]!.id;
      const workspaceId = (
        await admin<
          { id: string }[]
        >`insert into workspaces (account_id, name) values (${accountId}, '0065 legacy workspace') returning id`
      )[0]!.id;
      const legacyEnrollmentId = (
        await admin<{ id: string }[]>`
          insert into enrollments (account_id, workspace_id, pubkey)
          values (${accountId}, ${workspaceId}, 'ed25519:LEGACY-0065') returning id`
      )[0]!.id;

      const before = await admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'enrollments'
          and column_name = 'credential_generation'`;
      expect(before).toHaveLength(0);

      await applyFile(admin, migrationName);
      // The migration itself is idempotent, including the lost-response case where
      // SQL committed but the runner did not record schema_migrations.
      await applyFile(admin, migrationName);
      await admin`insert into schema_migrations (name) values (${migrationName})`;

      const [column] = await admin<
        { data_type: string; is_nullable: string; column_default: string | null }[]
      >`
        select data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'enrollments'
          and column_name = 'credential_generation'`;
      expect(column?.data_type).toBe("integer");
      expect(column?.is_nullable).toBe("NO");
      expect(column?.column_default).toContain("1");

      const [legacy] = await admin<{ credential_generation: number }[]>`
        select credential_generation from enrollments where id = ${legacyEnrollmentId}`;
      expect(legacy?.credential_generation).toBe(1);
      const [fresh] = await admin<{ credential_generation: number }[]>`
        insert into enrollments (account_id, workspace_id, pubkey)
        values (${accountId}, ${workspaceId}, 'ed25519:FRESH-0065')
        returning credential_generation`;
      expect(fresh?.credential_generation).toBe(1);

      // The real runner observes the recorded migration and remains a clean no-op
      // across repeated process starts.
      await migrate(blank.databaseUrl);
      await migrate(blank.databaseUrl);
      const [after] = await admin<{ credential_generation: number }[]>`
        select credential_generation from enrollments where id = ${legacyEnrollmentId}`;
      expect(after?.credential_generation).toBe(1);
    } finally {
      await admin.end();
    }
  }, 180_000);
});
