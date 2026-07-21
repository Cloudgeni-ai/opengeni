import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { readTurnExecutionPolicyV1, TurnExecutionPolicyV1 } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimPendingSessionWorkflowWakes,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionWorkflowWake,
  getSessionTurn,
  initializeSessionStartAtomically,
  listSessionEvents,
  listSessionTurns,
  markSessionWorkflowWakeDelivered,
  markSessionWorkflowWakeFailed,
  markSessionAttemptQuiesced,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  requestSessionTurnRecovery,
  settleSessionAttemptInterruptions,
  setSessionGoalStatus,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-workflow-wake-outbox");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "wake-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Wake outbox test",
    workspaceExternalSource: "wake-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Wake outbox test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  return { grant, session };
}

type WakeFixture = Awaited<ReturnType<typeof fixture>>;

async function send(
  wakeFixture: WakeFixture,
  text: string,
  delivery: "send" | "steer" = "send",
  clientEventId = crypto.randomUUID(),
) {
  return await withWorkspaceSubjectRls(
    client.db,
    wakeFixture.grant.workspaceId!,
    wakeFixture.grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: wakeFixture.grant.accountId,
          workspaceId: wakeFixture.grant.workspaceId!,
          sessionId: wakeFixture.session.id,
          subjectId: wakeFixture.grant.subjectId,
          actor: { type: "human", subjectId: wakeFixture.grant.subjectId },
          operationKey: clientEventId,
          delivery,
          text,
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
}

async function pauseWorkspace(ctx: WakeFixture) {
  return await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
    db.transaction((tx) =>
      mutateWorkspaceControlInTransaction(tx as typeof db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId!,
        actor: { type: "human", subjectId: ctx.grant.subjectId },
        operationKey: crypto.randomUUID(),
        action: "pause",
        reason: "test",
      }),
    ),
  );
}

async function wakeRow(workspaceId: string, sessionId: string) {
  return await withWorkspaceRls(client.db, workspaceId, async (db) => {
    const [row] = await db
      .select()
      .from(schema.sessionWorkflowWakeOutbox)
      .where(
        and(
          eq(schema.sessionWorkflowWakeOutbox.workspaceId, workspaceId),
          eq(schema.sessionWorkflowWakeOutbox.sessionId, sessionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

describe("transactional session workflow wake outbox", () => {
  test("initial session state, first turn, and wake commit once under concurrent retries", async () => {
    const ctx = await fixture();
    const turnExecutionPolicy = TurnExecutionPolicyV1.parse({
      schemaVersion: 1,
      productModelId: "scripted-model",
      requestedModelId: null,
      modelSource: "deployment",
      reasoningEffort: "low",
      reasoningSource: "deployment",
      providerId: "scripted-provider",
      upstreamModelId: "scripted-upstream",
      wireApi: "responses",
      credentialSource: { kind: "deployment", mechanism: "api_key" },
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
      definitionVersion: `sha256:${"a".repeat(64)}`,
    });
    const initialize = () =>
      initializeSessionStartAtomically(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId!,
        sessionId: ctx.session.id,
        clientEventId: `initial:${ctx.session.id}`,
        reasoningEffortFallback: "low",
        turnExecutionPolicy,
        createdEventPayload: {},
        goal: { text: "Finish exactly once" },
      });
    const results = await Promise.all([initialize(), initialize()]);
    expect(results.map((result) => result.turn?.id).filter(Boolean)).toEqual([
      results[0]!.turn!.id,
      results[0]!.turn!.id,
    ]);
    expect(results.flatMap((result) => result.events)).toHaveLength(5);
    expect(results.map((result) => result.workflowWakeRevision).sort()).toEqual([1, 2]);
    // Both concurrent callers own a committed wake revision, so neither may
    // describe itself as a mutation-free replay.
    expect(results.map((result) => result.changed).sort()).toEqual([true, true]);

    const events = await listSessionEvents(
      client.db,
      ctx.grant.workspaceId!,
      ctx.session.id,
      0,
      20,
    );
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "goal.set",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    expect(await listSessionTurns(client.db, ctx.grant.workspaceId!, ctx.session.id)).toHaveLength(
      1,
    );
    expect(readTurnExecutionPolicyV1(results[0]!.turn!.metadata)).toEqual({
      kind: "valid",
      policy: turnExecutionPolicy,
    });
    expect(readTurnExecutionPolicyV1(results[1]!.turn!.metadata)).toEqual({
      kind: "valid",
      policy: turnExecutionPolicy,
    });
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 0,
    });
  });

  test("initial session remains durably queued without a wake while its workspace is paused", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "wake-test",
      accountExternalId: `paused-account-${suffix}`,
      accountName: "Paused wake outbox test",
      workspaceExternalSource: "wake-test",
      workspaceExternalId: `paused-workspace-${suffix}`,
      workspaceName: "Paused wake outbox test",
      subjectId: `paused-subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `pause:${suffix}`,
          action: "pause",
          reason: "test",
        }),
      ),
    );
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "wait until resumed",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });

    const result = await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });

    expect(result.workflowWakeRevision).toBeNull();
    expect(result.turn?.status).toBe("queued");
    expect(result.events.find((event) => event.type === "session.created")?.payload).toMatchObject({
      status: "queued",
    });
    expect(
      result.events.find((event) => event.type === "session.status.changed")?.payload,
    ).toMatchObject({ status: "queued" });
    expect(await wakeRow(grant.workspaceId!, session.id)).toBeNull();
  });

  test("resuming a goal behind a closed workspace gate remains durable and does not manufacture a wake", async () => {
    const ctx = await fixture();
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: { text: "Resume only when admitted" },
    });
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: started.temporalWorkflowId,
      wakeRevision: started.workflowWakeRevision!,
    });
    await setSessionGoalStatus(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "paused",
      rationale: "test hold",
    });
    await pauseWorkspace(ctx);
    const afterPause = await wakeRow(ctx.grant.workspaceId!, ctx.session.id);

    const resumed = await setSessionGoalStatus(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "active",
    });

    expect(resumed.changed).toBe(true);
    expect(resumed.workflowWakeRevision).toBeNull();
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: afterPause!.wakeRevision,
      deliveredRevision: afterPause!.deliveredRevision,
    });
  });

  test("initial session advances an already-delivered wake before committing its first turn", async () => {
    const ctx = await fixture();
    const deliveredRevision = await enqueueSessionWorkflowWake(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      reason: "preexisting",
    });
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: deliveredRevision,
    });

    const result = await initializeSessionStartAtomically(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });

    expect(result.workflowWakeRevision).toBe(deliveredRevision + 1);
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: deliveredRevision + 1,
      deliveredRevision,
    });
  });

  test("initial session advances a pending wake so a stale acknowledgement cannot hide its first turn", async () => {
    const ctx = await fixture();
    const pendingRevision = await enqueueSessionWorkflowWake(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      reason: "preexisting",
    });

    const result = await initializeSessionStartAtomically(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: pendingRevision,
    });

    expect(result.workflowWakeRevision).toBe(pendingRevision + 1);
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: pendingRevision + 1,
      deliveredRevision: pendingRevision,
    });
  });

  test("coalesces revisions and stale acknowledgements cannot hide newer work", async () => {
    const ctx = await fixture();
    const first = await send(ctx, "first");
    const second = await send(ctx, "second");

    expect(first.wakeRevision).toBe(1);
    expect(second.wakeRevision).toBe(2);
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 0,
      attempts: 0,
    });

    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: first.wakeRevision,
    });
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 1,
    });

    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: second.wakeRevision,
    });
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 2,
      attempts: 0,
    });
  });

  test("a stale acknowledgement cannot clear retry state owned by a newer revision", async () => {
    const ctx = await fixture();
    const first = await send(ctx, "first");
    const second = await send(ctx, "second");
    const claimed = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(claimed?.wakeRevision).toBe(second.wakeRevision);
    await markSessionWorkflowWakeFailed(client.db, claimed!, "newer delivery failed");

    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: first.wakeRevision,
    });

    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: second.wakeRevision,
      deliveredRevision: first.wakeRevision,
      attempts: 1,
      lastError: "newer delivery failed",
    });
  });

  test("a late duplicate failure cannot poison an already-delivered revision", async () => {
    const ctx = await fixture();
    const queued = await send(ctx, "deliver once");
    const claimed = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(claimed?.wakeRevision).toBe(queued.wakeRevision);

    await markSessionWorkflowWakeDelivered(client.db, claimed!);
    expect(await markSessionWorkflowWakeFailed(client.db, claimed!, "late duplicate failure")).toBe(
      false,
    );
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: queued.wakeRevision,
      deliveredRevision: queued.wakeRevision,
      attempts: 0,
      lastError: null,
    });
  });

  test("concurrent producers serialize into distinct monotonically increasing revisions", async () => {
    const ctx = await fixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => send(ctx, `prompt-${index}`)),
    );
    expect(
      results.map((result) => result.wakeRevision).sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 12,
      deliveredRevision: 0,
    });
  });

  test("claim is bounded by due time and records failure without losing the revision", async () => {
    const ctx = await fixture();
    const result = await send(ctx, "repair me");
    const claimed = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(claimed).toMatchObject({
      wakeRevision: result.wakeRevision,
      interruptionRequested: false,
    });
    expect(
      (await claimPendingSessionWorkflowWakes(client.db, 1000)).some(
        (entry) => entry.sessionId === ctx.session.id,
      ),
    ).toBe(false);
    await markSessionWorkflowWakeFailed(client.db, claimed!, "temporal unavailable");
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 1,
      deliveredRevision: 0,
      attempts: 1,
      lastError: "temporal unavailable",
    });
  });

  test("repair claims derive cancellation from the durable interruption ledger", async () => {
    const ctx = await fixture();
    const queued = await send(ctx, "run");
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: queued.wakeRevision,
    });
    const attemptId = crypto.randomUUID();
    await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    const paused = await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    expect(paused.interruptionCount).toBe(1);
    const claimed = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(claimed).toMatchObject({
      interruptionRequested: true,
    });
  });

  test("fully quiesced historical interruptions do not upgrade ordinary wakes to control", async () => {
    const ctx = await fixture();
    const queued = await send(ctx, "run");
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: queued.wakeRevision,
    });
    const attemptId = crypto.randomUUID();
    const workflowRunId = crypto.randomUUID();
    const activityId = crypto.randomUUID();
    await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId,
      attemptId,
      dispatchId: activityId,
      trigger: { kind: "next" },
    });
    const paused = await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    expect(paused.interruptionCount).toBe(1);
    const pauseWake = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(pauseWake).toMatchObject({ interruptionRequested: true });
    await markSessionWorkflowWakeDelivered(client.db, pauseWake!);
    expect(
      await settleSessionAttemptInterruptions(
        client.db,
        ctx.grant.workspaceId!,
        ctx.session.id,
        attemptId,
      ),
    ).toMatchObject({ action: "paused" });
    const settlementWake = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(settlementWake).toMatchObject({ interruptionRequested: true });
    await markSessionWorkflowWakeDelivered(client.db, settlementWake!);
    const quiescenceEvents = await markSessionAttemptQuiesced(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      attemptId,
      temporalWorkflowId: `session-${ctx.session.id}`,
      temporalWorkflowRunId: workflowRunId,
      temporalActivityId: activityId,
    });
    expect(quiescenceEvents).toHaveLength(1);
    await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "resume",
        }),
      ),
    );

    const [attempt] = await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
      db
        .select({ quiescedAt: schema.sessionTurnAttempts.quiescedAt })
        .from(schema.sessionTurnAttempts)
        .where(eq(schema.sessionTurnAttempts.id, attemptId)),
    );
    expect(attempt?.quiescedAt).not.toBeNull();
    const resumeWake = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(resumeWake).toMatchObject({ interruptionRequested: true });
    await markSessionWorkflowWakeDelivered(client.db, resumeWake!);
    const ordinary = await send(ctx, "ordinary follow-up");

    expect(
      (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
        (entry) => entry.sessionId === ctx.session.id,
      ),
    ).toMatchObject({
      wakeRevision: ordinary.wakeRevision,
      interruptionRequested: false,
    });
  });

  test("an ownerless Steer keeps control priority when a later Send coalesces", async () => {
    const ctx = await fixture();
    const queued = await send(ctx, "run");
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: queued.wakeRevision,
    });
    const attemptId = crypto.randomUUID();
    const predecessor = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(predecessor.action).toBe("claimed");
    if (predecessor.action !== "claimed") throw new Error("predecessor was not claimed");
    expect(
      await requestSessionTurnRecovery(client.db, ctx.grant.workspaceId!, {
        sessionId: ctx.session.id,
        turnId: predecessor.turn.id,
        triggerEventId: predecessor.turn.triggerEventId,
        attemptId,
        reason: "provider_unavailable",
        providerRecoveryCount: 1,
        detail: { continueDelayMs: 2_000 },
      }),
    ).toMatchObject({ action: "recovering" });
    expect(
      (await getSessionTurn(client.db, ctx.grant.workspaceId!, predecessor.turn.id))?.metadata,
    ).toMatchObject({ providerRecoveryCount: 1 });

    const steered = await send(ctx, "change direction", "steer");
    expect(steered.interruptionCount).toBe(0);
    const laterSend = await send(ctx, "also remember this");
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: laterSend.wakeRevision,
      controlRevision: steered.wakeRevision,
    });
    const claimed = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(claimed).toMatchObject({
      wakeRevision: laterSend.wakeRevision,
      interruptionRequested: true,
    });

    await markSessionWorkflowWakeDelivered(client.db, claimed!);
    const ordinary = await send(ctx, "ordinary follow-up");
    const ordinaryClaim = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(ordinaryClaim).toMatchObject({
      wakeRevision: ordinary.wakeRevision,
      interruptionRequested: false,
    });
  });

  test("the rolling trigger preserves control priority for old writers", async () => {
    const ctx = await fixture();
    await withWorkspaceRls(client.db, ctx.grant.workspaceId!, async (db) => {
      await db.execute(sql`
        insert into ${schema.sessionWorkflowWakeOutbox} (
          session_id, account_id, workspace_id, temporal_workflow_id, reason
        ) values (
          ${ctx.session.id}, ${ctx.grant.accountId}, ${ctx.grant.workspaceId!},
          ${`session-${ctx.session.id}`}, 'prompt_steer'
        )
        on conflict (session_id) do update set
          wake_revision = ${schema.sessionWorkflowWakeOutbox}.wake_revision + 1,
          reason = excluded.reason,
          updated_at = now()
      `);
      await db.execute(sql`
        insert into ${schema.sessionWorkflowWakeOutbox} (
          session_id, account_id, workspace_id, temporal_workflow_id, reason
        ) values (
          ${ctx.session.id}, ${ctx.grant.accountId}, ${ctx.grant.workspaceId!},
          ${`session-${ctx.session.id}`}, 'prompt_send'
        )
        on conflict (session_id) do update set
          wake_revision = ${schema.sessionWorkflowWakeOutbox}.wake_revision + 1,
          reason = excluded.reason,
          updated_at = now()
      `);
    });
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 0,
      controlRevision: 1,
      reason: "prompt_send",
    });
    expect(
      (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
        (entry) => entry.sessionId === ctx.session.id,
      ),
    ).toMatchObject({ interruptionRequested: true });
  });
});
