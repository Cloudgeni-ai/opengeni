import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0276_onboarding_proposal_initiating_human_guc.sql",
  import.meta.url,
);

describe("migration 0276 onboarding-proposal initiating-human GUC", () => {
  test("compares the frozen human against the canonical initiating-human GUC", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_onboarding_proposal()",
    );
    // The one predicate change: initiating-human GUC first, subject-id GUC as
    // the fallback for direct human writers that never set the former.
    expect(sql).toContain("AND proposal.initiating_human_subject_id = COALESCE(");
    expect(sql).toContain(
      "NULLIF(current_setting('opengeni.initiating_human_subject_id', true), '')",
    );
    expect(sql).toContain("current_setting('opengeni.subject_id', true)");
    // The rest of the 0269 trigger body must survive intact.
    expect(sql).toContain("instruction-policy proposal must identify its exact inactive draft");
    expect(sql).toContain(
      "instruction-policy proposal must identify a never-activated inactive draft",
    );
    expect(sql).toContain(
      "instruction-policy proposal must capture the exact active head baseline",
    );
    expect(sql).toContain("instruction-policy proposal must capture the exact inactive boundary");
    // CREATE OR REPLACE drops the pinned search_path; the hardening block
    // must re-pin it.
    expect(sql).toContain(
      "ALTER FUNCTION %I.workspace_instruction_policy_validate_onboarding_proposal()",
    );
    expect(sql).toContain("SET search_path = pg_catalog, %I, pg_temp");
  });
});
