import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0131-realtime");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

describe("0131 session realtime mode migration", () => {
  test("installs the exact FORCE-RLS, index, constraint, and runtime-grant contract", async () => {
    const [table] = await shared.admin<
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
        and c.relname = 'session_realtime_modes'`;
    expect(table).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      policyCount: 1,
      appSelect: true,
      appInsert: true,
      appUpdate: true,
      appDelete: true,
    });

    const indexes = await shared.admin<{ indexName: string; definition: string }[]>`
      select indexname as "indexName", indexdef as definition
      from pg_indexes
      where schemaname = current_schema()
        and tablename = 'session_realtime_modes'
      order by indexname`;
    expect(indexes.map((index) => index.indexName)).toEqual([
      "session_realtime_modes_active_lease_idx",
      "session_realtime_modes_one_active_uq",
      "session_realtime_modes_operation_uq",
      "session_realtime_modes_pkey",
    ]);
    expect(
      indexes.find((index) => index.indexName.endsWith("one_active_uq"))?.definition,
    ).toContain("WHERE (state = 'active'::text)");

    const constraints = await shared.admin<{ name: string }[]>`
      select conname as name
      from pg_constraint
      where conrelid = 'session_realtime_modes'::regclass
      order by conname`;
    expect(constraints.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "session_realtime_modes_workspace_account_fk",
        "session_realtime_modes_workspace_session_fk",
        "session_realtime_modes_terminal_check",
        "session_realtime_modes_owner_key_hash_check",
        "session_realtime_modes_lease_check",
      ]),
    );
  });
});
