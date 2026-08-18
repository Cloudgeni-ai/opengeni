import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../drizzle/0285_widen_task_note_expiry_ceiling.sql", import.meta.url);

describe("migration 0285 widen task-note expiry ceiling", () => {
  test("widens the CHECK constraint and both SECURITY DEFINER bounds to 90 days", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    // Low-lock widen: DROP + ADD ... NOT VALID + VALIDATE, matching 0238's pattern.
    expect(sql).toContain('DROP CONSTRAINT "task_notes_expiry_check"');
    expect(sql).toContain(
      '"expires_at" > "created_at" AND "expires_at" <= "created_at" + interval \'90 days\'',
    );
    expect(sql).toContain("NOT VALID");
    expect(sql).toContain('VALIDATE CONSTRAINT "task_notes_expiry_check"');
    // Both SECURITY DEFINER functions widened, byte-identical bodies otherwise.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION create_task_note_for_attempt(");
    expect(sql).toContain("OR p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 90");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION replace_task_note_for_attempt(");
    expect(sql).toContain("OR p_replacement_expires_in_days NOT BETWEEN 1 AND 90");
    // The unrelated byte-length bounds on the same functions must be untouched.
    expect(sql).toContain("octet_length(p_text) NOT BETWEEN 1 AND 4096");
    expect(sql).toContain("octet_length(p_replacement_text) NOT BETWEEN 1 AND 4096");
    expect(sql).toContain("octet_length(p_reason) NOT BETWEEN 1 AND 2048");
    // Neither function's 30-day bound should survive.
    expect(sql).not.toContain("NOT BETWEEN 1 AND 30");
    // Both functions keep their SECURITY DEFINER / FROM CURRENT search_path
    // exactly as-is - no re-pin needed since the search_path clause is
    // unchanged (not a `SET search_path = ...` literal being replaced).
    expect(sql.match(/SECURITY DEFINER/g)?.length).toBe(2);
    expect(sql.match(/SET search_path FROM CURRENT/g)?.length).toBe(2);
  });
});
