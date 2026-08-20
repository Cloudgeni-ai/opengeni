import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0271_company_brain_retrieval_only_default.sql",
  import.meta.url,
);
const baseMigrationUrl = new URL(
  "../drizzle/0259_company_brain_context_selection_receipts.sql",
  import.meta.url,
);

describe("migration 0271 retrieval-only default", () => {
  test("is a rolling redefinition of both 0259 mode-resolution sites with retrieval_only fallback", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION capture_company_brain_turn_context_snapshot()",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION company_brain_context_get_or_create_selection(",
    );
    // Every fallback flips to retrieval_only; legacy_standing survives only as
    // the explicit opt-out.
    expect(sql).not.toContain("ELSE 'legacy_standing'");
    expect(sql.match(/WHEN 'legacy_standing' THEN 'legacy_standing'/g)?.length).toBe(3);
    expect(sql.match(/ELSE 'retrieval_only'/g)?.length).toBe(3);
    // No table, grant, or trigger changes: immutable snapshots/receipts and the
    // runtime capability surface stay exactly as 0259 declared them.
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE TRIGGER|GRANT|REVOKE/u);
    // CREATE OR REPLACE resets proconfig, so the 0259 definer search_path pin
    // must be re-applied to both replaced functions.
    expect(sql).toContain(
      "ALTER FUNCTION %1$I.capture_company_brain_turn_context_snapshot() SET search_path = %1$I, pg_catalog",
    );
    expect(sql).toContain(
      "ALTER FUNCTION %1$I.company_brain_context_get_or_create_selection(uuid,uuid,uuid,uuid,uuid,integer) SET search_path = %1$I, pg_catalog",
    );
  });

  test("keeps the redefined function bodies byte-identical to 0259 apart from the fallback", async () => {
    const [sql, base] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(baseMigrationUrl, "utf8"),
    ]);
    const normalize = (text: string) =>
      text
        .replaceAll("WHEN 'legacy_standing' THEN 'legacy_standing'", "WHEN 'X' THEN 'X'")
        .replaceAll("WHEN 'retrieval_only' THEN 'retrieval_only'", "WHEN 'X' THEN 'X'")
        .replaceAll("ELSE 'retrieval_only'", "ELSE 'Y'")
        .replaceAll("ELSE 'legacy_standing'", "ELSE 'Y'");
    const bodies = (text: string) =>
      [
        /CREATE OR REPLACE FUNCTION capture_company_brain_turn_context_snapshot\(\)[\s\S]*?\n\$\$;/u,
        /CREATE OR REPLACE FUNCTION company_brain_context_get_or_create_selection\([\s\S]*?\n\$\$;/u,
      ].map((pattern) => normalize(text.match(pattern)![0]));
    expect(bodies(sql)).toEqual(bodies(base));
  });
});
