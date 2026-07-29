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
  test("permits one active connection beside one negotiating or ready replacement", async () => {
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
    expect(indexes[0]?.definition).toContain("WHERE (state = 'active'::text)");
    expect(indexes[1]?.definition).toContain("state = ANY");
    expect(indexes[1]?.definition).toContain("'negotiating'::text");
    expect(indexes[1]?.definition).toContain("'ready'::text");
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
