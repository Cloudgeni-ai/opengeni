import { describe, expect, test } from "bun:test";

import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migration = await Bun.file(
  new URL("../drizzle/0317_pr_review_pack.sql", import.meta.url),
).text();

const tables = ["pr_review_app_registrations", "pr_review_repository_bindings"] as const;

describe("PR Review Pack migration", () => {
  test("is additive, rolling, tenant-isolated, and runtime-postured", () => {
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });

  test("separates provider action credentials from generic webhook and run authority", () => {
    expect(migration).toContain('"credential_encrypted" text');
    expect(migration).not.toContain('"webhook_secret_encrypted"');
    expect(migration).not.toMatch(/"(?:access_token|private_key|webhook_secret)"\s+text/iu);
    expect(migration).toContain("pr_review_app_registrations_source_uq");
    expect(migration).toContain("pr_review_repository_bindings_trigger_uq");
    expect(migration).toContain('REFERENCES "automation_sources"("workspace_id", "id")');
    expect(migration).toContain('REFERENCES "automation_triggers"("workspace_id", "id")');
    expect(migration).not.toContain("pr_review_webhook_deliveries");
  });
});
