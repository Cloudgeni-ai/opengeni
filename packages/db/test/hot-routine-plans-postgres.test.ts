import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  WORKSPACE_CLAUDE_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
} from "@opengeni/contracts";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  addSessionSystemUpdateWithSourceMutation,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeSelfServiceOrganizationSetup,
  createDb,
  createSession,
  freePlanCreditEligible,
  getOrCreateSessionSystemUpdateOutbox,
  initializeSessionStartAtomically,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  requestSessionTurnRecovery,
  withWorkspaceSessionActivityRls,
  type Database,
  type DbClient,
} from "../src";

// Hot production routines, called as the restricted runtime role (FORCE RLS;
// SECURITY DEFINER bodies run as the NOSUPERUSER migration owner). Each test
// checks the exact answer, then bounds the buffers a steady-state call reads.
// Nested statements count toward the outer call, including the catalog reads
// of planning them, so a routine that plans again on every call reads more.

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
let app: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("hot-routine-plans", "hot_plan_data");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2, searchPath: shared.schema });
  app = runtimeConnection();
}, 300_000);

afterAll(async () => {
  await app?.end();
  await client?.close();
  await shared?.release();
}, 180_000);

/** A new runtime-role connection, as a freshly opened pool connection is. */
function runtimeConnection() {
  return postgres(shared.appUrl, {
    max: 1,
    onnotice: () => undefined,
    connection: {
      search_path: shared.schema,
      // The runtime's own protocol marker (lossless-json.ts).
      application_name: "opengeni-lossless-v1-session-variable-sets-v1",
    },
  });
}

type Plan = { Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number } };

/**
 * The most buffers one of a connection's second to fifth calls reads. The
 * first call loads the connection's catalog caches; PL/pgSQL plans a
 * parameterized statement afresh for each of the first five calls unless the
 * routine reuses one plan.
 */
async function steadyCallBuffers(statement: string, prepare?: string): Promise<number> {
  const connection = runtimeConnection();
  try {
    if (prepare) await connection.unsafe(prepare);
    await connection.unsafe(statement);
    let most = 0;
    for (let call = 2; call <= 5; call += 1) {
      const [row] = await connection.unsafe<{ "QUERY PLAN": Plan[] }[]>(
        `explain (analyze, buffers, timing off, format json) ${statement}`,
      );
      const plan = row!["QUERY PLAN"][0]!.Plan;
      most = Math.max(most, plan["Shared Hit Blocks"] + plan["Shared Read Blocks"]);
    }
    return most;
  } finally {
    await connection.end();
  }
}

/** A self-serve organization with its verified signup trial receipt. */
async function organization() {
  const userId = crypto.randomUUID();
  await shared.admin`insert into auth_users(id, name, email, email_verified)
    values (${userId}, 'Owner', ${`${userId}@example.test`}, true)`;
  const { organizationId } = await completeSelfServiceOrganizationSetup(client.db, {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Plan organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "c".repeat(64),
    trialCreditsEnabled: true,
    trialCreditModelIds: ["model-a"],
  });
  return organizationId;
}

const LEDGER_ROWS = 60_000;

// Turn admission and every model-call credit hold call free_plan_credit_eligible.
// Before credit_ledger_verified_signup_trial_idx (1579) its trial check found
// the account's rows through (account_id, created_at) and read every ledger
// row of the account (prod: 132k rows, 174 ms for the busiest account).
test("the Free eligibility trial check reads only trial grants", async () => {
  const busy = await organization();
  const noTrial = await organization();
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from credit_ledger_entries
      where account_id = ${noTrial} and source_type = 'verified_signup_trial'`;
    // Usage debits of two busy organizations, one of them without its trial grant.
    for (const accountId of [busy, noTrial]) {
      await tx`
        insert into credit_ledger_entries (account_id, type, amount_micros, source_type,
          source_id, idempotency_key, metadata, occurred_at, created_at)
        select ${accountId}::uuid, 'model_usage_debit', -1000 - n % 7, 'model_response',
          'resp_' || n, 'debit:' || ${accountId}::text || ':' || n,
          jsonb_build_object('model', 'model-a', 'inputTokens', n),
          now() - n * interval '1 minute', now() - n * interval '1 minute'
        from generate_series(1, ${LEDGER_ROWS}) n`;
    }
  });
  await shared.admin`vacuum analyze credit_ledger_entries`;

  expect(await freePlanCreditEligible(client.db, busy)).toBe(true);
  expect(await freePlanCreditEligible(client.db, noTrial)).toBe(false);

  for (const accountId of [busy, noTrial]) {
    // About 50 buffers with the index; about 580 here without it.
    const buffers = await steadyCallBuffers(
      `select free_plan_credit_eligible('${accountId}'::uuid)`,
      `select set_config('opengeni.account_id', '${accountId}', false)`,
    );
    expect(buffers).toBeLessThan(200);
  }
}, 300_000);

const RESOLVER_TABLES = [
  "editable_artifact_live_outbox",
  "editable_artifacts",
  "editable_artifact_scope_authorization_heads",
  "editable_artifact_materialization_jobs",
  "editable_artifact_materialization_results",
  "editable_artifact_blob_refs",
] as const;

/** The resolver as the 0977 baseline defined it, under another name. */
async function installReferenceResolver(owner: postgres.Sql) {
  const baseline = await readFile(
    new URL("../drizzle/0977_baseline_01.sql", import.meta.url),
    "utf8",
  );
  const start = baseline.indexOf(
    "CREATE FUNCTION opengeni_private.resolve_editable_artifact_data_schema(",
  );
  const end = baseline.indexOf("\n$$;\n", start);
  expect(start).toBeGreaterThan(-1);
  const body = baseline
    .slice(start, end + 4)
    .replace(
      "opengeni_private.resolve_editable_artifact_data_schema(",
      "opengeni_private.resolve_editable_artifact_data_schema_reference(",
    );
  await owner.unsafe(body);
  await owner.unsafe(`grant execute on function
    opengeni_private.resolve_editable_artifact_data_schema_reference(name) to opengeni_app`);
}

// Every editable artifact routine starts with resolve_editable_artifact_data_schema.
// It joined pg_namespace, six pg_class rows and pg_roles: about 26 ms to plan
// warm, planned again for each of a connection's first five calls.
test("the editable artifact schema resolver keeps every check and plans one relation", async () => {
  const owner = postgres(shared.ownerUrl, { max: 1, onnotice: () => undefined });
  const otherOwner = `hot_plan_other_${crypto.randomUUID().slice(0, 8)}`;
  const variants = {
    ok: "",
    partitioned: "",
    missing: "",
    noforce: "",
    norls: "",
    view: "",
    foreign_owner: "",
    no_usage: "",
  } as Record<string, string>;
  try {
    await installReferenceResolver(owner);
    await shared.admin.unsafe(`create role "${otherOwner}" nologin`);
    for (const variant of Object.keys(variants)) {
      const schema = `hot_plan_${variant}`;
      variants[variant] = schema;
      await owner.unsafe(`create schema ${schema}`);
      for (const [index, table] of RESOLVER_TABLES.entries()) {
        const target = `${schema}.${table}`;
        if (variant === "missing" && index === 3) continue;
        if (variant === "view" && index === 4) {
          await owner.unsafe(`create view ${target} as select 1 as id`);
          continue;
        }
        await owner.unsafe(
          variant === "partitioned" && index === 1
            ? `create table ${target} (id int) partition by range (id)`
            : `create table ${target} (id int)`,
        );
        if (!(variant === "norls" && index === 2)) {
          await owner.unsafe(`alter table ${target} enable row level security`);
        }
        if (!(variant === "noforce" && index === 5)) {
          await owner.unsafe(`alter table ${target} force row level security`);
        }
        if (variant === "foreign_owner" && index === 0) {
          await shared.admin.unsafe(`alter table ${target} owner to "${otherOwner}"`);
        }
      }
      if (variant !== "no_usage") {
        await owner.unsafe(`grant usage on schema ${schema} to opengeni_app`);
      }
    }

    const resolve = async (routine: string, schema: string | null) => {
      try {
        const [row] = await app<{ value: string }[]>`
          select ${app.unsafe(`opengeni_private.${routine}`)}(${schema}::name)::text as value`;
        return { value: row!.value };
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        return { code: failure.code, message: failure.message };
      }
    };
    const requests = [
      shared.schema,
      ...Object.values(variants),
      "hot_plan_absent",
      "information_schema",
      "pg_catalog",
      "public",
      null,
    ];
    const answers: Record<string, unknown> = {};
    for (const schema of requests) {
      const current = await resolve("resolve_editable_artifact_data_schema", schema);
      expect(current).toEqual(
        await resolve("resolve_editable_artifact_data_schema_reference", schema),
      );
      answers[String(schema)] = current;
    }
    // Only complete, forced-RLS, owner-owned, usable schemas resolve.
    expect(answers).toMatchObject({
      [shared.schema]: { value: shared.schema },
      hot_plan_ok: { value: "hot_plan_ok" },
      hot_plan_partitioned: { value: "hot_plan_partitioned" },
      hot_plan_missing: { code: "42501" },
      hot_plan_noforce: { code: "42501" },
      hot_plan_norls: { code: "42501" },
      hot_plan_view: { code: "42501" },
      hot_plan_foreign_owner: { code: "42501" },
      hot_plan_no_usage: { code: "42501" },
      pg_catalog: { code: "42501" },
      null: { code: "42501" },
    });

    // About 16 buffers per call now; planning the 8-way join again on each
    // call read about 110.
    const buffers = await steadyCallBuffers(
      `select opengeni_private.resolve_editable_artifact_data_schema('${shared.schema}')`,
    );
    expect(buffers).toBeLessThan(40);
  } finally {
    for (const schema of Object.values(variants)) {
      if (schema) await shared.admin.unsafe(`drop schema if exists ${schema} cascade`);
    }
    await shared.admin.unsafe(`drop function if exists
      opengeni_private.resolve_editable_artifact_data_schema_reference(name)`);
    await shared.admin.unsafe(`drop role if exists "${otherOwner}"`);
    await owner.end();
  }
}, 300_000);

// The wake repair inventories run every few seconds. Their cost was planning:
// each call on a connection's first five planned the statement again.
// They must also find every tenant's sessions under the owner posture
// docs/deployment.md describes (NOBYPASSRLS, FORCE RLS) and under one that
// bypasses row security (production's), with the same answer.
test("the wake repair inventories find the same sessions and plan once per connection", async () => {
  const [owner] = await shared.admin<{ bypass: boolean }[]>`
    select rolbypassrls as bypass from pg_roles where rolname = ${shared.ownerRole}`;
  expect(owner?.bypass).toBe(false);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "hot-routine-plans",
    accountExternalId: suffix,
    accountName: "Wake repair plans",
    workspaceExternalSource: "hot-routine-plans",
    workspaceExternalId: suffix,
    workspaceName: "Wake repair plans",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const scoped = <T>(fn: (db: Database) => Promise<T>) =>
    withWorkspaceSessionActivityRls(client.db, workspaceId, (db) => fn(db as unknown as Database));
  const input = {
    accountId: grant.accountId,
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
        accountId: grant.accountId,
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

  // An idle parent with an accepted child result whose wakes were all delivered.
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
    accountId: grant.accountId,
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
  expect(added.reason).toBe("added");
  await shared.admin`update session_workflow_wake_outbox
    set delivered_revision = wake_revision where session_id = ${parent.id}`;
  await shared.admin`update sessions set status = 'idle' where id = ${parent.id}`;

  // A recovering session whose interrupted attempt closed without its receipt.
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
  expect(recovery.action).toBe("recovering");
  await shared.admin`update session_turn_attempts set closed_at = closed_at - interval '10 minutes'
    where id = ${strandedRun.attemptId}`;
  await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision,
    updated_at = now() - interval '20 minutes' where session_id = ${stranded.id}`;
  await shared.admin`analyze`;

  const inventories = [
    ["list_pending_child_terminal_wake_repairs_v1", parent.id],
    ["list_quiescence_receipt_wake_repairs_v1", stranded.id],
  ] as const;
  const list = async (inventory: string, after: string | null) => [
    ...(await app<{ account_id: string; workspace_id: string; session_id: string }[]>`
      select account_id::text, workspace_id::text, session_id::text
      from ${app.unsafe(`opengeni_private.${inventory}`)}(100, ${after && workspaceId}::uuid,
        ${after}::uuid)`),
  ];
  const claims = async () =>
    (
      await shared.admin`select count(*)::int as count from opengeni_private.maintenance_claim_capabilities`
    )[0]!.count;
  // The owner outside these routines holds no claim, so the new select
  // policies admit nothing: it still sees none of the rows they read.
  const ownerSql = postgres(shared.ownerUrl, {
    max: 1,
    onnotice: () => undefined,
    connection: {
      search_path: shared.schema,
      application_name: "opengeni-lossless-v1-session-variable-sets-v1",
    },
  });
  try {
    for (const table of [
      "session_system_updates",
      "session_system_update_outbox",
      "session_goals",
      "session_turns",
      "session_events",
      "sessions",
    ]) {
      const [visible] = await ownerSql<{ count: number }[]>`
        select count(*)::int as count from ${ownerSql(table)}`;
      expect({ table, count: visible!.count }).toEqual({ table, count: 0 });
    }
  } finally {
    await ownerSql.end();
  }
  let steady: Record<string, number> = {};
  try {
    for (const posture of ["nobypassrls", "bypassrls"] as const) {
      await shared.admin.unsafe(`alter role "${shared.ownerRole}" ${posture}`);
      steady = {};
      for (const [inventory, sessionId] of inventories) {
        // Before 1672-1677 an owner without BYPASSRLS saw no row: both returned [].
        expect(await list(inventory, null)).toEqual([
          { account_id: grant.accountId, workspace_id: workspaceId, session_id: sessionId },
        ]);
        // The keyset cursor still pages past it.
        expect(await list(inventory, sessionId)).toEqual([]);
        // The call's maintenance claim does not outlive it.
        expect(await claims()).toBe(0);
        steady[inventory] = await steadyCallBuffers(
          `select count(*) from opengeni_private.${inventory}(100, null, null)`,
        );
      }
    }
  } finally {
    await shared.admin.unsafe(`alter role "${shared.ownerRole}" nobypassrls`);
  }
  // Under production's owner (the last posture), planning the statement again
  // read catalog pages on every call: locally 39 and 99 buffers before, 5 and
  // 8 with one reused plan, 9 and 12 with the call's claim row. Under an owner
  // without BYPASSRLS the tables' existing row policies add their own reads.
  expect(steady).toEqual({
    list_pending_child_terminal_wake_repairs_v1: expect.any(Number),
    list_quiescence_receipt_wake_repairs_v1: expect.any(Number),
  });
  for (const buffers of Object.values(steady)) expect(buffers).toBeLessThan(20);
}, 300_000);
