/** Isolated loopback-only, synthetic staging-sized full HTTP/auth/Core/DB benchmark. */
import { createHash } from "node:crypto";
import { availableParallelism, cpus, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@opengeni/db/schema";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  createOrganizationApiKey,
  withSessionRlsActorContext,
  withWorkspaceSessionActivityRls,
  registerDbBinding,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "../../../packages/db/src/provision-roles";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../../../packages/db/src/lossless-json";
import { acquireOwnerMigratedTestDatabase, testSettings } from "@opengeni/testing";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { InsightsUsageResponse } from "@opengeni/contracts/insights-usage";
import { withAccessGrantSessionRlsContext } from "../src/access-grant-rls";
import { registerInsightsUsageRoutes } from "../src/routes/insights-usage";

const base = new URL(process.env.OPENGENI_TEST_PG_URL ?? "");
if (!["127.0.0.1", "localhost", "::1"].includes(base.hostname))
  throw new Error("Loopback test PostgreSQL required");
const out = process.env.INSIGHTS_BENCH_OUT ?? "/workspace/insights-raw-http-evidence.json";
const samples = Number(process.env.INSIGHTS_BENCH_SAMPLES ?? 20);
if (!Number.isSafeInteger(samples) || samples < 5 || samples > 100)
  throw new Error("samples5..100");
const facts = 838_000,
  warmEvents = 2_870_000,
  otherEvents = 1_300_000;
const fixturePath =
  process.env.INSIGHTS_BENCH_FIXTURE ?? "/workspace/insights-raw-http-fixture.json";
type Fixture = {
  database: string;
  ownerRole: string;
  accountId: string;
  workspaceId: string;
  workspaceIds: string[];
  subjectId: string;
  seeded: boolean;
};
let fixture: Fixture;
const exists = await Bun.file(fixturePath).exists();
let admin: postgres.Sql, client: ReturnType<typeof createDb>;
if (exists) {
  fixture = await Bun.file(fixturePath).json();
  if (
    !/^og_insights_http_scale_[a-f0-9]{12}$/.test(fixture.database) ||
    (!fixture.seeded && process.env.INSIGHTS_BENCH_RESUME !== "1")
  )
    throw new Error("Inspect incomplete/foreign fixture; no automatic mutation replay");
  const url = new URL(base);
  url.pathname = `/${fixture.database}`;
  admin = postgres(url.toString(), {
    max: 2,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  url.username = "opengeni_app";
  url.password = "local-test";
  client = createDb(url.toString(), { max: 4, rlsStrategy: "force" });
} else {
  const acquired = await acquireOwnerMigratedTestDatabase("insights_http_scale");
  if (!acquired) throw new Error("Native PG fixture unavailable");
  await migrate(acquired.ownerUrl, undefined, {
    applicationDatabaseRoles: ["opengeni_app"],
    preinstalledVector: true,
  });
  await provisionRoles(acquired.adminUrl, {
    appPassword: acquired.appPassword,
    rlsStrategy: "force",
  });
  const url = new URL(acquired.adminUrl);
  admin = postgres(url.toString(), {
    max: 2,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  url.username = "opengeni_app";
  url.password = acquired.appPassword;
  client = createDb(url.toString(), { max: 4, rlsStrategy: "force" });
  const userId = `insights-scale-${crypto.randomUUID()}`,
    subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Synthetic benchmark owner",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  await admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by)
    values(${accountId},1,${"0".repeat(64)},${"1".repeat(64)},'isolated-http-benchmark') on conflict do nothing`;
  const personalId = access.workspaceGrants[0]!.workspaceId!;
  const workspaceIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, id] of workspaceIds.entries()) {
    await admin`insert into workspaces(id,account_id,name) values(${id},${accountId},${`Synthetic shared ${index}`})`;
    await admin`insert into workspace_inference_controls(workspace_id,account_id) values(${id},${accountId})`;
    await admin`insert into workspace_memberships(account_id,workspace_id,subject_id,subject_label,role,permissions)
      values(${accountId},${id},${subjectId},'Synthetic benchmark owner','owner','[]'::jsonb)`;
  }
  const otherPersonal = crypto.randomUUID(),
    otherSubject = "user:insights-scale-private-owner",
    otherMember = crypto.randomUUID();
  await admin`insert into workspaces(id,account_id,name) values(${otherPersonal},${accountId},'Private Personal fixture')`;
  await admin`insert into workspace_inference_controls(workspace_id,account_id) values(${otherPersonal},${accountId})`;
  await admin`insert into organization_memberships(id,account_id,subject_id,role,status,personal_workspace_id)
    values(${otherMember},${accountId},${otherSubject},'member','active',${otherPersonal})`;
  for (const id of workspaceIds)
    await admin`insert into workspace_memberships(account_id,workspace_id,subject_id,subject_label,role,permissions)
      values(${accountId},${id},${otherSubject},'Private fixture owner','member','[]'::jsonb)`;
  const privateSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
  });
  if (!privateSettings.enabled)
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: privateSettings.version,
      operationId: crypto.randomUUID(),
    });
  fixture = {
    database: new URL(acquired.adminUrl).pathname.slice(1),
    ownerRole: acquired.ownerRole,
    accountId,
    workspaceId: workspaceIds[0]!,
    workspaceIds,
    subjectId,
    seeded: false,
  };
  await Bun.write(fixturePath, JSON.stringify(fixture, null, 2));
  const template = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(client.db, {
      accountId,
      workspaceId: workspaceIds[0]!,
      initialMessage: "Synthetic staging-sized benchmark",
      resources: [],
      metadata: {},
      model: "synthetic",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  const seedDb = drizzle(admin, { schema });
  registerDbBinding(seedDb, { rlsStrategy: "force" });
  const allWorkspaces = [...workspaceIds, personalId, otherPersonal];
  for (const [wi, workspaceId] of allWorkspaces.entries())
    await withWorkspaceSessionActivityRls(seedDb, workspaceId, async (tx) => {
      const capability = crypto.randomUUID();
      await tx.execute(sql`insert into session_visibility_write_capabilities(capability_id,backend_pid,transaction_id)
      values(${capability},pg_backend_pid(),pg_current_xact_id())`);
      await tx.execute(
        sql`select set_config('opengeni.session_visibility_write_capability',${capability},true)`,
      );
      await tx.execute(sql`insert into sessions select row.* from generate_series(0,4095) i cross join sessions template
      cross join lateral jsonb_populate_record(null::sessions,to_jsonb(template)||jsonb_build_object(
        'id',md5('insights-scale-session-'||i)::uuid,'account_id',${accountId}::uuid,'workspace_id',${workspaceId}::uuid,
        'root_session_id',md5('insights-scale-session-'||i)::uuid,'parent_session_id',null,'sandbox_group_id',md5('insights-scale-session-'||i)::uuid,
        'owner_subject_id',case when ${wi}=3 or (${wi}<>4 and i%2=0) then ${subjectId} else ${otherSubject} end,
        'owner_organization_membership_id',case when ${wi}=3 or (${wi}<>4 and i%2=0) then (select id from organization_memberships where account_id=${accountId} and subject_id=${subjectId}) else ${otherMember}::uuid end,
        'created_by_subject_id',case when ${wi}=3 or (${wi}<>4 and i%2=0) then ${subjectId} else ${otherSubject} end,
        'scope_subject_id',case when ${wi}=3 or (${wi}<>4 and i%2=0) then ${subjectId} else ${otherSubject} end,
        'visibility',case when ${wi}>=3 or i%5=0 then 'user_private' else 'workspace_shared' end,
        'create_requested_visibility',case when ${wi}>=3 or i%5=0 then 'user_private' else 'workspace_shared' end,
        'title','Synthetic session '||i,'title_source','user','status','idle','activity_revision',0,'activity_revision_pending_xid',null)) row
      where template.id=${template.id} and case when i%10=0 then 4 when i%10=1 then 3 when i%10=2 then 1 when i%10=3 then 2 else 0 end=${wi}`);
      await tx.execute(
        sql`delete from session_visibility_write_capabilities where capability_id=${capability}`,
      );
    });
  await acquired.admin.end();
}
if (!fixture.seeded) {
  const { accountId } = fixture;
  const owners =
    await admin`select distinct workspace_id,owner_subject_id from sessions where account_id=${accountId} and title like 'Synthetic session %'`;
  for (const owner of owners)
    await admin.begin(async (batch) => {
      await batch`select set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${owner.workspace_id},true),set_config('opengeni.subject_id',${owner.owner_subject_id},true)`;
      await batch`insert into session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,status,source,position,prompt,model,reasoning_effort,latency_mode,sandbox_backend,initiator_kind,initiator_subject_id,created_at,finished_at)
    select md5('insights-scale-turn-'||s.id)::uuid,s.account_id,s.workspace_id,s.id,gen_random_uuid(),'scale-'||s.id,'completed','user',1,
      'Synthetic turn','synthetic','medium','standard','none','subject',s.owner_subject_id,'2026-01-01','2026-10-03'
    from sessions s where s.account_id=${accountId} and s.workspace_id=${owner.workspace_id} and s.owner_subject_id=${owner.owner_subject_id} and s.title like 'Synthetic session %'
    on conflict do nothing`;
    });
  await admin`analyze sessions`;
  await admin`analyze session_turns`;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let start = 0; start < facts; start += 50_000) {
    const end = Math.min(facts - 1, start + 49_999);
    const [existing] =
      await admin`select count(*)::int n from model_call_facts where account_id=${accountId} and source_key in(select 'scale-call-'||i from generate_series(${start}::int,${end}::int)i)`;
    if (existing!.n === end - start + 1) continue;
    if (existing!.n !== 0) throw new Error("Partial fact batch; inspect before retry");
    await admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,
      input_tokens,output_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,total_tokens,priced_cost_micros,estimated_provider_cost_micros,pricing_source,occurred_at,recorded_at)
      select ${accountId},s.workspace_id,s.id,md5('insights-scale-turn-'||s.id)::uuid,'scale-call-'||i,
        case when i%3=1 then 'codex-subscription' when i%2=0 then 'openai' else 'anthropic' end,'responses','synthetic-model-'||(i%24),
        case when i%3=0 then 'opengeni_credits' else 'external' end,100+i%900,50+i%100,20,case when i%7=0 then null else 5 end,5,
        150+i%900+i%100,case when i%3=0 then 101 else 0 end,case when i%11=0 then null else 73 end,
        case when i%11=0 then null else 'configured_list_price' end,${today.toISOString()}::timestamptz-(i%276)*interval '1 day'+(i%3600)*interval '1 second',
        ${today.toISOString()}::timestamptz-(i%276)*interval '1 day'+(i%3600)*interval '1 second'
      from generate_series(${start}::int,${end}::int)i join sessions s on s.id=md5('insights-scale-session-'||(i%4096))::uuid`;
    console.log(JSON.stringify({ phase: "facts", rows: end + 1 }));
  }
  // Bound transactions: the real allowance trigger updates a hot workspace
  // counter. A single 276k-row transaction creates a long MVCC version chain.
  // Keep every trigger enabled and retain exactly the same independent debits.
  for (let start = 0; start < facts; start += 1000) {
    const end = Math.min(facts - 1, start + 999);
    await admin`insert into credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key,occurred_at)
      select f.account_id,f.workspace_id,'model_usage_debit',case when i%17=0 then -37 else -101 end,
        'model_response',f.turn_id::text||':'||f.source_key,'scale-debit-'||f.source_key,f.occurred_at
      from generate_series(${start}::int,${end}::int)i join sessions s on s.id=md5('insights-scale-session-'||(i%4096))::uuid
      join model_call_facts f on f.workspace_id=s.workspace_id and f.turn_id=md5('insights-scale-turn-'||s.id)::uuid and f.source_key='scale-call-'||i
      where f.account_id=${accountId} and i%3=0 and i%101<>0 on conflict do nothing`;
    if (end % 50_000 === 49_999 || end === facts - 1)
      console.log(JSON.stringify({ phase: "debits", callsCovered: end + 1 }));
  }
  for (const [kind, count] of [
    ["sandbox.warm_seconds", warmEvents],
    ["model.usage", otherEvents],
  ] as const)
    for (let start = 0; start < count; start += 100_000) {
      const end = Math.min(count - 1, start + 99_999);
      const [existing] =
        await admin`select count(*)::int n from usage_events where account_id=${accountId} and idempotency_key in(select ${`scale-${kind}-`}||i from generate_series(${start}::int,${end}::int)i)`;
      if (existing!.n === end - start + 1) continue;
      if (existing!.n !== 0) throw new Error("Partial event batch; inspect before retry");
      await admin`insert into usage_events(account_id,workspace_id,session_id,turn_id,event_type,quantity,unit,idempotency_key,occurred_at,recorded_at)
        select ${accountId},s.workspace_id,s.id,md5('insights-scale-turn-'||s.id)::uuid,case when ${kind}='model.usage' then case when i<${facts} then 'model.tokens' else 'model.cost' end else ${kind} end,
          case when ${kind}='model.usage' then case when i<${facts} then 100 else case when i%3=0 then 101 else 0 end end else 1 end,
          case when ${kind}='model.usage' then case when i<${facts} then 'tokens' else 'usd_micros' end else 'seconds' end,${`scale-${kind}-`}||i,
          ${today.toISOString()}::timestamptz-(i%276)*interval '1 day'+(i%3600)*interval '1 second',now()
        from generate_series(${start}::int,${end}::int)i join sessions s on s.id=md5('insights-scale-session-'||(i%4096))::uuid`;
      console.log(JSON.stringify({ phase: kind, rows: end + 1 }));
    }
  for (const table of [
    "model_call_facts",
    "usage_events",
    "credit_ledger_entries",
    "sessions",
    "session_turns",
    "organization_memberships",
    "workspace_memberships",
    "workspaces",
  ])
    await admin.unsafe(`analyze ${table}`);
  fixture.seeded = true;
  await Bun.write(fixturePath, JSON.stringify(fixture, null, 2));
}
const raw = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
await createOrganizationApiKey(client.db, {
  accountId: fixture.accountId,
  name: "Synthetic HTTP benchmark selected key",
  prefix: raw.slice(0, 14),
  keyHash: createHash("sha256").update(raw).digest("hex"),
  policy: {
    preset: "custom",
    permissions: ["billing:read", "workspace:admin", "workspace:read", "sessions:read"],
    workspaceScope: { kind: "selected", workspaceIds: fixture.workspaceIds },
  },
});
const [role] = await client.db.execute(
  sql`select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user`,
);
if (role.current_user !== "opengeni_app" || role.rolsuper || role.rolbypassrls)
  throw new Error("Restricted measured role required");
const app = new Hono();
const deps = {
  db: client.db,
  settings: testSettings({
    productAccessMode: "managed",
    delegationSecret: "synthetic-benchmark-only",
  }),
} as ApiRouteDeps;
app.use("/v1/workspaces/:workspaceId/*", async (c, next) => {
  const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId")!);
  await withAccessGrantSessionRlsContext(deps, grant, next);
});
registerInsightsUsageRoutes(app, deps);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeout: 60 });
const results: unknown[] = [];
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
try {
  for (const scope of ["workspace", "organization"] as const)
    for (const range of ["week", "30d"] as const) {
      const parent =
        scope === "workspace"
          ? `workspaces/${fixture.workspaceId}`
          : `organizations/${fixture.accountId}`;
      const timings: number[] = [];
      let first: unknown, last: ReturnType<typeof InsightsUsageResponse.parse> | undefined;
      for (let n = 0; n <= samples; n++) {
        const started = performance.now();
        const response = await fetch(
          `http://127.0.0.1:${server.port}/v1/${parent}/insights/usage?range=${range}`,
          { headers: { authorization: `Bearer ${raw}` } },
        );
        const text = await response.text(),
          ms = performance.now() - started;
        if (response.status !== 200) {
          results.push({
            scope,
            range,
            failed: true,
            status: response.status,
            ms,
            error: text.slice(0, 500),
          });
          break;
        }
        last = InsightsUsageResponse.parse(JSON.parse(text));
        const measurement = {
          ms,
          windowStart: last.windowStart,
          windowEnd: last.windowEnd,
          calls: last.totals.calls,
          chargedMicros: last.totals.chargedMicros,
        };
        if (n === 0) first = measurement;
        else timings.push(ms);
        console.log(JSON.stringify({ phase: "http", scope, range, sample: n, ...measurement }));
      }
      if (last)
        results.push({
          scope,
          range,
          firstRequest: first,
          coldLabel: "fresh HTTP/auth connection; seeded DB and OS caches are not flushed",
          warmSamples: timings.length,
          p50Ms: timings.length ? percentile(timings, 0.5) : null,
          p95Ms: timings.length ? percentile(timings, 0.95) : null,
          timingsMs: timings,
          windowStart: last.windowStart,
          windowEnd: last.windowEnd,
          priorWindowStart: last.priorWindowStart,
          priorWindowEnd: last.priorWindowEnd,
          elapsedHours: (Date.parse(last.windowEnd) - Date.parse(last.windowStart)) / 3_600_000,
          calls: last.totals.calls,
        });
    }
  const inventory =
    await admin`select (select count(*) from model_call_facts)::text facts,(select count(*) from usage_events)::text usage,
    (select count(*) from usage_events where event_type='sandbox.warm_seconds')::text warm,(select count(*) from credit_ledger_entries)::text ledger,
    (select count(*) from sessions)::text sessions,(select count(*) from workspaces)::text workspaces,(select count(*) from organization_memberships)::text members`;
  const database =
    await admin`select version(),current_setting('shared_buffers') shared_buffers,current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') parallel_workers`;
  const force =
    await admin`select relname,relforcerowsecurity from pg_class where oid in ('model_call_facts'::regclass,'credit_ledger_entries'::regclass,'usage_events'::regclass,'sessions'::regclass)`;
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" })
    .stdout.toString()
    .trim();
  const evidence = {
    head,
    synthetic: true,
    localOnly: true,
    actualHttp: true,
    auth: "canonical selected organization API key; production requireAccessGrant/access-context and actor wrappers",
    role,
    force,
    inventory,
    database,
    hardware: {
      cpuModel: cpus()[0]?.model,
      reportedLogicalCpus: cpus().length,
      availableParallelism: availableParallelism(),
      memoryBytes: totalmem(),
      cgroupCpuMax: await readFile("/sys/fs/cgroup/cpu.max", "utf8").catch(() => null),
      cgroupCpuQuotaV1: await readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").catch(
        () => null,
      ),
      cgroupCpuPeriodV1: await readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").catch(
        () => null,
      ),
      cgroupMemoryLimitV1: await readFile(
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
        "utf8",
      ).catch(() => null),
      processAffinity: Bun.spawnSync(["taskset", "-pc", String(process.pid)], { stdout: "pipe" })
        .stdout.toString()
        .trim(),
      note: "Not proven4vCPU equivalent; no synthetic admin read actor, fixture administrator only seeds",
    },
    results,
  };
  await Bun.write(out, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidence: out, fixture: fixturePath, results }));
} finally {
  server.stop(true);
  await client.close();
  await admin.end();
}
