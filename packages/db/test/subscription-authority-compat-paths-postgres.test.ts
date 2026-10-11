// Migration 0716: one case per resolver path of
// opengeni_subscription_internal.subscription_compat_carrier_sources (design
// docs/design/subscription-core-2026-10-07.md, 5.3 "PR 0b: authority
// compatibility and fences", the per-path source table and the copy rule).
// Every case runs after a provider's own receipt: the source holds a personal
// record owned by the session owner, the dependent carrier is written in the
// shape its writer uses, and the case shows that
// - the copy keeps the owner's record verbatim for the owner as causal human,
// - the copy is narrowed (personal entry dropped, the workspace narrowing
//   kept) when the causal human differs or the path's narrowing rule applies,
// - the deferred check rejects the carrier without its copy (23514).
// Runtime calls run as the restricted application role; fixture rows the
// application never writes directly (scheduler runs, cutover records,
// delivered internal turns) are written by the database owner, as in
// subscription-authority-compat-postgres.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  importArchivedSession,
  updateScheduledTask,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import {
  rawRows,
  withRestoredSessionActivityRlsContext,
  withRlsContext,
  withSessionActivityRlsContext,
  type Database,
} from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const CORE_SUBJECT = "service:subscription-core";
let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

type Org = {
  accountId: string;
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
};
type Carrier = { sessionId: string; turnId: string };
type CarrierKind =
  | "session_initial"
  | "session_turn"
  | "scheduled_task"
  | "scheduled_task_revision"
  | "session_system_update"
  | "session_system_update_outbox";
type RecordRow = {
  personal: unknown;
  shared_pool: string;
  legacy_scope: string;
  owner_subject_id: string | null;
};
type RecordContent = {
  personal: unknown[];
  sharedPool: "workspace" | "organization" | "none";
  legacyScope: "organization" | "workspace" | "user" | "missing";
  owner: string | null;
};

/** The organization owner; every session below is in the owner's Personal workspace. */
let org: Org | null = null;
/** A second human of the organization, an admin of the owner's Personal workspace. */
let other = "";
/** The owner's personal entry every source record carries. */
let entry: { ownerMembershipId: string; authorityGeneration: number; connectionIds: string[] } = {
  ownerMembershipId: "",
  authorityGeneration: 7,
  connectionIds: [],
};

/** The owner's record, as the provider's drained cutover writes it on a source. */
const ownerRecord = (): RecordContent => ({
  personal: [entry],
  sharedPool: "workspace",
  legacyScope: "workspace",
  owner: org!.subjectId,
});
/** The copy for the record's owner: verbatim. */
const kept = (): RecordRow => ({
  personal: [entry],
  shared_pool: "workspace",
  legacy_scope: "workspace",
  owner_subject_id: org!.subjectId,
});
/** The copy for anyone else: the personal entry dropped, the workspace narrowing kept. */
const narrowed: RecordRow = {
  personal: [],
  shared_pool: "workspace",
  legacy_scope: "workspace",
  owner_subject_id: null,
};

async function organization(db: DbClient): Promise<Org> {
  const userId = `authority-compat-paths-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(db.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Authority compatibility paths fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await database!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships where account_id = ${accountId}::uuid
      and subject_id = ${subjectId} and status = 'active' and revoked_at is null limit 1`;
  return {
    accountId,
    subjectId,
    membershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
  };
}

/** A second member of the owner's organization, admin of the owner's Personal workspace. */
async function secondMember(owner: Org): Promise<string> {
  const subjectId = `user:authority-compat-other-${crypto.randomUUID()}`;
  const [workspace] = await database!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${owner.accountId}::uuid, 'Other personal') returning id::text as id`;
  await database!.admin`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${owner.accountId}::uuid, ${subjectId}, 'active', ${workspace!.id}::uuid)`;
  await database!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${owner.accountId}::uuid, ${owner.personalWorkspaceId}::uuid, ${subjectId}, 'admin')`;
  return subjectId;
}

async function failure(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    const code =
      (cause as { code?: string } | undefined)?.code ?? (error as { code?: string }).code;
    return `${code ?? "?"} ${String(cause ?? error)}`;
  }
  return "succeeded";
}

/** Run as the application role in the owner's Personal workspace, as `subjectId`. */
async function asMember<T>(subjectId: string, work: (db: Database) => Promise<T>): Promise<T> {
  return await withSessionRlsActorContext({ subjectId }, () =>
    withRlsContext(
      client!.db,
      { accountId: org!.accountId, workspaceId: org!.personalWorkspaceId },
      work,
    ),
  );
}
const asOwner = <T>(work: (db: Database) => Promise<T>) => asMember(org!.subjectId, work);

/** The copy routine, as a writer calls it for a carrier its transaction inserted. */
async function copy(
  db: Database,
  kind: CarrierKind,
  id: string,
  revision: number | null = null,
): Promise<boolean> {
  const [row] = await rawRows<{ copied: boolean }>(
    db,
    sql`select opengeni_private.copy_subscription_authority_compat(
          'claude', ${kind}, ${org!.personalWorkspaceId}::uuid, ${id}::uuid,
          ${revision}::bigint) as copied`,
  );
  return row!.copied;
}

const ID_COLUMN: Record<CarrierKind, string> = {
  session_initial: "session_id",
  session_turn: "turn_id",
  scheduled_task: "scheduled_task_id",
  scheduled_task_revision: "scheduled_task_id",
  session_system_update: "system_update_id",
  session_system_update_outbox: "outbox_id",
};

/** A carrier's Claude record, read by the owner (the relation is owner-only). */
async function records(
  kind: CarrierKind,
  id: string,
  revision: number | null = null,
): Promise<RecordRow[]> {
  return [
    ...(await database!.admin.unsafe<RecordRow[]>(
      `select personal, shared_pool, legacy_scope, owner_subject_id
       from opengeni_private.subscription_authority_compat
       where provider = 'claude' and carrier_kind = $1 and ${ID_COLUMN[kind]} = $2::uuid
         and task_authority_revision is not distinct from $3::bigint`,
      [kind, id, revision],
    )),
  ];
}

/** A record the provider's drained cutover would write on a source (the owner writes it). */
async function cutoverRecord(
  kind: CarrierKind,
  id: string,
  content: RecordContent = ownerRecord(),
  revision: number | null = null,
) {
  await database!.admin.unsafe(
    `insert into opengeni_private.subscription_authority_compat (
       account_id, workspace_id, provider, carrier_kind, ${ID_COLUMN[kind]},
       task_authority_revision, personal, shared_pool, legacy_scope, owner_subject_id
     ) values ($1::uuid, $2::uuid, 'claude', $3, $4::uuid, $5::bigint, $6::text::jsonb, $7, $8, $9)`,
    [
      org!.accountId,
      org!.personalWorkspaceId,
      kind,
      id,
      revision,
      JSON.stringify(content.personal),
      content.sharedPool,
      content.legacyScope,
      content.owner,
    ],
  );
}

type SessionShape = {
  owner?: string;
  visibility?: "user_private" | "workspace_shared";
  parentSessionId?: string;
  createdByActor?: {
    type: "agent_attempt";
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
  };
  createdBy?: { kind: "subject" | "service"; subjectId: string };
  createdByContext?: Record<string, unknown>;
};

/**
 * A session created by the session writer. `copyInitial` copies its
 * session_initial record inside the writer's own transaction, as the writer
 * will (beforeCreateCommit runs inside the activity scope that inserted it).
 */
async function newSession(shape: SessionShape = {}, copyInitial = false): Promise<string> {
  const owner = shape.owner ?? org!.subjectId;
  const session = await withSessionRlsActorContext({ subjectId: owner }, () =>
    createSession(client!.db, {
      accountId: org!.accountId,
      workspaceId: org!.personalWorkspaceId,
      initialMessage: "authority compatibility paths fixture",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility: shape.visibility ?? "user_private",
      subjectId: owner,
      createdBy: shape.createdBy ?? { kind: "subject", subjectId: owner },
      createdByContext: (shape.createdByContext ?? {}) as never,
      ...(shape.parentSessionId ? { parentSessionId: shape.parentSessionId } : {}),
      ...(shape.createdByActor ? { createdByActor: shape.createdByActor } : {}),
      ...(copyInitial
        ? {
            beforeCreateCommit: async (tx: Database, sessionId: string) => {
              await copy(tx, "session_initial", sessionId);
            },
          }
        : {}),
    }),
  );
  return session.id;
}

/** One queued prompt of `subjectId` (or of a service, with no human) in `sessionId`. */
async function acceptedTurn(sessionId: string, subjectId: string | null): Promise<Carrier> {
  const actor = subjectId
    ? { subjectId }
    : { subjectId: CORE_SUBJECT, initiatingHumanSubjectId: null };
  const turn = await withSessionRlsActorContext(actor, () =>
    enqueueSessionTurn(client!.db, {
      accountId: org!.accountId,
      workspaceId: org!.personalWorkspaceId,
      sessionId,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${sessionId}`,
      source: "user",
      prompt: "authority compatibility paths fixture",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: subjectId
        ? { kind: "subject", subjectId }
        : { kind: "service", subjectId: CORE_SUBJECT },
    }),
  );
  return { sessionId, turnId: turn.id };
}

/** Claim the session's next turn for a live attempt, as the session workflow does. */
async function claim(sessionId: string) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client!.db, org!.personalWorkspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`not claimed: ${claimed.action}`);
  return {
    type: "agent_attempt" as const,
    sessionId,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

/** Point a session's receiving context at one of its turns (as a started turn does). */
async function setExecutionContext(sessionId: string, turnId: string) {
  await database!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set execution_context_turn_id = ${turnId}::uuid
      where id = ${sessionId}::uuid`;
  });
}

type TurnShape = {
  source: "user" | "system" | "goal" | "compaction";
  status?: "completed" | "running";
  lineage?: Record<string, unknown>;
  human: string | null;
  scheduledTaskRunId?: string;
  executionContextTurnId?: string;
  subscriptionAuthority?: unknown;
};

/**
 * Run `work` with one of the scheduler's own admission triggers disabled.
 * Those triggers validate a run's accepted execution, which this check does
 * not depend on; the database is private to this file and the trigger is
 * enabled again before the next statement of any other fixture.
 */
async function withoutTrigger<T>(table: string, trigger: string, work: () => Promise<T>) {
  await database!.admin.unsafe(`alter table ${table} disable trigger ${trigger}`);
  try {
    return await work();
  } finally {
    await database!.admin.unsafe(`alter table ${table} enable trigger ${trigger}`);
  }
}

/**
 * A turn written as the runtime writes it (the owner writes this fixture),
 * copying its Claude record when asked. `deliver` marks those updates as
 * delivered into it, as the inbox does; a turn in a receiving context takes
 * the context turn's frozen execution authority, as the inbox fence
 * requires. `startedInTransaction` records the new turn's own `turn.started`
 * in the same transaction; `contextInTransaction` makes the new turn its
 * session's receiving context in the same transaction.
 */
async function writeTurn(
  sessionId: string,
  turn: TurnShape,
  copyRecord: boolean,
  options: {
    deliver?: string[];
    startedInTransaction?: boolean;
    contextInTransaction?: boolean;
  } = {},
): Promise<string> {
  const runId = turn.scheduledTaskRunId;
  if (runId) {
    return await withoutTrigger(
      "session_turns",
      "accepted_scheduled_turn_connection_authority_capture",
      () => writeTurnRow(sessionId, turn, copyRecord, options, runId),
    );
  }
  return await writeTurnRow(sessionId, turn, copyRecord, options, null);
}

async function writeTurnRow(
  sessionId: string,
  turn: TurnShape,
  copyRecord: boolean,
  options: { deliver?: string[]; startedInTransaction?: boolean; contextInTransaction?: boolean },
  scheduledTaskRunId: string | null,
): Promise<string> {
  const turnId = crypto.randomUUID();
  const context = turn.executionContextTurnId ?? null;
  await database!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
    await tx`select set_config('opengeni.account_id', ${org!.accountId}, true),
      set_config('opengeni.workspace_id', ${org!.personalWorkspaceId}, true)`;
    if (options.deliver) {
      await tx`set local session_replication_role = replica`;
      await tx`update session_system_updates
        set state = 'delivered', delivered_turn_id = ${turnId}::uuid, delivered_at = now(),
          delivered_history_item_id = gen_random_uuid()
        where id = any(${options.deliver}::uuid[])`;
      await tx`set local session_replication_role = origin`;
    }
    await tx`insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, sandbox_backend, lineage,
        initiator_kind, initiator_subject_id, initiating_human_subject_id,
        scheduled_task_run_id, execution_context_turn_id, subscription_authority,
        personal_connection_delegations, mcp_account_bindings,
        xai_provider_account_authority_snapshot, claude_provider_account_authority_snapshot
      ) select ${turnId}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
        ${sessionId}::uuid, gen_random_uuid(), ${`session-${sessionId}`},
        ${turn.status ?? "completed"}, ${turn.source},
        (select coalesce(max(position), 0) + 1 from session_turns where session_id = ${sessionId}::uuid),
        'fixture', 'scripted-model', 'medium', 'none',
        ${tx.json((turn.lineage ?? {}) as never)}::jsonb,
        ${turn.human ? "subject" : "service"}, ${turn.human ?? CORE_SUBJECT}, ${turn.human},
        ${scheduledTaskRunId}::uuid, ${context}::uuid,
        ${turn.subscriptionAuthority === undefined ? null : tx.json(turn.subscriptionAuthority as never)}::jsonb,
        coalesce(context.personal_connection_delegations, '[]'::jsonb), context.mcp_account_bindings,
        coalesce(context.xai_provider_account_authority_snapshot, '{"scope":"workspace","version":1}'::jsonb),
        coalesce(context.claude_provider_account_authority_snapshot, '{"scope":"workspace","version":1}'::jsonb)
      from (select 1) one
      left join session_turns context on context.id = ${context}::uuid`;
    if (options.startedInTransaction) {
      await tx`insert into session_events (
          account_id, workspace_id, session_id, sequence, type, turn_id, payload
        ) values (${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid, ${sessionId}::uuid,
          (select coalesce(max(sequence), 0) + 1 from session_events
            where session_id = ${sessionId}::uuid),
          'turn.started', ${turnId}::uuid, '{}'::jsonb)`;
    }
    if (options.contextInTransaction) {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set execution_context_turn_id = ${turnId}::uuid
        where id = ${sessionId}::uuid`;
      await tx`set local session_replication_role = origin`;
    }
    if (copyRecord) {
      await tx`select opengeni_private.copy_subscription_authority_compat(
        'claude', 'session_turn', ${org!.personalWorkspaceId}::uuid, ${turnId}::uuid, null)`;
    }
  });
  return turnId;
}

/** A turn.started event for an existing turn (the turn a compaction continues). */
async function started(sessionId: string, turnId: string) {
  await database!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${org!.accountId}, true),
      set_config('opengeni.workspace_id', ${org!.personalWorkspaceId}, true)`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, sequence, type, turn_id, payload)
      values (${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid, ${sessionId}::uuid,
        (select coalesce(max(sequence), 0) + 1 from session_events where session_id = ${sessionId}::uuid),
        'turn.started', ${turnId}::uuid, '{}'::jsonb)`;
  });
}

type UpdateShape = {
  kind: string;
  lineage: Record<string, unknown>;
  dedupeKey?: string;
  sourceId?: string;
};

/** An internal update of `sessionId`, inserted by the application role. */
async function insertUpdate(db: Database, sessionId: string, update: UpdateShape) {
  const id = crypto.randomUUID();
  await rawRows(
    db,
    sql`insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
          payload, lineage
        ) values (
          ${id}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
          ${sessionId}::uuid, ${update.kind}, ${update.sourceId ?? id},
          ${update.dedupeKey ?? `compat-paths:${id}`}, 'fixture',
          ${JSON.stringify({ type: update.kind })}::jsonb, ${JSON.stringify(update.lineage)}::jsonb
        )`,
  );
  return id;
}

/** An update by `subjectId` (default: the owner), copied in the same transaction when asked. */
async function addUpdate(
  sessionId: string,
  shape: UpdateShape,
  copyRecord: boolean,
  subjectId = org!.subjectId,
): Promise<string> {
  return await asMember(subjectId, async (db) => {
    const id = await insertUpdate(db, sessionId, shape);
    if (copyRecord) await copy(db, "session_system_update", id);
    return id;
  });
}

/** An Agent message's or Steer's lineage, as the sending writer freezes it. */
const callerLineage = (caller: Carrier) => ({
  callerSessionId: caller.sessionId,
  callerTurnId: caller.turnId,
  callerAttemptId: crypto.randomUUID(),
  callerExecutionGeneration: 1,
});

/**
 * A scheduled occurrence of `runId` for `sessionId`, as the scheduler writes
 * it (its accepted-execution validation is skipped, see withoutTrigger).
 */
async function occurrence(sessionId: string, runId: string, copyRecord: boolean) {
  const id = crypto.randomUUID();
  const write = () =>
    database!.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
      await tx`select set_config('opengeni.account_id', ${org!.accountId}, true),
      set_config('opengeni.workspace_id', ${org!.personalWorkspaceId}, true)`;
      await tx`insert into session_system_updates (
        id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
        payload, lineage, scheduled_task_run_id
      ) values (${id}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
        ${sessionId}::uuid, 'scheduled_occurrence', ${runId}, ${`scheduled-task-run:${runId}:${id}`},
        'Scheduled work', ${tx.json({ type: "scheduled_occurrence", scheduledTaskRunId: runId })}::jsonb,
        ${tx.json({ scheduledTaskRunId: runId })}::jsonb, ${runId}::uuid)`;
      if (copyRecord) {
        await tx`select opengeni_private.copy_subscription_authority_compat(
        'claude', 'session_system_update', ${org!.personalWorkspaceId}::uuid, ${id}::uuid, null)`;
      }
    });
  await withoutTrigger(
    "session_system_updates",
    "scheduled_occurrence_accepted_execution_validation",
    write,
  );
  return id;
}

/** A scheduled task created by `subjectId`, its revision authorized by that human. */
async function scheduledTask(
  subjectId: string,
  extra: {
    createdByActor?: SessionShape["createdByActor"];
    targetSessionId?: string;
    copyRecords?: boolean;
  } = {},
) {
  return await withSessionRlsActorContext({ subjectId }, () =>
    createScheduledTask(client!.db, {
      accountId: org!.accountId,
      workspaceId: org!.personalWorkspaceId,
      name: "authority compatibility paths",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: extra.targetSessionId ? "existing_session" : "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      metadata: {},
      ...(extra.createdByActor
        ? { createdByActor: extra.createdByActor }
        : { createdBy: { kind: "subject" as const, subjectId } }),
      ...(extra.targetSessionId ? { targetSessionId: extra.targetSessionId } : {}),
      ...(extra.copyRecords
        ? {
            captureLinkAuthority: async (
              tx: Database,
              task: { id: string; authorityRevision: number },
            ) => {
              await copy(tx, "scheduled_task", task.id);
              await copy(tx, "scheduled_task_revision", task.id, task.authorityRevision);
            },
          }
        : {}),
    }),
  );
}

/** A new authorization of the task by `subjectId` (a new revision), copied when asked. */
async function reauthorize(taskId: string, subjectId: string, copyRecord: boolean) {
  const task = await withSessionRlsActorContext({ subjectId }, () =>
    updateScheduledTask(client!.db, org!.personalWorkspaceId, taskId, {
      refreshPersonalResourceAuthority: true,
      authorityUpdatedBy: { kind: "subject", subjectId },
      captureLinkAuthority: async (tx, revised) => {
        if (copyRecord)
          await copy(tx, "scheduled_task_revision", taskId, revised.authorityRevision);
      },
    }),
  );
  return task.authorityRevision;
}

/**
 * A scheduler run of the task's `revision`, bound to `sessionId` (the
 * scheduler writes it). The resolver reads only its task and revision; its
 * accepted execution is a placeholder the admission triggers never see.
 */
async function scheduledRun(taskId: string, revision: number, sessionId: string | null) {
  const runId = crypto.randomUUID();
  await database!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into scheduled_task_runs (
        id, account_id, workspace_id, task_id, trigger_type, status, session_id,
        task_authority_revision, accepted_execution_snapshot
      ) values (${runId}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
        ${taskId}::uuid, 'scheduled', 'dispatched', ${sessionId}::uuid, ${revision}::bigint,
        '{"version":1}'::jsonb)`;
  });
  return runId;
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-authority-compat-paths");
  if (!database) throw new Error("Real PostgreSQL is required");
  await migrate(database.ownerUrl);
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 4 });
  org = await organization(client);
  other = await secondMember(org);
  entry = {
    ownerMembershipId: org.membershipId,
    authorityGeneration: 7,
    connectionIds: [crypto.randomUUID()],
  };
  // Claude's drained cutover committed now: every carrier below is accepted
  // after it, so a carrier whose source holds no record carries none.
  await database.admin`
    insert into opengeni_private.subscription_provider_cutover_receipts (
      provider, migration, committed_at, seed_rotation
    ) values ('claude', '0799_subscription_core_claude_cutover.sql', clock_timestamp(),
      '{"mode":"spread"}')`;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
});

describe.skipIf(!realDb)("0716 compatibility paths after a provider's own receipt", () => {
  test("runs as the restricted application role", async () => {
    const [identity] = await rawRows<{ role: string; superuser: boolean; bypass: boolean }>(
      client!.db,
      sql`select current_user::text as role, rolsuper as superuser, rolbypassrls as bypass
          from pg_roles where rolname = current_user`,
    );
    expect(identity).toEqual({ role: "opengeni_app", superuser: false, bypass: false });
  });

  describe("scheduled work copies the occurrence's task revision", () => {
    /** A task the owner created (revision 1) and the other human reauthorized (revision 2). */
    let taskId = "";
    let ownerRevision = 0;
    let otherRevision = 0;
    let sessionId = "";
    let ownerRun = "";
    let otherRun = "";
    /** Occurrences accepted before the revisions held records: they carry none. */
    let unrecordedOwnerOccurrence = "";
    beforeAll(async () => {
      if (!realDb) return;
      const task = await scheduledTask(org!.subjectId);
      taskId = task.id;
      ownerRevision = task.authorityRevision;
      otherRevision = await reauthorize(taskId, other, false);
      sessionId = await newSession();
      ownerRun = await scheduledRun(taskId, ownerRevision, sessionId);
      otherRun = await scheduledRun(taskId, otherRevision, sessionId);
      unrecordedOwnerOccurrence = await occurrence(sessionId, ownerRun, false);
      await cutoverRecord("scheduled_task_revision", taskId, ownerRecord(), ownerRevision);
      // The other human's revision holds that human's own record: a firing
      // keeps personal authority only when the authorizer owns the task, so
      // even the authorizer's own entry is never carried.
      const [membership] = await database!.admin<{ id: string }[]>`
        select id::text as id from organization_memberships
        where account_id = ${org!.accountId}::uuid and subject_id = ${other}`;
      await cutoverRecord(
        "scheduled_task_revision",
        taskId,
        {
          personal: [{ ...entry, ownerMembershipId: membership!.id }],
          sharedPool: "workspace",
          legacyScope: "workspace",
          owner: other,
        },
        otherRevision,
      );
    });

    test("the authorizer of each revision is the one the writer recorded", async () => {
      const authorizers = await database!.admin<{ revision: number; subject_id: string }[]>`
        select task_authority_revision::int as revision, subject_id
        from scheduled_task_revision_authorities where task_id = ${taskId}::uuid
        order by task_authority_revision`;
      expect([...authorizers]).toEqual([
        { revision: ownerRevision, subject_id: org!.subjectId },
        { revision: otherRevision, subject_id: other },
      ]);
    });

    test("scheduled firing: the turn copies its run's revision, personal only when the task owner authorized it", async () => {
      // The firing turn delivers an occurrence accepted before the revision
      // held its record, so only the firing path names the revision.
      const firing = (runId: string, copyRecord: boolean, deliver: string) =>
        writeTurn(
          sessionId,
          { source: "system", human: null, scheduledTaskRunId: runId },
          copyRecord,
          {
            deliver: [deliver],
          },
        );
      expect(await failure(() => firing(ownerRun, false, unrecordedOwnerOccurrence))).toStartWith(
        "23514",
      );
      const owned = await firing(ownerRun, true, unrecordedOwnerOccurrence);
      expect(await records("session_turn", owned)).toEqual([kept()]);
      // A revision another human authorized keeps only the narrowing
      // (getScheduledTaskSubscriptionAuthority), whatever its record holds.
      const foreign = await writeTurn(
        sessionId,
        { source: "system", human: null, scheduledTaskRunId: otherRun },
        true,
      );
      expect(await records("session_turn", foreign)).toEqual([narrowed]);
    });

    test("scheduled occurrence: the update copies its run's revision, personal only when the task owner authorized it", async () => {
      expect(await failure(() => occurrence(sessionId, ownerRun, false))).toStartWith("23514");
      const owned = await occurrence(sessionId, ownerRun, true);
      expect(await records("session_system_update", owned)).toEqual([kept()]);
      const foreign = await occurrence(sessionId, otherRun, true);
      expect(await records("session_system_update", foreign)).toEqual([narrowed]);
    });

    test("scheduled session: the session and its first prompt copy the run's revision", async () => {
      // A new session per run is created by the scheduler and names its run.
      const scheduler = (runId: string): SessionShape => ({
        visibility: "workspace_shared",
        createdBy: { kind: "service", subjectId: "scheduler" },
        createdByContext: { scheduledTaskRunId: runId },
      });
      expect(await failure(() => newSession(scheduler(ownerRun), false))).toStartWith("23514");
      const owned = await newSession(scheduler(ownerRun), true);
      expect(await records("session_initial", owned)).toEqual([kept()]);
      const foreign = await newSession(scheduler(otherRun), true);
      expect(await records("session_initial", foreign)).toEqual([narrowed]);
      // Its first prompt (no run on the turn itself) copies the same source;
      // a later prompt is a new acceptance.
      const first = (session: string, copyRecord: boolean) =>
        writeTurn(
          session,
          { source: "user", lineage: { actor: "human" }, human: null },
          copyRecord,
        );
      expect(await failure(() => first(owned, false))).toStartWith("23514");
      const firstTurn = await first(owned, true);
      expect(await records("session_turn", firstTurn)).toEqual([kept()]);
      expect(await records("session_turn", await first(foreign, true))).toEqual([narrowed]);
      const later = await first(owned, false);
      expect(await records("session_turn", later)).toEqual([]);
    });

    test("task revision: a new authorization copies the task, personal only for the task owner as authorizer", async () => {
      const task = await scheduledTask(org!.subjectId);
      await cutoverRecord("scheduled_task", task.id);
      expect(await failure(() => reauthorize(task.id, org!.subjectId, false))).toStartWith("23514");
      const ownerAgain = await reauthorize(task.id, org!.subjectId, true);
      expect(await records("scheduled_task_revision", task.id, ownerAgain)).toEqual([kept()]);
      const byOther = await reauthorize(task.id, other, true);
      expect(await records("scheduled_task_revision", task.id, byOther)).toEqual([narrowed]);
    });
  });

  describe("a child copies its spawning parent turn", () => {
    // Children of shared parents: a private parent's child goes through the
    // private-child capability protocol, which this check does not depend on.
    let parent: Carrier | null = null;
    let actor: Awaited<ReturnType<typeof claim>> | null = null;
    let child = "";
    beforeAll(async () => {
      if (!realDb) return;
      const parentSession = await newSession({ visibility: "workspace_shared" });
      parent = await acceptedTurn(parentSession, org!.subjectId);
      actor = await claim(parentSession);
      await cutoverRecord("session_turn", parent.turnId);
    });

    test("child creation: the child session copies the parent turn, for the parent turn's human", async () => {
      const spawn = (copyInitial: boolean) =>
        newSession(
          {
            visibility: "workspace_shared",
            parentSessionId: parent!.sessionId,
            createdByActor: actor!,
          },
          copyInitial,
        );
      expect(await failure(() => spawn(false))).toStartWith("23514");
      child = await spawn(true);
      expect(await records("session_initial", child)).toEqual([kept()]);
    });

    test("child creation by a turn of another human keeps only the narrowing", async () => {
      // A shared session of the owner where the other human prompts.
      const shared = await newSession({ visibility: "workspace_shared" });
      const foreignTurn = await acceptedTurn(shared, other);
      const foreignActor = await claim(shared);
      expect(foreignActor.turnId).toBe(foreignTurn.turnId);
      await cutoverRecord("session_turn", foreignTurn.turnId);
      const spawned = await newSession(
        {
          owner: other,
          visibility: "workspace_shared",
          parentSessionId: shared,
          createdByActor: foreignActor,
        },
        true,
      );
      expect(await records("session_initial", spawned)).toEqual([narrowed]);
    });

    test("child's first turn copies the parent turn, for the prompt's own human", async () => {
      const first = (session: string, human: string, copyRecord: boolean) =>
        writeTurn(session, { source: "user", lineage: { actor: "human" }, human }, copyRecord);
      expect(await failure(() => first(child, org!.subjectId, false))).toStartWith("23514");
      const owned = await first(child, org!.subjectId, true);
      expect(await records("session_turn", owned)).toEqual([kept()]);
      // Every later prompt is a new acceptance, whatever its human.
      expect(await records("session_turn", await first(child, org!.subjectId, false))).toEqual([]);
      // The first prompt of a second child, by another human, keeps only the narrowing.
      const second = await newSession(
        {
          visibility: "workspace_shared",
          parentSessionId: parent!.sessionId,
          createdByActor: actor!,
        },
        true,
      );
      expect(await records("session_turn", await first(second, other, true))).toEqual([narrowed]);
    });

    test("child result: the outbox row copies the parent turn, and the parent's update copies the outbox row", async () => {
      // The child-lifecycle outbox row (parent wake): source the child, target
      // the parent, keyed by dedupe key; its lineage names no parent turn.
      const dedupeKey = `child-result:${crypto.randomUUID()}`;
      const lineage = { childSessionId: child, parentSessionId: parent!.sessionId };
      const outbox = (copyRecord: boolean) =>
        asOwner(async (db) => {
          const id = crypto.randomUUID();
          await rawRows(
            db,
            sql`insert into session_system_update_outbox (
                  id, account_id, workspace_id, source_session_id, target_session_id, dedupe_key,
                  kind, classification, source_id, summary, payload, lineage
                ) values (
                  ${id}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
                  ${child}::uuid, ${parent!.sessionId}::uuid, ${dedupeKey},
                  'child_terminal_result', 'success', ${child}, 'Child done',
                  ${JSON.stringify({ type: "child_terminal_result", childSessionId: child, status: "idle" })}::jsonb,
                  ${JSON.stringify(lineage)}::jsonb
                )`,
          );
          if (copyRecord) await copy(db, "session_system_update_outbox", id);
          return id;
        });
      expect(await failure(() => outbox(false))).toStartWith("23514");
      const outboxId = await outbox(true);
      expect(await records("session_system_update_outbox", outboxId)).toEqual([kept()]);
      // Delivered to the parent with the outbox row's key and lineage.
      const result = { kind: "child_terminal_result", lineage, dedupeKey, sourceId: child };
      expect(await failure(() => addUpdate(parent!.sessionId, result, false))).toStartWith("23514");
      const delivered = await addUpdate(parent!.sessionId, result, true);
      expect(await records("session_system_update", delivered)).toEqual([kept()]);
    });
  });

  describe("the receiving session's source", () => {
    /**
     * A shared session of the owner whose receiving context is a recorded
     * turn of `contextHuman`, followed by a later turn of the owner that holds
     * no record (so only the context turn can supply the copy).
     */
    async function receivingSession(contextHuman: string) {
      const session = await newSession({ visibility: "workspace_shared" });
      const context = await acceptedTurn(session, contextHuman);
      const later = await acceptedTurn(session, org!.subjectId);
      await cutoverRecord("session_turn", context.turnId);
      await setExecutionContext(session, context.turnId);
      return { session, context, later };
    }
    let receiver = "";
    let later: Carrier | null = null;
    /** Callers: a turn of the owner and one of the other human, in their own sessions. */
    let ownerCaller: Carrier | null = null;
    let otherCaller: Carrier | null = null;
    beforeAll(async () => {
      if (!realDb) return;
      ({ session: receiver, later } = await receivingSession(org!.subjectId));
      ownerCaller = await acceptedTurn(await newSession(), org!.subjectId);
      otherCaller = await acceptedTurn(await newSession({ owner: other }), other);
    });

    test("Agent message: the execution-context turn, kept only for the sender's human", async () => {
      const message = (caller: Carrier, copyRecord: boolean) =>
        addUpdate(receiver, { kind: "agent_message", lineage: callerLineage(caller) }, copyRecord);
      expect(await failure(() => message(ownerCaller!, false))).toStartWith("23514");
      expect(await records("session_system_update", await message(ownerCaller!, true))).toEqual([
        kept(),
      ]);
      expect(await records("session_system_update", await message(otherCaller!, true))).toEqual([
        narrowed,
      ]);
      // Not the latest turn: it holds no record.
      expect(await records("session_turn", later!.turnId)).toEqual([]);
    });

    test("Agent Steer: the instruction copies the receiving source like an Agent message", async () => {
      // One pending Steer per session: each instruction gets its own receiver.
      const steer = async (caller: Carrier, copyRecord: boolean, target?: string) =>
        addUpdate(
          target ?? (await receivingSession(org!.subjectId)).session,
          {
            kind: "agent_steer_instruction",
            lineage: callerLineage(caller),
            sourceId: caller.sessionId,
          },
          copyRecord,
        );
      const owned = (await receivingSession(org!.subjectId)).session;
      expect(await failure(() => steer(ownerCaller!, false, owned))).toStartWith("23514");
      expect(
        await records("session_system_update", await steer(ownerCaller!, true, owned)),
      ).toEqual([kept()]);
      expect(await records("session_system_update", await steer(otherCaller!, true))).toEqual([
        narrowed,
      ]);
    });

    test("delivery into a receiving context: the internal turn copies the context turn", async () => {
      // An Agent message is delivered into a running turn in the receiving
      // context; the message is not a causal source of that turn. The inbox
      // fence admits only the context turn's own human as the delivering
      // human (and the sender's), so the copy narrows exactly when that human
      // does not own the context turn's record.
      const delivered = async (contextHuman: string, caller: Carrier, copyRecord: boolean) => {
        const { session, context } = await receivingSession(contextHuman);
        const message = await addUpdate(
          session,
          { kind: "agent_message", lineage: callerLineage(caller) },
          true,
        );
        // The delivering turn copies the context's Codex v2 value too, as
        // the planner writes it (0717's inbox fence compares it).
        const [contextRow] = await database!.admin<{ v2: unknown }[]>`
          select subscription_authority as v2 from session_turns
          where id = ${context.turnId}::uuid`;
        return await writeTurn(
          session,
          {
            source: "system",
            status: "running",
            human: contextHuman,
            executionContextTurnId: context.turnId,
            subscriptionAuthority: contextRow!.v2 ?? undefined,
          },
          copyRecord,
          { deliver: [message] },
        );
      };
      expect(await failure(() => delivered(org!.subjectId, ownerCaller!, false))).toStartWith(
        "23514",
      );
      expect(
        await records("session_turn", await delivered(org!.subjectId, ownerCaller!, true)),
      ).toEqual([kept()]);
      expect(await records("session_turn", await delivered(other, otherCaller!, true))).toEqual([
        narrowed,
      ]);
    });

    test("agent-submitted prompt: the receiving source, never the prompt's own turn", async () => {
      // An agent's prompt into another session (lineage actor agent_attempt)
      // copies that session's receiving source, here its execution-context
      // turn, for the prompt's own human.
      const prompt = (human: string, copyRecord: boolean) =>
        writeTurn(
          receiver,
          { source: "user", lineage: { actor: "agent_attempt" }, human },
          copyRecord,
        );
      expect(await failure(() => prompt(org!.subjectId, false))).toStartWith("23514");
      expect(await records("session_turn", await prompt(org!.subjectId, true))).toEqual([kept()]);
      expect(await records("session_turn", await prompt(other, true))).toEqual([narrowed]);
    });

    test("agent-submitted prompt without a receiving context: the latest turn not inserted by its own transaction", async () => {
      // The prompt's own turn is the session's latest; it never stands in
      // for the receiving source (it holds no record, so without this rule
      // the copy-less prompt would commit).
      const session = await newSession();
      const latest = await acceptedTurn(session, org!.subjectId);
      await cutoverRecord("session_turn", latest.turnId);
      const prompt = (copyRecord: boolean, contextInTransaction = false) =>
        writeTurn(
          session,
          { source: "user", lineage: { actor: "agent_attempt" }, human: org!.subjectId },
          copyRecord,
          { contextInTransaction },
        );
      expect(await failure(() => prompt(false))).toStartWith("23514");
      expect(await records("session_turn", await prompt(true))).toEqual([kept()]);
      // Even when the prompt became the receiving context in its own
      // transaction, the source is still the turn before it.
      expect(await failure(() => prompt(false, true))).toStartWith("23514");
      expect(await records("session_turn", await prompt(true, true))).toEqual([kept()]);
    });

    test("a child with no turn yet: an Agent message copies its spawning parent turn", async () => {
      // The child is created before its parent turn held a record, so its own
      // session_initial carries none and only the parent turn can supply one.
      const parentSession = await newSession({ visibility: "workspace_shared" });
      const parentTurn = await acceptedTurn(parentSession, org!.subjectId);
      const spawner = await claim(parentSession);
      const child = await newSession({
        visibility: "workspace_shared",
        parentSessionId: parentSession,
        createdByActor: spawner,
      });
      expect(await records("session_initial", child)).toEqual([]);
      await cutoverRecord("session_turn", parentTurn.turnId);
      const message = (copyRecord: boolean) =>
        addUpdate(
          child,
          { kind: "agent_message", lineage: callerLineage(ownerCaller!) },
          copyRecord,
        );
      expect(await failure(() => message(false))).toStartWith("23514");
      expect(await records("session_system_update", await message(true))).toEqual([kept()]);
    });
  });

  describe("an agent-created task copies its creating turn", () => {
    let creator: Awaited<ReturnType<typeof claim>> | null = null;
    beforeAll(async () => {
      if (!realDb) return;
      const session = await newSession();
      const turn = await acceptedTurn(session, org!.subjectId);
      creator = await claim(session);
      expect(creator.turnId).toBe(turn.turnId);
      await cutoverRecord("session_turn", turn.turnId);
    });

    test("to the owner's own destination: kept", async () => {
      expect(
        await failure(() => scheduledTask(org!.subjectId, { createdByActor: creator! })),
      ).toStartWith("23514");
      const task = await scheduledTask(org!.subjectId, {
        createdByActor: creator!,
        copyRecords: true,
      });
      expect(await records("scheduled_task", task.id)).toEqual([kept()]);
      // Its first revision (authorized by the creating turn's human, the
      // task owner) copies the task verbatim.
      expect(await records("scheduled_task_revision", task.id, task.authorityRevision)).toEqual([
        kept(),
      ]);
    });

    test("to a session the task owner does not own: only the narrowing", async () => {
      // The writer's eligibility check: personal authority only for a
      // destination the task owner owns (private, or in a Personal workspace).
      const elsewhere = await newSession({ owner: other, visibility: "workspace_shared" });
      const task = await scheduledTask(org!.subjectId, {
        createdByActor: creator!,
        targetSessionId: elsewhere,
        copyRecords: true,
      });
      expect(await records("scheduled_task", task.id)).toEqual([narrowed]);
      expect(await records("scheduled_task_revision", task.id, task.authorityRevision)).toEqual([
        narrowed,
      ]);
    });
  });
});

describe.skipIf(!realDb)("0716 compatibility rules after a provider's own receipt", () => {
  test("an archive import carries no record, even naming a scheduler occurrence", async () => {
    // A recorded revision and a run the import's creator context names: a
    // scheduler-created session would copy it, an imported one never does.
    const task = await scheduledTask(org!.subjectId);
    await cutoverRecord("scheduled_task_revision", task.id, ownerRecord(), task.authorityRevision);
    const runId = await scheduledRun(task.id, task.authorityRevision, null);
    const imported = await importArchivedSession(client!.db, {
      accountId: org!.accountId,
      workspaceId: org!.personalWorkspaceId,
      subjectId: org!.subjectId,
      fileOwnerSubjectId: null,
      createdBy: { kind: "service", subjectId: "scheduler" },
      createdByContext: { scheduledTaskRunId: runId } as never,
      payload: {
        importId: `compat-paths-${crypto.randomUUID()}`,
        title: "Imported",
        createdAt: "2020-01-01T00:00:00Z",
        events: [],
      },
    });
    expect(await records("session_initial", imported.session.id)).toEqual([]);
    // An imported session never executes, so its turn exclusion has nothing
    // to exclude: the archive guard refuses every turn first.
    expect(
      await failure(() =>
        writeTurn(imported.session.id, { source: "user", human: org!.subjectId }, false),
      ),
    ).toContain("SESSION_IMPORTED_READ_ONLY");
  });

  test("a pure goal continuation delivered into another human's turn has no source, so its v2 value commits", async () => {
    const session = await newSession();
    const causal = await acceptedTurn(session, org!.subjectId);
    await cutoverRecord("session_turn", causal.turnId);
    const goal = () =>
      addUpdate(
        session,
        { kind: "goal_continuation", lineage: { causalTurnId: causal.turnId } },
        true,
      );
    // The delivering turn's own (different, non-null) human: a new acceptance.
    const v2 = {
      version: 2,
      personal: [
        { provider: "claude", ownerMembershipId: org!.membershipId, authorityGeneration: 7 },
      ],
    };
    const continuation = (copyRecord: boolean, subscriptionAuthority?: unknown) =>
      goal().then((id) =>
        writeTurn(session, { source: "goal", human: other, subscriptionAuthority }, copyRecord, {
          deliver: [id],
        }),
      );
    const withV2 = await continuation(false, v2);
    expect(await records("session_turn", withV2)).toEqual([]);
    const copied = await continuation(true);
    expect(await records("session_turn", copied)).toEqual([]);
    // For the causal turn's own human the same delivery copies its record.
    const ownGoal = await goal();
    expect(
      await failure(() =>
        writeTurn(session, { source: "goal", human: org!.subjectId }, false, {
          deliver: [ownGoal],
        }),
      ),
    ).toStartWith("23514");
  });

  test("the copy must run inside the same activity scope as the carrier insert", async () => {
    // A session-activity scope flushes deferred constraints when it
    // finalizes (SET CONSTRAINTS ALL IMMEDIATE), so the deferred check runs
    // there, not at commit.
    const session = await newSession();
    const causal = await acceptedTurn(session, org!.subjectId);
    await cutoverRecord("session_turn", causal.turnId);
    const scope = { accountId: org!.accountId, workspaceId: org!.personalWorkspaceId };
    const timeout = (db: Database) =>
      insertUpdate(db, session, {
        kind: "session_wait_timeout",
        lineage: { causalTurnId: causal.turnId },
      });
    // Copied inside the scope, before it finalizes: accepted.
    const inside = await withSessionRlsActorContext({ subjectId: org!.subjectId }, () =>
      withSessionActivityRlsContext(client!.db, scope, async (db) => {
        const id = await timeout(db);
        expect(await copy(db, "session_system_update", id)).toBe(true);
        return id;
      }),
    );
    expect(await records("session_system_update", inside)).toEqual([kept()]);
    // Copied after the scope finalized, still in the same transaction: the
    // finalizer's flush already rejected the carrier, the copy is never reached.
    let reachedCopy = false;
    const after = await failure(() =>
      withSessionRlsActorContext({ subjectId: org!.subjectId }, () =>
        withRlsContext(client!.db, scope, async (outer) => {
          const id = await withRestoredSessionActivityRlsContext(outer, scope, timeout);
          reachedCopy = true;
          await copy(outer, "session_system_update", id);
        }),
      ),
    );
    expect(after).toStartWith("23514");
    expect(after).toContain("subscription authority compatibility record mismatch");
    expect(reachedCopy).toBe(false);
    // Without an activity scope the check is deferred to commit, so a later
    // copy in the same transaction is still in time.
    const plain = await asOwner(async (db) => {
      const id = await timeout(db);
      await rawRows(db, sql`select 1`);
      await copy(db, "session_system_update", id);
      return id;
    });
    expect(await records("session_system_update", plain)).toEqual([kept()]);
  });

  test("compaction never copies itself when its own turn.started is written in the same transaction", async () => {
    const session = await newSession();
    const continued = await acceptedTurn(session, org!.subjectId);
    await started(session, continued.turnId);
    await cutoverRecord("session_turn", continued.turnId);
    const compaction = (copyRecord: boolean) =>
      writeTurn(session, { source: "compaction", human: org!.subjectId }, copyRecord, {
        startedInTransaction: true,
      });
    // Its own turn.started is the session's latest, but the compaction still
    // continues the turn started before it.
    expect(await failure(() => compaction(false))).toStartWith("23514");
    expect(await records("session_turn", await compaction(true))).toEqual([kept()]);
  });

  // The placement helper's record filter on its final visibility check has no
  // case: no public path reaches it. The record branch returns before minting
  // when the record lists no connection, mints only the listed connections,
  // and the access helper keeps a capability for the same turn only for a
  // connection that turn's record lists. So every personal access capability
  // for (session, turn) that the check can see already names a listed
  // connection.
});
