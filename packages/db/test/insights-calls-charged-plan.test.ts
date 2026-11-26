import { afterAll, beforeAll, expect, test } from "bun:test";
import { InsightsCallsQuery } from "@opengeni/contracts/insights-usage";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { bootstrapWorkspace, createDb, createSession, readInsightsCalls } from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("insights-calls-charged-plan");
  if (!acquired) throw new Error("PostgreSQL application-role plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const CALLS = 4000;

// The calls page prices each listed call by summing its ledger debits. Without an index
// keyed by the debit's source, every listed row re-read all of the account's debits, so a
// page of 100 calls cost 100 scans of the whole ledger.
test("pricing a page of calls reads only each call's own debits", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "insights charged",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "insights charged",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "m",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const now = new Date();
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into model_call_facts (account_id, workspace_id, session_id, turn_id, source_key, provider,
        provider_api, model, billing_path, priced_cost_micros, input_tokens, cached_tokens,
        cache_write_tokens, output_tokens, reasoning_tokens, occurred_at)
      select ${grant.accountId}::uuid, ${workspaceId}::uuid, ${session.id}::uuid, gen_random_uuid(),
        'k' || n, 'openai', 'responses', 'openai/gpt', 'opengeni_credits', 100, 100, 10, 0, 20, 5,
        ${now}::timestamptz - (n || ' minutes')::interval
      from generate_series(1, ${CALLS}) n`;
    // Each call has a debit of n micros; every third call was charged twice. A credit, a
    // debit of another type and a debit for an unrelated source must not count.
    await tx`
      insert into credit_ledger_entries (account_id, workspace_id, type, amount_micros, source_type,
        source_id, idempotency_key, occurred_at)
      select f.account_id, f.workspace_id, 'model_usage_debit', -(substr(f.source_key, 2)::bigint),
        'model_response', f.turn_id::text || ':' || f.source_key, 'charged-' || f.id || '-' || copy,
        f.occurred_at
      from model_call_facts f
      cross join generate_series(1, 2) copy
      where f.account_id = ${grant.accountId}::uuid
        and (copy = 1 or substr(f.source_key, 2)::bigint % 3 = 0)
      union all
      select f.account_id, f.workspace_id, 'model_usage_debit', 7, 'model_response',
        f.turn_id::text || ':' || f.source_key, 'credit-' || f.id, f.occurred_at
      from model_call_facts f where f.account_id = ${grant.accountId}::uuid
      union all
      select f.account_id, f.workspace_id, 'credit_purchase', -11, 'model_response',
        f.turn_id::text || ':' || f.source_key, 'other-' || f.id, f.occurred_at
      from model_call_facts f where f.account_id = ${grant.accountId}::uuid`;
  });
  await shared.admin`analyze model_call_facts`;
  await shared.admin`analyze credit_ledger_entries`;

  // The real read, through the application role: the pricing subquery must
  // probe the debit-source index, not scan the account's ledger per call.
  const indexScans = async () => {
    await shared.admin`select pg_stat_clear_snapshot()`;
    const [row] = await shared.admin<{ scans: string }[]>`
      select idx_scan::text as scans from pg_stat_user_indexes
      where indexrelname = 'credit_ledger_entries_model_debit_source_idx'`;
    return Number(row!.scans);
  };
  const scansBefore = await indexScans();
  // One connection, so it can flush its index statistics right after the read.
  const reader = createDb(shared.appUrl, { max: 1 });
  const page = await readInsightsCalls(reader.db, {
    accountId: grant.accountId,
    workspaceId,
    detailsWorkspaceIds: [workspaceId],
    now,
    query: InsightsCallsQuery.parse({ range: "30d" }),
  });
  expect(page.calls.length).toBeGreaterThan(10);
  for (const [index, call] of page.calls.entries()) {
    const n = index + 1;
    expect(call.chargedMicros).toBe(n % 3 === 0 ? 2 * n : n);
  }
  // Index statistics reach other sessions when the reading backend flushes them.
  await reader.db.execute(sql`select pg_stat_force_next_flush()`);
  await reader.db.execute(sql`select 1`);
  await reader.close();
  let scans = scansBefore;
  for (let attempt = 0; attempt < 50 && scans - scansBefore < page.calls.length; attempt += 1) {
    await Bun.sleep(100);
    scans = await indexScans();
  }
  // At least one probe per priced call.
  expect(scans - scansBefore).toBeGreaterThanOrEqual(page.calls.length);
}, 300_000);
