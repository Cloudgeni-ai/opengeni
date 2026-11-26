import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createDb, pruneHostExportOutbox } from "../src";

let shared: SharedTestDatabase;
let exporter: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-export-prune-hands-back-plans");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  exporter = createDb(shared.adminUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await exporter?.close();
  await shared?.release();
}, 60_000);

type Plan = { Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number } };

/** Buffers one statement touches, including the statements a function runs. */
async function warmBuffers(statement: string): Promise<number> {
  const connection = await shared.admin.reserve();
  try {
    let buffers = 0;
    // The first calls plan the function body; the steady state reuses the plan.
    for (let call = 0; call < 4; call += 1) {
      const [row] = await connection.unsafe<{ "QUERY PLAN": Plan[] }[]>(
        `explain (analyze, buffers, timing off, format json) ${statement}`,
      );
      const plan = row!["QUERY PLAN"][0]!.Plan;
      buffers = plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
    }
    return buffers;
  } finally {
    connection.release();
  }
}

const WINDOW = 5000;
const EXPIRED = 300;

// The pump prunes after every delivered batch. Delivered rows stay for an hour of
// grace, and the cursor index alone could not tell their age, so each prune read the
// heap row of every delivered row still in its grace window before finding none due.
test("pruning the host export outbox skips grace-window rows from the index", async () => {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from host_export_outbox where export_kind = 'session_event'`;
    // Delivered rows: some past their grace, the rest still inside it.
    await tx`
      insert into host_export_outbox (export_kind, export_cursor, source_id, account_id,
        workspace_id, event_type, idempotency_key, payload, envelope_bytes, occurred_at,
        source_recorded_at, enqueued_at)
      select 'session_event', n, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        'agent.message.completed', 'prune-' || n,
        jsonb_build_object('text', (select string_agg(md5(n::text || g::text), '')
          from generate_series(1, 45) g)),
        1600, at, at, at
      from generate_series(1, ${EXPIRED + WINDOW}) n,
        lateral (select case when n <= ${EXPIRED}
          then now() - interval '3 hours' + n * interval '1 second'
          else now() - interval '50 minutes' + (n - ${EXPIRED}) * interval '50 minutes' / ${WINDOW}
        end as at) t`;
    await tx`
      insert into host_export_consumers (consumer_id, export_kind, checkpoint)
      values ('prune-plan', 'session_event', ${EXPIRED + WINDOW})
      on conflict (export_kind, consumer_id) do update set checkpoint = excluded.checkpoint`;
    // Assigning those cursors advanced the allocator past them.
    await tx`
      update host_export_cursor_state set next_cursor = ${EXPIRED + WINDOW + 1}, pruned_through = 0
      where export_kind = 'session_event'`;
  });
  await shared.admin`vacuum analyze host_export_outbox`;

  // Only the rows past their grace go, oldest cursor first, and the limit holds.
  expect(await pruneHostExportOutbox(exporter.db, { kind: "session_event", limit: 200 })).toBe(200);
  expect(await pruneHostExportOutbox(exporter.db, { kind: "session_event" })).toBe(EXPIRED - 200);
  expect(await pruneHostExportOutbox(exporter.db, { kind: "session_event" })).toBe(0);
  const [left] = await shared.admin<{ count: number; min: string; pruned: string }[]>`
    select count(*)::int as count, min(export_cursor)::text as min,
      (select pruned_through::text from host_export_cursor_state
       where export_kind = 'session_event') as pruned
    from host_export_outbox where export_kind = 'session_event'`;
  expect(left).toEqual({ count: WINDOW, min: String(EXPIRED + 1), pruned: String(EXPIRED) });

  // With nothing due, a prune reads index pages only: well under one buffer per
  // grace-window row (about 1,340 buffers here before, about 125 after).
  const buffers = await warmBuffers(
    "select opengeni_host_export.prune_host_export_outbox('session_event', 3600, 1000)",
  );
  expect(buffers).toBeLessThan(300);
}, 300_000);

const GOALS = 30_000;

// A finished top-level turn asks whether the chat hands back to the person, once for
// its push and once for its inbox item. Goals were only indexed by workspace, so the
// active-goal check read every active goal in the database.
test("the hands-back check finds a session's active goal by index", async () => {
  const [ids] = await shared.admin<{ idle: string; pursuing: string }[]>`
    select md5('goal-1')::uuid::text as idle, md5('goal-3')::uuid::text as pursuing`;
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into session_goals (account_id, workspace_id, session_id, text, status)
      select md5('a' || (n % 300))::uuid, md5('w' || (n % 300))::uuid, md5('goal-' || n)::uuid,
        'goal', case when n % 3 = 0 then 'active' else 'completed' end
      from generate_series(1, ${GOALS}) n`;
  });
  await shared.admin`analyze session_goals`;

  const handsBack = async (sessionId: string) => {
    const [row] = await shared.admin<{ value: boolean }[]>`
      select opengeni_private.session_hands_back_v1(${sessionId}::uuid, gen_random_uuid()) as value`;
    return row!.value;
  };
  expect(await handsBack(ids!.idle)).toBe(true);
  expect(await handsBack(ids!.pursuing)).toBe(false);

  // A session without an active goal is the common case and the worst one for a
  // scan: about 800 buffers here before, about 55 after.
  const buffers = await warmBuffers(
    `select opengeni_private.session_hands_back_v1('${ids!.idle}'::uuid, gen_random_uuid())`,
  );
  expect(buffers).toBeLessThan(200);
}, 300_000);
