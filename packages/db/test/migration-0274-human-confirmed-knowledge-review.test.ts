import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0274_human_confirmed_knowledge_review.sql",
  import.meta.url,
);

describe("migration 0274 human-confirmed knowledge review", () => {
  test("adds an immutable receipt ledger and a hardened confirmation capability", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain(`CREATE TABLE "remember_knowledge_confirmation_receipts"`);
    expect(sql).toContain(`FORCE ROW LEVEL SECURITY`);
    expect(sql).toContain("session_visibility_isolation");
    expect(sql).toContain("remember Knowledge confirmation receipts are immutable");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION confirm_remember_knowledge_claim(");
    expect(sql).toContain("SECURITY DEFINER");
    // Bound question: exact claim, live turn generation, responder, canonical
    // prompt, exact note text, fixed options, save answer.
    expect(sql).toContain("human_question_id := 'remember:' || p_claim_id::text;");
    expect(sql).toContain("human_question_help := left(task_note_row.text, 2000);");
    expect(sql).toContain("Save this as workspace knowledge for everyone in this workspace?");
    expect(sql).toContain("AND request.turn_generation = p_execution_generation");
    expect(sql).toContain("AND request.responded_by = caller_subject_id");
    expect(sql).toContain("AND question.value->>'prompt' = human_question_prompt");
    expect(sql).toContain("AND question.value->>'helpText' = human_question_help");
    expect(sql).toContain("AND answer.value->'values' = to_jsonb(ARRAY['save'])");
    // Approval goes through the guarded governed-learning service review path.
    expect(sql).toContain("FROM governed_learning_apply_knowledge_review(");
    expect(sql).toContain("review_row.state <> 'proposed'");
    // Hardening.
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION confirm_remember_knowledge_claim(uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid) FROM PUBLIC;",
    );
    expect(sql).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(sql).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)\s+ON\s+TABLE/iu);
  });
});
