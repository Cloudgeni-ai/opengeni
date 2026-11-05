import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession, recordModelCallFact } from "../src/index";

// An Insights hourly rollup group must never hold a negative amount: readers
// reject negative quantities, so one such row fails every usage read that
// covers its hour. Deleting facts whose rollup row is missing or smaller than
// them must rebuild the group from facts instead of storing the difference.

setDefaultTimeout(120_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("insights-hourly-nonnegative");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 600_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const HOUR = new Date("2026-11-01T20:00:00Z");
const NEXT_HOUR = new Date("2026-11-01T21:00:00Z");

async function scope() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "rollup",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "rollup",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = async () =>
    (
      await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "low",
        latencyMode: "standard",
        sandboxBackend: "none",
      })
    ).id;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, session };
}

async function recordFacts(
  base: { accountId: string; workspaceId: string },
  sessionId: string,
  count: number,
  model = "codex/gpt-test",
) {
  for (let i = 0; i < count; i++) {
    await recordModelCallFact(client.db, {
      accountId: base.accountId,
      workspaceId: base.workspaceId,
      sessionId,
      turnId: crypto.randomUUID(),
      sourceKey: `fact-${i}`,
      provider: "codex-subscription",
      providerApi: "responses",
      model,
      billingPath: "external",
      pricedCostMicros: 0,
      estimatedProviderCostMicros: 1_000 + i * 7,
      pricingSource: "configured_list_price",
      inputTokens: 1_000 + i * 50,
      cachedTokens: 400 + i * 10,
      cacheWriteTokens: 0,
      outputTokens: 80 + i * 3,
      reasoningTokens: 9 + i,
      occurredAt: new Date(HOUR.getTime() + (10 + i) * 60_000),
    });
  }
}

const MEASURES = `session_id, provider, model, payer, scheduled_task_id, recorded_at, calls, "tokenKnownCalls",
  "cacheKnownCalls", "cacheWriteKnownCalls", "listClassKnownCalls", "uncachedInput", "cacheRead", "cacheWrite",
  output, reasoning, "listMicros", "pricedCalls", "listApproxCalls", "listUncachedInput", "listCacheRead",
  "listCacheWrite", "listOutput"`;

async function rollups(workspaceId: string) {
  return await shared.admin.unsafe(
    `select ${MEASURES} from opengeni_private.insights_usage_hourly_rollups
     where workspace_id = $1 order by session_id, model`,
    [workspaceId],
  );
}

async function truth(base: { accountId: string; workspaceId: string }) {
  return await shared.admin.unsafe(
    `select ${MEASURES} from opengeni_insights_internal.insights_usage_hourly_scan($1, $2, $3, $4)
     order by session_id, model`,
    [base.accountId, base.workspaceId, HOUR, NEXT_HOUR],
  );
}

async function expectExact(base: { accountId: string; workspaceId: string }) {
  const rows = await rollups(base.workspaceId);
  expect(rows).toEqual(await truth(base));
  const [negative] = await shared.admin`
    select count(*)::int as n from opengeni_private.insights_usage_hourly_rollups
    where workspace_id = ${base.workspaceId}
      and least(calls, "uncachedInput", "cacheRead", output, reasoning, "listMicros") < 0`;
  expect(negative!.n).toBe(0);
  const [queued] = await shared.admin`
    select count(*)::int as n from opengeni_private.insights_usage_hourly_repairs`;
  expect(queued!.n).toBe(0);
  return rows;
}

test("deleting facts after their rollup row was removed leaves no negative row", async () => {
  const base = await scope();
  const deleted = await base.session();
  const kept = await base.session();
  await recordFacts(base, deleted, 4);
  await recordFacts(base, kept, 2);
  expect(await expectExact(base)).toHaveLength(2);

  // A cleanup that removes a chat's rows table by table: the rollup row goes
  // first, then its facts. Each fact delete used to insert a negated row.
  await shared.admin`
    delete from opengeni_private.insights_usage_hourly_rollups where session_id = ${deleted}`;
  await shared.admin`delete from model_call_facts where session_id = ${deleted}`;

  const rows = await expectExact(base);
  expect(rows.map((row) => row.session_id)).toEqual([kept]);
});

test("a delete from a group smaller than its facts rebuilds the group at commit", async () => {
  const base = await scope();
  const sessionId = await base.session();
  await recordFacts(base, sessionId, 4);
  await recordFacts(base, sessionId, 1, "codex/gpt-other");

  // Simulate a group that lost amounts: it now holds a single call.
  await shared.admin`
    update opengeni_private.insights_usage_hourly_rollups
    set calls = 1, "tokenKnownCalls" = 1, "cacheKnownCalls" = 1, "cacheWriteKnownCalls" = 1,
      "uncachedInput" = 600, "cacheRead" = 400, output = 80, reasoning = 9, "listMicros" = 1000,
      "pricedCalls" = 1
    where session_id = ${sessionId} and model = 'codex/gpt-test'`;

  // One statement deletes two facts of the group, then later statements of
  // the same transaction keep writing to it. Row triggers of that statement
  // see the statement's full effect, so only a commit-time rebuild is exact.
  await shared.admin.begin(async (tx) => {
    await tx`
      delete from model_call_facts
      where session_id = ${sessionId} and model = 'codex/gpt-test' and source_key in ('fact-0', 'fact-1')`;
    await tx`
      delete from model_call_facts
      where session_id = ${sessionId} and model = 'codex/gpt-test' and source_key = 'fact-2'`;
  });
  await recordFacts(base, sessionId, 1, "codex/gpt-test");

  const rows = await expectExact(base);
  expect(rows.map((row) => [row.model, row.calls])).toEqual([
    ["codex/gpt-other", "1"],
    ["codex/gpt-test", "2"],
  ]);
});

test("ordinary deletes and moves between groups stay exact", async () => {
  const base = await scope();
  const sessionId = await base.session();
  await recordFacts(base, sessionId, 3);
  await recordFacts(base, sessionId, 2, "codex/gpt-other");

  await shared.admin`
    delete from model_call_facts where session_id = ${sessionId} and source_key = 'fact-2'
      and model = 'codex/gpt-test'`;
  await expectExact(base);
  await shared.admin`
    update model_call_facts set model = 'codex/gpt-other'
    where session_id = ${sessionId} and source_key = 'fact-1' and model = 'codex/gpt-test'`;
  expect((await expectExact(base)).map((row) => [row.model, row.calls])).toEqual([
    ["codex/gpt-other", "3"],
    ["codex/gpt-test", "1"],
  ]);
  await shared.admin`delete from model_call_facts where session_id = ${sessionId}`;
  expect(await expectExact(base)).toHaveLength(0);
});

test("the repair rebuilds every hour that holds a negative row, once", async () => {
  const base = await scope();
  const kept = await base.session();
  const deleted = await base.session();
  await recordFacts(base, kept, 2);
  // A negative row for a chat without facts, and a corrupted live group.
  await shared.admin`
    insert into opengeni_private.insights_usage_hourly_rollups
    values (${base.accountId}, ${base.workspaceId}, ${HOUR}, ${deleted}, 'codex-subscription',
      'codex/gpt-test', 'subscription', null, null, -4, -4, -4, -4, 0, -24125, -43392, 0, -2326, -198,
      -75851, -4, 0, 0, 0, 0, 0)`;
  await shared.admin`
    update opengeni_private.insights_usage_hourly_rollups set output = -1 where session_id = ${kept}`;

  const repair = () =>
    shared.admin`select opengeni_insights_internal.insights_usage_hourly_repair_negative_hours() as n`;
  const [first] = await repair();
  expect(first!.n).toBeGreaterThanOrEqual(1);
  const rows = await expectExact(base);
  expect(rows.map((row) => row.session_id)).toEqual([kept]);
  const [second] = await repair();
  expect(second!.n).toBe(0);
});
