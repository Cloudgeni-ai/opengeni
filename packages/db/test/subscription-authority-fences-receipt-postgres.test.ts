// Migration 0717 after a provider's own drained cutover (design
// docs/design/subscription-core-2026-10-07.md, 5.3 "PR 0b: authority
// compatibility and fences"): the receipt-time behaviour the main 0717 suite
// (subscription-authority-fences-postgres.test.ts) does not pin. Inert on
// deploy, but the SuperGrok and Claude cutovers rely on it:
//
// - the runtime inbox planner and the 0608 inbox fence agree on each
//   carrier's effective authority (a drift refuses production deliveries);
// - the live check's receipt switch applies to xAI as it does to Claude;
// - the live check locks the core-authority rows it then reads.
//
// The database is migrated by the NOSUPERUSER, NOBYPASSRLS owner; runtime work
// (prompt, claim, the planner's compatibility read, the live check) runs as
// the restricted application role. Carriers that predate the receipts, the
// cutover's records, and the deliveries a fence must refuse are written by
// the superuser (refused deliveries in transactions that roll back), as the
// main suite does. Receipts are append-only, so the pre-receipt check runs
// first.
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
  createDb,
  createScheduledTask,
  createSession,
  submitHumanPromptInTransaction,
  withRlsContext,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { subscriptionAuthorityCompatForCarriersInTransaction } from "../src/subscription-core-acceptance-authority";
import { SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS } from "../src";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
/** The providers whose own drained cutover this suite records (append-only receipts). */
const RECEIPT_PROVIDERS = ["claude", "xai"] as const;
/** An ownerless `workspace` record, as a provider's cutover writes for shared work. */
const WORKSPACE_RECORD = {
  authority: "record",
  personal: [],
  sharedPool: "workspace",
  legacyScope: "workspace",
};
const NONE = { authority: "none" };
let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let app: DbClient["db"] | null = null;
let appUrl = "";

type Grant = { accountId: string; workspaceId: string; subjectId: string };
type Scheduled = Grant & { membershipId: string };
/** A completed human turn accepted before the receipts, and its session. */
type PreReceipt = { grant: Grant; sessionId: string; turnId: string };
type XaiRun = { grant: Scheduled; taskId: string; runId: string };

let staged: {
  /** For the planner: a session whose pre-receipt turn the cutover gives a record. */
  planner: PreReceipt;
  /** For the inbox fence: the same shape in another session. */
  fence: PreReceipt;
  /** For the planner's batching without a receiving context: the same shape again. */
  coalesce: PreReceipt;
  /** A run with an accepted `user` xAI snapshot whose owner then disconnected it. */
  xaiRun: XaiRun;
} | null = null;

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

// ---------------------------------------------------------------- inbox

async function inboxGrant(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(app!, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Authority fences after a receipt",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Authority fences after a receipt",
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

async function claim(grant: Grant, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(app!, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`Expected a claim: ${claimed.reason}`);
  return { turn: claimed.turn, attemptId };
}

/** Claim the queued human turn, start and finish it: the session's receiving context. */
async function complete(grant: Grant, sessionId: string): Promise<string> {
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

/** A human turn that started and finished: the session's receiving context. */
async function contextTurn(grant: Grant, sessionId: string): Promise<string> {
  await prompt(grant, sessionId);
  return await complete(grant, sessionId);
}

async function preReceiptContext(): Promise<PreReceipt> {
  const grant = await inboxGrant();
  const sessionId = await newSession(grant);
  return { grant, sessionId, turnId: await contextTurn(grant, sessionId) };
}

/**
 * What each provider's drained cutover writes for a pre-receipt turn of
 * shared work: an ownerless `workspace` record (the post-cutover v1 default
 * equals this real pre-cutover `workspace` value, so only the record tells
 * them apart).
 */
async function cutoverWorkspaceRecords(carrier: PreReceipt): Promise<void> {
  for (const provider of RECEIPT_PROVIDERS) {
    await database!.admin`
      insert into opengeni_private.subscription_authority_compat (
        account_id, workspace_id, provider, carrier_kind, turn_id, personal, shared_pool,
        legacy_scope, owner_subject_id
      ) values (
        ${carrier.grant.accountId}::uuid, ${carrier.grant.workspaceId}::uuid, ${provider},
        'session_turn', ${carrier.turnId}::uuid, '[]'::jsonb, 'workspace', 'workspace', null
      )`;
  }
}

/**
 * A pending wait timeout of the session caused by `causalTurnId`, carrying the
 * causal turn's v1 execution values as the writers copy them. With `copy`,
 * each receipt provider's record is copied from the causal turn by 0716's copy
 * routine in the same transaction (what the provider writers will call); the
 * commit-time check accepts the row only with the right copies.
 */
async function causalUpdate(
  grant: Grant,
  sessionId: string,
  causalTurnId: string,
  copy: boolean,
): Promise<string> {
  const id = crypto.randomUUID();
  await database!.admin.begin(async (tx) => {
    await scope(tx, grant);
    await tx`insert into session_system_updates (
        id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
        payload, lineage, mcp_account_bindings, personal_connection_delegations,
        xai_provider_account_authority_snapshot, claude_provider_account_authority_snapshot
      ) select
        ${id}::uuid, ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${sessionId}::uuid,
        'session_wait_timeout', ${id}, ${`fences-receipt:${id}`}, 'fixture',
        ${JSON.stringify({
          type: "session_wait_timeout",
          waitTurnId: causalTurnId,
          deadlineAt: new Date().toISOString(),
          reason: "The wait timed out",
        })}::text::jsonb,
        ${JSON.stringify({ causalTurnId })}::text::jsonb,
        causal.mcp_account_bindings, causal.personal_connection_delegations,
        causal.xai_provider_account_authority_snapshot,
        causal.claude_provider_account_authority_snapshot
      from session_turns causal where causal.id = ${causalTurnId}::uuid`;
    if (!copy) return;
    for (const provider of RECEIPT_PROVIDERS) {
      const [copied] = await tx<{ copied: boolean }[]>`
        select opengeni_private.copy_subscription_authority_compat(${provider},
          'session_system_update', ${grant.workspaceId}::uuid, ${id}::uuid, null) as copied`;
      if (copied?.copied !== true) throw new Error(`No ${provider} record copied into ${id}`);
    }
  });
  return id;
}

/**
 * Deliver `updates` into a new running system turn that borrows the receiving
 * context (and copies its execution values), as the planner writes it: the
 * updates point at the turn before it is inserted. Rolled back by `attempt`.
 */
async function deliverInto(
  tx: postgres.TransactionSql,
  grant: Grant,
  contextTurnId: string,
  updates: string[],
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
      context.subscription_authority
    from session_turns context where context.id = ${contextTurnId}::uuid`;
  return turnId;
}

function delivery(grant: Grant, contextTurnId: string, updates: string[]) {
  return attempt((tx) => deliverInto(tx, grant, contextTurnId, updates));
}

/** The planner's read: each carrier's effective authority, as the application role. */
async function effective(
  grant: Grant,
  carriers: { kind: "session_turn" | "session_system_update"; id: string }[],
) {
  const compat = await withRlsContext(
    client!.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    (tx) =>
      subscriptionAuthorityCompatForCarriersInTransaction(tx, {
        workspaceId: grant.workspaceId,
        carriers,
      }),
  );
  return Object.fromEntries(compat);
}

async function updateState(id: string) {
  const [row] = await database!.admin<{ state: string; deliveredTurnId: string | null }[]>`
    select state, delivered_turn_id::text as "deliveredTurnId"
    from session_system_updates where id = ${id}::uuid`;
  return row;
}

async function sessionContext(sessionId: string): Promise<string | null> {
  const [row] = await database!.admin<{ context: string | null }[]>`
    select execution_context_turn_id::text as context from sessions where id = ${sessionId}::uuid`;
  return row!.context;
}

// ------------------------------------------------------------ scheduled

async function scheduledGrant(): Promise<Scheduled> {
  const admin = database!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('authority fences receipt') returning id::text as id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}::uuid, 'authority fences receipt') returning id::text as id`;
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

/**
 * A run whose accepted `user` xAI snapshot names its owner's SuperGrok
 * credential, fired through the real dispatcher; the owner then disconnects
 * the credential through the real writer, which revokes its v1 authority.
 */
async function revokedXaiRun(): Promise<XaiRun> {
  const grant = await scheduledGrant();
  const owner = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
  };
  const credential = await createXaiSubscriptionCredential(app!, {
    ...owner,
    scope: "user",
    encryptionKey: new Uint8Array(32).fill(23),
    secret: { version: 1, accessToken: "authority-fences-receipt" },
    providerAccountId: `authority-fences-receipt-${crypto.randomUUID()}`,
  });
  expect(credential.authoritySnapshot).toMatchObject({ scope: "user" });
  const task = await createScheduledTask(app!, {
    ...owner,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: `authority-fences-receipt-${crypto.randomUUID()}`,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `authority-fences-receipt-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Use the accepted SuperGrok account",
      model: "supergrok/grok-4.7",
      resources: [],
      tools: [],
      metadata: {},
    },
    xaiProviderAccountAuthoritySnapshot: credential.authoritySnapshot,
    metadata: {},
  });
  const db = app!;
  const scheduler = createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({
          databaseUrl: appUrl,
          sandboxBackend: "none",
          supergrokSubscriptionEnabled: true,
        }),
        db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
  const dispatched = await scheduler.dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey: `authority-fences-receipt:${crypto.randomUUID()}`,
  });
  if (dispatched.action !== "start") throw new Error(`dispatch ${JSON.stringify(dispatched)}`);
  const [run] = await database!.admin<{ runId: string; accepted: Record<string, unknown> }[]>`
    select id::text as "runId", accepted_execution_snapshot as accepted
    from scheduled_task_runs
    where task_id = ${task.id}::uuid and session_id = ${dispatched.sessionId}::uuid`;
  expect(run!.accepted).toMatchObject({
    xaiProviderAccountAuthoritySnapshot: credential.authoritySnapshot,
    causalHumanAuthority: { organizationMembershipId: grant.membershipId },
  });
  expect(
    await disconnectXaiSubscriptionCredential(app!, {
      ...owner,
      credentialId: credential.account.id,
      authoritySnapshot: credential.authoritySnapshot,
    }),
  ).toBe(true);
  return { grant, taskId: task.id, runId: run!.runId };
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

/** What a disconnect writes: revoke the authority row (rolled back), waiting at most 500 ms. */
function revoke(authorityId: string) {
  return attempt(async (tx) => {
    await tx`set local lock_timeout = '500ms'`;
    await tx`update organization_user_resource_authorities
      set status = 'revoked', revoked_at = now() where id = ${authorityId}::uuid`;
  });
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-authority-fences-receipt");
  if (!database) throw new Error("Real PostgreSQL is required");
  // This fixture installs its own receipts after staging historical authority.
  // Keep both real drained cutovers out of that pre-receipt world.
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values
      (${SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS.xai!}),
      (${SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS.claude!})`;
  } finally {
    await owner.end();
  }
  await migrate(database.ownerUrl);
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  appUrl = url.toString();
  client = createDb(appUrl, { max: 4 });
  app = client.db;
  staged = {
    planner: await preReceiptContext(),
    fence: await preReceiptContext(),
    coalesce: await preReceiptContext(),
    xaiRun: await revokedXaiRun(),
  };
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
});

describe.skipIf(!realDb)("0717 subscription authority fences after a provider's receipt", () => {
  test("runtime work runs as the restricted application role", async () => {
    const [identity] = await rawRows<{ role: string; superuser: boolean; bypass: boolean }>(
      client!.db,
      sql`select current_user::text as role, rolsuper as superuser, rolbypassrls as bypass
          from pg_roles where rolname = current_user`,
    );
    expect(identity).toEqual({ role: "opengeni_app", superuser: false, bypass: false });
  });

  test("before the xAI receipt the v1 check refuses a run whose accepted user xAI authority was revoked", async () => {
    const run = staged!.xaiRun;
    expect(await liveAuthority(run.grant, run.runId)).toBe("scheduled_xai_authority_changed");
  });

  describe("after the Claude and xAI receipts", () => {
    /** The xAI run's record connection, made serviceable by the live-check test. */
    let serviceableAuthorityId: string | null = null;

    beforeAll(async () => {
      if (!realDb) return;
      for (const provider of RECEIPT_PROVIDERS) {
        await database!.admin`
          insert into opengeni_private.subscription_provider_cutover_receipts (
            provider, migration, committed_at, seed_rotation
          ) values (${provider}, ${`0799_subscription_core_${provider}_cutover.sql`},
            clock_timestamp(), '{"mode":"spread"}')`;
      }
      await cutoverWorkspaceRecords(staged!.planner);
      await cutoverWorkspaceRecords(staged!.fence);
      await cutoverWorkspaceRecords(staged!.coalesce);
    });

    test("the runtime planner keeps a causal update with another effective authority out of the receiving context", async () => {
      // Records differ: the pending update copies its pre-receipt causal
      // turn's `workspace` records; the receiving context (the human turn the
      // claim takes) was accepted after the receipts and has none.
      const { grant, sessionId, turnId } = staged!.planner;
      const recorded = await causalUpdate(grant, sessionId, turnId, true);
      await prompt(grant, sessionId);
      const receiving = await claim(grant, sessionId);
      expect(receiving.turn.source).toBe("user");
      expect(
        await effective(grant, [
          { kind: "session_system_update", id: recorded },
          { kind: "session_turn", id: receiving.turn.id },
        ]),
      ).toEqual({
        [`session_system_update:${recorded}`]: { claude: WORKSPACE_RECORD, xai: WORKSPACE_RECORD },
        [`session_turn:${receiving.turn.id}`]: { claude: NONE, xai: NONE },
      });
      // The same v1 values and human, but another effective authority: not
      // batched with the context; the update waits for its own turn.
      expect(await updateState(recorded)).toEqual({ state: "pending", deliveredTurnId: null });

      // The same pair without records (every carrier accepted after the
      // receipts): both are `none`, and the update joins the context.
      const other = await inboxGrant();
      const otherSession = await newSession(other);
      const otherCause = await contextTurn(other, otherSession);
      const plain = await causalUpdate(other, otherSession, otherCause, false);
      await prompt(other, otherSession);
      const otherReceiving = await claim(other, otherSession);
      expect(
        await effective(other, [
          { kind: "session_system_update", id: plain },
          { kind: "session_turn", id: otherReceiving.turn.id },
        ]),
      ).toEqual({
        [`session_system_update:${plain}`]: { claude: NONE, xai: NONE },
        [`session_turn:${otherReceiving.turn.id}`]: { claude: NONE, xai: NONE },
      });
      expect(await updateState(plain)).toEqual({
        state: "delivered",
        deliveredTurnId: otherReceiving.turn.id,
      });
    });

    test("the runtime planner keeps updates with different effective authorities in separate batches when no receiving context owns them", async () => {
      // Wait timeouts are not informational agent input, so with no queued
      // human turn the claim plans them without the receiving context. Both
      // carry the same v1 values and causal human; only their records differ.
      const { grant, sessionId, turnId: recordedCause } = staged!.coalesce;
      const plainCause = await contextTurn(grant, sessionId);
      // The plain update is first in the inbox and leads the batch.
      const plain = await causalUpdate(grant, sessionId, plainCause, false);
      const recorded = await causalUpdate(grant, sessionId, recordedCause, true);
      expect(
        await effective(grant, [
          { kind: "session_system_update", id: plain },
          { kind: "session_system_update", id: recorded },
        ]),
      ).toEqual({
        [`session_system_update:${plain}`]: { claude: NONE, xai: NONE },
        [`session_system_update:${recorded}`]: { claude: WORKSPACE_RECORD, xai: WORKSPACE_RECORD },
      });
      const first = await claim(grant, sessionId);
      expect(first.turn.source).toBe("system");
      const [delivering] = await database!.admin<{ context: string | null }[]>`
        select execution_context_turn_id::text as context from session_turns
        where id = ${first.turn.id}::uuid`;
      expect(delivering).toEqual({ context: null });
      expect(await updateState(plain)).toEqual({
        state: "delivered",
        deliveredTurnId: first.turn.id,
      });
      // Another effective authority: not coalesced into the same turn.
      expect(await updateState(recorded)).toEqual({ state: "pending", deliveredTurnId: null });
    });

    test("the inbox fence refuses a delivery borrowing a context whose effective authority differs from its update's", async () => {
      // A delivery borrows the session's current context (0608), so the
      // pre-receipt context comes first, then one accepted after the receipts.
      const { grant, sessionId, turnId: recordedContext } = staged!.fence;
      expect(await sessionContext(sessionId)).toBe(recordedContext);
      // Causal updates copied from the pre-receipt context (its `workspace`
      // records), and one caused by a prompt queued after the receipts (none).
      const recorded = await causalUpdate(grant, sessionId, recordedContext, true);
      await prompt(grant, sessionId);
      const [queued] = await database!.admin<{ id: string }[]>`
        select id::text as id from session_turns
        where session_id = ${sessionId}::uuid and status = 'queued'`;
      const plain = await causalUpdate(grant, sessionId, queued!.id, false);
      expect(await sessionContext(sessionId)).toBe(recordedContext);
      expect(
        await effective(grant, [
          { kind: "session_turn", id: recordedContext },
          { kind: "session_system_update", id: recorded },
          { kind: "session_system_update", id: plain },
        ]),
      ).toEqual({
        [`session_turn:${recordedContext}`]: { claude: WORKSPACE_RECORD, xai: WORKSPACE_RECORD },
        [`session_system_update:${recorded}`]: { claude: WORKSPACE_RECORD, xai: WORKSPACE_RECORD },
        [`session_system_update:${plain}`]: { claude: NONE, xai: NONE },
      });
      // Equal effective authority: accepted.
      expect(await delivery(grant, recordedContext, [recorded])).toBe("accepted");
      // The exception the planner shares: post-receipt work without a v2
      // value or a record follows the context it joins.
      expect(await delivery(grant, recordedContext, [plain])).toBe("accepted");
      expect(await delivery(grant, recordedContext, [plain, recorded])).toBe("accepted");

      // The queued prompt runs and becomes the context (none). Its claim
      // takes the pending input the planner admits; fresh updates follow.
      const plainContext = await complete(grant, sessionId);
      expect(plainContext).toBe(queued!.id);
      expect(await sessionContext(sessionId)).toBe(plainContext);
      const recordedAgain = await causalUpdate(grant, sessionId, recordedContext, true);
      const plainAgain = await causalUpdate(grant, sessionId, plainContext, false);
      expect(
        await effective(grant, [
          { kind: "session_turn", id: plainContext },
          { kind: "session_system_update", id: recordedAgain },
          { kind: "session_system_update", id: plainAgain },
        ]),
      ).toEqual({
        [`session_turn:${plainContext}`]: { claude: NONE, xai: NONE },
        [`session_system_update:${recordedAgain}`]: {
          claude: WORKSPACE_RECORD,
          xai: WORKSPACE_RECORD,
        },
        [`session_system_update:${plainAgain}`]: { claude: NONE, xai: NONE },
      });
      expect(await delivery(grant, plainContext, [plainAgain])).toBe("accepted");
      // A record against a context without one: refused, alone or batched.
      expect(await delivery(grant, plainContext, [recordedAgain])).toBe(
        "42501 causal input has different execution authority",
      );
      expect(await delivery(grant, plainContext, [plainAgain, recordedAgain])).toBe(
        "42501 causal input has different execution authority",
      );
    });

    test("the live check switches from the v1 xAI authority to the run's record", async () => {
      const run = staged!.xaiRun;
      // The v1 check no longer applies, and the run's revision holds no
      // record with a personal entry: nothing personal to check.
      expect(await liveAuthority(run.grant, run.runId)).toBeNull();
      const [revision] = await database!.admin<{ revision: string }[]>`
        select task_authority_revision::text as revision from scheduled_task_runs
        where id = ${run.runId}::uuid`;
      const connectionId = crypto.randomUUID();
      await database!.admin`
        insert into opengeni_private.subscription_authority_compat (
          account_id, workspace_id, provider, carrier_kind, scheduled_task_id,
          task_authority_revision, personal, shared_pool, legacy_scope, owner_subject_id
        ) values (
          ${run.grant.accountId}::uuid, ${run.grant.workspaceId}::uuid, 'xai',
          'scheduled_task_revision', ${run.taskId}::uuid, ${revision!.revision}::bigint,
          ${JSON.stringify([
            {
              ownerMembershipId: run.grant.membershipId,
              authorityGeneration: 1,
              connectionIds: [connectionId],
            },
          ])}::text::jsonb, 'none', 'user', ${run.grant.subjectId}
        )`;
      // The record's connection is not serviceable: the same code as v1.
      expect(await liveAuthority(run.grant, run.runId)).toBe("scheduled_xai_authority_changed");
      // An active personal xAI connection of that membership, at the record's
      // generation and among its connections: live, although the v1
      // authority stays revoked.
      const authorityId = crypto.randomUUID();
      await database!.admin`
        insert into organization_user_resource_authorities (
          id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
        ) values (
          ${authorityId}::uuid, ${run.grant.accountId}::uuid, ${run.grant.membershipId}::uuid,
          'subscription_connection', ${connectionId}::uuid, 1, 'active'
        )`;
      await database!.admin`
        insert into subscription_connections (
          id, account_id, provider, credential_encrypted, ownership, scope_kind,
          owner_organization_membership_id, owner_subject_id, authority_id,
          authority_resource_kind, authority_generation
        ) values (
          ${connectionId}::uuid, ${run.grant.accountId}::uuid, 'xai', 'v1:x', 'personal',
          'people', ${run.grant.membershipId}::uuid, ${run.grant.subjectId},
          ${authorityId}::uuid, 'subscription_connection', 1
        )`;
      const [v1] = await database!.admin<{ status: string }[]>`
        select status from organization_user_resource_authorities
        where account_id = ${run.grant.accountId}::uuid and resource_kind = 'xai_subscription'`;
      expect(v1).toEqual({ status: "revoked" });
      expect(await liveAuthority(run.grant, run.runId)).toBeNull();
      serviceableAuthorityId = authorityId;
    });

    test("the live check holds the core authority it read until its transaction ends", async () => {
      // Behavioural: while the check's transaction is open, a disconnect
      // cannot revoke the record's authority row between the check and the
      // work it admits; afterwards it can.
      const run = staged!.xaiRun;
      const authorityId = serviceableAuthorityId;
      if (!authorityId)
        throw new Error("the live-check switch test makes the connection serviceable");
      const during = await withRlsContext(
        client!.db,
        { accountId: run.grant.accountId, workspaceId: run.grant.workspaceId },
        async (tx) => {
          const [row] = await rawRows<{ denial: string | null }>(
            tx,
            sql`select validate_scheduled_agent_run_live_authority(
              ${run.grant.accountId}::uuid, ${run.grant.workspaceId}::uuid,
              ${run.runId}::uuid) as denial`,
          );
          expect(row!.denial).toBeNull();
          return await revoke(authorityId);
        },
      );
      expect(during).toBe("55P03 canceling statement due to lock timeout");
      expect(await revoke(authorityId)).toBe("accepted");
    });
  });
});

import {
  createXaiSubscriptionCredential,
  disconnectXaiSubscriptionCredential,
} from "./fixtures/legacy-xai";
