import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0247_company_brain_governed_write_proposals.sql",
);

describe("migration 0247 Company Brain governed write proposals", () => {
  test("keeps onboarding validation and admits only exact workspace Knowledge instruction proposals", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain("workspace_instruction_policy_validate_onboarding_proposal");
    expect(sql).toContain("revision.\"provenance_source\" = 'onboarding'");
    expect(sql).toContain('revision."provenance_source_id" = NEW."id"::text');
    expect(sql).toContain("revision.\"provenance_source\" = 'knowledge_proposal'");
    expect(sql).toContain('revision."provenance_source_id" = NEW."source_id"');
    expect(sql).toContain('FROM "knowledge_change_proposals" proposal');
    expect(sql).toContain("proposal.\"scope_kind\" = 'workspace'");
    expect(sql).toContain('proposal."scope_workspace_id" = NEW."workspace_id"');
    expect(sql).toContain("proposal.\"target_kind\" = 'instruction_policy'");
    expect(sql).toContain("proposal.\"target_scope\" = 'workspace'");
    expect(sql).toContain('proposal."content_hash" = NEW."source_version"');
    expect(sql).toContain('NEW."source_version" = NEW."draft_content_hash"');
    expect(sql).toContain("must identify a never-activated inactive draft");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"workspace_instruction_policy_heads"/i);
    expect(sql).not.toMatch(/UPDATE\s+"workspace_instruction_policy_heads"/i);
  });

  test("creates preference proposals as an exact-attempt service without borrowing human_session", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE "company_brain_preference_proposal_receipts"');
    expect(sql).toContain("company_brain_preference_proposal_receipts_operation_uq");
    expect(sql).toContain("company_brain_preference_proposal_receipts_knowledge_uq");
    expect(sql).toContain("company_brain_preference_proposal_receipts_immutable");
    expect(sql).toContain('ALTER TABLE "company_brain_preference_proposal_receipts"');
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("preference_registry_create_knowledge_proposal_for_attempt");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("session.active_turn_id = p_turn_id");
    expect(sql).toContain("turn.active_attempt_id = p_attempt_id");
    expect(sql).toContain("attempt.execution_generation = p_execution_generation");
    expect(sql).toContain("interruption.state IN ('pending', 'delivered', 'acknowledged')");
    expect(sql).toContain("current_setting('opengeni.subject_id', true)");
    expect(sql).toContain("service:company-brain-governed-write:");
    expect(sql).toContain("proposal.actor_subject_id = actor_subject_id");
    expect(sql).toContain("review.actor_subject_id = actor_subject_id");
    expect(sql).toContain("proposal.target_kind = 'preference'");
    expect(sql).toContain("receipt.operation_id = p_operation_id");
    expect(sql).toContain("receipt_row.input_hash <> p_input_hash");
    expect(sql).toContain("receipt_row.preference_id");
    expect(sql).not.toContain("preference_row.status <> 'proposed'");
    expect(sql).not.toContain("preference_row.active_revision_id IS NOT NULL");
    expect(sql).toContain("'knowledge_proposal'");
    expect(sql).toContain("'untrusted_proposal'");
    expect(sql).toContain("'proposal_created'");
    expect(sql).not.toContain("opengeni.principal_kind");
    expect(sql).not.toContain("human_session");
    expect(sql).not.toMatch(/SET\s+status\s*=\s*'active'/i);
  });
});
