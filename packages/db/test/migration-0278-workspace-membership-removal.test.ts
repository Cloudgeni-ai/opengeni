// Migration 0278: workspace-membership removal is one fenced SECURITY DEFINER
// teardown. Source contract plus the live definer posture; the behavioral
// protocol is exercised in workspace-membership-removal.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0278_workspace_membership_removal_fencing.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0278-membership-removal");
});

afterAll(async () => {
  await shared?.release();
});

describe("migration 0278 workspace membership removal fencing", () => {
  test("declares one rolling fenced-removal protocol", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("CREATE FUNCTION prepare_workspace_membership_removal_settlements(");
    expect(source).toContain("CREATE FUNCTION workspace_membership_removal_command(");
    expect(source).toContain(
      "CREATE FUNCTION opengeni_private.assert_workspace_membership_removal_actor(",
    );
    // Fail-closed guards, restated from the application layer.
    expect(source).toContain("a member cannot remove their own workspace membership");
    expect(source).toContain("cannot remove the last administering workspace member");
    expect(source).toContain("workspace member administration required");
    // The canonical settlement contract and lock prefix.
    expect(source).toContain("pending tool calls require canonical protocol settlement");
    expect(source).toContain("FOR SHARE");
    expect(source).toContain("FOR KEY SHARE");
    expect(source).toContain("FOR NO KEY UPDATE");
    // The personal-state fence the pre-0278 path took stays load-bearing.
    expect(source).toContain("session-personal-state:");
    // Interruption evidence uses the existing kind vocabulary; no constraint
    // rewrite and no schema shape change in a rolling migration.
    expect(source).toContain("'authority_change'");
    expect(source).not.toMatch(/\bALTER TABLE\b/u);
    expect(source).not.toMatch(/\bDROP TABLE\b/u);
    expect(source).not.toMatch(/\bTRUNCATE\b/u);
    // Definer hardening.
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION prepare_workspace_membership_removal_settlements(jsonb) FROM PUBLIC",
    );
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION workspace_membership_removal_command(jsonb) FROM PUBLIC",
    );
    expect(source).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')");
  });

  test("both seams are SECURITY DEFINER with a pinned search_path on the live database", async () => {
    if (!shared) return;
    const rows = await shared.admin<
      Array<{ name: string; secdef: boolean; config: string[] | null }>
    >`
      select proname as name, prosecdef as secdef, proconfig as config
      from pg_proc
      where proname in (
        'prepare_workspace_membership_removal_settlements',
        'workspace_membership_removal_command'
      )
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
