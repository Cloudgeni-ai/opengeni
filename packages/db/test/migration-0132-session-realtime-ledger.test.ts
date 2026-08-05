import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0132-realtime-ledger");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

describe("0132/0133 session realtime ledger migrations", () => {
  test("installs both exact FORCE-RLS runtime DML tables", async () => {
    const rows = await shared.admin<
      {
        tableName: string;
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
        c.relname as "tableName",
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
        and c.relname in ('session_realtime_connections', 'session_realtime_entries')
      order by c.relname`;
    expect(Array.from(rows)).toEqual([
      {
        tableName: "session_realtime_connections",
        rlsEnabled: true,
        rlsForced: true,
        policyCount: 1,
        appSelect: true,
        appInsert: true,
        appUpdate: true,
        appDelete: true,
      },
      {
        tableName: "session_realtime_entries",
        rlsEnabled: true,
        rlsForced: true,
        policyCount: 1,
        appSelect: true,
        appInsert: true,
        appUpdate: true,
        appDelete: true,
      },
    ]);
  });

  test("installs idempotency, epoch, ordered replay, and pending-outbound indexes", async () => {
    const indexes = await shared.admin<{ tableName: string; indexName: string }[]>`
      select tablename as "tableName", indexname as "indexName"
      from pg_indexes
      where schemaname = current_schema()
        and tablename in ('session_realtime_connections', 'session_realtime_entries')
      order by tablename, indexname`;
    expect(indexes.map((row) => row.indexName)).toEqual([
      "session_realtime_connections_epoch_uq",
      "session_realtime_connections_one_active_uq",
      "session_realtime_connections_one_preparing_uq",
      "session_realtime_connections_operation_uq",
      "session_realtime_connections_pkey",
      "session_realtime_entries_delegation_call_uq",
      "session_realtime_entries_delegation_terminal_uq",
      "session_realtime_entries_delegation_turn_uq",
      "session_realtime_entries_operation_uq",
      "session_realtime_entries_outbound_pending_idx",
      "session_realtime_entries_pkey",
      "session_realtime_entries_sequence_uq",
      "session_realtime_entries_source_update_uq",
    ]);
  });

  test("permits one call and one terminal outbound row to share an ordinary turn", async () => {
    const [constraint] = await shared.admin<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'session_realtime_entries'::regclass
        and conname = 'session_realtime_entries_turn_check'`;
    expect(constraint?.definition).toContain("delegation_call");
    expect(constraint?.definition).toContain("delegation_result");
    expect(constraint?.definition).toContain("provider_out");
  });
});
