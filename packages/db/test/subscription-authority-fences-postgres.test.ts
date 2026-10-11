// Migration 0716: the fences compare subscription authority (design
// docs/design/subscription-core-2026-10-07.md, 5.3 "PR 0b: authority
// compatibility and fences" and "Findings in earlier merged work", rows 2 and
// 3). The database is migrated by the NOSUPERUSER, NOBYPASSRLS owner; runtime
// work runs as the restricted application role through the real dispatcher,
// inbox planner and claim. Only the rows a fence must refuse are written by
// the superuser, in transactions that roll back. Rows staged before 0716 are
// the pre-merge inventory's fixtures. Receipts are append-only, so the
// receipt switch runs last.
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  MemoryEventBus,
  testSettings,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../../../apps/worker/src/activities/scheduled-tasks";
import type { ActivityServices } from "../../../apps/worker/src/activities/types";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createClaudeSubscriptionAccount,
  createDb,
  createScheduledTask,
  createSession,
  createXaiSubscriptionCredential,
  disconnectClaudeSubscriptionAccount,
  disconnectXaiSubscriptionCredential,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  sendAgentMessageInTransaction,
  setInitialActiveClaudeCredential,
  submitHumanPromptInTransaction,
  withRlsContext,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { subscriptionAuthorityCompatForCarriersInTransaction } from "../src/subscription-core-acceptance-authority";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const FENCES = "0716_subscription_authority_fences.sql";
const EMPTY = { version: 2, personal: [] };
const ORGANIZATION_CLAUDE = { version: 1, scope: "organization" };
let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
/** The application role's database: the staging client before 0716, then `client`. */
let app: DbClient["db"] | null = null;
let appUrl = "";
/** Runtime posture right after applying 0716 to a provisioned database, then after provisioning. */
let posture: { unprovisioned: string[]; provisioned: string[] } | null = null;

type Grant = { accountId: string; workspaceId: string; subjectId: string };
type Scheduled = Grant & { membershipId: string };
type Run = {
  taskId: string;
  runId: string;
  occurrenceId: string;
  sessionId: string;
  workflowId: string;
  accepted: Record<string, unknown>;
};

type Finding = { finding: string; row_id: string; account_id: string };

/** Rows accepted before 0716 that its comparisons refuse: the inventory's fixtures. */
let staged: {
  accounts: string[];
  inboxTurn: string;
  inboxUpdate: string;
  drifted: Run;
  revoked: Run & { grant: Scheduled };
  ownerlessTask: string;
  /** A personal Claude connect before 0716 under the owner without BYPASSRLS. */
  claudeLockRefusal: string;
  /** The live `user` Claude credential of the drifted run's owner. */
  liveClaudeCredential: string;
  /** The authorities of the personal accounts disconnected before 0716, by kind. */
  disconnected: Record<string, { id: string; status: string }>;
  /** The inventory as an operator runs it before deploying 0716. */
  inventoryBefore: Finding[];
} | null = null;

function personal(membershipId: string, generation = 1) {
  return {
    version: 2,
    personal: [
      { provider: "codex", ownerMembershipId: membershipId, authorityGeneration: generation },
    ],
  };
}

/** The SQLSTATE and message of the first database error in the chain. */
function refusal(error: unknown): string {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return `${candidate.code} ${String(candidate.message)}`;
    }
    current = candidate.cause;
  }
  return `? ${String(error)}`;
}

class Rollback extends Error {}

/** Run `work` as the superuser and roll back: `accepted`, or the refusal. */
async function attempt(work: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<string> {
  try {
    await database!.admin.begin(async (tx) => {
      await work(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return "accepted";
    return refusal(error);
  }
  return "accepted";
}

async function scope(tx: postgres.TransactionSql, grant: Grant): Promise<void> {
  await tx`select set_config('opengeni.account_id', ${grant.accountId}, true),
    set_config('opengeni.workspace_id', ${grant.workspaceId}, true),
    set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
}

/** Fixture only: a frozen v2 value (the immutable slot admits only replica writes here). */
async function freeze(
  table: "session_turns" | "session_system_updates",
  id: string,
  value: unknown,
): Promise<void> {
  await database!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const frozen = value === null ? null : JSON.stringify(value);
    if (table === "session_turns") {
      await tx`update session_turns set subscription_authority = ${frozen}::text::jsonb where id = ${id}::uuid`;
    } else {
      await tx`update session_system_updates set subscription_authority = ${frozen}::text::jsonb
        where id = ${id}::uuid`;
    }
  });
}

// ---------------------------------------------------------------- inbox

async function inboxGrant(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(app!, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Authority fences",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Authority fences",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

async function newSession(grant: Grant): Promise<string> {
  const session = await createSession(app!, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Work",
    resources: [],
    metadata: {},
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return session.id;
}

async function prompt(grant: Grant, sessionId: string): Promise<void> {
  await withWorkspaceSubjectSessionActivityRls(app!, grant.workspaceId, grant.subjectId, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      subjectId: grant.subjectId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Continue",
      resources: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      reasoningEffortFallback: "medium",
      source: "user",
      personalConnectionDelegations: [],
      mcpAccountBindings: [],
    }),
  );
}

async function claim(grant: Grant, sessionId: string, workflowId = `session-${sessionId}`) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(app!, grant.workspaceId, {
    sessionId,
    workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`Expected a claim: ${claimed.reason}`);
  return { turn: claimed.turn, attemptId };
}

/** A human turn that started and finished: the session's receiving context. */
async function contextTurn(grant: Grant, sessionId: string): Promise<string> {
  await prompt(grant, sessionId);
  const claimed = await claim(grant, sessionId);
  for (const started of [true, false]) {
    const settled = await applySessionTurnSettlement(app!, grant.workspaceId, {
      sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.attemptId,
      turnStatus: started ? "running" : "completed",
      sessionStatus: started ? "running" : "idle",
      activeTurnId: started ? claimed.turn.id : null,
      events: started ? [{ type: "turn.started", payload: { turnId: claimed.turn.id } }] : [],
    });
    if (settled.action !== "settled") throw new Error("Expected a settlement");
  }
  return claimed.turn.id;
}

/**
 * A pending causal update of the session (a wait timeout or goal
 * continuation) carrying its causal turn's v1 execution values, as the
 * writers copy them.
 */
async function causalUpdate(
  grant: Grant,
  sessionId: string,
  causalTurnId: string,
  value: unknown,
  kind: "session_wait_timeout" | "goal_continuation" = "session_wait_timeout",
): Promise<string> {
  const id = crypto.randomUUID();
  await database!.admin.begin(async (tx) => {
    await scope(tx, grant);
    await tx`insert into session_system_updates (
        id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
        payload, lineage, mcp_account_bindings, personal_connection_delegations,
        xai_provider_account_authority_snapshot, claude_provider_account_authority_snapshot,
        subscription_authority
      ) select
        ${id}::uuid, ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${sessionId}::uuid,
        ${kind}, ${id}, ${`fences:${id}`}, 'fixture', ${JSON.stringify({ type: kind })}::text::jsonb,
        ${JSON.stringify({ causalTurnId })}::text::jsonb,
        causal.mcp_account_bindings, causal.personal_connection_delegations,
        causal.xai_provider_account_authority_snapshot,
        causal.claude_provider_account_authority_snapshot,
        ${value === null ? null : JSON.stringify(value)}::text::jsonb
      from session_turns causal where causal.id = ${causalTurnId}::uuid`;
  });
  return id;
}

/**
 * Deliver `updates` into a new running system turn that borrows the receiving
 * context and carries `value`, as the planner writes it (the updates point at
 * the turn before it is inserted).
 */
async function deliverInto(
  tx: postgres.TransactionSql,
  grant: Grant,
  contextTurnId: string,
  updates: string[],
  value: unknown,
): Promise<string> {
  const turnId = crypto.randomUUID();
  await scope(tx, grant);
  await tx`set local session_replication_role = replica`;
  await tx`update session_system_updates
    set state = 'delivered', delivered_turn_id = ${turnId}::uuid, delivered_at = now(),
      delivered_history_item_id = gen_random_uuid()
    where id = any(${updates}::uuid[])`;
  await tx`set local session_replication_role = origin`;
  await tx`insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, source, position, prompt, model, reasoning_effort, sandbox_backend,
      initiating_human_subject_id, personal_connection_delegations, mcp_account_bindings,
      xai_provider_account_authority_snapshot, claude_provider_account_authority_snapshot,
      execution_context_turn_id, subscription_authority
    ) select ${turnId}::uuid, context.account_id, context.workspace_id, context.session_id,
      gen_random_uuid(), context.temporal_workflow_id, 'running', 'system',
      (select max(other.position) + 1 from session_turns other
        where other.session_id = context.session_id),
      'delivery', context.model, context.reasoning_effort, context.sandbox_backend,
      coalesce(context.initiating_human_subject_id,
        case when context.initiator_kind = 'subject' then context.initiator_subject_id end),
      context.personal_connection_delegations, context.mcp_account_bindings,
      context.xai_provider_account_authority_snapshot,
      context.claude_provider_account_authority_snapshot, context.id,
      ${value === null ? null : JSON.stringify(value)}::text::jsonb
    from session_turns context where context.id = ${contextTurnId}::uuid`;
  return turnId;
}

function delivery(grant: Grant, contextTurnId: string, updates: string[], value: unknown) {
  return attempt((tx) => deliverInto(tx, grant, contextTurnId, updates, value));
}

// ------------------------------------------------------------ scheduled

async function scheduledGrant(): Promise<Scheduled> {
  const admin = database!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('authority fences') returning id::text as id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}::uuid, 'authority fences') returning id::text as id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${account!.id}::uuid)`;
  const subjectId = `subject-${crypto.randomUUID()}`;
  const [membership] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${account!.id}::uuid, ${subjectId}, 'active', ${workspace!.id}::uuid)
    returning id::text as id`;
  await admin`insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values (${account!.id}::uuid, ${workspace!.id}::uuid, ${subjectId}, 'owner', '[]'::jsonb)`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId,
    membershipId: membership!.id,
  };
}

/** The owner's `user` Claude credential and its accepted authority snapshot. */
async function claudeUserCredential(grant: Scheduled) {
  const identity = crypto.randomUUID();
  const claude = await createClaudeSubscriptionAccount(app!, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    scope: "user",
    encryptionKey: new Uint8Array(32).fill(23),
    secret: {
      version: 1,
      token: "sk-ant-oat01-authority-fences",
      identity: { accountUuid: identity, deviceId: "c".repeat(64) },
    },
    providerAccountId: identity,
    label: null,
    accountEmail: null,
    planType: "claude_max",
    expiresAt: null,
  });
  await setInitialActiveClaudeCredential(app!, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    authoritySnapshot: claude.authoritySnapshot,
    credentialId: claude.account.id,
  });
  return claude;
}

/** The owner's `user` SuperGrok credential. */
function xaiUserCredential(grant: Scheduled) {
  return createXaiSubscriptionCredential(app!, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    scope: "user",
    encryptionKey: new Uint8Array(32).fill(23),
    secret: { version: 1, accessToken: "authority-fences" },
    providerAccountId: `authority-fences-${crypto.randomUUID()}`,
  });
}

/** Disconnect both personal accounts as their owner, through the real writers. */
async function disconnectPersonal(
  grant: Scheduled,
  claude: { account: { id: string }; authoritySnapshot: unknown },
  xai: { account: { id: string }; authoritySnapshot: unknown },
): Promise<void> {
  const owner = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
  };
  expect(
    await disconnectClaudeSubscriptionAccount(app!, {
      ...owner,
      credentialId: claude.account.id,
      authoritySnapshot: claude.authoritySnapshot as never,
    }),
  ).toBe(true);
  expect(
    await disconnectXaiSubscriptionCredential(app!, {
      ...owner,
      credentialId: xai.account.id,
      authoritySnapshot: xai.authoritySnapshot as never,
    }),
  ).toBe(true);
}

/** The organization authorities of personal credentials, by resource kind. */
async function authoritiesOf(credentialIds: string[]) {
  const rows = await database!.admin<{ kind: string; id: string; status: string }[]>`
    select resource_kind as kind, id::text as id, status
    from organization_user_resource_authorities where resource_id = any(${credentialIds}::uuid[])`;
  return Object.fromEntries(rows.map((row) => [row.kind, { id: row.id, status: row.status }]));
}

/**
 * Before 0716 an owner without BYPASSRLS cannot lock the membership a
 * personal Claude connect needs (0598 missed the lock policy; 0716 adds it),
 * so the pre-0716 fixtures connect as a deployment whose owner is not bound by
 * the membership policies would. The schema is restored before staging goes on.
 */
async function withMembershipRlsUnforced<T>(work: () => Promise<T>): Promise<T> {
  await database!.admin`alter table organization_memberships no force row level security`;
  try {
    return await work();
  } finally {
    await database!.admin`alter table organization_memberships force row level security`;
  }
}

async function claudeTask(grant: Scheduled, snapshot: unknown): Promise<string> {
  const task = await createScheduledTask(app!, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: `authority-fences-${crypto.randomUUID()}`,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `authority-fences-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Use the accepted subscription pool",
      model: "scripted-model",
      resources: [],
      tools: [],
      metadata: {},
    },
    claudeProviderAccountAuthoritySnapshot: snapshot as never,
    metadata: {},
  });
  return task.id;
}

/** Fire the task through the real dispatcher (admission, occurrence, generated session). */
async function dispatch(grant: Scheduled, taskId: string): Promise<Run> {
  const db = app!;
  const scheduler = createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({ databaseUrl: appUrl, sandboxBackend: "none" }),
        db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
  const dispatched = await scheduler.dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey: `authority-fences:${crypto.randomUUID()}`,
  });
  if (dispatched.action !== "start") throw new Error(`dispatch ${JSON.stringify(dispatched)}`);
  const [row] = await database!.admin<
    { runId: string; occurrenceId: string; accepted: Record<string, unknown> }[]
  >`
    select run.id::text as "runId", occurrence.id::text as "occurrenceId",
      run.accepted_execution_snapshot as accepted
    from scheduled_task_runs run
    join session_system_updates occurrence on occurrence.scheduled_task_run_id = run.id
    where run.task_id = ${taskId}::uuid and run.session_id = ${dispatched.sessionId}::uuid`;
  return {
    taskId,
    runId: row!.runId,
    occurrenceId: row!.occurrenceId,
    sessionId: dispatched.sessionId,
    workflowId: dispatched.workflowId,
    accepted: row!.accepted,
  };
}

/** The live-authority check as the application role, in the run's scope. */
async function liveAuthority(grant: Grant, runId: string): Promise<string | null> {
  return await withRlsContext(
    client!.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{ denial: string | null }>(
        tx,
        sql`select validate_scheduled_agent_run_live_authority(
          ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${runId}::uuid) as denial`,
      );
      return row!.denial;
    },
  );
}

/**
 * Copy a row of `table` with `overrides` (rolled back): what the insert fences
 * decide. A run's accepted execution digest is recomputed for its snapshot;
 * `prepare` runs first, in the same transaction.
 */
function copyRow(
  table: "scheduled_task_runs" | "session_system_updates",
  grant: Grant,
  id: string,
  overrides: Record<string, unknown>,
  prepare?: (tx: postgres.TransactionSql) => Promise<unknown>,
) {
  return attempt(async (tx) => {
    await scope(tx, grant);
    await prepare?.(tx);
    await tx`insert into opengeni_private.scheduled_personal_resource_capabilities (
        backend_pid, transaction_id, capability_kind
      ) values (pg_backend_pid(), pg_current_xact_id(), 'run_admit')`;
    await tx.unsafe(
      `insert into ${table}
        select (jsonb_populate_record(null::${table}, source.merged${
          table === "scheduled_task_runs"
            ? ` || jsonb_build_object('accepted_execution_digest', encode(digest(convert_to(
                (source.merged -> 'accepted_execution_snapshot')::text, 'UTF8'), 'sha256'), 'hex'))`
            : ""
        })).*
        from (select to_jsonb(source_row) || $1::text::jsonb as merged
          from ${table} source_row where source_row.id = $2::uuid) source`,
      [JSON.stringify(overrides), id],
    );
  });
}

function runCopy(grant: Grant, run: Run, accepted: Record<string, unknown>) {
  return copyRow("scheduled_task_runs", grant, run.runId, {
    id: crypto.randomUUID(),
    producer_key: `authority-fences:${crypto.randomUUID()}`,
    status: "queued",
    session_id: null,
    trigger_event_id: null,
    completed_at: null,
    error: null,
    accepted_execution_snapshot: accepted,
  });
}

/**
 * Copy the run's occurrence with `overrides` (rolled back). A firing's dedupe
 * key names its run and is unique in the session, so the original moves aside.
 */
function occurrenceCopy(grant: Grant, run: Run, overrides: Record<string, unknown>) {
  return copyRow(
    "session_system_updates",
    grant,
    run.occurrenceId,
    {
      id: crypto.randomUUID(),
      dedupe_key: `scheduled-task-run:${run.runId}`,
      state: "pending",
      delivered_turn_id: null,
      delivered_at: null,
      delivered_history_item_id: null,
      ...overrides,
    },
    async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update session_system_updates set dedupe_key = ${`moved:${run.occurrenceId}`}
        where id = ${run.occurrenceId}::uuid`;
      await tx`set local session_replication_role = origin`;
    },
  );
}

async function inventory(): Promise<Finding[]> {
  const runbook = await readFile(new URL("../../../docs/deployment.md", import.meta.url), "utf8");
  const section = runbook.slice(runbook.indexOf("### Subscription authority fences (0716)"));
  const start = section.indexOf("```sql\n") + "```sql\n".length;
  const query = section.slice(start, section.indexOf("\n```", start));
  const rows =
    await database!.admin.unsafe<
      { finding: string; account_id: string; workspace_id: string; row_id: string }[]
    >(query);
  return rows.map((row) => ({
    finding: row.finding,
    row_id: String(row.row_id),
    account_id: String(row.account_id),
  }));
}

/** Rows the comparisons of 0716 refuse, written while the previous fences accept them. */
async function stageRowsTheFencesRefuse(): Promise<NonNullable<typeof staged>> {
  // An internal turn that borrowed a receiving context but carries another
  // v2 value than the context's, delivering an update frozen with a third.
  const inbox = await inboxGrant();
  const sessionId = await newSession(inbox);
  const context = await contextTurn(inbox, sessionId);
  await freeze("session_turns", context, personal(crypto.randomUUID()));
  const inboxUpdate = await causalUpdate(inbox, sessionId, context, personal(crypto.randomUUID()));
  let inboxTurn = "";
  await database!.admin.begin(async (tx) => {
    inboxTurn = await deliverInto(tx, inbox, context, [inboxUpdate], EMPTY);
  });

  // A run whose accepted Claude values drifted from its occurrence, its
  // generated session and its causal subject rule.
  const drift = await scheduledGrant();
  const claudeLockRefusal = await claudeUserCredential(drift).then(() => "accepted", refusal);
  const driftCredential = await withMembershipRlsUnforced(() => claudeUserCredential(drift));
  const driftSnapshot = driftCredential.authoritySnapshot;
  const drifted = await dispatch(drift, await claudeTask(drift, driftSnapshot));
  await database!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update scheduled_task_runs set accepted_execution_snapshot = drifted.snapshot,
        accepted_execution_digest = encode(digest(convert_to(drifted.snapshot::text, 'UTF8'),
          'sha256'), 'hex')
      from (select accepted_execution_snapshot
          || '{"claudeAuthoritySubjectId":"user:someone-else"}'::jsonb as snapshot
        from scheduled_task_runs where id = ${drifted.runId}::uuid) drifted
      where id = ${drifted.runId}::uuid`;
    await tx`update session_system_updates
      set claude_provider_account_authority_snapshot = ${JSON.stringify(ORGANIZATION_CLAUDE)}::text::jsonb,
        subscription_authority = ${JSON.stringify(personal(drift.membershipId))}::text::jsonb
      where id = ${drifted.occurrenceId}::uuid`;
    await tx`update sessions
      set initial_claude_provider_account_authority_snapshot = ${JSON.stringify(ORGANIZATION_CLAUDE)}::text::jsonb
      where id = ${drifted.sessionId}::uuid`;
  });
  // A task whose `user` Claude snapshot lost its owner: never admissible.
  const ownerlessTask = await claudeTask(drift, driftSnapshot);
  await database!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update scheduled_tasks set owner_subject_id = null where id = ${ownerlessTask}::uuid`;
  });

  // A live run whose owner then disconnected the accepted `user` Claude
  // account, and their SuperGrok account (connected after the firing, so the
  // run's SuperGrok snapshot stays `workspace`). Before 0716 neither
  // disconnect revokes its authority under this owner; 0716 repairs both.
  const revokedGrant = await scheduledGrant();
  const credential = await withMembershipRlsUnforced(() => claudeUserCredential(revokedGrant));
  const revoked = await dispatch(
    revokedGrant,
    await claudeTask(revokedGrant, credential.authoritySnapshot),
  );
  const xai = await xaiUserCredential(revokedGrant);
  await disconnectPersonal(revokedGrant, credential, xai);
  const disconnected = await authoritiesOf([credential.account.id, xai.account.id]);
  const accounts = [inbox.accountId, drift.accountId, revokedGrant.accountId];
  return {
    accounts,
    inboxTurn,
    inboxUpdate,
    drifted,
    revoked: { ...revoked, grant: revokedGrant },
    ownerlessTask,
    claudeLockRefusal,
    liveClaudeCredential: driftCredential.account.id,
    disconnected,
    inventoryBefore: (await inventory()).filter((row) => accounts.includes(row.account_id)),
  };
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-authority-fences");
  if (!database) throw new Error("Real PostgreSQL is required");
  // Stage a provisioned database without 0716, as a deployment is before it.
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values (${FENCES})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await owner.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  appUrl = url.toString();
  const before = createDb(appUrl, { max: 2 });
  try {
    app = before.db;
    staged = await stageRowsTheFencesRefuse();
  } finally {
    await before.close();
  }
  // A rolling migration keeps the previous binary's runtime posture until
  // roles are provisioned again: apply 0716 alone, evaluate as the runtime
  // role, then provision and evaluate again.
  const ownerAgain = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await ownerAgain`delete from schema_migrations where name = ${FENCES}`;
    await migrate(database.ownerUrl);
    const [applied] = await ownerAgain<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name = ${FENCES}`;
    if (applied?.count !== 1) throw new Error("0716 was not applied by the second migrate");
  } finally {
    await ownerAgain.end();
  }
  const options = {
    rlsStrategy: "force" as const,
    expectedRole: "opengeni_app",
    targetSchema: "public",
    requiredRuntimeRoutines: [],
  };
  const evaluate = async () => {
    const db = createDb(appUrl, { max: 1 });
    try {
      return evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(db.db, options),
        options,
      );
    } finally {
      await db.close();
    }
  };
  const unprovisioned = await evaluate();
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  posture = { unprovisioned, provisioned: await evaluate() };
  client = createDb(appUrl, { max: 4 });
  app = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
});

describe.skipIf(!realDb)("0716 subscription authority fences", () => {
  test("applies over a provisioned database and keeps the runtime posture before and after provisioning", async () => {
    expect(posture).toEqual({ unprovisioned: [], provisioned: [] });
    const [identity] = await rawRows<{ role: string; superuser: boolean; bypass: boolean }>(
      client!.db,
      sql`select current_user::text as role, rolsuper as superuser, rolbypassrls as bypass
          from pg_roles where rolname = current_user`,
    );
    expect(identity).toEqual({ role: "opengeni_app", superuser: false, bypass: false });
  });

  test("helpers are owner-only, definer fences search pg_temp last, the callers inherit the live check", async () => {
    const routines = await database!.admin<{ name: string; config: string[]; app: boolean }[]>`
      select routine::text as name, coalesce(proconfig, '{}') as config,
        has_function_privilege('opengeni_app', routine, 'EXECUTE') as app
      from unnest(array[
        'opengeni_subscription_internal.subscription_v2_copy_matches(jsonb,jsonb)',
        'opengeni_subscription_internal.subscription_scheduled_firing_v2(uuid,uuid,uuid,bigint)',
        'opengeni_subscription_internal.subscription_personal_entry_serviceable(uuid,jsonb)',
        'opengeni_subscription_internal.subscription_scheduled_run_personal_entries(uuid,uuid,uuid)',
        'opengeni_private.fence_session_execution_context()',
        'opengeni_private.advance_session_execution_context()',
        'opengeni_private.fence_inbox_execution_context()'
      ]::regprocedure[]) routine
      join pg_proc on pg_proc.oid = routine`;
    expect(routines).toHaveLength(7);
    for (const routine of routines) {
      expect(routine.config).toEqual(["search_path=pg_catalog, public, opengeni_private, pg_temp"]);
      if (routine.name.startsWith("opengeni_subscription_internal.")) {
        expect(routine.app).toBe(false);
      }
    }
    // 0447, 0452 and 0459 call the live check, so they inherit its refusals.
    const callers = await database!.admin<{ name: string; calls: boolean }[]>`
      select routine::text as name,
        pg_get_functiondef(routine) like '%validate_scheduled_agent_run_live_authority(%' as calls
      from unnest(array[
        'opengeni_private.guard_host_mcp_scheduled_turn_authority()',
        'opengeni_private.guard_external_link_work_snapshot()',
        'opengeni_private.mcp_operation_command_scoped(jsonb,text,jsonb)'
      ]::regprocedure[]) routine`;
    expect(callers.map((caller) => caller.calls)).toEqual([true, true, true]);
    const [trigger] = await database!.admin<{ definition: string }[]>`
      select pg_get_triggerdef(oid) as definition from pg_trigger
      where tgrelid = 'session_turns'::regclass and tgname = 'scheduled_turn_execution_immutable'`;
    expect(trigger!.definition).toContain(
      "xai_provider_account_authority_snapshot, claude_provider_account_authority_snapshot, subscription_authority ON",
    );
  });

  test("a personal Claude account connects under an owner without BYPASSRLS (0598's missing lock policy)", async () => {
    expect(staged!.claudeLockRefusal).toBe(
      "42501 active organization membership and workspace grant required",
    );
    const grant = await scheduledGrant();
    const claude = await claudeUserCredential(grant);
    expect(claude.authoritySnapshot).toMatchObject({ version: 1, scope: "user" });
    // The policy permits the lock only, never a rewrite.
    const [policy] = await database!.admin<{ command: string; check: string | null }[]>`
      select polcmd::text as command, pg_get_expr(polwithcheck, polrelid) as check
      from pg_policy
      where polrelid = 'organization_memberships'::regclass
        and polname = 'claude_subscription_membership_lock'`;
    expect(policy).toEqual({ command: "w", check: "false" });
  });

  test("a personal SuperGrok or Claude disconnect revokes its authority; 0716 revoked those left active", async () => {
    // Before 0716 the owner's disconnects deleted both credentials and left
    // both authorities active.
    const { claude_subscription: claude, xai_subscription: xai } = staged!.disconnected;
    expect([claude?.status, xai?.status]).toEqual(["active", "active"]);
    const repaired = await database!.admin<{ status: string }[]>`
      select status from organization_user_resource_authorities
      where id = any(${[claude!.id, xai!.id]}::uuid[])`;
    expect(repaired.map((row) => row.status)).toEqual(["revoked", "revoked"]);
    // A connected account's authority is untouched.
    expect(await authoritiesOf([staged!.liveClaudeCredential])).toMatchObject({
      claude_subscription: { status: "active" },
    });
    // From 0716 the disconnect itself revokes, and only its own kind.
    const grant = await scheduledGrant();
    const connected = {
      claude: await claudeUserCredential(grant),
      xai: await xaiUserCredential(grant),
    };
    const ids = [connected.claude.account.id, connected.xai.account.id];
    expect(await authoritiesOf(ids)).toMatchObject({
      claude_subscription: { status: "active" },
      xai_subscription: { status: "active" },
    });
    await disconnectPersonal(grant, connected.claude, connected.xai);
    expect(await authoritiesOf(ids)).toMatchObject({
      claude_subscription: { status: "revoked" },
      xai_subscription: { status: "revoked" },
    });
    const policies = await database!.admin<{ name: string; operation: string; check: string }[]>`
      select polname as name, polcmd::text as operation, pg_get_expr(polwithcheck, polrelid) as check
      from pg_policy
      where polrelid = 'organization_user_resource_authorities'::regclass
        and polname in ('claude_subscription_capability_revoke', 'xai_subscription_capability_revoke')
      order by polname`;
    expect([...policies]).toEqual([
      {
        name: "claude_subscription_capability_revoke",
        operation: "w",
        check: "((resource_kind = 'claude_subscription'::text) AND (status = 'revoked'::text))",
      },
      {
        name: "xai_subscription_capability_revoke",
        operation: "w",
        check: "((resource_kind = 'xai_subscription'::text) AND (status = 'revoked'::text))",
      },
    ]);
  });

  test("pre-merge inventory: lists exactly the staged rows 0716 refuses or repairs", async () => {
    const listed = (rows: Finding[]) =>
      rows
        .filter((row) => staged!.accounts.includes(row.account_id))
        .map((row) => `${row.finding} ${row.row_id}`)
        .sort();
    const refused = [
      `inbox_turn_v2 ${staged!.inboxTurn}`,
      `inbox_update_v2 ${staged!.inboxUpdate}`,
      `scheduled_occurrence_claude ${staged!.drifted.occurrenceId}`,
      `scheduled_occurrence_v2 ${staged!.drifted.occurrenceId}`,
      `scheduled_run_claude_accepted ${staged!.drifted.runId}`,
      `scheduled_run_claude_authority ${staged!.revoked.runId}`,
      `scheduled_session_claude ${staged!.drifted.runId}`,
      `scheduled_task_claude_subject ${staged!.ownerlessTask}`,
    ];
    const repaired = Object.values(staged!.disconnected).map(
      (authority) => `disconnected_personal_authority ${authority.id}`,
    );
    // As an operator runs it before deploying 0716.
    expect(listed(staged!.inventoryBefore)).toEqual([...refused, ...repaired].sort());
    // After 0716 the repaired authorities are revoked; the refused rows stay.
    expect(listed(await inventory())).toEqual([...refused].sort());
  });

  describe("Codex v2 in the inbox fence (acts on deploy)", () => {
    test("a delivery into a receiving context copies the context's value; any other is refused", async () => {
      const grant = await inboxGrant();
      const receiving = await newSession(grant);
      const context = await contextTurn(grant, receiving);
      const value = personal(crypto.randomUUID());
      await freeze("session_turns", context, value);
      // Through the planner and writer: an agent message joins the context.
      const sending = await newSession(grant);
      await prompt(grant, sending);
      const sender = await claim(grant, sending);
      await withWorkspaceSessionActivityRls(app!, grant.workspaceId, (tx) =>
        sendAgentMessageInTransaction(tx, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          targetSessionId: receiving,
          actor: {
            type: "agent_attempt",
            sessionId: sending,
            turnId: sender.turn.id,
            attemptId: sender.attemptId,
            executionGeneration: sender.turn.executionGeneration,
          },
          operationKey: crypto.randomUUID(),
          text: "Result from another agent session",
        }),
      );
      const delivered = await claim(grant, receiving);
      const [row] = await database!.admin<{ context: string; value: unknown }[]>`
        select execution_context_turn_id::text as context, subscription_authority as value
        from session_turns where id = ${delivered.turn.id}::uuid`;
      expect(row).toEqual({ context, value });

      // Direct deliveries into a second context frozen with `value`.
      const other = await newSession(grant);
      const second = await contextTurn(grant, other);
      await freeze("session_turns", second, value);
      const same = await causalUpdate(grant, other, second, value);
      const none = await causalUpdate(grant, other, second, null);
      const empty = await causalUpdate(grant, other, second, EMPTY);
      expect(await delivery(grant, second, [same], value)).toBe("accepted");
      expect(await delivery(grant, second, [none], value)).toBe("accepted");
      expect(await delivery(grant, second, [same], EMPTY)).toBe(
        "42501 invalid receiving execution context",
      );
      expect(await delivery(grant, second, [same], null)).toBe(
        "42501 invalid receiving execution context",
      );
      expect(await delivery(grant, second, [empty], value)).toBe(
        "42501 causal input has different execution authority",
      );

      // A context that froze none: the delivering turn carries none or the
      // empty value (written once the Codex cutover is enabled), never more.
      const third = await newSession(grant);
      const bare = await contextTurn(grant, third);
      await freeze("session_turns", bare, null);
      const bareUpdate = await causalUpdate(grant, third, bare, null);
      expect(await delivery(grant, bare, [bareUpdate], null)).toBe("accepted");
      expect(await delivery(grant, bare, [bareUpdate], EMPTY)).toBe("accepted");
      expect(await delivery(grant, bare, [bareUpdate], value)).toBe(
        "42501 invalid receiving execution context",
      );
    });

    test("a pure goal continuation compares with the goal's causal turn, not the context turn", async () => {
      const grant = await inboxGrant();
      const sessionId = await newSession(grant);
      const goalTurn = await contextTurn(grant, sessionId);
      const context = await contextTurn(grant, sessionId);
      const value = personal(crypto.randomUUID());
      await freeze("session_turns", goalTurn, EMPTY);
      await freeze("session_turns", context, value);
      const goal = await causalUpdate(grant, sessionId, goalTurn, null, "goal_continuation");
      expect(await delivery(grant, context, [goal], EMPTY)).toBe("accepted");
      expect(await delivery(grant, context, [goal], value)).toBe(
        "42501 invalid receiving execution context",
      );
      // With another causal update the delivery is not a pure goal
      // continuation: the context's value.
      const wait = await causalUpdate(grant, sessionId, context, null);
      expect(await delivery(grant, context, [goal, wait], value)).toBe("accepted");
      expect(await delivery(grant, context, [goal, wait], EMPTY)).toBe(
        "42501 invalid receiving execution context",
      );
    });

    test("the inbox batching key is unchanged while no provider holds records", async () => {
      const grant = await inboxGrant();
      const sessionId = await newSession(grant);
      const context = await contextTurn(grant, sessionId);
      const compat = await withRlsContext(
        client!.db,
        { accountId: grant.accountId, workspaceId: grant.workspaceId },
        (tx) =>
          subscriptionAuthorityCompatForCarriersInTransaction(tx, {
            workspaceId: grant.workspaceId,
            carriers: [{ kind: "session_turn", id: context }],
          }),
      );
      expect(compat.size).toBe(0);
    });
  });

  describe("scheduled Claude and v2 comparisons (act on deploy)", () => {
    let grant: Scheduled | null = null;
    let run: Run | null = null;
    let snapshot: unknown = null;

    beforeAll(async () => {
      if (!realDb) return;
      grant = await scheduledGrant();
      snapshot = (await claudeUserCredential(grant)).authoritySnapshot;
      run = await dispatch(grant, await claudeTask(grant, snapshot));
    });

    test("the dispatcher's rows pass: accepted, occurrence and generated session agree", async () => {
      expect(run!.accepted).toMatchObject({
        claudeProviderAccountAuthoritySnapshot: snapshot,
        claudeAuthoritySubjectId: grant!.subjectId,
      });
      const [rows] = await database!.admin<{ occurrence: unknown; session: unknown }[]>`
        select occurrence.claude_provider_account_authority_snapshot as occurrence,
          session_row.initial_claude_provider_account_authority_snapshot as session
        from session_system_updates occurrence, sessions session_row
        where occurrence.id = ${run!.occurrenceId}::uuid and session_row.id = ${run!.sessionId}::uuid`;
      expect(rows).toEqual({ occurrence: snapshot, session: snapshot });
      // The inventory lists nothing for rows the current writers produce.
      const found = (await inventory()).filter((row) => row.account_id === grant!.accountId);
      expect(found).toEqual([]);
    });

    test("admission compares the accepted Claude snapshot and its causal subject", async () => {
      const accepted = run!.accepted;
      // The unchanged copy passes admission (it then collides only on the
      // generated session binding's idempotency key, or is accepted).
      const control = await runCopy(grant!, run!, accepted);
      expect(control).not.toContain("admission");
      expect(control).not.toContain("causal");
      expect(
        await runCopy(grant!, run!, {
          ...accepted,
          claudeProviderAccountAuthoritySnapshot: ORGANIZATION_CLAUDE,
        }),
      ).toBe("40001 scheduled agent run accepted execution changed during admission");
      const { claudeProviderAccountAuthoritySnapshot: _omitted, ...withoutClaude } = accepted;
      expect(await runCopy(grant!, run!, withoutClaude)).toBe(
        "40001 scheduled agent run accepted execution changed during admission",
      );
      const otherSubject = await runCopy(grant!, run!, {
        ...accepted,
        claudeAuthoritySubjectId: "user:someone-else",
      });
      expect(otherSubject.startsWith("42501 ")).toBe(true);
      const { claudeAuthoritySubjectId: _subject, ...withoutSubject } = accepted;
      expect((await runCopy(grant!, run!, withoutSubject)).startsWith("42501 ")).toBe(true);
    });

    test("an occurrence carries the accepted Claude values and its firing's v2 value", async () => {
      const [occurrence] = await database!.admin<
        { lineage: Record<string, unknown>; value: unknown }[]
      >`
        select lineage, subscription_authority as value from session_system_updates
        where id = ${run!.occurrenceId}::uuid`;
      const control = await occurrenceCopy(grant!, run!, {});
      expect(control).not.toContain("differs from accepted execution");
      for (const overrides of [
        { claude_provider_account_authority_snapshot: ORGANIZATION_CLAUDE },
        { lineage: { ...occurrence!.lineage, claudeAuthoritySubjectId: "user:someone-else" } },
        { subscription_authority: personal(grant!.membershipId) },
      ]) {
        expect(await occurrenceCopy(grant!, run!, overrides)).toBe(
          "42501 scheduled occurrence differs from accepted execution",
        );
      }
      // Its Claude snapshot and v2 value are immutable for every role (each
      // written value differs from the stored one).
      for (const column of [
        "claude_provider_account_authority_snapshot",
        "subscription_authority",
      ]) {
        expect(
          await attempt(async (tx) => {
            await scope(tx, grant!);
            await tx.unsafe(
              `update session_system_updates set ${column} = $1::text::jsonb where id = $2::uuid`,
              [
                JSON.stringify(
                  column === "subscription_authority"
                    ? personal(crypto.randomUUID())
                    : ORGANIZATION_CLAUDE,
                ),
                run!.occurrenceId,
              ],
            );
          }),
        ).toBe("42501 scheduled occurrence accepted content is immutable");
      }
      expect(occurrence!.value === null || typeof occurrence!.value === "object").toBe(true);
    });

    test("binding the generated session compares its initial Claude snapshot", async () => {
      const rebind = (initialClaude: unknown) =>
        attempt(async (tx) => {
          await scope(tx, grant!);
          await tx`set local session_replication_role = replica`;
          await tx`update scheduled_task_runs set session_id = null where id = ${run!.runId}::uuid`;
          await tx`update sessions
            set initial_claude_provider_account_authority_snapshot = ${JSON.stringify(initialClaude)}::text::jsonb
            where id = ${run!.sessionId}::uuid`;
          await tx`set local session_replication_role = origin`;
          await tx`insert into opengeni_private.scheduled_personal_resource_capabilities (
              backend_pid, transaction_id, capability_kind
            ) values (pg_backend_pid(), pg_current_xact_id(), 'run_lifecycle')`;
          await tx`update scheduled_task_runs set session_id = ${run!.sessionId}::uuid
            where id = ${run!.runId}::uuid`;
        });
      expect(await rebind(snapshot)).toBe("accepted");
      expect(await rebind(ORGANIZATION_CLAUDE)).toBe(
        "42501 scheduled generated session differs from accepted execution",
      );
    });

    test("the scheduled turn keeps its Claude snapshot and v2 value for every role", async () => {
      const claimed = await claim(grant!, run!.sessionId, run!.workflowId);
      for (const column of [
        "claude_provider_account_authority_snapshot",
        "subscription_authority",
      ]) {
        expect(
          await attempt(async (tx) => {
            await scope(tx, grant!);
            await tx.unsafe(
              `update session_turns set ${column} = $1::text::jsonb where id = $2::uuid`,
              [
                JSON.stringify(
                  column === "subscription_authority"
                    ? personal(grant!.membershipId)
                    : ORGANIZATION_CLAUDE,
                ),
                claimed.turn.id,
              ],
            );
          }),
        ).toBe("42501 scheduled turn accepted execution is immutable");
      }
    });

    test("a revoked accepted user Claude authority fails the live check and the claim", async () => {
      const revoked = staged!.revoked;
      // Admitted before 0716 for an account its owner then disconnected
      // (0716 revoked the authority that disconnect left active): the check
      // it now inherits refuses it.
      expect(await liveAuthority(revoked.grant, revoked.runId)).toBe(
        "scheduled_claude_authority_changed",
      );
      expect(await liveAuthority(grant!, run!.runId)).toBeNull();
      const claimed = await claimSessionWorkForAttempt(client!.db, revoked.grant.workspaceId, {
        sessionId: revoked.sessionId,
        workflowId: revoked.workflowId,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      expect(claimed).toEqual({ action: "unclaimed", reason: "no-work" });
      const [evidence] = await database!.admin<
        { runStatus: string; runError: string | null; updateState: string; attempts: number }[]
      >`
        select run.status as "runStatus", run.error as "runError",
          update_value.state as "updateState",
          (select count(*)::int from session_turn_attempts attempt
            where attempt.session_id = run.session_id) as attempts
        from scheduled_task_runs run
        join session_system_updates update_value on update_value.scheduled_task_run_id = run.id
        where run.id = ${revoked.runId}::uuid`;
      expect(evidence).toEqual({
        runStatus: "failed",
        runError: "scheduled_claude_authority_changed",
        updateState: "failed",
        attempts: 0,
      });
    });
  });

  describe("after a provider's own drained cutover (receipt)", () => {
    beforeAll(async () => {
      if (!realDb) return;
      await database!.admin`
        insert into opengeni_private.subscription_provider_cutover_receipts (
          provider, migration, committed_at, seed_rotation
        ) values ('claude', '0799_subscription_core_claude_cutover.sql', clock_timestamp(),
          '{"mode":"spread"}')`;
    });

    test("the live check switches from the v1 Claude authority to the run's record", async () => {
      const revoked = staged!.revoked;
      // The v1 check no longer applies, and the run's revision holds no
      // record with a personal entry: nothing personal to check.
      expect(await liveAuthority(revoked.grant, revoked.runId)).toBeNull();
      const [revision] = await database!.admin<{ revision: string }[]>`
        select task_authority_revision::text as revision from scheduled_task_runs
        where id = ${revoked.runId}::uuid`;
      const connectionId = crypto.randomUUID();
      await database!.admin`
        insert into opengeni_private.subscription_authority_compat (
          account_id, workspace_id, provider, carrier_kind, scheduled_task_id,
          task_authority_revision, personal, shared_pool, legacy_scope, owner_subject_id
        ) values (
          ${revoked.grant.accountId}::uuid, ${revoked.grant.workspaceId}::uuid, 'claude',
          'scheduled_task_revision', ${revoked.taskId}::uuid, ${revision!.revision}::bigint,
          ${JSON.stringify([
            {
              ownerMembershipId: revoked.grant.membershipId,
              authorityGeneration: 1,
              connectionIds: [connectionId],
            },
          ])}::text::jsonb, 'none', 'user', ${revoked.grant.subjectId}
        )`;
      // The record's connection is not serviceable: the same code.
      expect(await liveAuthority(revoked.grant, revoked.runId)).toBe(
        "scheduled_claude_authority_changed",
      );
      // An active personal Claude connection of that membership, at the
      // record's generation and among its connections: live.
      const authorityId = crypto.randomUUID();
      await database!.admin`
        insert into organization_user_resource_authorities (
          id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
        ) values (
          ${authorityId}::uuid, ${revoked.grant.accountId}::uuid,
          ${revoked.grant.membershipId}::uuid, 'subscription_connection', ${connectionId}::uuid,
          1, 'active'
        )`;
      await database!.admin`
        insert into subscription_connections (
          id, account_id, provider, credential_encrypted, ownership, scope_kind,
          owner_organization_membership_id, owner_subject_id, authority_id,
          authority_resource_kind, authority_generation
        ) values (
          ${connectionId}::uuid, ${revoked.grant.accountId}::uuid, 'claude', 'v1:x', 'personal',
          'people', ${revoked.grant.membershipId}::uuid, ${revoked.grant.subjectId},
          ${authorityId}::uuid, 'subscription_connection', 1
        )`;
      expect(await liveAuthority(revoked.grant, revoked.runId)).toBeNull();
    });

    test("the inbox batching key then carries each carrier's effective authority", async () => {
      const grant = await inboxGrant();
      const sessionId = await newSession(grant);
      const context = await contextTurn(grant, sessionId);
      const compat = await withRlsContext(
        client!.db,
        { accountId: grant.accountId, workspaceId: grant.workspaceId },
        (tx) =>
          subscriptionAuthorityCompatForCarriersInTransaction(tx, {
            workspaceId: grant.workspaceId,
            carriers: [{ kind: "session_turn", id: context }],
          }),
      );
      expect(compat.get(`session_turn:${context}`)).toEqual({ claude: { authority: "none" } });
    });
  });
});
