import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0245_model_context_contribution_facts.sql",
);
const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../src/schema.ts");

describe("migration 0245 model-context contribution facts", () => {
  test("keeps the validator private while allowing app-role constraint evaluation", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.model_context_contributions_valid(jsonb)\n  FROM PUBLIC;",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION opengeni_private.model_context_contributions_valid(jsonb)\n      TO opengeni_app;",
    );
    expect(sql).not.toContain("opengeni_artifact_materializer");
    expect(sql).not.toContain("jsonb_object_length");
    expect(sql).toContain("(SELECT count(*) FROM pg_catalog.jsonb_object_keys(contribution)) <> 4");
    expect(sql).toContain(
      'CHECK (opengeni_private.model_context_contributions_valid("context_contributions")) NOT VALID',
    );
    expect(sql).toContain('VALIDATE CONSTRAINT "model_call_facts_context_contributions_check"');

    const schema = await readFile(schemaPath, "utf8");
    expect(schema).toContain(
      "sql`opengeni_private.model_context_contributions_valid(${table.contextContributions})`",
    );
    expect(schema).not.toContain("jsonb_typeof(${table.contextContributions}) = 'array'");
  });
});
