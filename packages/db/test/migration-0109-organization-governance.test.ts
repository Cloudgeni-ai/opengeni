import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0109_organization_governance_recovery.sql";
const constraintNames = [
  "managed_accounts_organization_kind_check",
  "managed_accounts_governance_state_check",
  "managed_accounts_governance_revision_check",
  "managed_accounts_recovery_quorum_check",
] as const;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0109-organization-governance");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0109] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("0109 organization governance migration schema isolation", () => {
  test("binds all four managed_accounts checks in two target schemas in one database", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, prepare: false });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schemas = [`migration_0109_a_${suffix}`, `migration_0109_b_${suffix}`];
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const priorFiles = files.filter((file) => file.localeCompare(migration) < 0);
      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      await sql.unsafe(
        `CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA "public"; CREATE EXTENSION IF NOT EXISTS vector SCHEMA "public";`,
      );

      for (const [schemaIndex, targetSchema] of schemas.entries()) {
        await sql.unsafe(`CREATE SCHEMA "${targetSchema}"`);
        await sql.unsafe(`SET search_path = "${targetSchema}", "opengeni_private", "public"`);
        if (schemaIndex === 0) {
          await sql.unsafe(
            `CREATE TABLE "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
          );
          for (const file of priorFiles) {
            await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
            await sql`INSERT INTO "schema_migrations" ("name") VALUES (${file})`;
          }
        } else {
          // The pre-0109 shape is sufficient for the migration under test. The
          // historical chain is not replayed here because it creates shared
          // opengeni_private helper functions that are intentionally database-
          // global, not one copy per embedded target schema.
          await sql.unsafe(`
            CREATE TABLE "managed_accounts" (
              "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              "external_source" text NOT NULL,
              "external_id" text
            );
          `);
        }

        // A name-only guard would incorrectly treat these decoy constraints as
        // existing. PostgreSQL permits the same constraint name on another
        // relation, which is the embedded-schema failure this regression fixes.
        await sql.unsafe(`
          CREATE TABLE "managed_accounts_constraint_decoy" (
            "organization_kind" text,
            "governance_state" text,
            "governance_revision" bigint NOT NULL,
            "recovery_policy_revision" bigint NOT NULL,
            "recovery_quorum" integer
          );
          ALTER TABLE "managed_accounts_constraint_decoy"
            ADD CONSTRAINT "managed_accounts_organization_kind_check"
              CHECK ("organization_kind" IS NULL OR "organization_kind" IS NOT NULL),
            ADD CONSTRAINT "managed_accounts_governance_state_check"
              CHECK ("governance_state" IS NULL OR "governance_state" IS NOT NULL),
            ADD CONSTRAINT "managed_accounts_governance_revision_check"
              CHECK ("governance_revision" >= 0),
            ADD CONSTRAINT "managed_accounts_recovery_quorum_check"
              CHECK ("recovery_quorum" IS NULL OR "recovery_quorum" >= 0);
        `);
        await sql.unsafe(migrationSql);

        const rows = await sql<Array<{ name: string; schema: string; table: string }>>`
          select c.conname as name, n.nspname as schema, r.relname as table
          from pg_catalog.pg_constraint c
          join pg_catalog.pg_class r on r.oid = c.conrelid
          join pg_catalog.pg_namespace n on n.oid = r.relnamespace
          where n.nspname = ${targetSchema}
            and c.conname in ${sql(constraintNames)}
          order by c.conname, r.relname`;
        expect(rows).toHaveLength(8);
        expect(
          rows.filter((row) => row.table === "managed_accounts").map((row) => row.name),
        ).toEqual([...constraintNames].sort());
        expect(
          rows
            .filter((row) => row.table === "managed_accounts_constraint_decoy")
            .map((row) => row.name),
        ).toEqual([...constraintNames].sort());
      }
    } finally {
      await sql.end();
    }
  }, 300_000);
});
