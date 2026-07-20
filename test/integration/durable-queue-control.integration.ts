import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import postgres from "postgres";
import type { AccessGrant, SessionEvent } from "@opengeni/contracts";
import { controlHumanSessionWorkstream, postUserMessageTurn } from "@opengeni/core";
import {
  addSessionSystemUpdate,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionHistoryItems,
  getSession,
  getSessionQueueSnapshot,
  listOutstandingSessionSystemUpdates,
  listSessionEvents,
  listSessionSystemUpdatesForTurn,
  listSessionTurns,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import {
  ScriptedModel,
  startTestServices,
  testSettings,
  waitFor,
  type TestServices,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../../apps/worker/src/activities";
import { currentActivityContext } from "../../apps/worker/src/activities/streaming";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "../../apps/worker/src/concurrency";
import { turnTaskQueue } from "../../apps/worker/src/workflows/activities";
import { submitTestHumanPrompt } from "./helpers/session-control";

type RequiredServices = Pick<
  TestServices,
  "databaseUrl" | "natsUrl" | "temporalHost" | "migrate" | "down"
> & { databaseAdminUrl: string };

const integrationTimeoutMs = 180_000;
const workerDeathTimeoutMs = 300_000;

describe("durable queue control integration (real Postgres/NATS/Temporal)", () => {
  let services: RequiredServices;
  let admin: postgres.Sql;
  let dbClient: ReturnType<typeof createDb>;
  let bus: EventBus;
  let connection: Connection;
  let nativeConnection: NativeConnection;

  beforeAll(async () => {
    services = await requiredServices();
    await services.migrate();
    admin = postgres(services.databaseAdminUrl, { max: 2 });
    dbClient = createDb(services.databaseUrl);
    bus = await createNatsEventBus(services.natsUrl);
    connection = await Connection.connect({ address: services.temporalHost });
    nativeConnection = await NativeConnection.connect({ address: services.temporalHost });
  }, 300_000);

  afterAll(async () => {
    await connection?.close();
    await nativeConnection?.close();
    await bus?.close();
    await dbClient?.close();
    await admin?.end().catch(() => undefined);
    await services?.down();
  }, 60_000);

  test(
    "100 concurrent internal updates coalesce into the urgent Steer inference without entering the prompt queue",
    async () => {
      const grant = await testGrant(dbClient.db, "fan-in-steer");
      const session = await createDurableSession(dbClient.db, grant, "fan-in then urgent steer");
      const initial = await submitTestHumanPrompt(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        text: "long-running initial work",
        resources: [],
        tools: [],
        operationKey: `integration-initial-${crypto.randomUUID()}`,
        delivery: "send",
        reasoningEffortFallback: "low",
      });
      const taskQueue = `durable-fan-in-${crypto.randomUUID()}`;
      const model = new ScriptedModel([
        {
          id: "fan-in-initial",
          chunks: Array.from({ length: 10_000 }, () => "working "),
          delayMs: 10,
        },
        { id: "fan-in-urgent", outputText: "urgent correction and internal updates handled" },
      ]);
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        temporalTaskQueue: taskQueue,
      });
      const workflowClient = sessionWorkflowClient(new Client({ connection }), taskQueue);
      const activities = createActivityTestHarness({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
        wakeSessionWorkflow: workflowClient.wakeSessionWorkflow,
      });
      const worker = await integrationWorker(nativeConnection, taskQueue, activities);
      const workerRun = worker.run();
      const live: SessionEvent[] = [];
      const unsubscribe = await bus.subscribe(grant.workspaceId, session.id, (events) => {
        live.push(...events);
      });
      const temporal = new Client({ connection });
      const handle = await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue,
        workflowId: initial.turn.temporalWorkflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
          },
        ],
        signal: "queueChanged",
      });

      try {
        await waitFor(() => model.calls === 1);
        const updates = await Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            addSessionSystemUpdate(
              dbClient.db,
              systemUpdateInput(grant, session.id, "children:integration", index),
            ),
          ),
        );
        const acceptedUpdates = updates.filter(
          (result): result is Exclude<typeof result, { reason: "session_cancelled" }> =>
            result.reason !== "session_cancelled",
        );
        expect(acceptedUpdates).toHaveLength(100);
        for (const result of acceptedUpdates) {
          if (result.added && result.events.length > 0) {
            await bus.publish(grant.workspaceId, session.id, result.events);
          }
        }

        const beforeSteer = await getSessionQueueSnapshot(
          dbClient.db,
          grant.workspaceId,
          session.id,
        );
        // The current inference is deliberately outside the visible prompt queue.
        expect(beforeSteer?.items).toHaveLength(0);
        expect(beforeSteer?.items.every((turn) => ["user", "api"].includes(turn.source))).toBe(
          true,
        );
        expect(
          await listOutstandingSessionSystemUpdates(dbClient.db, grant.workspaceId, session.id),
        ).toHaveLength(100);
        const steerRequestedAt = performance.now();
        const urgent = await postUserMessageTurn({
          db: dbClient.db,
          bus,
          workflowClient,
          settings,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          text: "urgent correction",
          resources: [],
          tools: [],
          clientEventId: `integration-urgent-${crypto.randomUUID()}`,
          delivery: "steer",
          controlEtag: beforeSteer!.effectiveControl.controlEtag,
        });
        try {
          await waitFor(() => model.calls === 2, {
            timeoutMs: 2_000,
            intervalMs: 10,
            describe: () =>
              `replacement model call did not start within the 2s Steer budget; calls=${model.calls}`,
          });
        } catch (error) {
          const diagnosticEvents = await listSessionEvents(
            dbClient.db,
            grant.workspaceId,
            session.id,
            0,
            2_000,
          );
          const diagnosticQueue = await getSessionQueueSnapshot(
            dbClient.db,
            grant.workspaceId,
            session.id,
          );
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; ` +
              `queue=${JSON.stringify({
                version: diagnosticQueue?.version,
                stopping: diagnosticQueue?.stoppingPreviousAttempt,
                items: diagnosticQueue?.items.map((turn) => turn.id),
              })}; tail=${JSON.stringify(
                diagnosticEvents.slice(-8).map((event) => ({
                  sequence: event.sequence,
                  type: event.type,
                  turnId: event.turnId,
                  payload: event.payload,
                })),
              )}`,
            { cause: error },
          );
        }
        expect(performance.now() - steerRequestedAt).toBeLessThan(2_000);

        await handle.result();
        const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
        expect(turns).toHaveLength(2);
        expect(turns.find((turn) => turn.id === initial.turn.id)?.status).toBe("superseded");
        expect(turns.find((turn) => turn.id === urgent.turn.id)?.status).toBe("completed");

        const events = await listSessionEvents(
          dbClient.db,
          grant.workspaceId,
          session.id,
          0,
          2_000,
        );
        const startedTurnIds = events
          .filter((event) => event.type === "turn.started")
          .map((event) => event.turnId);
        expect(startedTurnIds).toEqual([initial.turn.id, urgent.turn.id]);
        expect(
          events.filter(
            (event) => event.type === "turn.superseded" && event.turnId === initial.turn.id,
          ),
        ).toHaveLength(1);
        const steerRequested = events.find(
          (event) =>
            event.type === "session.control.steer_requested" &&
            event.payload.targetTurnId === urgent.turn.id,
        );
        const quiesced = events.find(
          (event) =>
            event.type === "session.queue.changed" &&
            event.turnId === initial.turn.id &&
            event.payload.operation === "attempt_quiesced",
        );
        const replacementStarted = events.find(
          (event) => event.type === "turn.started" && event.turnId === urgent.turn.id,
        );
        expect(steerRequested).toBeDefined();
        expect(quiesced).toBeDefined();
        expect(replacementStarted).toBeDefined();
        expect(quiesced!.sequence).toBeGreaterThan(steerRequested!.sequence);
        expect(replacementStarted!.sequence).toBeGreaterThan(quiesced!.sequence);
        expect(
          Date.parse(quiesced!.occurredAt) - Date.parse(urgent.accepted.occurredAt),
        ).toBeLessThan(2_000);
        expect(model.calls).toBe(2);
        const deliveredUpdates = await listSessionSystemUpdatesForTurn(
          dbClient.db,
          grant.workspaceId,
          session.id,
          urgent.turn.id,
        );
        expect(deliveredUpdates).toHaveLength(100);
        expect(new Set(deliveredUpdates.map((update) => update.id)).size).toBe(100);
        expect(
          events.filter(
            (event) => event.type === "system.update.delivered" && event.turnId === urgent.turn.id,
          ),
        ).toHaveLength(1);
        expect(live.some((event) => event.id === urgent.accepted.id)).toBe(true);
        expect(await getSession(dbClient.db, grant.workspaceId, session.id)).toMatchObject({
          status: "idle",
          activeTurnId: null,
        });
      } finally {
        unsubscribe();
        worker.shutdown();
        await workerRun;
      }
    },
    integrationTimeoutMs,
  );

  test(
    "an exhausted activity receipt recovers through one exact Temporal proof without replay",
    async () => {
      const grant = await testGrant(dbClient.db, "quiescence-receipt-exhaustion");
      const session = await createDurableSession(
        dbClient.db,
        grant,
        "quiescence receipt recovery session",
      );
      const initialText = `receipt exhaustion initial ${crypto.randomUUID()}`;
      const steerText = `receipt exhaustion replacement ${crypto.randomUUID()}`;
      const initial = await submitTestHumanPrompt(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        text: initialText,
        resources: [],
        tools: [],
        operationKey: `receipt-exhaustion-initial-${crypto.randomUUID()}`,
        delivery: "send",
        reasoningEffortFallback: "low",
      });
      const taskQueue = `durable-quiescence-recovery-${crypto.randomUUID()}`;
      const model = new ScriptedModel([
        {
          id: "receipt-exhaustion-original",
          chunks: Array.from({ length: 10_000 }, () => "old-output "),
          delayMs: 10,
        },
        {
          id: "receipt-exhaustion-replacement",
          outputText: "replacement completed after durable receipt recovery",
        },
      ]);
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        temporalTaskQueue: taskQueue,
      });
      const temporal = new Client({ connection });
      const workflowClient = sessionWorkflowClient(temporal, taskQueue);
      const realActivities = createActivityTestHarness({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
        wakeSessionWorkflow: workflowClient.wakeSessionWorkflow,
        signalSessionAttemptQuiesced: workflowClient.signalSessionAttemptQuiesced,
      });
      let recoveryActivityExecutions = 0;
      const activities = {
        ...realActivities,
        persistSessionAttemptQuiescence: async (
          input: Parameters<typeof realActivities.persistSessionAttemptQuiescence>[0],
        ) => {
          recoveryActivityExecutions += 1;
          return await realActivities.persistSessionAttemptQuiescence(input);
        },
      };
      // Three failures exhaust the dying runAgentTurn helper. Three more
      // exhaust the first DB-only control-activity execution. Temporal then
      // retries that exact idempotent activity, whose seventh UPDATE commits.
      const fault = await installQuiescenceReceiptFault(admin, session.id, 6);
      let worker: Awaited<ReturnType<typeof integrationWorker>> | undefined;
      let workerRun: Promise<void> | undefined;

      try {
        worker = await integrationWorker(nativeConnection, taskQueue, activities);
        workerRun = worker.run();
        const handle = await temporal.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: initial.turn.temporalWorkflowId,
          args: [
            {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              sessionId: session.id,
            },
          ],
        });

        await waitFor(() => model.calls === 1);
        const beforeSteer = await getSessionQueueSnapshot(
          dbClient.db,
          grant.workspaceId,
          session.id,
        );
        const urgent = await postUserMessageTurn({
          db: dbClient.db,
          bus,
          workflowClient,
          settings,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          text: steerText,
          resources: [],
          tools: [],
          clientEventId: `receipt-exhaustion-steer-${crypto.randomUUID()}`,
          delivery: "steer",
          controlEtag: beforeSteer!.effectiveControl.controlEtag,
        });

        await handle.result();

        expect(recoveryActivityExecutions).toBe(2);
        expect(await fault.attempts()).toBe(7);
        expect(model.calls).toBe(2);
        const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
        expect(turns).toHaveLength(2);
        expect(turns.find((turn) => turn.id === initial.turn.id)?.status).toBe("superseded");
        expect(turns.find((turn) => turn.id === urgent.turn.id)?.status).toBe("completed");

        const events = await listSessionEvents(
          dbClient.db,
          grant.workspaceId,
          session.id,
          0,
          2_000,
        );
        const quiesced = events.filter(
          (event) =>
            event.type === "session.queue.changed" &&
            event.turnId === initial.turn.id &&
            event.payload.operation === "attempt_quiesced",
        );
        const started = events.filter((event) => event.type === "turn.started");
        expect(quiesced).toHaveLength(1);
        expect(started.map((event) => event.turnId)).toEqual([initial.turn.id, urgent.turn.id]);
        expect(started[1]!.sequence).toBeGreaterThan(quiesced[0]!.sequence);
        expect(
          events.filter(
            (event) =>
              event.type === "agent.message.delta" &&
              event.turnId === initial.turn.id &&
              event.sequence > quiesced[0]!.sequence,
          ),
        ).toHaveLength(0);
        expect(events.filter((event) => event.type.startsWith("tool."))).toHaveLength(0);

        const history = JSON.stringify(
          await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id),
        );
        const replacementRequest = JSON.stringify(model.requests[1]?.input ?? null);
        expect(countOccurrences(history, initialText)).toBe(1);
        expect(countOccurrences(history, steerText)).toBe(1);
        expect(countOccurrences(replacementRequest, initialText)).toBe(1);
        expect(countOccurrences(replacementRequest, steerText)).toBe(1);
        expect(
          await getSessionQueueSnapshot(dbClient.db, grant.workspaceId, session.id),
        ).toMatchObject({
          stoppingPreviousAttempt: false,
          items: [],
        });
        expect(await getSession(dbClient.db, grant.workspaceId, session.id)).toMatchObject({
          status: "idle",
          activeTurnId: null,
        });
      } finally {
        try {
          worker?.shutdown();
          await workerRun;
        } finally {
          await fault.drop();
        }
      }
    },
    integrationTimeoutMs,
  );

  test(
    "a DB-committed lost internal-update wake is repaired without duplicating its inference",
    async () => {
      const grant = await testGrant(dbClient.db, "lost-wake");
      const session = await createDurableSession(dbClient.db, grant, "repair a lost Temporal wake");
      const taskQueue = `durable-lost-wake-${crypto.randomUUID()}`;
      const model = new ScriptedModel("repaired wake consumed once");
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        temporalTaskQueue: taskQueue,
      });
      const temporal = new Client({ connection });
      const workflowClient = sessionWorkflowClient(temporal, taskQueue);
      const activities = createActivityTestHarness({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
        wakeSessionWorkflow: workflowClient.wakeSessionWorkflow,
      });
      const live: SessionEvent[] = [];
      const unsubscribe = await bus.subscribe(grant.workspaceId, session.id, (events) => {
        live.push(...events);
      });

      const input = systemUpdateInput(grant, session.id, "lost-wake:integration", 0);
      const committed = await addSessionSystemUpdate(dbClient.db, input);
      if (committed.reason === "session_cancelled") throw new Error("unexpected cancelled session");
      expect(committed).toMatchObject({ added: true, reason: "added", shouldWake: true });
      const committedEventIds = committed.events.map((event) => event.id);

      // Simulate the process dying after the Postgres commit but before NATS
      // publish / Temporal signal. The replacement worker's bounded durable
      // repair scan must start the claimable session from Postgres truth.
      const firstWorker = await integrationWorker(nativeConnection, taskQueue, activities);
      const firstRun = firstWorker.run();
      firstWorker.shutdown();
      await firstRun;
      const secondWorker = await integrationWorker(nativeConnection, taskQueue, activities);
      const secondRun = secondWorker.run();
      try {
        const duplicate = await addSessionSystemUpdate(dbClient.db, input);
        if (duplicate.reason === "session_cancelled") {
          throw new Error("unexpected cancelled session on duplicate");
        }
        expect(duplicate).toMatchObject({
          added: false,
          reason: "duplicate",
          shouldWake: false,
          update: { id: committed.update.id },
          events: [],
        });
        // Workflow-wake repair has its own ownership-independent dispatcher.
        // The sandbox reaper deliberately no longer scans this outbox: tying
        // inference recovery to sandbox ownership would strand self-hosted and
        // feature-disabled sessions.
        const repair = await activities.dispatchSessionWorkflowWakes();
        // The dispatcher is global, so an earlier test/session may contribute a
        // legitimate pending revision. Assert the dispatcher contract here;
        // the target session's one turn/model call below proves this specific
        // revision was delivered exactly once.
        expect(repair.failed).toBe(0);
        expect(repair.exhaustedBatchLimit).toBe(false);
        expect(repair.claimed).toBeGreaterThanOrEqual(1);
        expect(repair.delivered).toBe(repair.claimed);
        let observedSession: Awaited<ReturnType<typeof getSession>> | null = null;
        await waitFor(
          async () => {
            const current = await getSession(dbClient.db, grant.workspaceId, session.id);
            observedSession = current;
            return (
              model.calls === 1 && (current?.status === "idle" || current?.status === "failed")
            );
          },
          {
            describe: () =>
              JSON.stringify({
                modelCalls: model.calls,
                status: observedSession?.status ?? null,
                activeTurnId: observedSession?.activeTurnId ?? null,
              }),
          },
        );
        if (observedSession?.status === "failed") {
          const failedEvents = await listSessionEvents(
            dbClient.db,
            grant.workspaceId,
            session.id,
            0,
            500,
          );
          throw new Error(
            `repaired inference failed: ${JSON.stringify(
              failedEvents.filter((event) => event.type === "turn.failed"),
            )}`,
          );
        }

        expect(model.calls).toBe(1);
        const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
          source: "system",
          status: "completed",
        });
        expect(
          await listSessionSystemUpdatesForTurn(
            dbClient.db,
            grant.workspaceId,
            session.id,
            turns[0]!.id,
          ),
        ).toHaveLength(1);
        const durable = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500);
        expect(committedEventIds.every((id) => durable.some((event) => event.id === id))).toBe(
          true,
        );
        expect(committedEventIds.every((id) => live.every((event) => event.id !== id))).toBe(true);
        expect(live.some((event) => event.type === "turn.started")).toBe(true);
      } finally {
        unsubscribe();
        secondWorker.shutdown();
        await secondRun;
      }
    },
    integrationTimeoutMs,
  );

  test(
    "Pause reaches quiescence and physically stops the active attempt within two seconds",
    async () => {
      const grant = await testGrant(dbClient.db, "pause-quiescence");
      const session = await createDurableSession(
        dbClient.db,
        grant,
        "keep producing output until paused",
      );
      const initial = await submitTestHumanPrompt(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        text: "keep producing output until paused",
        resources: [],
        tools: [],
        operationKey: `pause-initial-${crypto.randomUUID()}`,
        delivery: "send",
        reasoningEffortFallback: "low",
      });
      const taskQueue = `durable-pause-quiescence-${crypto.randomUUID()}`;
      const model = new ScriptedModel([
        {
          id: "pause-long-running",
          chunks: Array.from({ length: 10_000 }, () => "working "),
          delayMs: 10,
        },
      ]);
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        temporalTaskQueue: taskQueue,
      });
      const temporal = new Client({ connection });
      const workflowClient = sessionWorkflowClient(temporal, taskQueue);
      const activities = createActivityTestHarness({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
        wakeSessionWorkflow: workflowClient.wakeSessionWorkflow,
      });
      const worker = await integrationWorker(nativeConnection, taskQueue, activities);
      const workerRun = worker.run();
      await temporal.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId: initial.turn.temporalWorkflowId,
        args: [
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
          },
        ],
      });

      try {
        await waitFor(() => model.calls === 1);
        const pauseRequestedAt = performance.now();
        const paused = await controlHumanSessionWorkstream(
          {
            db: dbClient.db,
            bus,
            workflowClient: {
              requestSessionWorkflowWakeDispatch: async () => {
                const delivery = await activities.dispatchSessionWorkflowWakes();
                if (delivery.failed > 0 || delivery.exhaustedBatchLimit) {
                  throw new Error(`Pause wake delivery failed: ${JSON.stringify(delivery)}`);
                }
              },
            },
          },
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
            subjectId: grant.subjectId,
          },
          {
            action: "pause",
            reason: "strict physical-cancellation acceptance",
            clientEventId: `pause-quiescence-${crypto.randomUUID()}`,
          },
        );
        expect(paused.interruptionCount).toBe(1);
        expect(paused.effectiveControl.state).toBe("paused");
        let events: SessionEvent[] = [];
        await waitFor(
          async () => {
            events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 2_000);
            const state = await getSession(dbClient.db, grant.workspaceId, session.id);
            return (
              state?.status === "recovering" &&
              events.some(
                (event) =>
                  event.type === "session.queue.changed" &&
                  event.payload.operation === "attempt_quiesced",
              )
            );
          },
          {
            timeoutMs: 2_000,
            intervalMs: 10,
            describe: () =>
              "Pause did not commit both quiescence and logical recovery within the 2s budget",
          },
        );
        expect(performance.now() - pauseRequestedAt).toBeLessThan(2_000);

        const pauseEvent = events.find((event) => event.type === "session.control.paused");
        const quiesced = events.find(
          (event) =>
            event.type === "session.queue.changed" &&
            event.payload.operation === "attempt_quiesced",
        );
        expect(pauseEvent).toBeDefined();
        expect(quiesced).toBeDefined();
        expect(quiesced!.sequence).toBeGreaterThan(pauseEvent!.sequence);
        expect(Date.parse(quiesced!.occurredAt) - Date.parse(pauseEvent!.occurredAt)).toBeLessThan(
          2_000,
        );
        expect(
          events.filter(
            (event) =>
              event.type === "agent.message.delta" &&
              event.turnId === quiesced!.turnId &&
              event.sequence > quiesced!.sequence,
          ),
        ).toHaveLength(0);
        expect(model.calls).toBe(1);
        expect(await getSession(dbClient.db, grant.workspaceId, session.id)).toMatchObject({
          status: "recovering",
        });
      } finally {
        worker.shutdown();
        await workerRun;
      }
    },
    integrationTimeoutMs,
  );

  test(
    "a real heartbeat timeout recovers and completes the same internal-update inference",
    async () => {
      const grant = await testGrant(dbClient.db, "worker-death");
      const session = await createDurableSession(
        dbClient.db,
        grant,
        "recover bundle after worker death",
      );
      const update = await addSessionSystemUpdate(
        dbClient.db,
        systemUpdateInput(grant, session.id, "worker-death:integration", 0),
      );
      if (update.reason === "session_cancelled") {
        throw new Error("expected a pending internal update");
      }
      await bus.publish(grant.workspaceId, session.id, update.events);

      const taskQueue = `durable-worker-death-${crypto.randomUUID()}`;
      const model = new ScriptedModel("recovered after worker death");
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        temporalTaskQueue: taskQueue,
      });
      const temporal = new Client({ connection });
      const workflowClient = sessionWorkflowClient(temporal, taskQueue);
      const realActivities = createActivityTestHarness({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
        wakeSessionWorkflow: workflowClient.wakeSessionWorkflow,
      });
      let dispatches = 0;
      const activities = {
        ...realActivities,
        runAgentTurn: async (input: Parameters<typeof realActivities.runAgentTurn>[0]) => {
          dispatches += 1;
          if (dispatches === 1) {
            const claim = await claimSessionWorkForAttempt(dbClient.db, input.workspaceId, {
              sessionId: input.sessionId,
              workflowId: input.workflowId,
              workflowRunId: currentActivityContext()!.info.workflowExecution.runId,
              attemptId: input.attemptId,
              dispatchId: currentActivityContext()!.info.activityId,
              trigger: input.trigger,
            });
            if (claim.action !== "claimed") {
              return { status: "unclaimed", reason: claim.reason } as const;
            }
            return await hangWithoutHeartbeating();
          }
          return await realActivities.runAgentTurn(input);
        },
      };
      const worker = await integrationWorker(nativeConnection, taskQueue, activities);
      const workerRun = worker.run();
      const live: SessionEvent[] = [];
      const unsubscribe = await bus.subscribe(grant.workspaceId, session.id, (events) => {
        live.push(...events);
      });
      try {
        const handle = await temporal.workflow.signalWithStart("sessionWorkflow", {
          taskQueue,
          workflowId: update.temporalWorkflowId ?? `session-${session.id}`,
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [
            {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              sessionId: session.id,
            },
          ],
          signal: "queueChanged",
        });
        await handle.result();

        expect(dispatches).toBe(2);
        expect(model.calls).toBe(1);
        const [turn] = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
        expect(turn).toMatchObject({
          source: "system",
          status: "completed",
          executionGeneration: 2,
        });
        const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500);
        const recoveries = events.filter((event) => event.type === "turn.recovery.requested");
        expect(recoveries).toHaveLength(1);
        expect(recoveries[0]?.payload).toMatchObject({
          reason: "worker_death",
          redispatches: 1,
        });
        expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(events.some((event) => event.type === "turn.failed")).toBe(false);
        expect(live.some((event) => event.id === recoveries[0]?.id)).toBe(true);
        expect(
          await listSessionSystemUpdatesForTurn(
            dbClient.db,
            grant.workspaceId,
            session.id,
            turn!.id,
          ),
        ).toHaveLength(1);
      } finally {
        unsubscribe();
        worker.shutdown();
        await workerRun;
      }
    },
    workerDeathTimeoutMs,
  );
});

async function requiredServices(): Promise<RequiredServices> {
  const databaseUrl = process.env.OPENGENI_TEST_DATABASE_URL;
  const natsUrl = process.env.OPENGENI_TEST_NATS_URL;
  const temporalHost = process.env.OPENGENI_TEST_TEMPORAL_HOST;
  const configured = [databaseUrl, natsUrl, temporalHost].filter(Boolean).length;
  if (configured !== 0 && configured !== 3) {
    throw new Error(
      "native integration requires OPENGENI_TEST_DATABASE_URL, OPENGENI_TEST_NATS_URL, and OPENGENI_TEST_TEMPORAL_HOST together",
    );
  }
  if (databaseUrl && natsUrl && temporalHost) {
    const migrationUrl = process.env.OPENGENI_TEST_DATABASE_ADMIN_URL ?? databaseUrl;
    return {
      databaseUrl,
      databaseAdminUrl: migrationUrl,
      natsUrl,
      temporalHost,
      migrate: async () => {
        await migrate(migrationUrl);
      },
      down: async () => undefined,
    };
  }
  const started = await startTestServices({ temporal: true });
  return { ...started, databaseAdminUrl: started.databaseUrl };
}

async function testGrant(
  db: ReturnType<typeof createDb>["db"],
  label: string,
): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:durable-queue-integration",
    accountExternalId: `account:${label}:${id}`,
    accountName: "Durable queue integration account",
    workspaceExternalSource: "test:durable-queue-integration",
    workspaceExternalId: `workspace:${label}:${id}`,
    workspaceName: "Durable queue integration workspace",
    subjectId: `test:durable-queue-integration:${label}:${id}`,
    subjectLabel: "Durable queue integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) throw new Error("durable queue integration did not create a workspace grant");
  return grant;
}

async function createDurableSession(
  db: ReturnType<typeof createDb>["db"],
  grant: AccessGrant,
  initialMessage: string,
) {
  return await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage,
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
}

function systemUpdateInput(
  grant: AccessGrant,
  sessionId: string,
  groupingKey: string,
  index: number,
) {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    kind: "child_terminal_result" as const,
    classification: "success" as const,
    sourceId: `child-${index}`,
    dedupeKey: `${groupingKey}:child-${index}`,
    summary: `Child ${index} completed`,
    payload: {
      type: "child_terminal_result" as const,
      childSessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      status: "idle" as const,
    },
    lineage: { childIndex: index },
  };
}

function sessionWorkflowClient(temporal: Client, taskQueue: string) {
  return {
    wakeSessionWorkflow: async (input: {
      accountId: string;
      workspaceId: string;
      sessionId: string;
      workflowId: string;
      interruptionRequested?: boolean;
    }) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue,
        workflowId: input.workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
          },
        ],
        signal: input.interruptionRequested ? "sessionControl" : "queueChanged",
      });
    },
    signalSessionControl: async (input: {
      accountId: string;
      workspaceId: string;
      sessionId: string;
      eventId: string;
      workflowId: string;
    }) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue,
        workflowId: input.workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
          },
        ],
        signal: "sessionControl",
        signalArgs: [input.eventId],
      });
    },
    signalSessionAttemptQuiesced: async (proof: {
      accountId: string;
      workspaceId: string;
      sessionId: string;
      attemptId: string;
      workflowId: string;
      workflowRunId: string;
      activityId: string;
    }) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue,
        workflowId: proof.workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [
          {
            accountId: proof.accountId,
            workspaceId: proof.workspaceId,
            sessionId: proof.sessionId,
          },
        ],
        signal: "sessionAttemptQuiesced",
        signalArgs: [proof],
      });
    },
  };
}

async function installQuiescenceReceiptFault(
  admin: postgres.Sql,
  sessionId: string,
  failures: number,
): Promise<{ attempts: () => Promise<number>; drop: () => Promise<void> }> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const sequence = `quiescence_fault_seq_${suffix}`;
  const triggerFunction = `quiescence_fault_fn_${suffix}`;
  const trigger = `quiescence_fault_tr_${suffix}`;
  await admin.unsafe(`
    create sequence public.${sequence};
    create function public.${triggerFunction}()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog, public
    as $function$
    declare
      fault_attempt bigint;
    begin
      if new.session_id = '${sessionId}'::uuid
         and old.quiesced_at is null
         and new.quiesced_at is not null then
        fault_attempt := nextval('public.${sequence}');
        if fault_attempt <= ${failures} then
          raise exception using
            errcode = '40001',
            message = 'injected quiescence receipt serialization failure';
        end if;
      end if;
      return new;
    end
    $function$;
    create trigger ${trigger}
    before update of quiesced_at on public.session_turn_attempts
    for each row execute function public.${triggerFunction}();
  `);
  return {
    attempts: async () => {
      const [row] = await admin.unsafe<Array<{ last_value: string | number }>>(
        `select last_value from public.${sequence}`,
      );
      return Number(row?.last_value ?? 0);
    },
    drop: async () => {
      await admin
        .unsafe(`
          drop trigger if exists ${trigger} on public.session_turn_attempts;
          drop function if exists public.${triggerFunction}();
          drop sequence if exists public.${sequence};
        `)
        .catch(() => undefined);
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function integrationWorker(
  temporalConnection: NativeConnection,
  taskQueue: string,
  activities: Record<string, (...args: any[]) => Promise<unknown>>,
): Promise<{ run: () => Promise<void>; shutdown: () => void }> {
  const { runAgentTurn, ...controlActivities } = activities;
  if (!runAgentTurn) throw new Error("turn activity is missing from the integration harness");
  const [control, turns] = await Promise.all([
    Worker.create({
      connection: temporalConnection,
      namespace: "default",
      taskQueue,
      workflowsPath: new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname,
      activities: controlActivities,
      maxConcurrentActivityTaskExecutions: CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
    }),
    Worker.create({
      connection: temporalConnection,
      namespace: "default",
      taskQueue: turnTaskQueue(taskQueue),
      activities: { runAgentTurn },
      maxConcurrentActivityTaskExecutions: TURN_WORKER_MAX_CONCURRENT_TURNS,
    }),
  ]);
  return {
    run: async () => {
      await Promise.all([control.run(), turns.run()]);
    },
    shutdown: () => {
      control.shutdown();
      turns.shutdown();
    },
  };
}

async function hangWithoutHeartbeating(): Promise<{ status: "cancelled" }> {
  await new Promise<void>((resolve) => {
    const signal = currentActivityContext()?.cancellationSignal;
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return { status: "cancelled" };
}
