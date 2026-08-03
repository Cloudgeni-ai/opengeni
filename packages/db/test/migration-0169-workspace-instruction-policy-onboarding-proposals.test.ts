import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("workspace instruction-policy onboarding proposal migration", () => {
  test("is rolling, immutable, FORCE-RLS protected, and cannot activate policy", async () => {
    const sql = await readFile(
      join(migrationsDir, "0169_workspace_instruction_policy_onboarding_proposals.sql"),
      "utf8",
    );
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain(
      'CREATE TABLE "workspace_instruction_policy_onboarding_proposals"',
    );
    expect(sql).toContain(
      "workspace_instruction_policy_onboarding_proposals_source_version_target_uq",
    );
    expect(sql).toContain("workspace_instruction_policy_validate_onboarding_proposal");
    expect(sql).toContain("revision.\"provenance_source\" = 'onboarding'");
    expect(sql).toContain('revision."provenance_source_id" = NEW."id"::text');
    expect(sql).toContain("workspace_instruction_policy_onboarding_proposals_immutable");
    expect(sql).toContain('ALTER TABLE "workspace_instruction_policy_onboarding_proposals"');
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain(
      'CREATE POLICY workspace_isolation ON "workspace_instruction_policy_onboarding_proposals"',
    );
    expect(sql.match(/opengeni_private\.workspace_rls_visible/g)).toHaveLength(2);
    expect(sql).toContain('"baseline_activation_version" = 0');
    expect(sql).toContain('"confidence_bps" BETWEEN 0 AND 10000');
    expect(sql).toContain('"status" = \'proposed\'');
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"workspace_instruction_policy_heads"/i);
    expect(sql).not.toMatch(/UPDATE\s+"workspace_instruction_policy_heads"/i);
  });
});