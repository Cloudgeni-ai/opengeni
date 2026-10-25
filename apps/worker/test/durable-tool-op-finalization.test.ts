import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import * as runInput from "../src/activities/run-input";
import * as openSuffix from "../src/activities/open-suffix-resume";
import * as admission from "../src/activities/agent-turn/admission";
import { runTurnStreamAttempt } from "../src/activities/agent-turn/stream-attempt";
import { TurnAttemptFencedError } from "../src/activities/turn-attempt-fenced";

for (const scenario of [
  "committed",
  "missing",
  "fenced",
  "checkpoint_fenced",
  "event_failed",
] as const) {
  test(`partial tool batch ${scenario}: foreground release follows exact receipt and durable event`, async () => {
    const order: string[] = [];
    const finalizations: Array<readonly string[] | undefined> = [];
    const stopped = new Error("sibling tool is still in flight");
    const eventFailure = new Error("structural event write failed");
    const settings = testSettings({
      sandboxBackend: "none",
      billingMode: "disabled",
      usageLimitsMode: "none",
    });
    const checkpoint = [{ type: "message", role: "user", content: "Run two parallel tools" }];
    const checkpointTx = {} as db.Database;
    const allowedFence = { allowed: true } as Parameters<db.SessionEventMutation<"event">>[1];
    const mutationEvents: string[] = [];
    const spies = [
      spyOn(runInput, "turnInput").mockResolvedValue({
        input: { input: checkpoint },
        persistedHistoryCount: checkpoint.length,
        providerArtifactCandidates: { knownHistoryItemIds: [], historyItemIds: [] },
      } as Awaited<ReturnType<typeof runInput.turnInput>>),
      spyOn(openSuffix, "settleOpenSuffixResumeIfNeeded").mockResolvedValue({
        action: "continue",
      } as Awaited<ReturnType<typeof openSuffix.settleOpenSuffixResumeIfNeeded>>),
      spyOn(admission, "ensureRunAllowedBetweenModelCalls").mockResolvedValue(),
      spyOn(db, "nextSessionHistoryPosition").mockResolvedValue(2),
      // No explicit workspace recovery adds a discontinuity notice here.
      spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
      // This fixture has no stored programmatic operations to recover.
      spyOn(db, "listTurnCodemodeApprovals").mockResolvedValue([]),
      spyOn(db, "sessionTurnHasFinalReplyNudge").mockResolvedValue(false),
      spyOn(db, "registerPendingSessionToolCallInTransaction").mockResolvedValue({
        accepted: true,
        registered: true,
      }),
      spyOn(db, "recordPendingSessionToolCallResultInTransaction").mockImplementation(
        async (tx, input, fence) => {
          expect(tx).toBe(checkpointTx);
          expect(fence).toBe(allowedFence);
          expect(input.callId).toBe("call_first");
          expect(input.resultItem).toMatchObject({
            type: "function_call_result",
            callId: "call_first",
            output: { type: "text", text: "completed first result" },
          });
          order.push("receipt");
          return {
            accepted: scenario !== "fenced",
            recorded: scenario === "committed" || scenario === "event_failed",
          };
        },
      ),
    ];
    const metric = { record() {}, observe() {}, add() {}, inc() {}, set() {} };
    const stream = {
      completed: Promise.resolve(),
      error: null,
      toStream: () => ({
        async *[Symbol.asyncIterator]() {
          for (const callId of ["call_first", "call_sibling"]) {
            yield {
              type: "run_item_stream_event",
              item: {
                type: "tool_call_item",
                rawItem: { type: "function_call", callId, name: "command", arguments: "{}" },
              },
            };
          }
          yield {
            type: "run_item_stream_event",
            item: {
              type: "tool_call_output_item",
              rawItem: {
                type: "function_call_result",
                callId: "call_first",
                output: { type: "text", text: "completed first result" },
              },
              output: { type: "text", text: "completed first result" },
            },
          };
          throw stopped;
        },
      }),
    };
    try {
      let caught: unknown;
      try {
        await runTurnStreamAttempt({
          input: {
            accountId: crypto.randomUUID(),
            workspaceId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            attemptId: crypto.randomUUID(),
          },
          settings,
          runSettings: settings,
          db: {} as db.Database,
          runtime: { runStream: async () => stream },
          observability: {
            metrics: { histogram: () => metric, counter: () => metric, gauge: () => metric },
            observeHistogram() {},
            incrementCounter() {},
            info() {},
            warn() {},
          },
          attempt: { turnId: crypto.randomUUID(), executionGeneration: 1 },
          turn: {
            id: crypto.randomUUID(),
            executionGeneration: 1,
            model: "scripted-model",
            resources: [],
          },
          turnExecutionPolicy: { providerId: "openai" },
          trigger: { type: "user.message" },
          eventing: {
            modelRunSettings: settings,
            toolCancellationFenceRef: { current: null },
            firstModelRequestPreparationRecorded: true,
            publish: async (
              events: Array<{ type: string }>,
              _immediate: boolean,
              mutate?: db.SessionEventMutation<"event">,
            ) => {
              const output = events.some((event) => event.type === "agent.toolCall.output");
              // Production publishing executes the receipt mutation inside the
              // same fenced transaction as its structural event. Ignoring this
              // callback silently tests neither receipt nor foreground release.
              if (events.some((event) => event.type === "agent.toolCall.created") || output) {
                expect(mutate).toBeDefined();
                mutationEvents.push(output ? "output" : "created");
                const fence =
                  output && scenario === "checkpoint_fenced"
                    ? ({
                        allowed: false,
                        reason: "attempt_changed",
                        workspace: null,
                        session: null,
                        turn: null,
                        attempt: null,
                      } as Parameters<db.SessionEventMutation<"event">>[1])
                    : allowedFence;
                expect(await mutate!(checkpointTx, fence)).toBe(true);
              }
              if (output) {
                expect(finalizations).toEqual([]);
                order.push("event_started");
                if (scenario === "event_failed") throw eventFailure;
                await Promise.resolve();
                expect(finalizations).toEqual([]);
                order.push("event_durable");
              }
            },
          },
          historySink: {
            seedHistory() {},
            reconcileConversationTruth: async () => {
              order.push("history");
            },
          },
          billingState: { isCodexTurn: false },
          providerTurn: {},
          sandboxState: {},
          leases: { codex: { lost: false }, xai: { lost: false } },
          media: {
            retainedScreenshotReceiptsByCallId: new Map(),
            retainedSessionImageCallIds: new Set(),
            retainedSessionImageKindsByCallId: new Map(),
          },
          videoGenerationAcceptancesByCallId: new Map(),
          generatedImageHistoryProjector: async (items: unknown) => items,
          claimedModelUsageSourceKeys: new Set(),
          runtimeCancellationSignal: new AbortController().signal,
          activityContext: null,
          workerPreparationStartedAt: performance.now(),
          groupBoxBackend: "none",
          agent: {},
          turnTools: [],
          throwIfWorkerShuttingDown() {},
          throwIfTurnCancelled() {},
          recordCompanyBrainContributionReceiptOnce() {},
          withProviderRequestContext: async (operation: () => Promise<unknown>) => operation(),
          finalizeTurnOpStreamOps: async (callIds?: readonly string[]) => {
            order.push("finalize");
            finalizations.push(callIds);
          },
        } as unknown as Parameters<typeof runTurnStreamAttempt>[0]);
      } catch (error) {
        caught = error;
      }
      expect(mutationEvents).toEqual(["created", "created", "output"]);
      if (scenario === "fenced" || scenario === "checkpoint_fenced") {
        expect(caught).toBeInstanceOf(TurnAttemptFencedError);
        expect(order).not.toContain("event_started");
        if (scenario === "checkpoint_fenced") expect(order).not.toContain("receipt");
      } else {
        expect(caught).toBe(scenario === "event_failed" ? eventFailure : stopped);
      }
      if (scenario === "committed") {
        expect(finalizations).toEqual([["call_first"]]);
        expect(order.slice(order.indexOf("receipt"))).toEqual([
          "receipt",
          "event_started",
          "event_durable",
          "finalize",
        ]);
      } else {
        expect(finalizations).toEqual([]);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
}
