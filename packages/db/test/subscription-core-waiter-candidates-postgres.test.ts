import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import type { DbClient } from "../src";
const {
  armSubscriptionCoreCapacityWait,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  enqueueSessionWorkflowWakeInTransaction,
  ensureManagedAccessForUser,
  mutateSessionControlInTransaction,
  submitHumanPromptInTransaction,
  mutateWorkspaceControlInTransaction,
  peekSessionWork,
  reconcileSubscriptionCoreCapacityWait,
  withSessionRlsActorContext,
  withRlsContext,
  withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls,
} = await import("../src");
import { rawRows } from "../src/database";
const { wakeSubscriptionCoreCapacityWaiters } = await import("../src/subscription-core/waiters");

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  if (!realDb) return;
  const databaseFixture = await acquireSharedTestDatabase("waiter-candidates-b2");
  if (!databaseFixture) throw new Error("PostgreSQL required");
  shared = databaseFixture;
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture(candidateProviders?: string[]) {
  const userId = `waiter-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Waiter fixture",
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId;
  // Synthetic receipts admit the real registered providers only in this fixture.
  await shared.admin`insert into opengeni_private.subscription_provider_cutover_receipts
    (provider,migration,committed_at,seed_rotation)
    values ('claude','9999_waiter_fixture.sql',clock_timestamp(),'{}'::jsonb)
    on conflict do nothing`;
  const session = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "wait",
      resources: [],
      metadata: {},
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      subjectId,
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  const turn = await withSessionRlsActorContext({ subjectId }, () =>
    enqueueSessionTurn(client.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "wait",
      resources: [],
      tools: [],
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId },
    }),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("claim failed");
  const now = new Date();
  const reset = new Date(now.getTime() + 86_400_000);
  const identity = { accountId, workspaceId, sessionId: session.id, turnId: turn.id };
  const armed = await armSubscriptionCoreCapacityWait(client.db, "codex", {
    ...identity,
    attemptId,
    earliestResetAt: reset,
    ...(candidateProviders === undefined ? {} : { candidateProviders }),
    waitReason: "no_eligible_capacity",
    failurePayload: {},
    now,
  });
  if (armed.action !== "waiting") throw new Error(`arm: ${armed.action}`);
  return { ...identity, subjectId, armed, now, reset };
}

async function wake(f: Awaited<ReturnType<typeof fixture>>, provider: string) {
  return wakeSubscriptionCoreCapacityWaiters(
    client.db,
    provider,
    {
      accountId: f.accountId,
      workspaceIds: [f.workspaceId],
      reason: "test_capacity",
    },
    enqueueSessionWorkflowWakeInTransaction,
  );
}
async function state(f: Awaited<ReturnType<typeof fixture>>) {
  const [row] = await shared.admin`select candidate_providers, wake_revision::integer,
    observed_wake_revision::integer, earliest_reset_at,next_check_at
    from subscription_capacity_waiters where session_id=${f.sessionId}::uuid`;
  return row!;
}
/** Typed capacity deliveries and the generic session wake revision. */
async function deliveries(f: Awaited<ReturnType<typeof fixture>>) {
  const [typed] =
    await shared.admin`select count(*)::integer as count from subscription_capacity_wake_outbox
    where session_id=${f.sessionId}::uuid`;
  const [generic] = await shared.admin`select coalesce(max(wake_revision), 0)::integer as revision
    from session_workflow_wake_outbox where session_id=${f.sessionId}::uuid`;
  return { typed: typed!.count as number, generic: generic!.revision as number };
}
async function waiterCount(f: Awaited<ReturnType<typeof fixture>>) {
  const [row] = await shared.admin`select count(*)::integer as count
    from subscription_capacity_waiters where session_id=${f.sessionId}::uuid`;
  return row!.count as number;
}
async function turnState(f: Awaited<ReturnType<typeof fixture>>) {
  const [row] = await shared.admin`select session.status as session_status,
    session.active_turn_id::text as active_turn_id, turn.status as turn_status
    from sessions session join session_turns turn on turn.session_id = session.id
    where turn.id = ${f.turnId}::uuid`;
  return row!;
}
async function control(
  f: Awaited<ReturnType<typeof fixture>>,
  action: "pause" | "resume",
  sessionId = f.sessionId,
) {
  await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId,
      operationKey: crypto.randomUUID(),
      action,
      actor: { type: "human", subjectId: f.subjectId },
    }),
  );
}

/** Re-parent the waiter's session under a fresh parent session. */
async function adoptParent(f: Awaited<ReturnType<typeof fixture>>) {
  const parent = await withSessionRlsActorContext({ subjectId: f.subjectId }, () =>
    createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "parent",
      resources: [],
      metadata: {},
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      subjectId: f.subjectId,
      createdBy: { kind: "subject", subjectId: f.subjectId },
      createdByContext: {},
    }),
  );
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set parent_session_id = ${parent.id}::uuid,
      root_session_id = ${parent.id}::uuid where id = ${f.sessionId}::uuid`;
  });
  return parent;
}

describe.skipIf(!realDb)("SUB-WAIT-01/02 candidate-provider waiter persistence", () => {
  test("restricted role, candidate, home and noncandidate wakes and durable outboxes", async () => {
    const [role] = await rawRows<{ super: boolean; bypass: boolean; owns: boolean }>(
      client.db,
      sql`select rolsuper as super,rolbypassrls as bypass,
        (select relowner=(select oid from pg_roles where rolname=current_user)
         from pg_class where oid='subscription_capacity_waiters'::regclass) as owns
        from pg_roles where rolname=current_user`,
    );
    expect(role).toEqual({ super: false, bypass: false, owns: false });
    const f = await fixture(["claude"]);
    const other = await fixture([]);
    await wake(f, "claude");
    expect((await state(f)).wake_revision).toBe(2);
    expect((await state(other)).wake_revision).toBe(1);
    await wake(other, "claude");
    expect((await state(other)).wake_revision).toBe(1);
    await wake(f, "codex");
    expect((await state(f)).wake_revision).toBe(3);
    const [outbox] =
      await shared.admin`select count(*)::integer as count from subscription_capacity_wake_outbox
      where session_id=${f.sessionId}::uuid`;
    expect(outbox!.count).toBe(2);
    const [generic] =
      await shared.admin`select count(*)::integer as count from session_workflow_wake_outbox
      where session_id=${f.sessionId}::uuid`;
    expect(generic!.count).toBe(1);
    const foreign = await withRlsContext(
      client.db,
      { accountId: other.accountId, workspaceId: other.workspaceId },
      (tx) =>
        rawRows(
          tx,
          sql`select waiter_id from subscription_capacity_waiters where session_id=${f.sessionId}::uuid`,
        ),
    );
    expect(foreign).toEqual([]);
  }, 180_000);

  test("bounded lost-wake refresh replaces hints without changing true reset or accepted authority", async () => {
    const f = await fixture([]);
    expect(f.armed.waiter.nextCheckAt.getTime() - f.now.getTime()).toBeLessThanOrEqual(900_000);
    expect(f.armed.waiter.earliestResetAt).toEqual(f.reset);
    const [before] =
      await shared.admin`select to_jsonb(t) as row from session_turns t where id=${f.turnId}::uuid`;
    const result = await reconcileSubscriptionCoreCapacityWait(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      waiterId: f.armed.waiter.waiterId,
      generation: f.armed.waiter.generation,
      evaluatedWakeRevision: 1,
      now: f.armed.waiter.nextCheckAt,
      evaluation: {
        kind: "wait",
        waitReason: "no_eligible_capacity",
        earliestResetAt: f.reset,
        healthRetryAt: null,
        candidateProviders: ["claude"],
      },
    });
    expect(result).toMatchObject({
      action: "waiting",
      waiter: { candidateProviders: ["claude"], earliestResetAt: f.reset },
    });
    await wake(f, "claude");
    expect((await state(f)).wake_revision).toBe(2);
    const [after] =
      await shared.admin`select to_jsonb(t) as row from session_turns t where id=${f.turnId}::uuid`;
    expect(after).toEqual(before);
  }, 180_000);

  test("concurrent wakes are not lost and stale evaluation acknowledges only its observed revision", async () => {
    const f = await fixture(["claude"]);
    await Promise.all([wake(f, "claude"), wake(f, "codex"), wake(f, "claude")]);
    expect((await state(f)).wake_revision).toBe(4);
    await reconcileSubscriptionCoreCapacityWait(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      waiterId: f.armed.waiter.waiterId,
      generation: 1,
      evaluatedWakeRevision: 1,
      evaluation: {
        kind: "wait",
        waitReason: "no_eligible_capacity",
        earliestResetAt: f.reset,
        healthRetryAt: null,
        candidateProviders: [],
      },
    });
    expect(await state(f)).toMatchObject({
      wake_revision: 4,
      observed_wake_revision: 1,
      candidate_providers: [],
    });
    await wake(f, "claude");
    expect((await state(f)).wake_revision).toBe(4);
  }, 180_000);

  test("candidate removed after selection is rechecked by the final update", async () => {
    const f = await fixture(["claude"]);
    await wakeSubscriptionCoreCapacityWaiters(
      client.db,
      "claude",
      {
        accountId: f.accountId,
        workspaceIds: [f.workspaceId],
        reason: "test_capacity",
      },
      async (tx, input) => {
        await enqueueSessionWorkflowWakeInTransaction(tx, input);
        // Exercise the post-selection predicate under the already-held session
        // lock without introducing an impossible out-of-order concurrent writer.
        await tx.execute(sql`update subscription_capacity_waiters set candidate_providers='{}'::text[]
        where session_id=${f.sessionId}::uuid`);
      },
    );
    expect((await state(f)).wake_revision).toBe(1);
    const [typed] =
      await shared.admin`select count(*)::integer as count from subscription_capacity_wake_outbox
      where session_id=${f.sessionId}::uuid`;
    expect(typed!.count).toBe(0);
  }, 180_000);

  test("session Pause releases the waiting turn; capacity no longer wakes it and Resume runs it", async () => {
    const f = await fixture([]);
    await wake(f, "codex");
    const active = await deliveries(f);
    expect(active.typed).toBe(1);

    await control(f, "pause");
    // Pause stopped the wait itself: no waiter is left, and the same turn
    // parks recovering on an idle chat, as a paused running turn does.
    expect(await waiterCount(f)).toBe(0);
    expect(await turnState(f)).toEqual({
      session_status: "idle",
      active_turn_id: f.turnId,
      turn_status: "recovering",
    });
    // The dispatcher has delivered everything recorded so far.
    await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where session_id=${f.sessionId}::uuid`;
    const pausedBaseline = await deliveries(f);
    await wake(f, "codex");
    // Capacity changes have nothing left to wake, and no workflow run is
    // started merely to peek Pause and close.
    expect(await deliveries(f)).toEqual(pausedBaseline);
    expect((await peekSessionWork(client.db, f.workspaceId, f.sessionId)).kind).toBe("idle");

    // Resume commits its own wake, and the run it starts claims the same turn.
    await control(f, "resume");
    expect((await deliveries(f)).generic).toBeGreaterThan(pausedBaseline.generic);
    expect((await peekSessionWork(client.db, f.workspaceId, f.sessionId)).kind).toBe("runnable");
    const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      sessionId: f.sessionId,
      workflowId: `session-${f.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
    expect(claimed.turn.id).toBe(f.turnId);
  }, 180_000);

  test("an ancestor Pause releases a descendant's wait; the child's own Resume runs it", async () => {
    const f = await fixture([]);
    const parent = await adoptParent(f);
    await control(f, "pause", parent.id);
    expect(await waiterCount(f)).toBe(0);
    expect(await turnState(f)).toMatchObject({ session_status: "idle", turn_status: "recovering" });
    const baseline = await deliveries(f);
    await wake(f, "codex");
    expect(await deliveries(f)).toEqual(baseline);
    expect((await peekSessionWork(client.db, f.workspaceId, f.sessionId)).kind).toBe("idle");

    // A newer selected Resume on the child defeats the older ancestor Pause.
    await control(f, "resume");
    expect((await deliveries(f)).generic).toBeGreaterThan(baseline.generic);
    expect((await peekSessionWork(client.db, f.workspaceId, f.sessionId)).kind).toBe("runnable");
  }, 180_000);

  test("workspace Pause keeps the waiter and defers delivery; workspace Resume reconstructs the wait", async () => {
    const f = await fixture([]);
    await withWorkspaceRls(client.db, f.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          actor: { type: "human", subjectId: f.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where session_id=${f.sessionId}::uuid`;
    let baseline = await deliveries(f);
    const revision = (await state(f)).wake_revision;
    await wake(f, "codex");
    expect(await deliveries(f)).toEqual(baseline);
    expect((await state(f)).wake_revision).toBe(revision + 1);
    expect(await turnState(f)).toMatchObject({ turn_status: "waiting_capacity" });

    // Workspace Resume reconstructs the deferred wait like session Resume.
    await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where session_id=${f.sessionId}::uuid`;
    baseline = await deliveries(f);
    await withWorkspaceRls(client.db, f.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          actor: { type: "human", subjectId: f.subjectId },
          operationKey: crypto.randomUUID(),
          action: "resume",
        }),
      ),
    );
    expect((await deliveries(f)).generic).toBe(baseline.generic + 1);
    expect(await peekSessionWork(client.db, f.workspaceId, f.sessionId)).toMatchObject({
      kind: "capacity-wait",
      ref: { waiterId: f.armed.waiter.waiterId, wakeRevision: revision + 1 },
    });
  }, 180_000);

  test("a Steer that auto-resumes a paused branch wakes the descendants its Pause released", async () => {
    const f = await fixture([]);
    const parent = await adoptParent(f);
    await control(f, "pause", parent.id);
    // The paused child's workflow closed and every earlier wake was delivered.
    await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where session_id = ${f.sessionId}::uuid`;
    const baseline = await deliveries(f);
    expect((await peekSessionWork(client.db, f.workspaceId, f.sessionId)).kind).toBe("idle");

    await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: parent.id,
        subjectId: f.subjectId,
        actor: { type: "human", subjectId: f.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "steer",
        text: "carry on",
        resources: [],
        model: "codex/gpt-5.5",
        reasoningEffort: "medium",
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );

    const [wakeRow] = await shared.admin`select reason, wake_revision > delivered_revision as due
      from session_workflow_wake_outbox where session_id = ${f.sessionId}::uuid`;
    expect(wakeRow).toMatchObject({ reason: "session_auto_resume", due: true });
    expect((await deliveries(f)).generic).toBe(baseline.generic + 1);
    // Pause released the child's wait, so the resumed child runs its turn now.
    expect((await peekSessionWork(client.db, f.workspaceId, f.sessionId)).kind).toBe("runnable");
  }, 180_000);

  test("candidate containment uses the GIN index and migration bounds malformed arrays", async () => {
    const f = await fixture(["claude"]);
    const plan = await shared.admin.begin(async (tx) => {
      await tx`set local enable_seqscan=off`;
      return tx`explain (format json) select session_id from subscription_capacity_waiters
        where candidate_providers @> array['claude']::text[]`;
    });
    expect(JSON.stringify(plan)).toContain("subscription_capacity_waiters_candidates_idx");
    await expect(
      (async () => {
        await shared.admin`update subscription_capacity_waiters set candidate_providers=array_fill('claude'::text,array[33])
      where session_id=${f.sessionId}::uuid`;
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await shared.admin`update subscription_capacity_waiters set candidate_providers=array[null]::text[]
      where session_id=${f.sessionId}::uuid`;
      })(),
    ).rejects.toThrow();
  }, 180_000);
});
