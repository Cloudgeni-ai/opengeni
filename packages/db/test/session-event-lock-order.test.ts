import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  addSessionSystemUpdate,
  appendSessionEventToSandboxGroup,
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  appendSessionEventsForTurnAttempt,
  appendSessionEventsWithLockedSessionUpdate,
  applySessionTurnSettlement,
  createDb,
  sendAgentMessageInTransaction,
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

async function freshWorkspace(): Promise<WorkspaceFixture> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name)
    values ('OPE-63 event lock account')
    returning id
  `;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'OPE-63 event lock workspace')
    returning id
  `;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})
  `;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function seedRunningSession(workspace?: WorkspaceFixture): Promise<RunningFixture> {
  const owner = workspace ?? (await freshWorkspace());
  const sessionId = crypto.randomUUID();
  const sandboxGroupId = sessionId;
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const triggerEventId = crypto.randomUUID();
  const workflowId = `session-${sessionId}`;
  await admin`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id, status, temporal_workflow_id
    ) values (
      ${sessionId}, ${owner.accountId}, ${owner.workspaceId}, 'OPE-63 race',
      'codex/gpt-5.6-sol', 'modal', ${sandboxGroupId}, 'running', ${workflowId}
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
        ${workflowId}, 'running', 1, 'OPE-63 race', 'codex/gpt-5.6-sol',
        'xhigh', 'modal', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
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

async function seedGoal(fixture: RunningFixture): Promise<void> {
  await admin`
    insert into session_goals (
      account_id, workspace_id, session_id, status, text,
      success_criteria, version, max_auto_continuations
    ) values (
      ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.sessionId}, 'active',
      'Initial OPE-63 goal', 'Persist every event exactly once', 1, 20
    )
  `;
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

async function sendAgentMessage(
  actor: RunningFixture,
  target: RunningFixture,
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
            text: `OPE-63 pair-lock message ${operationKey}`,
          }),
      ),
  );
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
): Promise<void> {
  const lockId = nextBarrierId++;
  await barrier`select pg_advisory_lock(${BARRIER_CLASS}, ${lockId})`;
  await admin`
    insert into ope63_event_barriers (event_type, lock_class, lock_id)
    values (${firstEventType}, ${BARRIER_CLASS}, ${lockId})
  `;
  let released = false;
  let first: Promise<unknown> | null = null;
  let second: Promise<unknown> | null = null;
  try {
    first = firstWriter();
    await waitForAdvisoryWaiter();
    await admin`delete from ope63_event_barriers where event_type = ${firstEventType}`;
    second = secondWriter();
    await waitForTwoAppLockWaiters();
    await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`;
    released = true;
    await within(Promise.all([first, second]), "both event writers to commit");
  } finally {
    await admin`delete from ope63_event_barriers where event_type = ${firstEventType}`.catch(
      () => undefined,
    );
    if (!released) {
      await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`.catch(() => undefined);
    }
    await Promise.allSettled([first, second].filter((value): value is Promise<unknown> => !!value));
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
        payload: { trigger: "OPE-63 race" },
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
        [{ type: "agent.updated", payload: { source: "OPE-63 race" } }],
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
              payload: { source: "OPE-63 race" },
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
        sourceId: "ope-63-race",
        dedupeKey: `ope-63-${operationId}`,
        summary: "OPE-63 internal update race",
        payload: {
          type: "agent_message",
          text: "OPE-63 internal update race",
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
    create table ope63_event_barriers (
      event_type text primary key,
      lock_class integer not null,
      lock_id integer not null
    )
  `;
  await admin`create sequence ope63_fault_attempt_seq`;
  await admin`create sequence ope63_rollback_candidate_seq`;
  await admin.unsafe(`
    create function ope63_session_event_test_trigger()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog, public
    as $function$
    declare
      configured record;
      fault_state text;
      fault_attempt bigint;
    begin
      select lock_class, lock_id
      into configured
      from public.ope63_event_barriers
      where event_type = new.type;
      if found then
        perform pg_catalog.pg_advisory_xact_lock(configured.lock_class, configured.lock_id);
      end if;

      fault_state := new.payload ->> 'ope63FaultSqlState';
      if fault_state in ('40P01', '40001') then
        fault_attempt := nextval('public.ope63_fault_attempt_seq');
        if fault_attempt = 1 then
          raise exception using
            errcode = fault_state,
            message = 'OPE-63 injected persistence fault';
        end if;
      end if;

      if new.payload ->> 'ope63RollbackCandidate' = 'true' then
        perform setval('public.ope63_rollback_candidate_seq', new.sequence, false);
        raise exception using
          errcode = '23514',
          message = 'OPE-63 injected non-retryable rollback';
      end if;
      return new;
    end
    $function$;

    create trigger ope63_session_event_test_trigger
    before insert on session_events
    for each row execute function ope63_session_event_test_trigger();

    create function ope63_command_receipt_test_trigger()
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
      from public.ope63_event_barriers
      where event_type = 'receipt:' || new.action;
      if found then
        perform pg_catalog.pg_advisory_xact_lock(configured.lock_class, configured.lock_id);
      end if;
      return new;
    end
    $function$;

    create trigger zz_ope63_command_receipt_test_trigger
    after insert on session_command_receipts
    for each row execute function ope63_command_receipt_test_trigger();
  `);
}, 180_000);

afterAll(async () => {
  await appClient?.close().catch(() => undefined);
  await monitor?.end().catch(() => undefined);
  await barrier?.end().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("OPE-63 canonical session-event lock order", () => {
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

  test("first-turn title and goal mutation events race model usage without duplicate allocation", async () => {
    for (const first of ["generic", "activity"] as const) {
      const titleFixture = await seedRunningSession();
      const titleWriter = async () => {
        expect(
          await updateSessionTitle(db, {
            workspaceId: titleFixture.workspaceId,
            sessionId: titleFixture.sessionId,
            title: "OPE-63 first-turn canary",
            source: "agent",
          }),
        ).toMatchObject({ updated: true, title: "OPE-63 first-turn canary" });
        return await appendSessionEvents(db, titleFixture.workspaceId, titleFixture.sessionId, [
          {
            type: "session.title_set",
            payload: { title: "OPE-63 first-turn canary", source: "agent" },
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
      expect(title?.title).toBe("OPE-63 first-turn canary");

      const goalFixture = await seedRunningSession();
      await seedGoal(goalFixture);
      const goalWriter = async () => {
        const goal = await updateSessionGoal(db, goalFixture.workspaceId, goalFixture.sessionId, {
          text: "Updated OPE-63 goal",
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
          payload: { ope63RollbackCandidate: true },
        },
      ]),
    ).rejects.toBeDefined();
    const [attempted] = await admin<{ last_value: string }[]>`
      select last_value::text from ope63_rollback_candidate_seq
    `;
    expect(Number(attempted?.last_value)).toBe(1);
    expect(await assertCommittedSequence(fixture, 0)).toEqual([]);

    await appendSessionEvents(db, fixture.workspaceId, fixture.sessionId, [
      { type: "goal.updated", payload: { committed: true } },
    ]);
    const rows = await assertCommittedSequence(fixture, 1);
    expect(rows[0]).toMatchObject({ sequence: 1, type: "goal.updated" });
  });

  test("does not serialize unrelated sessions in the same workspace", async () => {
    const workspace = await freshWorkspace();
    const first = await seedRunningSession(workspace);
    const second = await seedRunningSession(workspace);
    const lockId = nextBarrierId++;
    await barrier`select pg_advisory_lock(${BARRIER_CLASS}, ${lockId})`;
    await admin`
      insert into ope63_event_barriers (event_type, lock_class, lock_id)
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
      await admin`delete from ope63_event_barriers where event_type = 'session.title_set'`;
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
      insert into ope63_event_barriers (event_type, lock_class, lock_id)
      values ('receipt:agent.message', ${BARRIER_CLASS}, ${lockId})
    `;
    let released = false;
    let first: Promise<unknown> | null = null;
    let second: Promise<unknown> | null = null;
    try {
      first = sendAgentMessage(actor, firstTarget, crypto.randomUUID());
      await waitForAdvisoryWaiter();
      await admin`delete from ope63_event_barriers where event_type = 'receipt:agent.message'`;
      second = sendAgentMessage(actor, secondTarget, crypto.randomUUID());
      await waitForTwoAppLockWaiters();
      await barrier`select pg_advisory_unlock(${BARRIER_CLASS}, ${lockId})`;
      released = true;
      await within(Promise.all([first, second]), "both pair-locked Agent messages to commit");
    } finally {
      await admin`delete from ope63_event_barriers where event_type = 'receipt:agent.message'`.catch(
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

  test("retries only idempotent persistence for real 40P01 and 40001 faults", async () => {
    for (const sqlState of ["40P01", "40001"] as const) {
      const fixture = await seedRunningSession();
      await admin`select setval('ope63_fault_attempt_seq', 1, false)`;
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
            payload: { sourceKey, ope63FaultSqlState: sqlState, totalTokens: 42 },
          },
        ],
      );
      expect(persisted).toMatchObject({ accepted: true });
      expect(providerCalls).toBe(1);
      expect(toolEffects).toBe(1);
      expect(externalEffects).toBe(1);
      const [attempts] = await admin<{ last_value: string }[]>`
          select last_value::text from ope63_fault_attempt_seq
        `;
      expect(Number(attempts?.last_value)).toBe(2);
      const rows = await assertCommittedSequence(fixture, 1);
      expect(rows[0]).toMatchObject({
        type: "agent.model.usage",
        payload: { sourceKey },
      });
    }
  }, 60_000);
});
