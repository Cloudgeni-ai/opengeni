import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0270_governed_learning_history_inspection.sql",
  import.meta.url,
);

describe("migration 0270 governed-learning history inspection", () => {
  test("keeps receipt tables private behind exact-human bounded capabilities", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    for (const routine of [
      "inspect_governed_learning_decisions",
      "inspect_governed_learning_activations",
      "inspect_governed_learning_activation_undos",
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${routine}`);
      expect(sql).toContain(`'${routine}(uuid,uuid,text,integer)'`);
    }
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("opengeni_private.current_account_id()");
    expect(sql).toContain("opengeni_private.current_workspace_id()");
    expect(sql).toContain("opengeni_private.current_subject_id()");
    expect(sql).toContain("opengeni.principal_kind");
    expect(sql).toContain("IS DISTINCT FROM 'human_session'");
    expect(sql).toContain("p_limit > 101");
    expect(sql).toContain("receipt.initiating_human_subject_id = p_subject_id");
    expect(sql).toContain("session_reference_visible(");
    expect(sql).not.toMatch(/GRANT\s+SELECT\s+ON\s+governed_learning/iu);
  });
});
