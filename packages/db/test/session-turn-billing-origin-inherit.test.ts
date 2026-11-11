import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "../src/schema";
import { bootstrapWorkspace, registerDbBinding, withWorkspaceSessionActivityRls } from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

// A turn written without a billing origin inherits its chat's latest decided
// one. That lookup runs in a BEFORE INSERT trigger for every such turn, so it
// must probe an index rather than walk the chat's history: a long chat whose
// turns never had an origin would otherwise make each new turn read every
// earlier one.

let shared: SharedTestDatabase;
let driver: postgres.Sql;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-turn-billing-origin-inherit");
  if (!acquired) throw new Error("Application-role PostgreSQL fixture unavailable");
  shared = acquired;
  driver = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  db = drizzle(driver, { schema });
  registerDbBinding(db, { rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await shared?.release();
}, 60_000);

test("inheriting a turn's billing origin probes the index, however long the chat", async () => {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Origin inherit",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Origin inherit",
    subjectId: `origin-inherit-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const legacy = crypto.randomUUID();
  const decided = crypto.randomUUID();
  await withWorkspaceSessionActivityRls(db, grant.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into sessions(id, account_id, workspace_id, initial_message, model,
        reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
        root_session_id, status, created_by_kind, created_by_subject_id)
      select id, ${grant.accountId}, ${grant.workspaceId}, 'Origin inherit fixture',
        'test-model', 'medium', 'standard', 'none', id,
        jsonb_build_object('mode','explicit','inheritedFromSessionId',null),
        id, 'idle', 'service', 'scheduler'
      from (values (${legacy}::uuid), (${decided}::uuid)) chats(id)
    `);
  });
  const conn = await shared.admin.reserve();
  const insertTurns = (sessionId: string, from: number, to: number, origin: string | null) => conn`
    insert into session_turns(id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, execution_generation, position, prompt, model,
      reasoning_effort, latency_mode, sandbox_backend, source, surface,
      initiator_kind, initiator_subject_id, initiating_human_subject_id, billing_origin,
      created_at)
    select gen_random_uuid(), ${grant.accountId}, ${grant.workspaceId}, ${sessionId},
      gen_random_uuid(), gen_random_uuid()::text, 'completed', 1, ordinal, 'fixture prompt',
      'test-model', 'medium', 'standard', 'none', 'user', 'web', 'subject',
      ${grant.subjectId}, ${grant.subjectId}, ${origin},
      timestamptz '2026-01-01' + ordinal * interval '1 second'
    from generate_series(${from}::int, ${to}::int) ordinal
  `;
  const indexScans = async () => {
    // Publish this backend's counters, then read them past the stats cache.
    await conn`select pg_catalog.pg_stat_force_next_flush()`;
    await conn`select 1`;
    await conn`select pg_catalog.pg_stat_clear_snapshot()`;
    const [row] = await conn<{ scans: string | null }[]>`
      select idx_scan::text as scans from pg_catalog.pg_stat_user_indexes
      where indexrelname = 'session_turns_billing_origin_latest_idx'`;
    if (!row) throw new Error("the billing-origin lookup index is missing");
    return Number(row.scans ?? 0);
  };
  try {
    // A long chat from before origins: nothing to inherit, so every turn
    // stays unset (billed as app).
    await insertTurns(legacy, 1, 2_000, null);
    await conn`analyze session_turns`;
    const before = await indexScans();
    await insertTurns(legacy, 2_001, 2_200, null);
    const after = await indexScans();
    // Each inheriting insert asks the index for its chat's latest decided
    // origin (and its parent chat's), instead of reading the history.
    expect(after - before).toBeGreaterThanOrEqual(200);
    const [legacyOrigins] = await conn<{ unset: string }[]>`
      select count(*) filter (where billing_origin is null)::text as unset
      from session_turns where workspace_id = ${grant.workspaceId} and session_id = ${legacy}`;
    expect(legacyOrigins?.unset).toBe("2200");

    // A decided origin is still what later turns inherit.
    await insertTurns(decided, 1, 1, "api");
    await insertTurns(decided, 2, 50, null);
    const decidedOrigins = await conn<{ origin: string | null; turns: string }[]>`
      select billing_origin as origin, count(*)::text as turns from session_turns
      where workspace_id = ${grant.workspaceId} and session_id = ${decided}
      group by billing_origin`;
    expect([...decidedOrigins]).toEqual([{ origin: "api", turns: "50" }]);
  } finally {
    conn.release();
  }
}, 120_000);
