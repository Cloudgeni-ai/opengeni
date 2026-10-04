/** Timing-only, loopback-only full-App benchmark on an attested isolated copy. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { availableParallelism, cpus, totalmem } from "node:os";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  createDb,
  createOrganizationApiKey,
  applyCreditLedgerEntry,
  recordModelCallFact,
  recordUsageEvent,
  withSessionRlsActorContext,
  withWorkspaceSessionActivityRls,
  withDatabaseTimingObserver,
  type DatabaseTimingObservation,
} from "@opengeni/db";
import { InsightsCallsResponse, InsightsUsageResponse } from "@opengeni/contracts/insights-usage";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

const NativeDate = Date;
const repo = process.cwd();
const fixture = await Bun.file("/workspace/insights-raw-http-fixture.json").json();
const receiptPath = process.env.INSIGHTS_DAILY_COPY_RECEIPT;
const out = process.env.INSIGHTS_DAILY_HTTP_OUT;
const samples = Number(process.env.INSIGHTS_DAILY_HTTP_SAMPLES ?? 20);
const mode = process.env.INSIGHTS_DAILY_HTTP_MODE ?? "clean";
if (!receiptPath || !out || !out.startsWith("/workspace/") || (await Bun.file(out).exists()))
  throw new Error("A new workspace output and an attested copy receipt are required; no replay");
if (!Number.isSafeInteger(samples) || samples < 2 || samples > 50)
  throw new Error("Samples must be 2..50, excluding the separately reported first request");
if (mode !== "clean" && mode !== "dirty") throw new Error("Benchmark mode must be clean or dirty");
const copy = await Bun.file(receiptPath).json();
if (
  fixture.database !== "og_insights_http_scale_1a6870920e21" ||
  !fixture.seeded ||
  copy.originalDatabase !== fixture.database ||
  !copy.countsAndForceEqual ||
  !/^og_insights_daily_http_[a-f0-9]{12}$/.test(copy.database) ||
  !["og_insights_daily_bootstrap_1a6870920e21", "og_insights_http_cache_1a6870920e21"].includes(
    copy.template,
  )
)
  throw new Error("Verified new isolated retained-volume copy required");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const head = () =>
  Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
const paths = [
  "apps/api/scripts/bench-insights-daily-http.ts",
  "apps/api/src/app.ts",
  "apps/api/src/routes/insights-usage.ts",
  "apps/api/src/routes/insights-response-cache.ts",
  "packages/db/src/insights-unified.ts",
  "packages/db/src/database.ts",
  "packages/core/src/domain/insights-usage.ts",
  "packages/core/src/session-authorization.ts",
  ...[
    "0606_insights_daily_rollups.sql",
    "0607_insights_actual_model_debits.sql",
    "0608_insights_historical_list_allocations.sql",
    "0609_insights_daily_usage_reader.sql",
  ].map((name) => `packages/db/drizzle/${name}`),
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, hash(await Bun.file(`${repo}/${path}`).text())]),
    ),
  );
const readOptional = async (path: string) => {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
};
const snapshot = async (connection: postgres.Sql) => ({
  counts: (
    await connection`select
    (select count(*)::text from model_call_facts) facts,
    (select count(*)::text from usage_events) usage,
    (select count(*)::text from usage_events where event_type='sandbox.warm_seconds') warm,
    (select count(*)::text from credit_ledger_entries) ledger,
    (select count(*)::text from sessions) sessions,
    (select sum(priced_cost_micros)::text from model_call_facts) requested,
    (select sum(estimated_provider_cost_micros)::text from model_call_facts) list,
    (select sum(amount_micros)::text from credit_ledger_entries) actual`
  )[0],
  force: [
    ...(await connection`select relname,relrowsecurity,relforcerowsecurity from pg_class
    where oid in('model_call_facts'::regclass,'usage_events'::regclass,'credit_ledger_entries'::regclass,'sessions'::regclass)
    order by relname`),
  ],
  history: [...(await connection`select name from schema_migrations order by name`)],
});
const admin = postgres(`postgres://postgres:x@127.0.0.1:61440/${copy.database}`, { max: 1 });
const original = postgres(`postgres://postgres:x@127.0.0.1:61440/${fixture.database}`, { max: 1 });
const client = createDb(`postgres://opengeni_app:local-test@127.0.0.1:61440/${copy.database}`, {
  max: 4,
  rlsStrategy: "force",
});
const evidence: Record<string, unknown> = {
  startedAt: new NativeDate().toISOString(),
  measuredStartHead: head(),
  sourceStart: await sourceHashes(),
  synthetic: true,
  localOnly: true,
  physicalCopy: copy,
  seedOrMigrationReplay: false,
  cachePolicy:
    "Every timed request uses a fresh complete createApp instance and its newly created empty response-cache map; no public bypass or authentication changes",
  route:
    "Full createApp middleware, canonical selected organization key, live actor ceilings, Core/DB and JSON over actual loopback HTTP",
  coldLabel:
    "First request is reported separately; shared PG/pool/OS caches are not flushed, no true cold samples",
  trueColdSamples: 0,
  plannedSubsequentSamplesPerScope: samples,
  mode,
  dirtyPolicy:
    mode === "dirty"
      ? "Before every timed request, atomically commit one ordinary restricted-app fact, one warm usage event and a matching negative ledger entry on this copy; HTTP latency excludes writer time but includes any read reconciliation; no manual refresh between samples"
      : null,
  dirtyWrites: [],
  cases: [],
  completed: false,
};
const persist = () => Bun.write(out, JSON.stringify(evidence, null, 2));
const percentile = (values: number[], quantile: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * quantile) - 1] : null;
};
const affinity = (pid: string | number) => {
  const result = Bun.spawnSync(["taskset", "-pc", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    observed: result.exitCode === 0 ? result.stdout.toString().trim() : null,
    error: result.exitCode === 0 ? null : result.stderr.toString().trim(),
  };
};
let server: ReturnType<typeof Bun.serve> | undefined;
async function request(path: string, raw: string) {
  const observations: DatabaseTimingObservation[] = [];
  const app = createApp({
    db: client.db,
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: "synthetic-benchmark-only",
    }),
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    fetch: (incoming) =>
      withDatabaseTimingObserver(
        (observation) => observations.push(observation),
        async () => await app.fetch(incoming),
      ),
  });
  try {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { authorization: `Bearer ${raw}` },
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: JSON.parse(text),
      elapsedMs: performance.now() - started,
      observations,
    };
  } finally {
    server.stop(true);
    server = undefined;
  }
}
function assertDirtyTotals(
  actual: InsightsUsageResponse,
  baseline: InsightsUsageResponse,
  writes: number,
) {
  const expected = {
    ...baseline.totals,
    calls: baseline.totals.calls + writes,
    chargedMicros: baseline.totals.chargedMicros + writes,
    listMicros: baseline.totals.listMicros + 73 * writes,
    pricedCalls: baseline.totals.pricedCalls + writes,
    listByClassApprox:
      baseline.totals.listByClassApprox ||
      (baseline.totals.listClassKnownCalls > 0 &&
        baseline.totals.listClassKnownCalls < baseline.totals.pricedCalls + writes),
    byPayer: {
      ...baseline.totals.byPayer,
      opengeni_credits: {
        calls: baseline.totals.byPayer.opengeni_credits.calls + writes,
        chargedMicros: baseline.totals.byPayer.opengeni_credits.chargedMicros + writes,
        listMicros: baseline.totals.byPayer.opengeni_credits.listMicros + 73 * writes,
      },
    },
  };
  if (
    JSON.stringify(actual.totals) !== JSON.stringify(expected) ||
    JSON.stringify(actual.prior) !== JSON.stringify(baseline.prior)
  )
    throw new Error("Committed dirty fact/debit is missing or changes prior/unknown coverage");
}
try {
  const before = await snapshot(admin),
    originalBefore = await snapshot(original);
  if (
    JSON.stringify(before) !== JSON.stringify(copy.after) ||
    before.counts?.facts !== "838000" ||
    before.counts?.usage !== "4170000" ||
    before.force.some((row) => !row.relrowsecurity || !row.relforcerowsecurity)
  )
    throw new Error("Attested copy data/FORCE/catalog changed before timing");
  evidence.before = before;
  const [role] = await client.db.execute(
    sql`select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user`,
  );
  if (role?.current_user !== "opengeni_app" || role.rolsuper || role.rolbypassrls)
    throw new Error("Normal NOSUPERUSER/NOBYPASSRLS application role required");
  evidence.role = role;
  evidence.schemaRoutineHashes = [
    ...(await admin`select p.proname,pg_get_function_identity_arguments(p.oid) signature,
    md5(pg_get_functiondef(p.oid)) definition_hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='opengeni_private' and p.proname like 'insights_%' order by p.proname,signature`),
  ];
  const [databaseSettings] =
    await admin`select version(),current_setting('shared_buffers') shared_buffers,
    current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') parallel_workers,
    current_setting('max_connections') max_connections,pg_postmaster_start_time() postmaster_started_at`;
  evidence.databaseSettings = databaseSettings;
  const pid = (await readFile("/workspace/insights-postgres-utf8/postmaster.pid", "utf8")).split(
    "\n",
  )[0];
  if (!pid || !/^\d+$/.test(pid)) throw new Error("Exact postmaster PID required");
  evidence.hardware = {
    cpuModel: cpus()[0]?.model,
    logicalCpus: cpus().length,
    availableParallelism: availableParallelism(),
    totalmem: totalmem(),
    cpuQuotaV2: await readOptional("/sys/fs/cgroup/cpu.max"),
    cpuQuotaV1: await readOptional("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
    cpuPeriodV1: await readOptional("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
    memoryLimitV2: await readOptional("/sys/fs/cgroup/memory.max"),
    memoryLimitV1: await readOptional("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    processAffinity: affinity(process.pid),
    postgresAffinity: affinity(pid),
  };
  // Normal key creation is confined to the new copy; never retain or log its raw value.
  const raw = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
  const permissions = [
    "billing:read",
    "workspace:read",
    "workspace:admin",
    "sessions:read",
  ] as const;
  const key = await createOrganizationApiKey(client.db, {
    accountId: fixture.accountId,
    name: "Isolated uncached daily HTTP benchmark",
    prefix: raw.slice(0, 14),
    keyHash: hash(raw),
    permissions: [...permissions],
    policy: {
      preset: "custom",
      permissions: [...permissions],
      workspaceScope: { kind: "selected", workspaceIds: fixture.workspaceIds },
    },
  });
  evidence.canonicalKeyCreatedOnCopy = true;
  evidence.keyReceiptPresent = Boolean(key);
  // Released week semantics: six preceding full days plus the current UTC day.
  // Freeze at its last millisecond, reporting seven calendar dates, not claiming exact 168h.
  const frozenAt = "2026-10-03T23:59:59.999Z",
    frozenMs = NativeDate.parse(frozenAt);
  const FrozenDate = function (...args: unknown[]) {
    if (!new.target) return new NativeDate(frozenMs).toString();
    return Reflect.construct(NativeDate, args.length ? args : [frozenMs], NativeDate);
  };
  Object.setPrototypeOf(FrozenDate, NativeDate);
  FrozenDate.prototype = NativeDate.prototype;
  Object.defineProperty(FrozenDate, "now", { value: () => frozenMs });
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  evidence.frozenRequestTime = frozenAt;
  let dirtySessionId: string | undefined;
  if (mode === "dirty") {
    const visible = await request(
      `/v1/workspaces/${fixture.workspaceId}/insights/calls?range=week&limit=1`,
      raw,
    );
    if (visible.status !== 200) throw new Error("Actual-auth visible fixture selection failed");
    dirtySessionId =
      InsightsCallsResponse.parse(visible.body).calls.find(
        (call) => call.sessionId !== null && call.sessionKind === "visible",
      )?.sessionId ?? undefined;
    if (!dirtySessionId) throw new Error("A normally authorized visible session is required");
    evidence.dirtySessionSelectedThroughActualAuth = true;
  }
  for (const scope of ["workspace", "organization"] as const) {
    const parent =
      scope === "workspace"
        ? `workspaces/${fixture.workspaceId}`
        : `organizations/${fixture.accountId}`;
    const path = `/v1/${parent}/insights/usage?range=week&groupBy=model`;
    const results: Record<string, unknown>[] = [],
      subsequent: number[] = [];
    let dirtyBaseline: InsightsUsageResponse | undefined;
    if (mode === "dirty") {
      const response = await request(path, raw);
      if (response.status !== 200) throw new Error("Pre-write scope baseline failed");
      dirtyBaseline = InsightsUsageResponse.parse(response.body);
      (evidence as { dirtyBaselines?: unknown[] }).dirtyBaselines ??= [];
      (evidence as { dirtyBaselines: unknown[] }).dirtyBaselines.push({
        scope,
        body: response.body,
        bodySha256: hash(response.text),
        elapsedMs: response.elapsedMs,
        freshAppAndEmptyResponseCache: true,
        includedInTimedSamples: false,
      });
    }
    let firstBody: unknown,
      successful = 0;
    for (let index = 0; index <= samples; index++) {
      if (mode === "dirty") {
        const turnId = crypto.randomUUID(),
          sourceKey = `isolated-dirty:${crypto.randomUUID()}`;
        const writeReceipt = {
          scope,
          index,
          turnId,
          sourceKey,
          committed: false,
          occurredAt: "2026-10-03T12:00:00.000Z",
          requestedMicros: 101,
          recordedListMicros: 73,
          actualDebitMicros: 1,
          warmUsageQuantity: 1,
        };
        (evidence.dirtyWrites as unknown[]).push(writeReceipt);
        await persist();
        const started = performance.now();
        await withSessionRlsActorContext({ subjectId: fixture.subjectId }, () =>
          withWorkspaceSessionActivityRls(client.db, fixture.workspaceId, async (bounded) => {
            await recordModelCallFact(bounded, {
              accountId: fixture.accountId,
              workspaceId: fixture.workspaceId,
              sessionId: dirtySessionId!,
              turnId,
              sourceKey,
              provider: "isolated-http-benchmark",
              providerApi: "responses",
              model: "synthetic-unknown-tokens",
              billingPath: "opengeni_credits",
              pricedCostMicros: 101,
              estimatedProviderCostMicros: 73,
              pricingSource: "configured_list_price",
              occurredAt: new NativeDate(writeReceipt.occurredAt),
            });
            await recordUsageEvent(bounded, {
              accountId: fixture.accountId,
              workspaceId: fixture.workspaceId,
              sessionId: dirtySessionId!,
              subjectId: fixture.subjectId,
              eventType: "sandbox.warm_seconds",
              quantity: 1,
              unit: "seconds",
              sourceResourceId: sourceKey,
              idempotencyKey: `usage:isolated-dirty:${turnId}:${sourceKey}`,
              occurredAt: new NativeDate(writeReceipt.occurredAt),
            });
            await applyCreditLedgerEntry(bounded, {
              accountId: fixture.accountId,
              workspaceId: fixture.workspaceId,
              type: "model_usage_debit",
              amountMicros: -1,
              sourceType: "model_response",
              sourceId: `${turnId}:${sourceKey}`,
              idempotencyKey: `credit:model_usage_debit:${turnId}:${sourceKey}`,
              metadata: { sessionId: dirtySessionId },
              occurredAt: new NativeDate(writeReceipt.occurredAt),
            });
          }),
        );
        Object.assign(writeReceipt, { committed: true, elapsedMs: performance.now() - started });
        await persist();
      }
      const response = await request(path, raw);
      const { text, body, elapsedMs, observations } = response;
      evidence.lastResponse = {
        scope,
        index,
        status: response.status,
        body,
        bodySha256: hash(text),
        elapsedMs,
        databaseObservations: observations,
      };
      if (response.status === 200) {
        const dto = InsightsUsageResponse.parse(body);
        if (dto.windowStart !== "2026-09-27T00:00:00.000Z" || dto.windowEnd !== frozenAt)
          throw new Error(
            "Request window differs from the frozen released seven-calendar-date semantics",
          );
        if (dirtyBaseline) assertDirtyTotals(dto, dirtyBaseline, index + 1);
        successful++;
        firstBody ??= body;
        if (index) subsequent.push(elapsedMs);
      }
      results.push({
        index,
        label: index === 0 ? "first_request_not_true_cold" : "subsequent_uncached_request",
        status: response.status,
        elapsedMs,
        bodySha256: hash(text),
        databaseObservations: observations,
        error: response.status === 200 ? null : body.error,
        freshAppAndEmptyResponseCache: true,
        committedDirtyWriteImmediatelyBeforeRequest: mode === "dirty",
        exactDirtyAmountAndKnownnessDelta: mode === "dirty" ? true : null,
      });
      console.log(JSON.stringify({ scope, index, status: response.status, elapsedMs }));
      // Expose a concrete failure promptly; do not issue many identical timed-out requests.
      if (response.status !== 200) break;
    }
    const dto = firstBody as
      | {
          windowStart?: string;
          windowEnd?: string;
          priorWindowStart?: string;
          priorWindowEnd?: string;
        }
      | undefined;
    (evidence.cases as unknown[]).push({
      scope,
      path,
      query: { range: "week", groupBy: "model" },
      requests: results,
      firstBody,
      successfulRequests: successful,
      errors: results.length - successful,
      windowStart: dto?.windowStart,
      windowEnd: dto?.windowEnd,
      priorWindowStart: dto?.priorWindowStart,
      priorWindowEnd: dto?.priorWindowEnd,
      elapsedHours:
        dto?.windowStart && dto.windowEnd
          ? (NativeDate.parse(dto.windowEnd) - NativeDate.parse(dto.windowStart)) / 3_600_000
          : null,
      subsequentSamples: subsequent.length,
      p50Ms: percentile(subsequent, 0.5),
      p95Ms: percentile(subsequent, 0.95),
      targetP95BelowOneSecond:
        successful === samples + 1 && (percentile(subsequent, 0.95) ?? Infinity) < 1000,
    });
    await persist();
  }
  globalThis.Date = NativeDate;
  evidence.after = await snapshot(admin);
  evidence.originalUnchanged =
    JSON.stringify(originalBefore) === JSON.stringify(await snapshot(original));
  evidence.copySourceDataAndForceUnchanged =
    JSON.stringify(before) === JSON.stringify(evidence.after);
  const committedWrites = (evidence.dirtyWrites as { committed: boolean }[]).filter(
    (write) => write.committed,
  ).length;
  const after = evidence.after as Awaited<ReturnType<typeof snapshot>>;
  const expectedCounts = { ...before.counts };
  for (const [field, delta] of Object.entries({
    facts: committedWrites,
    usage: committedWrites,
    warm: committedWrites,
    ledger: committedWrites,
    requested: 101 * committedWrites,
    list: 73 * committedWrites,
    actual: -committedWrites,
  })) {
    expectedCounts[field] = String(BigInt(before.counts![field] as string) + BigInt(delta));
  }
  evidence.copyExactDeliberateDirtyDelta =
    JSON.stringify(expectedCounts) === JSON.stringify(after.counts) &&
    JSON.stringify(before.force) === JSON.stringify(after.force) &&
    JSON.stringify(before.history) === JSON.stringify(after.history);
  evidence.measuredEndHead = head();
  evidence.sourceEnd = await sourceHashes();
  if (
    !evidence.originalUnchanged ||
    !(mode === "clean"
      ? evidence.copySourceDataAndForceUnchanged
      : evidence.copyExactDeliberateDirtyDelta) ||
    evidence.measuredStartHead !== evidence.measuredEndHead ||
    JSON.stringify(evidence.sourceStart) !== JSON.stringify(evidence.sourceEnd)
  )
    throw new Error("Source or retained data changed during timing");
  evidence.completed = true;
  evidence.completedAt = new NativeDate().toISOString();
  await persist();
} catch (error) {
  globalThis.Date = NativeDate;
  evidence.fatalError = {
    name: (error as Error).name,
    message: (error as Error).message.slice(0, 400),
  };
  await persist();
  throw error;
} finally {
  globalThis.Date = NativeDate;
  server?.stop(true);
  await client.close();
  await admin.end();
  await original.end();
}
