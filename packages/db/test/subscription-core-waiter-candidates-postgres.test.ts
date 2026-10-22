import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  await shared.admin`insert into subscription_provider_cutovers(account_id,provider,enabled)
    values (${accountId}::uuid,'codex',true),(${accountId}::uuid,'claude',true)
    on conflict(account_id,provider) do update set enabled=true`;
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

  test("a paused waiter records capacity changes but is delivered only through Resume", async () => {
    const f = await fixture([]);
    await wake(f, "codex");
    const active = await deliveries(f);
    expect(active.typed).toBe(1);

    await control(f, "pause");
    // The dispatcher has delivered everything recorded so far.
    await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where session_id=${f.sessionId}::uuid`;
    const pausedBaseline = await deliveries(f);
    await wake(f, "codex");
    await wake(f, "codex");
    // The capacity change is durable on the waiter, but no workflow run is
    // started merely to peek Pause and close.
    expect((await state(f)).wake_revision).toBe(4);
    expect(await deliveries(f)).toEqual(pausedBaseline);
    expect((await peekSessionWork(client.db, f.workspaceId, f.sessionId)).kind).toBe("idle");

    // Resume commits its own wake; the run it starts sees the unobserved
    // revision as an already-due waiter.
    await control(f, "resume");
    expect((await deliveries(f)).generic).toBeGreaterThan(pausedBaseline.generic);
    const resumed = await peekSessionWork(client.db, f.workspaceId, f.sessionId);
    expect(resumed).toMatchObject({
      kind: "capacity-wait",
      ref: { waiterId: f.armed.waiter.waiterId, wakeRevision: 4 },
    });
    expect(resumed.kind === "capacity-wait" && Date.parse(resumed.ref.nextCheckAt)).toBe(0);
    const resumedBaseline = await deliveries(f);
    await wake(f, "codex");
    expect(await deliveries(f)).toEqual({
      typed: resumedBaseline.typed + 1,
      generic: resumedBaseline.generic + 1,
    });
  }, 180_000);

  test("ancestor and workspace Pause defer delivery with the override algebra", async () => {
    const f = await fixture([]);
    const parent = await adoptParent(f);
    await control(f, "pause", parent.id);
    let baseline = await deliveries(f);
    await wake(f, "codex");
    expect(await deliveries(f)).toEqual(baseline);

    // A newer selected Resume on the child defeats the older ancestor Pause.
    await control(f, "resume");
    baseline = await deliveries(f);
    await wake(f, "codex");
    expect((await deliveries(f)).typed).toBe(baseline.typed + 1);

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
    baseline = await deliveries(f);
    const revision = (await state(f)).wake_revision;
    await wake(f, "codex");
    expect(await deliveries(f)).toEqual(baseline);
    expect((await state(f)).wake_revision).toBe(revision + 1);

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

  test("a Steer that auto-resumes a paused branch wakes its waiting descendants", async () => {
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
    expect(await peekSessionWork(client.db, f.workspaceId, f.sessionId)).toMatchObject({
      kind: "capacity-wait",
      ref: { waiterId: f.armed.waiter.waiterId },
    });
  }, 180_000);

  test("the rolling repair wakes unblocked waits resumed without a wake", async () => {
    const stranded = await fixture([]);
    const paused = await fixture([]);
    const pending = await fixture([]);
    await control(paused, "pause");
    const ids = [stranded.sessionId, paused.sessionId, pending.sessionId];
    // Every earlier wake was delivered and its workflow closed, as after a
    // Resume that registered no wake; `pending` still has one undelivered.
    await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where session_id = any(${ids}::uuid[])`;
    await wake(pending, "codex");
    const before = await Promise.all([stranded, paused, pending].map((f) => deliveries(f)));
    const forced = () => shared.admin`select relname::text, relforcerowsecurity from pg_class
      where oid in ('sessions'::regclass, 'session_turns'::regclass,
        'workspace_inference_controls'::regclass, 'codex_capacity_waiters'::regclass,
        'subscription_capacity_waiters'::regclass, 'session_workflow_wake_outbox'::regclass)
      order by relname`;
    const forcedBefore = await forced();

    const migration = await readFile(
      join(import.meta.dir, "../drizzle/0882_continuable_core_capacity_waits.sql"),
      "utf8",
    );
    await shared.admin.begin((tx) => tx.unsafe(migration));

    const after = await Promise.all([stranded, paused, pending].map((f) => deliveries(f)));
    expect(after[0]!.generic).toBe(before[0]!.generic + 1);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual(before[2]);
    const [wakeRow] = await shared.admin`select reason, wake_revision > delivered_revision as due
      from session_workflow_wake_outbox where session_id = ${stranded.sessionId}::uuid`;
    expect(wakeRow).toMatchObject({ reason: "capacity_wait_repair", due: true });
    expect(await forced()).toEqual(forcedBefore);
    expect(
      await peekSessionWork(client.db, stranded.workspaceId, stranded.sessionId),
    ).toMatchObject({ kind: "capacity-wait", ref: { waiterId: stranded.armed.waiter.waiterId } });
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
