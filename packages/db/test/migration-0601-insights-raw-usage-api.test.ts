import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  InsightsUsageQuery,
  InsightsUsageResponse,
  InsightsCallsQuery,
  InsightsCallsResponse,
} from "@opengeni/contracts/insights-usage";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  readInsightsUsage,
  readInsightsCalls,
  insightsUsageWindow,
  recordModelCallFact,
  withSessionRlsActorContext,
  inspectRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

setDefaultTimeout(180_000);
let fixture: OwnerMigratedTestDatabase;
let client: DbClient;
let app: postgres.Sql;
let accountId: string,
  workspaceId: string,
  personalId: string,
  sessionId: string,
  privateId: string,
  deletedId: string,
  subjectId: string;
const migrationName = "0601_insights_raw_usage_api.sql";
const now = new Date("2026-09-14T12:00:00Z");
const actor = <T>(fn: () => Promise<T>, id = subjectId) =>
  withSessionRlsActorContext({ subjectId: id }, fn);
const usage = (query: unknown, details = true, organization = false) =>
  actor(() =>
    readInsightsUsage(client.db, {
      accountId,
      workspaceId: organization ? null : workspaceId,
      now,
      query: InsightsUsageQuery.parse(query),
      detailsWorkspaceIds: details ? [workspaceId] : [],
    }),
  );

async function policies() {
  return await fixture.admin`select polrelid::regclass::text as relation,polname,polcmd,polpermissive,
    pg_get_expr(polqual,polrelid) as using,pg_get_expr(polwithcheck,polrelid) as checking from pg_policy
    where polrelid in('sessions'::regclass,'model_call_facts'::regclass,'usage_events'::regclass,'credit_ledger_entries'::regclass) order by 1,2`;
}

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("raw-insights-owner");
  if (!acquired) throw new Error("Real owner/app PostgreSQL is required");
  fixture = acquired;
  const owner = postgres(fixture.ownerUrl, { max: 1 });
  try {
    await owner`create table schema_migrations(name text primary key,applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values(${migrationName})`;
    await migrate(fixture.ownerUrl, undefined, {
      applicationDatabaseRoles: ["opengeni_app"],
      preinstalledVector: true,
    });
  } finally {
    await owner.end();
  }
  await provisionRoles(fixture.adminUrl, {
    appPassword: fixture.appPassword,
    rlsStrategy: "force",
  });
  const url = new URL(fixture.ownerUrl);
  url.username = "opengeni_app";
  url.password = fixture.appPassword;
  client = createDb(url.toString(), { max: 4, rlsStrategy: "force" });
  app = postgres(url.toString(), {
    max: 2,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  const userId = `raw-insights-${crypto.randomUUID()}`;
  subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Raw owner",
  });
  accountId = access.workspaceGrants[0]!.accountId;
  personalId = access.workspaceGrants[0]!.workspaceId!;
  workspaceId = crypto.randomUUID();
  await fixture.admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Shared fixture')`;
  await fixture.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspaceId},${accountId})`;
  await fixture.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,subject_label,role,permissions)
    values(${accountId},${workspaceId},${subjectId},'Raw owner','owner','["workspace:admin"]'::jsonb)`;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Visible fixture",
    resources: [],
    metadata: {},
    model: "fixture",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    createdByContext: {},
  });
  sessionId = session.id;
  await fixture.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,
    input_tokens,output_tokens,cached_tokens,cache_write_tokens,total_tokens,priced_cost_micros,estimated_provider_cost_micros,pricing_source,occurred_at,recorded_at)
    select ${accountId},${workspaceId},${sessionId},gen_random_uuid(),'history-'||n,'openai','responses','model/with/slash',
      case when n=2 then 'external' else 'opengeni_credits' end,10,5,case when n=3 then null else 2 end,
      case when n=4 then null else 0 end,case when n=5 then null else 15 end,999,
      case when n=6 then null else 20 end,case when n=6 then null else 'configured_list_price' end,
      '2026-09-02T03:00:00Z','2026-09-02T04:00:00Z'::timestamptz+n*interval '1 second' from generate_series(1,6)n`;
  await fixture.admin`insert into credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key,occurred_at)
    select account_id,workspace_id,'model_usage_debit',-11,'model_response',turn_id::text||':'||source_key,'debit-'||source_key,occurred_at
    from model_call_facts where workspace_id=${workspaceId} and source_key='history-1'`;
  await fixture.admin`insert into credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key,occurred_at)
    values(${accountId},${workspaceId},'model_usage_debit',-13,'model_response','orphan','orphan','2026-09-03T00:00:00Z'),
      (${accountId},null,'model_usage_debit',-7,'model_response',null,'account-orphan','2026-09-03T00:00:00Z'),
      (${accountId},${workspaceId},'model_usage_debit',-17,'model_response','prior-orphan','prior-orphan','2026-08-25T00:00:00Z')`;
  const before = await policies();
  await fixture.admin`delete from schema_migrations where name=${migrationName}`;
  await migrate(fixture.ownerUrl, undefined, {
    applicationDatabaseRoles: ["opengeni_app"],
    preinstalledVector: true,
  });
  await provisionRoles(fixture.adminUrl, {
    appPassword: fixture.appPassword,
    rlsStrategy: "force",
  });
  expect(await policies()).toEqual(before);
});
afterAll(async () => {
  await client?.close();
  await app?.end();
  await fixture?.release();
});

test("rolling owner migration leaves FORCE, policies, old facts, and billing amounts unchanged", async () => {
  const [owner] =
    await fixture.admin`select rolsuper,rolbypassrls from pg_roles where rolname=${fixture.ownerRole}`;
  expect(owner).toEqual({ rolsuper: false, rolbypassrls: false });
  const rows =
    await fixture.admin`select relforcerowsecurity from pg_class where oid in('model_call_facts'::regclass,'credit_ledger_entries'::regclass,'usage_events'::regclass)`;
  expect(rows.every((r) => r.relforcerowsecurity)).toBe(true);
  await migrate(fixture.ownerUrl, undefined, {
    applicationDatabaseRoles: ["opengeni_app"],
    preinstalledVector: true,
  });
  const response = await usage({ range: "month", groupBy: "model", seriesGroups: true });
  expect(response.totals).toMatchObject({
    calls: 6,
    chargedMicros: 24,
    listMicros: 100,
    pricedCalls: 5,
    cacheWriteKnownCalls: 5,
    listClassKnownCalls: 0,
    listByClassMicros: null,
    tokens: { uncachedInput: 32, cacheRead: 10, cacheWrite: 0, output: 30, reasoning: 0 },
  });
  expect(response.groups.find((g) => g.kind === "service")?.measures).toMatchObject({
    calls: 0,
    chargedMicros: 13,
  });
  const org = await usage({ range: "month", groupBy: "workspace" }, true, true);
  expect(org.totals.chargedMicros).toBe(31);
});

test("frozen pre-0601 runtime and provisioner accept the complete migrated inventory", async () => {
  const revision = "00000d75ec520007a318637c22d74f23fdc4deb1";
  const repoRoot = new URL("../../..", import.meta.url).pathname;
  const root = await mkdtemp(`${repoRoot}/.insights-0601-old-runtime-`);
  const directory = `${root}/${revision}`;
  const options = {
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
    targetSchema: "public",
    organizationTenancyCanonicalActivationEnabled: true,
  };
  const roles = { appPassword: fixture.appPassword, rlsStrategy: "force" as const };
  try {
    await mkdir(directory);
    for (const name of ["runtime-posture.ts", "role-relationships.ts", "provision-roles.ts"])
      await writeFile(
        `${directory}/${name}`,
        execFileSync("git", ["show", `${revision}:packages/db/src/${name}`], { cwd: repoRoot }),
      );
    const old = await import(pathToFileURL(`${directory}/runtime-posture.ts`).href);
    const oldProvision = await import(pathToFileURL(`${directory}/provision-roles.ts`).href);
    const verify = async () => {
      expect(
        old.evaluateRuntimeDatabasePosture(
          await old.inspectRuntimeDatabasePosture(client.db, options),
          options,
        ),
      ).toEqual([]);
      expect(
        evaluateRuntimeDatabasePosture(
          await inspectRuntimeDatabasePosture(client.db, options),
          options,
        ),
      ).toEqual([]);
    };
    await verify();
    await oldProvision.provisionRoles(fixture.adminUrl, roles);
    await verify();
    await provisionRoles(fixture.adminUrl, roles);
    await verify();
  } finally {
    await provisionRoles(fixture.adminUrl, roles);
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test("six ranges/every grouping conserve calls and money in groups/series and expose honest NULL knownness", async () => {
  for (const range of ["today", "week", "month", "30d", "90d", "ytd"] as const)
    for (const groupBy of [
      "model",
      "provider",
      "payer",
      "workspace",
      "project",
      "rootSession",
      "person",
      "schedule",
    ] as const) {
      const org = groupBy === "workspace";
      const response = await usage({ range, groupBy, seriesGroups: true, limit: 2 }, true, org);
      expect(InsightsUsageResponse.safeParse(response).success).toBe(true);
      const bounds = insightsUsageWindow(range, now);
      const [raw] =
        await fixture.admin`select count(*)::int as calls from model_call_facts where account_id=${accountId}
      and (${org} or workspace_id=${workspaceId}) and occurred_at>=${bounds.since} and occurred_at<${bounds.until}`;
      expect(response.totals.calls).toBe(raw!.calls);
      expect(response.groups.reduce((n, g) => n + g.measures.chargedMicros, 0)).toBe(
        response.totals.chargedMicros,
      );
      expect(response.series.reduce((n, g) => n + g.measures.chargedMicros, 0)).toBe(
        response.totals.chargedMicros,
      );
      expect(response.groups.reduce((n, g) => n + g.measures.calls, 0)).toBe(response.totals.calls);
      expect(response.series.reduce((n, g) => n + g.measures.calls, 0)).toBe(response.totals.calls);
    }
});

test("money-only prior is retained and validates without fabricated calls", async () => {
  const response = await usage({ range: "month" });
  expect(response.prior).toMatchObject({ calls: 0, chargedMicros: 17 });
  expect(InsightsUsageResponse.safeParse(response).success).toBe(true);
});

test("forward classes conserve frozen total and visible cursor pagination preserves PostgreSQL microseconds", async () => {
  await actor(() =>
    recordModelCallFact(client.db, {
      accountId,
      workspaceId,
      sessionId,
      turnId: sessionId,
      sourceKey: "capture",
      provider: "cursor-provider",
      providerApi: "responses",
      model: "model/with/slashes",
      billingPath: "external",
      pricedCostMicros: 0,
      estimatedProviderCostMicros: 20,
      pricingSource: "configured_list_price",
      listByClassMicros: { uncachedInput: 10, cacheRead: 2, cacheWrite: 0, output: 8 },
      listByClassApprox: false,
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 2,
      cacheWriteTokens: 0,
      totalTokens: 15,
      occurredAt: new Date("2026-09-06T00:00:00Z"),
    }),
  );
  await fixture.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,occurred_at)
    select ${accountId},${workspaceId},${sessionId},${sessionId},'micro-'||n,'cursor-provider','responses','model/with/slashes','external',
      '2026-09-06T00:00:00Z'::timestamptz+n*interval '1 microsecond' from generate_series(1,3)n`;
  const response = await usage({ range: "month", model: "cursor-provider/model/with/slashes" });
  expect(InsightsUsageResponse.safeParse(response).success).toBe(true);
  expect(response.totals).toMatchObject({
    calls: 4,
    listMicros: 20,
    listClassKnownCalls: 1,
    cacheWriteKnownCalls: 1,
    listByClassMicros: { uncachedInput: 10, cacheRead: 2, cacheWrite: 0, output: 8 },
    listByClassApprox: false,
  });
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await actor(() =>
      readInsightsCalls(client.db, {
        accountId,
        workspaceId,
        now,
        detailsWorkspaceIds: [workspaceId],
        query: InsightsCallsQuery.parse({
          range: "month",
          model: "cursor-provider/model/with/slashes",
          limit: 1,
          ...(cursor ? { cursor } : {}),
        }),
      }),
    );
    expect(InsightsCallsResponse.safeParse(page).success).toBe(true);
    ids.push(...page.calls.map((c) => c.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids.length).toBe(4);
  expect(new Set(ids).size).toBe(4);
});

test("same actor billing-only ceiling masks metadata before filters and omits detail calls", async () => {
  const restricted = await usage({ range: "month", groupBy: "model" }, false);
  expect(restricted.totals.calls).toBe(10);
  expect(restricted.facets.models).toEqual([]);
  expect(JSON.stringify(restricted)).not.toContain("model/with/slashes");
  expect((await usage({ range: "month", provider: "openai" }, false)).totals.calls).toBe(0);
  const calls = await actor(() =>
    readInsightsCalls(client.db, {
      accountId,
      workspaceId,
      now,
      detailsWorkspaceIds: [],
      query: InsightsCallsQuery.parse({ range: "month" }),
    }),
  );
  expect(calls.calls).toEqual([]);
});

test("private and deleted are distinct, hidden identities/filter facets/call details never escape", async () => {
  await fixture.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by)
    values(${accountId},1,${"0".repeat(64)},${"1".repeat(64)},'raw-insights-test') on conflict do nothing`;
  const settings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
    enabled: true,
    expectedVersion: settings.version,
    operationId: crypto.randomUUID(),
  });
  const privateSession = await actor(() =>
    createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "SECRET PRIVATE TITLE",
      resources: [],
      metadata: {},
      model: "fixture",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  privateId = privateSession.id;
  deletedId = crypto.randomUUID();
  await transitionSessionVisibility(client.db, {
    workspaceId,
    sessionId: privateId,
    actorSubjectId: subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  await fixture.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,occurred_at)
    values(${accountId},${workspaceId},${privateId},gen_random_uuid(),'private','secret-provider','responses','secret-model','external','2026-09-07T00:00:00Z'),
      (${accountId},${workspaceId},${deletedId},gen_random_uuid(),'deleted','deleted-provider','responses','deleted-model','external','2026-09-07T00:00:00Z')`;
  const outsider = `user:${crypto.randomUUID()}`;
  const response = await actor(
    () =>
      readInsightsUsage(client.db, {
        accountId,
        workspaceId,
        now,
        detailsWorkspaceIds: [workspaceId],
        query: InsightsUsageQuery.parse({ range: "month", groupBy: "project" }),
      }),
    outsider,
  );
  expect(response.groups.some((g) => g.kind === "private")).toBe(true);
  expect(response.groups.some((g) => g.kind === "deleted")).toBe(true);
  for (const hidden of [
    privateId,
    deletedId,
    "SECRET PRIVATE TITLE",
    "secret-provider",
    "secret-model",
    "deleted-provider",
    "deleted-model",
  ])
    expect(JSON.stringify(response)).not.toContain(hidden);
  const guess = await actor(
    () =>
      readInsightsUsage(client.db, {
        accountId,
        workspaceId,
        now,
        detailsWorkspaceIds: [workspaceId],
        query: InsightsUsageQuery.parse({ range: "month", rootSessionId: privateId }),
      }),
    outsider,
  );
  expect(guess.totals.calls).toBe(0);
  const calls = await actor(
    () =>
      readInsightsCalls(client.db, {
        accountId,
        workspaceId,
        now,
        detailsWorkspaceIds: [workspaceId],
        query: InsightsCallsQuery.parse({ range: "month" }),
      }),
    outsider,
  );
  expect(
    calls.calls.every(
      (c) => c.sessionKind === "visible" && c.sessionId !== privateId && c.sessionId !== deletedId,
    ),
  ).toBe(true);
});

test("unattested helper, scope mismatches, PUBLIC execution and residual capability rows are denied", async () => {
  await expect(
    (async () =>
      await app`select * from opengeni_private.insights_raw_amount_inputs(${accountId},${workspaceId},'2026-09-01Z','2026-09-14Z')`)(),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    (async () =>
      await app`select * from opengeni_private.insights_scoped_usage_rows(${accountId},${workspaceId},'2026-09-01Z','2026-09-14Z','day',array[${workspaceId}]::uuid[],false)`)(),
  ).rejects.toMatchObject({ code: "42501" });
  const routines =
    await fixture.admin`select p.proname,bool_or(acl.grantee=0 and acl.privilege_type='EXECUTE') as public_execute from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    where n.nspname='opengeni_private' and p.proname in('insights_scoped_usage_rows','insights_scoped_calls_rows','insights_raw_amount_inputs') group by 1`;
  expect(routines.every((r) => !r.public_execute)).toBe(true);
  const [remaining] =
    await fixture.admin`select count(*)::int as n from opengeni_private.insights_fact_read_runtime_capabilities`;
  expect(remaining!.n).toBe(0);
  const options = {
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
    organizationTenancyCanonicalActivationEnabled: true,
  };
  expect(
    evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, options),
      options,
    ),
  ).toEqual([]);
});

test("organization Shared-all never admits Personal IDs/names/details, and Personal person amounts remain separate", async () => {
  const hiddenWorkspaces: string[] = [],
    hiddenSessions: string[] = [],
    hiddenSubjects: string[] = [];
  for (let n = 0; n < 2; n++) {
    const workspace = crypto.randomUUID(),
      membership = crypto.randomUUID(),
      subject = `user:personal-${crypto.randomUUID()}`;
    hiddenWorkspaces.push(workspace);
    hiddenSubjects.push(subject);
    await fixture.admin`insert into workspaces(id,account_id,name) values(${workspace},${accountId},${"SECRET PERSONAL " + n})`;
    await fixture.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspace},${accountId})`;
    await fixture.admin`insert into organization_memberships(id,account_id,subject_id,status,personal_workspace_id) values(${membership},${accountId},${subject},'active',${workspace})`;
    const created = await actor(
      () =>
        createSession(client.db, {
          accountId,
          workspaceId: workspace,
          initialMessage: "SECRET PERSONAL TITLE " + n,
          resources: [],
          metadata: {},
          model: "fixture",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: subject },
          createdByContext: {},
        }),
      subject,
    );
    const session = created.id;
    hiddenSessions.push(session);
    await fixture.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,provider,provider_api,model,billing_path,
      estimated_provider_cost_micros,pricing_source,occurred_at) values(${accountId},${workspace},${session},gen_random_uuid(),'personal',
      'secret-personal-provider','responses','secret-personal-model','external',${21 + n},'configured_list_price','2026-09-08T00:00:00Z')`;
  }
  const query = InsightsUsageQuery.parse({ range: "month", groupBy: "person" });
  const response = await actor(() =>
    readInsightsUsage(client.db, {
      accountId,
      workspaceId: null,
      now,
      detailsSharedWorkspaces: true,
      query,
    }),
  );
  const personal = response.groups.filter((g) => g.kind === "personal");
  expect(personal).toHaveLength(2);
  expect(personal.map((g) => g.measures.listMicros).sort()).toEqual([21, 22]);
  expect(new Set(personal.map((g) => g.key)).size).toBe(2);
  for (const secret of [
    ...hiddenWorkspaces,
    ...hiddenSessions,
    ...hiddenSubjects,
    "SECRET PERSONAL",
    "secret-personal-provider",
    "secret-personal-model",
  ])
    expect(JSON.stringify(response)).not.toContain(secret);
  const filtered = await actor(() =>
    readInsightsUsage(client.db, {
      accountId,
      workspaceId: null,
      now,
      detailsSharedWorkspaces: true,
      query: InsightsUsageQuery.parse({
        range: "month",
        person: personal[0]!.key.replace(/^personal:/, ""),
      }),
    }),
  );
  expect(filtered.totals.calls).toBe(0);
  const calls = await actor(() =>
    readInsightsCalls(client.db, {
      accountId,
      workspaceId: null,
      now,
      detailsSharedWorkspaces: true,
      query: InsightsCallsQuery.parse({ range: "month" }),
    }),
  );
  expect(calls.calls.every((c) => !hiddenWorkspaces.includes(c.workspaceId))).toBe(true);
  const own = await actor(() =>
    readInsightsUsage(client.db, {
      accountId,
      workspaceId: personalId,
      now,
      detailsWorkspaceIds: [personalId],
      query: InsightsUsageQuery.parse({ range: "month" }),
    }),
  );
  expect(own.scope.workspaceId).toBe(personalId);
});

test("UTC exact midnight has no fabricated future usage point", async () => {
  const response = await actor(() =>
    readInsightsUsage(client.db, {
      accountId,
      workspaceId,
      detailsWorkspaceIds: [workspaceId],
      now: new Date("2026-10-03T00:00:00Z"),
      query: InsightsUsageQuery.parse({ range: "today" }),
    }),
  );
  expect(response.windowStart).toBe(response.windowEnd);
  expect(response.series).toEqual([]);
  expect(response.prior).toBeNull();
  expect(InsightsUsageResponse.safeParse(response).success).toBe(true);
});

test("uncached input subtracts both cache classes per complete fact, never unequal-coverage aggregate sums", async () => {
  const cases = [
    { name: "complete", input: 100, cached: 20, writes: 10, reasoning: 5, uncached: 70 },
    { name: "unknown-read", input: 100, cached: null, writes: 10, reasoning: 5, uncached: null },
    { name: "unknown-write", input: 100, cached: 20, writes: null, reasoning: 5, uncached: null },
    { name: "unknown-input", input: null, cached: 20, writes: 10, reasoning: 5, uncached: null },
    { name: "overlap", input: 25, cached: 20, writes: 10, reasoning: 5, uncached: null },
    { name: "known-zero-cache", input: 10, cached: 0, writes: 0, reasoning: 0, uncached: 10 },
  ];
  for (const value of cases) {
    await fixture.admin`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,
      provider,provider_api,model,billing_path,input_tokens,output_tokens,cached_tokens,cache_write_tokens,
      reasoning_tokens,total_tokens,occurred_at) values(${accountId},${workspaceId},${sessionId},${crypto.randomUUID()},
      ${`token-edge:${value.name}`},'token-edges','responses',${value.name},'external',${value.input},50,
      ${value.cached},${value.writes},${value.reasoning},${value.input === null ? null : value.input + 50},'2026-09-07T00:00:00Z')`;
  }
  const response = await usage({ range: "month", provider: "token-edges" });
  expect(response.totals.tokens).toEqual({
    uncachedInput: 80,
    cacheRead: 80,
    cacheWrite: 40,
    output: 300,
    reasoning: 25,
  });
  const page = await actor(() =>
    readInsightsCalls(client.db, {
      accountId,
      workspaceId,
      now,
      detailsWorkspaceIds: [workspaceId],
      query: InsightsCallsQuery.parse({ range: "month", provider: "token-edges" }),
    }),
  );
  expect(page.calls).toHaveLength(cases.length);
  for (const value of cases) {
    const call = page.calls.find((item) => item.model === value.name)!;
    if (value.uncached === null) expect(call.tokens).toBeNull();
    else
      expect(call.tokens).toEqual({
        uncachedInput: value.uncached,
        cacheRead: value.cached,
        cacheWrite: value.writes,
        output: 50,
        reasoning: value.reasoning,
      });
  }
});
