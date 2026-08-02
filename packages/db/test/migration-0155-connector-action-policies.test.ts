import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = new URL("../drizzle/0155_connector_action_policies.sql", import.meta.url);

describe("0155 connector action policy migration contract", () => {
  test("is rolling, bounded, FORCE-RLS, attempt-owned, and secret-free", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain("CREATE TABLE connector_action_policies");
    expect(sql).toContain("CREATE TABLE connector_action_requests");
    expect(sql).toContain("jsonb_array_length(connector_action_policies) <= 2048");
    expect(sql).toContain("connector_action_requests_creation_attempt_fk");
    expect(sql).toContain("connector_action_requests_execution_attempt_fk");
    expect(sql).toContain("ON DELETE CASCADE");
    expect(sql).toContain("connector action request identity is immutable");
    expect(sql).toContain("connector action approval decision is immutable");
    expect(sql).toContain("ALTER TABLE connector_action_policies FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE connector_action_requests FORCE ROW LEVEL SECURITY");
    expect(sql).not.toMatch(
      /\b(?:arguments|credentials?|request_payload|response_payload)\b\s+jsonb/i,
    );
  });

  test("keeps runtime posture explicit for both protected tables", () => {
    for (const table of ["connector_action_policies", "connector_action_requests"] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });
});
