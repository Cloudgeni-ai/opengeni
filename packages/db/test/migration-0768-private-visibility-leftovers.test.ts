import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  inspectSessionVisibilityChange,
  sessionHasLiveAttempts,
  settleSessionAttemptInterruptions,
  stopSessionWorkForVisibilityChange,
  submitHumanPromptInTransaction,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";

// Migration 0768 and the visibility work settlement: leftover records never
// block making a chat Only me. Visible work needs consent, a live attempt is
// stopped first, and blocks that protect another person's authority stay.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0768-private-visibility-leftovers");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `visibility-leftovers-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Visibility leftovers owner",
  });
  const legacyWorkspaceId = context.defaultWorkspaceId!;
  const personal = context.workspaceGrants.find((grant) => grant.workspaceId !== legacyWorkspaceId);
  if (!personal?.workspaceId) throw new Error("managed human has no personal workspace");
  const accountId = personal.accountId;
  const workspaceId = personal.workspaceId;
  const privateSessions = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
  });
  if (!privateSessions.enabled) {
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: privateSessions.version,
      operationId: crypto.randomUUID(),
    });
  }
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { accountId, workspaceId, subjectId, actorSubjectId: subjectId, sessionId: session.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function submit(f: Fixture, text: string): Promise<string> {
  const accepted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.workspaceId,
    f.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: f.sessionId,
          subjectId: f.subjectId,
          actor: { type: "human", subjectId: f.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text,
          resources: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
      ),
  );
  return accepted.turnId;
}

/** Forge persisted state the way an interrupted older release left it. */
async function forge(statement: (tx: typeof shared.admin) => Promise<unknown>): Promise<void> {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await statement(tx as unknown as typeof shared.admin);
  });
}

function privatize(f: Fixture, options: { stopActiveWork?: boolean; epoch?: number } = {}) {
  return transitionSessionVisibility(client.db, {
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    actorSubjectId: f.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: options.epoch ?? 1,
    operationKey: `visibility-${crypto.randomUUID()}`,
    ...(options.stopActiveWork ? { stopActiveWork: true } : {}),
  });
}

async function turnStates(f: Fixture) {
  return await shared.admin<Array<{ id: string; status: string; cancelReason: string | null }>>`
    select id, status, cancel_reason as "cancelReason" from session_turns
    where session_id = ${f.sessionId} order by position`;
}

async function sessionRow(f: Fixture) {
  const [row] = await shared.admin<
    Array<{ status: string; visibility: string; activeTurnId: string | null }>
  >`select status, visibility, active_turn_id as "activeTurnId" from sessions where id = ${f.sessionId}`;
  return row!;
}

async function insertPendingUpdate(
  f: Fixture,
  kind: "background_command_result" | "session_wait_timeout",
  causalTurnId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const payload =
    kind === "background_command_result"
      ? {
          type: kind,
          commandId: id,
          state: "exited",
          exitCode: 0,
          reason: "Completed",
          outputLocator: { eventType: "sandbox.command.output.delta", commandId: id },
        }
      : { type: kind, deadlineAt: new Date().toISOString() };
  await forge(
    (tx) => tx`insert into session_system_updates
      (id, account_id, workspace_id, session_id, kind, classification, source_id, dedupe_key,
       summary, payload, lineage, personal_connection_delegations, xai_provider_account_authority_snapshot)
      values (${id}, ${f.accountId}, ${f.workspaceId}, ${f.sessionId}, ${kind}, 'info', ${id}, ${id},
        'Machine notice', ${tx.json(payload as never)}, ${tx.json({ causalTurnId } as never)},
        ${tx.json([] as never)}, ${tx.json({ version: 1, scope: "workspace" } as never)})`,
  );
  return id;
}

async function scheduleTargeting(f: Fixture, runAtHoursAgo: number): Promise<string> {
  const runAt = new Date(Date.now() - runAtHoursAgo * 3_600_000).toISOString();
  const task = await createScheduledTask(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    name: "Targets this chat",
    status: "active",
    schedule: { type: "once", runAt, timeZone: "UTC" },
    temporalScheduleId: `schedule-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    agentConfig: { prompt: "Check in", resources: [], tools: [], metadata: {} },
    metadata: {},
    createdBy: { kind: "service", subjectId: "scheduler" },
  });
  await forge(
    (tx) =>
      tx`update scheduled_tasks set reusable_session_id = ${f.sessionId} where id = ${task.id}`,
  );
  return task.id;
}

describe("making a chat Only me settles leftovers", () => {
  for (const stuckStatus of ["recovering", "waiting_capacity", "queued"] as const) {
    test(`a turn stuck ${stuckStatus} behind an idle chat is cancelled, not a blocker`, async () => {
      const f = await fixture();
      const stuck = await submit(f, `${stuckStatus} forever`);
      const queued = await submit(f, "queued behind it");
      const finished = await submit(f, "finished long ago");
      await forge(async (tx) => {
        await tx`update session_turns set status = ${stuckStatus} where id = ${stuck}`;
        await tx`update session_turns set status = 'completed', finished_at = now()
          where id = ${finished}`;
        await tx`update sessions set status = 'idle', active_turn_id = null
          where id = ${f.sessionId}`;
        // A run state left on the finished turn by an older release.
        await tx`insert into agent_run_states
          (account_id, workspace_id, session_id, turn_id, state_version, serialized_run_state)
          values (${f.accountId}, ${f.workspaceId}, ${f.sessionId}, ${finished}, 1, '{}')`;
      });

      expect(await inspectSessionVisibilityChange(client.db, f)).toMatchObject({
        visibility: "workspace_shared",
        blocker: null,
        work: { runningTurnCount: 0, queuedTurnCount: 0, activeGoal: false },
      });

      const result = await privatize(f);
      expect(result).toMatchObject({
        visibility: "user_private",
        changed: true,
        cancelledTurnCount: 2,
      });
      expect(result.settledEventIds).toHaveLength(2);
      const turns = new Map((await turnStates(f)).map((turn) => [turn.id, turn]));
      for (const id of [stuck, queued]) {
        expect(turns.get(id)).toMatchObject({
          status: "cancelled",
          cancelReason: "authority_changed",
        });
      }
      expect(turns.get(finished)?.status).toBe("completed");
      expect(await sessionRow(f)).toMatchObject({ status: "idle", visibility: "user_private" });
      const events = await shared.admin<Array<{ type: string }>>`
        select type from session_events where session_id = ${f.sessionId}
          and type in ('turn.cancelled', 'session.visibility.changed') order by sequence`;
      expect(events.map((event) => event.type)).toEqual([
        "turn.cancelled",
        "turn.cancelled",
        "session.visibility.changed",
      ]);
    });
  }

  test("a foreign background-command notice is cancelled; other foreign input still blocks", async () => {
    const f = await fixture();
    const foreignTurn = crypto.randomUUID();
    const blocking = await insertPendingUpdate(f, "session_wait_timeout", foreignTurn);
    const notice = await insertPendingUpdate(f, "background_command_result", foreignTurn);

    expect((await inspectSessionVisibilityChange(client.db, f)).blocker).toBe(
      "pending_system_update",
    );
    await expect(privatize(f)).rejects.toMatchObject({
      name: "SessionTenancyConflictError",
      reason: "not_quiescent",
      blocker: "pending_system_update",
    });
    // Atomic: the refused change cancelled nothing.
    const [stillPending] = await shared.admin<Array<{ state: string }>>`
      select state from session_system_updates where id = ${notice}`;
    expect(stillPending!.state).toBe("pending");

    await forge(
      (tx) => tx`update session_system_updates set state = 'cancelled' where id = ${blocking}`,
    );
    expect((await inspectSessionVisibilityChange(client.db, f)).blocker).toBeNull();
    const result = await privatize(f);
    expect(result).toMatchObject({ visibility: "user_private", cancelledUpdateCount: 1 });
    const [cancelled] = await shared.admin<Array<{ state: string }>>`
      select state from session_system_updates where id = ${notice}`;
    expect(cancelled!.state).toBe("cancelled");
    const [event] = await shared.admin<Array<{ payload: { updateId: string; reason: string } }>>`
      select payload from session_events where session_id = ${f.sessionId}
        and type = 'system.update.cancelled'`;
    expect(event!.payload).toEqual({ updateId: notice, reason: "authority_changed" });
  });

  test("an exhausted schedule no longer blocks; a live schedule still does", async () => {
    const f = await fixture();
    const live = await scheduleTargeting(f, -2);
    await scheduleTargeting(f, 48);
    expect((await inspectSessionVisibilityChange(client.db, f)).blocker).toBe(
      "active_scheduled_task",
    );
    await expect(privatize(f)).rejects.toMatchObject({ blocker: "active_scheduled_task" });
    await forge((tx) => tx`update scheduled_tasks set status = 'paused' where id = ${live}`);
    expect(await privatize(f)).toMatchObject({ visibility: "user_private", changed: true });
  });
});

describe("making a chat Only me anyway", () => {
  test("visible work needs consent, then queued messages are cancelled and the goal paused", async () => {
    const f = await fixture();
    const parked = await submit(f, "waiting for an approval");
    const next = await submit(f, "queued behind it");
    await forge(async (tx) => {
      await tx`update session_turns set status = 'requires_action' where id = ${parked}`;
      await tx`update sessions set status = 'requires_action', active_turn_id = ${parked}
        where id = ${f.sessionId}`;
      await tx`insert into session_goals (account_id, workspace_id, session_id, text, status)
        values (${f.accountId}, ${f.workspaceId}, ${f.sessionId}, 'Ship it', 'active')`;
    });
    const work = { runningTurnCount: 1, queuedTurnCount: 1, activeGoal: true };
    expect((await inspectSessionVisibilityChange(client.db, f)).work).toEqual(work);
    await expect(privatize(f)).rejects.toMatchObject({
      name: "SessionVisibilityWorkConflictError",
      reason: "active_work",
      work,
      liveAttemptCount: 0,
    });
    expect((await turnStates(f)).map((turn) => turn.status)).toEqual(["requires_action", "queued"]);

    const result = await privatize(f, { stopActiveWork: true });
    expect(result).toMatchObject({
      visibility: "user_private",
      cancelledTurnCount: 2,
      pausedGoalCount: 1,
    });
    expect(result.workflowWake).not.toBeNull();
    expect((await turnStates(f)).map((turn) => turn.id)).toEqual([parked, next]);
    expect((await turnStates(f)).every((turn) => turn.status === "cancelled")).toBe(true);
    expect(await sessionRow(f)).toMatchObject({ status: "idle", activeTurnId: null });
    const [goal] = await shared.admin<Array<{ status: string; pausedReason: string }>>`
      select status, paused_reason as "pausedReason" from session_goals
      where session_id = ${f.sessionId}`;
    expect(goal).toEqual({ status: "paused", pausedReason: "api" });
  });

  test("a live attempt is interrupted, the worker cancels its turn, then the change completes", async () => {
    const f = await fixture();
    const running = await submit(f, "running right now");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      sessionId: f.sessionId,
      workflowId: `session-${f.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed" || claimed.turn.id !== running) {
      throw new Error("turn was not claimed");
    }
    const queued = await submit(f, "queued behind the running turn");

    await expect(privatize(f, { stopActiveWork: true })).rejects.toMatchObject({
      name: "SessionVisibilityWorkConflictError",
      reason: "active_work",
      liveAttemptCount: 1,
    });
    const operationKey = `stop-${crypto.randomUUID()}`;
    const stopped = await stopSessionWorkForVisibilityChange(client.db, {
      ...f,
      expectedAuthorityEpoch: 1,
      operationKey,
    });
    expect(stopped).toMatchObject({ interruptedAttemptCount: 1, liveAttemptCount: 1 });
    expect(stopped.workflowWake).not.toBeNull();
    // Retrying the stop request does not interrupt twice.
    expect(
      await stopSessionWorkForVisibilityChange(client.db, {
        ...f,
        expectedAuthorityEpoch: 1,
        operationKey,
      }),
    ).toMatchObject({ interruptedAttemptCount: 0, liveAttemptCount: 1 });
    const statuses = new Map((await turnStates(f)).map((turn) => [turn.id, turn.status]));
    expect(statuses.get(running)).toBe("running");
    expect(statuses.get(queued)).toBe("cancelled");
    expect(await sessionHasLiveAttempts(client.db, f)).toBe(true);

    // The worker observes the interruption and settles it terminally.
    const settled = await settleSessionAttemptInterruptions(
      client.db,
      f.workspaceId,
      f.sessionId,
      attemptId,
    );
    expect(settled.outcome).toBe("cancelled");
    expect(await sessionHasLiveAttempts(client.db, f)).toBe(false);
    const [turn] = await shared.admin<Array<{ status: string; cancelReason: string }>>`
      select status, cancel_reason as "cancelReason" from session_turns where id = ${running}`;
    expect(turn).toEqual({ status: "cancelled", cancelReason: "authority_changed" });

    expect(await privatize(f, { stopActiveWork: true })).toMatchObject({
      visibility: "user_private",
      changed: true,
    });
    expect(await sessionRow(f)).toMatchObject({ status: "idle", activeTurnId: null });
  });

  test("stopping refuses up front when another block would remain", async () => {
    const f = await fixture();
    const running = await submit(f, "running right now");
    await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      sessionId: f.sessionId,
      workflowId: `session-${f.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    await scheduleTargeting(f, -2);
    await expect(
      stopSessionWorkForVisibilityChange(client.db, {
        ...f,
        expectedAuthorityEpoch: 1,
        operationKey: `stop-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({ reason: "not_quiescent", blocker: "active_scheduled_task" });
    const [turn] = await shared.admin<Array<{ status: string }>>`
      select status from session_turns where id = ${running}`;
    expect(turn!.status).toBe("running");
    const [interruptions] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from session_attempt_interruptions
      where session_id = ${f.sessionId}`;
    expect(interruptions!.count).toBe(0);
  });
});
