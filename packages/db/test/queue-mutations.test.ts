import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, inArray } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  deleteSessionQueueItemInTransaction,
  editQueuedTurnInTransaction,
  evaluateSessionControl,
  getSessionQueueSnapshot,
  markSessionAttemptQuiesced,
  moveQueuedTurnInTransaction,
  mutateSessionControlInTransaction,
  peekSessionWork,
  QueueCommandConflictError,
  SessionCommandIdempotencyError,
  SessionControlConflictError,
  settleSessionAttemptInterruptions,
  steerQueuedTurnInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("queue-mutations");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(count = 3) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Queue commands",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Queue commands",
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
  const turns = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
    const rows = await db
      .insert(schema.sessionTurns)
      .values(
        Array.from({ length: count }, (_, index) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `session-${session.id}`,
          status: "queued",
          source: "user",
          position: index + 1,
          prompt: `prompt ${index + 1}`,
          resources: index === 1 ? [{ kind: "file" as const, id: crypto.randomUUID() }] : [],
          tools: [],
          model: `model-${index + 1}`,
          reasoningEffort: index === 1 ? "high" : "low",
          sandboxBackend: "none",
          metadata: {},
        })),
      )
      .returning();
    await db
      .update(schema.sessions)
      .set({ queueVersion: 1, queueHeadPosition: 0, queueTailPosition: count, status: "queued" })
      .where(eq(schema.sessions.id, session.id));
    return rows;
  });
  const actor = { type: "human" as const, subjectId: grant.subjectId };
  return { grant, session, turns, actor };
}

async function storedOrder(workspaceId: string, sessionId: string) {
  return await withWorkspaceRls(client.db, workspaceId, (db) =>
    db
      .select({ id: schema.sessionTurns.id, position: schema.sessionTurns.position })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.status, "queued"),
        ),
      )
      .orderBy(asc(schema.sessionTurns.position)),
  );
}

async function storedEvents(workspaceId: string, eventIds: string[]) {
  return await withWorkspaceRls(client.db, workspaceId, (db) =>
    db
      .select({
        id: schema.sessionEvents.id,
        type: schema.sessionEvents.type,
        payload: schema.sessionEvents.payload,
      })
      .from(schema.sessionEvents)
      .where(inArray(schema.sessionEvents.id, eventIds)),
  );
}

describe("canonical queue commands", () => {
  test("Move rewrites one authoritative order and an exact retry replays", async () => {
    const value = await fixture();
    const operationKey = crypto.randomUUID();
    const command = {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      turnId: value.turns[2]!.id,
      beforeTurnId: value.turns[0]!.id,
      expectedQueueVersion: 1,
      actor: value.actor,
      operationKey,
    };
    const moved = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db.transaction((tx) => moveQueuedTurnInTransaction(tx as typeof db, command)),
    );
    expect(moved.queueVersion).toBe(2);
    expect(moved.eventIds).toHaveLength(1);
    expect(await storedEvents(value.grant.workspaceId!, moved.eventIds)).toEqual([
      expect.objectContaining({
        type: "session.queue.changed",
        payload: expect.objectContaining({ operation: "move", queueVersion: 2 }),
      }),
    ]);
    expect(moved.items.map((turn) => turn.id)).toEqual([
      value.turns[2]!.id,
      value.turns[0]!.id,
      value.turns[1]!.id,
    ]);
    expect(await storedOrder(value.grant.workspaceId!, value.session.id)).toEqual([
      { id: value.turns[2]!.id, position: 1 },
      { id: value.turns[0]!.id, position: 2 },
      { id: value.turns[1]!.id, position: 3 },
    ]);

    const replay = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db.transaction((tx) => moveQueuedTurnInTransaction(tx as typeof db, command)),
    );
    expect(replay.replay).toBe(true);
    expect(replay.eventIds).toEqual([]);
    expect(replay.receipt.id).toBe(moved.receipt.id);
    await expect(
      withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        db.transaction((tx) =>
          moveQueuedTurnInTransaction(tx as typeof db, {
            ...command,
            beforeTurnId: null,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
  });

  test("Delete fences only the target prompt version", async () => {
    const value = await fixture();
    await withWorkspaceRls(client.db, value.grant.workspaceId!, async (db) => {
      await db
        .update(schema.sessions)
        .set({ queueVersion: 9 })
        .where(eq(schema.sessions.id, value.session.id));
    });
    const deleted = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        deleteSessionQueueItemInTransaction(tx as typeof db, {
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.session.id,
          turnId: value.turns[1]!.id,
          expectedTurnVersion: value.turns[1]!.version,
          actor: value.actor,
          operationKey: crypto.randomUUID(),
        }),
      ),
    );
    expect(deleted.queueVersion).toBe(10);
    expect(deleted.eventIds).toHaveLength(1);
    expect(await storedEvents(value.grant.workspaceId!, deleted.eventIds)).toEqual([
      expect.objectContaining({
        type: "session.queue.changed",
        payload: expect.objectContaining({ operation: "delete", queueVersion: 10 }),
      }),
    ]);
    expect(deleted.items.map((turn) => turn.id)).toEqual([value.turns[0]!.id, value.turns[2]!.id]);
  });

  test("Edit checks one prompt out into a complete private draft atomically", async () => {
    const value = await fixture();
    const edited = await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          editQueuedTurnInTransaction(tx as typeof db, {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId!,
            sessionId: value.session.id,
            turnId: value.turns[1]!.id,
            subjectId: value.grant.subjectId,
            expectedTurnVersion: value.turns[1]!.version,
            expectedDraftRevision: 0,
            replaceDraft: false,
            actor: value.actor,
            operationKey: crypto.randomUUID(),
          }),
        ),
    );
    expect(edited.draft).toMatchObject({
      revision: 1,
      text: "prompt 2",
      resources: value.turns[1]!.resources,
      tools: value.turns[1]!.tools,
      model: "model-2",
      reasoningEffort: "high",
      sourceTurnId: value.turns[1]!.id,
      sourceTurnVersion: value.turns[1]!.version,
    });
    expect(edited.eventIds).toHaveLength(1);
    expect(await storedEvents(value.grant.workspaceId!, edited.eventIds)).toEqual([
      expect.objectContaining({
        type: "session.queue.changed",
        payload: expect.objectContaining({ operation: "edit", queueVersion: 2, draftRevision: 1 }),
      }),
    ]);
    const [withdrawn] = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db
        .select({ status: schema.sessionTurns.status, reason: schema.sessionTurns.cancelReason })
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, value.turns[1]!.id)),
    );
    expect(withdrawn).toEqual({ status: "withdrawn_for_edit", reason: "withdrawn_for_edit" });
  });

  test("Edit never overwrites a dirty draft without exact replacement consent", async () => {
    const value = await fixture();
    await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db.insert(schema.composerDrafts).values({
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.session.id,
          subjectId: value.grant.subjectId,
          revision: 4,
          text: "do not lose me",
          resources: [],
          tools: [],
          model: "model-draft",
          reasoningEffort: "low",
        }),
    );
    await expect(
      withWorkspaceSubjectRls(client.db, value.grant.workspaceId!, value.grant.subjectId, (db) =>
        db.transaction((tx) =>
          editQueuedTurnInTransaction(tx as typeof db, {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId!,
            sessionId: value.session.id,
            turnId: value.turns[0]!.id,
            subjectId: value.grant.subjectId,
            expectedTurnVersion: value.turns[0]!.version,
            expectedDraftRevision: 4,
            replaceDraft: false,
            actor: value.actor,
            operationKey: crypto.randomUUID(),
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "DRAFT_NOT_EMPTY",
    } satisfies Partial<QueueCommandConflictError>);
  });

  test("row Steer preserves the prompt identity and blocks replacement claim behind a live owner", async () => {
    const value = await fixture();
    const attemptId = crypto.randomUUID();
    const runningTurn = await withWorkspaceRls(client.db, value.grant.workspaceId!, async (db) => {
      const [turn] = await db
        .insert(schema.sessionTurns)
        .values({
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.session.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `session-${value.session.id}`,
          status: "running",
          source: "user",
          position: 99,
          prompt: "current direction",
          resources: [],
          tools: [],
          model: "scripted-model",
          reasoningEffort: "low",
          sandboxBackend: "none",
          executionGeneration: 1,
          activeAttemptId: attemptId,
        })
        .returning();
      await db.insert(schema.sessionTurnAttempts).values({
        id: attemptId,
        accountId: value.grant.accountId,
        workspaceId: value.grant.workspaceId!,
        sessionId: value.session.id,
        turnId: turn!.id,
        executionGeneration: 1,
        state: "running",
        temporalWorkflowId: `session-${value.session.id}`,
        temporalWorkflowRunId: `run-${attemptId}`,
        temporalActivityId: `activity-${attemptId}`,
        verifiedControlRevision: 0,
        mcpApprovalPolicies: {},
      });
      await db
        .update(schema.sessions)
        .set({ activeTurnId: turn!.id, status: "running" })
        .where(eq(schema.sessions.id, value.session.id));
      return turn!;
    });

    const target = value.turns[2]!;
    const steered = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        steerQueuedTurnInTransaction(tx as typeof db, {
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.session.id,
          turnId: target.id,
          expectedTurnVersion: target.version,
          actor: value.actor,
          operationKey: crypto.randomUUID(),
        }),
      ),
    );
    expect(steered.items[0]).toMatchObject({
      id: target.id,
      triggerEventId: target.triggerEventId,
      prompt: target.prompt,
      version: target.version + 1,
      metadata: {
        delivery: "steer",
        replacedTurnId: runningTurn.id,
        replacedAttemptId: attemptId,
        interruptionCount: 1,
      },
    });
    expect(steered.interruptionCount).toBe(1);
    expect(steered.eventIds.length).toBeGreaterThan(0);
    const validSteerMetadata = steered.items[0]!.metadata;
    const setTargetMetadata = async (metadata: Record<string, unknown>) => {
      await withWorkspaceRls(client.db, value.grant.workspaceId!, async (db) => {
        await db
          .update(schema.sessionTurns)
          .set({ metadata })
          .where(eq(schema.sessionTurns.id, target.id));
      });
    };
    await setTargetMetadata({
      ...validSteerMetadata,
      replacedAttemptId: crypto.randomUUID(),
    });
    expect(
      await getSessionQueueSnapshot(client.db, value.grant.workspaceId!, value.session.id),
    ).toMatchObject({ stoppingPreviousAttempt: true });
    await setTargetMetadata({
      ...validSteerMetadata,
      interruptionCount: 0,
    });
    expect(
      await getSessionQueueSnapshot(client.db, value.grant.workspaceId!, value.session.id),
    ).toMatchObject({ stoppingPreviousAttempt: true });
    await setTargetMetadata(validSteerMetadata);
    const [superseded, interruption, session] = await withWorkspaceRls(
      client.db,
      value.grant.workspaceId!,
      async (db) => {
        const [turn] = await db
          .select()
          .from(schema.sessionTurns)
          .where(eq(schema.sessionTurns.id, runningTurn.id));
        const [request] = await db
          .select()
          .from(schema.sessionAttemptInterruptions)
          .where(eq(schema.sessionAttemptInterruptions.attemptId, attemptId));
        const [sessionRow] = await db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.id, value.session.id));
        return [turn!, request!, sessionRow!] as const;
      },
    );
    expect(superseded).toMatchObject({
      status: "running",
      activeAttemptId: attemptId,
      cancelReason: null,
    });
    expect(interruption).toMatchObject({ kind: "steer", state: "pending", attemptId });
    expect(session).toMatchObject({ activeTurnId: runningTurn.id, status: "running" });

    const replacementClaim = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId!, {
      sessionId: value.session.id,
      workflowId: `session-${value.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(replacementClaim).toEqual({ action: "unclaimed", reason: "control-pending" });
    const lateCompletion = await applySessionTurnSettlement(client.db, value.grant.workspaceId!, {
      sessionId: value.session.id,
      turnId: runningTurn.id,
      triggerEventId: runningTurn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { mustNotPublish: true } }],
    });
    expect(lateCompletion).toMatchObject({ action: "stale", events: [] });

    const settled = await settleSessionAttemptInterruptions(
      client.db,
      value.grant.workspaceId!,
      value.session.id,
      attemptId,
    );
    expect(settled).toMatchObject({
      action: "continue",
      attemptId,
      turnId: runningTurn.id,
      outcome: "superseded",
    });
    expect(settled.events.map((event) => event.type)).toEqual([
      "turn.superseded",
      "session.status.changed",
    ]);
    expect(await peekSessionWork(client.db, value.grant.workspaceId!, value.session.id)).toEqual({
      kind: "cancellation-wait",
      attemptId,
    });
    const claimBeforeQuiescence = await claimSessionWorkForAttempt(
      client.db,
      value.grant.workspaceId!,
      {
        sessionId: value.session.id,
        workflowId: `session-${value.session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      },
    );
    expect(claimBeforeQuiescence).toEqual({ action: "unclaimed", reason: "control-pending" });
    // The physical fence belongs to the session, not the replacement row. A
    // delete/reorder race must not let the next ordinary prompt start while the
    // predecessor activity is still stopping.
    await withWorkspaceRls(client.db, value.grant.workspaceId!, async (db) => {
      await db
        .update(schema.sessionTurns)
        .set({ status: "withdrawn_for_edit" })
        .where(eq(schema.sessionTurns.id, target.id));
    });
    expect(
      await getSessionQueueSnapshot(client.db, value.grant.workspaceId!, value.session.id),
    ).toMatchObject({ stoppingPreviousAttempt: true });
    const claimAfterReplacementRemoval = await claimSessionWorkForAttempt(
      client.db,
      value.grant.workspaceId!,
      {
        sessionId: value.session.id,
        workflowId: `session-${value.session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      },
    );
    expect(claimAfterReplacementRemoval).toEqual({
      action: "unclaimed",
      reason: "control-pending",
    });
    await withWorkspaceRls(client.db, value.grant.workspaceId!, async (db) => {
      await db
        .update(schema.sessionTurns)
        .set({ status: "queued" })
        .where(eq(schema.sessionTurns.id, target.id));
    });
    const wakeBeforeQuiescence = await withWorkspaceRls(
      client.db,
      value.grant.workspaceId!,
      async (db) => {
        const [row] = await db
          .select({ wakeRevision: schema.sessionWorkflowWakeOutbox.wakeRevision })
          .from(schema.sessionWorkflowWakeOutbox)
          .where(eq(schema.sessionWorkflowWakeOutbox.sessionId, value.session.id));
        return row?.wakeRevision ?? 0;
      },
    );
    const [quiescenceEvents, concurrentReplay] = await Promise.all([
      markSessionAttemptQuiesced(client.db, {
        workspaceId: value.grant.workspaceId!,
        sessionId: value.session.id,
        attemptId,
        temporalWorkflowId: `session-${value.session.id}`,
      }),
      markSessionAttemptQuiesced(client.db, {
        workspaceId: value.grant.workspaceId!,
        sessionId: value.session.id,
        attemptId,
        temporalWorkflowId: `session-${value.session.id}`,
      }),
    ]);
    expect(concurrentReplay).toEqual(quiescenceEvents);
    const wakeAfterQuiescence = await withWorkspaceRls(
      client.db,
      value.grant.workspaceId!,
      async (db) => {
        const [row] = await db
          .select({ wakeRevision: schema.sessionWorkflowWakeOutbox.wakeRevision })
          .from(schema.sessionWorkflowWakeOutbox)
          .where(eq(schema.sessionWorkflowWakeOutbox.sessionId, value.session.id));
        return row?.wakeRevision ?? 0;
      },
    );
    expect(wakeAfterQuiescence).toBe(wakeBeforeQuiescence + 1);
    expect(
      await markSessionAttemptQuiesced(client.db, {
        workspaceId: value.grant.workspaceId!,
        sessionId: value.session.id,
        attemptId,
        temporalWorkflowId: `session-${value.session.id}`,
      }),
    ).toEqual(quiescenceEvents);
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, async (db) => {
        const [row] = await db
          .select({ wakeRevision: schema.sessionWorkflowWakeOutbox.wakeRevision })
          .from(schema.sessionWorkflowWakeOutbox)
          .where(eq(schema.sessionWorkflowWakeOutbox.sessionId, value.session.id));
        return row?.wakeRevision ?? 0;
      }),
    ).toBe(wakeAfterQuiescence);
    const nextAttemptId = crypto.randomUUID();
    const claimAfterSettlement = await claimSessionWorkForAttempt(
      client.db,
      value.grant.workspaceId!,
      {
        sessionId: value.session.id,
        workflowId: `session-${value.session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: nextAttemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      },
    );
    expect(claimAfterSettlement).toMatchObject({
      action: "claimed",
      turn: { id: target.id, triggerEventId: target.triggerEventId },
    });
    const [closedAttempt, settledInterruption] = await withWorkspaceRls(
      client.db,
      value.grant.workspaceId!,
      async (db) => {
        const [attempt] = await db
          .select()
          .from(schema.sessionTurnAttempts)
          .where(eq(schema.sessionTurnAttempts.id, attemptId));
        const [request] = await db
          .select()
          .from(schema.sessionAttemptInterruptions)
          .where(eq(schema.sessionAttemptInterruptions.attemptId, attemptId));
        return [attempt!, request!] as const;
      },
    );
    expect(closedAttempt).toMatchObject({ state: "closed", outcome: "superseded" });
    expect(settledInterruption).toMatchObject({ state: "settled" });
  });

  test("Send atomically resumes a paused branch, submits the exact draft, and replays", async () => {
    const value = await fixture();
    const paused = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.session.id,
          actor: value.actor,
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db.insert(schema.composerDrafts).values({
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.session.id,
          subjectId: value.grant.subjectId,
          revision: 1,
          text: "resume from draft",
          resources: [],
          tools: [],
          model: "scripted-model",
          reasoningEffort: "low",
        }),
    );
    const operationKey = crypto.randomUUID();
    const command = {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId!,
      sessionId: value.session.id,
      subjectId: value.grant.subjectId,
      actor: value.actor,
      operationKey,
      delivery: "send" as const,
      controlEtag: paused.control.controlEtag,
      expectedDraftRevision: 1,
      text: "resume from draft",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low" as const,
      reasoningEffortFallback: "medium" as const,
      source: "user" as const,
    };
    const submitted = await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) => db.transaction((tx) => submitHumanPromptInTransaction(tx as typeof db, command)),
    );
    expect(submitted.replay).toBe(false);
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.session.id),
      ),
    ).toMatchObject({ state: "active" });
    const drafts = await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db
          .select()
          .from(schema.composerDrafts)
          .where(eq(schema.composerDrafts.sessionId, value.session.id)),
    );
    expect(drafts).toHaveLength(0);
    expect((await storedOrder(value.grant.workspaceId!, value.session.id)).at(-1)?.id).toBe(
      submitted.turnId,
    );
    const replay = await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) => db.transaction((tx) => submitHumanPromptInTransaction(tx as typeof db, command)),
    );
    expect(replay).toMatchObject({ replay: true, turnId: submitted.turnId });
  });

  test("an observing Send loses to an unseen newer Pause without consuming the draft", async () => {
    const value = await fixture();
    const observed = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      evaluateSessionControl(db, value.grant.workspaceId!, value.session.id),
    );
    await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db.insert(schema.composerDrafts).values({
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.session.id,
          subjectId: value.grant.subjectId,
          revision: 1,
          text: "preserve me",
          resources: [],
          tools: [],
          model: "scripted-model",
          reasoningEffort: "low",
        }),
    );
    await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.session.id,
          actor: value.actor,
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    await expect(
      withWorkspaceSubjectRls(client.db, value.grant.workspaceId!, value.grant.subjectId, (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as typeof db, {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId!,
            sessionId: value.session.id,
            subjectId: value.grant.subjectId,
            actor: value.actor,
            operationKey: crypto.randomUUID(),
            delivery: "send",
            controlEtag: observed.controlEtag,
            expectedDraftRevision: 1,
            text: "preserve me",
            resources: [],
            tools: [],
            model: "scripted-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(SessionControlConflictError);
    const [draft] = await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db
          .select()
          .from(schema.composerDrafts)
          .where(eq(schema.composerDrafts.sessionId, value.session.id)),
    );
    expect(draft).toMatchObject({ revision: 1, text: "preserve me" });
  });
});
