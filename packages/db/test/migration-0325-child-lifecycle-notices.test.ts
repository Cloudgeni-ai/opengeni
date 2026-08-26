import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const migrationUrl = new URL("../drizzle/0325_child_lifecycle_notices.sql", import.meta.url);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0325-child-lifecycle-notices");
}, 180_000);

afterAll(async () => {
  await shared?.release();
});

describe("migration 0325 child lifecycle notices", () => {
  test("is a rolling widening with no backfill", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain('ADD CONSTRAINT "system_updates_kind_check"');
    expect(sql).toContain('ADD CONSTRAINT "system_update_outbox_kind_check"');
    expect(sql).toContain('ADD CONSTRAINT "system_update_outbox_payload_kind_check"');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "session_system_updates_pending_kind_source_idx"',
    );
    // Rolling: kinds are widened and one index is added; no row is rewritten.
    expect(sql).not.toMatch(/\bUPDATE\s+"?session_system_update/iu);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/iu);
    expect(sql).not.toMatch(/NO FORCE ROW LEVEL SECURITY/iu);
  });

  test("accepts every child lifecycle kind on both tables and the pending partial index exists", async () => {
    if (!shared) return;
    const constraints = await shared.admin<Array<{ conname: string; definition: string }>>`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in (
        'system_updates_kind_check',
        'system_update_outbox_kind_check',
        'system_update_outbox_payload_kind_check'
      )
      order by conname`;
    const byName = new Map(
      constraints.map((row) => [row.conname, row.definition.replace(/\s+/gu, " ")]),
    );
    for (const kind of [
      "child_terminal_result",
      "child_requires_action",
      "child_requires_action_resolved",
      "child_paused",
      "child_waiting_capacity",
      "child_progress",
    ]) {
      expect(byName.get("system_updates_kind_check")).toContain(`'${kind}'`);
      expect(byName.get("system_update_outbox_kind_check")).toContain(`'${kind}'`);
    }
    for (const kind of [
      "scheduled_occurrence",
      "goal_continuation",
      "agent_message",
      "agent_steer_instruction",
      "media_generation_result",
    ]) {
      expect(byName.get("system_updates_kind_check")).toContain(`'${kind}'`);
      expect(byName.get("system_update_outbox_kind_check")).not.toContain(`'${kind}'`);
    }
    expect(byName.get("system_update_outbox_payload_kind_check")).toContain("= kind");
    const [index] = await shared.admin<Array<{ indexdef: string }>>`
      select indexdef
      from pg_indexes
      where indexname = 'session_system_updates_pending_kind_source_idx'`;
    expect(index?.indexdef.replace(/\s+/gu, " ")).toContain(
      "(workspace_id, session_id, kind, source_id) WHERE (state = 'pending'::text)",
    );
  });
});
