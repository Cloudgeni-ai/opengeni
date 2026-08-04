import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("migration 0170 (document authority reclassifications)", () => {
  test("is rolling, append-only, exact-tuple fenced, and collection-independent", async () => {
    const migration = await readFile(
      join(migrationsDir, "0170_document_authority_reclassifications.sql"),
      "utf8",
    );

    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain('CREATE TABLE "document_authority_reclassifications"');
    expect(migration).toContain('"transaction_id" bigint NOT NULL DEFAULT txid_current()');
    expect(migration).toContain('UNIQUE ("workspace_id", "operation_id")');
    expect(migration).toContain("document_authority_reclassifications_immutable");
    expect(migration).toContain(
      'ALTER TABLE "document_authority_reclassifications" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'CREATE POLICY workspace_isolation ON "document_authority_reclassifications"',
    );
    expect(migration).toContain('receipt."transaction_id" = txid_current()');
    expect(migration).toContain(
      "current_setting('opengeni.document_authority_operation_id', true)",
    );
    expect(migration).toContain(
      'receipt."source_authority_workspace_id" IS NOT DISTINCT FROM OLD."authority_workspace_id"',
    );
    expect(migration).toContain(
      'receipt."target_authority_subject_id" IS NOT DISTINCT FROM NEW."authority_subject_id"',
    );
    expect(migration).toContain(
      "document authority is immutable outside an explicit reclassification",
    );
    expect(migration).toContain(
      "document chunk authority is immutable outside an explicit reclassification",
    );
    expect(migration).toContain("NEW.visibility = 'private'");
    expect(migration).not.toMatch(/(?:FROM|JOIN)\s+"document_bases"/i);
    expect(migration).not.toMatch(/ALTER TABLE "documents"\s+DROP/i);
    expect(migration).not.toMatch(/ALTER TABLE "document_chunks"\s+DROP/i);
  });
});
