import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0260_preference_knowledge_proposal_actor_binding.sql",
);

describe("migration 0260 Knowledge-backed Ways adapter repair", () => {
  test("replaces only the existing rolling-safe functions with exact target and actor bindings", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("-- deployment-mode: rolling");
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '10min'");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION preference_registry_create_knowledge_proposal_for_attempt(",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_onboarding_proposal()",
    );
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path FROM CURRENT");
    expect(migration).toContain("v_actor_subject_id text;");
    expect(migration).toContain("proposal.actor_subject_id = v_actor_subject_id");
    expect(migration).toContain("review.actor_subject_id = v_actor_subject_id");
    expect(migration).toContain('proposal."target_scope" = NEW."scope"');
    expect(migration).toContain('WHEN NEW."scope" = \'role\' THEN NEW."role_key"');
    expect(migration).not.toMatch(/\.actor_subject_id\s*=\s*actor_subject_id\b/);
    expect(migration).not.toContain("CREATE TABLE");
    expect(migration).not.toContain("ALTER TABLE");
    expect(migration).not.toContain("GRANT ");
    expect(migration).not.toContain("REVOKE ");
  });
});
