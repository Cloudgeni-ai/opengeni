import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0260_task_note_knowledge_promotion.sql",
);
const scopedKnowledgeSchemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/scoped-knowledge-schema.ts",
);

describe("migration 0260 Task-note Knowledge promotion", () => {
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

  test("requires a one-shot exact-operation capability and hardens the definer path", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE "task_note_knowledge_promotion_capabilities"');
    expect(sql).toContain(
      'ALTER TABLE "task_note_knowledge_promotion_capabilities" FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain("current_setting('opengeni.task_note_knowledge_promotion_capability'");
    expect(sql).toContain("capability.evidence_operation_id = NEW.operation_id");
    expect(sql).toContain("claim.operation_id = capability_row.claim_operation_id");
    expect(sql).toContain("JOIN knowledge_facts fact");
    expect(sql).toContain("fact.object_value = pg_catalog.to_jsonb(note_row.text)");
    expect(sql).toContain("claim.extraction_method = 'task-note-promotion-v1'");
    expect(sql).toContain("claim.extraction_metadata = pg_catalog.jsonb_build_object(");
    expect(sql).toContain("FROM workspace_learning_policy_snapshots snapshot");
    expect(sql).toContain("effective_learning_mode NOT IN ('suggest', 'automatic')");
    expect(sql).toContain("DELETE FROM task_note_knowledge_promotion_capabilities capability");
    expect(sql).toContain("SET search_path = pg_catalog, %I");
    expect(sql).toContain("resolve_task_note_knowledge_promotion_source(");
  });

  test("keeps Drizzle aligned with the two nullable-source partial identities", async () => {
    const schema = await readFile(scopedKnowledgeSchemaPath, "utf8");
    expect(schema).toContain("knowledge_claim_evidence_document_natural_identity_uq");
    expect(schema).toContain("knowledge_claim_evidence_task_note_natural_identity_uq");
    expect(schema).toContain(".where(sql`${table.documentVersionId} is not null`)");
    expect(schema).toContain(".where(sql`${table.taskNoteId} is not null`)");
    expect(schema).not.toContain('uniqueIndex("knowledge_claim_evidence_natural_identity_uq")');
  });

  test("adds one immutable content-free atomic replacement receipt and exact lifecycle function", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE "task_note_replacement_receipts"');
    expect(sql).not.toMatch(/task_note_replacement_receipts[\s\S]{0,2500}"(?:text|content)"/i);
    expect(sql).toContain('ALTER TABLE "task_note_replacement_receipts" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("Task-note replacement receipts are immutable");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION replace_task_note_for_attempt(");
    expect(sql).toContain("receipt_row.input_hash IS DISTINCT FROM calculated_input_hash");
    expect(sql).toContain("SET search_path = pg_catalog, %I");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION %I.replace_task_note_for_attempt(");
  });
});
