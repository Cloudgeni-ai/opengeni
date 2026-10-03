import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  installInsightsListRateSnapshot,
  resumeInsightsListRateSnapshot,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import {
  allocateRecordedModelListCostByClass,
  configuredModelListPricingSchedules,
  getSettings,
} from "@opengeni/config";

setDefaultTimeout(180_000);
const migrations = [
  "0606_insights_daily_rollups.sql",
  "0607_insights_actual_model_debits.sql",
  "0608_insights_historical_list_allocations.sql",
];
let shared: OwnerMigratedTestDatabase | null = null;
let client: DbClient;
let app: postgres.Sql;
let accountId: string;
let workspaceId: string;
let sessionId: string;
let historicalTurn: string;
let policyBaseline: Awaited<ReturnType<typeof policies>>;

async function policies() {
  return await shared!
    .admin`select polrelid::regclass::text as relation,polname,polcmd,polpermissive,
    pg_get_expr(polqual,polrelid) as using,pg_get_expr(polwithcheck,polrelid) as checking
    from pg_policy where polrelid in('sessions'::regclass,'usage_events'::regclass,
      'model_call_facts'::regclass,'credit_ledger_entries'::regclass) order by relation,polname`;
}

beforeAll(async () => {
  shared = await acquireOwnerMigratedTestDatabase("insights-rollup-maintenance-followup");
  if (!shared) throw new Error("Real PostgreSQL owner/app fixture is required");
  const owner = postgres(shared.ownerUrl, { max: 1 });
  try {
    await owner`create table schema_migrations(name text primary key,applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) select unnest(${migrations}::text[])`;
    await migrate(shared.ownerUrl, undefined, {
      preinstalledVector: true,
      applicationDatabaseRoles: ["opengeni_app"],
    });
  } finally {
    await owner.end();
  }
  await provisionRoles(shared.adminUrl, { appPassword: shared.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(shared.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = shared.appPassword;
  client = createDb(appUrl.toString(), { max: 8, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), {
    max: 12,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  const userId = `rollup-followup-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Rollup owner",
  });
  const grant = access.workspaceGrants[0]!;
  accountId = grant.accountId;
  workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Rollup fixture",
    resources: [],
    metadata: {},
    model: "fixture",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: `user:${userId}` },
    createdByContext: {},
  });
  sessionId = session.id;
  historicalTurn = crypto.randomUUID();
  await shared.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,
    model,billing_path,input_tokens,output_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,total_tokens,
    priced_cost_micros,estimated_provider_cost_micros,context_contributions,occurred_at,recorded_at)
    select ${accountId},${workspaceId},${sessionId},${historicalTurn},'historical-'||n,'openai','responses','historical',
      case when n%2=0 then 'external' else 'opengeni_credits' end,
      case when n=2 then null else 100 end,30,case when n=3 then null else 20 end,
      case when n=4 then null else 10 end,case when n=5 then null else 5 end,case when n=6 then null else 130 end,
      999,case when n=6 then null else 37 end,
      case when n=1 then null when n=2 then '[]'::jsonb else
        '[{"source":"company_profile","items":3,"utf8Bytes":24,"estimatedTokens":6}]'::jsonb end,
      '2026-09-02T03:00:00Z'::timestamptz+n*interval '1 microsecond',
      '2026-09-02T04:00:00Z'::timestamptz+n*interval '1 second' from generate_series(1,6)n`;
  await shared.admin`insert into usage_events(account_id,workspace_id,session_id,event_type,unit,quantity,idempotency_key,occurred_at)
    values(${accountId},${workspaceId},${sessionId},'model.cost','usd_micros',999,'historic-usage','2026-09-02T03:00:00Z'),
      (${accountId},${workspaceId},${sessionId},'sandbox.warm_seconds','seconds',5,'warm-a','2026-09-02T00:00:00Z')`;
  await shared.admin`insert into credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key,metadata,occurred_at)
    values(${accountId},${workspaceId},'model_usage_debit',-7,'model_response',${historicalTurn + ":historical-1"},'historic-debit',
      jsonb_build_object('sessionId',${sessionId}::text),'2026-09-02T03:00:00Z'),
      (${accountId},${workspaceId},'model_usage_debit',-11,'model_response',${crypto.randomUUID() + ":orphan"},'historic-orphan','{}','2026-09-02T03:00:00Z'),
      (${accountId},null,'model_usage_debit',-13,'model_response',null,'historic-account-orphan','{}','2026-09-02T03:00:00Z')`;
  policyBaseline = await policies();
  await shared.admin`delete from schema_migrations where name=any(${migrations}::text[])`;
  await migrate(shared.ownerUrl, undefined, {
    preinstalledVector: true,
    applicationDatabaseRoles: ["opengeni_app"],
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await app?.end();
  await shared?.release();
}, 180_000);

async function scope<T>(body: (tx: postgres.TransactionSql) => Promise<T>) {
  return (await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true)`;
    return await body(tx);
  })) as T;
}

async function assertExact() {
  const model = await shared!.admin`with raw as(
      select account_id,workspace_id,(occurred_at at time zone 'UTC')::date as day,
        opengeni_private.insights_rollup_dimensions('model_call_facts',to_jsonb(f)) as dimensions,
        opengeni_private.insights_fact_measures(to_jsonb(f)) as m,recorded_at,occurred_at
      from model_call_facts f where account_id=${accountId}), fields as(
      select account_id,workspace_id,day,dimensions,e.key,sum(e.value::bigint)::bigint as value
      from raw cross join lateral jsonb_each_text(m)e group by 1,2,3,4,5), groups as(
      select account_id,workspace_id,day,dimensions,jsonb_object_agg(key,value) as measures from fields group by 1,2,3,4),
      extremes as(select account_id,workspace_id,day,dimensions,min(recorded_at) as recorded_at_min,
        max(recorded_at) as recorded_at,min(occurred_at) as occurred_at_min,max(occurred_at) as occurred_at_max
        from raw group by 1,2,3,4)
    select coalesce(g.dimensions,d.dimensions) as dimensions from groups g join extremes x using(account_id,workspace_id,day,dimensions)
      full join opengeni_private.insights_model_daily d using(account_id,workspace_id,day,dimensions)
      where coalesce(g.account_id,d.account_id)=${accountId} and
        (g.measures is distinct from d.measures or x.recorded_at is distinct from d.recorded_at or
         x.recorded_at_min is distinct from d.recorded_at_min or x.occurred_at_min is distinct from d.occurred_at_min or
         x.occurred_at_max is distinct from d.occurred_at_max)`;
  expect([...model]).toEqual([]);
  const usage = await shared!
    .admin`with raw as(select account_id,workspace_id,(occurred_at at time zone 'UTC')::date as day,
      opengeni_private.insights_rollup_dimensions('usage_events',to_jsonb(u)) as dimensions,sum(quantity) as quantity,count(*) as event_count
      from usage_events u where account_id=${accountId} group by 1,2,3,4)
    select coalesce(r.dimensions,d.dimensions) as dimensions from raw r full join opengeni_private.insights_usage_daily d
      using(account_id,workspace_id,day,dimensions) where coalesce(r.account_id,d.account_id)=${accountId}
      and(r.quantity is distinct from d.quantity or r.event_count is distinct from d.event_count)`;
  expect([...usage]).toEqual([]);
  const charges = await shared!
    .admin`with raw as(select c.id as ledger_id,c.account_id,c.workspace_id,
      (c.occurred_at at time zone 'UTC')::date as day,-c.amount_micros as quantity,
      opengeni_private.insights_charge_dimensions(to_jsonb(c),to_jsonb(f)) as dimensions
      from credit_ledger_entries c left join model_call_facts f on f.account_id=c.account_id and f.workspace_id=c.workspace_id
        and c.source_id=f.turn_id::text||':'||f.source_key
      where c.account_id=${accountId} and c.type='model_usage_debit' and c.source_type='model_response' and c.amount_micros<0),
      groups as(select account_id,workspace_id,day,dimensions,sum(quantity) as quantity,count(*) as entries from raw group by 1,2,3,4)
    select coalesce(g.dimensions,d.dimensions) as dimensions from groups g full join opengeni_private.insights_charge_daily d
      on g.account_id=d.account_id and g.workspace_id is not distinct from d.workspace_id and g.day=d.day and g.dimensions=d.dimensions
      where coalesce(g.account_id,d.account_id)=${accountId} and(g.quantity is distinct from d.quantity or g.entries is distinct from d.entries)`;
  expect([...charges]).toEqual([]);
  const [links] = await shared!
    .admin`select (select count(*) from credit_ledger_entries where account_id=${accountId}
      and type='model_usage_debit' and source_type='model_response' and amount_micros<0)::int as raw,
    (select count(*) from opengeni_private.insights_charge_links where account_id=${accountId})::int as projected`;
  expect(links!.raw).toBe(links!.projected);
}

test("historical owner bootstrap is complete, policy-preserving and journal-idempotent", async () => {
  const [role] = await shared!
    .admin`select rolsuper,rolbypassrls from pg_roles where rolname=${shared!.ownerRole}`;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  expect(await policies()).toEqual(policyBaseline);
  const forced = await shared!.admin`select relforcerowsecurity from pg_class where oid in
    ('usage_events'::regclass,'model_call_facts'::regclass,'credit_ledger_entries'::regclass)`;
  expect(forced.every((row) => row.relforcerowsecurity)).toBe(true);
  await assertExact();
  const [row] = await shared!
    .admin`select measures,contributions from opengeni_private.insights_model_daily
    where workspace_id=${workspaceId} and dimensions->>'model'='historical' and dimensions->>'billing_path'='opengeni_credits'`;
  expect(row!.measures.uncached_input_tokens).toBe(140);
  expect(row!.measures.uncached_input_known_calls).toBe(2);
  expect(row!.contributions).toEqual([
    { source: "company_profile", items: 6, utf8Bytes: 48, estimatedTokens: 12, calls: 2 },
  ]);
  const [money] = await shared!
    .admin`select sum(quantity)::int as quantity from opengeni_private.insights_charge_daily where account_id=${accountId}`;
  expect(money!.quantity).toBe(31);
  await migrate(shared!.ownerUrl, undefined, {
    preinstalledVector: true,
    applicationDatabaseRoles: ["opengeni_app"],
  });
  await assertExact();
});

test("restricted old writers maintain concurrent facts/events, conflict retries and rollback", async () => {
  await Promise.all(
    Array.from({ length: 24 }, (_, n) =>
      scope(async (tx) => {
        await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,
      input_tokens,cached_tokens,cache_write_tokens,output_tokens,reasoning_tokens,total_tokens,occurred_at)
      values(${accountId},${workspaceId},${sessionId},${sessionId},${"parallel-" + n},'openai','responses','parallel','external',
        100,20,10,30,5,130,'2026-09-03T04:00:00Z') on conflict(workspace_id,turn_id,source_key) do nothing`;
        await tx`insert into usage_events(account_id,workspace_id,session_id,event_type,unit,quantity,idempotency_key,occurred_at)
      values(${accountId},${workspaceId},${sessionId},'model.tokens','tokens',130,${"parallel-" + n},'2026-09-03T04:00:00Z') on conflict do nothing`;
      }),
    ),
  );
  await Promise.all(
    Array.from({ length: 16 }, () =>
      scope(async (tx) => {
        await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,occurred_at)
      values(${accountId},${workspaceId},${sessionId},${sessionId},'same-key','openai','responses','parallel','external','2026-09-03T04:00:00Z')
      on conflict(workspace_id,turn_id,source_key) do nothing`;
      }),
    ),
  );
  await expect(
    scope(async (tx) => {
      await tx`insert into usage_events(account_id,workspace_id,session_id,event_type,unit,quantity,idempotency_key,occurred_at)
      values(${accountId},${workspaceId},${sessionId},'model.tokens','tokens',987,'rollback','2026-09-03T04:00:00Z')`;
      throw new Error("fixture rollback");
    }),
  ).rejects.toThrow("fixture rollback");
  await assertExact();
});

test("updates, group moves, contribution changes and min/max deletion are exact", async () => {
  await scope(async (tx) => {
    await tx`update model_call_facts set input_tokens=100,cached_tokens=20,cache_write_tokens=10,
      context_contributions='[]'::jsonb,recorded_at='2026-09-02T05:00:00Z',occurred_at='2026-09-02T23:00:00Z'
      where workspace_id=${workspaceId} and source_key='historical-6'`;
    await tx`update model_call_facts set model='moved',occurred_at='2026-09-04T00:00:00Z'
      where workspace_id=${workspaceId} and source_key='historical-3'`;
    await tx`update usage_events set quantity=9,occurred_at='2026-09-04T00:00:00Z'
      where workspace_id=${workspaceId} and idempotency_key='warm-a'`;
    await tx`delete from model_call_facts where workspace_id=${workspaceId} and source_key in('historical-1','historical-6')`;
    await tx`delete from usage_events where workspace_id=${workspaceId} and idempotency_key='parallel-0'`;
  });
  await assertExact();
  const [capabilities] = await shared!
    .admin`select count(*)::int as count from opengeni_private.insights_fact_read_runtime_capabilities`;
  expect(capabilities!.count).toBe(0);
});

test("ledger first, late fact enrichment, source moves and deletions conserve actual charges", async () => {
  const turn = crypto.randomUUID();
  let ledger: string;
  await scope(async (tx) => {
    const [row] =
      await tx`insert into credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key,occurred_at)
      values(${accountId},${workspaceId},'model_usage_debit',-17,'model_response',${turn + ":late"},'late-ledger','2026-09-05T04:00:00Z') returning id`;
    ledger = row!.id;
  });
  await assertExact();
  await scope(async (tx) => {
    await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,occurred_at)
      values(${accountId},${workspaceId},${sessionId},${turn},'late','openai','responses','late','opengeni_credits','2026-09-05T04:00:00Z')`;
  });
  await assertExact();
  const [link] = await shared!
    .admin`select dimensions from opengeni_private.insights_charge_links where ledger_id=${ledger!}`;
  expect(link!.dimensions.model).toBe("late");
  await scope(async (tx) => {
    await tx`update model_call_facts set provider='other',model='late-move',source_key='later'
      where workspace_id=${workspaceId} and turn_id=${turn}`;
    await tx`update credit_ledger_entries set source_id=${turn + ":later"},amount_micros=-19,occurred_at='2026-09-06T00:00:00Z' where id=${ledger!}`;
  });
  await assertExact();
  await scope(async (tx) => {
    await tx`delete from model_call_facts where workspace_id=${workspaceId} and turn_id=${turn}`;
    await tx`update credit_ledger_entries set type='model_usage_refund' where id=${ledger!}`;
  });
  await assertExact();
  await scope(async (tx) => {
    await tx`delete from credit_ledger_entries where id=${ledger!}`;
  });
  await assertExact();
});

test("racing independent ledger/fact inserts converge without fabricated attribution", async () => {
  await Promise.all(
    Array.from({ length: 16 }, (_, n) => {
      const turn = crypto.randomUUID();
      return Promise.all([
        scope(async (tx) => {
          await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,occurred_at)
        values(${accountId},${workspaceId},${sessionId},${turn},'race','openai','responses','race','opengeni_credits','2026-09-07T03:00:00Z')`;
        }),
        scope(async (tx) => {
          await tx`insert into credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key,occurred_at)
        values(${accountId},${workspaceId},'model_usage_debit',${-(n + 1)},'model_response',${turn + ":race"},${"race-ledger-" + n},'2026-09-07T03:00:00Z')`;
        }),
      ]);
    }),
  );
  await assertExact();
});

test("application invokers cannot mutate private tables or attach an owner trigger to lookalikes", async () => {
  for (const name of [
    "insights_usage_daily",
    "insights_model_daily",
    "insights_model_daily_timestamps",
    "insights_charge_daily",
    "insights_charge_links",
  ]) {
    await expect(
      (async () => {
        await app.unsafe(`select * from opengeni_private.${name}`);
      })(),
    ).rejects.toMatchObject({ code: "42501" });
    const [grants] = await shared!
      .admin`select has_table_privilege('opengeni_app',${"opengeni_private." + name},'INSERT,UPDATE,DELETE') as dml`;
    expect(grants!.dml).toBe(false);
  }
  await expect(
    scope(async (tx) => {
      await tx`select opengeni_private.insights_apply_delta('usage_events',jsonb_build_object('account_id',${accountId}::text,
      'workspace_id',${workspaceId}::text,'occurred_at','2026-09-08T00:00:00Z','quantity',1),1)`;
    }),
  ).rejects.toMatchObject({ code: "42501" });
  for (const [name, routine] of [
    ["usage_events", "maintain_insights_daily_rollup"],
    ["credit_ledger_entries", "maintain_insights_model_charges"],
  ]) {
    await expect(
      scope(async (tx) => {
        await tx.unsafe(
          `create temporary table ${name}(account_id uuid,workspace_id uuid,occurred_at timestamptz,quantity bigint)`,
        );
        await tx.unsafe(
          `create trigger fake_owner_trigger after insert on pg_temp.${name} for each row execute function opengeni_private.${routine}()`,
        );
        await tx.unsafe(`insert into pg_temp.${name} values($1,$2,'2026-09-08T00:00:00Z',999)`, [
          accountId,
          workspaceId,
        ]);
      }),
    ).rejects.toMatchObject({ code: "42501" });
  }
  await assertExact();
});

test("UTC full-day partition leaves at most two bounded raw edges, including zero windows", async () => {
  const edges = await shared!
    .admin`select since::text,until::text from opengeni_private.insights_rollup_edge_ranges(
    '2026-01-01T12:00:00Z','2026-10-03T15:00:00Z','day')`;
  expect(edges).toHaveLength(2);
  expect(edges[0]!.until.startsWith("2026-01-02 00:00:00")).toBe(true);
  expect(edges[1]!.since.startsWith("2026-10-03 00:00:00")).toBe(true);
  const short = await shared!
    .admin`select * from opengeni_private.insights_rollup_edge_ranges('2026-09-02T01:00:00Z','2026-09-03T02:00:00Z','day')`;
  expect(short).toHaveLength(1);
  const zero = await shared!
    .admin`select * from opengeni_private.insights_rollup_edge_ranges('2026-09-02T00:00:00Z','2026-09-02T00:00:00Z','hour')`;
  expect([...zero]).toEqual([]);
});

test("owner-only fast input matches the raw input at full days, microsecond edges and hourly boundaries", async () => {
  const owner = postgres(shared!.ownerUrl, { max: 1 });
  try {
    await owner.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true)`;
      await tx`insert into opengeni_private.insights_fact_read_runtime_capabilities
        (backend_pid,transaction_id,capability_kind,account_id,workspace_id) values
        (pg_backend_pid(),pg_current_xact_id(),'model_call_facts',${accountId},${workspaceId})`;
      for (const [lo, hi, granularity] of [
        ["2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z", "day"],
        ["2026-09-02T03:00:00.000002Z", "2026-09-07T03:00:00.000001Z", "day"],
        ["2026-09-02T02:00:00Z", "2026-09-02T04:00:00Z", "hour"],
        ["2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z", "hour"],
      ] as const) {
        const aggregate = async (fast: boolean, scopeWorkspace: string | null) =>
          await tx.unsafe(
            `
          select session_id,provider,model,payer,scheduled_task_id,charge_row,
            date_trunc($5,occurred_at at time zone 'UTC') at time zone 'UTC' as bucket,
            e.key,sum(e.value::bigint)::text as amount,max(recorded_at) as recorded_at
          from opengeni_private.${fast ? "insights_rollup_amount_inputs" : "insights_raw_amount_inputs"}($1,$2,$3,$4${fast ? ",$5" : ""})
          cross join lateral jsonb_each_text(m)e group by 1,2,3,4,5,6,7,8
          order by 1,2,3,4,5,6,7,8`,
            [accountId, scopeWorkspace, lo, hi, granularity],
          );
        expect(await aggregate(true, workspaceId)).toEqual(await aggregate(false, workspaceId));
        expect(await aggregate(true, null)).toEqual(await aggregate(false, null));
      }
      await tx`delete from opengeni_private.insights_fact_read_runtime_capabilities where backend_pid=pg_backend_pid()`;
    });
  } finally {
    await owner.end();
  }
  await expect(
    scope(async (tx) => {
      await tx`select * from opengeni_private.insights_rollup_amount_inputs(${accountId},${workspaceId},'2026-09-01Z','2026-09-10Z','day')`;
    }),
  ).rejects.toMatchObject({ code: "42501" });
});

test("captured class updates conserve the frozen list total and knownness remains per fact", async () => {
  await scope(async (tx) => {
    await tx`update model_call_facts set estimated_provider_cost_micros=37,list_uncached_input_cost_micros=20,
      list_cache_read_cost_micros=4,list_cache_write_cost_micros=3,list_output_cost_micros=10,list_cost_is_approx=true
      where workspace_id=${workspaceId} and source_key='historical-2'`;
  });
  await assertExact();
  const [row] = await shared!
    .admin`select measures from opengeni_private.insights_model_daily where workspace_id=${workspaceId}
    and dimensions->>'model'='historical' and dimensions->>'billing_path'='external'`;
  expect(row!.measures.list_class_known_calls).toBe(1);
  expect(row!.measures.list_approx_calls).toBe(1);
  expect(
    row!.measures.list_uncached_input_cost_micros +
      row!.measures.list_cache_read_cost_micros +
      row!.measures.list_cache_write_cost_micros +
      row!.measures.list_output_cost_micros,
  ).toBe(37);
  for (const value of [
    {
      input_tokens: 100,
      cached_tokens: 20,
      cache_write_tokens: 10,
      output_tokens: 30,
      reasoning_tokens: 5,
      expected: 70,
      complete: true,
    },
    {
      input_tokens: 100,
      cached_tokens: 20,
      cache_write_tokens: null,
      output_tokens: 30,
      reasoning_tokens: 5,
      expected: 0,
      complete: false,
    },
    {
      input_tokens: 25,
      cached_tokens: 20,
      cache_write_tokens: 10,
      output_tokens: 30,
      reasoning_tokens: 5,
      expected: 0,
      complete: false,
    },
    {
      input_tokens: 10,
      cached_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 30,
      reasoning_tokens: 31,
      expected: 10,
      complete: false,
    },
  ]) {
    const [m] = await shared!
      .admin`select opengeni_private.insights_fact_measures(${shared!.admin.json(value)}::jsonb) as measures`;
    expect(m!.measures.uncached_input_tokens).toBe(value.expected);
    expect(m!.measures.complete_class_known_calls).toBe(value.complete ? 1 : 0);
  }
});

test("current and frozen pre-rollup runtime/provisioner accept the complete inventory and scrub polluted grants", async () => {
  const revision = "2f09c54dc9049af17db2814a7efba3d89b5946b0";
  const repoRoot = new URL("../../..", import.meta.url).pathname;
  const root = await mkdtemp(`${repoRoot}/.insights-0603-frozen-`);
  const options = {
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
    targetSchema: "public",
    organizationTenancyCanonicalActivationEnabled: true,
  };
  const roles = { appPassword: shared!.appPassword, rlsStrategy: "force" as const };
  const verifyCurrent = async () =>
    expect(
      evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(client.db, options),
        options,
      ),
    ).toEqual([]);
  try {
    for (const name of ["runtime-posture.ts", "role-relationships.ts", "provision-roles.ts"])
      await writeFile(
        `${root}/${name}`,
        execFileSync("git", ["show", `${revision}:packages/db/src/${name}`], { cwd: repoRoot }),
      );
    const old = await import(pathToFileURL(`${root}/runtime-posture.ts`).href);
    const oldProvision = await import(pathToFileURL(`${root}/provision-roles.ts`).href);
    const verify = async () => {
      expect(
        old.evaluateRuntimeDatabasePosture(
          await old.inspectRuntimeDatabasePosture(client.db, options),
          options,
        ),
      ).toEqual([]);
      await verifyCurrent();
    };
    await verify();
    await oldProvision.provisionRoles(shared!.adminUrl, roles);
    await verify();
    await shared!
      .admin`grant update(measures) on opengeni_private.insights_model_daily to opengeni_app`;
    await shared!.admin`grant insert(quantity) on opengeni_private.insights_charge_daily to PUBLIC`;
    await shared!
      .admin`grant execute on function opengeni_private.insights_rollup_amount_inputs(uuid,uuid,timestamptz,timestamptz,text) to PUBLIC`;
    const violations = evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, options),
      options,
    );
    expect(violations).toContain(
      "Insights rollup private table insights_model_daily is missing or unsafe",
    );
    expect(violations).toContain(
      "Insights rollup private table insights_charge_daily is missing or unsafe",
    );
    for (let pass = 0; pass < 2; pass++) {
      await provisionRoles(shared!.adminUrl, roles);
      await verify();
    }
    await assertExact();
  } finally {
    await provisionRoles(shared!.adminUrl, roles);
    await rm(root, { recursive: true, force: true });
  }
});

const allocationSettings = () =>
  getSettings({
    OPENGENI_ENV: "test",
    OPENGENI_OPENAI_API_KEY: "fixture-secret-not-persisted",
    OPENGENI_MODEL_PRICING_JSON: JSON.stringify({
      "allocation/model": {
        inputMicrosPerMillionTokens: 1000000,
        cachedInputMicrosPerMillionTokens: 1000000,
        cacheWriteMicrosPerMillionTokens: 1000000,
        outputMicrosPerMillionTokens: 1000000,
        marginBps: 7500,
      },
      "allocation/missing": {
        inputMicrosPerMillionTokens: 1000000,
        cachedInputMicrosPerMillionTokens: 1000000,
        outputMicrosPerMillionTokens: 1000000,
      },
      "allocation/tier": {
        default: {
          inputMicrosPerMillionTokens: 7,
          cachedInputMicrosPerMillionTokens: 3,
          cacheWriteMicrosPerMillionTokens: 9,
          outputMicrosPerMillionTokens: 11,
        },
        inputTokenTiers: [
          {
            minimumInputTokens: 100,
            pricing: {
              inputMicrosPerMillionTokens: 17,
              cachedInputMicrosPerMillionTokens: 5,
              cacheWriteMicrosPerMillionTokens: 23,
              outputMicrosPerMillionTokens: 13,
            },
          },
        ],
      },
    }),
  });
let allocationSnapshot: string;

test("SQL fixed-total allocation exactly matches the approved BigInt helper including tiers and large weights", async () => {
  const settings = allocationSettings();
  const schedules = configuredModelListPricingSchedules(settings);
  for (let n = 0; n < 80; n++) {
    const model = n % 2 ? "allocation/model" : "allocation/tier";
    const reads = n % 13,
      writes = n % 7,
      uncached = n % 21,
      output = n % 17,
      input = reads + writes + uncached + (n % 3 === 0 ? 120 : 0);
    const recorded = n % 23;
    const expected = allocateRecordedModelListCostByClass(
      settings,
      model,
      {
        inputTokens: input,
        outputTokens: output,
        inputTokensDetails: { cached_tokens: reads, cache_write_tokens: writes },
      },
      recorded,
    );
    const [actual] = await shared!
      .admin`select opengeni_private.insights_allocate_recorded_list_classes(
      ${shared!.admin.json({
        input_tokens: input,
        cached_tokens: reads,
        cache_write_tokens: writes,
        output_tokens: output,
        estimated_provider_cost_micros: recorded,
      })}::jsonb,${shared!.admin.json(schedules[model]!)}::jsonb) as classes`;
    expect(actual!.classes).toEqual(expected.listByClassMicros);
  }
  const huge = {
    ...settings,
    modelPricingJson: JSON.stringify({
      "allocation/huge": {
        inputMicrosPerMillionTokens: 9007199254740991,
        cachedInputMicrosPerMillionTokens: 9007199254740990,
        cacheWriteMicrosPerMillionTokens: 1,
        outputMicrosPerMillionTokens: 9007199254740989,
      },
    }),
  };
  const usage = {
    inputTokens: 9007199254740991,
    outputTokens: 9007199254740990,
    inputTokensDetails: { cached_tokens: 1, cache_write_tokens: 1 },
  };
  const expected = allocateRecordedModelListCostByClass(
    huge,
    "allocation/huge",
    usage,
    9007199254740991,
  );
  const [actual] = await shared!
    .admin`select opengeni_private.insights_allocate_recorded_list_classes(
    ${shared!.admin.json({
      input_tokens: usage.inputTokens,
      cached_tokens: 1,
      cache_write_tokens: 1,
      output_tokens: usage.outputTokens,
      estimated_provider_cost_micros: 9007199254740991,
    })}::jsonb,
    ${shared!.admin.json(configuredModelListPricingSchedules(huge)["allocation/huge"]!)}::jsonb) as classes`;
  expect(actual!.classes).toEqual(expected.listByClassMicros);
  expect(
    Object.values(actual!.classes as Record<string, number>).reduce((sum, value) => sum + value, 0),
  ).toBe(9007199254740991);
});

test("owner snapshot batches resume historical eligible allocations without changing any recorded total or debit", async () => {
  const seeds = [
    {
      key: "eligible-1",
      model: "allocation/model",
      writes: 1,
      price: 5,
      source: "configured_list_price",
    },
    {
      key: "eligible-2",
      model: "allocation/tier",
      writes: 1,
      price: 37,
      source: "configured_list_price",
    },
    {
      key: "eligible-zero-write",
      model: "allocation/missing",
      writes: 0,
      price: 5,
      source: "configured_list_price",
    },
    {
      key: "unknown-write",
      model: "allocation/model",
      writes: null,
      price: 5,
      source: "configured_list_price",
    },
    {
      key: "unknown-rate",
      model: "allocation/missing",
      writes: 1,
      price: 5,
      source: "configured_list_price",
    },
    { key: "unknown-price", model: "allocation/model", writes: 1, price: null, source: null },
    { key: "gateway", model: "allocation/model", writes: 1, price: 5, source: "gateway_reported" },
  ];
  for (const seed of seeds)
    await shared!
      .admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,
    provider,provider_api,model,billing_path,input_tokens,cached_tokens,cache_write_tokens,output_tokens,reasoning_tokens,total_tokens,
    estimated_provider_cost_micros,pricing_source,occurred_at) values(${accountId},${workspaceId},${sessionId},${crypto.randomUUID()},
      ${"allocation:" + seed.key},'openai','responses',${seed.model},'external',3,1,${seed.writes},1,0,4,
      ${seed.price},${seed.source},'2026-09-08T01:00:00Z')`;
  const totals = async () =>
    await shared!
      .admin`select id,estimated_provider_cost_micros,priced_cost_micros,equivalent_credit_cost_micros
    from model_call_facts where account_id=${accountId} order by id`;
  const before = await totals();
  const [debitBefore] = await shared!
    .admin`select sum(amount_micros)::text as total from credit_ledger_entries where account_id=${accountId}`;
  const owner = createDb(shared!.ownerUrl, { rlsStrategy: "force" });
  try {
    const first = await installInsightsListRateSnapshot(owner.db, {
      settings: allocationSettings(),
      version: "approved-3258-test-v1",
      batchSize: 2,
      maxBatches: 1,
    });
    expect(first.completed).toBe(false);
    allocationSnapshot = first.snapshotId;
    const resumed = await resumeInsightsListRateSnapshot(owner.db, {
      snapshotId: allocationSnapshot,
      batchSize: 2,
      maxBatches: 100,
    });
    expect(resumed.completed).toBe(true);
    expect(first.allocatedCalls + resumed.allocatedCalls).toBe(3);
    const again = await installInsightsListRateSnapshot(owner.db, {
      settings: allocationSettings(),
      version: "approved-3258-test-v1",
    });
    expect(again.snapshotId).toBe(allocationSnapshot);
    expect(again.allocatedCalls).toBe(0);
  } finally {
    await owner.close();
  }
  expect(await totals()).toEqual(before);
  const [debitAfter] = await shared!
    .admin`select sum(amount_micros)::text as total from credit_ledger_entries where account_id=${accountId}`;
  expect(debitAfter).toEqual(debitBefore);
  for (const seed of seeds) {
    const [fact] = await shared!
      .admin`select list_uncached_input_cost_micros,list_cache_read_cost_micros,list_cache_write_cost_micros,
      list_output_cost_micros,list_cost_is_approx,list_allocation_snapshot_id from model_call_facts where workspace_id=${workspaceId}
      and source_key=${"allocation:" + seed.key}`;
    if (seed.key.startsWith("eligible")) {
      expect(fact!.list_cost_is_approx).toBe(true);
      expect(fact!.list_allocation_snapshot_id).toBe(allocationSnapshot);
      expect(
        Number(fact!.list_uncached_input_cost_micros) +
          Number(fact!.list_cache_read_cost_micros) +
          Number(fact!.list_cache_write_cost_micros) +
          Number(fact!.list_output_cost_micros),
      ).toBe(seed.price!);
    } else expect(fact!.list_uncached_input_cost_micros).toBeNull();
  }
  const [snapshot] = await shared!
    .admin`select profiles from opengeni_private.insights_list_rate_snapshots where id=${allocationSnapshot}`;
  expect(JSON.stringify(snapshot!.profiles)).not.toContain("fixture-secret-not-persisted");
  expect(JSON.stringify(snapshot!.profiles)).not.toContain("marginBps");
  const [force] = await shared!
    .admin`select relforcerowsecurity from pg_class where oid='model_call_facts'::regclass`;
  expect(force!.relforcerowsecurity).toBe(true);
  await assertExact();
});

test("active snapshots maintain late old-writer inserts/enrichment and conflicts, while exact captures stay frozen", async () => {
  const turn = crypto.randomUUID();
  await Promise.all(
    Array.from({ length: 16 }, () =>
      scope(async (tx) => {
        await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,
      input_tokens,cached_tokens,cache_write_tokens,output_tokens,total_tokens,estimated_provider_cost_micros,pricing_source,occurred_at)
      values(${accountId},${workspaceId},${sessionId},${turn},'allocation-live','openai','responses','allocation/model','external',
        3,1,1,1,4,5,'configured_list_price','2026-09-09T01:00:00Z') on conflict(workspace_id,turn_id,source_key) do nothing`;
      }),
    ),
  );
  const [live] = await shared!
    .admin`select list_uncached_input_cost_micros,list_cache_read_cost_micros,list_cache_write_cost_micros,
    list_output_cost_micros,list_allocation_snapshot_id from model_call_facts where workspace_id=${workspaceId} and source_key='allocation-live'`;
  expect(live).toEqual({
    list_uncached_input_cost_micros: "2",
    list_cache_read_cost_micros: "1",
    list_cache_write_cost_micros: "1",
    list_output_cost_micros: "1",
    list_allocation_snapshot_id: allocationSnapshot,
  });
  await scope(async (tx) => {
    await tx`update model_call_facts set cache_write_tokens=1 where workspace_id=${workspaceId} and source_key='allocation:unknown-write'`;
    await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,
      input_tokens,cached_tokens,cache_write_tokens,output_tokens,estimated_provider_cost_micros,list_uncached_input_cost_micros,
      list_cache_read_cost_micros,list_cache_write_cost_micros,list_output_cost_micros,list_cost_is_approx,occurred_at)
      values(${accountId},${workspaceId},${sessionId},${crypto.randomUUID()},'allocation-exact','openai','responses','allocation/model','external',
        3,1,1,1,5,1,1,1,2,false,'2026-09-09T01:00:00Z')`;
  });
  const [enriched] = await shared!
    .admin`select list_allocation_snapshot_id from model_call_facts where workspace_id=${workspaceId} and source_key='allocation:unknown-write'`;
  expect(enriched!.list_allocation_snapshot_id).toBe(allocationSnapshot);
  const owner = createDb(shared!.ownerUrl, { rlsStrategy: "force" });
  try {
    const settings = allocationSettings();
    const prices = JSON.parse(settings.modelPricingJson!) as Record<string, Record<string, number>>;
    prices["allocation/model"]!.outputMicrosPerMillionTokens = 9000000;
    const second = await installInsightsListRateSnapshot(owner.db, {
      settings: { ...settings, modelPricingJson: JSON.stringify(prices) },
      version: "approved-3258-test-v2",
      batchSize: 2,
      maxBatches: 100,
    });
    expect(second.completed).toBe(true);
    expect(second.snapshotId).not.toBe(allocationSnapshot);
  } finally {
    await owner.close();
  }
  const [exact] = await shared!
    .admin`select list_cost_is_approx,list_allocation_snapshot_id,list_output_cost_micros from model_call_facts
    where workspace_id=${workspaceId} and source_key='allocation-exact'`;
  expect(exact).toEqual({
    list_cost_is_approx: false,
    list_allocation_snapshot_id: null,
    list_output_cost_micros: "2",
  });
  const [frozen] = await shared!
    .admin`select list_allocation_snapshot_id from model_call_facts where workspace_id=${workspaceId} and source_key='allocation-live'`;
  expect(frozen!.list_allocation_snapshot_id).toBe(allocationSnapshot);
  await assertExact();
});

test("derived historical corrections use original weights and invalid telemetry removes class knownness", async () => {
  const classes = async () => {
    const [row] = await shared!
      .admin`select model,list_uncached_input_cost_micros,list_cache_read_cost_micros,
      list_cache_write_cost_micros,list_output_cost_micros,list_cost_is_approx,list_allocation_snapshot_id
      from model_call_facts where workspace_id=${workspaceId} and source_key='allocation-live'`;
    return row!;
  };
  await scope(async (tx) => {
    await tx`update model_call_facts set estimated_provider_cost_micros=9,input_tokens=5,output_tokens=2
      where workspace_id=${workspaceId} and source_key='allocation-live'`;
  });
  const changed = await classes();
  expect(changed.list_allocation_snapshot_id).toBe(allocationSnapshot);
  expect([
    changed.list_uncached_input_cost_micros,
    changed.list_cache_read_cost_micros,
    changed.list_cache_write_cost_micros,
    changed.list_output_cost_micros,
  ]).toEqual(["4", "1", "1", "3"]);
  await assertExact();
  await scope(async (tx) => {
    await tx`update model_call_facts set model='allocation/tier' where workspace_id=${workspaceId} and source_key='allocation-live'`;
  });
  const moved = await classes();
  const expected = allocateRecordedModelListCostByClass(
    allocationSettings(),
    "allocation/tier",
    {
      inputTokens: 5,
      outputTokens: 2,
      inputTokensDetails: { cached_tokens: 1, cache_write_tokens: 1 },
    },
    9,
  );
  expect(
    [
      moved.list_uncached_input_cost_micros,
      moved.list_cache_read_cost_micros,
      moved.list_cache_write_cost_micros,
      moved.list_output_cost_micros,
    ].map(Number),
  ).toEqual(Object.values(expected.listByClassMicros!));
  expect(moved.list_allocation_snapshot_id).toBe(allocationSnapshot);
  await assertExact();
  await scope(async (tx) => {
    await tx`update model_call_facts set cache_write_tokens=null where workspace_id=${workspaceId} and source_key='allocation-live'`;
  });
  const unknown = await classes();
  expect(unknown.list_uncached_input_cost_micros).toBeNull();
  expect(unknown.list_cost_is_approx).toBeNull();
  expect(unknown.list_allocation_snapshot_id).toBeNull();
  await assertExact();
});

test("native Anthropic default-zero history is not promoted to provider-supported coverage", async () => {
  for (const [key, reads, writes, input, output, eligible] of [
    ["absent-read", 0, 1, 3, 1, false],
    ["absent-write", 1, 0, 3, 1, false],
    ["absent-input", 1, 1, 2, 1, false],
    ["absent-output", 1, 1, 3, 0, false],
    ["positive-reported", 1, 1, 3, 1, true],
  ] as const) {
    await scope(async (tx) => {
      await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,
        model,billing_path,input_tokens,cached_tokens,cache_write_tokens,output_tokens,estimated_provider_cost_micros,
        pricing_source,occurred_at) values(${accountId},${workspaceId},${sessionId},${crypto.randomUUID()},${"anthropic:" + key},
        'anthropic','anthropic-messages','allocation/model','external',${input},${reads},${writes},${output},5,
        'configured_list_price','2026-09-09T02:00:00Z')`;
    });
    const [row] = await shared!.admin`select list_uncached_input_cost_micros,list_cost_is_approx
      from model_call_facts where workspace_id=${workspaceId} and source_key=${"anthropic:" + key}`;
    expect(row!.list_uncached_input_cost_micros !== null).toBe(eligible);
    if (eligible) expect(row!.list_cost_is_approx).toBe(true);
  }
  await assertExact();
});

test("allocation batch rollback preserves cursor, source FORCE posture and daily deltas", async () => {
  const [active] = await shared!
    .admin`select id from opengeni_private.insights_list_rate_snapshots where active`;
  const snapshotId = active!.id as string;
  await shared!
    .admin`update opengeni_private.insights_list_rate_snapshots set active=false where id=${snapshotId}`;
  await scope(async (tx) => {
    await tx`insert into model_call_facts(id,account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,
      model,billing_path,input_tokens,cached_tokens,cache_write_tokens,output_tokens,estimated_provider_cost_micros,
      pricing_source,occurred_at) values('ffffffff-ffff-4fff-bfff-fffffffffffe',${accountId},${workspaceId},${sessionId},
        ${crypto.randomUUID()},'allocation-rollback','openai','responses','allocation/model','external',3,1,1,1,5,
        'configured_list_price','2026-09-09T02:00:00Z')`;
  });
  await shared!
    .admin`update opengeni_private.insights_list_rate_snapshots set active=true,completed=false,
    last_fact_id='ffffffff-ffff-4fff-bfff-fffffffffffd' where id=${snapshotId}`;
  const progress = async () =>
    await shared!.admin`select last_fact_id,allocated_calls,unknown_calls,completed
    from opengeni_private.insights_list_rate_snapshots where id=${snapshotId}`;
  const before = await progress();
  const owner = createDb(shared!.ownerUrl, { rlsStrategy: "force" });
  try {
    await expect(
      owner.db.transaction(async (tx) => {
        await tx.execute(
          sql`select opengeni_private.insights_backfill_list_snapshot(${snapshotId},1)`,
        );
        throw new Error("abort allocation batch");
      }),
    ).rejects.toThrow("abort allocation batch");
    expect(await progress()).toEqual(before);
    const [fact] = await shared!.admin`select list_uncached_input_cost_micros from model_call_facts
      where id='ffffffff-ffff-4fff-bfff-fffffffffffe'`;
    expect(fact!.list_uncached_input_cost_micros).toBeNull();
    const [force] = await shared!
      .admin`select relforcerowsecurity from pg_class where oid='model_call_facts'::regclass`;
    expect(force!.relforcerowsecurity).toBe(true);
    await assertExact();
    expect(
      await resumeInsightsListRateSnapshot(owner.db, { snapshotId, batchSize: 1 }),
    ).toMatchObject({ allocatedCalls: 1, completed: true });
    const settings = allocationSettings();
    const prices = JSON.parse(settings.modelPricingJson!) as Record<string, Record<string, number>>;
    prices["allocation/model"]!.inputMicrosPerMillionTokens = 2;
    await expect(
      installInsightsListRateSnapshot(owner.db, {
        settings: { ...settings, modelPricingJson: JSON.stringify(prices) },
        version: "approved-3258-test-v1",
      }),
    ).rejects.toThrow();
    const [stillActive] = await shared!
      .admin`select id from opengeni_private.insights_list_rate_snapshots where active`;
    expect(stillActive!.id).toBe(snapshotId);
  } finally {
    await owner.close();
  }
  await assertExact();
});

test("allocation snapshots and backfills deny app/PUBLIC writes, enforce immutability and reject fake source triggers", async () => {
  await expect(
    (async () => await app`select * from opengeni_private.insights_list_rate_snapshots`)(),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    (async () =>
      await app`select opengeni_private.insights_backfill_list_snapshot(${allocationSnapshot},2)`)(),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    (async () =>
      await shared!
        .admin`update opengeni_private.insights_list_rate_snapshots set profiles='{}'::jsonb where id=${allocationSnapshot}`)(),
  ).rejects.toMatchObject({ code: "22023" });
  await expect(
    scope(async (tx) => {
      await tx`create temporary table model_call_facts(id uuid)`;
      await tx`create trigger fake_allocation before insert on pg_temp.model_call_facts for each row execute function opengeni_private.allocate_insights_model_list_classes()`;
      await tx`insert into pg_temp.model_call_facts values(gen_random_uuid())`;
    }),
  ).rejects.toMatchObject({ code: "42501" });
  await assertExact();
});
