import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("workspace instruction-policy migration", () => {
  test("is rolling, additive, FORCE-RLS protected, and performs no backfill", async () => {
    const sql = await readFile(
      join(migrationsDir, "0129_workspace_instruction_policies.sql"),
      "utf8",
    );
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "workspace_instruction_policy_revisions"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "workspace_instruction_policy_heads"');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "workspace_instruction_policy_activation_events"',
    );
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(sql.match(/CREATE POLICY workspace_isolation/g)).toHaveLength(3);
    expect(sql).toContain("workspace_instruction_policy_heads_charter_uq");
    expect(sql).toContain("workspace_instruction_policy_heads_global_policy_uq");
    expect(sql).toContain("workspace_instruction_policy_heads_role_policy_uq");
    expect(sql).toContain("workspace_instruction_policy_validate_event");
    expect(sql).toContain("workspace_instruction_policy_validate_head");
    expect(sql).toContain("workspace_instruction_policy_revisions_immutable");
    expect(sql).toContain("workspace_instruction_policy_events_immutable");
    expect(sql.match(/opengeni_private\.workspace_rls_visible/g)).toHaveLength(6);
    expect(sql).not.toMatch(/INSERT\s+INTO[\s\S]+SELECT/i);
    expect(sql).not.toContain('UPDATE "workspaces"');
  });
});
