import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { INSTRUCTION_POLICY_STALE_BASELINE_DIAGNOSTIC } from "../src";

const migrationUrl = new URL("../drizzle/0293_confirm_time_rule_rebaseline.sql", import.meta.url);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0287-rebaseline");
});

afterAll(async () => {
  await shared?.release();
});

describe("migration 0293 confirm-time rule rebaseline", () => {
  test("moves proposal uniqueness to one per source per baseline", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain(
      'DROP INDEX "workspace_instruction_policy_onboarding_proposals_source_versio"',
    );
    expect(sql).toContain('"source_id", "source_version", "baseline_activation_version"');
    // The activation must resolve the live head and select by it rather than
    // assuming a single candidate row.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION activate_human_confirmed_learning_decision(");
    expect(sql).toContain(
      "AND proposal.baseline_revision_id IS NOT DISTINCT FROM current_instruction_head.revision_id",
    );
    expect(sql).toContain(
      "AND proposal.baseline_activation_version = current_instruction_activation_version",
    );
    // The stale signal the confirm path keys its rebaseline off must survive,
    // and must stay byte-identical to the constant the code matches on.
    expect(sql).toContain(INSTRUCTION_POLICY_STALE_BASELINE_DIAGNOSTIC);
    // CREATE OR REPLACE drops proconfig; the pin must be re-applied.
    expect(sql).toContain(
      "ALTER FUNCTION %I.activate_human_confirmed_learning_decision(uuid,uuid,uuid,uuid,uuid) ",
    );
    expect(sql).toContain("SET search_path = pg_catalog, %I, pg_temp");
  });

  test("keeps the activation seam SECURITY DEFINER with a pinned search_path", async () => {
    if (!shared) return;
    const rows = await shared.admin<
      Array<{ name: string; secdef: boolean; config: string[] | null }>
    >`
      select proname as name, prosecdef as secdef, proconfig as config
      from pg_proc where proname = 'activate_human_confirmed_learning_decision'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secdef).toBe(true);
    expect(
      (rows[0]!.config ?? []).some(
        (entry) => entry.startsWith("search_path=") && entry.includes("pg_catalog"),
      ),
    ).toBe(true);
  });
});
