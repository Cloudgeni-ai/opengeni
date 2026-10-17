/** Disposable local PostgreSQL only. Run in a bounded systemd scope with
 * OPENGENI_REQUIRE_REAL_DB=1 bun scripts/bench-insights-hourly.ts.
 * 80 days x 50,000 facts, 7,000 sessions; each session active for six hours.
 * Prints full EXPLAIN JSON plus compact timings. Never uses a deployment URL.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../packages/db/src/schema";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import { InsightsUsageQuery } from "@opengeni/contracts/insights-usage";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  readInsightsUsage,
  registerDbBinding,
  withSessionRlsActorContext,
} from "../packages/db/src";
import { executeMigrationFile } from "../packages/db/src/migrate";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../packages/db/src/lossless-json";

if (
  process.env.OPENGENI_TEST_PG_URL &&
  !["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.OPENGENI_TEST_PG_URL).hostname)
)
  throw new Error("This benchmark only accepts a local disposable test cluster");
const retained = process.env.OPENGENI_INSIGHTS_LAB_DATABASE;
if (retained && !/^og_insights_hourly_lab_[a-f0-9]{12}$/.test(retained))
  throw new Error("Expected an exact retained hourly lab database name");
const allocated = await acquireSharedTestDatabase("insights-hourly-lab");
if (!allocated) throw new Error("Real local PostgreSQL required");
const retainedUrl = (value: string) => {
  const url = new URL(value);
  url.pathname = `/${retained}`;
  return url.toString();
};
const fixture = retained
  ? {
      admin: postgres(retainedUrl(allocated.adminUrl), { max: 4 }),
      appUrl: retainedUrl(allocated.appUrl),
      release: async () => {
        await allocated.release();
      },
    }
  : allocated;
const admin = fixture.admin;
const client = createDb(fixture.appUrl, { max: 1, rlsStrategy: "force" });
const app = postgres(fixture.appUrl, {
  max: 1,
  connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  onnotice: () => {},
});
const captured: { query: string; params: unknown[] }[] = [];
const db = drizzle(app, {
  schema,
  logger: {
    logQuery(query, params) {
      captured.push({ query, params });
    },
  },
});
registerDbBinding(db, { rlsStrategy: "force" });
const now = new Date("2026-10-17T23:37:21.123Z");
const results: Record<string, unknown> = {};
const ranges = ["today", "30d", "ytd"] as const;
try {
  const [existing] = retained
    ? await admin`select w.id workspace_id,w.account_id,m.subject_id from workspaces w
    join workspace_memberships m on m.workspace_id=w.id where w.name='Hourly benchmark' limit 1`
    : [];
  if (retained && !existing) throw new Error("Retained database has no hourly benchmark scope");
  const userId = `hourly-lab-${crypto.randomUUID()}`;
  const subjectId = existing?.subject_id ?? `user:${userId}`;
  const access = existing
    ? null
    : await ensureManagedAccessForUser(client.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Hourly lab",
      });
  const accountId = existing?.account_id ?? access!.workspaceGrants[0]!.accountId;
  const workspaceId = existing?.workspace_id ?? crypto.randomUUID();
  if (!existing) {
    await admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Hourly benchmark')`;
    await admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspaceId},${accountId})`;
    await admin`insert into workspace_memberships(account_id,workspace_id,subject_id,subject_label,role,permissions)
    values(${accountId},${workspaceId},${subjectId},'Hourly lab','owner','["workspace:admin"]')`;
  }
  const template = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Lab template",
    resources: [],
    metadata: {},
    model: "fixture",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    createdByContext: {},
  });
  const queries = new Map<string, { query: string; params: unknown[] }[]>();
  for (const range of ranges) {
    captured.length = 0;
    await withSessionRlsActorContext({ subjectId }, () =>
      readInsightsUsage(db, {
        accountId,
        workspaceId,
        now: retained ? new Date(now.getTime() - 365 * 86400000) : now,
        detailsWorkspaceIds: [workspaceId],
        query: InsightsUsageQuery.parse({ range, seriesGroups: true }),
      }),
    );
    queries.set(
      range,
      captured
        .filter(
          (x) =>
            x.query.includes("current_rows as materialized") || x.query.includes("end as prior"),
        )
        .map((q) => ({
          ...q,
          params: q.params.map((p) =>
            retained && typeof p === "string" && /^202[45]-\d\d-\d\dT.*Z$/.test(p)
              ? new Date(Date.parse(p) + 365 * 86400000).toISOString()
              : p,
          ),
        })),
    );
  }
  const [optimized] =
    await admin`select pg_get_functiondef('opengeni_private.insights_raw_amount_inputs(uuid,uuid,timestamptz,timestamptz)'::regprocedure) input,
    pg_get_functiondef('opengeni_private.insights_scoped_usage_rows(uuid,uuid,timestamptz,timestamptz,text,uuid[],boolean)'::regprocedure) scoped`;
  // Restore only 0604's raw input in this disposable DB; ledger/ACLs and the
  // independently installed Site audience remain the same.
  const source = await Bun.file(
    new URL("../packages/db/drizzle/0604_insights_raw_usage_api.sql", import.meta.url),
  ).text();
  const rawBlock = source
    .slice(source.indexOf("DO $inputs$"), source.indexOf("DO $readers$"))
    .replace(
      "CREATE FUNCTION opengeni_private.insights_raw_amount_inputs",
      "CREATE OR REPLACE FUNCTION opengeni_private.insights_raw_amount_inputs",
    );
  await admin.unsafe(rawBlock);
  await admin.unsafe(
    optimized!.scoped
      .replace(
        "coalesce((s.owner_organization_membership_id::text||':'||s.owner_subject_id)=ANY((SELECT public.session_private_actor_visible_keys())::text[]),false)",
        "public.session_private_actor_visible(\n                  s.account_id,s.workspace_id,s.owner_organization_membership_id,s.owner_subject_id)",
      )
      .replace(
        "opengeni_insights_internal.insights_usage_amount_inputs(a,w.id,p_since,p_until,p_granularity)",
        "opengeni_private.insights_raw_amount_inputs(a,w.id,p_since,p_until)",
      )
      .replace(
        "opengeni_insights_internal.insights_usage_amount_inputs(a,null,p_since,p_until,p_granularity)",
        "opengeni_private.insights_raw_amount_inputs(a,null,p_since,p_until)",
      ),
  );
  const seedStart = performance.now();
  if (!retained) {
    // Restore triggers at commit. This is a fresh isolated fixture, not an
    // operational bypass: historical facts deliberately predate maintenance.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role=replica`;
      await tx`insert into sessions select seeded.* from generate_series(0,6999) n cross join sessions template
      cross join lateral jsonb_populate_record(null::sessions,to_jsonb(template)||jsonb_build_object(
        'id',md5('hourly-lab-'||n)::uuid,'root_session_id',md5('hourly-lab-'||n)::uuid,
        'sandbox_group_id',md5('hourly-lab-'||n)::uuid,'title','Lab session '||n)) seeded
      where template.id=${template.id}`;
    });
    for (let day = 0; day < 80; day++) {
      await admin.begin(async (tx) => {
        await tx`set local session_replication_role=replica`;
        await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,
        input_tokens,cached_tokens,cache_write_tokens,output_tokens,reasoning_tokens,total_tokens,estimated_provider_cost_micros,
        list_uncached_input_cost_micros,list_cache_read_cost_micros,list_cache_write_cost_micros,list_output_cost_micros,list_cost_is_approx,
        occurred_at,recorded_at)
        select ${accountId},${workspaceId},md5('hourly-lab-'||(${day}*87+(n%87)))::uuid,gen_random_uuid(),'lab-'||${day}||'-'||n,
          case when n%87%3=0 then 'codex-subscription' else 'openai' end,'responses','model-'||(n%87%4),
          case when n%87%3=1 then 'opengeni_credits' else 'external' end,
          10000,7000,100,500,100,10500,4000,2000,700,300,1000,false,
          '2026-07-30T00:00:00Z'::timestamptz+${day}*interval '1 day'+(n%87%18)*interval '1 hour'+(n/87)*interval '37 seconds',
          '2026-07-30T00:00:00Z'::timestamptz+${day}*interval '1 day'+(n%87%18)*interval '1 hour'+(n/87)*interval '37 seconds'+interval '2 minutes'
        from generate_series(0,49999)n`;
      });
      if (day % 10 === 9)
        console.log(
          JSON.stringify({
            seededDays: day + 1,
            elapsedMs: Math.round(performance.now() - seedStart),
          }),
        );
    }
    await admin`analyze model_call_facts`;
    await admin`analyze sessions`;
  }
  results.seedMs = performance.now() - seedStart;
  const explain = async (phase: string) => {
    for (const range of ranges) {
      if (
        phase === "before" &&
        process.env.OPENGENI_INSIGHTS_LAB_BASELINE_RANGE &&
        range !== process.env.OPENGENI_INSIGHTS_LAB_BASELINE_RANGE
      )
        continue;
      const timings = [];
      for (const [index, q] of queries.get(range)!.entries()) {
        const timeoutMs = phase === "before" ? 300000 : 30000;
        try {
          const result = await app.begin(async (tx) => {
            await tx`select set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true),
            set_config('opengeni.subject_id',${subjectId},true),set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
            await tx`select set_config('statement_timeout',${String(timeoutMs)},true)`;
            await tx`set local work_mem='16MB'`;
            await tx`set local jit=off`;
            return await tx.unsafe(
              `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${q.query}`,
              q.params as never[],
            );
          });
          const plan = result[0]!["QUERY PLAN"][0];
          timings.push(plan["Execution Time"]);
          console.log(
            JSON.stringify({ phase, range, window: index === 0 ? "prior" : "current", plan }),
          );
        } catch (error) {
          if (phase !== "before" || (error as { code?: string }).code !== "57014") throw error;
          timings.push({ timeoutMs });
          console.log(
            JSON.stringify({ phase, range, window: index === 0 ? "prior" : "current", timeoutMs }),
          );
        }
      }
      results[`${phase}:${range}`] = timings;
      console.log(JSON.stringify({ phase, range, executionMs: timings }));
    }
  };
  if (!process.env.OPENGENI_INSIGHTS_LAB_SKIP_BEFORE) await explain("before");
  if (retained) {
    const definitions = await Bun.file(
      new URL("../packages/db/drizzle/0815_insights_usage_hourly.sql", import.meta.url),
    ).text();
    await admin.unsafe("CREATE SCHEMA IF NOT EXISTS opengeni_insights_internal");
    await admin.unsafe(
      definitions
        .slice(
          definitions.indexOf(
            "CREATE FUNCTION opengeni_insights_internal.insights_usage_hour_lock",
          ),
          definitions.indexOf("CREATE TRIGGER insights_usage_hourly_maintain"),
        )
        .replaceAll("CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION "),
    );
    await admin.unsafe(
      "CREATE OR REPLACE TRIGGER insights_usage_hourly_maintain AFTER INSERT OR UPDATE OR DELETE ON model_call_facts FOR EACH ROW EXECUTE FUNCTION opengeni_insights_internal.insights_usage_hourly_maintain()",
    );
  }
  const backfillStart = performance.now();
  for (const file of [
    "0816_insights_usage_hourly_queue.sql",
    "0817_insights_usage_hourly_backfill.sql",
  ])
    await executeMigrationFile(
      admin,
      file,
      await Bun.file(new URL(`../packages/db/drizzle/${file}`, import.meta.url)).text(),
    );
  results.backfillMs = performance.now() - backfillStart;
  // Apply the exact final reader migration, rather than a saved prototype.
  const [scoped] =
    await admin`select pg_get_functiondef('opengeni_private.insights_scoped_usage_rows(uuid,uuid,timestamptz,timestamptz,text,uuid[],boolean)'::regprocedure) body`;
  await admin.unsafe(
    scoped!.body.replace(
      "public.session_private_actor_visible(s.account_id,s.workspace_id,s.owner_organization_membership_id,s.owner_subject_id)",
      "public.session_private_actor_visible(\n                  s.account_id,s.workspace_id,s.owner_organization_membership_id,s.owner_subject_id)",
    ),
  );
  await executeMigrationFile(
    admin,
    "0818_insights_usage_hourly_reader.sql",
    await Bun.file(
      new URL("../packages/db/drizzle/0818_insights_usage_hourly_reader.sql", import.meta.url),
    ).text(),
  );
  await admin`analyze opengeni_private.insights_usage_hourly_rollups`;
  const [counts] = await admin`select (select count(*) from model_call_facts) facts,
    (select count(*) from sessions) sessions,(select count(*) from opengeni_private.insights_usage_hourly_rollups) rollups`;
  results.counts = counts;
  console.log(JSON.stringify({ backfillMs: results.backfillMs, counts }));
  await explain("after");
  // Also run the real reader with its unchanged 10-second per-statement limit,
  // not only EXPLAIN under the diagnostic timeout.
  for (const range of ranges) {
    const response = await withSessionRlsActorContext({ subjectId }, () =>
      readInsightsUsage(db, {
        accountId,
        workspaceId,
        now,
        detailsWorkspaceIds: [workspaceId],
        query: InsightsUsageQuery.parse({ range, seriesGroups: true }),
      }),
    );
    const expected = range === "today" ? 50000 : range === "30d" ? 1500000 : 4000000;
    if (response.totals.calls !== expected || response.totals.listMicros !== expected * 4000)
      throw new Error(`Hourly benchmark ${range} totals do not match seeded facts`);
    console.log(
      JSON.stringify({
        range,
        verifiedCalls: response.totals.calls,
        verifiedListMicros: response.totals.listMicros,
      }),
    );
  }
  // EXPLAIN reports trigger time independently of the raw INSERT/index work.
  let insertPlan: unknown;
  const rollbackSample = new Error("Rollback isolated insert sample");
  try {
    await admin.begin(async (tx) => {
      const plan =
        await tx`explain(analyze,buffers,format json) insert into model_call_facts(account_id,workspace_id,session_id,turn_id,
      source_key,provider,provider_api,model,billing_path,occurred_at)
      select ${accountId},${workspaceId},${template.id},gen_random_uuid(),'overhead-'||n,'openai','responses','overhead','external',
        '2026-10-17T12:00:00Z' from generate_series(1,10000)n`;
      insertPlan = plan[0]!["QUERY PLAN"][0];
      throw rollbackSample;
    });
  } catch (error) {
    if (error !== rollbackSample) throw error;
  }
  results.insertPlan = insertPlan;
  console.log(JSON.stringify({ summary: results }));
} finally {
  await app.end();
  await client.close();
  if (retained) await admin.end();
  await fixture.release();
}
