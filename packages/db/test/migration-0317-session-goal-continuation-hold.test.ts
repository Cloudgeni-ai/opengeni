import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const migrationUrl = new URL("../drizzle/0317_session_goal_continuation_hold.sql", import.meta.url);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0317-goal-continuation-hold");
}, 180_000);

afterAll(async () => {
  await shared?.release();
});

describe("migration 0317 session goal continuation hold", () => {
  test("is an additive rolling migration with no backfill", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    for (const column of [
      "continuation_hold_turn_id",
      "continuation_hold_until",
      "continuation_hold_reason",
      "continuation_hold_set_at",
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
    }
    expect(sql).toContain('ADD CONSTRAINT "session_goals_continuation_hold_check"');
    // Additive only: an old worker that ignores the columns keeps the prior
    // immediate-continuation behaviour, so nothing is rewritten.
    expect(sql).not.toMatch(/\bUPDATE\s+"?session_goals"?/iu);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/iu);
    expect(sql).not.toMatch(/NO FORCE ROW LEVEL SECURITY/iu);
  });

  test("adds four nullable hold columns and the all-or-nothing check", async () => {
    if (!shared) return;
    const columns = await shared.admin<
      Array<{ column_name: string; data_type: string; is_nullable: string }>
    >`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'session_goals'
        and column_name like 'continuation_hold_%'
      order by column_name`;
    expect([...columns]).toEqual([
      { column_name: "continuation_hold_reason", data_type: "text", is_nullable: "YES" },
      {
        column_name: "continuation_hold_set_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
      { column_name: "continuation_hold_turn_id", data_type: "uuid", is_nullable: "YES" },
      {
        column_name: "continuation_hold_until",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
    ]);
    const [constraint] = await shared.admin<Array<{ definition: string }>>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'session_goals_continuation_hold_check'
        and conrelid = 'session_goals'::regclass`;
    expect(constraint?.definition).toBeTruthy();
    const definition = constraint!.definition.replace(/\s+/gu, " ");
    expect(definition).toContain("continuation_hold_turn_id IS NULL");
    expect(definition).toContain("continuation_hold_until IS NULL");
    expect(definition).toContain("continuation_hold_reason IS NULL");
    expect(definition).toContain("continuation_hold_set_at IS NULL");
    expect(definition).toContain("continuation_hold_turn_id IS NOT NULL");
    expect(definition).toContain("continuation_hold_until IS NOT NULL");
    expect(definition).toContain("continuation_hold_set_at IS NOT NULL");
    expect(definition).toContain("octet_length(continuation_hold_reason) <= 2048");
  });
});
