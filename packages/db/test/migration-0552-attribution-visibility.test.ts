import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  applyCreditDebitAfterUse,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  getNestedAgentDepthDeploymentPolicy,
  getScheduledTaskRevisionAuthority,
  initializeSessionStartAtomically,
  migrate,
  nestedPostgresSqlState,
  provisionRoles,
  setSubjectRlsContext,
  withSessionActivityRlsContext,
} from "../src";

const repair = "0552_usage_allowances.sql";
const directory = fileURLToPath(new URL("../drizzle/", import.meta.url));

async function expectSqlState(action: () => Promise<unknown>, state: string) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(
    nestedPostgresSqlState(failure),
    failure instanceof Error ? failure.message : "No error",
  ).toBe(state);
}

test("0552 attribution lifecycle does not rewrite source visibility or read private source content", async () => {
  const source = await readFile(new URL(`../drizzle/${repair}`, import.meta.url), "utf8");
  expect(source).not.toMatch(/(?:ALTER|DROP|CREATE) POLICY session_visibility/iu);
  expect(source).not.toMatch(
    /(?:ALTER|DROP|CREATE) POLICY organization_usage_expected_visibility/iu,
  );
  const lifecycle = source
    .split("CREATE FUNCTION capture_usage_allowance_attribution()")[1]!
    .split("REVOKE ALL ON FUNCTION capture_usage_allowance_attribution()")[0]!;
  expect(lifecycle).not.toMatch(/FROM\s+(?:session_turns|scheduled_task_runs|usage_events)\b/iu);
  const counter = source
    .split("CREATE FUNCTION count_workspace_allowance_debit()")[1]!
    .split("CREATE TRIGGER credit_ledger_allowance_debit")[0]!;
  expect(counter).not.toMatch(/FROM\s+(?:session_turns|scheduled_task_runs|usage_events)\b/iu);
  for (const table of ["session_turns", "scheduled_task_runs", "usage_events"]) {
    expect(source).toContain(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    expect(source).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
  expect(source).toContain("Allowance attribution backfill did not converge");
  expect(source).toContain("receipt.quantity=amount");
  expect(source).toContain("receipt.idempotency_key='knowledge.query_cost:'||NEW.source_id");
});

test("real non-bypass owner migrates receipts while all original source policies remain byte-identical", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("0552-attribution-visibility");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("0552 owner-migrated PostgreSQL fixture unavailable");
    console.warn("SKIPPED 0552 owner-migrated attribution/visibility: PostgreSQL unavailable");
    return;
  }
  const owner = postgres(owned.ownerUrl, { max: 1 });
  const adminDb = createDb(owned.adminUrl, { max: 1 });
  let app: ReturnType<typeof createDb> | undefined;
  let appSql: postgres.Sql | undefined;
  try {
    await owner.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const deferred = (await readdir(directory)).filter(
      (file) => file.endsWith(".sql") && file >= repair,
    );
    for (const name of deferred) await owner`insert into schema_migrations(name) values(${name})`;
    await migrate(owned.ownerUrl);
    await owner`delete from schema_migrations where name >= ${repair}`;
    const [role] =
      await owned.admin`select rolsuper,rolbypassrls from pg_roles where rolname=${owned.ownerRole}`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });

    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `user:mirror:${crypto.randomUUID()}`;
    await owned.admin`insert into managed_accounts(id,name) values(${accountId},'Mirror test')`;
    await owned.admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Personal')`;
    await owned.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspaceId},${accountId})`;
    await owned.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
      values(${accountId},${subjectId},'owner','active',${workspaceId})`;
    await owned.admin`insert into session_tenancy_activations
      (account_id,activation_version,inventory_digest,parity_digest,activated_by)
      values(${accountId},1,${"0".repeat(64)},${"1".repeat(64)},'test')`;
    const sessionInput = {
      accountId,
      workspaceId,
      subjectId,
      visibility: "user_private" as const,
      initialMessage: "content must never enter the attribution receipt",
      resources: [],
      metadata: {},
      model: "scripted",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
      createdBy: { kind: "subject" as const, subjectId },
      createdByContext: {},
    };
    const initialize = async (sessionId: string) =>
      await withSessionActivityRlsContext(adminDb.db, { accountId, workspaceId }, async (tx) => {
        await setSubjectRlsContext(tx, subjectId);
        return await initializeSessionStartAtomically(tx, {
          accountId,
          workspaceId,
          sessionId,
          reasoningEffortFallback: "low",
          createdEventPayload: {},
        });
      });
    const historical = await createSession(adminDb.db, sessionInput);
    const turn = (await initialize(historical.id)).turn;
    expect(turn).not.toBeNull();
    const task = await createScheduledTask(adminDb.db, {
      accountId,
      workspaceId,
      name: "Accepted payer",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "scheduled content never mirrored",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId },
      metadata: {},
    });
    const causalHumanAuthority = await getScheduledTaskRevisionAuthority(adminDb.db, {
      accountId,
      workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
    });
    expect(causalHumanAuthority?.subjectId).toBe(subjectId);
    const depthPolicy = await getNestedAgentDepthDeploymentPolicy(adminDb.db);
    const scheduleId = crypto.randomUUID();
    const run = await createScheduledTaskRun(adminDb.db, {
      runId: scheduleId,
      workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
      taskExecutionDigest: task.executionDigest,
      triggerType: "scheduled",
      producerKey: `mirror:${scheduleId}`,
      acceptedExecutionSnapshot: {
        version: 1,
        task,
        resolvedModel: "scripted",
        resolvedReasoningEffort: "medium",
        resolvedLatencyMode: "standard",
        resolvedSandboxBackend: "none",
        resolvedSandboxOs: "linux",
        resolvedTools: [],
        resolvedFirstPartyMcpTools: [],
        resolvedFirstPartyMcpPermissions: [],
        resolvedVariableSet: null,
        resolvedRig: null,
        resolvedSlackBotConnection: null,
        targetSessionExecution: null,
        generatedSessionBinding: {
          createIdempotencyKey: `scheduled-task-run:${scheduleId}`,
          effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
          nestedAgentDepthPolicySource: depthPolicy.policySource,
          codexCompactionMode: "portable",
        },
        personalConnectionDelegations: [],
        personalResourceAuthoritySubjectId: null,
        causalHumanSubjectId: subjectId,
        causalHumanAuthority,
        xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
        xaiAuthoritySubjectId: null,
        connectionAuthoritySubjectId: null,
        triggerInitiator: { kind: "service", subjectId: "scheduler" },
        agentRunUsageIdempotencyKey: null,
        incidentPreflightRequired: false,
        alertOccurrenceLabels: null,
      },
    });
    const queryId = crypto.randomUUID();
    await owned.admin`insert into usage_events
      (account_id,workspace_id,session_id,event_type,quantity,unit,source_resource_type,source_resource_id,idempotency_key,occurred_at,initiator_context)
      values(${accountId},${workspaceId},${historical.id},'document.query_embedding_cost',7,'usd_micros',
        'knowledge_query',${queryId},${`knowledge.query_cost:${queryId}`},now(),
        ${owned.admin.json({
          creditDebitAttribution: { kind: "human", initiatingHumanSubjectId: subjectId },
          prompt: "private query text not mirrored",
        })})`;
    const snapshot = () => owned.admin`select c.relname,p.polname,p.polcmd,p.polpermissive,
      p.polroles::text as roles,pg_get_expr(p.polqual,p.polrelid) as qual,
      pg_get_expr(p.polwithcheck,p.polrelid) as check
      from pg_policy p join pg_class c on c.oid=p.polrelid
      where c.oid in ('session_turns'::regclass,'scheduled_task_runs'::regclass,'usage_events'::regclass)
      order by c.relname,p.polname`;
    const before = await snapshot();
    const installed = before.find(
      (row) => row.relname === "usage_events" && row.polname === "session_visibility_isolation",
    );
    expect(installed!.qual).toContain("organization_usage_policy_capability_active");
    expect(before.some((row) => row.polname === "organization_usage_expected_visibility")).toBe(
      false,
    );
    await migrate(owned.ownerUrl);
    expect([...(await snapshot())]).toEqual([...before]);
    const [backfill] =
      await owned.admin`select attribution from opengeni_private.usage_allowance_attribution_receipts
      where account_id=${accountId} and workspace_id=${workspaceId} and source_kind='turn' and source_id=${String(turn!.id)}`;
    expect(backfill!.attribution).toEqual({
      kind: "turn",
      turnId: turn!.id,
      initiatingHumanSubjectId: subjectId,
    });
    const [queryReceipt] =
      await owned.admin`select attribution,quantity from opengeni_private.usage_allowance_attribution_receipts
      where account_id=${accountId} and workspace_id=${workspaceId} and source_kind='knowledge_query' and source_id=${queryId}`;
    expect(queryReceipt!.attribution).toEqual({
      kind: "human",
      initiatingHumanSubjectId: subjectId,
    });
    expect(Number(queryReceipt!.quantity)).toBe(7);
    const [scheduleReceipt] =
      await owned.admin`select attribution from opengeni_private.usage_allowance_attribution_receipts
      where account_id=${accountId} and workspace_id=${workspaceId} and source_kind='schedule' and source_id=${run.id}`;
    expect(scheduleReceipt!.attribution).toEqual({
      kind: "human",
      initiatingHumanSubjectId: subjectId,
    });
    const [content] = await owned.admin`select column_name from information_schema.columns
      where table_schema='opengeni_private' and table_name='usage_allowance_attribution_receipts'
        and column_name in ('prompt','accepted_execution_snapshot','initiator_context','metadata')`;
    expect(content).toBeUndefined();

    await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
    const appUrl = new URL(owned.ownerUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owned.appPassword;
    app = createDb(appUrl.toString(), { max: 1 });
    appSql = postgres(appUrl.toString(), { max: 1 });
    const scope = { accountId, workspaceId };
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "TRIGGER"]) {
      const [permission] = await owned.admin`select
        has_table_privilege('opengeni_app','opengeni_private.usage_allowance_attribution_receipts',${privilege}) as allowed`;
      expect(permission!.allowed).toBe(false);
    }
    await expectSqlState(
      async () =>
        await appSql!`select * from opengeni_private.usage_allowance_attribution_receipts`,
      "42501",
    );
    const [execute] = await owned.admin`select
      has_function_privilege('opengeni_app','capture_usage_allowance_attribution()','EXECUTE') as allowed`;
    expect(execute!.allowed).toBe(false);
    await owner.begin(async (tx) => {
      await tx`select set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
      await tx`insert into opengeni_private.usage_allowance_capabilities
        values(pg_backend_pid(),pg_current_xact_id(),'public',${accountId},${workspaceId})`;
      // The live allowance capability does not grant private source visibility.
      const [hidden] =
        await tx`select count(*)::int as count from session_turns where id=${turn!.id}`;
      expect(hidden!.count).toBe(0);
      const [visible] =
        await tx`select count(*)::int as count from opengeni_private.usage_allowance_attribution_receipts
        where account_id=${accountId} and workspace_id=${workspaceId}
          and source_id in (${String(turn!.id)},${run.id},${queryId})`;
      expect(visible!.count).toBe(3);
      const changed =
        await tx`update opengeni_private.usage_allowance_attribution_receipts set attribution='{"kind":"service"}'::jsonb
        where account_id=${accountId} and workspace_id=${workspaceId}`;
      expect(changed.count).toBe(0);
      await tx`delete from opengeni_private.usage_allowance_capabilities where backend_pid=pg_backend_pid()`;
    });
    await appSql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id',${accountId},true),
        set_config('opengeni.workspace_id',${workspaceId},true),
        set_config('opengeni.subject_id','user:not-the-owner',true),
        set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
      for (const table of ["sessions", "session_turns", "usage_events"]) {
        const [hidden] = await tx.unsafe(
          `select count(*)::int as count from ${table}
          where ${table === "sessions" ? "id" : "session_id"} = $1`,
          [historical.id],
        );
        expect(hidden!.count).toBe(0);
      }
    });

    const newSession = await createSession(adminDb.db, sessionInput);
    const newTurn = (await initialize(newSession.id)).turn;
    expect(newTurn).not.toBeNull();
    const debit = {
      ...scope,
      type: "model",
      amountMicros: 11,
      sourceType: "model_response",
      sourceId: `${turn!.id}:response`,
      idempotencyKey: crypto.randomUUID(),
    };
    await applyCreditDebitAfterUse(app.db, debit);
    await applyCreditDebitAfterUse(app.db, debit);
    await applyCreditDebitAfterUse(app.db, {
      ...scope,
      type: "model",
      amountMicros: 13,
      sourceType: "model_response",
      sourceId: "old-writer-response",
      idempotencyKey: crypto.randomUUID(),
      metadata: { turnId: newTurn!.id, initiatingHumanSubjectId: "user:spoof" },
    });
    const freshQueryId = crypto.randomUUID();
    await appSql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id',${accountId},true),
        set_config('opengeni.workspace_id',${workspaceId},true)`;
      await tx`insert into usage_events
        (account_id,workspace_id,event_type,quantity,unit,source_resource_type,source_resource_id,idempotency_key,occurred_at,initiator_context)
        values(${accountId},${workspaceId},'document.query_embedding_cost',3,'usd_micros',
          'knowledge_query',${freshQueryId},${`knowledge.query_cost:${freshQueryId}`},now(),
          ${tx.json({ creditDebitAttribution: { kind: "human", initiatingHumanSubjectId: subjectId } })})`;
      await tx`insert into credit_ledger_entries
        (account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key)
        values(${accountId},${workspaceId},'query',-3,'knowledge_query',${freshQueryId},${crypto.randomUUID()})`;
    });
    const otherWorkspace = crypto.randomUUID();
    await owned.admin`insert into workspaces(id,account_id,name) values(${otherWorkspace},${accountId},'Other')`;
    await owned.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${otherWorkspace},${accountId})`;
    await applyCreditDebitAfterUse(app.db, {
      accountId,
      workspaceId: otherWorkspace,
      type: "model",
      amountMicros: 2,
      sourceType: "model_response",
      sourceId: `${turn!.id}:response`,
      idempotencyKey: crypto.randomUUID(),
    });
    const foreignCounters =
      await owned.admin`select subject_id,used::int as used from opengeni_private.workspace_allowance_counters
      where account_id=${accountId} and workspace_id=${otherWorkspace}`;
    expect([...foreignCounters]).toEqual([{ subject_id: "", used: 2 }]);
    await applyCreditDebitAfterUse(app.db, {
      ...scope,
      type: "query",
      amountMicros: 7,
      sourceType: "knowledge_query",
      sourceId: queryId,
      idempotencyKey: crypto.randomUUID(),
    });
    // Wrong quantity/source tenancy never falls back to a supplied turn.
    await applyCreditDebitAfterUse(app.db, {
      ...scope,
      type: "query",
      amountMicros: 8,
      sourceType: "knowledge_query",
      sourceId: queryId,
      idempotencyKey: crypto.randomUUID(),
      metadata: { turnId: newTurn!.id },
    });
    await applyCreditDebitAfterUse(app.db, {
      ...scope,
      type: "schedule",
      amountMicros: 5,
      sourceType: "scheduled_task_run",
      sourceId: run.id,
      idempotencyKey: crypto.randomUUID(),
      metadata: { turnId: newTurn!.id, initiatingHumanSubjectId: "user:spoof" },
    });
    const counters =
      await owned.admin`select subject_id,used::int as used from opengeni_private.workspace_allowance_counters
      where account_id=${accountId} and workspace_id=${workspaceId} order by subject_id`;
    expect([...counters]).toEqual([
      { subject_id: "", used: 47 },
      { subject_id: subjectId, used: 39 },
    ]);
    await expectSqlState(
      async () =>
        await owned.admin.begin(async (tx) => {
          await tx`select set_config('opengeni.session_variable_set_attachments_v1','1',true),
          set_config('opengeni.lossless_content_writer','1',true)`;
          await tx`update session_turns set initiating_human_subject_id='user:changed' where id=${turn!.id}`;
        }),
      "55000",
    );
    await expectSqlState(
      async () =>
        await owned.admin`update usage_events set quantity=8
      where account_id=${accountId} and idempotency_key=${`knowledge.query_cost:${queryId}`}`,
      "23514",
    );
    const [closed] =
      await owned.admin`select count(*)::int as count from opengeni_private.usage_allowance_capabilities`;
    expect(closed!.count).toBe(0);
    expect([...(await snapshot())]).toEqual([...before]);
  } finally {
    await appSql?.end();
    await app?.close();
    await adminDb.close();
    await owner.end();
    await owned.release();
  }
}, 900_000);
