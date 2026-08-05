import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0134-realtime-context");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

describe("0134 session realtime context projection migration", () => {
  test("installs the exact FORCE-RLS runtime DML table", async () => {
    const [row] = await shared.admin<
      {
        rlsEnabled: boolean;
        rlsForced: boolean;
        policyCount: number;
        appSelect: boolean;
        appInsert: boolean;
        appUpdate: boolean;
        appDelete: boolean;
      }[]
    >`
      select
        c.relrowsecurity as "rlsEnabled",
        c.relforcerowsecurity as "rlsForced",
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as "policyCount",
        has_table_privilege('opengeni_app', c.oid, 'select') as "appSelect",
        has_table_privilege('opengeni_app', c.oid, 'insert') as "appInsert",
        has_table_privilege('opengeni_app', c.oid, 'update') as "appUpdate",
        has_table_privilege('opengeni_app', c.oid, 'delete') as "appDelete"
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname = 'session_realtime_context_projections'`;
    expect(row).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      policyCount: 1,
      appSelect: true,
      appInsert: true,
      appUpdate: true,
      appDelete: true,
    });
  });

  test("installs the turn binding, pending-source index, and paired consumption marker", async () => {
    const indexes = await shared.admin<{ indexName: string; definition: string }[]>`
      select indexname as "indexName", indexdef as definition
      from pg_indexes
      where schemaname = current_schema()
        and tablename in ('session_realtime_context_projections', 'session_realtime_modes')
        and indexname in (
          'session_realtime_context_projections_turn_uq',
          'session_realtime_modes_pending_context_idx'
        )
      order by indexname`;
    expect(indexes.map((row) => row.indexName)).toEqual([
      "session_realtime_context_projections_turn_uq",
      "session_realtime_modes_pending_context_idx",
    ]);
    expect(indexes[0]?.definition).toContain("workspace_id, session_id, turn_id");
    expect(indexes[1]?.definition).toContain("context_projection_id IS NULL");

    const columns = await shared.admin<
      { columnName: string; dataType: string; nullable: boolean }[]
    >`
      select
        column_name as "columnName",
        data_type as "dataType",
        is_nullable = 'YES' as nullable
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'session_realtime_modes'
        and column_name in ('context_projection_id', 'context_projected_at')
      order by column_name`;
    expect(Array.from(columns)).toEqual([
      { columnName: "context_projected_at", dataType: "timestamp with time zone", nullable: true },
      { columnName: "context_projection_id", dataType: "uuid", nullable: true },
    ]);

    const constraints = await shared.admin<{ name: string; definition: string }[]>`
      select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in (
        'session_realtime_context_projections_context_check',
        'session_realtime_context_projections_counts_check',
        'session_realtime_modes_context_projection_fk',
        'session_realtime_modes_context_projection_check'
      )
      order by conname`;
    expect(constraints.map((row) => row.name)).toEqual([
      "session_realtime_context_projections_context_check",
      "session_realtime_context_projections_counts_check",
      "session_realtime_modes_context_projection_check",
      "session_realtime_modes_context_projection_fk",
    ]);
    expect(constraints.find((row) => row.name.endsWith("context_check"))?.definition).toContain(
      "65536",
    );
    expect(
      constraints.find((row) => row.name === "session_realtime_modes_context_projection_check")
        ?.definition,
    ).toContain("state = 'ended'");
  });
});
