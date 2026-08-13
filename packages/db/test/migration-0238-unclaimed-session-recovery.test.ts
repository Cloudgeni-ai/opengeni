import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
} from "../src/index";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0238_recover_unclaimed_session_turns.sql",
);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let migration = "";

beforeAll(async () => {
  migration = await readFile(migrationPath, "utf8");
  const acquired = await acquireSharedTestDatabase("migration-0238-unclaimed-session-recovery");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function createInitializedSession(
  initialMessage: string,
  options: { pausedWorkspace?: boolean } = {},
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "migration-0238-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Unclaimed recovery migration test",
    workspaceExternalSource: "migration-0238-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Unclaimed recovery migration test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  if (options.pausedWorkspace) {
    await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `pause:${suffix}`,
          action: "pause",
          reason: "migration recovery regression",
        }),
      ),
    );
  }
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage,
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const initialized = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!initialized.turn) throw new Error("Expected an initialized session turn");
  return { grant, session, turn: initialized.turn };
}

async function applyMigration() {
  await shared.admin.begin(async (tx) => {
    await tx.unsafe(migration);
  });
}

async function readWake(sessionId: string) {
  const row = await readWakeOrNull(sessionId);
  if (!row) throw new Error(`Workflow wake missing for session ${sessionId}`);
  return row;
}

async function readWakeOrNull(sessionId: string) {
  const [row] = await shared.admin<
    Array<{
      wakeRevision: string;
      deliveredRevision: string;
      reason: string;
      nextAttemptAt: Date;
      attempts: number;
      lastError: string | null;
    }>
  >`
    select
      wake_revision as "wakeRevision",
      delivered_revision as "deliveredRevision",
      reason,
      next_attempt_at as "nextAttemptAt",
      attempts,
      last_error as "lastError"
    from session_workflow_wake_outbox
    where session_id = ${sessionId}`;
  return row ?? null;
}

async function readRecoveryPredicate(sessionId: string) {
  const [row] = await shared.admin<
    Array<{
      sessionStatus: string;
      activeTurnId: string | null;
      turnStatus: string | null;
      activeAttemptId: string | null;
    }>
  >`
    select
      session_row.status as "sessionStatus",
      session_row.active_turn_id as "activeTurnId",
      turn_row.status as "turnStatus",
      turn_row.active_attempt_id as "activeAttemptId"
    from sessions session_row
    left join session_turns turn_row
      on turn_row.workspace_id = session_row.workspace_id
     and turn_row.session_id = session_row.id
     and turn_row.id = session_row.active_turn_id
    where session_row.id = ${sessionId}`;
  if (!row) throw new Error(`Session missing: ${sessionId}`);
  return row;
}

type InitializedSession = Awaited<ReturnType<typeof createInitializedSession>>;

async function markWakeDelivered(sessionId: string) {
  await shared.admin`
    update session_workflow_wake_outbox
    set delivered_revision = wake_revision,
        next_attempt_at = now() - interval '1 hour',
        attempts = 1,
        last_error = 'initial wake was already delivered'
    where session_id = ${sessionId}`;
}

async function finishInitialTurn(fixture: InitializedSession) {
  await shared.admin`
    update session_turns
    set status = 'completed',
        active_attempt_id = null,
        started_at = coalesce(started_at, now()),
        finished_at = now()
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.turn.id}`;
  await shared.admin`
    update sessions
    set status = 'idle',
        active_turn_id = null
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.session.id}`;
}

async function configureApprovalWait(fixture: InitializedSession, withResponse: boolean) {
  await shared.admin`
    update session_turns
    set status = 'requires_action',
        active_attempt_id = null
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.turn.id}`;
  await shared.admin`
    update sessions
    set status = 'requires_action',
        active_turn_id = ${fixture.turn.id}
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.session.id}`;
  if (!withResponse) return;
  const [event] = await shared.admin<Array<{ sequence: number }>>`
    insert into session_events (
      account_id,
      workspace_id,
      session_id,
      turn_id,
      turn_generation,
      sequence,
      type,
      payload
    )
    select
      ${fixture.grant.accountId},
      ${fixture.grant.workspaceId!},
      ${fixture.session.id},
      ${fixture.turn.id},
      turn_row.execution_generation,
      session_row.last_sequence + 1,
      'user.approvalDecision',
      jsonb_build_object('approvalId', 'migration-0238-test', 'decision', 'approve')
    from sessions session_row
    join session_turns turn_row
      on turn_row.workspace_id = session_row.workspace_id
     and turn_row.session_id = session_row.id
     and turn_row.id = ${fixture.turn.id}
    where session_row.workspace_id = ${fixture.grant.workspaceId!}
      and session_row.id = ${fixture.session.id}
    returning sequence`;
  if (!event) throw new Error("Approval response event was not inserted");
  await shared.admin`
    update sessions
    set last_sequence = ${event.sequence}
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.session.id}`;
}

async function configureCapacityWait(fixture: InitializedSession, withWaiter: boolean) {
  await shared.admin`
    update session_turns
    set status = 'waiting_capacity',
        active_attempt_id = null,
        execution_generation = greatest(execution_generation, 1)
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.turn.id}`;
  await shared.admin`
    update sessions
    set status = 'waiting_capacity',
        active_turn_id = ${fixture.turn.id}
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.session.id}`;
  if (!withWaiter) return;
  await shared.admin`
    insert into codex_capacity_waiters (
      account_id,
      workspace_id,
      session_id,
      blocked_turn_id,
      blocked_turn_generation,
      workflow_id,
      next_check_at,
      reset_kind
    )
    select
      ${fixture.grant.accountId},
      ${fixture.grant.workspaceId!},
      ${fixture.session.id},
      ${fixture.turn.id},
      turn_row.execution_generation,
      session_row.temporal_workflow_id,
      now() + interval '1 hour',
      'authoritative'
    from sessions session_row
    join session_turns turn_row
      on turn_row.workspace_id = session_row.workspace_id
     and turn_row.session_id = session_row.id
     and turn_row.id = ${fixture.turn.id}
    where session_row.workspace_id = ${fixture.grant.workspaceId!}
      and session_row.id = ${fixture.session.id}`;
}

async function configurePendingSystemUpdate(fixture: InitializedSession) {
  const operationId = crypto.randomUUID();
  await finishInitialTurn(fixture);
  await shared.admin`
    insert into session_system_updates (
      account_id,
      workspace_id,
      session_id,
      kind,
      classification,
      source_id,
      dedupe_key,
      summary,
      payload,
      lineage
    ) values (
      ${fixture.grant.accountId},
      ${fixture.grant.workspaceId!},
      ${fixture.session.id},
      'agent_message',
      'info',
      ${`migration-0238:${operationId}`},
      ${`migration-0238:${operationId}`},
      'durable update awaiting claim',
      jsonb_build_object(
        'type', 'agent_message',
        'text', 'durable update awaiting claim',
        'operationId', (${operationId})::text
      ),
      '{}'::jsonb
    )`;
  await shared.admin`
    update sessions
    set status = 'queued'
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.session.id}`;
}

async function pauseSession(fixture: InitializedSession) {
  await withWorkspaceSessionActivityRls(client.db, fixture.grant.workspaceId!, (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: fixture.grant.accountId,
      workspaceId: fixture.grant.workspaceId!,
      sessionId: fixture.session.id,
      actor: { type: "human", subjectId: fixture.grant.subjectId },
      operationKey: `migration-0238-pause:${crypto.randomUUID()}`,
      action: "pause",
      reason: "migration recovery regression",
    }),
  );
}

async function pauseWorkspace(fixture: InitializedSession) {
  await withWorkspaceRls(client.db, fixture.grant.workspaceId!, (db) =>
    db.transaction((tx) =>
      mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
        accountId: fixture.grant.accountId,
        workspaceId: fixture.grant.workspaceId!,
        actor: { type: "human", subjectId: fixture.grant.subjectId },
        operationKey: `migration-0238-workspace-pause:${crypto.randomUUID()}`,
        action: "pause",
        reason: "migration recovery regression",
      }),
    ),
  );
}

async function recordContextCompactionFailure(fixture: InitializedSession) {
  const [event] = await shared.admin<Array<{ sequence: number }>>`
    insert into session_events (
      account_id,
      workspace_id,
      session_id,
      turn_id,
      turn_generation,
      sequence,
      type,
      payload
    )
    select
      ${fixture.grant.accountId},
      ${fixture.grant.workspaceId!},
      ${fixture.session.id},
      ${fixture.turn.id},
      turn_row.execution_generation,
      session_row.last_sequence + 1,
      'turn.failed',
      jsonb_build_object('code', 'context_compaction_failed')
    from sessions session_row
    join session_turns turn_row
      on turn_row.workspace_id = session_row.workspace_id
     and turn_row.session_id = session_row.id
     and turn_row.id = ${fixture.turn.id}
    where session_row.workspace_id = ${fixture.grant.workspaceId!}
      and session_row.id = ${fixture.session.id}
    returning sequence`;
  if (!event) throw new Error("Context compaction failure event was not inserted");
  await shared.admin`
    update sessions
    set last_sequence = ${event.sequence}
    where workspace_id = ${fixture.grant.workspaceId!}
      and id = ${fixture.session.id}`;
}

async function expectWakeSeeded(
  fixture: InitializedSession,
  before: Awaited<ReturnType<typeof readWake>>,
) {
  const after = await readWake(fixture.session.id);
  expect(after).toMatchObject({
    wakeRevision: String(Number(before.wakeRevision) + 1),
    deliveredRevision: before.wakeRevision,
    reason: "unclaimed_attempt_recovery_cutover",
    attempts: 0,
    lastError: null,
  });
  expect(after.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 58_000);
}

describe("migration 0238 unclaimed session recovery", () => {
  test("seeds exact recovering and delivered-wake queued orphans without touching healthy queued work", async () => {
    const orphaned = await createInitializedSession("recover this orphaned turn");
    const queuedOrphan = await createInitializedSession("recover this delivered queued turn");
    const healthy = await createInitializedSession("leave this pending queued turn alone");
    const paused = await createInitializedSession("leave this paused queued turn alone", {
      pausedWorkspace: true,
    });
    const pendingAt = new Date(Date.now() - 5_000);

    await shared.admin`
      update sessions
      set status = 'recovering', active_turn_id = ${orphaned.turn.id}
      where workspace_id = ${orphaned.grant.workspaceId!}
        and id = ${orphaned.session.id}`;
    await shared.admin`
      update session_turns
      set status = 'recovering', active_attempt_id = null
      where workspace_id = ${orphaned.grant.workspaceId!}
        and id = ${orphaned.turn.id}`;
    await shared.admin`
      update session_workflow_wake_outbox
      set next_attempt_at = ${pendingAt}, attempts = 4, last_error = 'transient delivery error'
      where session_id = ${orphaned.session.id}`;
    await shared.admin`
      update session_workflow_wake_outbox
      set delivered_revision = wake_revision,
          next_attempt_at = now() - interval '1 hour',
          attempts = 2,
          last_error = 'initial wake was already delivered'
      where session_id = ${queuedOrphan.session.id}`;

    expect(await readRecoveryPredicate(orphaned.session.id)).toEqual({
      sessionStatus: "recovering",
      activeTurnId: orphaned.turn.id,
      turnStatus: "recovering",
      activeAttemptId: null,
    });

    const orphanedBefore = await readWake(orphaned.session.id);
    const queuedOrphanBefore = await readWake(queuedOrphan.session.id);
    const healthyBefore = await readWake(healthy.session.id);
    const pausedBefore = await readWakeOrNull(paused.session.id);
    await applyMigration();
    const orphanedAfter = await readWake(orphaned.session.id);
    const queuedOrphanAfter = await readWake(queuedOrphan.session.id);
    const healthyAfter = await readWake(healthy.session.id);
    const pausedAfter = await readWakeOrNull(paused.session.id);

    expect(orphanedAfter).toMatchObject({
      wakeRevision: String(Number(orphanedBefore.wakeRevision) + 1),
      deliveredRevision: orphanedBefore.deliveredRevision,
      reason: "unclaimed_attempt_recovery_cutover",
      attempts: 0,
      lastError: null,
    });
    expect(orphanedAfter.nextAttemptAt.getTime()).toBe(pendingAt.getTime());
    expect(queuedOrphanAfter).toMatchObject({
      wakeRevision: String(Number(queuedOrphanBefore.wakeRevision) + 1),
      deliveredRevision: queuedOrphanBefore.wakeRevision,
      reason: "unclaimed_attempt_recovery_cutover",
      attempts: 0,
      lastError: null,
    });
    expect(queuedOrphanAfter.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 58_000);
    expect(healthyAfter).toEqual(healthyBefore);
    expect(pausedBefore).toBeNull();
    expect(pausedAfter).toBeNull();

    const audits = await shared.admin<Array<{ targetId: string; wakeRevision: number }>>`
      select
        target_id as "targetId",
        (metadata ->> 'wakeRevision')::integer as "wakeRevision"
      from audit_events
      where action = 'session.workflow.unclaimed_attempt_wake_seeded'
        and target_id in (${orphaned.session.id}, ${queuedOrphan.session.id})
      order by target_id`;
    expect(audits).toEqual(
      [
        { targetId: orphaned.session.id, wakeRevision: Number(orphanedAfter.wakeRevision) },
        {
          targetId: queuedOrphan.session.id,
          wakeRevision: Number(queuedOrphanAfter.wakeRevision),
        },
      ].toSorted((left, right) => left.targetId.localeCompare(right.targetId)),
    );
  });

  test("creates a delayed pending revision when the previous wake was delivered", async () => {
    const orphaned = await createInitializedSession("recover after delivered wake");
    await shared.admin`
      update sessions
      set status = 'recovering', active_turn_id = ${orphaned.turn.id}
      where workspace_id = ${orphaned.grant.workspaceId!}
        and id = ${orphaned.session.id}`;
    await shared.admin`
      update session_turns
      set status = 'recovering', active_attempt_id = null
      where workspace_id = ${orphaned.grant.workspaceId!}
        and id = ${orphaned.turn.id}`;
    await shared.admin`
      update session_workflow_wake_outbox
      set delivered_revision = wake_revision,
          next_attempt_at = now() - interval '1 hour',
          attempts = 3,
          last_error = 'already delivered'
      where session_id = ${orphaned.session.id}`;

    expect(await readRecoveryPredicate(orphaned.session.id)).toEqual({
      sessionStatus: "recovering",
      activeTurnId: orphaned.turn.id,
      turnStatus: "recovering",
      activeAttemptId: null,
    });

    const before = await readWake(orphaned.session.id);
    const startedAt = Date.now();
    await applyMigration();
    const finishedAt = Date.now();
    const after = await readWake(orphaned.session.id);

    expect(after).toMatchObject({
      wakeRevision: String(Number(before.wakeRevision) + 1),
      deliveredRevision: before.wakeRevision,
      reason: "unclaimed_attempt_recovery_cutover",
      attempts: 0,
      lastError: null,
    });
    expect(after.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(startedAt + 59_000);
    expect(after.nextAttemptAt.getTime()).toBeLessThanOrEqual(finishedAt + 61_000);
  });

  test("repairs every durable work shape admitted before an attempt is created", async () => {
    const approval = await createInitializedSession("resume this accepted approval");
    const releasedCapacity = await createInitializedSession("resume this released capacity wait");
    const compaction = await createInitializedSession("run this requested compaction");
    const systemUpdate = await createInitializedSession("deliver this pending internal update");

    await configureApprovalWait(approval, true);
    await configureCapacityWait(releasedCapacity, false);
    await finishInitialTurn(compaction);
    await shared.admin`
      update sessions
      set compact_requested = true
      where workspace_id = ${compaction.grant.workspaceId!}
        and id = ${compaction.session.id}`;
    await configurePendingSystemUpdate(systemUpdate);
    for (const fixture of [approval, releasedCapacity, compaction, systemUpdate]) {
      await markWakeDelivered(fixture.session.id);
    }

    const before = await Promise.all(
      [approval, releasedCapacity, compaction, systemUpdate].map((fixture) =>
        readWake(fixture.session.id),
      ),
    );
    await applyMigration();

    await expectWakeSeeded(approval, before[0]!);
    await expectWakeSeeded(releasedCapacity, before[1]!);
    await expectWakeSeeded(compaction, before[2]!);
    await expectWakeSeeded(systemUpdate, before[3]!);
  });

  test("leaves held, paused, and already-pending work unchanged", async () => {
    const approvalWait = await createInitializedSession("wait for an approval response");
    const capacityWait = await createInitializedSession("wait for provider capacity");
    const paused = await createInitializedSession("leave this directly paused turn alone");
    const workspacePaused = await createInitializedSession("leave this paused workspace alone");
    const compactionHold = await createInitializedSession("hold after compaction failure");
    const healthy = await createInitializedSession("leave this pending wake alone");

    await configureApprovalWait(approvalWait, false);
    await configureCapacityWait(capacityWait, true);
    await pauseSession(paused);
    await pauseWorkspace(workspacePaused);
    await configurePendingSystemUpdate(compactionHold);
    await recordContextCompactionFailure(compactionHold);
    for (const fixture of [approvalWait, capacityWait, paused, workspacePaused, compactionHold]) {
      await markWakeDelivered(fixture.session.id);
    }

    const fixtures = [approvalWait, capacityWait, paused, workspacePaused, compactionHold, healthy];
    const before = await Promise.all(fixtures.map((fixture) => readWake(fixture.session.id)));
    await applyMigration();
    const after = await Promise.all(fixtures.map((fixture) => readWake(fixture.session.id)));

    expect(after).toEqual(before);
  });
});
