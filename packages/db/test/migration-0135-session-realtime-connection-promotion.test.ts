import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0135-realtime-promotion");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

describe("0135 session realtime connection promotion migration", () => {
  test("defaults old writers to legacy promotion with a constrained schema marker", async () => {
    const columns = await shared.admin<
      Array<{ name: string; nullable: string; defaultValue: string | null }>
    >`
      select
        column_name as name,
        is_nullable as nullable,
        column_default as "defaultValue"
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'session_realtime_connections'
        and column_name = 'promotion_mode'`;
    expect(columns.map((column) => ({ ...column }))).toEqual([
      {
        name: "promotion_mode",
        nullable: "NO",
        defaultValue: "'legacy'::text",
      },
    ]);

    const constraints = await shared.admin<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'session_realtime_connections'::regclass
        and conname = 'session_realtime_connections_promotion_mode_check'`;
    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.definition).toContain("'legacy'::text");
    expect(constraints[0]?.definition).toContain("'staged'::text");
  });

  test("permits staged active plus preparing while every legacy open row remains exclusive", async () => {
    const indexes = await shared.admin<{ indexName: string; definition: string }[]>`
      select indexname as "indexName", indexdef as definition
      from pg_indexes
      where schemaname = current_schema()
        and tablename = 'session_realtime_connections'
        and indexname in (
          'session_realtime_connections_one_open_uq',
          'session_realtime_connections_one_active_uq',
          'session_realtime_connections_one_preparing_uq'
        )
      order by indexname`;

    expect(indexes.map((row) => row.indexName)).toEqual([
      "session_realtime_connections_one_active_uq",
      "session_realtime_connections_one_preparing_uq",
    ]);
    for (const index of indexes) {
      expect(index.definition).toContain("promotion_mode = 'legacy'::text");
      expect(index.definition).toContain("promotion_mode = 'staged'::text");
      expect(index.definition).toContain("'negotiating'::text");
      expect(index.definition).toContain("'ready'::text");
      expect(index.definition).toContain("'active'::text");
    }
    expect(indexes[0]?.definition).toContain("(state = 'active'::text)");
    expect(indexes[1]?.definition).toContain("state = ANY");
  });

  test("requires a negotiated answer for ready and active rows", async () => {
    const constraints = await shared.admin<{ name: string; definition: string }[]>`
      select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'session_realtime_connections'::regclass
        and conname in (
          'session_realtime_connections_state_check',
          'session_realtime_connections_terminal_check'
        )
      order by conname`;

    expect(constraints.map((row) => row.name)).toEqual([
      "session_realtime_connections_state_check",
      "session_realtime_connections_terminal_check",
    ]);
    expect(constraints[0]?.definition).toContain("'ready'::text");
    expect(constraints[1]?.definition).toContain("state = 'ready'::text");
    expect(constraints[1]?.definition).toContain("sdp_answer IS NOT NULL");
    expect(constraints[1]?.definition).toContain("negotiated_at IS NOT NULL");
    expect(constraints[1]?.definition).toContain("closed_at IS NULL");
  });
});
