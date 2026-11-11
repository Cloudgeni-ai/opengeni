import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import { executeMigrationFile } from "../src/migrate";
import { BASELINE_MIGRATIONS } from "../src/migration-baseline";

const firstPart = BASELINE_MIGRATIONS[0]!;
const secondPart = BASELINE_MIGRATIONS[1]!;
const first = await readFile(new URL(`../drizzle/${firstPart}`, import.meta.url), "utf8");
const vectorStatement = "\nCREATE EXTENSION IF NOT EXISTS vector;\n";
const preamble =
  "SELECT\n  pg_catalog.set_config('lock_timeout', '5s', true),\n  pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),\n  pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true);\n";

function connection(present: boolean) {
  const statements: string[] = [];
  const inspections: string[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("current_schema() AS schema")) {
        return Promise.resolve([
          { schema: "public", schemaOid: "2200", owner: "opengeni", now: "2026-01-01 00:00:00+00" },
        ]);
      }
      inspections.push(text);
      return Promise.resolve([{ present }]);
    },
    {
      unsafe: async (text: string) => {
        statements.push(text);
      },
    },
  ) as unknown as postgres.Sql;
  return { sql, statements, inspections };
}

describe("explicit preinstalled-vector migration", () => {
  test("default runs the first baseline part with its vector installation", async () => {
    const { sql, statements, inspections } = connection(false);
    await executeMigrationFile(sql, firstPart, first);
    expect(inspections).toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(vectorStatement);
    expect(statements[0]).not.toContain("{{schema}}");
  });

  test("opt-in verifies extension-owned public type before omitting only vector installation", async () => {
    const { sql, statements, inspections } = connection(true);
    await executeMigrationFile(sql, firstPart, first, { preinstalledVector: true });
    expect(inspections).toHaveLength(1);
    expect(inspections[0]).toContain("dependency.refobjid = extension.oid");
    expect(inspections[0]).toContain("namespace.nspname = 'public'");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(
      "CREATE EXTENSION IF NOT EXISTS pgcrypto;\nCREATE EXTENSION IF NOT EXISTS pg_trgm;",
    );
    expect(statements[0]).not.toContain("CREATE EXTENSION IF NOT EXISTS vector;");
  });

  test("absent extension or changed statement fails before any migration DDL", async () => {
    const missing = connection(false);
    await expect(
      executeMigrationFile(missing.sql, firstPart, first, { preinstalledVector: true }),
    ).rejects.toThrow("Preinstalled public pgvector");
    expect(missing.statements).toEqual([]);

    const changed = connection(true);
    await expect(
      executeMigrationFile(
        changed.sql,
        firstPart,
        first.replace(vectorStatement, "\nSELECT 1;\n"),
        {
          preinstalledVector: true,
        },
      ),
    ).rejects.toThrow("vector statement changed");
    expect(changed.inspections).toEqual([]);
    expect(changed.statements).toEqual([]);
  });

  test("never changes another migration even with opt-in", async () => {
    for (const file of [secondPart, "0999_other.sql"]) {
      const { sql, statements, inspections } = connection(true);
      await executeMigrationFile(sql, file, "SELECT 1;", { preinstalledVector: true });
      expect(inspections).toEqual([]);
      expect(statements).toEqual([`${preamble}SELECT 1;`]);
    }
  });
});

test("recordApplied ends the same simple query with the ledger row", async () => {
  const { sql, statements } = connection(false);
  await executeMigrationFile(sql, "0999_o'ther.sql", "SELECT 1;", { recordApplied: true });
  expect(statements).toEqual([
    `${preamble}SELECT 1;\n;\nINSERT INTO "schema_migrations" ("name") VALUES ('0999_o''ther.sql') ON CONFLICT DO NOTHING;`,
  ]);
});
