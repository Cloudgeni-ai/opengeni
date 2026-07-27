import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConcurrentIndexMigration } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("document access migrations", () => {
  test("repairs legacy state before validating document constraints", async () => {
    const sql = await readFile(join(migrationsDir, "0126_document_access_constraints.sql"), "utf8");

    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain("SET \"visibility\" = 'workspace'");
    expect(sql).toContain("SET \"curation_status\" = 'none'");
    expect(sql).toContain('VALIDATE CONSTRAINT "documents_visibility_chk"');
    expect(sql).toContain("NULLIF(btrim(\"created_by\"), '') IS NOT NULL");
  });

  test("builds the Default-base uniqueness guard online", async () => {
    const file = "0127_document_default_base_index.sql";
    const sql = await readFile(join(migrationsDir, file), "utf8");

    expect(parseConcurrentIndexMigration(file, sql)).toMatchObject({
      indexName: "document_bases_workspace_default_name_uq",
      lockTimeout: "5s",
      skipWhenValid: false,
    });
    expect(sql).toContain("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS");
  });
});
