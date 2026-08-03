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
    expect(sql).toContain("min(id::text)::uuid");
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

  test("backfills immutable document and chunk authority before replacing FORCE-RLS policy", async () => {
    const sql = await readFile(
      join(migrationsDir, "0165_document_authority_foundation.sql"),
      "utf8",
    );

    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(sql).toContain(
      `CASE WHEN "visibility" = 'private' THEN 'personal' ELSE 'workspace' END`,
    );
    expect(sql).toContain(`"authority_subject_id" = CASE WHEN "visibility" = 'private'`);
    expect(sql).toContain('chunk."base_id" IS DISTINCT FROM document."base_id"');
    expect(sql).toContain("parent.base_id IS DISTINCT FROM NEW.base_id");
    expect(sql).toContain("document_chunks_authority_guard");
    expect(sql).toContain("document authority is immutable");
    expect(sql).toContain("migration 0165 requires every queued/indexing document to settle");
    expect(sql.match(/requires all opengeni_app sessions to be stopped/g)).toHaveLength(2);
    expect(sql).toContain('ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "document_chunks" NO FORCE ROW LEVEL SECURITY');
    expect(sql.indexOf('ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY')).toBeLessThan(
      sql.indexOf("$document_index_drain$"),
    );
    expect(sql.indexOf("$document_writer_drain_after_lock$;")).toBeLessThan(
      sql.indexOf("$document_index_drain$"),
    );
    expect(sql.indexOf("$document_index_drain$;")).toBeLessThan(
      sql.indexOf('ALTER TABLE "documents" ADD COLUMN "authority_kind"'),
    );
    expect(
      sql.match(/octet_length\(convert_to\("authority_subject_id", 'UTF8'\)\) <= 1024/g),
    ).toHaveLength(2);
    expect(sql).toContain("opengeni_private.scoped_knowledge_scope_visible");
    expect(sql).toContain("DROP POLICY workspace_isolation");
    expect(sql.match(/ALTER TABLE %I FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
    expect(sql.lastIndexOf("ALTER TABLE %I FORCE ROW LEVEL SECURITY")).toBeGreaterThan(
      sql.indexOf("CREATE POLICY document_authority_isolation"),
    );
    expect(sql.indexOf('UPDATE "documents"')).toBeLessThan(
      sql.indexOf('ALTER TABLE "documents" ALTER COLUMN "authority_kind" SET NOT NULL'),
    );
  });
});
