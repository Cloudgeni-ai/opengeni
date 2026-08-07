import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0183_model_call_provider_cost_estimates.sql",
);

describe("migration 0183 model-call provider cost estimates", () => {
  test("adds nullable provider-rate truth without rewriting historical credit prices", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "estimated_provider_cost_micros" bigint');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "pricing_source" text');
    expect(sql).toContain("'configured_list_price', 'gateway_reported'");
    expect(sql).not.toMatch(/UPDATE\s+"model_call_facts"/i);
    expect(sql).not.toMatch(/SET\s+"estimated_provider_cost_micros"\s*=\s*"priced_cost_micros"/i);
  });
});
