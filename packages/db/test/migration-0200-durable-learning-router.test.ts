import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  FORCE_RLS_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_INSERT_TABLES,
} from "../src/runtime-posture";

const migrationUrl = new URL("../drizzle/0200_durable_learning_router.sql", import.meta.url);

describe("migration 0200 durable-learning router", () => {
  test("is rolling, append-only, tenant-scoped audit evidence", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of [
      "durable_learning_attempts",
      "durable_learning_receipts",
      "durable_learning_authority_results",
    ] as const) {
      expect(source).toContain(`CREATE TABLE "${table}"`);
      expect(source).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(source).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(source).toContain(`CREATE POLICY workspace_isolation ON "${table}"`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_READ_INSERT_TABLES).toContain(table);
    }
    expect(source).toContain("durable_learning_attempts_immutable");
    expect(source).toContain("durable_learning_receipts_immutable");
    expect(source).toContain("durable_learning_authority_results_immutable");
    expect(source).toContain("durable_learning_reject_mutation");
    expect(source).toContain("GRANT SELECT, INSERT ON TABLE");
    expect(source).toContain('CREATE TABLE "durable_learning_attempt_claims"');
    expect(source).toContain(
      'ALTER TABLE "durable_learning_attempt_claims" FORCE ROW LEVEL SECURITY',
    );
    expect(FORCE_RLS_TABLES).toContain("durable_learning_attempt_claims");
    expect(RUNTIME_FULL_DML_TABLES).toContain("durable_learning_attempt_claims");
    expect(source).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE");
    expect(source).toContain("durable_learning_attempt_claims_time_chk");
  });

  test("binds receipts and optional sessions to the exact tenant attempt", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source).toContain('UNIQUE ("account_id", "workspace_id", "id")');
    expect(source).toContain('FOREIGN KEY ("account_id", "workspace_id", "attempt_id")');
    expect(source).toContain(
      'REFERENCES "durable_learning_attempts"("account_id", "workspace_id", "id")',
    );
    expect(source).toContain("durable_learning_validate_attempt_session");
    expect(source).toContain(
      "durable learning attempt session is outside its exact account/workspace",
    );
    expect(source).toContain('"request" ->> \'attemptId\' = "id"::text');
    expect(source).toContain('"receipt" ->> \'attemptId\' = "attempt_id"::text');
    expect(source).toContain('"receipt" ->> \'inputHash\' = "input_hash"');
    expect(source).toContain("durable_learning_authority_results_attempt_fk");
    expect(source).toContain("'memory_write', 'memory_rollback'");
  });

  test("keeps the router ledger separate from every knowledge authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    const executable = source.replace(/^--.*$/gm, "");
    expect(executable).not.toMatch(/INSERT\s+INTO\s+"knowledge_memories"/i);
    expect(executable).not.toMatch(/INSERT\s+INTO\s+"preference_registry_/i);
    expect(executable).not.toMatch(/INSERT\s+INTO\s+"workspace_instruction_policy_/i);
    expect(executable).not.toMatch(/INSERT\s+INTO\s+"documents"/i);
  });
});
