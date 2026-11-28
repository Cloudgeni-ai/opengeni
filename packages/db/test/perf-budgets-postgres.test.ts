import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  WORKSPACE_CLAUDE_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
} from "@opengeni/contracts";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { PERF_BUDGETS, perfBudgetFailure, type PerfBudgetId } from "./perf-budgets";
import { sqlParameterLiteral } from "./helpers/sql-literal";
import {
  addSessionSystemUpdateWithSourceMutation,
  appendSessionEvents,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeSelfServiceOrganizationSetup,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  effectiveSessionPolicyQuery,
  freePlanCreditEligible,
  getBillingBalance,
  getOrCreateSessionSystemUpdateOutbox,
  getScheduledTargetSessionExecution,
  getScheduledTaskPersonalResourceAuthoritySubject,
  getScheduledTaskRevisionAuthority,
  getSessionToolConfigs,
  initializeSessionStartAtomically,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  requestSessionTurnRecovery,
  settleEndedEpochWorkspaceBlockers,
  withAccountRls,
  withRlsContext,
  withSessionActivityRlsContext,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
  type Database,
  type DbClient,
} from "../src";

// The performance regression guard for the database's hot paths (see
// docs/perf-budgets.md). One production-shaped, multi-tenant fixture is seeded
// once, with set-based inserts; each hot routine or query fixed in GK rounds
// 1-13 then runs as production runs it (the restricted runtime role under
// FORCE RLS, SECURITY DEFINER bodies owned by a BYPASSRLS migration owner) and
// its EXPLAIN (ANALYZE, BUFFERS) shared buffers, hit + read, must stay within
// its committed budget in perf-budgets.ts. Buffers, not time: the same plan
// on the same rows reads the same pages on any runner, and every measuring
// connection plans with PostgreSQL's default planner settings (PINNED_PLANNER).
//
// The last tests put back the regressions these budgets exist for (#8168's
// admission body, no index 1589, no index 1579, unguarded owner definers, no
// index 1696 and the unsplit lookup) and require each budget to fail on it,
// then restore.

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
const measured = new Map<PerfBudgetId, number>();
const regressed = new Map<string, number>();

type Plan = { Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number } };
type Grant = { accountId: string; workspaceId: string; subjectId: string };
type PlanMode = "auto" | "force_generic_plan" | "force_custom_plan";
/** How production enters the database for a call: its RLS scope, if any. */
type Scope = <T>(db: Database, fn: (tx: Database) => Promise<T>) => Promise<T>;

const BOTH_PLANS: PlanMode[] = ["force_generic_plan", "force_custom_plan"];

// Fixture sizes. Production's worst cases are larger; these are large enough
// that every regression below reads several times its budget.
//
// OPENGENI_PERF_BUDGETS_SCALE (default 1) multiplies the shared sizes, for
// checking that a probe is isolated (docs/perf-budgets.md): a bounded probe
// must measure the same at scale 2. The sizes marked "own" are the data a
// probe's cost is proportional to by design (the GC claim reads every live
// checkpoint, the inventory every plan organization); they do not scale.
const SCALE = Number(process.env.OPENGENI_PERF_BUDGETS_SCALE ?? "1");
if (!(SCALE >= 1)) throw new Error("OPENGENI_PERF_BUDGETS_SCALE must be a number >= 1");
const scaled = (size: number) => Math.round(size * SCALE);
const CHAT_TURNS = scaled(2_000);
// Three short sessions' turns between each two of the chat's, as production
// interleaves a long chat's turns with everyone else's over time.
const CHAT_BACKGROUND_SESSIONS = 3 * CHAT_TURNS;
// Older turns of other short sessions of the workspace, so the chat is a
// small share of session_turns as in production. With the chat a quarter of
// the table, a custom plan scanned the whole table for its person/API turns.
const HISTORY_TURNS = scaled(90_000);
const FIRST_SEQUENCE = 1_000;
const TARGET_CHATS = 50; // own: schedule_targets_reads
const SCHEDULED_TASKS = scaled(200);
const SCHEDULED_RUNS = scaled(6_000);
const BUSY_LEDGER_ROWS = scaled(60_000);
const PLAN_ORGANIZATIONS = 1_000; // own: list_subscription_plan_maintenance_accounts
const PLAN_LEDGER_NOISE = scaled(60_000);
const CHECKPOINT_LEASES = 1_000; // own: checkpoint_gc_claim
// Recently deleted checkpoints, kept until their retention passes.
const CHECKPOINT_TOMBSTONES = 300; // own: checkpoint_gc_prune
const ATTEMPTS = scaled(11_000);
const SETTLED_REQUESTS = scaled(39_000);
const OPEN_TURN_REQUESTS = 4;
const BACKGROUND_LEASES = scaled(1_000);
const BACKGROUND_REQUESTS_PER_LEASE = 34;
const RETAINED_PROCESSES = scaled(3_000);
const BACKGROUND_COMMANDS = scaled(3_000);
const OUTBOX_GRACE_ROWS = 5_000; // own: host_export_outbox_prune (index entries of the window)
const GOALS = scaled(30_000);
const OTHER_TENANT_SESSIONS = 3_000; // own: rls_policy_heavy_read
const TERMINAL_CALLS = scaled(3_000);
const TERMINAL_FILLER_EVENTS = scaled(4_000);
// One clock reading for every plan date, so plan maintenance's due set is
// decided against one instant rather than each statement's now(); the
// measurement runs well inside the hour of margin the seed leaves.
const PLAN_ANCHOR = new Date().toISOString();

/**
 * Planner settings every measuring connection gets (docs/perf-budgets.md):
 * PostgreSQL's compiled defaults for every planner method, cost and
 * collapse setting and for work_mem, with no parallel workers and no JIT, so
 * a test cluster's tuning cannot change a plan's shape or its buffers.
 */
const PINNED_PLANNER = `
  select name, case name
      when 'jit' then 'off'
      when 'max_parallel_workers_per_gather' then '0'
      else boot_val end as value
  from pg_settings
  where context = 'user'
    and (category like 'Query Tuning%'
      or name in ('work_mem', 'hash_mem_multiplier', 'max_parallel_workers_per_gather'))
  order by name`;

const fixture = {} as {
  chat: Grant & { sessionId: string; task: Awaited<ReturnType<typeof createScheduledTask>> };
  targetChatIds: string[];
  busyOrganization: string;
  noTrialOrganization: string;
  sandbox: Grant & {
    tuple: Parameters<typeof settleEndedEpochWorkspaceBlockers>[1];
    turnOwner: string;
    processOwner: string;
  };
  idleGoalSession: string;
  reader: Grant;
  otherTenant: Grant;
  wake: { parent: string; stranded: string };
  terminal: Grant & { sessionId: string; turnId: string };
};

const FIXTURES: Record<PerfBudgetId, string> = {
  scheduled_admission: `one chat with ${CHAT_TURNS} scheduled turns after a settings write, interleaved with ${CHAT_BACKGROUND_SESSIONS} short sessions' turns after ${HISTORY_TURNS} older ones, ${SCHEDULED_TASKS} tasks and ${SCHEDULED_RUNS} runs`,
  effective_model_read: `the same chat: ${CHAT_TURNS} scheduled turns after a settings write, among ${CHAT_BACKGROUND_SESSIONS + HISTORY_TURNS} other turns`,
  schedule_targets_reads: `${TARGET_CHATS} target chats of ${SCHEDULED_TASKS} schedules`,
  schedule_targets_statements: `${TARGET_CHATS} target chats of ${SCHEDULED_TASKS} schedules`,
  credit_balance_read: `an organization with ${BUSY_LEDGER_ROWS} usage debits`,
  read_organization_plan_balance: `an organization with ${BUSY_LEDGER_ROWS} usage debits`,
  list_subscription_plan_maintenance_accounts: `${PLAN_ORGANIZATIONS} plan organizations, ${PLAN_LEDGER_NOISE} ledger rows, steady state (only the fixture bootstrap organizations are due)`,
  free_plan_credit_eligible: `two organizations with ${BUSY_LEDGER_ROWS} usage debits each, one without its trial grant`,
  checkpoint_gc_claim: `${CHECKPOINT_LEASES} leases, each with a current and a previous checkpoint, nothing due`,
  checkpoint_gc_prune: `${CHECKPOINT_LEASES} leases with checkpoints and recent tombstones, nothing due`,
  host_export_outbox_prune: `${OUTBOX_GRACE_ROWS} delivered outbox rows inside their grace window`,
  hands_back_active_goal: `${GOALS} goals across 300 workspaces, the session has none active`,
  rls_owner_definer_calls: `a reader workspace beside ${OTHER_TENANT_SESSIONS} sessions of another tenant`,
  rls_policy_heavy_read: `a reader workspace beside ${OTHER_TENANT_SESSIONS} sessions of another tenant`,
  terminal_usage_insert: `a turn with ${TERMINAL_CALLS} model calls in a session with ${TERMINAL_FILLER_EVENTS} more events`,
  editable_artifact_schema_resolver: "the migrated data schema",
  wake_inventory_child_terminal:
    "an idle parent with a delivered child result among the fixture's sessions",
  wake_inventory_quiescence: "a recovering session without its quiescence receipt",
  lost_provider_session_lookup: `a lease with ${SETTLED_REQUESTS} settled requests in a workspace of ${ATTEMPTS} attempts, ${BACKGROUND_LEASES} other leases`,
};

// Measure and print every probe without failing on budgets (docs/perf-budgets.md).
const REPORT_ONLY = process.env.OPENGENI_PERF_BUDGETS_REPORT === "1";

function within(id: PerfBudgetId, value: number) {
  measured.set(id, Math.max(measured.get(id) ?? 0, value));
  const entry = PERF_BUDGETS[id];
  console.info(
    "perf-budget",
    JSON.stringify({ id, unit: entry.unit, measured: value, budget: entry.budget }),
  );
  if (value > entry.budget && !REPORT_ONLY) {
    throw new Error(perfBudgetFailure(id, value, FIXTURES[id]));
  }
}

/** A regression must read more than the budget it is guarded by. */
function caught(id: PerfBudgetId, regression: string, value: number) {
  regressed.set(`${id}: ${regression}`, value);
  const entry = PERF_BUDGETS[id];
  console.info(
    "perf-budget-regression",
    JSON.stringify({ id, regression, measured: value, budget: entry.budget }),
  );
  if (REPORT_ONLY) return;
  expect({ id, regression, exceedsBudget: value > entry.budget }).toEqual({
    id,
    regression,
    exceedsBudget: true,
  });
}

beforeAll(async () => {
  const started = performance.now();
  const acquired = await acquireRestrictedRuntimeTestDatabase("perf-budgets", "perf_budget_data");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  // Count the runtime role's function calls for the owner-definer budget.
  const [database] = await shared.admin<{ name: string }[]>`select current_database() as name`;
  await shared.admin.unsafe(
    `alter role opengeni_app in database "${database!.name}" set track_functions = 'all'`,
  );
  // Pin the planner for every connection opened from here on.
  const planner = await shared.admin.unsafe<{ name: string; value: string }[]>(PINNED_PLANNER);
  for (const setting of planner) {
    await shared.admin.unsafe(
      `alter database "${database!.name}" set ${setting.name} = '${setting.value.replaceAll("'", "''")}'`,
    );
  }
  client = createDb(shared.appUrl, { max: 2, searchPath: shared.schema });
  // Production's migration owner bypasses row security; its triggers and
  // SECURITY DEFINER routines run that way while seeding and measuring.
  await shared.admin.unsafe(`alter role "${shared.ownerRole}" bypassrls`);
  const migrated = performance.now();

  const seedMs: Record<string, number> = {};
  for (const [name, seed] of [
    ["scheduledChat", seedScheduledChat],
    ["ledgers", seedLedgers],
    ["sandbox", seedSandbox],
    ["outboxAndGoals", seedOutboxAndGoals],
    ["otherTenant", seedOtherTenant],
    ["wakeRepairs", seedWakeRepairs],
    ["terminalTurn", seedTerminalTurn],
    ["vacuumAnalyze", vacuumAnalyze],
  ] as const) {
    const stepStarted = performance.now();
    await seed();
    seedMs[name] = Math.round(performance.now() - stepStarted);
  }
  console.info(
    "perf-budget-fixture",
    JSON.stringify({
      scale: SCALE,
      pinnedPlannerSettings: planner.length,
      migrateMs: Math.round(migrated - started),
      seedMs: Math.round(performance.now() - migrated),
      steps: seedMs,
    }),
  );
}, 900_000);

afterAll(async () => {
  if (measured.size > 0) {
    console.info(
      "perf-budget-summary",
      JSON.stringify(
        Object.fromEntries(
          [...measured].map(([id, value]) => [
            id,
            { measured: value, budget: PERF_BUDGETS[id].budget },
          ]),
        ),
      ),
    );
  }
  if (regressed.size > 0) {
    console.info("perf-budget-regression-summary", JSON.stringify(Object.fromEntries(regressed)));
  }
  await shared?.admin.unsafe(`alter role "${shared.ownerRole}" nobypassrls`).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 180_000);

// ---------------------------------------------------------------------------
// Measurement

class Measured extends Error {
  constructor(readonly value: number) {
    super("measured");
  }
}

function planBuffers(rows: unknown): number {
  const plan = (rows as { "QUERY PLAN": Plan[] }[])[0]!["QUERY PLAN"][0]!.Plan;
  return plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
}

const unscoped: Scope = (db, fn) => db.transaction((tx) => fn(tx as unknown as Database));
const workspaceScope =
  (workspaceId: string): Scope =>
  (db, fn) =>
    withWorkspaceRls(db, workspaceId, fn);
const subjectScope =
  (grant: Grant): Scope =>
  (db, fn) =>
    withWorkspaceSubjectRls(db, grant.workspaceId, grant.subjectId, fn);
const accountScope =
  (accountId: string): Scope =>
  (db, fn) =>
    withAccountRls(db, accountId, fn);

type Statement = { text: string; prepare?: { sql: string; params: unknown[] } };

/** One EXPLAIN (ANALYZE, BUFFERS) in the scope, optionally rolled back. */
async function explainOnce(
  db: Database,
  scope: Scope,
  statement: Statement,
  mode: PlanMode,
  rollback: boolean,
): Promise<number> {
  try {
    return await scope(db, async (tx) => {
      if (mode !== "auto") await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
      let text = statement.text;
      if (statement.prepare) {
        await tx.execute(sql.raw(`prepare perf_budget_statement as ${statement.prepare.sql}`));
        text = `execute perf_budget_statement(${statement.prepare.params.map(sqlParameterLiteral).join(", ")})`;
      }
      const value = planBuffers(
        await tx.execute(sql.raw(`explain (analyze, buffers, timing off, format json) ${text}`)),
      );
      if (statement.prepare) await tx.execute(sql.raw("deallocate perf_budget_statement"));
      if (rollback) throw new Measured(value);
      return value;
    });
  } catch (error) {
    if (error instanceof Measured) return error.value;
    throw error;
  }
}

/**
 * The most buffers one of a fresh runtime connection's 2nd to 6th calls reads,
 * for each plan mode. The first call loads the connection's caches; PL/pgSQL
 * plans a statement afresh for each of the first five calls unless it reuses
 * one plan, so a routine that replans every call is measured with that cost.
 */
async function steadyBuffers(
  scope: Scope,
  statement: string | Statement | ((call: number) => string),
  options: { modes?: PlanMode[]; calls?: number; rollback?: boolean } = {},
): Promise<number> {
  let most = 0;
  for (const mode of options.modes ?? ["auto"]) {
    const fresh = createDb(shared.appUrl, { max: 1, searchPath: shared.schema });
    try {
      for (let call = 1; call <= (options.calls ?? 6); call += 1) {
        const current =
          typeof statement === "function"
            ? { text: statement(call) }
            : typeof statement === "string"
              ? { text: statement }
              : statement;
        const value = await explainOnce(fresh.db, scope, current, mode, options.rollback ?? false);
        if (call > 1) most = Math.max(most, value);
      }
    } finally {
      await fresh.close();
    }
  }
  return most;
}

/** The same, on a connection of the BYPASSRLS migration owner. */
async function ownerSteadyBuffers(statement: string): Promise<number> {
  const owner = postgres(shared.ownerUrl, {
    max: 1,
    onnotice: () => undefined,
    connection: { search_path: shared.schema },
  });
  try {
    let most = 0;
    for (let call = 1; call <= 6; call += 1) {
      const value = planBuffers(
        await owner.unsafe(`explain (analyze, buffers, timing off, format json) ${statement}`),
      );
      if (call > 1) most = Math.max(most, value);
    }
    return most;
  } finally {
    await owner.end();
  }
}

type Captured = { query: string; parameters: unknown[] };

/** The statements one application call sends, as the driver sends them. */
async function capture(run: () => Promise<unknown>, keep: (query: string) => boolean) {
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const debug = driver.options.debug;
  const statements: Captured[] = [];
  driver.options.debug = (_connection, query, parameters) => {
    if (keep(query)) statements.push({ query, parameters: [...(parameters as unknown[])] });
  };
  try {
    await run();
  } finally {
    driver.options.debug = debug;
  }
  return statements;
}

/** Application reads, not the scope's own setup (GUCs, fences, transaction control). */
const applicationRead = (query: string) =>
  /^\s*(select|with)\b/i.test(query) &&
  !/set_config|pg_advisory|pg_try_advisory|opengeni_private\.open_session_tenancy/i.test(query);

/** Buffers of a captured statement under both plan modes, prepared with its parameters. */
async function capturedBuffers(scope: Scope, statement: Captured): Promise<number> {
  return await steadyBuffers(
    scope,
    { text: "", prepare: { sql: statement.query, params: statement.parameters } },
    { modes: BOTH_PLANS, calls: 2 },
  );
}

/** A connection of the migration owner, for the regressions it puts back. */
async function asOwner<T>(fn: (owner: postgres.Sql) => Promise<T>): Promise<T> {
  const owner = postgres(shared.ownerUrl, {
    max: 1,
    onnotice: () => undefined,
    connection: { search_path: shared.schema },
  });
  try {
    return await fn(owner);
  } finally {
    await owner.end();
  }
}

// ---------------------------------------------------------------------------
// Fixture

/** Statistics at the pinned default_statistics_target. */
async function vacuumAnalyze() {
  const connection = await shared.admin.reserve();
  try {
    await connection`select set_config('default_statistics_target', '100', false)`;
    await connection`vacuum analyze`;
  } finally {
    connection.release();
  }
}

async function workspace(label: string): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "perf-budgets",
    accountExternalId: `${label}-${suffix}`,
    accountName: label,
    workspaceExternalSource: "perf-budgets",
    workspaceExternalId: `${label}-${suffix}`,
    workspaceName: label,
    subjectId: `perf-${label}-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

async function session(grant: Grant, initialMessage = "") {
  return await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage,
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
    model: "stored-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
}

/** A self-serve organization with its verified signup trial receipt. */
async function organization() {
  const userId = crypto.randomUUID();
  await shared.admin`insert into auth_users(id, name, email, email_verified)
    values (${userId}, 'Owner', ${`${userId}@example.test`}, true)`;
  const { organizationId } = await completeSelfServiceOrganizationSetup(client.db, {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Perf budget organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "c".repeat(64),
    trialCreditsEnabled: true,
    trialCreditModelIds: ["model-a"],
  });
  return organizationId;
}

/**
 * A chat a schedule keeps running (#8168's production shape): a settings
 * write, then thousands of scheduled turns, each queued and started, beside
 * many short sessions; a schedule-heavy workspace of tasks, runs and target
 * chats.
 */
async function seedScheduledChat() {
  const grant = await workspace("scheduled-chat");
  const chat = await session(grant);
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: "Check this chat",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `perf-budget-${crypto.randomUUID()}`,
    runMode: "existing_session",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "Check for updates", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    targetSessionId: chat.id,
    metadata: {},
  });
  fixture.chat = { ...grant, sessionId: chat.id, task };
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
      values (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${chat.id}::uuid,
        ${FIRST_SEQUENCE - 10}, 'session.model_settings.updated', '{}'::jsonb)`;
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) select gen_random_uuid(), ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
        md5('perf-history-' || n / 3)::uuid, gen_random_uuid(), 'history', 'completed',
        case when n % 5 = 0 then 'api' else 'user' end, 1 + n % 3, 'turn', 'history-model',
        'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        now() - interval '30 days', now() - interval '30 days'
      from generate_series(1, ${HISTORY_TURNS}) n`;
    // The chat's scheduled turns interleaved with the short sessions' turns
    // (most sessions of a workspace are short: production-like statistics),
    // so a read of every turn of the chat touches most of the table's pages,
    // as it does in production.
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) select gen_random_uuid(), ${grant.accountId}::uuid, ${grant.workspaceId}::uuid,
        case when chat_turn then ${chat.id}::uuid else gen_random_uuid() end, gen_random_uuid(),
        case when chat_turn then ${`session-${chat.id}`} else 'background' end, 'completed',
        case when chat_turn then 'scheduled_task' else 'user' end,
        case when chat_turn then n / 4 else 1 end, 'turn',
        case when chat_turn then 'automated-model' else 'background-model' end, 'medium',
        'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now()
      from generate_series(1, ${CHAT_TURNS + CHAT_BACKGROUND_SESSIONS}) n,
        lateral (select n % 4 = 0 as chat_turn) kind`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select turn.account_id, turn.workspace_id, turn.session_id, turn.id,
        ${FIRST_SEQUENCE} + turn.position * 2 + step.offset_value,
        case when step.offset_value = 0 then 'turn.queued' else 'turn.started' end, '{}'::jsonb
      from session_turns turn cross join (values (0), (1)) step(offset_value)
      where turn.workspace_id = ${grant.workspaceId}::uuid and turn.session_id = ${chat.id}::uuid`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select turn.account_id, turn.workspace_id, turn.session_id, turn.id, step.offset_value,
        case when step.offset_value = 1 then 'turn.queued' else 'turn.started' end, '{}'::jsonb
      from session_turns turn cross join (values (1), (2)) step(offset_value)
      where turn.workspace_id = ${grant.workspaceId}::uuid and turn.temporal_workflow_id = 'background'`;
    // Target chats: copies of the chat's row with their own ids.
    const targets = await tx<{ id: string }[]>`
      insert into sessions
      select clone.* from sessions s
      cross join (select gen_random_uuid() as id from generate_series(1, ${TARGET_CHATS})) seed
      cross join lateral jsonb_populate_record(null::sessions, to_jsonb(s)
        || jsonb_build_object('id', seed.id, 'root_session_id', seed.id, 'create_idempotency_key', null)) clone
      where s.id = ${chat.id}::uuid
      returning id::text`;
    fixture.targetChatIds = [chat.id, ...targets.map((row) => row.id)];
    // Many schedules on those chats, and their run history.
    await tx`
      insert into scheduled_tasks
      select clone.* from scheduled_tasks t
      cross join generate_series(1, ${SCHEDULED_TASKS - 1}) n
      cross join lateral jsonb_populate_record(null::scheduled_tasks, to_jsonb(t)
        || jsonb_build_object('id', gen_random_uuid(), 'temporal_schedule_id', t.temporal_schedule_id || '-' || n,
          'target_session_id', (${fixture.targetChatIds}::uuid[])[1 + n % ${fixture.targetChatIds.length}])) clone
      where t.id = ${task.id}::uuid`;
    await tx`
      insert into scheduled_task_runs (task_id, trigger_type, account_id, workspace_id, status, created_at)
      select task.id, 'scheduled', task.account_id, task.workspace_id, 'succeeded',
        now() - n * interval '10 minutes'
      from (select id, account_id, workspace_id, row_number() over (order by id) as i
        from scheduled_tasks where workspace_id = ${grant.workspaceId}::uuid) task
      join generate_series(1, ${SCHEDULED_RUNS}) n on n % ${SCHEDULED_TASKS} = task.i - 1`;
  });
}

/** A busy organization's ledger (triggers on, so its totals are kept), one without its trial, and many plan organizations. */
async function seedLedgers() {
  const busy = await organization();
  const noTrial = await organization();
  fixture.busyOrganization = busy;
  fixture.noTrialOrganization = noTrial;
  await shared.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${busy}, true)`;
    await tx`
      insert into credit_ledger_entries (account_id, type, amount_micros, source_type, source_id,
        usage_origin, idempotency_key, metadata, occurred_at, created_at)
      select ${busy}::uuid, 'model_usage_debit', -1000 - n % 7, 'model_response', 'resp_' || n,
        case when n % 3 = 0 then 'api' else 'app' end, 'debit:' || ${busy}::text || ':' || n,
        jsonb_build_object('model', 'model-a', 'inputTokens', n),
        now() - n * interval '1 minute', now() - n * interval '1 minute'
      from generate_series(1, ${BUSY_LEDGER_ROWS}) n`;
  });
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from credit_ledger_entries
      where account_id = ${noTrial} and source_type = 'verified_signup_trial'`;
    await tx`
      insert into credit_ledger_entries (account_id, type, amount_micros, source_type,
        source_id, idempotency_key, metadata, occurred_at, created_at)
      select ${noTrial}::uuid, 'model_usage_debit', -1000 - n % 7, 'model_response',
        'resp_' || n, 'debit:' || ${noTrial}::text || ':' || n,
        jsonb_build_object('model', 'model-a', 'inputTokens', n),
        now() - n * interval '1 minute', now() - n * interval '1 minute'
      from generate_series(1, ${BUSY_LEDGER_ROWS}) n`;
    // Plan organizations in their steady state (1578's fixture): Free with a
    // trial and this anniversary's receipt, some without a trial, some Pro.
    await tx`
      insert into auth_users (id, name, email, email_verified, created_at)
      select 'plan-owner-' || i, 'Owner ' || i, 'plan-owner-' || i || '@example.test', true,
        ${PLAN_ANCHOR}::timestamptz - (i * interval '7 hours')
      from generate_series(1, ${PLAN_ORGANIZATIONS}) i`;
    await tx`
      insert into managed_accounts (name, created_at)
      select 'plan-org-' || i, ${PLAN_ANCHOR}::timestamptz - ((i * 7) % 900) * interval '1 day' - interval '3 hours'
      from generate_series(1, ${PLAN_ORGANIZATIONS}) i`;
    await tx`
      create temp table plan_orgs on commit drop as
      select account.id, row_number() over (order by account.name) as i, account.created_at
      from managed_accounts account where account.name like 'plan-org-%'`;
    await tx`
      insert into organization_plans (account_id, plan_key, status, stripe_subscription_id,
        current_period_start, current_period_end)
      select id, case when i % 20 = 0 then 'pro' else 'free' end, 'active',
        case when i % 20 = 0 then 'sub_' || i end,
        case when i % 20 = 0 then ${PLAN_ANCHOR}::timestamptz - interval '10 days' end,
        case when i % 20 = 0 then ${PLAN_ANCHOR}::timestamptz + interval '20 days' end
      from plan_orgs`;
    await tx`
      insert into credit_ledger_entries (account_id, type, amount_micros, source_type, source_id, idempotency_key)
      select id, 'grant', 10000000, 'verified_signup_trial', 'plan-owner-' || i,
        'verified-signup-trial:v1:plan-owner-' || i
      from plan_orgs where i % 10 <> 9`;
    await tx`
      insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
      select org.id, 'model_usage_debit', -1 - (n % 1000), 'app', 'plan-noise-' || n
      from generate_series(1, ${PLAN_LEDGER_NOISE}) n
      join plan_orgs org on org.i = 1 + (n % ${PLAN_ORGANIZATIONS})`;
    await tx`
      insert into credit_ledger_entries (id, account_id, type, amount_micros, idempotency_key)
      select gen_random_uuid(), id, 'plan_credit_grant', 1000000, 'plan-grant-' || id
      from plan_orgs where i % 10 <> 9 and i % 20 <> 0`;
    await tx`
      insert into plan_credit_periods (account_id, plan_key, catalog_revision, period_start, period_end,
        granted_micros, opening_debt_micros, grant_entry_id, idempotency_key,
        expired_at, expiry_entry_id, usage_at_expiry_micros)
      select org.id, 'free',
        (select min(revision) from opengeni_private.subscription_plan_catalog_revisions),
        anniversary.period_start, anniversary.period_end, 1000000, 0, grant_entry.id,
        'plan-credit:free:' || org.id::text || ':' || to_char(anniversary.period_start at time zone 'UTC', 'YYYY-MM'),
        case when org.i % 10 < 3 then ${PLAN_ANCHOR}::timestamptz - interval '1 minute' end,
        case when org.i % 10 < 3 then grant_entry.id end,
        case when org.i % 10 < 3 then 0 end
      from plan_orgs org
      cross join lateral opengeni_private.subscription_plan_free_anniversary(org.created_at,
        greatest(org.created_at, ${PLAN_ANCHOR}::timestamptz)) anniversary
      join credit_ledger_entries grant_entry on grant_entry.idempotency_key = 'plan-grant-' || org.id
      where anniversary.period_end > ${PLAN_ANCHOR}::timestamptz + interval '1 hour'`;
  });
}

/**
 * One sandbox tenant: leases with current and previous checkpoints, a lost box
 * with open and settled requests among many attempts (#8243's production
 * shape), retained processes and background commands, and other tenants'
 * leases beside it.
 */
async function seedSandbox() {
  const grant = await workspace("sandbox");
  const { accountId, workspaceId } = grant;
  const turnOwner = await session(grant, "turn owner");
  const processOwner = await session(grant, "process owner");
  const history = await session(grant, "history");
  const tuple = {
    accountId,
    workspaceId,
    leaseId: crypto.randomUUID(),
    sandboxGroupId: crypto.randomUUID(),
    lostEpoch: 79,
    lostBackend: "modal",
    lostInstanceId: `sb-${crypto.randomUUID()}`,
  };
  fixture.sandbox = { ...grant, tuple, turnOwner: turnOwner.id, processOwner: processOwner.id };
  const ownerAttemptIds = Array.from({ length: OPEN_TURN_REQUESTS }, () => crypto.randomUUID());
  const processAttemptId = crypto.randomUUID();
  const processId = crypto.randomUUID();

  // Leases with their checkpoints, triggers on: GC reads the lease projection
  // those triggers keep.
  await shared.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
    await tx`
      create temp table checkpoint_seed on commit drop as
      with leases as (
        select n, gen_random_uuid() as lease_id, gen_random_uuid() as group_id
        from generate_series(1, ${CHECKPOINT_LEASES}) n
      ), artifacts as (
        select lease.*, kind.state, gen_random_uuid() as artifact_id
        from leases lease cross join (values ('current'), ('previous'), ('deleted')) kind(state)
        where kind.state <> 'deleted' or lease.n <= ${CHECKPOINT_TOMBSTONES}
      ), archives as (
        select artifact.*, convert_to('MODAL_SANDBOX_FS_SNAPSHOT_V1' || chr(10) ||
          '{"snapshot_id":"im-' || artifact.artifact_id || '","workspace_persistence":"snapshot_filesystem"}',
          'UTF8') as bytes
        from artifacts artifact
      )
      select archive.*, replace(encode(bytes, 'base64'), chr(10), '') as archive_base64,
        encode(sha256(bytes), 'hex') as archive_sha256, length(bytes) as archive_bytes
      from archives archive`;
    await tx`
      insert into sandbox_checkpoint_artifacts
        (id, account_id, workspace_id, sandbox_group_id, source_lease_id, source_lease_epoch,
         source_instance_id, source_workspace_generation, provenance, provider_backend,
         provider_binding_key, provider_binding, object_kind, object_id, archive_base64,
         archive_sha256, archive_bytes, descriptor, descriptor_revision, state, created_at,
         deleted_at)
      select artifact_id, ${accountId}::uuid, ${workspaceId}::uuid, group_id, lease_id, 1, null, null,
        'legacy_provider_adopted', 'modal', binding.value, binding.value::jsonb,
        'modal_filesystem_snapshot', 'im-' || artifact_id, archive_base64, archive_sha256,
        archive_bytes,
        jsonb_build_object('version', 2, 'kind', 'provider_snapshot',
          'revision', 'wa2:1:' || archive_sha256, 'archiveSha256', archive_sha256,
          'archiveBytes', archive_bytes, 'snapshotId', 'im-' || artifact_id,
          'provider', 'modal_snapshot_filesystem', 'workspacePersistence', 'snapshot_filesystem'),
        'wa2:1:' || archive_sha256, state, '2000-01-01T00:00:00Z',
        case when state = 'deleted' then now() end
      from checkpoint_seed
      cross join (values ('{"version":1,"serverUrl":"https://api.modal.com","workspaceName":"fixture","environment":"test"}')) binding(value)`;
    await tx`
      insert into sandbox_leases (id, account_id, workspace_id, sandbox_group_id, liveness,
        refcount, turn_holders, viewer_holders, instance_id, backend, lease_epoch,
        workspace_generation, archive_generation, resume_backend_id, resume_state, expires_at,
        current_checkpoint_artifact_id, previous_checkpoint_artifact_id)
      select current.lease_id, ${accountId}::uuid, ${workspaceId}::uuid, current.group_id, 'warm',
        0, 0, 0, 'box', 'modal', 1, 2, 2, 'modal',
        jsonb_build_object('backendId', 'modal', 'sessionState', jsonb_build_object(
          'providerState', jsonb_build_object('sandboxId', 'box'),
          'workspaceArchive', current.archive_base64,
          'workspaceArchiveMeta', artifact_current.descriptor,
          'workspaceArchivePrev', previous.archive_base64,
          'workspaceArchivePrevMeta', artifact_previous.descriptor)),
        '2100-01-01T00:00:00Z', current.artifact_id, previous.artifact_id
      from checkpoint_seed current
      join checkpoint_seed previous on previous.lease_id = current.lease_id and previous.state = 'previous'
      join sandbox_checkpoint_artifacts artifact_current on artifact_current.id = current.artifact_id
      join sandbox_checkpoint_artifacts artifact_previous on artifact_previous.id = previous.artifact_id
      where current.state = 'current'`;
    await tx.unsafe("set constraints all immediate");
  });

  // The lost box (writer triggers and foreign keys off, as its test seeds it).
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const attempts = (sessionId: string, ids: string[] | null, count = 0) => tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies, authority_epoch, authority_visibility,
        state, outcome, closed_at, quiesced_at
      ) select attempt_id, ${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid,
        gen_random_uuid(), 1, ${`session-${sessionId}`}, attempt_id::text, 'attempt', 0,
        '[]'::jsonb, 1, 'workspace_shared', 'closed', 'completed', now(), null
      from (
        select unnest(${ids ?? []}::uuid[]) as attempt_id
        union all select gen_random_uuid() from generate_series(1, ${count})
      ) ids`;
    await attempts(history.id, null, ATTEMPTS);
    await attempts(turnOwner.id, ownerAttemptIds);
    await attempts(processOwner.id, [processAttemptId]);
    const process = (
      id: string | null,
      sessionId: string,
      leaseId: string,
      epoch: number,
      count: number,
    ) => tx`
      insert into sandbox_retained_processes (
        id, account_id, workspace_id, session_id, lease_id, sandbox_group_id,
        parent_admission_id, holder_id, owner_actor_kind, owner_actor_id, owner_turn_id,
        owner_attempt_id, owner_execution_generation, lease_epoch, provider_backend,
        provider_instance_id, route_kind, route_epoch, provider_session_id, state
      ) select coalesce(${id}::uuid, gen_random_uuid()), ${accountId}::uuid, ${workspaceId}::uuid,
        ${sessionId}::uuid, ${leaseId}::uuid, ${tuple.sandboxGroupId}::uuid,
        gen_random_uuid(), 'process-holder-' || n, 'turn', ${processAttemptId}::uuid,
        gen_random_uuid(), ${processAttemptId}::uuid, 1, ${epoch}, 'modal',
        'sb-older', 'home', 0, n, 'active'
      from generate_series(1, ${count}) n`;
    // The process the open request names, now on an older box of the lease.
    await process(processId, processOwner.id, tuple.leaseId, tuple.lostEpoch - 1, 1);
    // Processes of other leases of the workspace.
    await process(null, history.id, crypto.randomUUID(), 1, RETAINED_PROCESSES);
    await tx`
      insert into session_background_commands (account_id, workspace_id, session_id, provider,
        retained_process_id, state, settled_at, settlement_reason)
      select ${accountId}::uuid, ${workspaceId}::uuid, ${history.id}::uuid, 'managed',
        process.id, case when n % 3 = 0 then 'running' else 'exited' end,
        case when n % 3 <> 0 then now() end, case when n % 3 <> 0 then 'exited' end
      from (select id, row_number() over (order by id) as n from sandbox_retained_processes
        where workspace_id = ${workspaceId}::uuid and session_id = ${history.id}::uuid
        limit ${BACKGROUND_COMMANDS}) process`;
    const requests = (input: {
      sessionId: string;
      count: number;
      from: number;
      settled: boolean;
      attemptIds?: string[];
      processId?: string;
    }) => tx`
      insert into sandbox_workspace_mutation_admissions (
        account_id, workspace_id, lease_id, sandbox_group_id, session_id, actor_kind, actor_id,
        turn_id, attempt_id, execution_generation, holder_kind, holder_id, lease_epoch,
        provider_backend, provider_instance_id, route_kind, route_epoch, workspace_generation,
        operation, provider_outcome, settled_at
      ) select ${accountId}::uuid, ${workspaceId}::uuid, ${tuple.leaseId}::uuid,
        ${tuple.sandboxGroupId}::uuid, ${input.sessionId}::uuid,
        case when ${input.processId ?? null}::uuid is null then 'turn' else 'process' end,
        coalesce(${input.processId ?? null}::uuid, attempt_id),
        case when ${input.processId ?? null}::uuid is null then gen_random_uuid() end,
        case when ${input.processId ?? null}::uuid is null then attempt_id end,
        case when ${input.processId ?? null}::uuid is null then 1 end,
        case when ${input.processId ?? null}::uuid is null then 'turn' else 'process' end,
        'holder', ${tuple.lostEpoch}, 'modal', ${tuple.lostInstanceId}, 'home', 0,
        ${input.from} + ordinality::integer, 'write',
        case when ${input.settled} then 'resolved' end,
        case when ${input.settled} then now() end
      from unnest(
        coalesce(${input.attemptIds ?? null}::uuid[],
          array(select gen_random_uuid() from generate_series(1, ${input.count})))
      ) with ordinality as request(attempt_id, ordinality)`;
    await requests({ sessionId: history.id, count: SETTLED_REQUESTS, from: 0, settled: true });
    // Other tenants' leases, each with its own settled requests.
    await tx`
      insert into sandbox_workspace_mutation_admissions (
        account_id, workspace_id, lease_id, sandbox_group_id, session_id, actor_kind, actor_id,
        holder_kind, holder_id, lease_epoch, provider_backend, provider_instance_id, route_kind,
        route_epoch, workspace_generation, operation, provider_outcome, settled_at
      ) select lease.account_id, lease.workspace_id, lease.id, lease.id, lease.id, 'direct',
        gen_random_uuid(), 'direct', 'holder', 1, 'modal', 'sb-background', 'home', 0, n,
        'write', 'resolved', now()
      from (
        select gen_random_uuid() as id, gen_random_uuid() as account_id,
          gen_random_uuid() as workspace_id
        from generate_series(1, ${BACKGROUND_LEASES})
      ) lease
      cross join generate_series(1, ${BACKGROUND_REQUESTS_PER_LEASE}) n`;
    await requests({
      sessionId: turnOwner.id,
      count: OPEN_TURN_REQUESTS,
      from: SETTLED_REQUESTS,
      settled: false,
      attemptIds: ownerAttemptIds,
    });
    await requests({
      sessionId: processOwner.id,
      count: 1,
      from: SETTLED_REQUESTS + OPEN_TURN_REQUESTS,
      settled: false,
      processId,
    });
  });
}

/** The host export outbox inside its grace window, and goals across many workspaces. */
async function seedOutboxAndGoals() {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into host_export_outbox (export_kind, export_cursor, source_id, account_id,
        workspace_id, event_type, idempotency_key, payload, envelope_bytes, occurred_at,
        source_recorded_at, enqueued_at)
      select 'session_event', n, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        'agent.message.completed', 'perf-budget-' || n,
        jsonb_build_object('text', (select string_agg(md5(n::text || g::text), '')
          from generate_series(1, 45) g)),
        1600, at, at, at
      from generate_series(1, ${OUTBOX_GRACE_ROWS}) n,
        lateral (select now() - interval '50 minutes' + n * interval '50 minutes' / ${OUTBOX_GRACE_ROWS} as at) t`;
    await tx`
      insert into host_export_consumers (consumer_id, export_kind, checkpoint)
      values ('perf-budget', 'session_event', ${OUTBOX_GRACE_ROWS})
      on conflict (export_kind, consumer_id) do update set checkpoint = excluded.checkpoint`;
    await tx`
      update host_export_cursor_state set next_cursor = ${OUTBOX_GRACE_ROWS + 1}, pruned_through = 0
      where export_kind = 'session_event'`;
    await tx`
      insert into session_goals (account_id, workspace_id, session_id, text, status)
      select md5('a' || (n % 300))::uuid, md5('w' || (n % 300))::uuid, md5('perf-goal-' || n)::uuid,
        'goal', case when n % 3 = 0 then 'active' else 'completed' end
      from generate_series(1, ${GOALS}) n`;
  });
  const [row] = await shared.admin<{ id: string }[]>`select md5('perf-goal-1')::uuid::text as id`;
  fixture.idleGoalSession = row!.id;
}

/** Another tenant's many sessions beside a reader workspace (#8214). */
async function seedOtherTenant() {
  const other = await workspace("other-tenant");
  const reader = await workspace("reader");
  const otherSession = await session(other);
  await session(reader);
  fixture.reader = reader;
  fixture.otherTenant = other;
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into sessions
      select clone.* from sessions s
      cross join (select gen_random_uuid() as id from generate_series(1, ${OTHER_TENANT_SESSIONS})) seed
      cross join lateral jsonb_populate_record(null::sessions, to_jsonb(s)
        || jsonb_build_object('id', seed.id, 'root_session_id', seed.id, 'create_idempotency_key', null)) clone
      where s.id = ${otherSession.id}::uuid`;
  });
}

/** An idle parent with a delivered child result, and a recovering session without its receipt. */
async function seedWakeRepairs() {
  const grant = await workspace("wake-repair");
  const { accountId, workspaceId } = grant;
  const scoped = <T>(fn: (db: Database) => Promise<T>) =>
    withWorkspaceSessionActivityRls(client.db, workspaceId, (db) => fn(db as unknown as Database));
  const input = {
    accountId,
    workspaceId,
    initialMessage: "delegate a task",
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
  const start = async (sessionId: string) => {
    await scoped((db) =>
      initializeSessionStartAtomically(db, {
        accountId,
        workspaceId,
        sessionId,
        clientEventId: `initial:${sessionId}`,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
      }),
    );
    const attemptId = crypto.randomUUID();
    const claimed = await scoped((db) =>
      claimSessionWorkForAttempt(db, workspaceId, {
        sessionId,
        workflowId: `session-${sessionId}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      }),
    );
    if (claimed.action !== "claimed") throw new Error("fixture session not claimed");
    return { claimed, attemptId };
  };
  const parent = await scoped((db) => createSession(db, input));
  const parentRun = await start(parent.id);
  const child = await scoped((db) =>
    createSession(db, {
      ...input,
      initialMessage: "child task",
      parentSessionId: parent.id,
      createdByActor: {
        type: "agent_attempt" as const,
        sessionId: parent.id,
        turnId: parentRun.claimed.turn.id,
        attemptId: parentRun.attemptId,
        executionGeneration: parentRun.claimed.turn.executionGeneration,
      },
    }),
  );
  await scoped((db) =>
    applySessionTurnSettlement(db, workspaceId, {
      sessionId: parent.id,
      turnId: parentRun.claimed.turn.id,
      triggerEventId: parentRun.claimed.turn.triggerEventId,
      attemptId: parentRun.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    }),
  );
  const update = {
    accountId,
    workspaceId,
    sourceSessionId: child.id,
    targetSessionId: parent.id,
    kind: "child_terminal_result" as const,
    classification: "success" as const,
    sourceId: child.id,
    dedupeKey: `child-completion:${child.id}:terminal`,
    summary: "Child finished",
    payload: {
      type: "child_terminal_result" as const,
      childSessionId: child.id,
      status: "idle" as const,
    },
    lineage: { parentSessionId: parent.id, childSessionId: child.id },
    personalConnectionDelegations: [],
    mcpAccountBindings: null,
    xaiProviderAccountAuthoritySnapshot: WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
    claudeProviderAccountAuthoritySnapshot: WORKSPACE_CLAUDE_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  };
  const outbox = await scoped((db) => getOrCreateSessionSystemUpdateOutbox(db, update));
  const added = await scoped((db) =>
    addSessionSystemUpdateWithSourceMutation(db, { ...update, sessionId: parent.id }, (tx) =>
      markSessionSystemUpdateOutboxDeliveredInTransaction(tx, outbox),
    ),
  );
  if (added.reason !== "added") throw new Error("fixture child result not added");
  await shared.admin`update session_workflow_wake_outbox
    set delivered_revision = wake_revision where session_id = ${parent.id}`;
  await shared.admin`update sessions set status = 'idle' where id = ${parent.id}`;
  const stranded = await scoped((db) => createSession(db, input));
  const strandedRun = await start(stranded.id);
  const recovery = await scoped((db) =>
    requestSessionTurnRecovery(db, workspaceId, {
      sessionId: stranded.id,
      turnId: strandedRun.claimed.turn.id,
      triggerEventId: strandedRun.claimed.turn.triggerEventId,
      attemptId: strandedRun.attemptId,
      reason: "worker_shutdown",
    }),
  );
  if (recovery.action !== "recovering") throw new Error("fixture session not recovering");
  await shared.admin`update session_turn_attempts set closed_at = closed_at - interval '10 minutes'
    where id = ${strandedRun.attemptId}`;
  await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision,
    updated_at = now() - interval '20 minutes' where session_id = ${stranded.id}`;
  fixture.wake = { parent: parent.id, stranded: stranded.id };
}

/** A turn with thousands of model calls, recorded as the current worker records them (#8215). */
async function seedTerminalTurn() {
  const grant = await workspace("terminal-usage");
  const chat = await session(grant, "usage");
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const turn = async (position: number) => {
    const turnId = crypto.randomUUID();
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, sandbox_backend, resources, tools, metadata, started_at, finished_at
        ) values (
          ${turnId}, ${grant.accountId}, ${grant.workspaceId}, ${chat.id},
          ${crypto.randomUUID()}, ${`session-${chat.id}`}, 'completed', ${position},
          'hello', 'scripted-model', 'medium', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
          now(), now()
        )`);
    });
    return turnId;
  };
  const filler = await turn(1);
  // One appended event through the application, then the rest set-based with
  // every trigger on, so the running per-turn totals are kept as in production.
  await appendSessionEvents(client.db, grant.workspaceId, chat.id, [
    { type: "agent.message.completed", turnId: filler, payload: { text: "x".repeat(200) } },
  ]);
  const turnId = await turn(2);
  await shared.admin.begin(async (tx) => {
    const [last] = await tx<{ sequence: number }[]>`
      select max(sequence)::int as sequence from session_events
      where workspace_id = ${grant.workspaceId} and session_id = ${chat.id}`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type,
        payload, turn_association)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${chat.id}::uuid,
        ${filler}::uuid, ${last!.sequence} + n, 'agent.message.completed',
        jsonb_build_object('text', repeat('x', 200)), 'current'
      from generate_series(1, ${TERMINAL_FILLER_EVENTS}) n`;
    // A call as the current worker records it: its credit charges settled with the usage.
    await tx`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type,
        payload, turn_association)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${chat.id}::uuid,
        ${turnId}::uuid, ${last!.sequence + TERMINAL_FILLER_EVENTS} + n, 'agent.model.usage',
        jsonb_build_object('sourceKey', 'call-' || n, 'model', 'scripted-model',
          'inputTokens', n * 31 % 30000, 'outputTokens', n * 17 % 2000,
          'pricedCostMicros', n * 7919 % 40000,
          'settlement', jsonb_build_object('version', 1, 'chargesOpenGeniCredits', true,
            'charges', jsonb_build_object('debits', n * 7919 % 40000 > 0,
              'creditCostMicros', n * 7919 % 40000, 'byokPlatformFeeMicros', 0,
              'hostedWebSearch', null, 'completionKey', 'k'))), 'current'
      from generate_series(1, ${TERMINAL_CALLS}) n`;
  });
  await withRlsContext(client.db, scope, async (tx) => {
    await tx.execute(sql`
      insert into usage_events (account_id, workspace_id, session_id, turn_id, event_type,
        quantity, unit, source_resource_type, source_resource_id, idempotency_key, occurred_at)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${chat.id}::uuid,
        ${turnId}::uuid, 'model.cost', 1 + n % 977, 'usd_micros', 'model_response',
        ${turnId}::text || ':call-' || n, 'usage:model.cost:' || ${turnId}::text || ':call-' || n, now()
      from generate_series(0, ${TERMINAL_CALLS - 1}) n`);
  });
  fixture.terminal = { ...grant, sessionId: chat.id, turnId };
}

// ---------------------------------------------------------------------------
// Probes. Each returns the measurement its budget bounds.

async function acceptedExecution() {
  const { accountId, workspaceId, sessionId, task } = fixture.chat;
  const personalResourceAuthoritySubjectId = await getScheduledTaskPersonalResourceAuthoritySubject(
    client.db,
    { accountId, workspaceId, taskId: task.id, taskAuthorityRevision: task.authorityRevision },
  );
  const targetSessionExecution = await getScheduledTargetSessionExecution(
    client.db,
    workspaceId,
    sessionId,
    personalResourceAuthoritySubjectId,
  );
  if (!targetSessionExecution) throw new Error("scheduled target execution is unavailable");
  const causalHumanAuthority = await getScheduledTaskRevisionAuthority(client.db, {
    accountId,
    workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
  });
  return {
    version: 1 as const,
    task,
    resolvedModel: targetSessionExecution.model,
    resolvedReasoningEffort: targetSessionExecution.reasoningEffort,
    resolvedLatencyMode: targetSessionExecution.latencyMode,
    resolvedSandboxBackend: targetSessionExecution.sandboxBackend,
    resolvedSandboxOs: targetSessionExecution.sandboxOs,
    resolvedTools: targetSessionExecution.tools,
    resolvedFirstPartyMcpTools: targetSessionExecution.firstPartyMcpTools ?? [
      ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
    ],
    resolvedFirstPartyMcpPermissions: targetSessionExecution.firstPartyMcpPermissions ?? [
      ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
    ],
    resolvedVariableSet: null,
    resolvedRig: null,
    resolvedSlackBotConnection: null,
    targetSessionExecution,
    generatedSessionBinding: null,
    personalConnectionDelegations: [],
    personalResourceAuthoritySubjectId,
    causalHumanSubjectId:
      personalResourceAuthoritySubjectId ?? causalHumanAuthority?.subjectId ?? null,
    causalHumanAuthority,
    xaiProviderAccountAuthoritySnapshot: { version: 1 as const, scope: "workspace" as const },
    claudeProviderAccountAuthoritySnapshot: { version: 1 as const, scope: "workspace" as const },
    claudeAuthoritySubjectId: null,
    xaiAuthoritySubjectId: null,
    connectionAuthoritySubjectId: null,
    triggerInitiator: { kind: "service" as const, subjectId: "scheduler" },
    agentRunUsageIdempotencyKey: null,
    incidentPreflightRequired: false,
    alertOccurrenceLabels: null,
  };
}

let accepted: Awaited<ReturnType<typeof acceptedExecution>> | null = null;

async function scheduledAdmissionBuffers(): Promise<number> {
  const { accountId, workspaceId, task } = fixture.chat;
  if (!accepted) {
    accepted = await acceptedExecution();
    // The worker's read and the admission fence agree: the stored defaults,
    // since no automated turn after the write can replace them.
    expect(accepted.targetSessionExecution.model).toBe("stored-model");
    expect(
      await createScheduledTaskRun(client.db, {
        workspaceId,
        taskId: task.id,
        taskAuthorityRevision: task.authorityRevision,
        taskExecutionDigest: task.executionDigest,
        triggerType: "scheduled",
        producerKey: `perf-budget:${crypto.randomUUID()}`,
        acceptedExecutionSnapshot: accepted,
      }),
    ).toMatchObject({ status: "queued", taskId: task.id });
  }
  const snapshot = sqlParameterLiteral(JSON.stringify(accepted));
  return await steadyBuffers(
    workspaceScope(workspaceId),
    () => `select create_scheduled_agent_run_with_admission(
      '${crypto.randomUUID()}'::uuid, '${accountId}'::uuid, '${workspaceId}'::uuid,
      '${task.id}'::uuid, ${task.authorityRevision}::bigint, ${sqlParameterLiteral(task.executionDigest)}::text,
      'scheduled'::text, 'perf-budget:${crypto.randomUUID()}'::text,
      null::timestamptz, now(), ${snapshot}::jsonb)`,
    { modes: BOTH_PLANS, calls: 3 },
  );
}

async function effectiveModelBuffers(): Promise<number> {
  const { workspaceId, sessionId } = fixture.chat;
  const [row] = await subjectScope(fixture.chat)(client.db, (tx) =>
    effectiveSessionPolicyQuery(tx, workspaceId, [sessionId]),
  );
  expect(row?.model).toBe("stored-model");
  const query = effectiveSessionPolicyQuery(client.db, workspaceId, [sessionId]).toSQL();
  return await capturedBuffers(subjectScope(fixture.chat), {
    query: query.sql,
    parameters: query.params,
  });
}

async function freePlanBuffers(): Promise<number> {
  let most = 0;
  for (const accountId of [fixture.busyOrganization, fixture.noTrialOrganization]) {
    const scope: Scope = (db, fn) =>
      withAccountRls(db, accountId, async (tx) => {
        await tx.execute(
          sql`select pg_catalog.set_config('opengeni.free_credit_card_claim', 'on', true)`,
        );
        return await fn(tx);
      });
    most = Math.max(
      most,
      await steadyBuffers(scope, `select free_plan_credit_eligible('${accountId}'::uuid)`),
    );
  }
  return most;
}

const OWNER_DEFINERS = [
  "session_tenancy_fence_owner_policy_active(text,text,oid,uuid,boolean)",
  "scoped_compute_policy_capability_active(text,text,text)",
];

/** Owner-only definer calls of one runtime-role scan of sessions, past another tenant's rows. */
async function ownerDefinerCalls(): Promise<number> {
  const fresh = createDb(shared.appUrl, { max: 1, searchPath: shared.schema });
  const calls = sql.raw(
    OWNER_DEFINERS.map(
      (name) => `coalesce(pg_stat_get_xact_function_calls('${name}'::regprocedure), 0)`,
    ).join(" + "),
  );
  try {
    return await subjectScope(fixture.reader)(fresh.db, async (tx) => {
      const [before] = (await tx.execute(sql`select ${calls} as calls`)) as unknown as {
        calls: string;
      }[];
      const [count] = (await tx.execute(
        sql`select count(*)::int as count from sessions`,
      )) as unknown as { count: number }[];
      expect(count!.count).toBe(1);
      const [after] = (await tx.execute(sql`select ${calls} as calls`)) as unknown as {
        calls: string;
      }[];
      return Number(after!.calls) - Number(before!.calls);
    });
  } finally {
    await fresh.close();
  }
}

async function lostProviderLookup(): Promise<Captured> {
  const lookups = await capture(
    async () => {
      expect(await settleEndedEpochWorkspaceBlockers(client.db, fixture.sandbox.tuple)).toBeNull();
    },
    (query) => query.includes("select distinct session_id from ("),
  );
  expect(lookups).toHaveLength(1);
  return lookups[0]!;
}

async function lostProviderBuffers(lookup: Captured): Promise<number> {
  const { accountId, workspaceId, turnOwner, processOwner } = fixture.sandbox;
  const scope: Scope = (db, fn) =>
    withSessionActivityRlsContext(db, { accountId, workspaceId }, (tx) =>
      fn(tx as unknown as Database),
    );
  // Both owner kinds, in lock order.
  const rows = await scope(client.db, (tx) =>
    tx.execute(
      sql.raw(
        lookup.query.replace(/\$(\d+)/g, (_, index: string) =>
          sqlParameterLiteral(lookup.parameters[Number(index) - 1]),
        ),
      ),
    ),
  );
  expect((rows as unknown as { session_id: string }[]).map((row) => row.session_id)).toEqual(
    [turnOwner, processOwner].sort(),
  );
  return await capturedBuffers(scope, lookup);
}

// ---------------------------------------------------------------------------
// Budgets

test("scheduled-run admission into a long scheduled chat", async () => {
  within("scheduled_admission", await scheduledAdmissionBuffers());
}, 300_000);

test("the effective model of a long scheduled chat", async () => {
  within("effective_model_read", await effectiveModelBuffers());
}, 120_000);

test("schedule target chats are read in one batch", async () => {
  const { workspaceId } = fixture.chat;
  let configs = 0;
  const statements = await capture(async () => {
    configs = (await getSessionToolConfigs(client.db, workspaceId, fixture.targetChatIds)).size;
  }, applicationRead);
  expect(configs).toBe(fixture.targetChatIds.length);
  within("schedule_targets_statements", statements.length);
  let buffers = 0;
  for (const statement of statements) {
    buffers += await capturedBuffers(workspaceScope(workspaceId), statement);
  }
  within("schedule_targets_reads", buffers);
}, 120_000);

test("the credit balance read of a large ledger", async () => {
  const accountId = fixture.busyOrganization;
  const reads = await capture(
    () => getBillingBalance(client.db, accountId),
    (query) => query.includes("read_organization_plan_balance"),
  );
  expect(reads).toHaveLength(1);
  within("credit_balance_read", await capturedBuffers(accountScope(accountId), reads[0]!));
}, 120_000);

test("read_organization_plan_balance of a large ledger", async () => {
  const accountId = fixture.busyOrganization;
  within(
    "read_organization_plan_balance",
    await steadyBuffers(
      accountScope(accountId),
      `select read_organization_plan_balance('${accountId}'::uuid, statement_timestamp())`,
    ),
  );
}, 120_000);

test("the plan maintenance inventory in steady state", async () => {
  // Only the fixture's own new workspaces' organizations, which have no plan yet.
  const [due] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from opengeni_private.list_subscription_plan_maintenance_accounts(50)`;
  expect(due!.count).toBeLessThan(20);
  within(
    "list_subscription_plan_maintenance_accounts",
    await steadyBuffers(
      unscoped,
      "select count(*) from opengeni_private.list_subscription_plan_maintenance_accounts(50)",
    ),
  );
}, 120_000);

test("free_plan_credit_eligible for busy organizations", async () => {
  expect(await freePlanCreditEligible(client.db, fixture.busyOrganization)).toBe(true);
  expect(await freePlanCreditEligible(client.db, fixture.noTrialOrganization)).toBe(false);
  within("free_plan_credit_eligible", await freePlanBuffers());
}, 120_000);

test("the checkpoint GC claim and prune with nothing due", async () => {
  within(
    "checkpoint_gc_claim",
    await steadyBuffers(
      unscoped,
      "select count(*) from opengeni_private.claim_sandbox_checkpoint_artifacts(gen_random_uuid(), 500, 60000)",
    ),
  );
  within(
    "checkpoint_gc_prune",
    await steadyBuffers(
      unscoped,
      "select opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(86400000, 1000)",
    ),
  );
}, 120_000);

test("the host export outbox prune with nothing due", async () => {
  within(
    "host_export_outbox_prune",
    await ownerSteadyBuffers(
      "select opengeni_host_export.prune_host_export_outbox('session_event', 3600, 1000)",
    ),
  );
}, 120_000);

test("the hands-back active-goal check", async () => {
  const statement = `select opengeni_private.session_hands_back_v1('${fixture.idleGoalSession}'::uuid, gen_random_uuid())`;
  const [row] = await shared.admin.unsafe<{ value: boolean }[]>(`${statement} as value`);
  expect(row!.value).toBe(true);
  within("hands_back_active_goal", await steadyBuffers(unscoped, statement));
}, 120_000);

test("runtime-role policies skip owner-only definers", async () => {
  within("rls_owner_definer_calls", await ownerDefinerCalls());
  // Only the two tenants' rows (an index range), so other probes' sessions
  // do not move this budget.
  const read = `select count(*) from sessions
    where workspace_id in ('${fixture.reader.workspaceId}'::uuid, '${fixture.otherTenant.workspaceId}'::uuid)`;
  const [count] = await subjectScope(fixture.reader)(client.db, (tx) =>
    tx.execute(sql.raw(`${read.replace("count(*)", "count(*)::int as count")}`)),
  );
  expect((count as { count: number }).count).toBe(1);
  within("rls_policy_heavy_read", await steadyBuffers(subjectScope(fixture.reader), read));
}, 120_000);

test("the terminal usage insert of a turn with thousands of calls", async () => {
  const { accountId, workspaceId, sessionId, turnId } = fixture.terminal;
  const scope: Scope = (db, fn) => withRlsContext(db, { accountId, workspaceId }, fn);
  const [next] = await shared.admin<{ sequence: number }[]>`
    select max(sequence)::int + 1 as sequence from session_events
    where workspace_id = ${workspaceId} and session_id = ${sessionId}`;
  within(
    "terminal_usage_insert",
    await steadyBuffers(
      scope,
      `insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload, turn_association)
       values ('${accountId}'::uuid, '${workspaceId}'::uuid, '${sessionId}'::uuid,
         '${turnId}'::uuid, ${next!.sequence}, 'turn.completed', '{}'::jsonb, 'current')`,
      { rollback: true, calls: 4 },
    ),
  );
}, 120_000);

test("the editable artifact schema resolver", async () => {
  within(
    "editable_artifact_schema_resolver",
    await steadyBuffers(
      unscoped,
      `select opengeni_private.resolve_editable_artifact_data_schema('${shared.schema}')`,
    ),
  );
}, 120_000);

test("both wake repair inventories", async () => {
  const inventories = [
    [
      "wake_inventory_child_terminal",
      "list_pending_child_terminal_wake_repairs_v1",
      fixture.wake.parent,
    ],
    ["wake_inventory_quiescence", "list_quiescence_receipt_wake_repairs_v1", fixture.wake.stranded],
  ] as const;
  for (const [id, inventory, sessionId] of inventories) {
    const rows = await shared.admin<{ session_id: string }[]>`
      select session_id::text from ${shared.admin.unsafe(`opengeni_private.${inventory}`)}(100, null, null)`;
    expect(rows.map((row) => row.session_id)).toContain(sessionId);
    within(
      id,
      await steadyBuffers(
        unscoped,
        `select count(*) from opengeni_private.${inventory}(100, null, null)`,
      ),
    );
  }
}, 120_000);

test("the lost-provider retained-process session lookup", async () => {
  within("lost_provider_session_lookup", await lostProviderBuffers(await lostProviderLookup()));
}, 120_000);

// ---------------------------------------------------------------------------
// The regressions the budgets exist for: each must exceed its budget. Each
// puts the old shape back as the migration owner, measures, and restores.
// If a later migration reshapes one of these routines so its old shape no
// longer applies, move the proof to the new shape or remove it.

const DRIZZLE = new URL("../drizzle/", import.meta.url);

/** The migration file with this number, whatever its name. */
async function migrationFile(number: number): Promise<URL> {
  const names = (await readdir(DRIZZLE)).filter(
    (name) => name.startsWith(`${number}_`) && name.endsWith(".sql"),
  );
  expect(names).toHaveLength(1);
  return new URL(names[0]!, DRIZZLE);
}

test("regression: #8168's admission body (1567, before 1695) exceeds its budget", async () => {
  const migration = await readFile(await migrationFile(1695), "utf8");
  const olds = [...migration.matchAll(/\$old\$([\s\S]*?)\$old\$/g)].map((match) => match[1]!);
  const news = [...migration.matchAll(/\$new\$([\s\S]*?)\$new\$/g)].map((match) => match[1]!);
  expect({ olds: olds.length, news: news.length }).toEqual({ olds: 3, news: 3 });
  await asOwner(async (owner) => {
    const [current] = await owner<{ definition: string }[]>`
      select pg_get_functiondef('admit_scheduled_agent_run_execution()'::regprocedure) as definition`;
    let reverted = current!.definition;
    for (const [index, replacement] of news.entries()) {
      expect(reverted.split(replacement).length - 1).toBe(1);
      reverted = reverted.replace(replacement, olds[index]!);
    }
    await owner.unsafe(reverted);
    try {
      caught("scheduled_admission", "1567 admission body", await scheduledAdmissionBuffers());
    } finally {
      await owner.unsafe(current!.definition);
    }
  });
  // Restored.
  within("scheduled_admission", await scheduledAdmissionBuffers());
}, 600_000);

test("regression: the effective model read without index 1589 exceeds its budget", async () => {
  await asOwner(async (owner) => {
    const [index] = await owner<{ definition: string }[]>`
      select pg_get_indexdef('session_turns_session_person_api_idx'::regclass) as definition`;
    await owner`drop index session_turns_session_person_api_idx`;
    try {
      caught("effective_model_read", "no index 1589", await effectiveModelBuffers());
    } finally {
      await owner.unsafe(index!.definition);
    }
  });
}, 300_000);

test("regression: free_plan_credit_eligible without index 1579 exceeds its budget", async () => {
  await asOwner(async (owner) => {
    const [index] = await owner<{ definition: string }[]>`
      select pg_get_indexdef('credit_ledger_verified_signup_trial_idx'::regclass) as definition`;
    await owner`drop index credit_ledger_verified_signup_trial_idx`;
    try {
      caught("free_plan_credit_eligible", "no index 1579", await freePlanBuffers());
    } finally {
      await owner.unsafe(index!.definition);
    }
  });
}, 300_000);

test("regression: unguarded owner-only definers (before #8214) exceed their budget", async () => {
  await asOwner(async (owner) => {
    const policies = await owner<{ name: string; qual: string | null; check: string | null }[]>`
      select polname as name, pg_get_expr(polqual, polrelid) as qual,
        pg_get_expr(polwithcheck, polrelid) as check
      from pg_policy where polrelid = 'sessions'::regclass`;
    const guard =
      /\(\(\(CURRENT_USER\)::text = ('(?:[^']|'')*'::text)\) AND ((?:session_tenancy_fence_owner_policy_active|scoped_compute_policy_capability_active)\(\(CURRENT_USER\)::text, \1, (?:[^()']|'(?:[^']|'')*'|\([0-9]+\))*\))\)/g;
    const unguard = (expression: string | null) => expression?.replace(guard, "$2") ?? null;
    const alter = (name: string, qual: string | null, check: string | null) =>
      owner.unsafe(
        `alter policy "${name}" on sessions ${[
          qual === null ? "" : `using (${qual})`,
          check === null ? "" : `with check (${check})`,
        ].join(" ")}`,
      );
    const changed = policies.filter(
      (policy) => unguard(policy.qual) !== policy.qual || unguard(policy.check) !== policy.check,
    );
    expect(changed.length).toBeGreaterThan(0);
    for (const policy of changed)
      await alter(policy.name, unguard(policy.qual), unguard(policy.check));
    try {
      caught("rls_owner_definer_calls", "unguarded sessions policies", await ownerDefinerCalls());
    } finally {
      for (const policy of changed) await alter(policy.name, policy.qual, policy.check);
    }
  });
  within("rls_owner_definer_calls", await ownerDefinerCalls());
}, 300_000);

test("regression: the lost-provider lookup without 1696 or its split exceeds its budget", async () => {
  const lookup = await lostProviderLookup();
  // The lookup before #8243: one arm joining attempts on
  // coalesce(request attempt, process owner).
  const first = lookup.query.indexOf(
    "select attempt.session_id\n      from sandbox_workspace_mutation_admissions admission\n      join session_turn_attempts attempt",
  );
  const end = lookup.query.indexOf(") owners order by session_id");
  expect({ first: first > 0, end: end > first }).toEqual({ first: true, end: true });
  const scopeClause = lookup.query
    .slice(first)
    .match(/where (admission\.account_id = \$\d+[\s\S]*?admission\.settled_at is null)/)![1]!;
  const unsplitQuery = `${lookup.query.slice(0, first)}select attempt.session_id
      from sandbox_workspace_mutation_admissions admission
      left join sandbox_retained_processes actor_process
        on admission.actor_kind = 'process'
        and actor_process.id = admission.actor_id
        and actor_process.workspace_id = admission.workspace_id
      join session_turn_attempts attempt
        on attempt.id = coalesce(admission.attempt_id, actor_process.owner_attempt_id)
        and attempt.workspace_id = admission.workspace_id
      where ${scopeClause}
        and attempt.state = 'closed' and attempt.quiesced_at is null
      ${lookup.query.slice(end)}`;
  // The dropped second arm's parameters were the last ones.
  const placeholders = Math.max(
    ...[...unsplitQuery.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
  );
  const unsplit: Captured = {
    query: unsplitQuery,
    parameters: lookup.parameters.slice(0, placeholders),
  };
  caught("lost_provider_session_lookup", "unsplit lookup", await lostProviderBuffers(unsplit));
  // Without 1696 alone the planner here probes the lease's open requests
  // through sandbox_workspace_mutation_admissions_blocking_idx, which serves
  // the same predicate; production's statistics chose the scoped id index and
  // read every settled request of the lease. Reported, not required.
  await asOwner(async (owner) => {
    const [index] = await owner<{ definition: string }[]>`
      select pg_get_indexdef('sandbox_workspace_mutation_admissions_unsettled_lease_idx'::regclass) as definition`;
    await owner`drop index sandbox_workspace_mutation_admissions_unsettled_lease_idx`;
    try {
      const withoutIndex = await lostProviderBuffers(lookup);
      regressed.set("lost_provider_session_lookup: no index 1696 (reported only)", withoutIndex);
      console.info(
        "perf-budget-regression",
        JSON.stringify({
          id: "lost_provider_session_lookup",
          regression: "no index 1696",
          measured: withoutIndex,
        }),
      );
      caught(
        "lost_provider_session_lookup",
        "no index 1696, unsplit lookup",
        await lostProviderBuffers(unsplit),
      );
    } finally {
      await owner.unsafe(index!.definition);
    }
  });
}, 300_000);
