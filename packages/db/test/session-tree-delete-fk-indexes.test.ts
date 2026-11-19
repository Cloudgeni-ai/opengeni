import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

// Deleting a session tree runs under the exclusive workspace-control lock, and
// PostgreSQL fires one referential action per deleted session or turn row. On
// staging, these foreign keys had no index leading with their columns, so every
// cascaded row scanned the whole child table while every event append in the
// workspace waited (0.8-3.5 s for 1-12 turns). Migrations 1454-1470 add them.
const COVERED = [
  "subscription_operation_leases_workspace_id_turn_id_fkey",
  "session_turns_execution_context_turn_id_fkey",
  "session_events_session_id_fkey",
  "session_history_items_session_id_fkey",
  "sessions_execution_context_turn_id_fkey",
  "workspace_instruction_policy_snapshots_turn_id_fkey",
  "workspace_instruction_policy_snapshots_session_id_fkey",
  "company_profile_snapshots_turn_id_fkey",
  "company_profile_snapshots_session_id_fkey",
  "preference_registry_snapshots_turn_id_fkey",
  "preference_registry_snapshots_session_id_fkey",
  "session_background_commands_session_fk",
  "session_turn_delta_folds_turn_fk",
  "workspace_captures_turn_id_fkey",
  "sandbox_retained_processes_workspace_session_fk",
  "agent_learning_snapshots_workspace_id_turn_id_fkey",
  "retained_screenshot_artifacts_turn_fk",
] as const;

let shared: SharedTestDatabase;
let admin: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-tree-delete-fk-indexes");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  admin = postgres(shared.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await shared?.release();
});

test("session-tree cascade foreign keys are served by a valid index leading with their columns", async () => {
  const rows = await admin<{ conname: string; covered: boolean }[]>`
    select constraint_row.conname,
      exists (
        select 1 from pg_index index_row
        where index_row.indrelid = constraint_row.conrelid
          and index_row.indisvalid
          and index_row.indnkeyatts >= cardinality(constraint_row.conkey)
          and (index_row.indkey::int2[])[0:cardinality(constraint_row.conkey) - 1]
            @> constraint_row.conkey
          and (index_row.indkey::int2[])[0:cardinality(constraint_row.conkey) - 1]
            <@ constraint_row.conkey
          -- A partial index serves the cascade only when its predicate is
          -- implied by the FK column being non-null.
          and (
            index_row.indpred is null
            or (
              cardinality(constraint_row.conkey) = 1
              and pg_get_expr(index_row.indpred, index_row.indrelid) = format(
                '(%s IS NOT NULL)',
                (
                  select quote_ident(attribute.attname) from pg_attribute attribute
                  where attribute.attrelid = constraint_row.conrelid
                    and attribute.attnum = constraint_row.conkey[1]
                )
              )
            )
          )
      ) as covered
    from pg_constraint constraint_row
    where constraint_row.contype = 'f'
      and constraint_row.conname in ${admin(COVERED)}
    order by constraint_row.conname`;
  expect(rows.map((row) => row.conname).sort()).toEqual([...COVERED].sort());
  expect(rows.filter((row) => !row.covered)).toEqual([]);
});
