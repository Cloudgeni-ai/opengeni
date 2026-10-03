import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type postgres from "postgres";
import { executeMigrationFile, initialMigrationWithPreinstalledVector } from "../src/migrate";

const initial = await readFile(join(import.meta.dir, "../drizzle/0000_initial.sql"), "utf8");
const prefix = "CREATE EXTENSION IF NOT EXISTS pgcrypto;\nCREATE EXTENSION IF NOT EXISTS vector;\n";

function connection(present: boolean) {
  const statements: string[] = [];
  const inspections: string[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray) => {
      inspections.push(strings.join("?"));
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
  test("default runs the shipped initial migration verbatim", async () => {
    const { sql, statements, inspections } = connection(false);
    await executeMigrationFile(sql, "0000_initial.sql", initial);
    expect(inspections).toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(prefix);
  });

  test("opt-in verifies extension-owned public type before omitting only vector installation", async () => {
    const { sql, statements, inspections } = connection(true);
    await executeMigrationFile(sql, "0000_initial.sql", initial, { preinstalledVector: true });
    expect(inspections).toHaveLength(1);
    expect(inspections[0]).toContain("dependency.refobjid = extension.oid");
    expect(inspections[0]).toContain("namespace.nspname = 'public'");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(
      "CREATE EXTENSION IF NOT EXISTS pgcrypto;\n" + initial.slice(prefix.length),
    );
    expect(statements[0]).not.toContain("CREATE EXTENSION IF NOT EXISTS vector;");
  });

  test("absent extension or changed preamble fails before any migration DDL", async () => {
    const missing = connection(false);
    await expect(
      executeMigrationFile(missing.sql, "0000_initial.sql", initial, { preinstalledVector: true }),
    ).rejects.toThrow("Preinstalled public pgvector");
    expect(missing.statements).toEqual([]);

    const changed = connection(true);
    await expect(
      initialMigrationWithPreinstalledVector(changed.sql, initial.replace(prefix, "SELECT 1;\n")),
    ).rejects.toThrow("initial extension preamble changed");
    expect(changed.inspections).toEqual([]);
    expect(changed.statements).toEqual([]);
  });

  test("never changes another migration even with opt-in", async () => {
    const { sql, statements, inspections } = connection(true);
    await executeMigrationFile(sql, "0001_other.sql", "SELECT 1;", { preinstalledVector: true });
    expect(inspections).toEqual([]);
    expect(statements).toEqual([
      "SELECT\n  pg_catalog.set_config('lock_timeout', '5s', true),\n  pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),\n  pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true);\nSELECT 1;",
    ]);
  });
});

test("0510 receives the ordinary lock bound without changing its migration SQL", async () => {
  const file = "0510_knowledge_index_funding_wait.sql";
  const body = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
  expect(body.match(/ALTER TABLE knowledge_index_jobs ADD COLUMN/g)).toHaveLength(3);
  expect(body).not.toMatch(/^\s*(?:SET(?: LOCAL)?|RESET)\s+lock_timeout\b/im);
  const { sql, statements } = connection(false);
  await executeMigrationFile(sql, file, body);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain("pg_catalog.set_config('lock_timeout', '5s', true)");
  expect(statements[0]?.endsWith(body)).toBe(true);
});
