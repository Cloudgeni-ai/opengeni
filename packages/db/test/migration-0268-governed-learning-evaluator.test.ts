import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(root, "../drizzle/0268_governed_learning_decision_receipts.sql");
const schemaPath = join(root, "../src/governed-learning-evaluator-schema.ts");

describe("migration 0268 governed-learning evaluator", () => {
  test("is a rolling inert receipt authority with no destination mutation", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain('CREATE TABLE "governed_learning_decision_receipts"');
    expect(migration).toContain(
      'ALTER TABLE "governed_learning_decision_receipts" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain("Governed-learning decision receipts are immutable");
    expect(migration).toContain("automatic_eligible, confidence_floor_bps");
    expect(migration).not.toMatch(
      /(?:workspace_instruction_policy_apply_activation|preference_registry_apply|memory_save)\s*\(/,
    );
    expect(migration).not.toMatch(
      /INSERT INTO\s+(?:workspace_instruction_policy_heads|preference_registry_heads|knowledge_memories)/i,
    );
  });

  test("binds the exact accepted snapshot and proposal lineage before current-state evaluation", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const fragment of [
      "snapshot.id = p_policy_snapshot_id",
      "snapshot.attempt_id = p_attempt_id",
      "proposal.claim_id = p_claim_id",
      "proposal.evidence_id = p_evidence_id",
      "evidence.claim_id = p_claim_id",
      "evidence.polarity = 'supports'",
      "session.active_turn_id = p_turn_id",
      "turn.active_attempt_id = p_attempt_id",
      "interruption.state IN ('pending', 'delivered', 'acknowledged')",
    ]) {
      expect(migration).toContain(fragment);
    }
    expect(migration).toContain("proposal_row.status <> 'proposed'");
    expect(migration).toContain("review_row.state = 'revoked'");
    expect(migration).toContain("source.current_acl_generation");
    expect(migration).toContain(
      "document_authority.current_version_id IS DISTINCT FROM document_authority.version_id",
    );
    expect(migration).toContain("document_authority.object_version_generation IS DISTINCT FROM");
    expect(migration).toContain("task_note_row.status <> 'active'");
  });

  test("uses exact replay, canonical locks, and target-schema hardened definers", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("FOR KEY SHARE");
    expect(migration).toContain("FOR SHARE");
    expect(migration).toContain("Serialize review, contradictory-evidence, and relation admission");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(migration).toContain("receipt_row.input_hash <> calculated_input_hash");
    expect(migration).toContain("proposal was already evaluated under another operation");
    expect(migration).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(migration).toContain("REVOKE ALL ON TABLE %I.governed_learning_decision_receipts");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION %I.evaluate_governed_learning_proposal(",
    );
  });

  test("keeps the Drizzle declaration content-free", async () => {
    const schema = await readFile(schemaPath, "utf8");
    expect(schema).toContain('"governed_learning_decision_receipts"');
    expect(schema).not.toMatch(/(?:content|quote|citation|noteText):/);
    expect(schema).toContain("policySnapshotHash");
    expect(schema).toContain("evidenceAuthorityHash");
    expect(schema).toContain("reasonCodes");
  });
});
