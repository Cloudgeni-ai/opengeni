import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { AccessGrant } from "@opengeni/contracts";
import {
  acceptSessionApprovalDecision,
  admitSessionTurnModelCall,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  establishSessionTurnPersistenceReceipt,
  getSession,
  getSessionHistoryItems,
  getSessionTurnPersistenceReceipt,
  listSessionEvents,
  listSessionTurns,
  mutateSessionControlInTransaction,
  withWorkspaceRls,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
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
import { createActivityTestHarness } from "../../apps/worker/src/activities";
import { currentActivityContext } from "../../apps/worker/src/activities/streaming";
import { prepareTurnPersistenceHandoff } from "../../apps/worker/src/turn-persistence-handoff";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "../../apps/worker/src/concurrency";
import { turnTaskQueue } from "../../apps/worker/src/workflows/activities";
import { submitTestHumanPrompt } from "./helpers/session-control";

// Proves the campaign's robustness contract across real PostgreSQL, Temporal,
// and NATS: a worker restart can recover pre-effect or fully receipted progress,
// but it must fail closed rather than replay an admitted provider/tool effect
// whose complete result is unknown.
type RequiredServices = Pick<
  TestServices,
  "databaseUrl" | "natsUrl" | "temporalHost" | "migrate" | "down"
>;

async function hangWithoutHeartbeating(): Promise<never> {
  await new Promise<void>((_resolve, reject) => {
    const signal = currentActivityContext()?.cancellationSignal;
    if (!signal || signal.aborted) {
      reject(new Error("simulated dead turn worker cancelled after timeout"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("simulated dead turn worker cancelled after timeout")),
      { once: true },
    );
  });
  throw new Error("unreachable simulated dead turn worker completion");
}

describe("worker restart resilience", () => {
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
    nativeConnection = await NativeConnection.connect({
      address: services.temporalHost,
    });
  }, 300_000);

  afterAll(async () => {
    await connection?.close();
    await nativeConnection?.close();
    await bus?.close();
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("graceful worker shutdown during an admitted model call quarantines without replay", async () => {
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
      // Must remain unused: the admitted second call cannot be replayed merely
      // because shutdown interrupted its stream before receipt establishment.
      {
        id: "restart-call-3",
        outputText: "must not replay",
        chunks: ["must ", "not ", "replay"],
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
    const activities = createActivityTestHarness({
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
    const accepted = await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "do the work",
      resources: [],
      tools: [{ kind: "mcp", id: "docs" }],
      delivery: "send",
      reasoningEffortFallback: settings.openaiReasoningEffort,
    });

    const firstWorker = await restartTestWorker(nativeConnection, taskQueue, activities);
    const firstRun = firstWorker.run();
    let firstWorkerStopped = false;
    let completionWorker: Awaited<ReturnType<typeof restartTestWorker>> | null = null;
    let completionRun: Promise<void> | null = null;
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
          },
        ],
      });

      // Wait until the side effect ran, its progress was checkpointed to items,
      // and the second (slow) model call is in flight — then pull the plug. The
      // first workflow bundle load can exceed the generic 30s polling default on
      // a cold native Temporal worker, so keep this below the enclosing test
      // bound and emit state that makes a genuine failure actionable.
      await waitFor(() => mcp.calls.length === 1, {
        timeoutMs: 120_000,
        describe: () => `modelCalls=${model.calls} mcpCalls=${mcp.calls.length}`,
      });
      await waitFor(
        async () =>
          (await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id)).length > 0,
      );
      await waitFor(() => model.calls === 2);
      firstWorker.shutdown();
      firstWorkerStopped = true;
      await firstRun;
      // A healthy worker is still needed to drain the workflow task after the
      // old turn activity exits. It must not receive a new inference attempt.
      completionWorker = await restartTestWorker(nativeConnection, taskQueue, activities);
      completionRun = completionWorker.run();
      await handle.result();
    } finally {
      if (!firstWorkerStopped) {
        firstWorker.shutdown();
        await firstRun.catch(() => undefined);
      }
      if (completionWorker && completionRun) {
        completionWorker.shutdown();
        await completionRun;
      }
      mcp.close();
    }

    const quarantined = await getSession(dbClient.db, grant.workspaceId, session.id);
    expect(quarantined).toMatchObject({ status: "failed", activeTurnId: null });
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns).toEqual([
      expect.objectContaining({ id: accepted.turn.id, status: "failed", activeAttemptId: null }),
    ]);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500);
    expect(events.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.failed",
        payload: expect.objectContaining({
          code: "ambiguous_model_call",
          effectState: "unknown",
          retryable: false,
        }),
      }),
    );
    expect(latestStatus(events)).toBe("failed");
    // Both external boundaries happened once: the first tool result was fully
    // durable, while the second provider call remained ambiguous. Neither is
    // invoked again by a successor attempt.
    expect(model.calls).toBe(2);
    expect(model.requests).toHaveLength(2);
    expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "current state" } }]);
  }, 180_000);

  test("worker shutdown after an approved tool begins continues from canonical history without replay", async () => {
    const grant = await testGrant();
    let activeActivityCancellation: Promise<void> | null = null;
    const mcp = startTestMcpServer({
      beforeToolResult: async () => {
        if (!activeActivityCancellation) {
          throw new Error("approved-tool restart fixture has no active cancellation signal");
        }
        // The external effect is recorded before this hook. Hold its response
        // until Temporal has actually cancelled the resumed activity, so the
        // result cannot race ahead of the worker-shutdown boundary.
        await activeActivityCancellation;
      },
    });
    const taskQueue = `approved-tool-restart-${crypto.randomUUID()}`;
    const model = new ScriptedModel([
      {
        id: "approved-tool-call-1",
        output: [
          functionCall(
            "docs__search_documents",
            { query: "rolling deploy state" },
            "call-approved-restart",
          ),
        ],
      },
      {
        id: "approved-tool-call-2",
        outputText: "continued from the explicit unknown outcome",
        chunks: ["continued from ", "the explicit unknown outcome"],
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
          requireApproval: true,
        },
      ],
    });
    const baseActivities = createActivityTestHarness({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const activities = {
      ...baseActivities,
      runAgentTurn: async (input: Parameters<typeof baseActivities.runAgentTurn>[0]) => {
        const signal = currentActivityContext()?.cancellationSignal;
        if (!signal) {
          throw new Error("approved-tool restart fixture has no Temporal activity context");
        }
        activeActivityCancellation = new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return await baseActivities.runAgentTurn(input);
      },
    };
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "inspect the rolling deploy state",
      resources: [],
      tools: [{ kind: "mcp", id: "docs" }],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const workflowId = `session-${session.id}`;
    await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "inspect the rolling deploy state",
      resources: [],
      tools: [{ kind: "mcp", id: "docs" }],
      delivery: "send",
      reasoningEffortFallback: settings.openaiReasoningEffort,
    });

    const firstWorker = await restartTestWorker(nativeConnection, taskQueue, activities);
    const firstRun = firstWorker.run();
    let firstWorkerStopped = false;
    let completionWorker: Awaited<ReturnType<typeof restartTestWorker>> | null = null;
    let completionRun: Promise<void> | null = null;
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
          },
        ],
      });
      await waitFor(
        async () =>
          (await getSession(dbClient.db, grant.workspaceId, session.id))?.status ===
          "requires_action",
        { timeoutMs: 120_000 },
      );
      const approvalEvent = (
        await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 200)
      ).find((event) => event.type === "session.requiresAction");
      const approvalId = (
        approvalEvent?.payload as {
          approvals?: Array<{ rawItem?: { id?: unknown } }>;
        }
      )?.approvals?.[0]?.rawItem?.id;
      expect(approvalId).toBe("call-approved-restart");
      const approval = await acceptSessionApprovalDecision(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        payload: { approvalId, decision: "approve" },
      });
      if (approval.action !== "accepted") {
        throw new Error(`approval was not accepted: session is ${approval.sessionStatus}`);
      }
      await handle.signal("approvalDecision", approval.event.id);

      await waitFor(() => mcp.calls.length === 1, {
        timeoutMs: 120_000,
        describe: () => `modelCalls=${model.calls} mcpCalls=${mcp.calls.length}`,
      });
      firstWorker.shutdown();
      firstWorkerStopped = true;
      await firstRun;

      completionWorker = await restartTestWorker(nativeConnection, taskQueue, activities);
      completionRun = completionWorker.run();
      await handle.result();
    } finally {
      if (!firstWorkerStopped) {
        firstWorker.shutdown();
        await firstRun.catch(() => undefined);
      }
      if (completionWorker && completionRun) {
        completionWorker.shutdown();
        await completionRun;
      }
      mcp.close();
    }

    expect(mcp.calls).toEqual([
      { tool: "search_documents", args: { query: "rolling deploy state" } },
    ]);
    expect(model.calls).toBe(2);
    expect(model.requests).toHaveLength(2);
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "completed", executionGeneration: 3 });
    const attempts = await withWorkspaceRls(dbClient.db, grant.workspaceId, async (db) =>
      (await db.query.sessionTurnAttempts.findMany()).filter(
        (attempt) => attempt.turnId === turns[0]!.id,
      ),
    );
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.state === "closed")).toBe(true);

    const history = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(history.map((row) => row.item)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          callId: "call-approved-restart",
        }),
        expect.objectContaining({
          type: "function_call_result",
          callId: "call-approved-restart",
          status: "incomplete",
          output: expect.objectContaining({
            text: expect.stringContaining("side-effect outcome is unknown"),
          }),
        }),
      ]),
    );
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500);
    const unknownOutputIndex = events.findIndex(
      (event) =>
        event.type === "agent.toolCall.output" &&
        (event.payload as { id?: unknown; recovery?: { outcome?: unknown } }).id ===
          "call-approved-restart" &&
        (event.payload as { recovery?: { outcome?: unknown } }).recovery?.outcome === "unknown",
    );
    const recoveryIndex = events.findIndex((event) => event.type === "turn.recovery.requested");
    expect(unknownOutputIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeGreaterThan(unknownOutputIndex);
    expect(events.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
    expect(latestStatus(events)).toBe("idle");
  }, 240_000);

  test("worker death after a PostgreSQL model receipt but before heartbeat never replays inference", async () => {
    const grant = await testGrant();
    const taskQueue = `receipt-before-heartbeat-${crypto.randomUUID()}`;
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      temporalTaskQueue: taskQueue,
    });
    const baseActivities = createActivityTestHarness({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel("must not be called") }),
    });
    let providerInferenceEffects = 0;
    let turnDispatches = 0;
    let committedReceiptId: string | null = null;
    let receiptAttemptId: string | null = null;
    const activities = {
      ...baseActivities,
      runAgentTurn: async (input: Parameters<typeof baseActivities.runAgentTurn>[0]) => {
        const context = currentActivityContext();
        if (!context) throw new Error("receipt fault fixture has no Temporal activity context");
        const claim = await claimSessionWorkForAttempt(dbClient.db, input.workspaceId, {
          sessionId: input.sessionId,
          workflowId: input.workflowId,
          workflowRunId: input.workflowRunId,
          attemptId: input.attemptId,
          dispatchId: context.info.activityId,
          trigger: input.trigger,
        });
        if (claim.action === "unclaimed") {
          return { status: "unclaimed" as const, reason: claim.reason };
        }
        turnDispatches += 1;
        const turn = claim.turn;
        if (turnDispatches === 1) {
          providerInferenceEffects += 1;
          const sourceKey = `provider-response-${input.attemptId}`;
          const prepared = prepareTurnPersistenceHandoff({
            turnId: turn.id,
            triggerEventId: turn.triggerEventId,
            executionGeneration: turn.executionGeneration,
            attemptId: input.attemptId,
            obligation: {
              kind: "model_call",
              history: {
                producerCodexCredentialId: null,
                modelToolOutputTruncationTokens: 4_096,
                items: [
                  {
                    // The initial user prompt already owns canonical position 0.
                    position: 1,
                    item: {
                      type: "message",
                      role: "assistant",
                      content: "provider completed exactly once",
                    },
                  },
                ],
              },
              metering: {
                model: "scripted-model",
                isCodexTurn: false,
                usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
                sourceKey,
              },
              event: {
                type: "agent.model.usage",
                payload: {
                  turnId: turn.id,
                  model: "scripted-model",
                  sourceKey,
                  inputTokens: 10,
                  outputTokens: 3,
                },
                turnId: turn.id,
                producerId: `turn-attempt:${input.attemptId}`,
                producerSeq: 1,
                occurredAt: new Date().toISOString(),
              },
            },
          });
          const modelCallAdmissionId = crypto.randomUUID();
          const admitted = await admitSessionTurnModelCall(dbClient.db, {
            id: modelCallAdmissionId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: turn.id,
            attemptId: input.attemptId,
            executionGeneration: turn.executionGeneration,
            triggerEventId: turn.triggerEventId,
            callIndex: 1,
            callKind: "agent_model",
            provider: "scripted",
            providerApi: "responses",
            model: "scripted-model",
          });
          expect(admitted.action).toBe("established");
          const established = await establishSessionTurnPersistenceReceipt(dbClient.db, {
            id: prepared.handoff.receiptId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: prepared.handoff.turnId,
            attemptId: prepared.handoff.attemptId,
            executionGeneration: prepared.handoff.executionGeneration,
            triggerEventId: prepared.handoff.triggerEventId,
            modelCallAdmissionId,
            obligationKind: prepared.handoff.obligationKind,
            obligationVersion: 1,
            obligationDigest: prepared.handoff.obligationDigest,
            obligation: prepared.obligation,
          });
          expect(established.action).toBe("established");
          committedReceiptId = prepared.handoff.receiptId;
          receiptAttemptId = input.attemptId;
          // No heartbeat and no activity result follows this committed row.
          // Temporal's real heartbeat timeout supplies the worker-death edge.
          return await hangWithoutHeartbeating();
        }

        const settled = await applySessionTurnSettlement(dbClient.db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: turn.id,
          triggerEventId: turn.triggerEventId,
          attemptId: input.attemptId,
          turnStatus: "completed",
          sessionStatus: "idle",
          activeTurnId: null,
          events: [{ type: "turn.completed", payload: { recoveredReceipt: true } }],
        });
        expect(settled.action).toBe("settled");
        return {
          status: "idle" as const,
          turnId: turn.id,
          attemptId: input.attemptId,
        };
      },
    };
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "complete one provider call",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "complete one provider call",
      resources: [],
      tools: [],
      delivery: "send",
      reasoningEffortFallback: settings.openaiReasoningEffort,
    });

    const worker = await restartTestWorker(nativeConnection, taskQueue, activities);
    const run = worker.run();
    const client = new Client({ connection });
    try {
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId: `session-${session.id}`,
        args: [
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
          },
        ],
      });
      await handle.result();
    } finally {
      worker.shutdown();
      await run;
    }

    expect(providerInferenceEffects).toBe(1);
    expect(turnDispatches).toBe(2);
    expect(committedReceiptId).not.toBeNull();
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "completed", executionGeneration: 2 });
    const attempts = await withWorkspaceRls(dbClient.db, grant.workspaceId, async (db) =>
      (await db.query.sessionTurnAttempts.findMany()).filter(
        (attempt) => attempt.turnId === turns[0]!.id,
      ),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.state === "closed")).toBe(true);
    expect(
      await getSessionTurnPersistenceReceipt(dbClient.db, grant.workspaceId, {
        sessionId: session.id,
        attemptId: receiptAttemptId!,
        receiptId: committedReceiptId!,
      }),
    ).toMatchObject({ state: "settled" });
    const history = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(JSON.stringify(history)).toContain("provider completed exactly once");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500);
    expect(events.filter((event) => event.type === "agent.model.usage")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
  }, 240_000);

  test("graceful worker shutdown before model progress recovers the same turn untouched", async () => {
    const grant = await testGrant();
    const taskQueue = `worker-restart-early-${crypto.randomUUID()}`;
    const model = new ScriptedModel([
      // The only model call: the first attempt is interrupted before it ever
      // reaches the model, so the rerun replays the original trigger cleanly.
      {
        id: "early-call-1",
        outputText: "did the work",
        chunks: ["did ", "the ", "work"],
      },
    ]);
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      temporalTaskQueue: taskQueue,
    });
    const activities = createActivityTestHarness({
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
    const accepted = await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "do the early work",
      resources: [],
      tools: [],
      delivery: "send",
      reasoningEffortFallback: settings.openaiReasoningEffort,
    });

    const firstWorker = await restartTestWorker(nativeConnection, taskQueue, gatedActivities);
    const firstRun = firstWorker.run();
    const client = new Client({ connection });
    const handle = await client.workflow.start("sessionWorkflow", {
      taskQueue,
      workflowId,
      args: [
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
        },
      ],
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

  test("a late activity settlement after Pause cannot override admitted-call quarantine", async () => {
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
    const baseActivities = createActivityTestHarness({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    let dispatchedAttemptId: string | null = null;
    const activities = {
      ...baseActivities,
      runAgentTurn: async (input: Parameters<typeof baseActivities.runAgentTurn>[0]) => {
        dispatchedAttemptId = input.attemptId;
        return await baseActivities.runAgentTurn(input);
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
    await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "hold until pause",
      resources: [],
      tools: [],
      delivery: "send",
      reasoningEffortFallback: "xhigh",
    });

    const worker = await restartTestWorker(nativeConnection, taskQueue, activities);
    const workerRun = worker.run();
    const client = new Client({ connection });
    const handle = await client.workflow.start("sessionWorkflow", {
      taskQueue,
      workflowId,
      args: [
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
        },
      ],
    });
    try {
      await waitFor(async () => {
        const [turn] = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
        return (
          dispatchedAttemptId !== null &&
          turn?.status === "running" &&
          turn.activeAttemptId === dispatchedAttemptId &&
          model.calls === 1
        );
      });
      const pause = await withWorkspaceRls(dbClient.db, grant.workspaceId, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
            actor: { type: "human", subjectId: grant.subjectId },
            action: "pause",
            reason: "operator pause",
            operationKey: `pause-zombie-${crypto.randomUUID()}`,
          }),
        ),
      );
      expect(pause.interruptionCount).toBe(1);
      await handle.signal("sessionControl");
      await handle.result();
    } finally {
      worker.shutdown();
      await workerRun;
    }

    // The provider call was durably admitted before Pause, so cancellation cannot
    // prove whether the provider completed an externally visible response. The
    // workflow must fail closed instead of replaying inference. Model the old
    // worker's terminal write after that durable quarantine; the attempt fence
    // must reject this exact zombie write without changing committed truth.
    const [pausedTurn] = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    if (!pausedTurn || !dispatchedAttemptId) {
      throw new Error(`pause fixture lost its turn attempt for ${session.id}`);
    }
    const lateSettlement = await applySessionTurnSettlement(dbClient.db, grant.workspaceId, {
      sessionId: session.id,
      turnId: pausedTurn.id,
      triggerEventId: pausedTurn.triggerEventId,
      attemptId: dispatchedAttemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        {
          type: "turn.completed",
          payload: { output: "late zombie output" },
        },
      ],
    });
    expect(lateSettlement).toMatchObject({
      action: "stale",
      turnStatus: "failed",
      activeTurnId: null,
      events: [],
    });
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns.map((turn) => turn.status)).toEqual(["failed"]);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    expect(events.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.failed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "ambiguous_model_call",
          effectState: "unknown",
          retryable: false,
        }),
      }),
    ]);
    expect(model.calls).toBe(1);
    expect(await getSession(dbClient.db, grant.workspaceId, session.id)).toMatchObject({
      status: "failed",
      activeTurnId: null,
      effectiveControl: { state: "paused" },
    });
  }, 180_000);

  test("a failed session accepts a new user message and revives from stored items", async () => {
    const grant = await testGrant();
    const taskQueue = `failed-revival-${crypto.randomUUID()}`;
    const model = new ScriptedModel([
      // Turn 1 completes normally so the session has stored conversation truth.
      {
        id: "revive-call-1",
        outputText: "first answer",
        chunks: ["first ", "answer"],
      },
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
    const activities = createActivityTestHarness({
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
    await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "answer me",
      resources: [],
      tools: [],
      delivery: "send",
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
      requestSessionWorkflowWakeDispatch: async () => undefined,
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
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
          },
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
      // conversation truth. The new run deliberately reuses the stable workflow
      // ID and Temporal restarts its activity-ID sequence; only the first-class
      // workflow run ID keeps this dispatch distinct from the original run.
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

async function restartTestWorker(
  nativeConnection: NativeConnection,
  taskQueue: string,
  activities: ReturnType<typeof createActivityTestHarness>,
): Promise<{ run: () => Promise<void>; shutdown: () => void }> {
  const { runAgentTurn, ...controlActivities } = activities;
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
