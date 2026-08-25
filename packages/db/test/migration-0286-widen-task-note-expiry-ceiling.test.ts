import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const migrationUrl = new URL("../drizzle/0286_widen_task_note_expiry_ceiling.sql", import.meta.url);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0285-task-note-expiry");
}, 180_000);

afterAll(async () => {
  await shared?.release();
});

describe("migration 0286 widen task-note expiry ceiling", () => {
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
    // CREATE OR REPLACE drops proconfig entirely - the search_path pin both
    // functions originally received via ALTER FUNCTION in 0239/0260 must be
    // re-applied here, or the widen silently de-hardens them.
    expect(sql.match(/SECURITY DEFINER/g)?.length).toBe(2);
    expect(sql.match(/SET search_path FROM CURRENT/g)?.length).toBe(2);
    expect(sql).toContain("ALTER FUNCTION %I.create_task_note_for_attempt(");
    expect(sql).toContain("ALTER FUNCTION %I.replace_task_note_for_attempt(");
    expect(sql.match(/SET search_path = pg_catalog, %I, pg_temp/g)?.length).toBe(2);
  });

  test("both functions are SECURITY DEFINER with a pinned search_path on the live database", async () => {
    if (!shared) return;
    const rows = await shared.admin<
      Array<{ name: string; secdef: boolean; config: string[] | null }>
    >`
      select proname as name, prosecdef as secdef, proconfig as config
      from pg_proc
      where proname in ('create_task_note_for_attempt', 'replace_task_note_for_attempt')
      order by proname`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.secdef).toBe(true);
      expect(
        (row.config ?? []).some(
          (entry) => entry.startsWith("search_path=") && entry.includes("pg_catalog"),
        ),
      ).toBe(true);
    }
  });
});
