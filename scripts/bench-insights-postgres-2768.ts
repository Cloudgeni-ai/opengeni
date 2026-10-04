/** Local-only, actual production query harness. See --help; never point at an external DB. */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { availableParallelism, cpus, freemem, totalmem } from "node:os";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { OrganizationUsageSummary } from "@opengeni/contracts";
import { OrganizationModelUsage } from "@opengeni/contracts/organization-model-usage";
import { organizationUsageWindow } from "../packages/db/src/organization-usage";
import {
  createDb,
  registerDbBinding,
  getOrganizationModelUsage,
  getOrganizationUsageSummary,
  getOrganizationUsageWorkspacePage,
  withSessionRlsActorContext,
  withWorkspaceRls,
  type DbClient,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../packages/db/src/lossless-json";
import {
  getWorkspaceInsights,
  type GetWorkspaceInsightsInput,
} from "../packages/core/src/domain/insights";
import { acquireSharedTestDatabase, testSettings } from "@opengeni/testing";
import {
  DEFAULT_CALLS,
  FIXTURE_VERSION,
  NOW,
  fixtureId,
  type OracleFilter,
} from "./bench-insights-postgres-2768/oracle";
import {
  fixtureInventory,
  seedFixture,
  reconcileApprovedFixture,
  upgradeRetainedFixture,
  type Fixture,
} from "./bench-insights-postgres-2768/seed";
import {
  restrictedOwnerFixture,
  assertBenchmarkClusterName,
  classifyInsightsSql,
  BENCH_READ_FUNCTIONS,
  sanitizeEvidence,
  summarizeExplain,
} from "./bench-insights-postgres-2768/auth";
import {
  assertOrganizationLedger,
  assertOrganizationModels,
  assertWorkspace,
  compareMeasurements,
  type Assertion,
} from "./bench-insights-postgres-2768/assertions";

type CapturedQuery = {
  connection: number;
  sql: string;
  parameters: any[];
  setup: { sql: string; parameters: any[] }[];
};
const requestStore = new AsyncLocalStorage<{ queries: CapturedQuery[]; phases: unknown[] }>();
// PostgreSQL notices arrive on socket callbacks, outside request AsyncLocalStorage.
// Diagnostic plans run sequentially, so one explicit active sink is unambiguous.
let activePlanNotices: unknown[] | null = null;
const setupByConnection = new Map<number, { sql: string; parameters: any[] }[]>();
type Args = {
  seed: boolean;
  resumeSeed: boolean;
  out: string;
  runs: number;
  calls: number;
  explain: boolean;
  plansOnly: boolean;
  concurrency: number;
  strict: boolean;
  verifyHarness: boolean;
  reconcileApproved: boolean;
  upgradeRetained: boolean;
  exportOnly: boolean;
  diagnosticResults: boolean;
  fixturePath?: string;
  baselinePath?: string;
  approvedSha?: string;
};
function parseArgs(): Args {
  const args: Args = {
    seed: false,
    resumeSeed: false,
    out: resolve(".artifacts/bench-insights-2768"),
    runs: 2,
    calls: DEFAULT_CALLS,
    explain: false,
    plansOnly: false,
    concurrency: 4,
    strict: false,
    verifyHarness: false,
    reconcileApproved: false,
    upgradeRetained: false,
    exportOnly: false,
    diagnosticResults: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--help") {
      console.log(
        "OPENGENI_TEST_PG_URL=<loopback-maintenance-url> bun scripts/bench-insights-postgres-2768.ts [--seed --calls=2000000] [--fixture=<retained-fixture.json>] [--reconcile-approved] [--baseline=<retained-baseline-dir>] [--approved-sha=<exact40charSHA>] [--runs=2] [--explain] [--concurrency=4] [--strict] [--out=<new-evidence-dir>]\nUse a DEDICATED PostgreSQL17+pgvector cluster started with -c cluster_name=opengeni-bench2768. The fixture restricts migration owners and retains FORCE RLS; a separate fixture admin is recorded in auth-fixture.json. A new --out plus --fixture preserves original baseline measurements and does NOT reseed. --reconcile-approved physically clones that seed, records the reviewed migration renumber and uses the restricted owner/repository migration engine; it never writes the original database. Completed reconciliation is reused with its --out, omitting --fixture/--reconcile-approved. --strict requires the approved immutable backend SHA; production-source diffs are rejected. --baseline produces successful-request median comparisons and flags >20%regressions/production failures; diagnostic timings are excluded. --resume-seed is only for incomplete matching-version checkpoints, not this retained final workload. --plans-only replays retained SQL without overwriting request measurements. Diagnostic timeout120s; org production wrappers retain10s; app defaults/setups are recorded. Dates: today/week/month/ytd, with provider/model/root/session scopes for each (all is NOT a production contract).",
      );
      console.log(
        "--export-only writes a sanitized publishable/current plus optional baseline JSON export without DB access. --diagnostic-results-only replays retained year-wide org SQL under the captured app auth with a120s diagnostic timeout; its checks are separate from production measurements and cannot clear production failures.",
      );
      console.log(
        "--upgrade-retained --fixture=<previous-approved-fixture.json> --approved-sha=<new-approved-SHA> --out=<new-output> applies additive rolling migrations to the existing physical copy, verifies unchanged rows/write policies, and never reseeds. Reuse completed upgrades with their --out only.",
      );
      process.exit(0);
    }
    if (arg === "--seed") args.seed = true;
    else if (arg === "--upgrade-retained") args.upgradeRetained = true;
    else if (arg === "--diagnostic-results-only") {
      args.diagnosticResults = true;
      args.plansOnly = true;
    } else if (arg === "--export-only") args.exportOnly = true;
    else if (arg === "--reconcile-approved") args.reconcileApproved = true;
    else if (arg === "--verify-harness") args.verifyHarness = true;
    else if (arg === "--resume-seed") args.resumeSeed = true;
    else if (arg === "--explain") args.explain = true;
    else if (arg === "--plans-only") {
      args.plansOnly = true;
      args.explain = true;
    } else if (arg === "--strict") args.strict = true;
    else if (arg.startsWith("--out=")) args.out = resolve(arg.slice(6));
    else if (arg.startsWith("--fixture=")) args.fixturePath = resolve(arg.slice(10));
    else if (arg.startsWith("--baseline=")) args.baselinePath = resolve(arg.slice(11));
    else if (arg.startsWith("--approved-sha=")) args.approvedSha = arg.slice(15);
    else if (arg.startsWith("--runs=")) args.runs = Number(arg.slice(7));
    else if (arg.startsWith("--calls=")) args.calls = Number(arg.slice(8));
    else if (arg.startsWith("--concurrency=")) args.concurrency = Number(arg.slice(14));
    else throw new Error(`Unknown argument ${arg}`);
  }
  for (const n of [args.runs, args.calls, args.concurrency])
    if (!Number.isSafeInteger(n) || n < 1) throw new Error("Positive integer options required");
  if (args.concurrency > 8) throw new Error("Local harness concurrency maximum is 8");
  if (args.seed && args.resumeSeed) throw new Error("Choose --seed OR --resume-seed");
  if (args.fixturePath && (args.seed || args.resumeSeed))
    throw new Error("Explicit --fixture cannot seed/resume");
  if (
    args.reconcileApproved &&
    (!args.approvedSha || !args.fixturePath || !args.baselinePath || args.plansOnly)
  )
    throw new Error(
      "Reconciliation requires approved SHA, original fixture, baseline and new output",
    );
  if (args.approvedSha && !/^[a-f0-9]{40}$/.test(args.approvedSha))
    throw new Error("Approved SHA must be an exact 40-character commit");
  if (
    args.upgradeRetained &&
    (!args.approvedSha || !args.fixturePath || args.plansOnly || args.reconcileApproved)
  )
    throw new Error(
      "Retained upgrade requires previous fixture and approved SHA without reconciliation/plans-only",
    );
  if (args.strict && !args.approvedSha)
    throw new Error("Final --strict requires --approved-sha=<parent-approved immutable SHA>");
  if (args.strict && !args.plansOnly && (args.runs < 2 || args.concurrency < 4))
    throw new Error("Final strict workload requires at least2runs and4concurrent reads");
  if (args.baselinePath === args.out)
    throw new Error("Never overwrite the retained baseline output");
  if (args.plansOnly && (args.seed || args.resumeSeed))
    throw new Error("--plans-only requires an already completed retained fixture");
  if (!args.out.startsWith(`${process.cwd()}/`))
    throw new Error("Evidence must remain inside this checkout");
  return args;
}
function localUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  )
    throw new Error("Only loopback PostgreSQL test fixtures are permitted");
  return url;
}
function command(args: string[]) {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${args[0]}`);
  return result.stdout.toString().trim();
}
function queryCapture(connection: number, query: string, parameters: any[]) {
  if (/^begin/i.test(query)) setupByConnection.set(connection, []);
  const current = setupByConnection.get(connection) ?? [];
  const request = requestStore.getStore();
  if (
    request &&
    (classifyInsightsSql(query) || /current_grouped|current_facts|usage_base/.test(query)) &&
    !/set_config/.test(query)
  ) {
    request.queries.push({
      connection,
      sql: query,
      parameters: [...parameters],
      setup: [...current],
    });
  }
  if (/set_config|pg_advisory/.test(query) && !/organization_(model_)?usage_summary/.test(query)) {
    current.push({ sql: query, parameters: [...parameters] });
    setupByConnection.set(connection, current);
  }
  if (/^(commit|rollback)/i.test(query)) setupByConnection.delete(connection);
}
function json(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
async function write(out: string, name: string, value: unknown) {
  await Bun.write(`${out}/${name}`, json(value));
}
function safeError(error: any) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 2000),
    cause: error?.cause
      ? {
          name: error.cause.name,
          code: error.cause.code ?? null,
          message: String(error.cause.message).slice(0, 2000),
        }
      : undefined,
  };
}

async function main() {
  const args = parseArgs();
  if (args.exportOnly) {
    if (
      args.seed ||
      args.resumeSeed ||
      args.reconcileApproved ||
      args.upgradeRetained ||
      args.fixturePath
    )
      throw new Error("Evidence export does not touch a database or seed");
    const sensitiveValues = Object.entries(process.env)
      .filter(([name]) => /TOKEN|SECRET|API_KEY|CREDENTIALS|PASSWORD/.test(name))
      .map(([, value]) => value ?? "")
      .filter((value) => value.length >= 12);
    const directories = [
      { source: args.out, destination: `${args.out}/publishable/current` },
      ...(args.baselinePath
        ? [{ source: args.baselinePath, destination: `${args.out}/publishable/baseline` }]
        : []),
    ];
    const files = [];
    const plans: Record<string, any> = {};
    for (const directory of directories) {
      await mkdir(directory.destination, { recursive: true });
      for (const name of (await readdir(directory.source))
        .filter((entry) => entry.endsWith(".json"))
        .sort()) {
        const raw = await Bun.file(`${directory.source}/${name}`).json();
        const safe = sanitizeEvidence(raw, sensitiveValues);
        const body = json(safe);
        if (sensitiveValues.some((secret) => body.includes(secret)))
          throw new Error("An environment credential survived evidence sanitization");
        await Bun.write(`${directory.destination}/${name}`, body);
        files.push({
          path: `${directory.destination}/${name}`,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
        if (directory.source === args.out && name.startsWith("explain-"))
          plans[name] = summarizeExplain(safe);
      }
    }
    await write(`${args.out}/publishable`, "plan-hotspots.json", plans);
    await write(`${args.out}/publishable`, "export-index.json", {
      exportedAt: new Date().toISOString(),
      files,
      authSetupRedacted: true,
      environmentCredentialScanPassed: true,
      note: "Synthetic data only. All bound auth-setup parameters and local maintenance identity/connection URLs are redacted. Production helper source regenerates contexts. Raw local originals remain untouched. This directory is not a retained artifact until native publication returns a receipt.",
    });
    console.log(
      json({
        exportedFiles: files.length,
        planFiles: Object.keys(plans).length,
        credentialScanPassed: true,
      }),
    );
    return;
  }
  if (args.verifyHarness) {
    await mkdir(args.out, { recursive: true });
    const commands = [
      [
        "bun",
        "node_modules/oxfmt/bin/oxfmt",
        "--check",
        "scripts/bench-insights-postgres-2768.ts",
        "scripts/bench-insights-postgres-2768/",
      ],
      [
        "bun",
        "node_modules/typescript/bin/tsc",
        "--project",
        "scripts/bench-insights-postgres-2768/tsconfig.json",
        "--noEmit",
      ],
      ["bun", "test", "scripts/bench-insights-postgres-2768/oracle.test.ts"],
      ["bun", "node_modules/oxlint/bin/oxlint", "--deny-warnings", "."],
      ["git", "diff", "--check"],
    ];
    const checks = [];
    for (const argv of commands) {
      const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      checks.push({
        argv,
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      });
      await write(args.out, "verification.json", {
        checkedAt: new Date().toISOString(),
        sourceHead: command(["git", "rev-parse", "HEAD"]),
        checks,
      });
    }
    if (checks.some((check) => check.exitCode !== 0)) process.exitCode = 1;
    console.log(json(checks.map((check) => ({ argv: check.argv, exitCode: check.exitCode }))));
    return;
  }
  const maintenance = localUrl(process.env.OPENGENI_TEST_PG_URL ?? "");
  // Reject a different local development/test cluster before the shared
  // fixture factory, seeding or upgrade can provision roles or databases.
  const preflight = postgres(maintenance.toString(), { max: 1, prepare: false });
  try {
    const [cluster] = await preflight`select current_setting('cluster_name') as name`;
    assertBenchmarkClusterName(cluster?.name);
  } finally {
    await preflight.end();
  }
  if (args.approvedSha) {
    command(["git", "merge-base", "--is-ancestor", args.approvedSha, "HEAD"]);
    const changes = command([
      "git",
      "diff",
      args.approvedSha,
      "--",
      "packages/db/src",
      "packages/db/drizzle",
      "packages/core/src/domain/insights.ts",
      "packages/contracts/src",
    ]);
    if (changes)
      throw new Error(
        "Production source differs from the approved SHA; only harness changes are permitted",
      );
  }
  await mkdir(args.out, { recursive: true });
  let statePath = args.fixturePath ?? `${args.out}/fixture.json`;
  if (args.upgradeRetained) {
    if (await Bun.file(`${args.out}/fixture.json`).exists())
      throw new Error(
        "Retained upgrade already completed; reuse its --out without --fixture/upgrade",
      );
    await upgradeRetainedFixture(
      maintenance,
      await Bun.file(statePath).json(),
      `${dirname(statePath)}/environment.json`,
      args.approvedSha!,
      args.out,
    );
    statePath = `${args.out}/fixture.json`;
  }
  if (args.reconcileApproved) {
    if (await Bun.file(`${args.out}/fixture.json`).exists())
      throw new Error(
        "Reconciliation already completed; reuse its --out without --fixture/reconcile",
      );
    await reconcileApprovedFixture(
      maintenance,
      await Bun.file(statePath).json(),
      args.approvedSha!,
      args.baselinePath!,
      args.out,
    );
    statePath = `${args.out}/fixture.json`;
  }
  let admin: postgres.Sql;
  let appUrl: string;
  let fixture: Fixture;
  if (args.seed || args.resumeSeed) {
    if (await Bun.file(statePath).exists())
      throw new Error(
        "Existing fixture manifest: reuse it or choose a new explicit --out, never overwrite",
      );
    let database: string;
    if (args.resumeSeed) {
      const state = await Bun.file(`${args.out}/database.json`).json();
      if (
        !/^og_bench_insights_2768_[a-f0-9]{12}$/.test(state.database) ||
        state.phase !== "seed_started" ||
        state.fixtureVersion !== FIXTURE_VERSION
      )
        throw new Error("Unexpected incomplete fixture target");
      database = state.database;
      maintenance.pathname = `/${database}`;
      admin = postgres(maintenance.toString(), { max: 2, prepare: false });
      const app = new URL(maintenance);
      app.username = "opengeni_app";
      app.password = "apppw";
      appUrl = app.toString();
    } else {
      const shared = await acquireSharedTestDatabase("bench_insights_2768");
      if (!shared) throw new Error("Real PostgreSQL fixture required");
      admin = shared.admin;
      appUrl = shared.appUrl;
      database = new URL(shared.adminUrl).pathname.slice(1);
    }
    // Keep this exact isolated clone for repeatability; release() would DROP it.
    await write(args.out, "database.json", {
      database,
      phase: "seed_started",
      fixtureVersion: FIXTURE_VERSION,
    });
    const seedClient = createDb(appUrl, { max: 4 });
    try {
      fixture = await seedFixture(admin, seedClient, args.calls);
      await write(args.out, "fixture.json", {
        database,
        fixture,
        approvedSha: args.approvedSha ?? null,
      });
    } finally {
      await seedClient.close();
    }
  } else {
    const state = await Bun.file(statePath).json();
    if (!/^og_bench_insights_2768_[a-f0-9]{12}$/.test(state.database))
      throw new Error("Unexpected fixture database target");
    if (args.approvedSha && state.approvedSha !== args.approvedSha)
      throw new Error(
        "Retained fixture belongs to another approved backend; reconcile/upgrade explicitly first",
      );
    maintenance.pathname = `/${state.database}`;
    admin = postgres(maintenance.toString(), { max: 2, prepare: false });
    const app = new URL(maintenance);
    app.username = "opengeni_app";
    app.password = "apppw";
    appUrl = app.toString();
    fixture = state.fixture;
    if (fixture.version !== FIXTURE_VERSION)
      throw new Error(
        "Fixture source revision mismatch; use a new --out and seed the current version",
      );
    if (args.fixturePath && statePath !== `${args.out}/fixture.json`) {
      if (await Bun.file(`${args.out}/fixture.json`).exists())
        throw new Error("New evidence output already has a fixture manifest; choose another --out");
      await write(args.out, "fixture.json", {
        ...state,
        reusedFrom: statePath,
      });
    }
  }
  const authFixture = await restrictedOwnerFixture(
    admin,
    maintenance,
    new URL(appUrl).pathname.slice(1),
    args.explain,
  );
  admin = authFixture.admin;
  await write(args.out, "auth-fixture.json", {
    functionOwners: authFixture.evidence,
    objectOwner: authFixture.objectOwner,
    fixtureAdminRole: authFixture.fixtureAdminRole,
    nestedPlansPrepared: args.explain,
    note: "Fixture administrative connection is only for inventory/seed; all measured calls use opengeni_app. Definer owner is NOSUPERUSER NOBYPASSRLS; FORCE RLS and original policies are retained.",
  });
  const app = postgres(appUrl, {
    max: 32,
    prepare: false,
    idle_timeout: 30,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    debug: queryCapture,
    onnotice: (notice) => activePlanNotices?.push(notice),
  });
  const db = drizzle(app, { schema });
  registerDbBinding(db, { rlsStrategy: "force" });
  const client: DbClient = { db, close: () => app.end() };
  const checks: Assertion[] = [];
  const measurements: Record<string, any>[] = [];
  const queries = new Map<string, CapturedQuery>();
  if (args.plansOnly) {
    if (args.approvedSha) {
      const prior = await Bun.file(`${args.out}/environment.json`).json();
      if (prior.approvedBackendSha !== args.approvedSha)
        throw new Error("Retained queries belong to a different backend SHA");
    }
    for (const query of (await Bun.file(`${args.out}/queries.json`).json()) as CapturedQuery[])
      queries.set(
        createHash("sha256")
          .update(query.sql + json(query.parameters))
          .digest("hex"),
        query,
      );
  }
  try {
    const [role] =
      await app`select current_user, session_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    if (!role || role.rolsuper || role.rolbypassrls || role.current_user !== "opengeni_app")
      throw new Error("Measurements require non-superuser, non-BYPASSRLS application login");
    const forceRls =
      await admin`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('sessions', 'usage_events', 'model_call_facts') order by relname`;
    if (forceRls.some((r) => !r.relrowsecurity || !r.relforcerowsecurity))
      throw new Error("Fixture FORCE RLS missing");
    const directRls = await withSessionRlsActorContext({ subjectId: fixture.actorSubjectId }, () =>
      withWorkspaceRls(
        db,
        fixture.workspaceA,
        async (scopedDb) =>
          await scopedDb.execute(sql`
        select current_user, session_user,
          count(*) filter (where visibility = 'workspace_shared')::text as "sharedVisible",
          count(*) filter (where visibility = 'user_private' and owner_subject_id = ${fixture.actorSubjectId})::text as "ownPrivateVisible",
          count(*) filter (where visibility = 'user_private' and owner_subject_id <> ${fixture.actorSubjectId})::text as "otherPrivateVisible"
        from sessions where workspace_id = ${fixture.workspaceA}`),
      ),
    );
    if (
      Number(directRls[0]?.otherPrivateVisible) !== 0 ||
      Number(directRls[0]?.ownPrivateVisible) < 1 ||
      Number(directRls[0]?.sharedVisible) < 1
    ) {
      throw new Error("Real application-role privacy fixture proof failed");
    }
    await write(args.out, "direct-rls-proof.json", directRls);
    const [pg] =
      await admin`select version(), pg_database_size(current_database())::text as database_bytes`;
    const settings =
      await admin`select name, setting, unit from pg_settings where name in ('shared_buffers','work_mem','statement_timeout','max_connections','max_parallel_workers','max_parallel_workers_per_gather','effective_cache_size','jit','track_io_timing') order by name`;
    const [appDefaults] =
      await app`select current_setting('statement_timeout') as statement_timeout,
      current_setting('work_mem') as work_mem`;
    const declaredRoleSettings = await admin`select d.datname, s.setconfig from pg_db_role_setting s
        left join pg_database d on d.oid = s.setdatabase
        where s.setrole = (select oid from pg_roles where rolname = 'opengeni_app')`;
    const definerOwners =
      await admin`select r.rolname, r.rolsuper, r.rolbypassrls, count(*)::integer as functions
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
      where p.prosecdef and n.nspname in ('public', 'opengeni_private')
      group by r.rolname, r.rolsuper, r.rolbypassrls order by r.rolname`;
    if (definerOwners.some((r) => r.rolsuper || r.rolbypassrls))
      throw new Error("An application SECURITY DEFINER still has superuser/BYPASSRLS authority");
    const functionSources =
      await admin`select p.proname, p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private' and p.proname = any(${[...BENCH_READ_FUNCTIONS]}::text[])
      order by p.proname`;
    const cgroup: Record<string, string> = {};
    for (const name of ["cpu.max", "memory.max", "memory.current"])
      cgroup[name] = await readFile(`/sys/fs/cgroup/${name}`, "utf8")
        .then((s) => s.trim())
        .catch(() => "unavailable");
    const files = [
      "packages/db/src/organization-usage.ts",
      "packages/db/src/insights-model-bundle.ts",
      "packages/db/src/insights-usage-bundle.ts",
      "packages/core/src/domain/insights.ts",
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        files.map(async (p) => [
          p,
          createHash("sha256")
            .update(await Bun.file(p).text())
            .digest("hex"),
        ]),
      ),
    );
    await write(args.out, args.plansOnly ? "plans-environment.json" : "environment.json", {
      measuredAt: new Date().toISOString(),
      backendSha: command(["git", "rev-parse", "HEAD"]),
      approvedBackendSha: args.approvedSha ?? null,
      dirty: command(["git", "status", "--short"]),
      bun: Bun.version,
      pg,
      settings,
      appDefaults,
      declaredRoleSettings,
      restrictedSettingVisibility:
        "session_preload_libraries cannot be read by the restricted app (42501); administrator records declared role settings, not an app-observed value. No pg_read_all_settings grant is added.",
      role,
      functionOwners: authFixture.evidence,
      allApplicationDefinerOwners: definerOwners,
      databaseFunctionHashes: Object.fromEntries(
        functionSources.map((r) => [
          r.signature,
          createHash("sha256").update(r.definition).digest("hex"),
        ]),
      ),
      forceRls,
      sourceHashes,
      cpu: cpus()[0]?.model,
      cpuDetails: command(["lscpu", "-J"]),
      hostLogicalCpus: cpus().length,
      availableParallelism: availableParallelism(),
      hostMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      cgroup,
      resourceVisibility:
        "CPU model and cgroup allocation limits may be unavailable; host totals are observations, not proof of an allocated memory quota.",
      cacheCondition:
        "first-observed request on retained or physically cloned ANALYZEd fixture; OS and PostgreSQL caches NOT cleared or proven cold",
      concurrency: args.concurrency,
      connectionPoolMax: 32,
      fixtureServer: { host: maintenance.hostname, port: maintenance.port },
      supportedDates: ["today", "week", "month", "ytd"],
      unsupportedDates: ["all"],
      auth: "real restricted app login + production withSessionRlsActorContext and RLS/security-definer fixtures; HTTP cookie verification not simulated",
    });
    await write(args.out, "inventory.json", await fixtureInventory(admin, fixture));

    async function measure(
      name: string,
      run: number,
      work: () => Promise<any>,
      assertions?: (r: any) => Assertion[],
    ) {
      const phases: any[] = [];
      const captured: CapturedQuery[] = [];
      const started = performance.now();
      try {
        const result = await requestStore.run({ queries: captured, phases }, () =>
          withSessionRlsActorContext({ subjectId: fixture.actorSubjectId }, work),
        );
        const durationMs = performance.now() - started;
        const row = {
          name,
          run,
          durationMs,
          outcome: "completed",
          phases,
          firstObserved: run === 0,
        };
        measurements.push(row);
        if (run === 0) {
          await write(args.out, `${name}.response.json`, result);
          const evaluated = assertions?.(result) ?? [];
          checks.push(...evaluated.map((a) => ({ ...a, name: `${name}: ${a.name}` })));
          for (const q of captured)
            queries.set(
              createHash("sha256")
                .update(q.sql + json(q.parameters))
                .digest("hex"),
              q,
            );
          await write(args.out, "queries.json", [...queries.values()]);
        }
        console.log(json(row));
        return result;
      } catch (error) {
        const row = {
          name,
          run,
          durationMs: performance.now() - started,
          outcome: "failed",
          error: safeError(error),
        };
        measurements.push(row);
        console.log(json(row));
        for (const q of captured)
          queries.set(
            createHash("sha256")
              .update(q.sql + json(q.parameters))
              .digest("hex"),
            q,
          );
        return null;
      } finally {
        await write(args.out, "measurements.json", measurements);
        await write(args.out, "assertions.json", checks);
      }
    }
    const workspace = (
      range: GetWorkspaceInsightsInput["range"],
      filters: Partial<GetWorkspaceInsightsInput> = {},
    ) =>
      getWorkspaceInsights(
        db,
        testSettings({ sandboxSelfhostedEnabled: false }),
        {
          workspaceId: fixture.workspaceA,
          range,
          now: NOW,
          ...filters,
        },
        (observation) => requestStore.getStore()?.phases.push(observation),
      );
    if (!args.plansOnly) {
      for (const period of ["today", "week", "month", "ytd"] as const) {
        for (let run = 0; run < args.runs; run++) {
          const ledger = await measure(
            `org-ledger-${period}`,
            run,
            () => getOrganizationUsageSummary(db, { accountId: fixture.accountId, period }, NOW),
            (r) => assertOrganizationLedger(r, fixture, period),
          );
          if (run === 0 && ledger?.nextWorkspaceCursor)
            await measure(`org-ledger-page-${period}`, run, () =>
              getOrganizationUsageWorkspacePage(db, {
                accountId: fixture.accountId,
                period,
                until: NOW.toISOString(),
                afterWorkspaceId: ledger.nextWorkspaceCursor,
              }),
            );
          await measure(
            `org-models-${period}`,
            run,
            () => getOrganizationModelUsage(db, { accountId: fixture.accountId, period }, NOW),
            (r) => assertOrganizationModels(r, fixture, period),
          );
          await measure(
            `workspace-${period}-all`,
            run,
            () => workspace(period),
            (r) => assertWorkspace(r, fixture, period),
          );
        }
      }
      for (const scopedPeriod of ["today", "week", "month", "ytd"] as const) {
        for (const scope of [
          {
            name: "provider",
            input: { provider: "codex-subscription" },
            oracle: { provider: "codex-subscription" },
          },
          { name: "model", input: { model: "bench-model-2" }, oracle: { model: "bench-model-2" } },
          {
            name: "provider-model",
            input: { provider: "codex-subscription", model: "bench-model-2" },
            oracle: { provider: "codex-subscription", model: "bench-model-2" },
          },
          {
            name: "root",
            input: { rootSessionId: fixtureId("session", 8) },
            oracle: { rootSessionId: fixtureId("session", 8) },
          },
          {
            name: "session",
            input: { sessionId: fixtureId("session", 9) },
            oracle: { sessionId: fixtureId("session", 9) },
          },
          {
            name: "root-hidden-descendant",
            input: { rootSessionId: fixtureId("session", 264) },
            oracle: { rootSessionId: fixtureId("session", 264) },
          },
          {
            name: "hidden-session",
            input: { sessionId: fixtureId("session", 266) },
            oracle: { sessionId: fixtureId("session", 266), visibleOnly: true },
          },
        ])
          for (let run = 0; run < args.runs; run++)
            await measure(
              `workspace-${scopedPeriod}-${scope.name}`,
              run,
              () => workspace(scopedPeriod, scope.input),
              (r) => assertWorkspace(r, fixture, scopedPeriod, scope.oracle as OracleFilter),
            );
      }

      const concurrencyStarted = performance.now();
      await Promise.all(
        Array.from({ length: args.concurrency }, (_, i) =>
          measure(`concurrent-${i}`, 0, () =>
            i % 3 === 0
              ? getOrganizationUsageSummary(
                  db,
                  { accountId: fixture.accountId, period: "ytd" },
                  NOW,
                )
              : i % 3 === 1
                ? getOrganizationModelUsage(
                    db,
                    { accountId: fixture.accountId, period: "ytd" },
                    NOW,
                  )
                : workspace("ytd"),
          ),
        ),
      );
      await write(args.out, "concurrency.json", {
        readRequests: args.concurrency,
        wallMs: performance.now() - concurrencyStarted,
        requests: measurements.filter((r) => r.name.startsWith("concurrent-")),
        productionCoreHelperFanout: true,
      });
      await write(args.out, "queries.json", [...queries.values()]);
    }

    if (args.explain) {
      const selected = [...queries.values()].filter(
        (q) =>
          !q.parameters.includes("codex-subscription") && !q.parameters.includes("bench-model-2"),
      );
      const seen = new Set<string>();
      let index = 0;
      for (const q of selected) {
        const key = classifyInsightsSql(q.sql);
        if (!key) continue;
        if (seen.has(key)) continue;
        // Prefer year-wide captures to the inexpensive current day.
        const at = q.parameters.some((p) => p === "2026-01-01T00:00:00.000Z");
        if (!at) continue;
        seen.add(key);
        const notices: unknown[] = [];
        activePlanNotices = notices;
        try {
          const plan = await app.begin(async (tx) => {
            for (const setup of q.setup) await tx.unsafe(setup.sql, setup.parameters);
            await tx`select set_config('statement_timeout', '120s', true)`;
            for (const [name, value] of [
              ["log_min_duration", "100ms"],
              ["log_analyze", "on"],
              ["log_buffers", "on"],
              ["log_timing", "off"],
              ["log_verbose", "on"],
              ["log_settings", "on"],
              ["log_format", "json"],
              ["log_level", "notice"],
              ["log_nested_statements", "on"],
            ] as const)
              await tx`select set_config(${`auto_explain.${name}`}, ${value}, true)`;
            const before =
              await tx`select current_user, current_setting('opengeni.account_id', true) as account_id,
              current_setting('opengeni.workspace_id', true) as workspace_id, current_setting('opengeni.subject_id', true) as subject_id`;
            const explain = await tx.unsafe(
              `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) ${q.sql}`,
              q.parameters,
            );
            return { roleContext: before, explain };
          });
          await write(args.out, `explain-${index++}-${key}.json`, {
            sql: q.sql,
            parameters: q.parameters,
            setup: q.setup,
            ...plan,
            nestedPlans: notices,
            diagnosticOverrides: {
              statementTimeout: "120s",
              nestedMinimumDuration: "100ms",
              nodeTiming: false,
            },
          });
        } catch (error) {
          await write(args.out, `explain-${index++}-${key}.json`, {
            error: safeError(error),
            sql: q.sql,
            parameters: q.parameters,
            setup: q.setup,
            nestedPlans: notices,
          });
        } finally {
          activePlanNotices = null;
        }
      }
    }
    if (args.diagnosticResults) {
      const diagnosticChecks: Assertion[] = [];
      const diagnosticReads = [];
      const expectedKeys = new Set(["organization_ledger", "organization_models"]);
      for (const q of queries.values()) {
        const kind = classifyInsightsSql(q.sql);
        if (!kind || !expectedKeys.has(kind) || !q.parameters.includes("2026-01-01T00:00:00.000Z"))
          continue;
        expectedKeys.delete(kind);
        const started = performance.now();
        try {
          const rows = await app.begin(async (tx) => {
            for (const setup of q.setup) await tx.unsafe(setup.sql, setup.parameters);
            await tx`select set_config('statement_timeout', '120s', true)`;
            return await tx.unsafe(q.sql, q.parameters);
          });
          const summary = rows[0]?.summary;
          const window = organizationUsageWindow("ytd", NOW);
          const raw = { ...summary, accountId: fixture.accountId, period: "ytd", ...window };
          const result =
            kind === "organization_ledger"
              ? OrganizationUsageSummary.parse(raw)
              : OrganizationModelUsage.parse(raw);
          const evaluated =
            kind === "organization_ledger"
              ? assertOrganizationLedger(result, fixture, "ytd")
              : assertOrganizationModels(result, fixture, "ytd");
          diagnosticChecks.push(
            ...evaluated.map((row) => ({ ...row, name: `${kind}: ${row.name}` })),
          );
          await write(args.out, `diagnostic-${kind}-ytd.response.json`, result);
          diagnosticReads.push({
            kind,
            outcome: "completed",
            diagnosticDurationMs: performance.now() - started,
          });
        } catch (error) {
          diagnosticReads.push({
            kind,
            outcome: "failed",
            diagnosticDurationMs: performance.now() - started,
            error: safeError(error),
          });
        }
      }
      const diagnostic = {
        approvedBackendSha: args.approvedSha,
        appRole: role,
        timeout: "120s diagnostic only; production wrapper10s failures remain authoritative",
        replay:
          "Unmodified retained production SELECT and captured auth setup, followed by120s override; actual production response contract parser and independent oracle assertions.",
        reads: diagnosticReads,
        checks: diagnosticChecks,
        missingQueries: [...expectedKeys],
        passed: diagnosticChecks.filter((row) => row.ok).length,
        failed: diagnosticChecks.filter((row) => !row.ok).length,
      };
      await write(args.out, "diagnostic-assertions.json", diagnostic);
      if (
        diagnostic.failed ||
        expectedKeys.size ||
        diagnosticReads.some((row) => row.outcome !== "completed")
      )
        process.exitCode = 1;
      console.log(
        json({
          diagnosticReads,
          passed: diagnostic.passed,
          failed: diagnostic.failed,
          missingQueries: [...expectedKeys],
        }),
      );
    }
    if (args.baselinePath && !args.plansOnly) {
      const baseline = await Bun.file(`${args.baselinePath}/measurements.json`).json();
      const environment = await Bun.file(`${args.baselinePath}/environment.json`).json();
      await write(args.out, "comparison.json", {
        baselineBackendSha: environment.backendSha,
        approvedBackendSha: args.approvedSha ?? null,
        baselinePath: args.baselinePath,
        cacheCondition:
          "First-observed is not proven OS-cold; medians use successful like-named production requests only, never diagnostic plan timings.",
        comparisons: compareMeasurements(baseline, measurements),
      });
    }
    const completion = {
      stage: args.approvedSha
        ? "Approved corrected-backend measurement; failures/assertions are authoritative, not baseline199 failures"
        : "FIRST harness preparation only, NOT final corrected-backend verification",
      backendSha: command(["git", "rev-parse", "HEAD"]),
      approvedBackendSha: args.approvedSha ?? null,
      completedRequests: measurements.filter((r) => r.outcome === "completed").length,
      failedRequests: measurements.filter((r) => r.outcome === "failed").length,
      capturedProductionQueries: queries.size,
      plansOnly: args.plansOnly,
      assertionsPassed: checks.filter((a) => a.ok).length,
      assertionsFailed: checks.filter((a) => !a.ok).length,
      independentOracleMatched: true,
      fixtureRetained: true,
      command:
        "OPENGENI_TEST_PG_URL=<loopback-maintenance-url> bun scripts/bench-insights-postgres-2768.ts --runs=2 --explain --concurrency=4",
      args,
    };
    await write(args.out, args.plansOnly ? "plans-completion.json" : "completion.json", completion);
    console.log(json(completion));
    if ((!args.plansOnly && !completion.completedRequests) || !completion.capturedProductionQueries)
      throw new Error("Production query execution proof missing");
    if (args.strict && (completion.failedRequests || completion.assertionsFailed))
      process.exitCode = 1;
  } finally {
    await client.close();
    await admin.end();
  }
}
if (import.meta.main) await main();
