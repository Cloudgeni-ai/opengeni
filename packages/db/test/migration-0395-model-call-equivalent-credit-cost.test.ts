import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0395_model_call_equivalent_credit_cost.sql",
);

describe("migration 0395 model-call equivalent credit cost", () => {
  test("adds nullable comparison truth without repricing historical calls", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "equivalent_credit_cost_micros" bigint');
    expect(sql).toContain('"estimated_provider_cost_micros" IS NOT NULL');
    expect(sql).not.toMatch(/UPDATE\s+"model_call_facts"/i);
  });
});
