import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("workspace instruction-policy operation receipt migration", () => {
  test("is rolling, additive, and leaves immutable legacy history untouched", async () => {
    const sql = await readFile(
      join(migrationsDir, "0168_workspace_instruction_policy_operation_receipts.sql"),
      "utf8",
    );
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain(
      'ALTER TABLE "workspace_instruction_policy_revisions"\n  ADD COLUMN IF NOT EXISTS "operation_id" uuid',
    );
    expect(sql).toContain(
      'ALTER TABLE "workspace_instruction_policy_activation_events"\n  ADD COLUMN IF NOT EXISTS "operation_id" uuid',
    );
    expect(sql).toContain("workspace_instruction_policy_revisions_workspace_operation_uq");
    expect(sql).toContain("workspace_instruction_policy_events_workspace_operation_uq");
    expect(sql.match(/WHERE "operation_id" IS NOT NULL/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/SET\s+NOT\s+NULL/i);
  });
});
