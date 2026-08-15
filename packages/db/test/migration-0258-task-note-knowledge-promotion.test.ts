import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0258_task_note_knowledge_promotion.sql",
);

describe("migration 0258 Task-note Knowledge promotion", () => {
  test("keeps document provenance and adds exact value-free Task-note evidence", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain('ALTER COLUMN "document_version_id" DROP NOT NULL');
    expect(sql).toContain('"knowledge_claim_evidence_source_shape_chk"');
    expect(sql).toContain('"document_version_id" IS NOT NULL');
    expect(sql).toContain('"task_note_version" = 1');
    expect(sql).toContain("validate_task_note_knowledge_evidence");
    expect(sql).toContain("NEW.content_hash IS DISTINCT FROM note_row.text_hash");
    expect(sql).not.toMatch(/ADD COLUMN\s+"task_note_(?:text|content)"/i);
  });

  test("resolves only a current exact attempt and active unexpired note in its rooted tree", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("resolve_task_note_knowledge_promotion_source");
    expect(sql).toContain("resolve_task_note_attempt_authority");
    expect(sql).toContain("note.root_session_id = authority.root_session_id");
    expect(sql).toContain("note.status = 'active'");
    expect(sql).toContain("note.expires_at > statement_timestamp()");
    expect(sql).toContain("FOR SHARE");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION");
  });
});
