import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Context, heartbeat } from "@temporalio/activity";
import {
  ActivityNotFoundError,
  AsyncCompletionClient,
  Client,
  Connection,
  encodePendingActivityState,
} from "@temporalio/client";
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
      const asyncCompletion = new AsyncCompletionClient({
        connection,
        namespace: "default",
      });
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
        await markSessionWorkflowWakeDelivered(dbClient.db, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: target.id,
          temporalWorkflowId: workflowId,
          wakeRevision: steered.wakeRevision,
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
        // Agent Steer has no visible user/API replacement row yet, so the
        // public queue currently reports no stop even though Temporal and the
        // attempt receipt below prove that the predecessor is not quiesced.
        expect(queue).toMatchObject({ items: [], stoppingPreviousAttempt: false });
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
        expect(rows.wake?.wakeRevision).toBe(rows.wake?.deliveredRevision);

        let workflowSettled = false;
        const workflowResult = handle.result().finally(() => {
          workflowSettled = true;
        });
        await Bun.sleep(300);
        expect(workflowSettled).toBe(false);

        // Terminalize only this exact Temporal activity. This must release the
        // workflow's WAIT_CANCELLATION_COMPLETED promise without terminating
        // the workflow itself.
        const fullActivityId = {
          workflowId,
          runId: handle.firstExecutionRunId,
          activityId: pendingActivityId!,
        };
        await asyncCompletion.reportCancellation(fullActivityId, { fixtureCleanup: "OPE-75" });

        await waitFor(async () => {
          const current = await handle.describe();
          return !current.raw.pendingActivities?.some(
            (activity) => activity.activityId === pendingActivityId,
          );
        });
        await expect(
          asyncCompletion.heartbeat(fullActivityId, {
            fixtureProbe: "after-exact-terminalization",
          }),
        ).rejects.toBeInstanceOf(ActivityNotFoundError);

        // Temporal terminalization is not physical quiescence. The local
        // activity body still executes, but its worker heartbeat helper has no
        // per-call acknowledgement. The by-ID probe above is the independent
        // server-side proof that the activity is no longer pending.
        const beatsAtTemporalTerminalization = heartbeats;
        await waitFor(() => heartbeats >= beatsAtTemporalTerminalization + 3);

        // The workflow must progress naturally after exact terminalization;
        // terminating it here would hide the production deadlock boundary.
        const workflowProgress = await Promise.race([
          workflowResult.then(() => "settled" as const),
          Bun.sleep(15_000).then(() => "timed_out" as const),
        ]);
        expect(workflowProgress).toBe("settled");
        expect(workflowSettled).toBe(true);
        expect(replacementDispatches).toBe(1);
        expect(model.calls).toBe(1);

        // This records a second current defect rather than endorsing it: the
        // workflow fallback equates Temporal's cancellation result with a
        // physical stop and writes quiesced_at even though the zombie proof
        // above shows the activity body is still executing.
        const [finalSession, finalTurns, finalOutstandingUpdates, finalQueue, finalRows] =
          await Promise.all([
            getSession(dbClient.db, workspaceId, target.id),
            listSessionTurns(dbClient.db, workspaceId, target.id),
            listOutstandingSessionSystemUpdates(dbClient.db, workspaceId, target.id),
            getSessionQueueSnapshot(dbClient.db, workspaceId, target.id),
            withWorkspaceRls(dbClient.db, workspaceId, async (scoped) => {
              const attempts = await scoped
                .select()
                .from(schema.sessionTurnAttempts)
                .where(eq(schema.sessionTurnAttempts.sessionId, target.id));
              const allUpdates = await scoped
                .select()
                .from(schema.sessionSystemUpdates)
                .where(eq(schema.sessionSystemUpdates.sessionId, target.id));
              const [interruption] = await scoped
                .select()
                .from(schema.sessionAttemptInterruptions)
                .where(eq(schema.sessionAttemptInterruptions.sessionId, target.id));
              const [wake] = await scoped
                .select()
                .from(schema.sessionWorkflowWakeOutbox)
                .where(eq(schema.sessionWorkflowWakeOutbox.sessionId, target.id));
              return { attempts, allUpdates, interruption, wake };
            }),
          ]);
        const replacementTurn = finalTurns.find((turn) => turn.id !== targetClaim!.turn.id);
        const terminalizedAttempt = finalRows.attempts.find(
          (attempt) => attempt.id === targetClaim!.turn.activeAttemptId,
        );
        const replacementAttempt = finalRows.attempts.find(
          (attempt) => attempt.turnId === replacementTurn?.id,
        );

        expect(finalSession).toMatchObject({
          status: "idle",
          activeTurnId: null,
          queueHeadPosition: 0,
          queueTailPosition: 1,
        });
        expect(finalTurns).toHaveLength(2);
        expect(replacementTurn).toMatchObject({ source: "system", status: "completed" });
        expect(finalOutstandingUpdates).toHaveLength(0);
        expect(finalRows.allUpdates).toHaveLength(7);
        expect(
          finalRows.allUpdates.every(
            (update) =>
              update.state === "delivered" &&
              update.deliveredTurnId === replacementTurn?.id &&
              update.deliveredAt !== null,
          ),
        ).toBe(true);
        expect(
          finalRows.allUpdates.filter((update) => update.kind === "agent_steer_instruction"),
        ).toHaveLength(1);
        expect(finalRows.attempts).toHaveLength(2);
        expect(terminalizedAttempt).toMatchObject({
          state: "closed",
          outcome: "superseded",
        });
        expect(terminalizedAttempt?.quiescedAt).not.toBeNull();
        expect(replacementAttempt).toMatchObject({
          state: "closed",
          outcome: "completed",
        });
        expect(finalRows.interruption).toMatchObject({ kind: "steer", state: "settled" });
        expect(finalRows.wake?.wakeRevision).toBe(finalRows.wake?.deliveredRevision);
        expect(finalQueue).toMatchObject({ items: [], stoppingPreviousAttempt: false });
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
