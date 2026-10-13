import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  armSubscriptionCoreCodexCapacityWait,
  blockSessionWorkBeforeAttemptClaim,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionTurns,
  markSessionAttemptQuiesced,
  peekSessionWork,
  requestSessionTurnRecovery,
  steerQueuedTurnInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0760_queue_steer_admission_recheck_repair.sql";
let database: OwnerMigratedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("queue-steer-recheck-repair");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  database = acquired;
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of await readdir(join(import.meta.dir, "../drizzle"))) {
      if (name.endsWith(".sql") && name >= MIGRATION)
        await owner`insert into schema_migrations(name) values (${name})`;
    }
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await owner.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString());
}, 180_000);
afterAll(async () => {
  await client?.close();
  await database?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Repair fixture",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Repair fixture",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "Accepted work",
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const [turn] = await listSessionTurns(client.db, workspaceId, session.id);
  return { grant, workspaceId, sessionId: session.id, turn: turn! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function block(f: Fixture) {
  const peek = await peekSessionWork(client.db, f.workspaceId, f.sessionId, true);
  if (peek.kind !== "runnable" || !peek.admissionFence) throw new Error("fixture not runnable");
  await blockSessionWorkBeforeAttemptClaim(client.db, f.workspaceId, {
    accountId: f.grant.accountId,
    sessionId: f.sessionId,
    workflowId: `session-${f.sessionId}`,
    attemptId: crypto.randomUUID(),
    fence: peek.admissionFence,
    reason: "database_claim_rejected",
    sqlState: "42501",
  });
  const [row] =
    await database.admin`select admission_block from sessions where id = ${f.sessionId}`;
  return row!.admission_block;
}

async function oldSteer(f: Fixture) {
  const originalBlock = await block(f);
  await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.grant.subjectId, (db) =>
    db.transaction((tx) =>
      steerQueuedTurnInTransaction(tx as unknown as typeof db, {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        turnId: f.turn.id,
        expectedTurnVersion: f.turn.version,
        actor: { type: "human", subjectId: f.grant.subjectId },
        operationKey: crypto.randomUUID(),
      }),
    ),
  );
  // Reproduce the old writer's omission; leave its genuine command receipt,
  // target version, sequence and queue version exactly as committed.
  await database.admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${f.workspaceId}`}, 0))`;
    await tx`update sessions set admission_block = ${tx.json(originalBlock)} where id = ${f.sessionId}`;
    await tx`update session_workflow_wake_outbox set delivered_revision = wake_revision where session_id = ${f.sessionId}`;
  });
  return originalBlock;
}

async function snapshot(f: Fixture) {
  const [row] = await database.admin`
    select to_jsonb(s) as session, to_jsonb(t) as turn, to_jsonb(w) as wake
    from sessions s join session_turns t on t.id = ${f.turn.id}
    left join session_workflow_wake_outbox w on w.session_id = s.id
    where s.id = ${f.sessionId}`;
  return row!;
}

async function claim(f: Fixture) {
  const attemptId = crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId: f.sessionId,
    workflowId: `session-${f.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(result.action).toBe("claimed");
  return attemptId;
}

test("0760 repairs only an unchanged explicit recheck, through the real owner/RLS boundary", async () => {
  const eligible = await fixture();
  await oldSteer(eligible);
  const secondWorkspace = await fixture();
  await oldSteer(secondWorkspace);
  const noSteer = await fixture();
  await block(noSteer);
  const laterBlock = await fixture();
  await oldSteer(laterBlock);
  // A later admission refusal must win over the old direction, even if its
  // legacy status was subsequently misprojected as queued too.
  await database.admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${laterBlock.workspaceId}`}, 0))`;
    await tx`update sessions set admission_block = jsonb_set(admission_block,
      '{blockedAt}', to_jsonb(to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      where id = ${laterBlock.sessionId}`;
  });
  const edited = await fixture();
  await oldSteer(edited);
  await database.admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${edited.workspaceId}`}, 0))`;
    await tx`update session_turns set version = version + 1 where id = ${edited.turn.id}`;
  });
  const recovering = await fixture();
  const interrupted = await claim(recovering);
  await requestSessionTurnRecovery(client.db, recovering.workspaceId, {
    sessionId: recovering.sessionId,
    turnId: recovering.turn.id,
    triggerEventId: recovering.turn.triggerEventId,
    attemptId: interrupted,
    reason: "worker_shutdown",
  });
  await markSessionAttemptQuiesced(client.db, {
    workspaceId: recovering.workspaceId,
    sessionId: recovering.sessionId,
    attemptId: interrupted,
    temporalWorkflowId: `session-${recovering.sessionId}`,
  });
  await database.admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${recovering.workspaceId}`}, 0))`;
    await tx`update sessions set status = 'idle', direct_control_state = 'paused', direct_pause_revision = 1, control_version = 1
      where id = ${recovering.sessionId}`;
  });
  const capacity = await fixture();
  const capacityAttempt = await claim(capacity);
  expect(
    await armSubscriptionCoreCodexCapacityWait(client.db, {
      accountId: capacity.grant.accountId,
      workspaceId: capacity.workspaceId,
      sessionId: capacity.sessionId,
      turnId: capacity.turn.id,
      attemptId: capacityAttempt,
      waitReason: "no_eligible_capacity",
      earliestResetAt: new Date(Date.now() + 60_000),
      failurePayload: { code: "subscription_capacity_unavailable" },
    }),
  ).toMatchObject({ action: "waiting" });
  const kept = [noSteer, laterBlock, edited, recovering, capacity];
  const beforeKept = await Promise.all(kept.map(snapshot));
  const before = await snapshot(eligible);
  const beforeAttempts =
    await database.admin`select to_jsonb(a) as attempt from session_turn_attempts a order by id`;
  const beforeWaiters =
    await database.admin`select to_jsonb(w) as waiter from subscription_capacity_waiters w order by session_id`;
  const beforeHistory =
    await database.admin`select to_jsonb(h) as history from session_history_items h order by id`;
  await database.admin`delete from schema_migrations where name = ${MIGRATION}`;
  await migrate(database.ownerUrl);

  const after = await snapshot(eligible);
  expect(after.session.admission_block).toBeNull();
  expect(after.session.status).toBe("queued");
  expect(after.turn).toEqual(before.turn);
  expect(Number(after.session.activity_revision)).toBeGreaterThan(
    Number(before.session.activity_revision),
  );
  expect(after.session.activity_revision_pending_xid).toBeNull();
  expect((await snapshot(secondWorkspace)).session.admission_block).toBeNull();
  expect(Number(after.wake.wake_revision)).toBe(Number(before.wake.wake_revision) + 1);
  expect(Number(after.wake.delivered_revision)).toBe(Number(before.wake.delivered_revision));
  expect(after.wake.reason).toBe("queue_steer_recheck_repair");
  expect(await Promise.all(kept.map(snapshot))).toEqual(beforeKept);
  expect([
    ...(await database.admin`select to_jsonb(a) as attempt from session_turn_attempts a order by id`),
  ]).toEqual([...beforeAttempts]);
  expect([
    ...(await database.admin`select to_jsonb(w) as waiter from subscription_capacity_waiters w order by session_id`),
  ]).toEqual([...beforeWaiters]);
  expect([
    ...(await database.admin`select to_jsonb(h) as history from session_history_items h order by id`),
  ]).toEqual([...beforeHistory]);
  const posture = await database.admin`select relname, relforcerowsecurity from pg_class
    where relname in ('sessions','session_turns','session_turn_attempts','session_command_receipts','session_events','session_workflow_wake_outbox','workspace_session_activity_revisions')`;
  expect(posture).toHaveLength(7);
  expect(posture.every((row) => row.relforcerowsecurity)).toBe(true);
  const triggers = await database.admin`select tgname, tgenabled from pg_trigger
    where tgrelid = 'sessions'::regclass and tgname in
      ('session_tenancy_workspace_fence', 'sessions_mark_activity_pending',
       'sessions_activity_insert_commit_guard', 'sessions_activity_update_commit_guard')`;
  expect(triggers).toHaveLength(4);
  expect(triggers.every((row) => row.tgenabled === "O")).toBe(true);
  expect(await peekSessionWork(client.db, eligible.workspaceId, eligible.sessionId)).toEqual({
    kind: "runnable",
  });
  // Reapplying even the SQL (not just the ledger) is a no-op after convergence.
  await database.admin`delete from schema_migrations where name = ${MIGRATION}`;
  await migrate(database.ownerUrl);
  expect(await snapshot(eligible)).toEqual(after);
}, 180_000);
