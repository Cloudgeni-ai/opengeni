// Migration 0713: accepted authority across a provider's cutover (design
// docs/design/subscription-core-2026-10-07.md, 5.3 "Accepted authority across
// the cutover" and "PR 0b: authority compatibility and fences"). The database
// is migrated by the NOSUPERUSER, NOBYPASSRLS owner; runtime calls run as the
// restricted application role. Only Codex has a receipt ('-infinity'), so
// everything here is inert until a test records a provider receipt with a
// real commit time (as the provider's drained cutover will). Receipts are
// append-only, so the inert checks run first.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  withSubscriptionCoreAcceptedTurn,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows, withRlsContext, type Database } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const COMPAT = "0713_subscription_authority_compat.sql";
// 0714 requires 0713's routines: withheld with it and applied by the same run.
const FENCES = "0714_subscription_authority_fences.sql";
const CORE_SUBJECT = "service:subscription-core";
let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let appUrl = "";
/** Runtime posture right after applying 0713 to a provisioned database, then after provisioning. */
let posture: { unprovisioned: string[]; provisioned: string[] } | null = null;
/** A configured application role other than the default name, and its grants before provisioning. */
const customApplicationRole = `og_pr0b_custom_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let customRoleGrantsBeforeProvision: Record<string, boolean> | null = null;
/** 0713's transaction time, read from a row that existed before it. */
let migratedAt: Date | null = null;

type Org = {
  accountId: string;
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
};
type Carrier = { sessionId: string; turnId: string };

let org: Org | null = null;
/** A private session and turn accepted before 0713 (and so before any later receipt). */
let before: Carrier | null = null;

async function organization(db: DbClient, label: string): Promise<Org> {
  const userId = `authority-compat-${label}-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(db.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Authority compatibility fixture",
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

/**
 * A session in the owner's Personal workspace and one queued turn: private
 * for the owner's own turn, shared for a service turn (no human).
 */
async function acceptedTurn(
  db: DbClient,
  owner: Org,
  initiator: "owner" | "service" = "owner",
  existingSessionId?: string,
): Promise<Carrier> {
  const session = existingSessionId
    ? { id: existingSessionId }
    : await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
        createSession(db.db, {
          accountId: owner.accountId,
          workspaceId: owner.personalWorkspaceId,
          initialMessage: "authority compatibility fixture",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          visibility: initiator === "owner" ? "user_private" : "workspace_shared",
          subjectId: owner.subjectId,
          createdBy: { kind: "subject", subjectId: owner.subjectId },
          createdByContext: {},
        }),
      );
  const actor =
    initiator === "owner"
      ? { subjectId: owner.subjectId }
      : { subjectId: CORE_SUBJECT, initiatingHumanSubjectId: null };
  const turn = await withSessionRlsActorContext(actor, () =>
    enqueueSessionTurn(db.db, {
      accountId: owner.accountId,
      workspaceId: owner.personalWorkspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "authority compatibility fixture",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator:
        initiator === "owner"
          ? { kind: "subject", subjectId: owner.subjectId }
          : { kind: "service", subjectId: CORE_SUBJECT },
    }),
  );
  return { sessionId: session.id, turnId: turn.id };
}

/** Run as the application role in the owner's Personal workspace. */
async function asOwner<T>(work: (db: Database) => Promise<T>): Promise<T> {
  return await withSessionRlsActorContext({ subjectId: org!.subjectId }, () =>
    withRlsContext(
      client!.db,
      { accountId: org!.accountId, workspaceId: org!.personalWorkspaceId },
      work,
    ),
  );
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

/** A causal update (a wait timeout) of the private session, caused by `causalTurnId`. */
async function insertWaitTimeout(
  db: Database,
  carrier: Carrier,
  causalTurnId: string,
  extra: { subscriptionAuthority?: unknown } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await rawRows(
    db,
    sql`insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
          payload, lineage, subscription_authority, authority_inserted_at
        ) values (
          ${id}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
          ${carrier.sessionId}::uuid, 'session_wait_timeout', ${id}, ${`compat:${id}`},
          'wait timed out', ${JSON.stringify({ type: "session_wait_timeout" })}::jsonb,
          ${JSON.stringify({ causalTurnId })}::jsonb,
          ${extra.subscriptionAuthority === undefined ? null : JSON.stringify(extra.subscriptionAuthority)}::jsonb,
          '2000-01-01T00:00:00Z'::timestamptz
        )`,
  );
  return id;
}

async function copy(db: Database, provider: string, kind: string, id: string) {
  const [row] = await rawRows<{ copied: boolean }>(
    db,
    sql`select opengeni_private.copy_subscription_authority_compat(
          ${provider}, ${kind}, ${org!.personalWorkspaceId}::uuid, ${id}::uuid, null) as copied`,
  );
  return row!.copied;
}

/** An Agent message into `receiver`'s session, sent by `caller`'s turn. */
async function insertAgentMessage(db: Database, receiver: Carrier, caller: Carrier) {
  const id = crypto.randomUUID();
  await rawRows(
    db,
    sql`insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
          payload, lineage
        ) values (
          ${id}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
          ${receiver.sessionId}::uuid, 'agent_message', ${id}, ${`compat:${id}`},
          'agent message', ${JSON.stringify({ type: "agent_message" })}::jsonb,
          ${JSON.stringify({
            callerSessionId: caller.sessionId,
            callerTurnId: caller.turnId,
            callerAttemptId: crypto.randomUUID(),
            callerExecutionGeneration: 1,
          })}::jsonb
        )`,
  );
  return id;
}

async function read(db: Database, provider: string, kind: string, id: string) {
  const [row] = await rawRows<{ authority: unknown }>(
    db,
    sql`select opengeni_private.read_subscription_authority_compat(
          ${provider}, ${kind}, ${org!.personalWorkspaceId}::uuid, ${id}::uuid, null) as authority`,
  );
  return row!.authority;
}

async function records(carrierId: string) {
  return [
    ...(await database!.admin<
      {
        provider: string;
        carrier_kind: string;
        personal: unknown;
        shared_pool: string;
        legacy_scope: string;
        owner_subject_id: string | null;
      }[]
    >`
      select provider, carrier_kind, personal, shared_pool, legacy_scope, owner_subject_id
      from opengeni_private.subscription_authority_compat
      where ${carrierId}::uuid in (session_id, turn_id, scheduled_task_id, system_update_id, outbox_id)
      order by provider`),
  ];
}

/** A record the provider's drained cutover would write (the owner writes it). */
async function cutoverRecord(
  turnId: string,
  content: {
    personal: unknown[];
    sharedPool: "workspace" | "organization" | "none";
    legacyScope: "organization" | "workspace" | "user" | "missing";
    owner: string | null;
  },
) {
  await database!.admin`
    insert into opengeni_private.subscription_authority_compat (
      account_id, workspace_id, provider, carrier_kind, turn_id, personal, shared_pool,
      legacy_scope, owner_subject_id
    ) values (
      ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid, 'claude', 'session_turn',
      ${turnId}::uuid, ${database!.admin.json(content.personal as never)}::jsonb, ${content.sharedPool},
      ${content.legacyScope}, ${content.owner}
    )`;
}

/** A personal Claude connection of the organization owner at `generation`. */
async function personalClaudeConnection(generation: number): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await database!.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org!.accountId}::uuid, ${org!.membershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, ${generation}, 'active'
    )`;
  await database!.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation
    ) values (
      ${connectionId}::uuid, ${org!.accountId}::uuid, 'claude', 'v1:x', 'personal', 'people',
      ${org!.membershipId}::uuid, ${org!.subjectId}, ${authorityId}::uuid,
      'subscription_connection', ${generation}
    )`;
  return connectionId;
}

/**
 * Deliver `updates` into a new system turn of `carrier`'s session, as the
 * inbox does (the updates point at the turn before it is inserted), and copy
 * the turn's Claude record when asked. Fixture writer: the delivery history
 * row is not part of this check, so its reference is skipped.
 */
async function deliver(
  carrier: Carrier,
  updates: string[],
  copyRecord: boolean,
  turn: { source: "system" | "goal"; human: string | null } = { source: "system", human: null },
) {
  await database!.admin.begin(async (tx) => {
    const turnId = crypto.randomUUID();
    await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
    await tx`select set_config('opengeni.account_id', ${org!.accountId}, true),
      set_config('opengeni.workspace_id', ${org!.personalWorkspaceId}, true)`;
    await tx`set local session_replication_role = replica`;
    await tx`update session_system_updates
      set state = 'delivered', delivered_turn_id = ${turnId}::uuid, delivered_at = now(),
        delivered_history_item_id = gen_random_uuid()
      where id = any(${updates}::uuid[])`;
    await tx`set local session_replication_role = origin`;
    await tx`insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, sandbox_backend,
        initiating_human_subject_id
      ) values (${turnId}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
        ${carrier.sessionId}::uuid, gen_random_uuid(), ${`session-${carrier.sessionId}`},
        'completed', ${turn.source},
        (select coalesce(max(position), 0) + 1 from session_turns where session_id = ${carrier.sessionId}::uuid),
        'delivery', 'scripted-model', 'medium', 'none', ${turn.human})`;
    if (copyRecord) {
      await tx`select opengeni_private.copy_subscription_authority_compat(
        'claude', 'session_turn', ${org!.personalWorkspaceId}::uuid, ${turnId}::uuid, null)`;
    }
  });
}

/**
 * A finished turn of `carrier`'s session written as the runtime writes an
 * edit or a compaction, copying its Claude record when asked. `started`
 * first records a `turn.started` event for an existing turn of the session.
 */
async function insertTurn(
  carrier: Carrier,
  turn: { source: "user" | "compaction"; lineage: Record<string, unknown>; human: string | null },
  copyRecord: boolean,
  started?: string,
): Promise<string> {
  const turnId = crypto.randomUUID();
  await database!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
    await tx`select set_config('opengeni.account_id', ${org!.accountId}, true),
      set_config('opengeni.workspace_id', ${org!.personalWorkspaceId}, true)`;
    if (started) {
      await tx`insert into session_events (
          account_id, workspace_id, session_id, sequence, type, turn_id, payload
        ) values (${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
          ${carrier.sessionId}::uuid,
          (select coalesce(max(sequence), 0) + 1 from session_events
            where session_id = ${carrier.sessionId}::uuid),
          'turn.started', ${started}::uuid, '{}'::jsonb)`;
    }
    await tx`insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, source, position, prompt, model, reasoning_effort, sandbox_backend, lineage,
        initiator_kind, initiator_subject_id, initiating_human_subject_id
      ) values (${turnId}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
        ${carrier.sessionId}::uuid, gen_random_uuid(), ${`session-${carrier.sessionId}`},
        'completed', ${turn.source},
        (select coalesce(max(position), 0) + 1 from session_turns where session_id = ${carrier.sessionId}::uuid),
        'fixture', 'scripted-model', 'medium', 'none', ${tx.json(turn.lineage as never)}::jsonb,
        ${turn.human ? "subject" : "service"}, ${turn.human ?? CORE_SUBJECT}, ${turn.human})`;
    if (copyRecord) {
      await tx`select opengeni_private.copy_subscription_authority_compat(
        'claude', 'session_turn', ${org!.personalWorkspaceId}::uuid, ${turnId}::uuid, null)`;
    }
  });
  return turnId;
}

/** Insert a goal continuation caused by `causalTurnId`, copying its Claude record when asked. */
async function insertGoalContinuation(
  db: Database,
  carrier: Carrier,
  causalTurnId: string,
  copyRecord: boolean,
): Promise<string> {
  const id = crypto.randomUUID();
  await rawRows(
    db,
    sql`insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
          payload, lineage
        ) values (
          ${id}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
          ${carrier.sessionId}::uuid, 'goal_continuation', ${id}, ${`compat:${id}`},
          'continue the goal', ${JSON.stringify({ type: "goal_continuation" })}::jsonb,
          ${JSON.stringify({ causalTurnId })}::jsonb
        )`,
  );
  if (copyRecord) await copy(db, "claude", "session_system_update", id);
  return id;
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-authority-compat");
  if (!database) throw new Error("Real PostgreSQL is required");
  // Stage a provisioned database without 0713, as a deployment is before it.
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values (${COMPAT}), (${FENCES})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await owner.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  appUrl = url.toString();
  const staged = createDb(appUrl, { max: 2 });
  try {
    org = await organization(staged, "owner");
    before = await acceptedTurn(staged, org);
  } finally {
    await staged.close();
  }
  // A rolling migration keeps the previous binary's runtime posture until
  // roles are provisioned again: apply 0713 alone, evaluate as the runtime
  // role, then provision and evaluate again.
  const ownerAgain = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await ownerAgain`delete from schema_migrations where name in (${COMPAT}, ${FENCES})`;
    await database.admin.unsafe(
      `CREATE ROLE "${customApplicationRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`,
    );
    await migrate(database.ownerUrl, undefined, {
      applicationDatabaseRoles: ["opengeni_app", customApplicationRole],
    });
    const [applied] = await ownerAgain<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name in (${COMPAT}, ${FENCES})`;
    if (applied?.count !== 2) {
      throw new Error("0713 and 0714 were not applied by the second migrate");
    }
    const grants = await database.admin<{ routine: string; allowed: boolean }[]>`
      select routine, has_function_privilege(${customApplicationRole}, routine, 'EXECUTE') as allowed
      from unnest(array[
        'opengeni_private.copy_subscription_authority_compat(text,text,uuid,uuid,bigint)',
        'opengeni_private.read_subscription_authority_compat(text,text,uuid,uuid,bigint)',
        'opengeni_private.subscription_authority_compat_providers()',
        'opengeni_subscription_internal.enforce_subscription_authority_compat()'
      ]) routine`;
    customRoleGrantsBeforeProvision = Object.fromEntries(
      grants.map((grant) => [grant.routine, grant.allowed]),
    );
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
  const [marker] = await database.admin<{ at: Date }[]>`
    select authority_inserted_at as at from session_turns where id = ${before!.turnId}::uuid`;
  migratedAt = marker!.at;
}, 180_000);

afterAll(async () => {
  await client?.close();
  if (database) {
    await database.admin.unsafe(`DROP OWNED BY "${customApplicationRole}"`).catch(() => undefined);
    await database.admin
      .unsafe(`DROP ROLE IF EXISTS "${customApplicationRole}"`)
      .catch(() => undefined);
  }
  await database?.release();
});

describe.skipIf(!realDb)("0713 subscription authority compatibility", () => {
  test("applies over a provisioned database and keeps the runtime posture before and after provisioning", async () => {
    expect(posture).toEqual({ unprovisioned: [], provisioned: [] });
    // Every configured application role can run the three runtime routines
    // before provisioning; the owner-only check is never granted.
    expect(customRoleGrantsBeforeProvision).toEqual({
      "opengeni_private.copy_subscription_authority_compat(text,text,uuid,uuid,bigint)": true,
      "opengeni_private.read_subscription_authority_compat(text,text,uuid,uuid,bigint)": true,
      "opengeni_private.subscription_authority_compat_providers()": true,
      "opengeni_subscription_internal.enforce_subscription_authority_compat()": false,
    });
    const [identity] = await rawRows<{ role: string; superuser: boolean; bypass: boolean }>(
      client!.db,
      sql`select current_user::text as role, rolsuper as superuser, rolbypassrls as bypass
          from pg_roles where rolname = current_user`,
    );
    expect(identity).toEqual({ role: "opengeni_app", superuser: false, bypass: false });
  });

  test("authority_inserted_at: existing rows read the migration time, explicit values are replaced, never changed", async () => {
    // Every carrier row that existed before 0713 reads 0713's transaction time.
    const existing = await database!.admin<{ count: number; distinct: number }[]>`
      select count(*)::int as count, count(distinct authority_inserted_at)::int as distinct
      from (
        select authority_inserted_at from sessions where id = ${before!.sessionId}::uuid
        union all select authority_inserted_at from session_turns where id = ${before!.turnId}::uuid
      ) markers`;
    expect(existing[0]).toEqual({ count: 2, distinct: 1 });
    expect(migratedAt!.getTime()).toBeLessThan(Date.now());
    const defaults = await database!.admin<{ table_name: string; column_default: string }[]>`
      select table_name::text, column_default::text from information_schema.columns
      where table_schema = 'public' and column_name = 'authority_inserted_at' and is_nullable = 'NO'
      order by table_name`;
    expect(defaults.map((row) => row.table_name)).toEqual([
      "scheduled_task_revision_authorities",
      "scheduled_tasks",
      "session_system_update_outbox",
      "session_system_updates",
      "session_turns",
      "sessions",
    ]);
    expect(new Set(defaults.map((row) => row.column_default))).toEqual(
      new Set(["transaction_timestamp()"]),
    );
    // A writer (an older binary or a backdating import) that supplies a value
    // is not rejected: the marker is this transaction's start.
    const stamped = await asOwner(async (db) => {
      const id = await insertWaitTimeout(db, before!, before!.turnId);
      const [row] = await rawRows<{ stamped: boolean }>(
        db,
        sql`select authority_inserted_at = transaction_timestamp() as stamped
            from session_system_updates where id = ${id}::uuid`,
      );
      return { id, stamped: row!.stamped };
    });
    expect(stamped.stamped).toBe(true);
    // Never changed, by the runtime role or the owner.
    expect(
      await failure(() =>
        asOwner((db) =>
          rawRows(
            db,
            sql`update session_system_updates set authority_inserted_at = '2000-01-01T00:00:00Z'
                where id = ${stamped.id}::uuid`,
          ),
        ),
      ),
    ).toStartWith("42501");
    expect(
      await failure(
        () =>
          database!
            .admin`update session_turns set authority_inserted_at = authority_inserted_at - interval '1 day'
            where id = ${before!.turnId}::uuid`,
      ),
    ).toStartWith("42501");
    // The marker is not execution state: a task's digest (and every run
    // receipt holding it) does not depend on it.
    const [digest] = await database!.admin<{ same: boolean; trigger_excludes: boolean }[]>`
      select
        scheduled_task_execution_digest(jsonb_populate_record(null::scheduled_tasks,
          '{"name":"digest","authority_inserted_at":"2000-01-01T00:00:00Z"}'::jsonb))
        = scheduled_task_execution_digest(jsonb_populate_record(null::scheduled_tasks,
          '{"name":"digest","authority_inserted_at":"2030-01-01T00:00:00Z"}'::jsonb)) as same,
        strpos(pg_get_functiondef('set_scheduled_task_execution_digest()'::regprocedure),
          '- ''authority_inserted_at''') > 0 as trigger_excludes`;
    expect(digest).toEqual({ same: true, trigger_excludes: true });
  });

  test("the compatibility relation is owner-only, and records exist only after a provider's own receipt", async () => {
    for (const statement of [
      sql`select count(*) from opengeni_private.subscription_authority_compat`,
      sql`insert into opengeni_private.subscription_authority_compat (
            account_id, workspace_id, provider, carrier_kind, turn_id, personal, shared_pool, legacy_scope
          ) values (${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid, 'claude',
            'session_turn', ${before!.turnId}::uuid, '[]', 'workspace', 'workspace')`,
      sql`update opengeni_private.subscription_authority_compat set shared_pool = 'none'`,
      sql`delete from opengeni_private.subscription_authority_compat`,
    ]) {
      expect(await failure(() => asOwner((db) => rawRows(db, statement)))).toStartWith("42501");
    }
    const [table] = await database!.admin<{ forced: boolean; acl: string | null }[]>`
      select relforcerowsecurity as forced, relacl::text as acl from pg_class
      where oid = 'opengeni_private.subscription_authority_compat'::regclass`;
    expect(table!.forced).toBe(true);
    expect(table!.acl ?? "").not.toContain("opengeni_app");
    // Codex was cut over before receipts existed ('-infinity') and never gets
    // a record; a provider without a receipt gets none either.
    for (const provider of ["codex", "claude"]) {
      expect(
        await failure(
          () => database!.admin`
            insert into opengeni_private.subscription_authority_compat (
              account_id, workspace_id, provider, carrier_kind, turn_id, personal, shared_pool, legacy_scope
            ) values (${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid, ${provider},
              'session_turn', ${before!.turnId}::uuid, '[]', 'workspace', 'workspace')`,
        ),
      ).toStartWith("55000");
    }
  });

  test("inert for Codex and for providers without a receipt", async () => {
    const inert = await asOwner(async (db) => {
      const [providers] = await rawRows<{ providers: string[] }>(
        db,
        sql`select opengeni_private.subscription_authority_compat_providers() as providers`,
      );
      const id = await insertWaitTimeout(db, before!, before!.turnId);
      return {
        providers: providers!.providers,
        copiedCodex: await copy(db, "codex", "session_system_update", id),
        copiedClaude: await copy(db, "claude", "session_system_update", id),
        codex: await read(db, "codex", "session_turn", before!.turnId),
        claude: await read(db, "claude", "session_turn", before!.turnId),
        id,
      };
    });
    expect(inert).toMatchObject({
      providers: [],
      copiedCodex: false,
      copiedClaude: false,
      codex: { authority: "none" },
      claude: { authority: "v1" },
    });
    // Committed without a record: nothing checks it while no provider can
    // hold records.
    expect(await records(inert.id)).toEqual([]);
  });

  describe("after a provider's own receipt", () => {
    let ownerTurn: Carrier | null = null;
    let workspaceTurn: Carrier | null = null;
    let serviceTurn: Carrier | null = null;
    /** A shared session's service turn, and a wait timeout it caused that the cutover missed. */
    let batchSource: Carrier | null = null;
    let missedUpdate: string | null = null;
    beforeAll(async () => {
      if (!realDb) return;
      // Turns by the owner and by a service (no human); all predate the
      // receipt below.
      ownerTurn = await acceptedTurn(client!, org!);
      workspaceTurn = await acceptedTurn(client!, org!);
      serviceTurn = await acceptedTurn(client!, org!, "service");
      batchSource = await acceptedTurn(client!, org!, "service");
      missedUpdate = await asOwner((db) =>
        insertWaitTimeout(db, batchSource!, batchSource!.turnId),
      );
      await database!.admin`
        insert into opengeni_private.subscription_provider_cutover_receipts (
          provider, migration, committed_at, seed_rotation
        ) values ('claude', '0799_subscription_core_claude_cutover.sql', clock_timestamp(),
          '{"mode":"spread"}')`;
    });

    test("the reader answers per provider: v1 before a receipt, missing for a pre-receipt carrier without either", async () => {
      const answers = await asOwner(async (db) => {
        const [providers] = await rawRows<{ providers: string[] }>(
          db,
          sql`select opengeni_private.subscription_authority_compat_providers() as providers`,
        );
        return {
          providers: providers!.providers,
          claude: await read(db, "claude", "session_turn", before!.turnId),
          xai: await read(db, "xai", "session_turn", before!.turnId),
          codex: await read(db, "codex", "session_turn", before!.turnId),
          invisible: await read(db, "claude", "session_turn", crypto.randomUUID()),
        };
      });
      expect(answers).toEqual({
        providers: ["claude"],
        claude: { authority: "missing", personal: [], sharedPool: "none" },
        xai: { authority: "v1" },
        codex: { authority: "none" },
        invisible: null,
      });
    });

    test("a carrier derived from a pre-receipt source commits only with the waiting `missing` copy", async () => {
      // Without the copy the commit-time check rejects the whole transaction.
      expect(
        await failure(() => asOwner((db) => insertWaitTimeout(db, before!, before!.turnId))),
      ).toStartWith("23514");
      const copied = await asOwner(async (db) => {
        const id = await insertWaitTimeout(db, before!, before!.turnId);
        return { id, copied: await copy(db, "claude", "session_system_update", id) };
      });
      expect(copied.copied).toBe(true);
      expect(await records(copied.id)).toEqual([
        {
          provider: "claude",
          carrier_kind: "session_system_update",
          personal: [],
          shared_pool: "none",
          legacy_scope: "missing",
          owner_subject_id: null,
        },
      ]);
      expect(await asOwner((db) => read(db, "claude", "session_system_update", copied.id))).toEqual(
        {
          authority: "record",
          personal: [],
          sharedPool: "none",
          legacyScope: "missing",
        },
      );
    });

    test("copies keep personal authority only for the record's owner and narrow otherwise", async () => {
      const entry = {
        ownerMembershipId: org!.membershipId,
        authorityGeneration: 7,
        connectionIds: [crypto.randomUUID()],
      };
      // What the cutover writes: a `user` record and a Personal-workspace
      // `workspace` record with the owner's entry on owner turns, and an
      // ownerless `workspace` record on the service turn.
      await cutoverRecord(ownerTurn!.turnId, {
        personal: [entry],
        sharedPool: "none",
        legacyScope: "user",
        owner: org!.subjectId,
      });
      await cutoverRecord(workspaceTurn!.turnId, {
        personal: [entry],
        sharedPool: "workspace",
        legacyScope: "workspace",
        owner: org!.subjectId,
      });
      await cutoverRecord(serviceTurn!.turnId, {
        personal: [],
        sharedPool: "workspace",
        legacyScope: "workspace",
        owner: null,
      });
      const copied = await asOwner(async (db) => {
        const result: Record<string, { id: string; copied: boolean }> = {};
        const add = async (name: string, id: string) => {
          result[name] = { id, copied: await copy(db, "claude", "session_system_update", id) };
        };
        // Owner-caused: the causal turn's human owns the record.
        await add("ownerCaused", await insertWaitTimeout(db, ownerTurn!, ownerTurn!.turnId));
        // An ownerless shared record, whatever the cause.
        await add("ownerless", await insertWaitTimeout(db, serviceTurn!, serviceTurn!.turnId));
        // Agent messages sent by the service turn (no human) into the owner's
        // sessions read the receivers' records but are not owner-caused.
        await add("userByOther", await insertAgentMessage(db, ownerTurn!, serviceTurn!));
        await add("workspaceByOther", await insertAgentMessage(db, workspaceTurn!, serviceTurn!));
        return result;
      });
      expect(copied.ownerCaused!.copied).toBe(true);
      expect(await records(copied.ownerCaused!.id)).toEqual([
        {
          provider: "claude",
          carrier_kind: "session_system_update",
          personal: [entry],
          shared_pool: "none",
          legacy_scope: "user",
          owner_subject_id: org!.subjectId,
        },
      ]);
      expect(copied.ownerless!.copied).toBe(true);
      expect((await records(copied.ownerless!.id))[0]).toMatchObject({
        personal: [],
        shared_pool: "workspace",
        legacy_scope: "workspace",
        owner_subject_id: null,
      });
      // A `user` record caused by someone else is not carried: no record, no
      // wait, shared capacity as for a new acceptance.
      expect(copied.userByOther!.copied).toBe(false);
      expect(await records(copied.userByOther!.id)).toEqual([]);
      expect(
        await asOwner((db) => read(db, "claude", "session_system_update", copied.userByOther!.id)),
      ).toEqual({ authority: "none" });
      // A `workspace` record caused by someone else keeps only its narrowing.
      expect(copied.workspaceByOther!.copied).toBe(true);
      expect(await records(copied.workspaceByOther!.id)).toEqual([
        {
          provider: "claude",
          carrier_kind: "session_system_update",
          personal: [],
          shared_pool: "workspace",
          legacy_scope: "workspace",
          owner_subject_id: null,
        },
      ]);
    });

    test("the commit-time check rejects a missing, different or v2-shadowed copy", async () => {
      // A derived carrier committed without its record.
      expect(
        await failure(() => asOwner((db) => insertWaitTimeout(db, ownerTurn!, ownerTurn!.turnId))),
      ).toStartWith("23514");
      // A different record, written by a role that can (the owner).
      expect(
        await failure(() =>
          database!.admin.begin(async (tx) => {
            const id = crypto.randomUUID();
            await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
            await tx`
              insert into session_system_updates (
                id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary,
                payload, lineage
              ) values (
                ${id}::uuid, ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
                ${ownerTurn!.sessionId}::uuid, 'session_wait_timeout', ${id}, ${`compat:${id}`},
                'wait timed out', '{"type":"session_wait_timeout"}'::jsonb,
                ${tx.json({ causalTurnId: ownerTurn!.turnId })}::jsonb
              )`;
            await tx`
              insert into opengeni_private.subscription_authority_compat (
                account_id, workspace_id, provider, carrier_kind, system_update_id, personal,
                shared_pool, legacy_scope
              ) values (${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid, 'claude',
                'session_system_update', ${id}::uuid, '[]', 'none', 'missing')`;
          }),
        ),
      ).toStartWith("23514");
      // The right record, but the carrier also froze a v2 entry for the
      // provider: a carrier has at most one of the two.
      expect(
        await failure(() =>
          asOwner(async (db) => {
            const id = await insertWaitTimeout(db, ownerTurn!, ownerTurn!.turnId, {
              subscriptionAuthority: {
                version: 2,
                personal: [
                  {
                    provider: "claude",
                    ownerMembershipId: org!.membershipId,
                    authorityGeneration: 7,
                  },
                ],
              },
            });
            await copy(db, "claude", "session_system_update", id);
          }),
        ),
      ).toStartWith("23514");
    });

    test("the copy routine takes no content and copies only into a carrier its transaction inserted", async () => {
      // A carrier inserted by an earlier transaction.
      expect(
        await failure(() => asOwner((db) => copy(db, "claude", "session_turn", ownerTurn!.turnId))),
      ).toStartWith("55000");
      // Another workspace than the caller's.
      expect(
        await failure(() =>
          asOwner((db) =>
            rawRows(
              db,
              sql`select opengeni_private.copy_subscription_authority_compat(
                    'claude', 'session_turn', ${crypto.randomUUID()}::uuid,
                    ${ownerTurn!.turnId}::uuid, null)`,
            ),
          ),
        ),
      ).toStartWith("42501");
      const [signature] = await database!.admin<{ args: string }[]>`
        select pg_get_function_identity_arguments(
          'opengeni_private.copy_subscription_authority_compat(text,text,uuid,uuid,bigint)'::regprocedure
        ) as args`;
      expect(signature!.args).toBe(
        "p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint",
      );
    });

    test("records are never updated or deleted except with their carrier", async () => {
      const [record] = await database!.admin<{ id: string }[]>`
        select id::text from opengeni_private.subscription_authority_compat
        where turn_id = ${ownerTurn!.turnId}::uuid`;
      expect(
        await failure(
          () => database!.admin`
            update opengeni_private.subscription_authority_compat set shared_pool = 'workspace'
            where id = ${record!.id}::uuid`,
        ),
      ).toStartWith("42501");
      expect(
        await failure(
          () => database!.admin`
            delete from opengeni_private.subscription_authority_compat where id = ${record!.id}::uuid`,
        ),
      ).toStartWith("42501");
      expect(
        await failure(
          () => database!.admin`truncate opengeni_private.subscription_authority_compat`,
        ),
      ).toStartWith("42501");
      // Under FORCE row security the owner sees no row to change.
      const owner = postgres(database!.ownerUrl, { max: 1, onnotice: () => undefined });
      try {
        const changed = await owner`
          update opengeni_private.subscription_authority_compat set shared_pool = 'workspace'
          where id = ${record!.id}::uuid`;
        expect(changed.count).toBe(0);
      } finally {
        await owner.end();
      }
      // Deleting the carrier deletes its records (session retention keeps working).
      const doomed = await acceptedTurn(client!, org!);
      await cutoverRecord(doomed.turnId, {
        personal: [],
        sharedPool: "organization",
        legacyScope: "organization",
        owner: null,
      });
      expect(await records(doomed.turnId)).toHaveLength(1);
      await database!.admin`delete from sessions where id = ${doomed.sessionId}::uuid`;
      expect(await records(doomed.turnId)).toEqual([]);
    });

    test("one delivering turn never mixes a narrowed, an unnarrowed and a waiting update", async () => {
      // The cutover recorded a workspace narrowing on the service turn; a turn
      // accepted in the same session after the receipt is a new acceptance
      // (no record).
      const narrowedSource = batchSource!;
      await cutoverRecord(narrowedSource.turnId, {
        personal: [],
        sharedPool: "workspace",
        legacyScope: "workspace",
        owner: null,
      });
      const freshSource = await acceptedTurn(client!, org!, "service", narrowedSource.sessionId);
      const updates = await asOwner(async (db) => {
        const narrowed = await insertWaitTimeout(db, narrowedSource, narrowedSource.turnId);
        const fresh = await insertWaitTimeout(db, narrowedSource, freshSource.turnId);
        return {
          narrowed,
          narrowedCopied: await copy(db, "claude", "session_system_update", narrowed),
          fresh,
          freshCopied: await copy(db, "claude", "session_system_update", fresh),
        };
      });
      expect(updates).toMatchObject({ narrowedCopied: true, freshCopied: false });
      // The cutover missed `missedUpdate`: it waits (`missing`), the fresh one does not.
      expect(
        await asOwner((db) => read(db, "claude", "session_system_update", missedUpdate!)),
      ).toEqual({ authority: "missing", personal: [], sharedPool: "none" });
      for (const mixed of [
        [updates.narrowed, updates.fresh],
        [missedUpdate!, updates.fresh],
        [missedUpdate!, updates.narrowed],
      ]) {
        for (const copyRecord of [false, true]) {
          expect(await failure(() => deliver(narrowedSource, mixed, copyRecord))).toContain(
            "subscription authority sources of one session_turn carrier disagree",
          );
        }
      }
      // Delivered apart, each turn carries exactly its update's copy.
      expect(await failure(() => deliver(narrowedSource, [updates.narrowed], false))).toStartWith(
        "23514",
      );
      expect(await failure(() => deliver(narrowedSource, [updates.narrowed], true))).toBe(
        "succeeded",
      );
      expect(await failure(() => deliver(narrowedSource, [updates.fresh], false))).toBe(
        "succeeded",
      );
      expect(await failure(() => deliver(narrowedSource, [missedUpdate!], true))).toBe("succeeded");
      const delivered = await database!.admin<
        { id: string; shared_pool: string | null; legacy_scope: string | null }[]
      >`
        select update_row.id::text as id, record.shared_pool, record.legacy_scope
        from session_system_updates update_row
        left join opengeni_private.subscription_authority_compat record
          on record.turn_id = update_row.delivered_turn_id and record.provider = 'claude'
        where update_row.id = any(${[updates.narrowed, updates.fresh, missedUpdate!]}::uuid[])`;
      expect(
        new Map(delivered.map((row) => [row.id, [row.shared_pool, row.legacy_scope]])),
      ).toEqual(
        new Map([
          [updates.narrowed, ["workspace", "workspace"]],
          [updates.fresh, [null, null]],
          [missedUpdate!, ["none", "missing"]],
        ]),
      );
    });

    test("an edited prompt copies the exact turn withdrawn for its edit, and nothing else", async () => {
      const entry = {
        ownerMembershipId: org!.membershipId,
        authorityGeneration: 7,
        connectionIds: [crypto.randomUUID()],
      };
      // A queued prompt holding the owner's record, withdrawn for edit as
      // the queue's Edit command does.
      const source = await acceptedTurn(client!, org!);
      await cutoverRecord(source.turnId, {
        personal: [entry],
        sharedPool: "workspace",
        legacyScope: "workspace",
        owner: org!.subjectId,
      });
      await database!.admin`
        update session_turns set status = 'withdrawn_for_edit', cancel_reason = 'withdrawn_for_edit',
          cancelled_by = ${org!.subjectId}, version = version + 1, finished_at = now(),
          updated_at = now()
        where id = ${source.turnId}::uuid`;
      const edit = (link: string, copyRecord: boolean) =>
        insertTurn(
          source,
          {
            source: "user",
            lineage: { actor: "human", editedFromTurnId: link },
            human: org!.subjectId,
          },
          copyRecord,
        );
      // The resubmitted prompt copies the withdrawn turn's record verbatim.
      expect(await failure(() => edit(source.turnId, false))).toStartWith("23514");
      const edited = await edit(source.turnId, true);
      expect(await records(edited)).toEqual([
        {
          provider: "claude",
          carrier_kind: "session_turn",
          personal: [entry],
          shared_pool: "workspace",
          legacy_scope: "workspace",
          owner_subject_id: org!.subjectId,
        },
      ]);
      // A link to a turn that was not withdrawn for this edit is refused,
      // with or without a copy.
      const live = await acceptedTurn(client!, org!, "owner", source.sessionId);
      for (const copyRecord of [false, true]) {
        expect(await failure(() => edit(live.turnId, copyRecord))).toContain(
          "an edited prompt copies only the exact turn withdrawn for its edit",
        );
      }
      // Another human's resubmission of it is refused too.
      expect(
        await failure(() =>
          insertTurn(
            source,
            {
              source: "user",
              lineage: { actor: "human", editedFromTurnId: source.turnId },
              human: `user:${crypto.randomUUID()}`,
            },
            true,
          ),
        ),
      ).toContain("an edited prompt copies only the exact turn withdrawn for its edit");
    });

    test("compaction copies the latest started turn, and a pure goal continuation its causal turn of the same human", async () => {
      const entry = {
        ownerMembershipId: org!.membershipId,
        authorityGeneration: 7,
        connectionIds: [crypto.randomUUID()],
      };
      const narrowed = await acceptedTurn(client!, org!);
      await cutoverRecord(narrowed.turnId, {
        personal: [entry],
        sharedPool: "none",
        legacyScope: "user",
        owner: org!.subjectId,
      });
      // Compaction after the started turn copies its record (same human).
      const compaction = (copyRecord: boolean, started?: string) =>
        insertTurn(
          narrowed,
          { source: "compaction", lineage: {}, human: org!.subjectId },
          copyRecord,
          started,
        );
      expect(await failure(() => compaction(false, narrowed.turnId))).toStartWith("23514");
      const compacted = await compaction(true, narrowed.turnId);
      expect((await records(compacted))[0]).toMatchObject({
        personal: [entry],
        legacy_scope: "user",
        owner_subject_id: org!.subjectId,
      });
      // Once a post-receipt turn without a record started last, compaction
      // carries nothing.
      const fresh = await acceptedTurn(client!, org!, "owner", narrowed.sessionId);
      expect(await failure(() => compaction(true, fresh.turnId))).toBe("succeeded");
      expect(await failure(() => compaction(false))).toBe("succeeded");

      // A pure goal continuation reads the goal's causal turn, only for the
      // delivering turn's own human.
      const goal = await asOwner((db) =>
        insertGoalContinuation(db, narrowed, narrowed.turnId, true),
      );
      expect((await records(goal))[0]).toMatchObject({ legacy_scope: "user" });
      const continuation = { source: "goal" as const, human: org!.subjectId };
      expect(await failure(() => deliver(narrowed, [goal], false, continuation))).toStartWith(
        "23514",
      );
      expect(await failure(() => deliver(narrowed, [goal], true, continuation))).toBe("succeeded");
      const [delivered] = await database!.admin<{ legacy_scope: string; personal: unknown }[]>`
        select record.legacy_scope, record.personal
        from session_system_updates update_row
        join opengeni_private.subscription_authority_compat record
          on record.turn_id = update_row.delivered_turn_id and record.provider = 'claude'
        where update_row.id = ${goal}::uuid`;
      expect(delivered).toEqual({ legacy_scope: "user", personal: [entry] });
      // Delivered without the causal human it has no source: no record.
      const unowned = await asOwner((db) =>
        insertGoalContinuation(db, narrowed, narrowed.turnId, true),
      );
      expect(
        await failure(() => deliver(narrowed, [unowned], true, { source: "goal", human: null })),
      ).toBe("succeeded");
      expect(
        await database!.admin`
          select record.id from session_system_updates update_row
          join opengeni_private.subscription_authority_compat record
            on record.turn_id = update_row.delivered_turn_id
          where update_row.id = ${unowned}::uuid`,
      ).toHaveLength(0);

      // Several continuations delivered together: the first in delivery order
      // (created_at, then id) names the source, as the writer copies its v2.
      const deliveredRecords = async (update: string) => [
        ...(await database!.admin<{ legacy_scope: string; personal: unknown }[]>`
          select record.legacy_scope, record.personal
          from session_system_updates update_row
          join opengeni_private.subscription_authority_compat record
            on record.turn_id = update_row.delivered_turn_id and record.provider = 'claude'
          where update_row.id = ${update}::uuid`),
      ];
      const recorded = await asOwner((db) =>
        insertGoalContinuation(db, narrowed, narrowed.turnId, true),
      );
      const unrecorded = await asOwner((db) =>
        insertGoalContinuation(db, narrowed, fresh.turnId, true),
      );
      expect(
        await failure(() => deliver(narrowed, [recorded, unrecorded], false, continuation)),
      ).toStartWith("23514");
      expect(
        await failure(() => deliver(narrowed, [recorded, unrecorded], true, continuation)),
      ).toBe("succeeded");
      expect(await deliveredRecords(recorded)).toEqual([
        { legacy_scope: "user", personal: [entry] },
      ]);
      const earlier = await asOwner((db) =>
        insertGoalContinuation(db, narrowed, fresh.turnId, true),
      );
      const later = await asOwner((db) =>
        insertGoalContinuation(db, narrowed, narrowed.turnId, true),
      );
      expect(await failure(() => deliver(narrowed, [earlier, later], true, continuation))).toBe(
        "succeeded",
      );
      expect(await deliveredRecords(earlier)).toHaveLength(0);
    });

    test("both personal helpers read a record only for its exact owner membership, current generation and connections", async () => {
      const generation = 3;
      const listed = await personalClaudeConnection(generation);
      const unlisted = await personalClaudeConnection(generation);
      await database!.admin`
        insert into subscription_provider_cutovers (account_id, provider, enabled)
        values (${org!.accountId}::uuid, 'claude', true)
        on conflict (account_id, provider) do update set enabled = true`;
      const entry = (overrides: Record<string, unknown> = {}) => ({
        ownerMembershipId: org!.membershipId,
        authorityGeneration: generation,
        connectionIds: [listed],
        ...overrides,
      });
      const withRecord = async (personal: unknown[] | null) => {
        const turn = await acceptedTurn(client!, org!);
        if (personal) {
          await cutoverRecord(turn.turnId, {
            personal,
            sharedPool: "none",
            legacyScope: "user",
            owner: org!.subjectId,
          });
        }
        return turn;
      };
      const current = await withRecord([entry()]);
      const staleGeneration = await withRecord([entry({ authorityGeneration: generation + 1 })]);
      const otherMembership = await withRecord([entry({ ownerMembershipId: crypto.randomUUID() })]);
      const noRecord = await withRecord(null);
      const identity = (turn: Carrier) => ({
        accountId: org!.accountId,
        workspaceId: org!.personalWorkspaceId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        sessionOwnerSubjectId: org!.subjectId,
        sessionOwnerMembershipId: org!.membershipId,
        initiatingHumanSubjectId: org!.subjectId,
      });
      const access = (turn: Carrier, connectionId: string) =>
        withSessionRlsActorContext(
          { subjectId: CORE_SUBJECT, initiatingHumanSubjectId: org!.subjectId },
          () =>
            withRlsContext(
              client!.db,
              { accountId: org!.accountId, workspaceId: org!.personalWorkspaceId },
              async (db) => {
                const [row] = await rawRows<{ authorized: boolean }>(
                  db,
                  sql`select opengeni_private.authorize_subscription_personal_access(
                        ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
                        ${turn.sessionId}::uuid, ${turn.turnId}::uuid, ${connectionId}::uuid,
                        'claude', ${org!.subjectId}, ${org!.subjectId}) as authorized`,
                );
                return row!.authorized;
              },
            ),
        );
      const placement = async (turn: Carrier, membershipId = org!.membershipId) => {
        const result = await withSubscriptionCoreAcceptedTurn(
          client!.db,
          identity(turn),
          async (tx) => {
            const [row] = await rawRows<{ authorized: boolean }>(
              tx,
              sql`select opengeni_private.authorize_subscription_personal_placement_access(
                  ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid,
                  ${turn.sessionId}::uuid, ${turn.turnId}::uuid, 'claude', ${membershipId}::uuid,
                  ${generation}::bigint, ${org!.subjectId}, ${org!.subjectId}) as authorized`,
            );
            const visible = async (connectionId: string) => {
              const [visibility] = await rawRows<{ visible: boolean }>(
                tx,
                sql`select opengeni_private.subscription_connection_visible(
                    ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid, ${connectionId}::uuid,
                    'personal', 'people', ${org!.membershipId}::uuid, ${org!.subjectId}, 'claude'
                  ) as visible`,
              );
              return visibility!.visible;
            };
            return {
              authorized: row!.authorized,
              listed: await visible(listed),
              unlisted: await visible(unlisted),
            };
          },
        );
        expect(result.status).toBe("completed");
        return (result as { value: { authorized: boolean; listed: boolean; unlisted: boolean } })
          .value;
      };
      expect(await access(current, listed)).toBe(true);
      expect(await access(current, unlisted)).toBe(false);
      expect(await placement(current)).toEqual({ authorized: true, listed: true, unlisted: false });
      // Membership and generation alone never reach the record's other connections.
      for (const turn of [staleGeneration, otherMembership, noRecord]) {
        expect(await access(turn, listed)).toBe(false);
        expect(await placement(turn)).toEqual({
          authorized: false,
          listed: false,
          unlisted: false,
        });
      }
      expect(await placement(current, crypto.randomUUID())).toMatchObject({ authorized: false });
      // personalConnectionsAllowed and the enabled cutover row still apply.
      await database!.admin`
        update subscription_settings set personal_connections_allowed = false
        where account_id = ${org!.accountId}::uuid and workspace_id is null`;
      expect(await access(current, listed)).toBe(false);
      expect(await placement(current)).toMatchObject({ authorized: false });
      await database!.admin`
        update subscription_settings set personal_connections_allowed = true
        where account_id = ${org!.accountId}::uuid and workspace_id is null`;
      await database!.admin`
        update subscription_provider_cutovers set enabled = false
        where account_id = ${org!.accountId}::uuid and provider = 'claude'`;
      expect(await access(current, listed)).toBe(false);
      expect(await placement(current)).toMatchObject({ authorized: false });
      await database!.admin`
        update subscription_provider_cutovers set enabled = true
        where account_id = ${org!.accountId}::uuid and provider = 'claude'`;
      expect(await access(current, listed)).toBe(true);
    });
  });
});
