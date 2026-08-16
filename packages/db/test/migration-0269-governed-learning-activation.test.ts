import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(root, "../drizzle/0269_governed_learning_activation_controller.sql");

describe("migration 0269 governed-learning activation controller", () => {
  test("is rolling, content-free, FORCE-RLS and grants only controller capabilities", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of [
      "governed_learning_activation_receipts",
      "governed_learning_activation_undo_receipts",
      "workspace_instruction_policy_deactivation_events",
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL ON TABLE %I.${table}`);
    }
    expect(migration).not.toMatch(
      /"(?:proposal_content|note_text|fact_value|quote|citation)"\s+(?:text|jsonb)/i,
    );
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION %I.activate_governed_learning_decision");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION %I.undo_governed_learning_activation");
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION %I\.governed_learning_apply_/);
  });

  test("revalidates policy, evidence, review, conflicts and destination CAS", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const fragment of [
      "receipt.outcome = 'automatic' AND receipt.automatic_eligible",
      "policy_head.revision_id IS DISTINCT FROM decision_row.policy_revision_id",
      "current_mode <> 'automatic'",
      "proposal.status = 'proposed'",
      "review_row.state <> 'proposed'",
      "conflict_count <> 0",
      "note.status = 'active' AND note.expires_at > transaction_timestamp()",
      "document_authority.current_version_id IS DISTINCT FROM document_authority.version_id",
      "instruction_proposal.baseline_activation_version",
      "preference.active_revision_id IS NULL AND preference.activation_version = 0",
    ]) {
      expect(migration).toContain(fragment);
    }
  });

  test("uses service actors, append-only Knowledge review and exact null-head undo", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("service:governed-learning-activation:");
    expect(migration).toContain("governed_learning_apply_knowledge_review");
    expect(migration).toContain("automatic_deactivate");
    expect(migration).toContain(
      "DELETE FROM workspace_instruction_policy_heads WHERE id = current_head.id",
    );
    expect(migration).not.toContain('ALTER COLUMN "revision_id" DROP NOT NULL');
    expect(migration).not.toContain("revision_id = NULL, revision = NULL, content_hash = NULL");
    expect(migration).toContain(
      "latest_review.id IS DISTINCT FROM activation_row.knowledge_approval_review_id",
    );
    expect(migration).toContain("automatic instruction-policy activation was superseded");
    expect(migration).toContain("automatic preference activation was superseded");
  });

  test("hardens every definer against TEMP shadowing", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const routine of [
      "governed_learning_apply_knowledge_review",
      "workspace_instruction_policy_validate_head",
      "workspace_instruction_policy_validate_onboarding_proposal",
      "workspace_instruction_policy_validate_deactivation_event",
      "governed_learning_apply_instruction_policy",
      "governed_learning_deactivate_instruction_policy",
      "workspace_instruction_policy_canonical_snapshot_entries",
      "governed_learning_apply_preference",
      "activate_governed_learning_decision",
      "undo_governed_learning_activation",
    ]) {
      expect(migration).toContain(`ALTER FUNCTION %I.${routine}`);
    }
    expect(
      migration.match(/SET search_path = pg_catalog, %I, pg_temp/g)?.length,
    ).toBeGreaterThanOrEqual(12);
  });
});
