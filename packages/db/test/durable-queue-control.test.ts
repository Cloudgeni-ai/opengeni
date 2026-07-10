import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import type { AccessGrant } from "@opengeni/contracts";
import {
  SYSTEM_UPDATE_INLINE_BYTE_LIMIT,
  SYSTEM_UPDATE_INLINE_ITEM_LIMIT,
  addSessionSystemUpdate,
  addSessionSystemUpdateWithSourceMutation,
  appendSessionEventsForTurnGeneration,
  appendSessionHistoryItems,
  applySessionControlInterrupt,
  bootstrapWorkspace,
  cancelQueuedSessionTurnWithVersion,
  claimNextQueuedTurn,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  enqueueSessionMessageAtomically,
  finishTurn,
  getSessionQueueSnapshot,
  getSessionHistoryItems,
  getSessionSystemUpdateBundlePage,
  getSessionTurn,
  listPendingSessionSystemWakeRepairs,
  listScheduledTaskRuns,
  listSessionEvents,
  promoteQueuedSessionTurn,
  requeueTurnAfterWorkerDeathAtomically,
  reorderQueuedSessionTurnsWithVersion,
  requestSessionControl,
  saveRunState,
  settleScheduledTaskRunInTransaction,
  setWorkspaceInferenceControl,
  stopSessionDescendants,
  sessionSystemUpdateConstituentBytes,
  setSessionStatus,
  setWorkspaceQueueRuntimeControl,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

type RequiredTestDatabase = SharedTestDatabase;

describe("durable queue and control transactions (real PostgreSQL)", () => {
  let shared: RequiredTestDatabase;
  let dbClient: ReturnType<typeof createDb>;

  beforeAll(async () => {
    shared = await acquireRequiredTestDatabase("durable-queue-control");
    dbClient = createDb(shared.appUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await shared?.release();
  }, 60_000);

  test("concurrent claimers start exactly one turn for a durable session", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "claim exactly once",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await cutOverDurableQueue(grant);

    for (const [index, text] of ["first", "second"].entries()) {
      await enqueueSessionMessageAtomically(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        actor: "test",
        origin: "human",
        text,
        resources: [],
        tools: [],
        clientEventId: `claim-message-${index}-${crypto.randomUUID()}`,
        delivery: "queue",
        reasoningEffortFallback: "low",
      });
    }

    const claims = await Promise.all([
      claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "claim-workflow-a"),
      claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "claim-workflow-b"),
    ]);
    const claimed = claims.filter((turn) => turn !== null);
    expect(claimed).toHaveLength(1);

    const queue = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    expect(queue?.items.filter((turn) => turn.status === "running")).toHaveLength(1);
    expect(queue?.items.filter((turn) => turn.status === "queued")).toHaveLength(1);
  });

  test("rolling cutover normalizes old producers, rejects old claims, and supports explicit rollback", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "rolling queue migration",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const legacyTurnId = crypto.randomUUID();
    const triggerEventId = crypto.randomUUID();
    const [normalized] = await shared.admin<
      Array<{ queue_kind: string; origin: string; priority: number }>
    >`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, resources, tools, model,
        reasoning_effort, sandbox_backend, metadata
      ) values (
        ${legacyTurnId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
        ${triggerEventId}, ${`session-${session.id}`}, 'queued', 'scheduled_task', 1,
        'legacy scheduled wake',
        '[]'::jsonb, '[]'::jsonb, 'scripted-model', 'low', 'none', '{}'::jsonb
      )
      returning queue_kind, origin, priority
    `;
    expect(normalized).toEqual({
      queue_kind: "scheduled_wake",
      origin: "system",
      priority: 200,
    });

    const cutover = await setWorkspaceQueueRuntimeControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: "test",
      state: "durable_v1",
      reason: "all compatible workers ready",
      clientEventId: `queue-cutover-rolling-${crypto.randomUUID()}`,
      expectedState: "legacy",
      expectedGeneration: 0,
    });
    let incompatibleClaimError: unknown;
    try {
      await shared.admin`
        update session_turns set status = 'running'
        where workspace_id = ${grant.workspaceId} and id = ${legacyTurnId}
      `;
    } catch (error) {
      incompatibleClaimError = error;
    }
    expect(incompatibleClaimError).toBeInstanceOf(Error);
    expect((incompatibleClaimError as Error).message).toContain(
      "durable queue claim requires a compatible worker",
    );

    const rollback = await setWorkspaceQueueRuntimeControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: "test",
      state: "legacy",
      reason: "roll back mixed worker fleet",
      clientEventId: `queue-rollback-rolling-${crypto.randomUUID()}`,
      expectedState: "durable_v1",
      expectedGeneration: cutover.generation,
    });
    expect(rollback).toMatchObject({ state: "legacy", generation: cutover.generation + 1 });
    const [legacyClaim] = await shared.admin<Array<{ status: string }>>`
      update session_turns set status = 'running'
      where workspace_id = ${grant.workspaceId} and id = ${legacyTurnId}
      returning status
    `;
    expect(legacyClaim?.status).toBe("running");
  });

  test("a successful reorder is the exact order returned and claimed", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "reorder exactly",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await cutOverDurableQueue(grant);
    const human = await enqueueMessage(grant, session.id, "human", "human");
    const operator = await enqueueMessage(grant, session.id, "operator", "operator");
    const before = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    expect(before?.items.map((turn) => turn.id)).toEqual([operator.turn.id, human.turn.id]);

    const requestedOrder = [human.turn.id, operator.turn.id];
    const reordered = await reorderQueuedSessionTurnsWithVersion(
      dbClient.db,
      grant.workspaceId,
      session.id,
      before!.version,
      requestedOrder,
      "test",
    );
    expect(reordered.snapshot.items.map((turn) => turn.id)).toEqual(requestedOrder);
    expect(reordered.events.map((event) => event.type)).toEqual(["session.queue.reordered"]);

    const claimed = await claimNextQueuedTurn(
      dbClient.db,
      grant.workspaceId,
      session.id,
      "reorder-workflow",
    );
    expect(claimed?.id).toBe(human.turn.id);
  });

  test("human intent outranks routine system work and stale queue OCC has exactly one winner", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createDurableSession(grant, "queue priority and OCC");
    const routine = await addSessionSystemUpdate(
      dbClient.db,
      systemUpdateInput(grant, session.id, {
        groupingKey: "routine-priority",
        sourceId: "routine-priority",
        dedupeKey: "routine-priority",
        summary: "Routine system maintenance",
        payload: {},
      }),
    );
    if (!("turn" in routine) || !routine.turn) throw new Error("Expected routine queue turn");
    const privatePrompt = `private-human-${crypto.randomUUID()}`;
    const human = await enqueueMessage(grant, session.id, privatePrompt, "human");
    const operator = await enqueueMessage(grant, session.id, "operator correction", "operator");
    const before = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    expect(before?.items.map((turn) => turn.id)).toEqual([
      operator.turn.id,
      human.turn.id,
      routine.turn.id,
    ]);
    await expect(
      reorderQueuedSessionTurnsWithVersion(
        dbClient.db,
        grant.workspaceId,
        session.id,
        before!.version,
        [routine.turn.id, human.turn.id, operator.turn.id],
        "test",
      ),
    ).rejects.toThrow("routine system work cannot be reordered ahead");

    const humanItem = before!.items.find((turn) => turn.id === human.turn.id)!;
    const raced = await Promise.allSettled([
      cancelQueuedSessionTurnWithVersion(
        dbClient.db,
        grant.workspaceId,
        session.id,
        humanItem.id,
        before!.version,
        humanItem.version,
        "test",
        "concurrent cancellation",
      ),
      promoteQueuedSessionTurn(
        dbClient.db,
        grant.workspaceId,
        session.id,
        humanItem.id,
        before!.version,
        humanItem.version,
        "test",
      ),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = raced.find(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof promoteQueuedSessionTurn>>> =>
        result.status === "fulfilled",
    )!;
    expect(winner.value.events).toHaveLength(1);
    expect(JSON.stringify(winner.value.events[0]?.payload)).not.toContain(privatePrompt);
  });

  test("101 concurrent child updates converge on one paged bundle and duplicate repair wake", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createDurableSession(grant, "fan in 101 children");
    const inputs = Array.from({ length: SYSTEM_UPDATE_INLINE_ITEM_LIMIT + 1 }, (_, index) =>
      systemUpdateInput(grant, session.id, {
        groupingKey: "child-terminals:v1",
        sourceId: `child-${index}`,
        dedupeKey: `child-terminal-${index}`,
        summary: `Child ${index} completed`,
        payload: { index, status: "completed" },
      }),
    );

    const results = await Promise.all(
      inputs.map((input) => addSessionSystemUpdate(dbClient.db, input)),
    );
    const added = results.filter((result) => "added" in result && result.added);
    expect(added).toHaveLength(SYSTEM_UPDATE_INLINE_ITEM_LIMIT + 1);
    const successful = results.filter(
      (result): result is Extract<typeof result, { reason: "added" | "duplicate" }> =>
        "bundle" in result,
    );
    expect(new Set(successful.map((result) => result.bundle.id)).size).toBe(1);
    expect(new Set(successful.map((result) => result.bundle.generation))).toEqual(new Set([1]));
    expect(successful.filter((result) => result.wakeCreated)).toHaveLength(1);
    expect(new Set(successful.map((result) => result.turn?.id))).toHaveLength(1);

    const finalBundle = successful.at(-1)!.bundle;
    expect(finalBundle.memberCount).toBe(SYSTEM_UPDATE_INLINE_ITEM_LIMIT + 1);
    expect(finalBundle.overflow).toBe(true);
    expect(finalBundle.payloadBytes).toBe(
      successful.reduce(
        (total, result) => total + sessionSystemUpdateConstituentBytes(result.update),
        0,
      ),
    );
    const firstPage = await getSessionSystemUpdateBundlePage(
      dbClient.db,
      grant.workspaceId,
      session.id,
      finalBundle.id,
    );
    expect(firstPage?.updates).toHaveLength(SYSTEM_UPDATE_INLINE_ITEM_LIMIT);
    expect(firstPage?.nextCursor).toBe(SYSTEM_UPDATE_INLINE_ITEM_LIMIT);
    const secondPage = await getSessionSystemUpdateBundlePage(
      dbClient.db,
      grant.workspaceId,
      session.id,
      finalBundle.id,
      firstPage!.nextCursor!,
    );
    expect(secondPage?.updates).toHaveLength(1);
    expect(secondPage?.nextCursor).toBeNull();

    const duplicate = await addSessionSystemUpdate(dbClient.db, inputs[0]!);
    expect(duplicate).toMatchObject({
      added: false,
      reason: "duplicate",
      shouldWake: true,
      wakeCreated: false,
      events: [],
    });
    if (!("bundle" in duplicate)) throw new Error("Expected duplicate fan-in result");
    expect(duplicate.bundle.id).toBe(finalBundle.id);
    expect(duplicate.update.id).toBe(successful[0]!.update.id);
    expect(duplicate.turn?.id).toBe(successful[0]!.turn?.id);

    const queue = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    expect(queue?.items.filter((turn) => turn.queueKind === "system_update_bundle")).toHaveLength(
      1,
    );
  }, 30_000);

  test("10 and 100 simultaneous child completions each create one wake and no lost constituent", async () => {
    for (const count of [10, SYSTEM_UPDATE_INLINE_ITEM_LIMIT]) {
      const grant = await testGrant(dbClient.db);
      const session = await createDurableSession(grant, `fan in exactly ${count} children`);
      const inputs = Array.from({ length: count }, (_, index) =>
        systemUpdateInput(grant, session.id, {
          groupingKey: `child-terminals:${count}`,
          sourceId: `child-${count}-${index}`,
          dedupeKey: `child-terminal-${count}-${index}`,
          summary: `Child ${index} of ${count} completed`,
          payload: { index, count, status: "completed" },
        }),
      );

      const results = await Promise.all(
        inputs.map((input) => addSessionSystemUpdate(dbClient.db, input)),
      );
      const successful = results.filter(
        (result): result is Extract<typeof result, { reason: "added" | "duplicate" }> =>
          "bundle" in result,
      );
      expect(successful).toHaveLength(count);
      expect(successful.every((result) => result.added)).toBe(true);
      expect(new Set(successful.map((result) => result.update.dedupeKey)).size).toBe(count);
      expect(new Set(successful.map((result) => result.bundle.id)).size).toBe(1);
      expect(successful.filter((result) => result.wakeCreated)).toHaveLength(1);
      expect(new Set(successful.map((result) => result.turn?.id)).size).toBe(1);
      const bundleId = successful[0]!.bundle.id;
      const turnId = successful[0]!.turn?.id;
      const page = await getSessionSystemUpdateBundlePage(
        dbClient.db,
        grant.workspaceId,
        session.id,
        bundleId,
      );
      if (!page) throw new Error(`Expected persisted fan-in bundle: ${bundleId}`);
      expect(page.bundle.memberCount).toBe(count);
      expect(page.updates).toHaveLength(count);
      expect(page.nextCursor).toBeNull();
      expect(
        page.updates.reduce(
          (total, update) => total + sessionSystemUpdateConstituentBytes(update),
          0,
        ),
      ).toBe(page.bundle.payloadBytes);
      expect(
        (await listPendingSessionSystemWakeRepairs(dbClient.db, 100)).some(
          (repair) => repair.turnId === turnId,
        ),
      ).toBe(true);
    }
  }, 30_000);

  test("byte overflow pages safely and late arrivals form a settled next generation", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createDurableSession(grant, "fan in byte overflow");
    const largePayload = "x".repeat(20_000);
    const firstGeneration = [];
    for (let index = 0; index < 4; index += 1) {
      const result = await addSessionSystemUpdate(
        dbClient.db,
        systemUpdateInput(grant, session.id, {
          groupingKey: "large-children:v1",
          sourceId: `large-child-${index}`,
          dedupeKey: `large-child-${index}`,
          summary: `Large child ${index}`,
          payload: { index, content: largePayload },
        }),
      );
      if (!("bundle" in result)) throw new Error("Expected fan-in result");
      firstGeneration.push(result);
    }
    const bundle = firstGeneration.at(-1)!.bundle;
    expect(bundle.payloadBytes).toBeGreaterThan(SYSTEM_UPDATE_INLINE_BYTE_LIMIT);
    expect(bundle.overflow).toBe(true);
    const page = await getSessionSystemUpdateBundlePage(
      dbClient.db,
      grant.workspaceId,
      session.id,
      bundle.id,
    );
    expect(page?.updates.length).toBeGreaterThan(0);
    expect(page?.updates.length).toBeLessThan(4);
    expect(
      page!.updates.reduce(
        (total, update) => total + sessionSystemUpdateConstituentBytes(update),
        0,
      ),
    ).toBeLessThanOrEqual(SYSTEM_UPDATE_INLINE_BYTE_LIMIT);
    expect(page?.nextCursor).not.toBeNull();

    const running = await claimNextQueuedTurn(
      dbClient.db,
      grant.workspaceId,
      session.id,
      "large-bundle-workflow",
    );
    expect(running?.bundleId).toBe(bundle.id);
    const late = await addSessionSystemUpdate(
      dbClient.db,
      systemUpdateInput(grant, session.id, {
        groupingKey: "large-children:v1",
        sourceId: "late-child",
        dedupeKey: "late-child",
        summary: "Late child completed",
        payload: { late: true },
      }),
    );
    if (!("bundle" in late)) throw new Error("Expected late fan-in result");
    expect(late.bundle.generation).toBe(2);
    expect(late.bundle.id).not.toBe(bundle.id);
    expect(late.wakeCreated).toBe(true);
    expect(late.shouldWake).toBe(false);

    expect(
      await finishTurn(
        dbClient.db,
        grant.workspaceId,
        running!.id,
        "completed",
        running!.executionGeneration,
      ),
    ).toBe(true);
    const settledFirst = await getSessionSystemUpdateBundlePage(
      dbClient.db,
      grant.workspaceId,
      session.id,
      bundle.id,
    );
    expect(settledFirst?.bundle.status).toBe("acknowledged");
    expect(settledFirst?.updates.every((update) => update.deliveryState === "acknowledged")).toBe(
      true,
    );
    await setSessionStatus(dbClient.db, grant.workspaceId, session.id, "queued", null);
    const queue = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    const lateTurn = queue!.items.find((turn) => turn.bundleId === late.bundle.id)!;
    const cancelled = await cancelQueuedSessionTurnWithVersion(
      dbClient.db,
      grant.workspaceId,
      session.id,
      lateTurn.id,
      queue!.version,
      lateTurn.version,
      "test",
      "no longer needed",
    );
    expect(cancelled.events.map((event) => event.type)).toEqual(["session.queue.item.cancelled"]);
    const settledLate = await getSessionSystemUpdateBundlePage(
      dbClient.db,
      grant.workspaceId,
      session.id,
      late.bundle.id,
    );
    expect(settledLate?.bundle.status).toBe("cancelled");
    expect(settledLate?.updates.every((update) => update.deliveryState === "cancelled")).toBe(true);
  });

  test("empty interrupt is durable and non-empty stop preserves queued work inert until exact resume", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createDurableSession(grant, "interrupt and stop");
    const emptyInterrupt = await requestSessionControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: "test",
      mode: "interrupt",
      reason: "empty interrupt",
      clientEventId: `empty-interrupt-${crypto.randomUUID()}`,
    });
    expect(emptyInterrupt.shouldSignalInterrupt).toBe(false);
    expect(emptyInterrupt.events.map((event) => event.type)).toEqual([
      "user.interrupt",
      "session.control.interrupt_requested",
    ]);
    expect(emptyInterrupt.shouldWake).toBe(false);

    const activeInput = await enqueueMessage(grant, session.id, "active", "human");
    const queuedInput = await enqueueMessage(grant, session.id, "queued", "human");
    const active = await claimNextQueuedTurn(
      dbClient.db,
      grant.workspaceId,
      session.id,
      "stop-workflow",
    );
    expect(active?.id).toBe(activeInput.turn.id);
    const beforeStop = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    const stop = await requestSessionControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: "test",
      mode: "stop",
      reason: "preserve the queue",
      clientEventId: `stop-${crypto.randomUUID()}`,
      expectedControlState: beforeStop!.controlState,
      expectedControlGeneration: beforeStop!.controlGeneration,
      expectedWorkspaceInferenceGeneration: beforeStop!.workspaceInferenceGeneration,
    });
    expect(stop.shouldSignalInterrupt).toBe(true);
    expect(
      await claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "must-not-run"),
    ).toBeNull();
    const stopped = await applySessionControlInterrupt(
      dbClient.db,
      grant.workspaceId,
      session.id,
      stop.deliveryEventId!,
    );
    expect(stopped.cancelledTurnId).toBe(active!.id);
    const stoppedQueue = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    expect(stoppedQueue?.controlState).toBe("session_stopped");
    expect(stoppedQueue?.items.map((turn) => turn.id)).toEqual([queuedInput.turn.id]);
    expect(
      await claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "still-must-not-run"),
    ).toBeNull();

    const resumed = await requestSessionControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: "test",
      mode: "resume",
      reason: "resume exact stopped generation",
      clientEventId: `resume-${crypto.randomUUID()}`,
      expectedControlState: stoppedQueue!.controlState,
      expectedControlGeneration: stoppedQueue!.controlGeneration,
      expectedWorkspaceInferenceGeneration: stoppedQueue!.workspaceInferenceGeneration,
    });
    expect(resumed.shouldSignalInterrupt).toBe(false);
    expect(resumed.shouldWake).toBe(true);
    expect(
      (await claimNextQueuedTurn(dbClient.db, grant.workspaceId, session.id, "resumed-workflow"))
        ?.id,
    ).toBe(queuedInput.turn.id);
  });

  test("send-and-steer cancels only the active generation and claims the exact human target", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createDurableSession(grant, "send and steer");
    const runningBundle = await addSessionSystemUpdate(
      dbClient.db,
      systemUpdateInput(grant, session.id, {
        groupingKey: "routine-a",
        sourceId: "routine-a",
        dedupeKey: "routine-a",
        summary: "Routine system work A",
        payload: {},
      }),
    );
    if (!("turn" in runningBundle) || !runningBundle.turn) {
      throw new Error("Expected first bundle turn");
    }
    const active = await claimNextQueuedTurn(
      dbClient.db,
      grant.workspaceId,
      session.id,
      "steer-workflow-active",
    );
    expect(active?.id).toBe(runningBundle.turn.id);
    const olderBundle = await addSessionSystemUpdate(
      dbClient.db,
      systemUpdateInput(grant, session.id, {
        groupingKey: "routine-b",
        sourceId: "routine-b",
        dedupeKey: "routine-b",
        summary: "Routine system work B",
        payload: {},
      }),
    );
    if (!("turn" in olderBundle) || !olderBundle.turn) {
      throw new Error("Expected second bundle turn");
    }
    const beforeSteer = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    const steered = await enqueueSessionMessageAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: "test",
      origin: "human",
      text: "urgent correction",
      resources: [],
      tools: [],
      clientEventId: `steer-message-${crypto.randomUUID()}`,
      delivery: "steer",
      expectedControlGeneration: beforeSteer!.controlGeneration,
      expectedWorkspaceInferenceGeneration: beforeSteer!.workspaceInferenceGeneration,
      reasoningEffortFallback: "low",
    });
    expect(steered.shouldSignalInterrupt).toBe(true);
    expect(steered.controlEvent?.type).toBe("session.control.steer_requested");
    const cancelled = await applySessionControlInterrupt(
      dbClient.db,
      grant.workspaceId,
      session.id,
      steered.controlEvent!.id,
    );
    expect(cancelled.cancelledTurnId).toBe(active!.id);
    const intended = await claimNextQueuedTurn(
      dbClient.db,
      grant.workspaceId,
      session.id,
      "steer-workflow-intended",
    );
    expect(intended?.id).toBe(steered.turn.id);
    const queue = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    expect(
      queue?.items.some((turn) => turn.id === olderBundle.turn!.id && turn.status === "queued"),
    ).toBe(true);
    expect(queue?.items.filter((turn) => turn.status === "running")).toHaveLength(1);
  });

  test("a pending stop fences history, RunState, and late activity events before cancellation", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createDurableSession(grant, "fence stale activity writes");
    const queued = await enqueueMessage(grant, session.id, "run once", "human");
    const active = await claimNextQueuedTurn(
      dbClient.db,
      grant.workspaceId,
      session.id,
      "writer-fence-active",
    );
    expect(active?.id).toBe(queued.turn.id);

    expect(
      await appendSessionHistoryItems(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: active!.id,
        expectedExecutionGeneration: active!.executionGeneration,
        items: [{ position: 1, item: { role: "assistant", content: "accepted before stop" } }],
      }),
    ).toBe(true);
    expect(
      await saveRunState(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: active!.id,
        expectedExecutionGeneration: active!.executionGeneration,
        serializedRunState: "accepted-before-stop",
        pendingApprovals: [],
      }),
    ).toBe(true);
    expect(
      await appendSessionEventsForTurnGeneration(
        dbClient.db,
        grant.workspaceId,
        session.id,
        active!.id,
        active!.executionGeneration,
        [{ type: "agent.message.delta", payload: { text: "accepted before stop" } }],
      ),
    ).toMatchObject({ accepted: true });

    const beforeStop = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id);
    const stop = await requestSessionControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: "test",
      mode: "stop",
      reason: "fence this generation",
      clientEventId: `writer-fence-stop-${crypto.randomUUID()}`,
      expectedControlState: beforeStop!.controlState,
      expectedControlGeneration: beforeStop!.controlGeneration,
      expectedWorkspaceInferenceGeneration: beforeStop!.workspaceInferenceGeneration,
    });
    expect(stop.shouldSignalInterrupt).toBe(true);

    expect(
      await appendSessionHistoryItems(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: active!.id,
        expectedExecutionGeneration: active!.executionGeneration,
        items: [{ position: 2, item: { role: "assistant", content: "must be rejected" } }],
      }),
    ).toBe(false);
    expect(
      await saveRunState(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: active!.id,
        expectedExecutionGeneration: active!.executionGeneration,
        serializedRunState: "must-be-rejected",
        pendingApprovals: [],
      }),
    ).toBe(false);
    const rejected = await appendSessionEventsForTurnGeneration(
      dbClient.db,
      grant.workspaceId,
      session.id,
      active!.id,
      active!.executionGeneration,
      [{ type: "agent.message.delta", payload: { text: "must be rejected" } }],
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.events.map((event) => event.type)).toEqual(["turn.event.rejected_late"]);
    expect(await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id)).toHaveLength(
      1,
    );

    const cancelled = await applySessionControlInterrupt(
      dbClient.db,
      grant.workspaceId,
      session.id,
      stop.deliveryEventId!,
    );
    expect(cancelled.cancelledTurnId).toBe(active!.id);
  });

  test("worker-death recovery atomically resets a bundle and fences the dead generation", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createDurableSession(grant, "worker death bundle recovery");
    const bundled = await addSessionSystemUpdate(
      dbClient.db,
      systemUpdateInput(grant, session.id, {
        groupingKey: "worker-death-bundle",
        sourceId: "worker-death-child",
        dedupeKey: "worker-death-child",
        summary: "Child completed before worker death",
        payload: { status: "completed" },
      }),
    );
    if (!("turn" in bundled) || !bundled.turn) throw new Error("Expected bundle queue turn");
    const first = await claimNextQueuedTurn(
      dbClient.db,
      grant.workspaceId,
      session.id,
      "worker-death-first-dispatch",
    );
    expect(first?.id).toBe(bundled.turn.id);
    expect(
      (
        await getSessionSystemUpdateBundlePage(
          dbClient.db,
          grant.workspaceId,
          session.id,
          bundled.bundle.id,
        )
      )?.bundle.status,
    ).toBe("running");

    const recovery = await requeueTurnAfterWorkerDeathAtomically(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: first!.id,
      originalTriggerEventId: first!.triggerEventId,
      resumeWithNotice: true,
      maxRedispatches: 3,
      preemptedPayload: { turnId: first!.id, reason: "worker_death" },
    });
    expect(recovery.action).toBe("requeued");
    if (recovery.action !== "requeued") throw new Error("Expected worker-death requeue");
    expect(recovery.redispatches).toBe(1);
    expect(recovery.events.map((event) => event.type)).toEqual([
      "turn.preempted",
      "session.status.changed",
    ]);
    const reset = await getSessionSystemUpdateBundlePage(
      dbClient.db,
      grant.workspaceId,
      session.id,
      bundled.bundle.id,
    );
    expect(reset?.bundle.status).toBe("queued");
    expect(reset?.updates.every((update) => update.deliveryState === "pending")).toBe(true);

    const second = await claimNextQueuedTurn(
      dbClient.db,
      grant.workspaceId,
      session.id,
      "worker-death-second-dispatch",
    );
    expect(second?.id).toBe(first!.id);
    expect(second?.executionGeneration).toBe(first!.executionGeneration + 1);
    expect(
      await appendSessionHistoryItems(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: first!.id,
        expectedExecutionGeneration: first!.executionGeneration,
        items: [{ position: 1, item: { role: "assistant", content: "dead generation" } }],
      }),
    ).toBe(false);
    const late = await appendSessionEventsForTurnGeneration(
      dbClient.db,
      grant.workspaceId,
      session.id,
      first!.id,
      first!.executionGeneration,
      [{ type: "agent.message.delta", payload: { text: "dead generation" } }],
    );
    expect(late.accepted).toBe(false);
    expect(late.events.map((event) => event.type)).toEqual(["turn.event.rejected_late"]);
  });

  test("recursive stop and workspace kill are generation-fenced, idempotent, and preserve queues", async () => {
    const grant = await testGrant(dbClient.db);
    const root = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "root",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const child = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: root.id,
    });
    const grandchild = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "grandchild",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: child.id,
    });
    await cutOverDurableQueue(grant);
    for (const target of [root, child, grandchild]) {
      await enqueueMessage(grant, target.id, `work-${target.id}`, "human");
      await claimNextQueuedTurn(
        dbClient.db,
        grant.workspaceId,
        target.id,
        `descendant-workflow-${target.id}`,
      );
      await enqueueMessage(grant, target.id, `queued-${target.id}`, "human");
    }
    const rootBefore = await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, root.id);
    const descendantsKey = `descendants-${crypto.randomUUID()}`;
    const descendants = await stopSessionDescendants(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      rootSessionId: root.id,
      actor: "test",
      reason: "stop descendants",
      includeRoot: false,
      clientEventId: descendantsKey,
      expectedWorkspaceInferenceGeneration: rootBefore!.workspaceInferenceGeneration,
      expectedRootControlGeneration: rootBefore!.controlGeneration,
    });
    expect(new Set(descendants.affectedSessionIds)).toEqual(new Set([child.id, grandchild.id]));
    expect(descendants.interrupts).toHaveLength(2);
    const duplicateDescendants = await stopSessionDescendants(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      rootSessionId: root.id,
      actor: "test",
      reason: "stop descendants",
      includeRoot: false,
      clientEventId: descendantsKey,
      expectedWorkspaceInferenceGeneration: rootBefore!.workspaceInferenceGeneration,
      expectedRootControlGeneration: rootBefore!.controlGeneration,
    });
    expect(duplicateDescendants.operationId).toBe(descendants.operationId);
    expect(duplicateDescendants.interrupts).toHaveLength(2);
    for (const interrupt of descendants.interrupts) {
      await applySessionControlInterrupt(
        dbClient.db,
        grant.workspaceId,
        interrupt.sessionId,
        interrupt.eventId,
      );
      expect(
        (await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, interrupt.sessionId))
          ?.controlState,
      ).toBe("session_stopped");
    }
    expect(
      (await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, root.id))?.controlState,
    ).toBe("active");

    const workspaceKey = `workspace-kill-${crypto.randomUUID()}`;
    const killed = await setWorkspaceInferenceControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: "test",
      state: "killed",
      reason: "emergency test",
      clientEventId: workspaceKey,
      expectedState: "active",
      expectedGeneration: rootBefore!.workspaceInferenceGeneration,
    });
    expect(killed.state).toBe("killed");
    expect(new Set(killed.affectedSessionIds)).toEqual(new Set([root.id, child.id, grandchild.id]));
    expect(killed.interrupts.map((item) => item.sessionId)).toEqual([root.id]);
    await applySessionControlInterrupt(
      dbClient.db,
      grant.workspaceId,
      root.id,
      killed.interrupts[0]!.eventId,
    );
    for (const target of [root, child, grandchild]) {
      expect(
        await claimNextQueuedTurn(
          dbClient.db,
          grant.workspaceId,
          target.id,
          `killed-workflow-${target.id}`,
        ),
      ).toBeNull();
    }
    const duplicateKill = await setWorkspaceInferenceControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: "test",
      state: "killed",
      reason: "emergency test",
      clientEventId: workspaceKey,
      expectedState: "active",
      expectedGeneration: rootBefore!.workspaceInferenceGeneration,
    });
    expect(duplicateKill.operationId).toBe(killed.operationId);
    expect(duplicateKill.interrupts).toHaveLength(0);
    const resumed = await setWorkspaceInferenceControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: "test",
      state: "active",
      reason: "incident cleared",
      clientEventId: `workspace-resume-${crypto.randomUUID()}`,
      expectedState: "killed",
      expectedGeneration: killed.generation,
    });
    expect(resumed.wakeSessionIds).toContain(root.id);
    expect(resumed.wakeSessionIds).not.toContain(child.id);
    expect(
      (await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, child.id))?.controlState,
    ).toBe("session_stopped");
  });

  test("sessions created during a workspace kill remain fenced and are included in exact resume", async () => {
    const grant = await testGrant(dbClient.db);
    await createDurableSession(grant, "existing before workspace kill");
    const killed = await setWorkspaceInferenceControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: "test",
      state: "killed",
      reason: "hold all inference while admitting queued work",
      clientEventId: `workspace-kill-create-race-${crypto.randomUUID()}`,
      expectedState: "active",
      expectedGeneration: 0,
    });

    const createdWhileKilled = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "created while killed",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    expect(createdWhileKilled.controlState).toBe("workspace_killed");
    const queued = await enqueueMessage(
      grant,
      createdWhileKilled.id,
      "preserve me until exact resume",
      "human",
    );
    expect(
      await claimNextQueuedTurn(
        dbClient.db,
        grant.workspaceId,
        createdWhileKilled.id,
        "must-remain-killed",
      ),
    ).toBeNull();

    const resumed = await setWorkspaceInferenceControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: "test",
      state: "active",
      reason: "workspace incident cleared",
      clientEventId: `workspace-resume-create-race-${crypto.randomUUID()}`,
      expectedState: "killed",
      expectedGeneration: killed.generation,
    });
    expect(resumed.wakeSessionIds).toContain(createdWhileKilled.id);
    expect(
      (
        await claimNextQueuedTurn(
          dbClient.db,
          grant.workspaceId,
          createdWhileKilled.id,
          "resumed-created-session",
        )
      )?.id,
    ).toBe(queued.turn.id);
  });

  test("lifecycle source mutation and fan-in commit or roll back in the same transaction", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createDurableSession(grant, "lifecycle seam");
    const task = await createScheduledTask(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "lifecycle source",
      status: "active",
      temporalScheduleId: `lifecycle-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    const run = await createScheduledTaskRun(dbClient.db, {
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `lifecycle-run-${crypto.randomUUID()}`,
    });
    const baseInput = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      kind: "lifecycle_event" as const,
      groupingKey: `lifecycle:${task.id}`,
      classification: "info" as const,
      sourceId: run.id,
      dedupeKey: `lifecycle:${run.id}`,
      summary: "Scheduled lifecycle source dispatched",
      payload: { taskId: task.id, runId: run.id },
      lineage: { taskId: task.id, runId: run.id },
      reasoningEffortFallback: "low" as const,
    };
    await expect(
      addSessionSystemUpdateWithSourceMutation(
        dbClient.db,
        { ...baseInput, payload: { content: "x".repeat(SYSTEM_UPDATE_INLINE_BYTE_LIMIT) } },
        async (tx) => {
          await settleScheduledTaskRunInTransaction(tx, {
            workspaceId: grant.workspaceId,
            runId: run.id,
            sessionId: session.id,
            status: "dispatched",
          });
        },
      ),
    ).rejects.toThrow("exceeds");
    expect((await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id))[0]?.status).toBe(
      "queued",
    );
    expect(
      (await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id))?.items,
    ).toHaveLength(0);

    const committed = await addSessionSystemUpdateWithSourceMutation(
      dbClient.db,
      baseInput,
      async (tx) => {
        await settleScheduledTaskRunInTransaction(tx, {
          workspaceId: grant.workspaceId,
          runId: run.id,
          sessionId: session.id,
          status: "dispatched",
        });
      },
    );
    expect(committed).toMatchObject({ added: true, reason: "added", wakeCreated: true });
    expect((await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id))[0]?.status).toBe(
      "dispatched",
    );
    if (!("update" in committed)) throw new Error("Expected lifecycle update");
    expect(committed.update.kind).toBe("lifecycle_event");
  });

  async function cutOverDurableQueue(grant: AccessGrant): Promise<void> {
    await setWorkspaceQueueRuntimeControl(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: "test",
      state: "durable_v1",
      reason: "real PostgreSQL queue test",
      clientEventId: `queue-cutover-${crypto.randomUUID()}`,
      expectedState: "legacy",
      expectedGeneration: 0,
    });
  }

  async function createDurableSession(grant: AccessGrant, initialMessage: string) {
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage,
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await cutOverDurableQueue(grant);
    return session;
  }

  async function enqueueMessage(
    grant: AccessGrant,
    sessionId: string,
    text: string,
    origin: "human" | "operator",
  ) {
    return await enqueueSessionMessageAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      actor: "test",
      origin,
      text,
      resources: [],
      tools: [],
      clientEventId: `queue-message-${crypto.randomUUID()}`,
      delivery: "queue",
      reasoningEffortFallback: "low",
    });
  }

  function systemUpdateInput(
    grant: AccessGrant,
    sessionId: string,
    update: {
      groupingKey: string;
      sourceId: string;
      dedupeKey: string;
      summary: string;
      payload: Record<string, unknown>;
    },
  ) {
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      kind: "child_session_update" as const,
      groupingKey: update.groupingKey,
      classification: "success" as const,
      sourceId: update.sourceId,
      dedupeKey: update.dedupeKey,
      summary: update.summary,
      payload: update.payload,
      lineage: { childSessionId: update.sourceId },
      resources: [],
      tools: [],
      reasoningEffortFallback: "low" as const,
    };
  }
});

async function testGrant(db: ReturnType<typeof createDb>["db"]): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:durable-queue",
    accountExternalId: `account:${id}`,
    accountName: "Durable queue test account",
    workspaceExternalSource: "test:durable-queue",
    workspaceExternalId: `workspace:${id}`,
    workspaceName: "Durable queue test workspace",
    subjectId: `test:durable-queue:${id}`,
    subjectLabel: "Durable queue integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) throw new Error("Durable queue test did not create a workspace grant");
  return grant;
}

/**
 * CI uses the repository's one-container pgvector harness. Sandboxes without a
 * Docker daemon may opt into an already-running native PostgreSQL cluster; the
 * test still creates, migrates, and drops its own database and uses the real
 * non-superuser opengeni_app role. No unavailable/skip branch is accepted.
 */
async function acquireRequiredTestDatabase(label: string): Promise<RequiredTestDatabase> {
  const externalAdminBase = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  if (!externalAdminBase) {
    const acquired = await acquireSharedTestDatabase(label);
    if (!acquired) {
      throw new Error(
        "durable queue tests require real PostgreSQL (Docker or OPENGENI_TEST_POSTGRES_ADMIN_URL)",
      );
    }
    return acquired;
  }

  const dbName = `og_${label.replace(/[^a-z0-9]/gi, "_").slice(0, 24)}_${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`.toLowerCase();
  const root = postgres(externalAdminBase, { max: 1 });
  const adminUrl = databaseUrl(externalAdminBase, dbName);
  const externalAppBase =
    process.env.OPENGENI_TEST_POSTGRES_APP_URL ?? appRoleUrl(externalAdminBase);
  const appUrl = databaseUrl(externalAppBase, dbName);
  try {
    await root.unsafe(`CREATE DATABASE "${dbName}"`);
    await migrate(adminUrl);
    const admin = postgres(adminUrl, { max: 4 });
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
          CREATE ROLE opengeni_app LOGIN;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO opengeni_app;
      GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
    `);
    let released = false;
    return {
      admin,
      adminUrl,
      appUrl,
      release: async () => {
        if (released) return;
        released = true;
        await admin.end().catch(() => undefined);
        await root.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await root.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await root.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await root.end().catch(() => undefined);
    throw error;
  }
}

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function appRoleUrl(base: string): string {
  const url = new URL(base);
  url.username = "opengeni_app";
  url.password = "";
  return url.toString();
}
