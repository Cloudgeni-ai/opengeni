import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Context, heartbeat } from "@temporalio/activity";
import { Client, Connection, encodePendingActivityState } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { and, eq } from "drizzle-orm";
import {
  addSessionSystemUpdate,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  getSessionQueueSnapshot,
  listOutstandingSessionSystemUpdates,
  listSessionTurns,
  markSessionWorkflowWakeDelivered,
  steerAgentSessionInTransaction,
  withWorkspaceRls,
  type Database,
  type SessionCommandActor,
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
import type { RunAgentTurnInput, RunAgentTurnResult } from "../../apps/worker/src/activities/types";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "../../apps/worker/src/concurrency";
import { turnTaskQueue } from "../../apps/worker/src/workflows/activities";
import * as schema from "../../packages/db/src/schema";
import { submitTestHumanPrompt } from "./helpers/session-control";

const fixtureTimeoutMs = 180_000;
const failedWorkflowFixtureTimeoutMs = 300_000;
type RequiredServices = Pick<
  TestServices,
  "databaseUrl" | "natsUrl" | "temporalHost" | "migrate" | "down"
>;

describe("OPE-75 Agent Steer cancellation deadlock production fixture", () => {
  let services: RequiredServices;
  let dbClient: ReturnType<typeof createDb>;
  let bus: EventBus;
  let connection: Connection;
  let nativeConnection: NativeConnection;

  beforeAll(async () => {
    services = await requiredServices();
    await services.migrate();
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
    await services?.down();
  }, 60_000);

  test(
    "materialization remains blocked while the superseded activity is CANCEL_REQUESTED and heartbeating",
    async () => {
      const suffix = crypto.randomUUID();
      const access = await bootstrapWorkspace(dbClient.db, {
        accountExternalSource: "test",
        accountExternalId: `ope75-account-${suffix}`,
        accountName: "OPE-75 cancellation fixture",
        workspaceExternalSource: "test",
        workspaceExternalId: `ope75-workspace-${suffix}`,
        workspaceName: "OPE-75 cancellation fixture",
        subjectId: `ope75-subject-${suffix}`,
      });
      const grant = access.workspaceGrants[0]!;
      const workspaceId = grant.workspaceId!;

      // Agent Steer authority is attempt-fenced. Keep a separate caller attempt
      // current while the target workflow owns the deliberately stuck attempt.
      const caller = await createSession(dbClient.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "caller",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      await submitTestHumanPrompt(dbClient.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: caller.id,
        subjectId: grant.subjectId,
        text: "caller is working",
        resources: [],
        tools: [],
        reasoningEffortFallback: "low",
      });
      const callerAttemptId = crypto.randomUUID();
      const callerClaim = await claimSessionWorkForAttempt(dbClient.db, workspaceId, {
        sessionId: caller.id,
        workflowId: `session-${caller.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: callerAttemptId,
        dispatchId: `caller-${callerAttemptId}`,
        trigger: { kind: "next" },
      });
      if (callerClaim.action !== "claimed") {
        throw new Error(`Caller attempt was not claimed: ${callerClaim.reason}`);
      }
      const actor: Extract<SessionCommandActor, { type: "agent_attempt" }> = {
        type: "agent_attempt",
        sessionId: caller.id,
        turnId: callerClaim.turn.id,
        attemptId: callerAttemptId,
        executionGeneration: callerClaim.turn.executionGeneration,
      };

      const target = await createSession(dbClient.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "target",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      await submitTestHumanPrompt(dbClient.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: target.id,
        subjectId: grant.subjectId,
        text: "continue the long-running target work",
        resources: [],
        tools: [],
        reasoningEffortFallback: "low",
      });

      const taskQueue = `ope75-cancellation-${crypto.randomUUID()}`;
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        temporalTaskQueue: taskQueue,
      });
      const model = new ScriptedModel([
        { id: "replacement-completed", outputText: "replacement completed exactly once" },
      ]);
      const activities = createActivityTestHarness({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({
          // The first manually claimed activity never invokes a provider. The
          // real activity consumes this sole response for the replacement.
          model,
        }),
      });
      const realRunAgentTurn = activities.runAgentTurn;

      let releaseZombie = false;
      let heartbeats = 0;
      let replacementDispatches = 0;
      let targetClaim:
        | Extract<Awaited<ReturnType<typeof claimSessionWorkForAttempt>>, { action: "claimed" }>
        | undefined;
      const ignoreCancellation = async (input: RunAgentTurnInput): Promise<RunAgentTurnResult> => {
        if (targetClaim) {
          replacementDispatches += 1;
          return await realRunAgentTurn(input);
        }
        const activityId = Context.current().info.activityId;
        const claim = await claimSessionWorkForAttempt(dbClient.db, input.workspaceId, {
          sessionId: input.sessionId,
          workflowId: input.workflowId,
          workflowRunId: input.workflowRunId,
          attemptId: input.attemptId,
          dispatchId: activityId,
          trigger: input.trigger,
        });
        if (claim.action !== "claimed") {
          return { status: "unclaimed", reason: claim.reason };
        }
        targetClaim = claim;
        for (;;) {
          if (releaseZombie) break;
          heartbeats += 1;
          heartbeat({
            attemptId: input.attemptId,
            activityId,
            heartbeats,
            phase: "model_call",
          });
          // Deliberately ignore Context.current().cancelled and the activity
          // cancellation signal. This is the production failure condition.
          await Bun.sleep(25);
        }
        return {
          status: "idle",
          turnId: claim.turn.id,
          attemptId: input.attemptId,
        };
      };

      const worker = await fixtureWorker(nativeConnection, taskQueue, {
        ...activities,
        runAgentTurn: ignoreCancellation,
      });
      const workerRun = worker.run();
      const client = new Client({ connection });
      const workflowId = `session-${target.id}`;
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId: target.id,
          },
        ],
      });

      let pendingActivityId: string | undefined;
      try {
        await waitFor(() => targetClaim !== undefined && heartbeats >= 3);

        // Six ordinary updates plus the canonical Agent Steer instruction
        // reproduce the seven pending updates in the recorded fixture.
        for (let index = 0; index < 6; index += 1) {
          const update = await addSessionSystemUpdate(dbClient.db, {
            accountId: grant.accountId,
            workspaceId,
            sessionId: target.id,
            kind: "agent_message",
            classification: "info",
            sourceId: `fixture-source-${index}`,
            dedupeKey: `ope75-update-${index}-${suffix}`,
            summary: `pending fixture update ${index}`,
            payload: {
              type: "agent_message",
              text: `pending fixture update ${index}`,
              operationId: crypto.randomUUID(),
            },
          });
          expect(update.reason).toBe("added");
        }

        const steered = await withWorkspaceRls(dbClient.db, workspaceId, (scoped) =>
          scoped.transaction((tx) =>
            steerAgentSessionInTransaction(tx as unknown as Database, {
              accountId: grant.accountId,
              workspaceId,
              targetSessionId: target.id,
              actor,
              operationKey: `ope75-steer-${suffix}`,
              instruction: "replace the superseded direction exactly once",
            }),
          ),
        );
        expect(steered.interruptionCount).toBe(1);
        expect(steered.wakeRevision).toBeGreaterThan(0);
        await handle.signal("sessionControl");
        const wakeDelivery = await markSessionWorkflowWakeDelivered(dbClient.db, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: target.id,
          temporalWorkflowId: workflowId,
          wakeRevision: steered.wakeRevision,
        });
        expect(wakeDelivery).toEqual({
          action: "pending_admission",
          blocker: "pending_agent_steer",
        });

        // The workflow logically settles Steer before waiting forever for the
        // activity promise. This is the exact split-brain production state.
        await waitFor(async () => {
          const session = await getSession(dbClient.db, workspaceId, target.id);
          return session?.status === "queued" && session.activeTurnId === null;
        });
        await Bun.sleep(300);

        const description = await handle.describe();
        const pending = description.raw.pendingActivities?.find(
          (activity) => activity.activityType?.name === "runAgentTurn",
        );
        expect(pending?.state).toBe(encodePendingActivityState("CANCEL_REQUESTED"));
        pendingActivityId = pending?.activityId;
        expect(pendingActivityId).toBeTruthy();

        const beatsAfterCancelRequest = heartbeats;
        await waitFor(() => heartbeats >= beatsAfterCancelRequest + 3);

        const [session, turns, updates, queue, rows] = await Promise.all([
          getSession(dbClient.db, workspaceId, target.id),
          listSessionTurns(dbClient.db, workspaceId, target.id),
          listOutstandingSessionSystemUpdates(dbClient.db, workspaceId, target.id),
          getSessionQueueSnapshot(dbClient.db, workspaceId, target.id),
          withWorkspaceRls(dbClient.db, workspaceId, async (scoped) => {
            const [attempt] = await scoped
              .select()
              .from(schema.sessionTurnAttempts)
              .where(eq(schema.sessionTurnAttempts.id, targetClaim!.turn.activeAttemptId!));
            const [interruption] = await scoped
              .select()
              .from(schema.sessionAttemptInterruptions)
              .where(
                and(
                  eq(schema.sessionAttemptInterruptions.sessionId, target.id),
                  eq(
                    schema.sessionAttemptInterruptions.attemptId,
                    targetClaim!.turn.activeAttemptId!,
                  ),
                ),
              );
            const [wake] = await scoped
              .select()
              .from(schema.sessionWorkflowWakeOutbox)
              .where(eq(schema.sessionWorkflowWakeOutbox.sessionId, target.id));
            return { attempt, interruption, wake };
          }),
        ]);

        expect(session).toMatchObject({
          status: "queued",
          activeTurnId: null,
          queueHeadPosition: 0,
          queueTailPosition: 1,
        });
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
          id: targetClaim!.turn.id,
          status: "superseded",
          activeAttemptId: null,
        });
        expect(updates).toHaveLength(7);
        expect(updates.filter((update) => update.kind === "agent_steer_instruction")).toHaveLength(
          1,
        );
        expect(updates.every((update) => update.state === "pending")).toBe(true);
        // Agent Steer has no visible user/API replacement row yet, but the
        // latest interruption still truthfully reports the unquiesced fence.
        expect(queue).toMatchObject({ items: [], stoppingPreviousAttempt: true });
        expect(rows.attempt).toMatchObject({
          state: "closed",
          outcome: "superseded",
          quiescedAt: null,
          temporalActivityId: pendingActivityId,
        });
        expect(rows.interruption).toMatchObject({
          kind: "steer",
          state: "settled",
        });
        expect(rows.wake?.deliveredRevision).toBeLessThan(rows.wake?.wakeRevision ?? 0);

        // Current v2 closes after its bounded cancellation wait without
        // waiting for the cancellation-ignoring activity to terminalize. The
        // exact activity must remain visible in Temporal and physically keep
        // heartbeating while the predecessor fence remains closed.
        await handle.result();
        const completedDescription = await handle.describe();
        expect(completedDescription.status.name).toBe("COMPLETED");
        const pendingAfterWorkflowClose = completedDescription.raw.pendingActivities?.find(
          (activity) => activity.activityId === pendingActivityId,
        );
        expect(pendingAfterWorkflowClose?.activityId).toBe(pendingActivityId);
        expect(pendingAfterWorkflowClose?.state).toBe(
          encodePendingActivityState("CANCEL_REQUESTED"),
        );

        const beatsAtWorkflowClose = heartbeats;
        await waitFor(() => heartbeats >= beatsAtWorkflowClose + 3);
        expect(replacementDispatches).toBe(0);
        expect(model.calls).toBe(0);
      } finally {
        releaseZombie = true;
        try {
          await handle.terminate("OPE-75 fixture final cleanup");
        } catch {
          // The workflow already completed naturally after exact-activity cleanup.
        }
        worker.shutdown();
        await workerRun;
      }
    },
    fixtureTimeoutMs,
  );

  test(
    "a bounded cancellation close leaves the receipt fence closed while the activity remains pending",
    async () => {
      const suffix = crypto.randomUUID();
      const access = await bootstrapWorkspace(dbClient.db, {
        accountExternalSource: "test",
        accountExternalId: `ope75-failed-account-${suffix}`,
        accountName: "OPE-75 failed workflow fixture",
        workspaceExternalSource: "test",
        workspaceExternalId: `ope75-failed-workspace-${suffix}`,
        workspaceName: "OPE-75 failed workflow fixture",
        subjectId: `ope75-failed-subject-${suffix}`,
      });
      const grant = access.workspaceGrants[0]!;
      const workspaceId = grant.workspaceId!;

      const caller = await createSession(dbClient.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "caller",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      await submitTestHumanPrompt(dbClient.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: caller.id,
        subjectId: grant.subjectId,
        text: "caller is working",
        resources: [],
        tools: [],
        reasoningEffortFallback: "low",
      });
      const callerAttemptId = crypto.randomUUID();
      const callerClaim = await claimSessionWorkForAttempt(dbClient.db, workspaceId, {
        sessionId: caller.id,
        workflowId: `session-${caller.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: callerAttemptId,
        dispatchId: `caller-${callerAttemptId}`,
        trigger: { kind: "next" },
      });
      if (callerClaim.action !== "claimed") {
        throw new Error(`Caller attempt was not claimed: ${callerClaim.reason}`);
      }
      const actor: Extract<SessionCommandActor, { type: "agent_attempt" }> = {
        type: "agent_attempt",
        sessionId: caller.id,
        turnId: callerClaim.turn.id,
        attemptId: callerAttemptId,
        executionGeneration: callerClaim.turn.executionGeneration,
      };

      const target = await createSession(dbClient.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "target",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      await submitTestHumanPrompt(dbClient.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: target.id,
        subjectId: grant.subjectId,
        text: "continue the target work before cancellation timeout",
        resources: [],
        tools: [],
        reasoningEffortFallback: "low",
      });

      const taskQueue = `ope75-failed-workflow-${crypto.randomUUID()}`;
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        temporalTaskQueue: taskQueue,
      });
      const model = new ScriptedModel([
        { id: "must-not-run", outputText: "replacement must remain blocked" },
      ]);
      const activities = createActivityTestHarness({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });
      const realRunAgentTurn = activities.runAgentTurn;

      let stopHeartbeats = false;
      let releaseHungActivity = false;
      let heartbeats = 0;
      let hungTicks = 0;
      let replacementDispatches = 0;
      let targetClaim:
        | Extract<Awaited<ReturnType<typeof claimSessionWorkForAttempt>>, { action: "claimed" }>
        | undefined;
      const ignoreCancellationWhilePending = async (
        input: RunAgentTurnInput,
      ): Promise<RunAgentTurnResult> => {
        if (targetClaim) {
          replacementDispatches += 1;
          return await realRunAgentTurn(input);
        }
        const activityId = Context.current().info.activityId;
        const claim = await claimSessionWorkForAttempt(dbClient.db, input.workspaceId, {
          sessionId: input.sessionId,
          workflowId: input.workflowId,
          workflowRunId: input.workflowRunId,
          attemptId: input.attemptId,
          dispatchId: activityId,
          trigger: input.trigger,
        });
        if (claim.action !== "claimed") {
          return { status: "unclaimed", reason: claim.reason };
        }
        targetClaim = claim;
        for (;;) {
          if (releaseHungActivity) break;
          hungTicks += 1;
          if (!stopHeartbeats) {
            heartbeats += 1;
            heartbeat({
              attemptId: input.attemptId,
              activityId,
              heartbeats,
              phase: "sandbox_command",
            });
          }
          // Ignore both Temporal cancellation and the activity AbortSignal.
          // The fixture intentionally does not wait for the real heartbeat
          // timeout after stopping acknowledgements.
          await Bun.sleep(25);
        }
        return {
          status: "idle",
          turnId: claim.turn.id,
          attemptId: input.attemptId,
        };
      };

      const worker = await fixtureWorker(nativeConnection, taskQueue, {
        ...activities,
        runAgentTurn: ignoreCancellationWhilePending,
      });
      const workerRun = worker.run();
      const client = new Client({ connection });
      const workflowId = `session-${target.id}`;
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId: target.id,
          },
        ],
      });

      let pendingActivityId: string | undefined;
      try {
        await waitFor(() => targetClaim !== undefined && heartbeats >= 3);

        const steered = await withWorkspaceRls(dbClient.db, workspaceId, (scoped) =>
          scoped.transaction((tx) =>
            steerAgentSessionInTransaction(tx as unknown as Database, {
              accountId: grant.accountId,
              workspaceId,
              targetSessionId: target.id,
              actor,
              operationKey: `ope75-failed-steer-${suffix}`,
              instruction: "deliver this existing direction exactly once after typed recovery",
            }),
          ),
        );
        expect(steered.interruptionCount).toBe(1);
        expect(steered.wakeRevision).toBeGreaterThan(0);
        await handle.signal("sessionControl");
        const wakeDelivery = await markSessionWorkflowWakeDelivered(dbClient.db, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: target.id,
          temporalWorkflowId: workflowId,
          wakeRevision: steered.wakeRevision,
        });
        expect(wakeDelivery).toEqual({
          action: "pending_admission",
          blocker: "pending_agent_steer",
        });

        await waitFor(async () => {
          const description = await handle.describe();
          const pending = description.raw.pendingActivities?.find(
            (activity) => activity.activityType?.name === "runAgentTurn",
          );
          pendingActivityId = pending?.activityId;
          return pending?.state === encodePendingActivityState("CANCEL_REQUESTED");
        });
        expect(pendingActivityId).toBeTruthy();

        // Stop acknowledging the server heartbeat contract without allowing
        // the local function to settle. The receipt-gated workflow closes its
        // run after the bounded cancellation wait; it must not infer a
        // physical stop or admit replacement work from that closure.
        stopHeartbeats = true;
        const beatsAtStop = heartbeats;
        await handle.result();
        expect(heartbeats).toBe(beatsAtStop);
        const completedDescription = await handle.describe();
        expect(completedDescription.status.name).toBe("COMPLETED");
        const pendingAfterWorkflowClose = completedDescription.raw.pendingActivities?.find(
          (activity) => activity.activityId === pendingActivityId,
        );
        expect(pendingAfterWorkflowClose?.activityId).toBe(pendingActivityId);
        expect(pendingAfterWorkflowClose?.state).toBe(
          encodePendingActivityState("CANCEL_REQUESTED"),
        );

        // The bounded workflow close is not a heartbeat timeout or physical
        // quiescence proof. The disposable loop remains live until exact
        // cleanup releases its gate.
        const ticksAtWorkflowClose = hungTicks;
        await waitFor(() => hungTicks >= ticksAtWorkflowClose + 3);
        expect(replacementDispatches).toBe(0);
        expect(model.calls).toBe(0);
      } finally {
        releaseHungActivity = true;
        try {
          await handle.terminate("OPE-75 failed-workflow fixture final cleanup");
        } catch {
          // The workflow already closed after its bounded cancellation wait.
        }
        worker.shutdown();
        await workerRun;
      }
    },
    failedWorkflowFixtureTimeoutMs,
  );
});

async function fixtureWorker(
  nativeConnection: NativeConnection,
  taskQueue: string,
  activities: Record<string, (...args: any[]) => Promise<unknown>>,
): Promise<{ run: () => Promise<void>; shutdown: () => void }> {
  const defaults = {
    enqueueGoalRetryWake: async () => undefined,
    maybeContinueGoal: async () => ({ action: "none" }),
    getCodexCapacityWait: async () => null,
    reconcileCodexCapacityWait: async () => ({ action: "stale" }),
    ...activities,
  };
  const { runAgentTurn, ...controlActivities } = defaults;
  if (!runAgentTurn) throw new Error("turn activity is missing from OPE-75 fixture");
  const [control, turns] = await Promise.all([
    Worker.create({
      connection: nativeConnection,
      namespace: "default",
      taskQueue,
      workflowsPath: new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname,
      activities: controlActivities,
      maxConcurrentActivityTaskExecutions: CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
    }),
    Worker.create({
      connection: nativeConnection,
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

async function requiredServices(): Promise<RequiredServices> {
  const databaseUrl = process.env.OPENGENI_TEST_DATABASE_URL;
  const natsUrl = process.env.OPENGENI_TEST_NATS_URL;
  const temporalHost = process.env.OPENGENI_TEST_TEMPORAL_HOST;
  const configured = [databaseUrl, natsUrl, temporalHost].filter(Boolean).length;
  if (configured !== 0 && configured !== 3) {
    throw new Error(
      "OPE-75 fixture requires OPENGENI_TEST_DATABASE_URL, OPENGENI_TEST_NATS_URL, and OPENGENI_TEST_TEMPORAL_HOST together",
    );
  }
  if (databaseUrl && natsUrl && temporalHost) {
    const migrationUrl = process.env.OPENGENI_TEST_DATABASE_ADMIN_URL ?? databaseUrl;
    return {
      databaseUrl,
      natsUrl,
      temporalHost,
      migrate: async () => {
        await migrate(migrationUrl);
      },
      down: async () => undefined,
    };
  }
  return await startTestServices({ temporal: true });
}
