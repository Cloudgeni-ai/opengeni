import { afterAll, beforeAll, expect, test } from "bun:test";
import { InsightsCallsQuery } from "@opengeni/contracts/insights-usage";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
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

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

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

  const page = await readInsightsCalls(client.db, {
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

  // The function prices calls with exactly this subquery; plan it at the same shape.
  const [definition] = await shared.admin<{ body: string }[]>`
    select pg_get_functiondef('opengeni_private.insights_scoped_calls_rows'::regproc) as body`;
  expect(definition!.body.replace(/\s+/g, " ")).toContain(
    "WHERE c.account_id=a AND c.workspace_id=w.id AND c.type='model_usage_debit' AND c.source_type='model_response' AND c.amount_micros<0 AND c.source_id=f.turn_id::text||':'||f.source_key",
  );
  const [explained] = await shared.admin.unsafe<{ "QUERY PLAN": [{ Plan: PlanNode }] }[]>(
    `explain (analyze, buffers, format json)
     select f.id, (select coalesce(-sum(c.amount_micros), 0) from public.credit_ledger_entries c
       where c.account_id = $1 and c.workspace_id = $2 and c.type = 'model_usage_debit'
         and c.source_type = 'model_response' and c.amount_micros < 0
         and c.source_id = f.turn_id::text || ':' || f.source_key)
     from public.model_call_facts f
     where f.account_id = $1 and f.workspace_id = $2
     order by f.occurred_at desc, f.id desc limit 101`,
    [grant.accountId, workspaceId],
  );
  const nodes = planNodes(explained!["QUERY PLAN"][0].Plan);
  const ledgerScans = nodes.filter((node) => node["Relation Name"] === "credit_ledger_entries");
  expect(ledgerScans.map((node) => node["Index Name"])).toEqual([
    "credit_ledger_entries_model_debit_source_idx",
  ]);
  const ledgerBlocks = ledgerScans.reduce(
    (sum, node) => sum + (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0),
    0,
  );
  // A handful of blocks per call; the account-wide scan read thousands per call.
  expect(ledgerBlocks).toBeLessThan(101 * 8);
}, 300_000);
