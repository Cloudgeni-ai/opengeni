import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sendAgentSessionMessage, steerAgentSession } from "@opengeni/core";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  addSessionSystemUpdate,
  AgentCommandAuthorityError,
  appendSessionEventToSandboxGroup,
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  appendSessionEventsForTurnAttempt,
  appendSessionEventsWithLockedSessionUpdate,
  armCodexCapacityWait,
  applySessionTurnSettlement,
  canonicalSessionCommandHash,
  createDb,
  ensureCodexRotationSettings,
  getOrCreateSessionSystemUpdateOutbox,
  markSessionAttemptQuiesced,
  mutateSessionControlInTransaction,
  QueueCommandConflictError,
  reconcileCodexCapacityWait,
  recoverSessionDispatch,
  sendAgentMessageInTransaction,
  SessionCommandIdempotencyError,
  SessionControlInvariantError,
  SessionEventPersistenceError,
  settleSessionIdleWithParentOutbox,
  updateSessionGoal,
  updateSessionTitle,
  withWorkspaceRls,
  type Database,
  type DbClient,
} from "../src/index";

const BARRIER_CLASS = 630_063;

type WorkspaceFixture = {
  accountId: string;
  workspaceId: string;
};

type RunningFixture = WorkspaceFixture & {
  sessionId: string;
  sandboxGroupId: string;
  turnId: string;
  attemptId: string;
  triggerEventId: string;
};

type GenericWriter = {
  name: string;
  eventType: string;
  write: (fixture: RunningFixture) => Promise<unknown>;
};

let shared: SharedTestDatabase;
let admin: postgres.Sql;
let monitor: postgres.Sql;
let barrier: postgres.Sql;
let appClient: DbClient;
let db: Database;
let nextBarrierId = 1;
let nextSessionPairId = 1;

async function freshWorkspace(): Promise<WorkspaceFixture> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name)
    values ('event-ordering invariant event lock account')
    returning id
  `;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'event-ordering invariant event lock workspace')
    returning id
  `;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})
  `;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function seedRunningSession(
  workspace?: WorkspaceFixture,
  options: { sessionId?: string; parentSessionId?: string | null } = {},
): Promise<RunningFixture> {
  const owner = workspace ?? (await freshWorkspace());
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const sandboxGroupId = sessionId;
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const triggerEventId = crypto.randomUUID();
  const workflowId = `session-${sessionId}`;
  const metadata = {
    dispatchGeneration: 1,
    dispatchAttempt: {
      id: `activity-${attemptId}`,
      generation: 1,
      triggerEventId,
    },
  };
  await admin`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id, status, temporal_workflow_id,
      parent_session_id
    ) values (
      ${sessionId}, ${owner.accountId}, ${owner.workspaceId}, 'event-ordering invariant race',
      'codex/gpt-5.6-sol', 'modal', ${sandboxGroupId}, 'running', ${workflowId},
      ${options.parentSessionId ?? null}
    )
  `;
  await admin.begin(async (tx) => {
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, resources, tools, metadata,
        execution_generation, active_attempt_id
      ) values (
        ${turnId}, ${owner.accountId}, ${owner.workspaceId}, ${sessionId}, ${triggerEventId},
        ${workflowId}, 'running', 1, 'event-ordering invariant race', 'codex/gpt-5.6-sol',
        'xhigh', 'modal', '[]'::jsonb, '[]'::jsonb, ${JSON.stringify(metadata)}::jsonb,
        1, ${attemptId}
      )
    `;
    await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id,
        execution_generation, state, temporal_workflow_id,
        temporal_workflow_run_id, temporal_activity_id, verified_control_revision
      ) values (
        ${attemptId}, ${owner.accountId}, ${owner.workspaceId}, ${sessionId}, ${turnId},
        1, 'running', ${workflowId}, ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0
      )
    `;
    await tx`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;
  });
  return {
    ...owner,
    sessionId,
    sandboxGroupId,
    turnId,
    attemptId,
    triggerEventId,
  };
}

async function seedIdleChild(
  workspace: WorkspaceFixture,
  sessionId: string,
  parentSessionId: string,
): Promise<Pick<RunningFixture, "accountId" | "workspaceId" | "sessionId">> {
  await admin`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id, status, temporal_workflow_id,
      parent_session_id
    ) values (
      ${sessionId}, ${workspace.accountId}, ${workspace.workspaceId}, 'event-ordering invariant idle child',
      'codex/gpt-5.6-sol', 'modal', ${sessionId}, 'running', ${`session-${sessionId}`},
      ${parentSessionId}
    )
  `;
  return { ...workspace, sessionId };
}

function orderedParentChildIds(order: "parent-first" | "child-first"): {
  parentSessionId: string;
  childSessionId: string;
} {
  const suffix = (nextSessionPairId++).toString(16).padStart(12, "0");
  const low = `00000000-0000-4000-8000-${suffix}`;
  const high = `ffffffff-ffff-4fff-bfff-${suffix}`;
  return order === "parent-first"
    ? { parentSessionId: low, childSessionId: high }
    : { parentSessionId: high, childSessionId: low };
}

async function seedSandboxGroupMember(
  fixture: Pick<RunningFixture, "accountId" | "workspaceId" | "sandboxGroupId">,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  await admin`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id, status, temporal_workflow_id
    ) values (
      ${sessionId}, ${fixture.accountId}, ${fixture.workspaceId}, 'event-ordering invariant group join',
      'codex/gpt-5.6-sol', 'modal', ${fixture.sandboxGroupId}, 'idle',
      ${`session-${sessionId}`}
    )
  `;
  return sessionId;
}

async function seedGoal(fixture: RunningFixture): Promise<string> {
  const [goal] = await admin<{ id: string }[]>`
    insert into session_goals (
      account_id, workspace_id, session_id, status, text,
      success_criteria, version, max_auto_continuations
    ) values (
      ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.sessionId}, 'active',
      'Initial event-ordering invariant goal', 'Persist every event exactly once', 1, 20
    )
    returning id
  `;
  return goal!.id;
}

async function seedRecording(fixture: RunningFixture): Promise<string> {
  const recordingId = crypto.randomUUID();
  await admin`
    insert into session_recordings (
      id, account_id, workspace_id, session_id, turn_id,
      state, mode, codec, width, height
    ) values (
      ${recordingId}, ${fixture.accountId}, ${fixture.workspaceId},
      ${fixture.sessionId}, ${fixture.turnId},
      'recording', 'on-turn', 'h264-mp4', 1280, 800
    )
  `;
  return recordingId;
}

async function seedPendingInterruption(fixture: RunningFixture): Promise<void> {
  const [receipt] = await admin<{ id: string }[]>`
    insert into session_command_receipts (
      account_id, workspace_id, actor_type, actor_subject_id, action,
      target_session_id, target_turn_id, operation_key, canonical_request_hash
    ) values (
      ${fixture.accountId}, ${fixture.workspaceId}, 'human', 'event-order-race',
      'session.queue.steer', ${fixture.sessionId}, ${fixture.turnId},
      ${crypto.randomUUID()}, 'event-order-quiescence-race'
    )
    returning id
  `;
  await admin`
    insert into session_attempt_interruptions (
      account_id, workspace_id, session_id, operation_id, attempt_id,
      kind, control_revision
    ) values (
      ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.sessionId}, ${receipt!.id},
      ${fixture.attemptId}, 'steer', 1
    )
  `;
}

async function quiescenceWriter(fixture: RunningFixture): Promise<unknown> {
  return await markSessionAttemptQuiesced(db, {
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    attemptId: fixture.attemptId,
    temporalWorkflowId: `session-${fixture.sessionId}`,
  });
}

async function activityWriter(
  fixture: RunningFixture,
  type: "agent.message.delta" | "agent.model.usage",
): Promise<unknown> {
  const payload =
    type === "agent.model.usage"
      ? { sourceKey: `response-${crypto.randomUUID()}`, totalTokens: 42 }
      : { text: "durable delta" };
  return await appendSessionEventsForTurnAttempt(
    db,
    fixture.workspaceId,
    fixture.sessionId,
    fixture.turnId,
    1,
    fixture.attemptId,
    [{ type, payload }],
  );
}

async function pauseSession(fixture: RunningFixture): Promise<unknown> {
  return await withWorkspaceRls(
    db,
    fixture.workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(
        async (tx) =>
          await mutateSessionControlInTransaction(tx as unknown as Database, {
            accountId: fixture.accountId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            actor: { type: "human", subjectId: "eventorder-capacity-pause-race" },
            operationKey: crypto.randomUUID(),
            action: "pause",
            reason: "event-ordering invariant capacity control barrier",
          }),
      ),
  );
}

async function armCapacityWait(fixture: RunningFixture, goalId: string) {
  await ensureCodexRotationSettings(db, fixture.accountId, fixture.workspaceId);
  return await armCodexCapacityWait(db, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    turnId: fixture.turnId,
    attemptId: fixture.attemptId,
    workflowId: `session-${fixture.sessionId}`,
    goalId,
    goalVersion: 1,
    earliestResetAt: null,
    resetKind: "bounded_refresh",
    failurePayload: {
      error: "all connected Codex subscriptions are unavailable",
      code: "codex_usage_limit_reached",
    },
  });
}

async function reconcileAvailableCapacity(
  fixture: RunningFixture,
  waiter: { id: string; generation: number },
) {
  return await reconcileCodexCapacityWait(
    db,
    {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      waiterId: waiter.id,
      generation: waiter.generation,
    },
    () => ({ kind: "available", credentialId: crypto.randomUUID() }),
  );
}

async function sendAgentMessage(
  actor: RunningFixture,
  target: Pick<RunningFixture, "sessionId">,
  operationKey: string,
): Promise<unknown> {
  return await withWorkspaceRls(
    db,
    actor.workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(
        async (tx) =>
          await sendAgentMessageInTransaction(tx as unknown as Database, {
            accountId: actor.accountId,
            workspaceId: actor.workspaceId,
            targetSessionId: target.sessionId,
            actor: {
              type: "agent_attempt",
              sessionId: actor.sessionId,
              turnId: actor.turnId,
              attemptId: actor.attemptId,
              executionGeneration: 1,
            },
            operationKey,
            text: `event-ordering invariant pair-lock message ${operationKey}`,
          }),
      ),
  );
}

async function sendPublishedAgentMessage(
  actor: RunningFixture,
  target: Pick<RunningFixture, "sessionId">,
  operationKey: string,
  bus: MemoryEventBus,
  onWake: () => void,
  callerExecutionGeneration = 1,
): Promise<unknown> {
  return await sendAgentSessionMessage(
    {
      db,
      bus,
      workflowClient: {
        wakeSessionWorkflow: async () => {
          onWake();
        },
      },
    },
    {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      callerSessionId: actor.sessionId,
      callerTurnId: actor.turnId,
      callerAttemptId: actor.attemptId,
      callerExecutionGeneration,
    },
    {
      targetSessionId: target.sessionId,
      text: `event-ordering invariant published pair-lock message ${operationKey}`,
      idempotencyKey: operationKey,
    },
  );
}

async function steerPublishedAgentSession(
  actor: RunningFixture,
  target: Pick<RunningFixture, "sessionId">,
  operationKey: string,
  bus: MemoryEventBus,
  onWake: () => void,
): Promise<unknown> {
  return await steerAgentSession(
    {
      db,
      bus,
      workflowClient: {
        wakeSessionWorkflow: async () => {
          onWake();
        },
      },
    },
    {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      callerSessionId: actor.sessionId,
      callerTurnId: actor.turnId,
      callerAttemptId: actor.attemptId,
      callerExecutionGeneration: 1,
    },
    {
      targetSessionId: target.sessionId,
      instruction: `event-ordering invariant published steer ${operationKey}`,
      idempotencyKey: operationKey,
    },
  );
}

type AgentCommandEffectSnapshot = {
  receipts: number;
  updates: number;
  events: number;
  auditEvents: number;
  wakeRevision: number;
  lastSequence: number;
  queueVersion: number;
  status: string;
  activeTurnId: string | null;
};

async function agentCommandEffectSnapshot(
  fixture: RunningFixture,
  targetSessionId: string,
): Promise<AgentCommandEffectSnapshot> {
  const [snapshot] = await admin<AgentCommandEffectSnapshot[]>`
    select
      (select count(*)::int from session_command_receipts
       where workspace_id = ${fixture.workspaceId}
         and actor_attempt_id = ${fixture.attemptId}) as receipts,
      (select count(*)::int from session_system_updates
       where workspace_id = ${fixture.workspaceId}
         and session_id = ${targetSessionId}) as updates,
      (select count(*)::int from session_events
       where workspace_id = ${fixture.workspaceId}
         and session_id = ${targetSessionId}) as events,
      (select count(*)::int from audit_events
       where workspace_id = ${fixture.workspaceId}
         and subject_id = ${`attempt:${fixture.attemptId}`}
         and action in ('session.agent_message', 'session.agent_steer')) as "auditEvents",
      coalesce((select wake_revision::int from session_workflow_wake_outbox
                where workspace_id = ${fixture.workspaceId}
                  and session_id = ${targetSessionId}), 0) as "wakeRevision",
      session.last_sequence as "lastSequence",
      session.queue_version as "queueVersion",
      session.status,
      session.active_turn_id as "activeTurnId"
    from sessions session
    where session.workspace_id = ${fixture.workspaceId}
      and session.id = ${targetSessionId}
  `;
  if (!snapshot) throw new Error(`Missing Agent command target ${targetSessionId}`);
  return snapshot;
}

async function rejectAgentCommandWithoutEffects(input: {
  actor: RunningFixture;
  targetSessionId: string;
  bus: MemoryEventBus;
  wakeCount: () => number;
  invoke: () => Promise<unknown>;
}): Promise<unknown> {
  const before = await agentCommandEffectSnapshot(input.actor, input.targetSessionId);
  const publishedBefore = input.bus.published.length;
  const controlPublishedBefore = input.bus.publishedWorkspaceControl.length;
  const wakesBefore = input.wakeCount();
  const error = await input.invoke().catch((caught) => caught);

  expect(await agentCommandEffectSnapshot(input.actor, input.targetSessionId)).toEqual(before);
  expect(input.bus.published).toHaveLength(publishedBefore);
  expect(input.bus.publishedWorkspaceControl).toHaveLength(controlPublishedBefore);
  expect(input.wakeCount()).toBe(wakesBefore);
  return error;
}

async function waitFor(
  description: string,
  read: () => Promise<number>,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await read()) >= minimum) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForAdvisoryWaiter(): Promise<void> {
  await waitFor(
    "the first writer to reach the advisory barrier",
    async () => {
      const [row] = await monitor<{ count: number }[]>`
        select count(*)::int as count
        from pg_locks lock
        join pg_stat_activity activity on activity.pid = lock.pid
        where activity.datname = current_database()
          and activity.usename = 'opengeni_app'
          and lock.locktype = 'advisory'
          and not lock.granted
      `;
      return row?.count ?? 0;
    },
    1,
  );
}

async function waitForTwoAppLockWaiters(): Promise<void> {
  await waitFor(
    "the second writer to queue behind the same session allocator",
    async () => {
      const [row] = await monitor<{ count: number }[]>`
        select count(*)::int as count
        from pg_stat_activity
        where datname = current_database()
          and usename = 'opengeni_app'
          and wait_event_type = 'Lock'
      `;
      return row?.count ?? 0;
    },
    2,
  );
}

async function within<T>(promise: Promise<T>, description: string, timeoutMs = 10_000): Promise<T> {
  const timeout = Symbol(description);
  const result = await Promise.race([promise, Bun.sleep(timeoutMs).then(() => timeout)]);
  if (result === timeout) throw new Error(`Timed out waiting for ${description}`);
  return result as T;
}

/**
 * The first writer takes the canonical locks and then stops in the insert
 * trigger. The barrier row is deleted before the second writer starts, so only
 * the first writer can wait on the advisory lock; the second must instead wait
 * on the same session allocator row. Releasing the advisory lock proves both
 * transactions finish in a deterministic arrival order without deadlock.
 */
async function raceInOrder(
  firstEventType: string,
  firstWriter: () => Promise<unknown>,
  secondWriter: () => Promise<unknown>,
): Promise<[unknown, unknown]> {
  const lockId = nextBarrierId++;
  await barrier`select pg_advisory_lock(${BARRIER_CLASS}, ${lockId})`;
  await admin`
    insert into eventorder_event_barriers (event_type, lock_class, lock_id)
    values (${firstEventType}, ${BARRIER_CLASS}, ${lockId})
  `;
  let released = false;
  let first: Promise<unknown> | null = null;
  let second: Promise<unknown> | null = null;
  try {
    first = firstWriter();
    await waitForAdvisoryWaiter();
    await admin`delete from eventorder_event_barriers where event_type = ${firstEventType}`;
    second = secondWriter();
    await waitForTwoAppLockWaiters();
    await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`;
    released = true;
    return (await within(Promise.all([first, second]), "both event writers to commit")) as [
      unknown,
      unknown,
    ];
  } finally {
    await admin`delete from eventorder_event_barriers where event_type = ${firstEventType}`.catch(
      () => undefined,
    );
    if (!released) {
      await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`.catch(() => undefined);
    }
    await Promise.allSettled([first, second].filter((value): value is Promise<unknown> => !!value));
  }
}

async function raceLifecycleOutboxAgainstAgentCommand(input: {
  dedupeKey: string;
  lifecycleWriter: () => Promise<unknown>;
  parent: RunningFixture;
  child: Pick<RunningFixture, "sessionId">;
}): Promise<[unknown, unknown]> {
  const barrierKey = `outbox:${input.dedupeKey}`;
  const lockId = nextBarrierId++;
  await barrier`select pg_advisory_lock(${BARRIER_CLASS}, ${lockId})`;
  await admin`
    insert into eventorder_event_barriers (event_type, lock_class, lock_id)
    values (${barrierKey}, ${BARRIER_CLASS}, ${lockId})
  `;
  let released = false;
  let lifecycle: Promise<unknown> | null = null;
  let command: Promise<unknown> | null = null;
  try {
    lifecycle = input.lifecycleWriter();
    await waitForAdvisoryWaiter();
    await admin`delete from eventorder_event_barriers where event_type = ${barrierKey}`;
    command = sendAgentMessage(input.parent, input.child, crypto.randomUUID());
    await waitForTwoAppLockWaiters();
    await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`;
    released = true;
    return await within(
      Promise.all([lifecycle, command]),
      "the lifecycle outbox and parent-to-child command to commit",
    );
  } finally {
    await admin`delete from eventorder_event_barriers where event_type = ${barrierKey}`.catch(
      () => undefined,
    );
    if (!released) {
      await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`.catch(() => undefined);
    }
    await Promise.allSettled(
      [lifecycle, command].filter((value): value is Promise<unknown> => Boolean(value)),
    );
  }
}

async function assertCommittedSequence(
  fixture: Pick<RunningFixture, "sessionId">,
  expectedCount: number,
): Promise<Array<{ sequence: number; type: string; payload: unknown }>> {
  const rows = await admin<Array<{ sequence: number; type: string; payload: unknown }>>`
    select sequence, type, payload
    from session_events
    where session_id = ${fixture.sessionId}
    order by sequence
  `;
  const sequences = rows.map((row) => row.sequence);
  expect(rows).toHaveLength(expectedCount);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(sequences).toEqual(Array.from({ length: expectedCount }, (_, index) => index + 1));
  const [session] = await admin<{ last_sequence: number }[]>`
    select last_sequence from sessions where id = ${fixture.sessionId}
  `;
  expect(session?.last_sequence).toBe(sequences.at(-1) ?? 0);
  return rows;
}

const genericWriters: GenericWriter[] = [
  {
    name: "appendSessionEvents",
    eventType: "session.title_set",
    write: async (fixture) =>
      await appendSessionEvents(db, fixture.workspaceId, fixture.sessionId, [
        { type: "session.title_set", payload: { title: "generic append" } },
      ]),
  },
  {
    name: "appendSessionEventToSandboxGroup",
    eventType: "sandbox.box.snapshot",
    write: async (fixture) =>
      await appendSessionEventToSandboxGroup(db, fixture.workspaceId, fixture.sandboxGroupId, {
        type: "sandbox.box.snapshot",
        payload: { trigger: "event-ordering invariant race" },
      }),
  },
  {
    name: "appendSessionEventsAndUpdateSession",
    eventType: "agent.updated",
    write: async (fixture) =>
      await appendSessionEventsAndUpdateSession(
        db,
        fixture.workspaceId,
        fixture.sessionId,
        [{ type: "agent.updated", payload: { source: "event-ordering invariant race" } }],
        { metadata: { race: "generic-and-update" } },
      ),
  },
  {
    name: "appendSessionEventsWithLockedSessionUpdate",
    eventType: "session.context.compaction.requested",
    write: async (fixture) =>
      await appendSessionEventsWithLockedSessionUpdate(
        db,
        fixture.workspaceId,
        fixture.sessionId,
        async () => ({
          events: [
            {
              type: "session.context.compaction.requested",
              payload: { source: "event-ordering invariant race" },
            },
          ],
          update: { metadata: { race: "locked-update" } },
        }),
      ),
  },
  {
    name: "addSessionSystemUpdate",
    eventType: "system.update.pending",
    write: async (fixture) => {
      const operationId = crypto.randomUUID();
      return await addSessionSystemUpdate(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        kind: "agent_message",
        classification: "info",
        sourceId: "event-order-race",
        dedupeKey: `event-order-${operationId}`,
        summary: "event-ordering invariant internal update race",
        payload: {
          type: "agent_message",
          text: "event-ordering invariant internal update race",
          operationId,
        },
      });
    },
  },
];

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-lock-order");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  admin = shared.admin;
  monitor = postgres(shared.adminUrl, { max: 1 });
  barrier = postgres(shared.adminUrl, { max: 1 });
  appClient = createDb(shared.appUrl, { max: 20 });
  db = appClient.db;

  await admin`
    create table eventorder_event_barriers (
      event_type text primary key,
      lock_class integer not null,
      lock_id integer not null
    )
  `;
  await admin`
    create table eventorder_command_faults (
      action text primary key,
      sql_state text not null,
      always_fault boolean not null default false
    )
  `;
  await admin`create sequence eventorder_fault_attempt_seq`;
  await admin`create sequence eventorder_rollback_candidate_seq`;
  await admin.unsafe(`
    create function eventorder_session_event_test_trigger()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog, public
    as $function$
    declare
      configured record;
      fault_state text;
      always_fault_state text;
      fault_attempt bigint;
    begin
      select lock_class, lock_id
      into configured
      from public.eventorder_event_barriers
      where event_type = new.type;
      if found then
        perform pg_catalog.pg_advisory_xact_lock(configured.lock_class, configured.lock_id);
      end if;

      fault_state := new.payload ->> 'eventorderFaultSqlState';
      if fault_state in ('40P01', '40001') then
        fault_attempt := nextval('public.eventorder_fault_attempt_seq');
        if fault_attempt = 1 then
          raise exception using
            errcode = fault_state,
            message = 'event-ordering invariant injected persistence fault';
        end if;
      end if;

      always_fault_state := new.payload ->> 'eventorderAlwaysFaultSqlState';
      if always_fault_state in ('40P01', '40001') then
        raise exception using
          errcode = always_fault_state,
          message = 'event-ordering invariant injected persistence fault with private-token',
          detail = 'Failed query: insert into session_events values ($1) private-token',
          table = 'session_events';
      end if;

      if new.payload ->> 'eventorderRollbackCandidate' = 'true' then
        perform setval('public.eventorder_rollback_candidate_seq', new.sequence, false);
        raise exception using
          errcode = '23514',
          message = 'event-ordering invariant injected non-retryable rollback';
      end if;
      return new;
    end
    $function$;

    create trigger eventorder_session_event_test_trigger
    before insert on session_events
    for each row execute function eventorder_session_event_test_trigger();

    create function eventorder_command_receipt_test_trigger()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog, public
    as $function$
    declare
      configured record;
      configured_fault record;
      fault_attempt bigint;
    begin
      select lock_class, lock_id
      into configured
      from public.eventorder_event_barriers
      where event_type = 'receipt:' || new.action;
      if found then
        perform pg_catalog.pg_advisory_xact_lock(configured.lock_class, configured.lock_id);
      end if;

      select sql_state, always_fault
      into configured_fault
      from public.eventorder_command_faults
      where action = new.action;
      if found and configured_fault.sql_state in ('40P01', '40001') then
        fault_attempt := nextval('public.eventorder_fault_attempt_seq');
        if configured_fault.always_fault or fault_attempt = 1 then
          raise exception using
            errcode = configured_fault.sql_state,
            message = 'event-ordering invariant injected command persistence fault with private-token',
            detail = 'Failed query: insert into session_command_receipts values ($1) private-token',
            table = 'session_command_receipts';
        end if;
      end if;
      return new;
    end
    $function$;

    create trigger zz_eventorder_command_receipt_test_trigger
    after insert on session_command_receipts
    for each row execute function eventorder_command_receipt_test_trigger();

    create function eventorder_system_update_outbox_test_trigger()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog, public
    as $function$
    declare
      configured record;
    begin
      select lock_class, lock_id
      into configured
      from public.eventorder_event_barriers
      where event_type = 'outbox:' || new.dedupe_key;
      if found then
        perform pg_catalog.pg_advisory_xact_lock(configured.lock_class, configured.lock_id);
      end if;
      return new;
    end
    $function$;

    create trigger eventorder_system_update_outbox_test_trigger
    before insert on session_system_update_outbox
    for each row execute function eventorder_system_update_outbox_test_trigger();
  `);
}, 180_000);

afterAll(async () => {
  await appClient?.close().catch(() => undefined);
  await monitor?.end().catch(() => undefined);
  await barrier?.end().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("event-ordering invariant canonical session-event lock order", () => {
  test("serializes every generic writer with usage and streamed activity in both arrival orders", async () => {
    for (const generic of genericWriters) {
      for (const activityType of ["agent.model.usage", "agent.message.delta"] as const) {
        const genericFirst = await seedRunningSession();
        await raceInOrder(
          generic.eventType,
          async () => await generic.write(genericFirst),
          async () => await activityWriter(genericFirst, activityType),
        );
        await assertCommittedSequence(genericFirst, 2);

        const activityFirst = await seedRunningSession();
        await raceInOrder(
          activityType,
          async () => await activityWriter(activityFirst, activityType),
          async () => await generic.write(activityFirst),
        );
        await assertCommittedSequence(activityFirst, 2);
      }
    }
  }, 180_000);

  test("serializes the quiescence event writer with every generic writer in both arrival orders", async () => {
    for (const generic of genericWriters) {
      const genericFirst = await seedRunningSession();
      await seedPendingInterruption(genericFirst);
      await raceInOrder(
        generic.eventType,
        async () => await generic.write(genericFirst),
        async () => await quiescenceWriter(genericFirst),
      );
      const genericFirstEvents = await assertCommittedSequence(genericFirst, 2);
      expect(genericFirstEvents.map((event) => event.type)).toContain("session.queue.changed");

      const quiescenceFirst = await seedRunningSession();
      await seedPendingInterruption(quiescenceFirst);
      await raceInOrder(
        "session.queue.changed",
        async () => await quiescenceWriter(quiescenceFirst),
        async () => await generic.write(quiescenceFirst),
      );
      const quiescenceFirstEvents = await assertCommittedSequence(quiescenceFirst, 2);
      expect(quiescenceFirstEvents.map((event) => event.type)).toContain("session.queue.changed");
    }
  }, 180_000);

  test("first-turn title and goal mutation events race model usage without duplicate allocation", async () => {
    for (const first of ["generic", "activity"] as const) {
      const titleFixture = await seedRunningSession();
      const titleWriter = async () => {
        expect(
          await updateSessionTitle(db, {
            workspaceId: titleFixture.workspaceId,
            sessionId: titleFixture.sessionId,
            title: "event-ordering invariant first-turn canary",
            source: "agent",
          }),
        ).toMatchObject({ updated: true, title: "event-ordering invariant first-turn canary" });
        return await appendSessionEvents(db, titleFixture.workspaceId, titleFixture.sessionId, [
          {
            type: "session.title_set",
            payload: { title: "event-ordering invariant first-turn canary", source: "agent" },
          },
        ]);
      };
      const usageWriter = async () => await activityWriter(titleFixture, "agent.model.usage");
      await raceInOrder(
        first === "generic" ? "session.title_set" : "agent.model.usage",
        first === "generic" ? titleWriter : usageWriter,
        first === "generic" ? usageWriter : titleWriter,
      );
      const titleRows = await assertCommittedSequence(titleFixture, 2);
      expect(new Set(titleRows.map((row) => row.type))).toEqual(
        new Set(["session.title_set", "agent.model.usage"]),
      );
      const [title] = await admin<{ title: string | null }[]>`
          select title from sessions where id = ${titleFixture.sessionId}
        `;
      expect(title?.title).toBe("event-ordering invariant first-turn canary");

      const goalFixture = await seedRunningSession();
      await seedGoal(goalFixture);
      const goalWriter = async () => {
        const goal = await updateSessionGoal(db, goalFixture.workspaceId, goalFixture.sessionId, {
          text: "Updated event-ordering invariant goal",
        });
        return await appendSessionEvents(db, goalFixture.workspaceId, goalFixture.sessionId, [
          {
            type: "goal.updated",
            payload: { goalId: goal.id, text: goal.text, version: goal.version },
          },
        ]);
      };
      const goalUsageWriter = async () => await activityWriter(goalFixture, "agent.model.usage");
      await raceInOrder(
        first === "generic" ? "goal.updated" : "agent.model.usage",
        first === "generic" ? goalWriter : goalUsageWriter,
        first === "generic" ? goalUsageWriter : goalWriter,
      );
      const goalRows = await assertCommittedSequence(goalFixture, 2);
      expect(new Set(goalRows.map((row) => row.type))).toEqual(
        new Set(["goal.updated", "agent.model.usage"]),
      );
    }
  }, 120_000);

  test("serializes capacity-wait arming with Pause in both arrival orders", async () => {
    for (const first of ["arm", "pause"] as const) {
      const fixture = await seedRunningSession();
      const goalId = await seedGoal(fixture);
      const arm = async () => await armCapacityWait(fixture, goalId);
      const pause = async () => await pauseSession(fixture);

      const [firstResult, secondResult] = await raceInOrder(
        first === "arm" ? "codex.capacity.waiting" : "session.control.paused",
        first === "arm" ? arm : pause,
        first === "arm" ? pause : arm,
      );
      const armResult = (first === "arm" ? firstResult : secondResult) as Awaited<
        ReturnType<typeof armCapacityWait>
      >;
      const pauseResult = (first === "pause" ? firstResult : secondResult) as Awaited<
        ReturnType<typeof pauseSession>
      >;

      if (first === "pause") {
        expect(armResult.action).toBe("stale");
        expect(await assertCommittedSequence(fixture, 1)).toMatchObject([
          { sequence: 1, type: "session.control.paused" },
        ]);
        continue;
      }

      expect(armResult.action).toBe("waiting");
      if (armResult.action !== "waiting") throw new Error("capacity wait did not arm");
      const reconciled = await reconcileAvailableCapacity(fixture, armResult.waiter);
      expect(reconciled.action).toBe("superseded");
      expect((pauseResult as { interruptionCount?: number }).interruptionCount).toBe(0);
      expect(await assertCommittedSequence(fixture, 5)).toMatchObject([
        { sequence: 1, type: "turn.failed" },
        { sequence: 2, type: "codex.capacity.waiting" },
        { sequence: 3, type: "session.status.changed" },
        { sequence: 4, type: "session.control.paused" },
        { sequence: 5, type: "codex.capacity.superseded" },
      ]);
    }
  }, 120_000);

  test("serializes capacity reconciliation with Pause in both arrival orders", async () => {
    for (const first of ["reconcile", "pause"] as const) {
      const fixture = await seedRunningSession();
      const goalId = await seedGoal(fixture);
      const armed = await armCapacityWait(fixture, goalId);
      if (armed.action !== "waiting") throw new Error("capacity wait did not arm");
      const reconcile = async () => await reconcileAvailableCapacity(fixture, armed.waiter);
      const pause = async () => await pauseSession(fixture);

      const [firstResult, secondResult] = await raceInOrder(
        first === "reconcile" ? "codex.capacity.resumed" : "session.control.paused",
        first === "reconcile" ? reconcile : pause,
        first === "reconcile" ? pause : reconcile,
      );
      const reconcileResult = (first === "reconcile" ? firstResult : secondResult) as Awaited<
        ReturnType<typeof reconcileAvailableCapacity>
      >;

      if (first === "pause") {
        expect(reconcileResult.action).toBe("superseded");
        expect(await assertCommittedSequence(fixture, 5)).toMatchObject([
          { sequence: 1, type: "turn.failed" },
          { sequence: 2, type: "codex.capacity.waiting" },
          { sequence: 3, type: "session.status.changed" },
          { sequence: 4, type: "session.control.paused" },
          { sequence: 5, type: "codex.capacity.superseded" },
        ]);
      } else {
        expect(reconcileResult.action).toBe("resumed");
        expect(await assertCommittedSequence(fixture, 6)).toMatchObject([
          { sequence: 1, type: "turn.failed" },
          { sequence: 2, type: "codex.capacity.waiting" },
          { sequence: 3, type: "session.status.changed" },
          { sequence: 4, type: "system.update.pending" },
          { sequence: 5, type: "codex.capacity.resumed" },
          { sequence: 6, type: "session.control.paused" },
        ]);
      }

      const [state] = await admin<
        {
          status: string;
          active_turn_id: string | null;
          pending_updates: number;
        }[]
      >`
        select session.status, session.active_turn_id,
               (select count(*)::int from session_system_updates update_row
                where update_row.workspace_id = session.workspace_id
                  and update_row.session_id = session.id
                  and update_row.state = 'pending') as pending_updates
        from sessions session
        where session.workspace_id = ${fixture.workspaceId}
          and session.id = ${fixture.sessionId}
      `;
      expect(state).toEqual({
        status: first === "reconcile" ? "queued" : "idle",
        active_turn_id: null,
        pending_updates: first === "reconcile" ? 1 : 0,
      });
    }
  }, 120_000);

  test("root goal append and root-to-lower-UUID child command finish in both arrival orders", async () => {
    for (const first of ["goal", "command"] as const) {
      const workspace = await freshWorkspace();
      // Exact 2026-07-19 production fixture: the command supplied root first,
      // even though the child UUID sorts first. Only persistence may retry;
      // publish and workflow wake must remain exactly once.
      const ids = {
        parentSessionId: "aed24825-71d0-465e-8f9b-37f4d51b8eac",
        childSessionId: "74f49e50-467b-43e1-b1f7-bcc895211649",
      };
      expect(ids.childSessionId < ids.parentSessionId).toBe(true);
      const root = await seedRunningSession(workspace, { sessionId: ids.parentSessionId });
      const child = await seedIdleChild(workspace, ids.childSessionId, ids.parentSessionId);
      await seedGoal(root);
      const bus = new MemoryEventBus();
      let goalMutations = 0;
      let wakes = 0;
      const goalWriter = async () => {
        goalMutations += 1;
        const goal = await updateSessionGoal(db, root.workspaceId, root.sessionId, {
          text: "event-ordering invariant live root fixture",
        });
        return await appendAndPublishEvents(db, bus, root.workspaceId, root.sessionId, [
          {
            type: "goal.updated",
            payload: { goalId: goal.id, text: goal.text, version: goal.version },
          },
        ]);
      };
      const commandWriter = async () =>
        await sendPublishedAgentMessage(root, child, crypto.randomUUID(), bus, () => {
          wakes += 1;
        });

      await raceInOrder(
        first === "goal" ? "goal.updated" : "system.update.pending",
        first === "goal" ? goalWriter : commandWriter,
        first === "goal" ? commandWriter : goalWriter,
      );

      expect(goalMutations).toBe(1);
      expect(wakes).toBe(1);
      expect(bus.published).toHaveLength(2);
      expect(await assertCommittedSequence(root, 1)).toMatchObject([
        { sequence: 1, type: "goal.updated" },
      ]);
      expect(await assertCommittedSequence(child, 1)).toMatchObject([
        { sequence: 1, type: "system.update.pending" },
      ]);
      const [updates] = await admin<{ count: number }[]>`
        select count(*)::int as count
        from session_system_updates
        where workspace_id = ${workspace.workspaceId}
          and session_id = ${child.sessionId}
          and kind = 'agent_message'
      `;
      expect(updates?.count).toBe(1);
      // Session IDs are global, so drop this isolated fixture before reseeding
      // the same production UUID pair for the opposite arrival order.
      await admin`delete from managed_accounts where id = ${workspace.accountId}`;
    }
  }, 60_000);

  test("recording settlement and streamed activity retain one monotonic timeline in both orders", async () => {
    for (const first of ["settlement", "activity"] as const) {
      const fixture = await seedRunningSession();
      const recordingId = await seedRecording(fixture);
      const settlement = async () =>
        await applySessionTurnSettlement(db, fixture.workspaceId, {
          sessionId: fixture.sessionId,
          turnId: fixture.turnId,
          triggerEventId: fixture.triggerEventId,
          attemptId: fixture.attemptId,
          turnStatus: "completed",
          sessionStatus: "idle",
          activeTurnId: null,
          recording: {
            action: "available",
            recordingId,
            storageKey: `recordings/${recordingId}.mp4`,
            sizeBytes: 42_000,
            durationSeconds: 3,
          },
          events: [{ type: "turn.completed", payload: { output: "done" } }],
        });
      const activity = async () => await activityWriter(fixture, "agent.message.delta");
      await raceInOrder(
        first === "settlement" ? "recording.available" : "agent.message.delta",
        first === "settlement" ? settlement : activity,
        first === "settlement" ? activity : settlement,
      );
      const rows = await assertCommittedSequence(fixture, 3);
      expect(rows.map((row) => row.type)).toContain("recording.available");
      expect(rows.map((row) => row.type)).toContain("turn.completed");
      expect(rows.map((row) => row.type)).toContain(
        first === "settlement" ? "turn.event.rejected_late" : "agent.message.delta",
      );
      const [recording] = await admin<{ state: string; storage_key: string | null }[]>`
          select state, storage_key from session_recordings where id = ${recordingId}
        `;
      expect(recording).toEqual({
        state: "available",
        storage_key: `recordings/${recordingId}.mp4`,
      });
    }
  }, 60_000);

  test("reuses a rolled-back uncommitted sequence candidate without a committed gap", async () => {
    const fixture = await seedRunningSession();
    await expect(
      appendSessionEvents(db, fixture.workspaceId, fixture.sessionId, [
        {
          type: "goal.updated",
          payload: { eventorderRollbackCandidate: true },
        },
      ]),
    ).rejects.toBeDefined();
    const [attempted] = await admin<{ last_value: string }[]>`
      select last_value::text from eventorder_rollback_candidate_seq
    `;
    expect(Number(attempted?.last_value)).toBe(1);
    expect(await assertCommittedSequence(fixture, 0)).toEqual([]);

    await appendSessionEvents(db, fixture.workspaceId, fixture.sessionId, [
      { type: "goal.updated", payload: { committed: true } },
    ]);
    const rows = await assertCommittedSequence(fixture, 1);
    expect(rows[0]).toMatchObject({ sequence: 1, type: "goal.updated" });
  });

  test("fanout advances only the group members in its locked snapshot", async () => {
    const fixture = await seedRunningSession();
    const lockId = nextBarrierId++;
    await barrier`select pg_advisory_lock(${BARRIER_CLASS}, ${lockId})`;
    await admin`
      insert into eventorder_event_barriers (event_type, lock_class, lock_id)
      values ('sandbox.box.snapshot', ${BARRIER_CLASS}, ${lockId})
    `;
    let released = false;
    let fanout: Promise<unknown> | null = null;
    let joinedSessionId: string | null = null;
    try {
      fanout = appendSessionEventToSandboxGroup(db, fixture.workspaceId, fixture.sandboxGroupId, {
        type: "sandbox.box.snapshot",
        payload: { phase: "membership-snapshot" },
      });
      await waitForAdvisoryWaiter();
      joinedSessionId = await within(
        seedSandboxGroupMember(fixture),
        "a new sandbox-group member to commit while fanout is blocked",
        2_000,
      );
      await admin`delete from eventorder_event_barriers where event_type = 'sandbox.box.snapshot'`;
      await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`;
      released = true;
      await within(fanout, "the membership-snapshot fanout to commit");
    } finally {
      await admin`delete from eventorder_event_barriers where event_type = 'sandbox.box.snapshot'`.catch(
        () => undefined,
      );
      if (!released) {
        await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`.catch(
          () => undefined,
        );
      }
      await fanout?.catch(() => undefined);
    }

    expect(joinedSessionId).not.toBeNull();
    expect(await assertCommittedSequence(fixture, 1)).toMatchObject([
      { sequence: 1, type: "sandbox.box.snapshot" },
    ]);
    expect(await assertCommittedSequence({ sessionId: joinedSessionId! }, 0)).toEqual([]);

    const second = await appendSessionEventToSandboxGroup(
      db,
      fixture.workspaceId,
      fixture.sandboxGroupId,
      {
        type: "sandbox.box.snapshot",
        payload: { phase: "joined-member-visible" },
      },
    );
    expect(second).toHaveLength(2);
    expect(await assertCommittedSequence(fixture, 2)).toMatchObject([
      { sequence: 1, type: "sandbox.box.snapshot" },
      { sequence: 2, type: "sandbox.box.snapshot" },
    ]);
    expect(await assertCommittedSequence({ sessionId: joinedSessionId! }, 1)).toMatchObject([
      { sequence: 1, type: "sandbox.box.snapshot" },
    ]);
  }, 60_000);

  test("does not serialize unrelated sessions in the same workspace", async () => {
    const workspace = await freshWorkspace();
    const first = await seedRunningSession(workspace);
    const second = await seedRunningSession(workspace);
    const lockId = nextBarrierId++;
    await barrier`select pg_advisory_lock(${BARRIER_CLASS}, ${lockId})`;
    await admin`
      insert into eventorder_event_barriers (event_type, lock_class, lock_id)
      values ('session.title_set', ${BARRIER_CLASS}, ${lockId})
    `;
    let released = false;
    const held = appendSessionEvents(db, first.workspaceId, first.sessionId, [
      { type: "session.title_set", payload: { title: "blocked session" } },
    ]);
    try {
      await waitForAdvisoryWaiter();
      await within(
        appendSessionEvents(db, second.workspaceId, second.sessionId, [
          { type: "goal.updated", payload: { independent: true } },
        ]),
        "the unrelated session append to commit",
        2_000,
      );
      expect(await assertCommittedSequence(second, 1)).toMatchObject([
        { sequence: 1, type: "goal.updated" },
      ]);
    } finally {
      await admin`delete from eventorder_event_barriers where event_type = 'session.title_set'`;
      if (!released) {
        await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`;
        released = true;
      }
      await held;
    }
    await assertCommittedSequence(first, 1);
  });

  test("locks actor and target rows before command receipt foreign keys can form an upgrade cycle", async () => {
    const workspace = await freshWorkspace();
    const actor = await seedRunningSession(workspace);
    const firstTarget = await seedRunningSession(workspace);
    const secondTarget = await seedRunningSession(workspace);
    const lockId = nextBarrierId++;
    await barrier`select pg_advisory_lock(${BARRIER_CLASS}, ${lockId})`;
    await admin`
      insert into eventorder_event_barriers (event_type, lock_class, lock_id)
      values ('receipt:agent.message', ${BARRIER_CLASS}, ${lockId})
    `;
    let released = false;
    let first: Promise<unknown> | null = null;
    let second: Promise<unknown> | null = null;
    try {
      first = sendAgentMessage(actor, firstTarget, crypto.randomUUID());
      await waitForAdvisoryWaiter();
      await admin`delete from eventorder_event_barriers where event_type = 'receipt:agent.message'`;
      second = sendAgentMessage(actor, secondTarget, crypto.randomUUID());
      await waitForTwoAppLockWaiters();
      await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`;
      released = true;
      await within(Promise.all([first, second]), "both pair-locked Agent messages to commit");
    } finally {
      await admin`delete from eventorder_event_barriers where event_type = 'receipt:agent.message'`.catch(
        () => undefined,
      );
      if (!released) {
        await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`.catch(
          () => undefined,
        );
      }
      await Promise.allSettled(
        [first, second].filter((value): value is Promise<unknown> => Boolean(value)),
      );
    }
    expect(await assertCommittedSequence(firstTarget, 1)).toMatchObject([
      { sequence: 1, type: "system.update.pending" },
    ]);
    expect(await assertCommittedSequence(secondTarget, 1)).toMatchObject([
      { sequence: 1, type: "system.update.pending" },
    ]);
  }, 60_000);

  test("retries only Agent command persistence and publishes or wakes exactly once", async () => {
    for (const sqlState of ["40P01", "40001"] as const) {
      const workspace = await freshWorkspace();
      const ids = orderedParentChildIds("child-first");
      const actor = await seedRunningSession(workspace, { sessionId: ids.parentSessionId });
      const target = await seedIdleChild(workspace, ids.childSessionId, ids.parentSessionId);
      const operationKey = crypto.randomUUID();
      const bus = new MemoryEventBus();
      let inferenceCalls = 0;
      let toolEffects = 0;
      let wakes = 0;
      inferenceCalls += 1;
      toolEffects += 1;
      await admin`select setval('eventorder_fault_attempt_seq', 1, false)`;
      await admin`
        insert into eventorder_command_faults (action, sql_state)
        values ('agent.message', ${sqlState})
      `;
      let delivered: unknown;
      try {
        delivered = await sendPublishedAgentMessage(actor, target, operationKey, bus, () => {
          wakes += 1;
        });
      } finally {
        await admin`delete from eventorder_command_faults where action = 'agent.message'`;
      }

      expect(delivered).toMatchObject({ replay: false });
      expect(inferenceCalls).toBe(1);
      expect(toolEffects).toBe(1);
      expect(wakes).toBe(1);
      expect(bus.published).toHaveLength(1);
      expect(bus.published[0]).toMatchObject([{ type: "system.update.pending", sequence: 1 }]);
      const [attempts] = await admin<{ last_value: string }[]>`
        select last_value::text from eventorder_fault_attempt_seq
      `;
      expect(Number(attempts?.last_value)).toBe(2);
      const [persisted] = await admin<Array<{ receipts: number; updates: number; events: number }>>`
        select
          (select count(*)::int from session_command_receipts
           where workspace_id = ${workspace.workspaceId}
             and action = 'agent.message'
             and operation_key = ${operationKey}) as receipts,
          (select count(*)::int from session_system_updates
           where workspace_id = ${workspace.workspaceId}
             and session_id = ${target.sessionId}
             and kind = 'agent_message') as updates,
          (select count(*)::int from session_events
           where workspace_id = ${workspace.workspaceId}
             and session_id = ${target.sessionId}
             and type = 'system.update.pending') as events
      `;
      expect(persisted).toEqual({ receipts: 1, updates: 1, events: 1 });
      await assertCommittedSequence(target, 1);
    }
  }, 60_000);

  test("preserves Agent command domain conflicts without persistence or external effects", async () => {
    {
      const workspace = await freshWorkspace();
      const actor = await seedRunningSession(workspace);
      const target = await seedIdleChild(workspace, crypto.randomUUID(), actor.sessionId);
      const bus = new MemoryEventBus();
      let wakes = 0;
      const error = await rejectAgentCommandWithoutEffects({
        actor,
        targetSessionId: target.sessionId,
        bus,
        wakeCount: () => wakes,
        invoke: async () =>
          await sendPublishedAgentMessage(
            actor,
            target,
            crypto.randomUUID(),
            bus,
            () => {
              wakes += 1;
            },
            2,
          ),
      });
      expect(error).toBeInstanceOf(AgentCommandAuthorityError);
      expect(error).toMatchObject({ code: "CALLER_STALE" });
    }

    {
      const workspace = await freshWorkspace();
      const actor = await seedRunningSession(workspace);
      const target = await seedIdleChild(workspace, crypto.randomUUID(), actor.sessionId);
      await withWorkspaceRls(
        db,
        workspace.workspaceId,
        async (scopedDb) =>
          await scopedDb.transaction(
            async (tx) =>
              await mutateSessionControlInTransaction(tx as unknown as Database, {
                accountId: workspace.accountId,
                workspaceId: workspace.workspaceId,
                sessionId: actor.sessionId,
                actor: { type: "human", subjectId: "eventorder-domain-conflict" },
                operationKey: crypto.randomUUID(),
                action: "pause",
              }),
          ),
      );
      const bus = new MemoryEventBus();
      let wakes = 0;
      const error = await rejectAgentCommandWithoutEffects({
        actor,
        targetSessionId: target.sessionId,
        bus,
        wakeCount: () => wakes,
        invoke: async () =>
          await sendPublishedAgentMessage(actor, target, crypto.randomUUID(), bus, () => {
            wakes += 1;
          }),
      });
      expect(error).toBeInstanceOf(AgentCommandAuthorityError);
      expect(error).toMatchObject({ code: "CALLER_INTERRUPTED" });
    }

    {
      const actor = await seedRunningSession();
      const bus = new MemoryEventBus();
      let wakes = 0;
      const error = await rejectAgentCommandWithoutEffects({
        actor,
        targetSessionId: actor.sessionId,
        bus,
        wakeCount: () => wakes,
        invoke: async () =>
          await steerPublishedAgentSession(actor, actor, crypto.randomUUID(), bus, () => {
            wakes += 1;
          }),
      });
      expect(error).toBeInstanceOf(AgentCommandAuthorityError);
      expect(error).toMatchObject({ code: "SELF_STEER" });
    }

    {
      const workspace = await freshWorkspace();
      const actor = await seedRunningSession(workspace);
      const target = await seedIdleChild(workspace, crypto.randomUUID(), actor.sessionId);
      const operationKey = crypto.randomUUID();
      const bus = new MemoryEventBus();
      let wakes = 0;
      await sendPublishedAgentMessage(actor, target, operationKey, bus, () => {
        wakes += 1;
      });
      const error = await rejectAgentCommandWithoutEffects({
        actor,
        targetSessionId: target.sessionId,
        bus,
        wakeCount: () => wakes,
        invoke: async () =>
          await sendAgentSessionMessage(
            {
              db,
              bus,
              workflowClient: {
                wakeSessionWorkflow: async () => {
                  wakes += 1;
                },
              },
            },
            {
              accountId: actor.accountId,
              workspaceId: actor.workspaceId,
              callerSessionId: actor.sessionId,
              callerTurnId: actor.turnId,
              callerAttemptId: actor.attemptId,
              callerExecutionGeneration: 1,
            },
            {
              targetSessionId: target.sessionId,
              text: "different input for the same operation key",
              idempotencyKey: operationKey,
            },
          ),
      });
      expect(error).toBeInstanceOf(SessionCommandIdempotencyError);
      expect(error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    }

    {
      const workspace = await freshWorkspace();
      const actor = await seedRunningSession(workspace);
      const target = await seedIdleChild(workspace, crypto.randomUUID(), actor.sessionId);
      await admin`
        update sessions
        set status = 'cancelled'
        where workspace_id = ${workspace.workspaceId}
          and id = ${target.sessionId}
      `;
      const bus = new MemoryEventBus();
      let wakes = 0;
      const error = await rejectAgentCommandWithoutEffects({
        actor,
        targetSessionId: target.sessionId,
        bus,
        wakeCount: () => wakes,
        invoke: async () =>
          await sendPublishedAgentMessage(actor, target, crypto.randomUUID(), bus, () => {
            wakes += 1;
          }),
      });
      expect(error).toBeInstanceOf(QueueCommandConflictError);
      expect(error).toMatchObject({ code: "QUEUE_PROMPT_STARTED" });
    }

    {
      const workspace = await freshWorkspace();
      const actor = await seedRunningSession(workspace);
      const target = await seedIdleChild(workspace, crypto.randomUUID(), actor.sessionId);
      const operationKey = crypto.randomUUID();
      const text = "malformed replay fixture";
      await admin`
        insert into session_command_receipts (
          account_id, workspace_id, actor_type, actor_attempt_id, action,
          target_session_id, operation_key, canonical_request_hash
        ) values (
          ${workspace.accountId}, ${workspace.workspaceId}, 'agent_attempt',
          ${actor.attemptId}, 'agent.message', ${target.sessionId}, ${operationKey},
          ${canonicalSessionCommandHash({ text })}
        )
      `;
      const bus = new MemoryEventBus();
      let wakes = 0;
      const error = await rejectAgentCommandWithoutEffects({
        actor,
        targetSessionId: target.sessionId,
        bus,
        wakeCount: () => wakes,
        invoke: async () =>
          await sendAgentSessionMessage(
            {
              db,
              bus,
              workflowClient: {
                wakeSessionWorkflow: async () => {
                  wakes += 1;
                },
              },
            },
            {
              accountId: actor.accountId,
              workspaceId: actor.workspaceId,
              callerSessionId: actor.sessionId,
              callerTurnId: actor.turnId,
              callerAttemptId: actor.attemptId,
              callerExecutionGeneration: 1,
            },
            {
              targetSessionId: target.sessionId,
              text,
              idempotencyKey: operationKey,
            },
          ),
      });
      expect(error).toBeInstanceOf(SessionControlInvariantError);
      expect(error).toMatchObject({ code: "SESSION_CONTROL_INVARIANT" });
    }
  }, 60_000);

  test("sanitizes an exhausted Agent command persistence failure before external effects", async () => {
    const workspace = await freshWorkspace();
    const ids = orderedParentChildIds("child-first");
    const actor = await seedRunningSession(workspace, { sessionId: ids.parentSessionId });
    const target = await seedIdleChild(workspace, ids.childSessionId, ids.parentSessionId);
    const bus = new MemoryEventBus();
    let wakes = 0;
    await admin`select setval('eventorder_fault_attempt_seq', 1, false)`;
    await admin`
      insert into eventorder_command_faults (action, sql_state, always_fault)
      values ('agent.message', '40P01', true)
    `;
    const error = await sendPublishedAgentMessage(actor, target, crypto.randomUUID(), bus, () => {
      wakes += 1;
    })
      .catch((caught) => caught)
      .finally(async () => {
        await admin`delete from eventorder_command_faults where action = 'agent.message'`;
      });

    expect(error).toBeInstanceOf(SessionEventPersistenceError);
    expect((error as SessionEventPersistenceError).details).toMatchObject({
      code: "db_deadlock",
      sqlState: "40P01",
      stage: "session_commands.agent_message",
      eventTypes: ["system.update.pending"],
      attempts: 3,
      retryOutcome: "exhausted",
      database: { table: "session_command_receipts" },
    });
    const observable = JSON.stringify({
      message: (error as Error).message,
      stack: (error as Error).stack,
      details: (error as SessionEventPersistenceError).details,
      cause: (error as Error & { cause?: unknown }).cause,
    });
    expect(observable).not.toContain("private-token");
    expect(observable).not.toContain("insert into");
    expect(wakes).toBe(0);
    expect(bus.published).toHaveLength(0);
    expect(await assertCommittedSequence(target, 0)).toEqual([]);
  }, 60_000);

  test("locks both child lifecycle outbox sessions before parent-to-child Agent commands", async () => {
    for (const order of ["parent-first", "child-first"] as const) {
      for (const path of [
        "idle",
        "failed-settlement",
        "exhausted-recovery",
        "get-or-create",
      ] as const) {
        const workspace = await freshWorkspace();
        const ids = orderedParentChildIds(order);
        const parent = await seedRunningSession(workspace, { sessionId: ids.parentSessionId });
        let child: Pick<RunningFixture, "accountId" | "workspaceId" | "sessionId">;
        let runningChild: RunningFixture | null = null;
        if (path === "idle" || path === "get-or-create") {
          child = await seedIdleChild(workspace, ids.childSessionId, ids.parentSessionId);
        } else {
          runningChild = await seedRunningSession(workspace, {
            sessionId: ids.childSessionId,
            parentSessionId: ids.parentSessionId,
          });
          child = runningChild;
        }
        const dedupeKey =
          path === "idle" || path === "get-or-create"
            ? `child-completion:${child.sessionId}:0`
            : `child-completion:${child.sessionId}:turn:${runningChild!.turnId}`;

        const lifecycleWriter = async (): Promise<unknown> => {
          switch (path) {
            case "idle":
              return await settleSessionIdleWithParentOutbox(
                db,
                workspace.workspaceId,
                child.sessionId,
              );
            case "failed-settlement":
              return await applySessionTurnSettlement(db, workspace.workspaceId, {
                sessionId: runningChild!.sessionId,
                turnId: runningChild!.turnId,
                triggerEventId: runningChild!.triggerEventId,
                attemptId: runningChild!.attemptId,
                turnStatus: "failed",
                sessionStatus: "failed",
                activeTurnId: null,
                events: [
                  { type: "turn.failed", payload: { code: "eventorder_test_failure" } },
                  { type: "session.status.changed", payload: { status: "failed" } },
                ],
              });
            case "exhausted-recovery":
              return await recoverSessionDispatch(db, workspace.workspaceId, {
                sessionId: runningChild!.sessionId,
                attemptId: runningChild!.attemptId,
                timeoutType: "HEARTBEAT",
                maxRedispatches: 0,
              });
            case "get-or-create":
              return await getOrCreateSessionSystemUpdateOutbox(db, {
                accountId: workspace.accountId,
                workspaceId: workspace.workspaceId,
                sourceSessionId: child.sessionId,
                targetSessionId: parent.sessionId,
                dedupeKey,
                kind: "child_terminal_result",
                classification: "success",
                sourceId: child.sessionId,
                summary: "event-ordering invariant fallback outbox race",
                payload: {
                  type: "child_terminal_result",
                  childSessionId: child.sessionId,
                  status: "idle",
                },
                lineage: {
                  childSessionId: child.sessionId,
                  parentSessionId: parent.sessionId,
                },
              });
          }
        };

        const [lifecycle, command] = await raceLifecycleOutboxAgainstAgentCommand({
          dedupeKey,
          lifecycleWriter,
          parent,
          child,
        });
        expect(command).toMatchObject({ replay: false });
        if (path === "idle") expect(lifecycle).toMatchObject({ action: "settled" });
        if (path === "failed-settlement") {
          expect(lifecycle).toMatchObject({ action: "settled" });
        }
        if (path === "exhausted-recovery") {
          expect(lifecycle).toMatchObject({ action: "exceeded" });
        }
        if (path === "get-or-create") {
          expect(lifecycle).toMatchObject({ dedupeKey, status: "pending" });
        }

        const outbox = await admin<
          Array<{
            source_session_id: string;
            target_session_id: string;
            status: string;
          }>
        >`
          select source_session_id, target_session_id, status
          from session_system_update_outbox
          where workspace_id = ${workspace.workspaceId}
            and dedupe_key = ${dedupeKey}
        `;
        expect([...outbox]).toEqual([
          {
            source_session_id: child.sessionId,
            target_session_id: parent.sessionId,
            status: "pending",
          },
        ]);
        const [updates] = await admin<{ count: number }[]>`
          select count(*)::int as count
          from session_system_updates
          where workspace_id = ${workspace.workspaceId}
            and session_id = ${child.sessionId}
            and kind = 'agent_message'
        `;
        expect(updates?.count).toBe(1);
        const expectedEventCount =
          path === "idle"
            ? 2
            : path === "failed-settlement" || path === "exhausted-recovery"
              ? 3
              : 1;
        const rows = await assertCommittedSequence(child, expectedEventCount);
        expect(rows.filter((row) => row.type === "system.update.pending")).toHaveLength(1);
      }
    }
  }, 180_000);

  test("retries failed-child settlement persistence without replaying external effects", async () => {
    for (const sqlState of ["40P01", "40001"] as const) {
      const workspace = await freshWorkspace();
      const parent = await seedRunningSession(workspace);
      const child = await seedRunningSession(workspace, { parentSessionId: parent.sessionId });
      await admin`select setval('eventorder_fault_attempt_seq', 1, false)`;
      let providerCalls = 0;
      let toolEffects = 0;
      let externalEffects = 0;
      providerCalls += 1;
      toolEffects += 1;
      externalEffects += 1;
      const sourceKey = `lifecycle-exactly-once-${sqlState}-${crypto.randomUUID()}`;

      const settled = await applySessionTurnSettlement(db, workspace.workspaceId, {
        sessionId: child.sessionId,
        turnId: child.turnId,
        triggerEventId: child.triggerEventId,
        attemptId: child.attemptId,
        turnStatus: "failed",
        sessionStatus: "failed",
        activeTurnId: null,
        events: [
          {
            type: "agent.model.usage",
            payload: { sourceKey, eventorderFaultSqlState: sqlState, totalTokens: 42 },
          },
          { type: "turn.failed", payload: { code: "eventorder_test_failure" } },
        ],
      });
      expect(settled).toMatchObject({ action: "settled" });
      expect(providerCalls).toBe(1);
      expect(toolEffects).toBe(1);
      expect(externalEffects).toBe(1);
      const [attempts] = await admin<{ last_value: string }[]>`
        select last_value::text from eventorder_fault_attempt_seq
      `;
      expect(Number(attempts?.last_value)).toBe(2);
      const rows = await assertCommittedSequence(child, 2);
      expect(rows.filter((row) => row.type === "agent.model.usage")).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ sourceKey }) }),
      ]);
      const [outbox] = await admin<{ count: number }[]>`
        select count(*)::int as count
        from session_system_update_outbox
        where workspace_id = ${workspace.workspaceId}
          and dedupe_key = ${`child-completion:${child.sessionId}:turn:${child.turnId}`}
      `;
      expect(outbox?.count).toBe(1);
    }
  }, 60_000);

  test("sanitizes exhausted lifecycle persistence failures", async () => {
    const workspace = await freshWorkspace();
    const parent = await seedRunningSession(workspace);
    const child = await seedRunningSession(workspace, { parentSessionId: parent.sessionId });
    const error = await applySessionTurnSettlement(db, workspace.workspaceId, {
      sessionId: child.sessionId,
      turnId: child.turnId,
      triggerEventId: child.triggerEventId,
      attemptId: child.attemptId,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [
        {
          type: "turn.failed",
          payload: { eventorderAlwaysFaultSqlState: "40P01", private: "private-token" },
        },
      ],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionEventPersistenceError);
    expect((error as SessionEventPersistenceError).details).toMatchObject({
      code: "db_deadlock",
      sqlState: "40P01",
      stage: "session_lifecycle_outbox.settle_turn",
      eventTypes: ["child_terminal_result", "turn.failed"],
      attempts: 3,
      retryOutcome: "exhausted",
      database: { table: "session_events" },
    });
    const observable = JSON.stringify({
      message: (error as Error).message,
      stack: (error as Error).stack,
      details: (error as SessionEventPersistenceError).details,
      cause: (error as Error & { cause?: unknown }).cause,
    });
    expect(observable).not.toContain("private-token");
    expect(observable).not.toContain("insert into");
    expect(await assertCommittedSequence(child, 0)).toEqual([]);
  }, 60_000);

  test("retries only idempotent persistence for real 40P01 and 40001 faults", async () => {
    for (const sqlState of ["40P01", "40001"] as const) {
      const fixture = await seedRunningSession();
      await admin`select setval('eventorder_fault_attempt_seq', 1, false)`;
      let providerCalls = 0;
      let toolEffects = 0;
      let externalEffects = 0;
      providerCalls += 1;
      toolEffects += 1;
      externalEffects += 1;
      const sourceKey = `exactly-once-${sqlState}-${crypto.randomUUID()}`;

      const persisted = await appendSessionEventsForTurnAttempt(
        db,
        fixture.workspaceId,
        fixture.sessionId,
        fixture.turnId,
        1,
        fixture.attemptId,
        [
          {
            type: "agent.model.usage",
            payload: { sourceKey, eventorderFaultSqlState: sqlState, totalTokens: 42 },
          },
        ],
      );
      expect(persisted).toMatchObject({ accepted: true });
      expect(providerCalls).toBe(1);
      expect(toolEffects).toBe(1);
      expect(externalEffects).toBe(1);
      const [attempts] = await admin<{ last_value: string }[]>`
          select last_value::text from eventorder_fault_attempt_seq
        `;
      expect(Number(attempts?.last_value)).toBe(2);
      const rows = await assertCommittedSequence(fixture, 1);
      expect(rows[0]).toMatchObject({
        type: "agent.model.usage",
        payload: { sourceKey },
      });
    }
  }, 60_000);

  test("retries a generic goal append without replaying inference, goal mutation, or publish", async () => {
    for (const sqlState of ["40P01", "40001"] as const) {
      const fixture = await seedRunningSession();
      await seedGoal(fixture);
      await admin`select setval('eventorder_fault_attempt_seq', 1, false)`;
      const bus = new MemoryEventBus();
      let inferenceCalls = 0;
      let goalMutations = 0;
      inferenceCalls += 1;
      goalMutations += 1;
      const goal = await updateSessionGoal(db, fixture.workspaceId, fixture.sessionId, {
        text: `event-ordering invariant retried generic append ${sqlState}`,
      });

      await appendAndPublishEvents(db, bus, fixture.workspaceId, fixture.sessionId, [
        {
          type: "goal.updated",
          payload: {
            goalId: goal.id,
            version: goal.version,
            eventorderFaultSqlState: sqlState,
          },
        },
      ]);

      expect(inferenceCalls).toBe(1);
      expect(goalMutations).toBe(1);
      expect(bus.published).toHaveLength(1);
      expect(bus.published[0]).toMatchObject([{ sequence: 1, type: "goal.updated" }]);
      const [attempts] = await admin<{ last_value: string }[]>`
        select last_value::text from eventorder_fault_attempt_seq
      `;
      expect(Number(attempts?.last_value)).toBe(2);
      const [persistedGoal] = await admin<{ version: number; text: string }[]>`
        select version, text from session_goals where session_id = ${fixture.sessionId}
      `;
      expect(persistedGoal).toEqual({
        version: 2,
        text: `event-ordering invariant retried generic append ${sqlState}`,
      });
      await assertCommittedSequence(fixture, 1);
    }
  }, 60_000);

  test("sanitizes an exhausted generic append with exact stage and SQLSTATE", async () => {
    const fixture = await seedRunningSession();
    const error = await appendSessionEvents(db, fixture.workspaceId, fixture.sessionId, [
      {
        type: "goal.updated",
        payload: { eventorderAlwaysFaultSqlState: "40001", private: "private-token" },
      },
    ]).catch((caught) => caught);

    expect(error).toBeInstanceOf(SessionEventPersistenceError);
    expect((error as SessionEventPersistenceError).details).toMatchObject({
      code: "db_serialization_failure",
      sqlState: "40001",
      stage: "session_events.append_generic",
      eventTypes: ["goal.updated"],
      attempts: 3,
      retryOutcome: "exhausted",
      database: { table: "session_events" },
    });
    const observable = JSON.stringify({
      message: (error as Error).message,
      stack: (error as Error).stack,
      details: (error as SessionEventPersistenceError).details,
      cause: (error as Error & { cause?: unknown }).cause,
    });
    expect(observable).not.toContain("private-token");
    expect(observable).not.toContain("insert into");
    expect(await assertCommittedSequence(fixture, 0)).toEqual([]);
  }, 60_000);
});
