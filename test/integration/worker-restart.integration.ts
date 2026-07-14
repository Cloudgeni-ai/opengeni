import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { AccessGrant } from "@opengeni/contracts";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  createDb,
  createSession,
  enqueueSessionMessageAtomically,
  getSession,
  getSessionHistoryItems,
  listSessionEvents,
  listSessionTurns,
  requestSessionControl,
} from "@opengeni/db";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import {
  functionCall,
  latestStatus,
  ScriptedModel,
  startTestMcpServer,
  startTestServices,
  testSettings,
  waitFor,
  type TestServices,
} from "@opengeni/testing";
import { postUserMessageTurn } from "@opengeni/core";
import type { SessionWorkflowClient } from "../../apps/api/src/app";
import { createActivities } from "../../apps/worker/src/activities";
import { currentActivityContext } from "../../apps/worker/src/activities/streaming";

// Proves the campaign's robustness contract: a worker rollout restart
// (graceful SIGTERM shutdown) mid-turn must not produce a failed session.
// The in-flight turn checkpoints, re-queues, and a second worker resumes it
// from persisted conversation truth — without re-executing side effects the
// first attempt already performed.
describe("worker restart resilience", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let bus: EventBus;
  let connection: Connection;
  let nativeConnection: NativeConnection;

  beforeAll(async () => {
    services = await startTestServices({ temporal: true });
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

  test("graceful worker shutdown mid-turn recovers the same turn on a healthy worker", async () => {
    const grant = await testGrant();
    const mcp = startTestMcpServer();
    const taskQueue = `worker-restart-${crypto.randomUUID()}`;
    const model = new ScriptedModel([
      // Model call 1: completes and triggers a side-effectful MCP tool call,
      // so the turn has checkpointed progress before the restart.
      {
        id: "restart-call-1",
        output: [
          functionCall("docs__search_documents", { query: "current state" }, "call-restart-1"),
        ],
      },
      // Model call 2: streams far longer than the test; the worker shuts down
      // while this response is in flight, so it is the lost model step.
      {
        id: "restart-call-2",
        chunks: Array.from({ length: 10_000 }, () => "tick "),
        delayMs: 50,
        outputText: "never finished",
      },
      // Model call 3: the resumed attempt's response on the second worker.
      {
        id: "restart-call-3",
        outputText: "resumed and finished",
        chunks: ["resumed ", "and ", "finished"],
      },
    ]);
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      temporalTaskQueue: taskQueue,
      mcpServers: [
        {
          id: "docs",
          name: "Document Search",
          url: mcp.url,
          allowedTools: ["search_documents"],
          cacheToolsList: false,
        },
      ],
    });
    const activities = createActivities({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "do the work",
      resources: [],
      tools: [{ kind: "mcp", id: "docs" }],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const workflowId = `session-${session.id}`;
    const accepted = await enqueueSessionMessageAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: grant.subjectId,
      origin: "human",
      text: "do the work",
      resources: [],
      tools: [{ kind: "mcp", id: "docs" }],
      delivery: "queue",
      reasoningEffortFallback: settings.openaiReasoningEffort,
    });

    const firstWorker = await restartTestWorker(nativeConnection, taskQueue, activities);
    const firstRun = firstWorker.run();
    const client = new Client({ connection });
    const handle = await client.workflow.start("sessionWorkflow", {
      taskQueue,
      workflowId,
      args: [{ accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id }],
    });

    // Wait until the side effect ran, its progress was checkpointed to items,
    // and the second (slow) model call is in flight — then pull the plug.
    await waitFor(() => mcp.calls.length === 1);
    await waitFor(
      async () =>
        (await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id)).length > 0,
    );
    await waitFor(() => model.calls === 2);
    firstWorker.shutdown();
    await firstRun;

    // Between workers the same logical turn is recoverable, not converted into
    // queue work and not failed.
    const recovering = await getSession(dbClient.db, grant.workspaceId, session.id);
    expect(recovering?.status).toBe("recovering");
    const turnsAfterShutdown = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turnsAfterShutdown.map((turn) => turn.status)).toEqual(["recovering"]);
    expect(turnsAfterShutdown[0]?.id).toBe(accepted.turn.id);
    const eventsAfterShutdown = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      session.id,
      0,
      200,
    );
    expect(eventsAfterShutdown.some((event) => event.type === "turn.recovery.requested")).toBe(
      true,
    );
    expect(eventsAfterShutdown.some((event) => event.type === "turn.failed")).toBe(false);

    const secondWorker = await restartTestWorker(nativeConnection, taskQueue, activities);
    const secondRun = secondWorker.run();
    try {
      await handle.result();
    } finally {
      secondWorker.shutdown();
      await secondRun;
      mcp.close();
    }

    const resumed = await getSession(dbClient.db, grant.workspaceId, session.id);
    expect(resumed?.status).toBe("idle");
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns.map((turn) => turn.status)).toEqual(["completed"]);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(1);
    expect(latestStatus(events)).toBe("idle");
    // The new attempt receives the same canonical conversation truth, without
    // a fabricated recovery message.
    expect(model.calls).toBe(3);
    const resumeRequest = JSON.stringify(
      (model.requests.at(-1) as { input?: unknown })?.input ?? "",
    );
    expect(resumeRequest).toContain("do the work");
    expect(resumeRequest).toContain("call-restart-1");
    // ...and did not blindly replay the already-executed side effect.
    expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "current state" } }]);
    expect(
      events.some(
        (event) =>
          event.type === "agent.message.completed" &&
          JSON.stringify(event.payload).includes("resumed and finished"),
      ),
    ).toBe(true);
  }, 180_000);

  test("graceful worker shutdown before model progress recovers the same turn untouched", async () => {
    const grant = await testGrant();
    const taskQueue = `worker-restart-early-${crypto.randomUUID()}`;
    const model = new ScriptedModel([
      // The only model call: the first attempt is interrupted before it ever
      // reaches the model, so the rerun replays the original trigger cleanly.
      { id: "early-call-1", outputText: "did the work", chunks: ["did ", "the ", "work"] },
    ]);
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      temporalTaskQueue: taskQueue,
    });
    const activities = createActivities({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    let turnDispatches = 0;
    const gatedActivities = {
      ...activities,
      // The first dispatch holds the agent-turn activity in its setup window
      // (before turn.started is published) until the worker's graceful
      // shutdown has delivered cancellation — deterministically landing the
      // shutdown before the turn visibly started. The same turn must become
      // recoverable, not fail or enter the prompt queue again.
      runAgentTurn: async (input: Parameters<typeof activities.runAgentTurn>[0]) => {
        turnDispatches += 1;
        if (turnDispatches === 1) {
          await new Promise<void>((resolve) => {
            const signal = currentActivityContext()?.cancellationSignal;
            if (!signal || signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return await activities.runAgentTurn(input);
      },
    };
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "do the early work",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const workflowId = `session-${session.id}`;
    const accepted = await enqueueSessionMessageAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: grant.subjectId,
      origin: "human",
      text: "do the early work",
      resources: [],
      tools: [],
      delivery: "queue",
      reasoningEffortFallback: settings.openaiReasoningEffort,
    });

    const firstWorker = await restartTestWorker(nativeConnection, taskQueue, gatedActivities);
    const firstRun = firstWorker.run();
    const client = new Client({ connection });
    const handle = await client.workflow.start("sessionWorkflow", {
      taskQueue,
      workflowId,
      args: [{ accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id }],
    });

    // Pull the plug while the turn activity is still in setup.
    try {
      await waitFor(() => turnDispatches === 1);
    } finally {
      firstWorker.shutdown();
      await firstRun;
    }

    // Between workers the turn is recoverable; nothing else happened, so the
    // next attempt reuses its original trigger and canonical prompt.
    const recovering = await getSession(dbClient.db, grant.workspaceId, session.id);
    expect(recovering?.status).toBe("recovering");
    const turnsAfterShutdown = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turnsAfterShutdown.map((turn) => turn.status)).toEqual(["recovering"]);
    expect(turnsAfterShutdown[0]?.id).toBe(accepted.turn.id);
    expect(turnsAfterShutdown[0]?.triggerEventId).toBe(accepted.accepted.id);
    const eventsAfterShutdown = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      session.id,
      0,
      200,
    );
    expect(eventsAfterShutdown.some((event) => event.type === "turn.recovery.requested")).toBe(
      true,
    );
    expect(eventsAfterShutdown.some((event) => event.type === "turn.started")).toBe(false);
    expect(eventsAfterShutdown.some((event) => event.type === "turn.failed")).toBe(false);
    expect(model.calls).toBe(0);

    const secondWorker = await restartTestWorker(nativeConnection, taskQueue, gatedActivities);
    const secondRun = secondWorker.run();
    try {
      await handle.result();
    } finally {
      secondWorker.shutdown();
      await secondRun;
    }

    const finished = await getSession(dbClient.db, grant.workspaceId, session.id);
    expect(finished?.status).toBe("idle");
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns.map((turn) => turn.status)).toEqual(["completed"]);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500);
    expect(events.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(latestStatus(events)).toBe("idle");
    // The next attempt entered through the original trigger without a synthetic message.
    expect(model.calls).toBe(1);
    const rerunRequest = JSON.stringify(
      (model.requests.at(-1) as { input?: unknown })?.input ?? "",
    );
    expect(rerunRequest).toContain("do the early work");
    expect(
      events.some(
        (event) =>
          event.type === "agent.message.completed" &&
          JSON.stringify(event.payload).includes("did the work"),
      ),
    ).toBe(true);
  }, 180_000);

  test("a late activity settlement after Pause is stale and cannot override recovery truth", async () => {
    const grant = await testGrant();
    const taskQueue = `pause-zombie-race-${crypto.randomUUID()}`;
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      temporalTaskQueue: taskQueue,
    });
    const model = new ScriptedModel([
      {
        id: "pause-zombie-call",
        chunks: Array.from({ length: 10_000 }, () => "tick "),
        delayMs: 50,
        outputText: "must not finish",
      },
    ]);
    const baseActivities = createActivities({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    let dispatchedAttemptId: string | null = null;
    let interruptSettled!: () => void;
    const interruptSettlement = new Promise<void>((resolve) => {
      interruptSettled = resolve;
    });
    let lateSettlement: Awaited<ReturnType<typeof applySessionTurnSettlement>> | null = null;
    const activities = {
      ...baseActivities,
      settleSessionControl: async (
        input: Parameters<typeof baseActivities.settleSessionControl>[0],
      ) => {
        await baseActivities.settleSessionControl(input);
        interruptSettled();
      },
      runAgentTurn: async (input: Parameters<typeof baseActivities.runAgentTurn>[0]) => {
        dispatchedAttemptId = input.attemptId;
        const result = await baseActivities.runAgentTurn(input);
        // Deterministically model the production zombie boundary: the real
        // activity has observed cancellation, then this wrapper publishes a
        // terminal settlement from that fenced attempt after Pause committed.
        await interruptSettlement;
        lateSettlement = await applySessionTurnSettlement(dbClient.db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: input.turnId!,
          triggerEventId: input.triggerEventId,
          attemptId: input.attemptId,
          turnStatus: "completed",
          sessionStatus: "idle",
          activeTurnId: null,
          events: [{ type: "turn.completed", payload: { output: "late zombie output" } }],
        });
        return result;
      },
    };
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "hold until steer",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const workflowId = `session-${session.id}`;
    await enqueueSessionMessageAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: grant.subjectId,
      origin: "human",
      text: "hold until pause",
      resources: [],
      tools: [],
      delivery: "queue",
      reasoningEffortFallback: "xhigh",
    });

    const worker = await restartTestWorker(nativeConnection, taskQueue, activities);
    const workerRun = worker.run();
    const client = new Client({ connection });
    const handle = await client.workflow.start("sessionWorkflow", {
      taskQueue,
      workflowId,
      args: [{ accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id }],
    });
    try {
      await waitFor(async () => {
        const [turn] = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
        return (
          dispatchedAttemptId !== null &&
          turn?.status === "running" &&
          turn.activeAttemptId === dispatchedAttemptId
        );
      });
      const pause = await requestSessionControl(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        actor: grant.subjectId,
        mode: "pause",
        reason: "operator pause",
        clientEventId: `pause-zombie-${crypto.randomUUID()}`,
      });
      expect(pause.shouldSignalControl).toBe(true);
      await handle.signal("sessionControl", pause.event.id);
      await handle.result();
    } finally {
      worker.shutdown();
      await workerRun;
    }

    expect(lateSettlement).toMatchObject({
      action: "stale",
      turnStatus: "recovering",
      events: [],
    });
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns.map((turn) => turn.status)).toEqual(["recovering"]);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    expect(events.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("paused");
  }, 180_000);

  test("a failed session accepts a new user message and revives from stored items", async () => {
    const grant = await testGrant();
    const taskQueue = `failed-revival-${crypto.randomUUID()}`;
    const model = new ScriptedModel([
      // Turn 1 completes normally so the session has stored conversation truth.
      { id: "revive-call-1", outputText: "first answer", chunks: ["first ", "answer"] },
      // Turn 2 blows up with a non-retryable agent error: the session fails.
      { id: "revive-call-2", error: new Error("agent exploded mid-turn") },
      // Turn 3 is the revival turn, running from stored items.
      {
        id: "revive-call-3",
        outputText: "revived and answered",
        chunks: ["revived ", "and ", "answered"],
      },
    ]);
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      temporalTaskQueue: taskQueue,
    });
    const activities = createActivities({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "answer me",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const workflowId = `session-${session.id}`;
    await enqueueSessionMessageAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actor: grant.subjectId,
      origin: "human",
      text: "answer me",
      resources: [],
      tools: [],
      delivery: "queue",
      reasoningEffortFallback: settings.openaiReasoningEffort,
    });
    const client = new Client({ connection });
    // Same signalWithStart wiring as the production API client: revival of a
    // failed session must start a fresh workflow run for the completed one.
    const workflowClient: SessionWorkflowClient = {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async (input) => {
        await client.workflow.signalWithStart("sessionWorkflow", {
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
          signal: "queueChanged",
        });
      },
      signalApprovalDecision: async () => undefined,
      signalSessionControl: async () => undefined,
      syncScheduledTask: async () => undefined,
      deleteScheduledTaskSchedule: async () => undefined,
      triggerScheduledTask: async () => undefined,
    };
    const sendUserMessage = async (text: string) =>
      await postUserMessageTurn({
        db: dbClient.db,
        bus,
        workflowClient,
        settings,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        text,
        resources: [],
        tools: [],
      });

    const worker = await restartTestWorker(nativeConnection, taskQueue, activities);
    const run = worker.run();
    try {
      await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId,
        args: [
          { accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id },
        ],
      });
      await waitFor(
        async () =>
          (await getSession(dbClient.db, grant.workspaceId, session.id))?.status === "idle",
      );

      // Turn 2 fails the session for real.
      await sendUserMessage("do the next thing");
      await waitFor(
        async () =>
          (await getSession(dbClient.db, grant.workspaceId, session.id))?.status === "failed",
      );
      const turnsAfterFailure = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
      expect(turnsAfterFailure.map((turn) => turn.status)).toEqual(["completed", "failed"]);

      // Revival: the failed session accepts the message (no 409), goes back
      // to queued, and a fresh workflow run executes the turn from stored
      // conversation truth.
      await sendUserMessage("are you still there?");
      await waitFor(
        async () =>
          (await getSession(dbClient.db, grant.workspaceId, session.id))?.status === "idle",
      );
    } finally {
      worker.shutdown();
      await run;
    }

    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns.map((turn) => turn.status)).toEqual(["completed", "failed", "completed"]);
    expect(model.calls).toBe(3);
    // The revival turn was built from stored items: turn 1's conversation
    // truth is threaded in alongside the new user message.
    const revivalRequest = JSON.stringify(
      (model.requests.at(-1) as { input?: unknown })?.input ?? "",
    );
    expect(revivalRequest).toContain("first answer");
    expect(revivalRequest).toContain("are you still there?");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500);
    const statuses = events
      .filter((event) => event.type === "session.status.changed")
      .map((event) => (event.payload as { status?: string }).status);
    expect(statuses.slice(statuses.lastIndexOf("failed"))).toEqual([
      "failed",
      "queued",
      "running",
      "idle",
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "agent.message.completed" &&
          JSON.stringify(event.payload).includes("revived and answered"),
      ),
    ).toBe(true);
  }, 180_000);

  async function testGrant(): Promise<AccessGrant> {
    const id = crypto.randomUUID();
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:worker-restart",
      accountExternalId: `account:${id}`,
      accountName: "Worker restart account",
      workspaceExternalSource: "test:worker-restart",
      workspaceExternalId: `workspace:${id}`,
      workspaceName: "Worker restart workspace",
      subjectId: `test:worker-restart:${id}`,
      subjectLabel: "Worker restart integration",
    });
    const grant = context.workspaceGrants[0];
    if (!grant) {
      throw new Error("Worker restart test did not create a workspace grant");
    }
    return grant;
  }
});

async function restartTestWorker(
  nativeConnection: NativeConnection,
  taskQueue: string,
  activities: ReturnType<typeof createActivities>,
): Promise<Worker> {
  return await Worker.create({
    connection: nativeConnection,
    namespace: "default",
    taskQueue,
    workflowsPath: new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname,
    activities,
  });
}
