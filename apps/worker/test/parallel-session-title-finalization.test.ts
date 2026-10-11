import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import * as runInput from "../src/activities/run-input";
import * as openSuffix from "../src/activities/open-suffix-resume";
import * as admission from "../src/activities/agent-turn/admission";
import * as modelUsage from "../src/activities/agent-turn/model-usage";
import { createCoreCodexRequests } from "../src/activities/agent-turn/codex-core-requests";
import { runTurnStreamAttempt } from "../src/activities/agent-turn/stream-attempt";

for (const persistence of ["committed", "failed"] as const) {
  test(`main 503 joins completed title cleanup: persistence ${persistence}`, async () => {
    const order: string[] = [];
    const unavailable = Object.assign(new Error("503 upstream connection terminated"), {
      status: 503,
    });
    const settings = testSettings({
      sandboxBackend: "none",
      billingMode: "disabled",
      usageLimitsMode: "none",
    });
    const titleRequest = { requestId: "title", transportAttempt: 1 };
    const titleRequests = createCoreCodexRequests({
      reserve: async () => ({ operationId: "title-operation" }),
      settle: async ({ outcome }) => {
        expect(outcome).toBe("response_received");
        order.push("title_request_settled");
      },
    });
    const usage = { responseId: "title-response", usage: { inputTokens: 20, outputTokens: 5 } };
    const checkpoint = [{ type: "message", role: "user", content: "Find relevant events" }];
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
      spyOn(db, "listTurnCodemodeApprovals").mockResolvedValue([]),
      spyOn(db, "sessionTurnHasFinalReplyNudge").mockResolvedValue(false),
      spyOn(db, "isSubscriptionCoreCodexSourceDisconnected").mockResolvedValue(false),
      spyOn(modelUsage, "processSessionTitleModelUsageEvent").mockImplementation(async (input) => {
        expect(input.usage).toBe(usage);
        expect(titleRequests.canRecover()).toBe(false);
        order.push("usage_committed");
        return { status: "processed", sourceKey: "title-response", authoritative: true };
      }),
      spyOn(db, "updateSessionTitleWithEvent").mockImplementation(async (_database, input) => {
        expect(input.title).toBe("Relevant partner events");
        expect(titleRequests.canRecover()).toBe(false);
        order.push("title_write");
        if (persistence === "failed") throw new Error("title persistence failed");
        return { events: [] } as Awaited<ReturnType<typeof db.updateSessionTitleWithEvent>>;
      }),
    ];
    const metric = { record() {}, observe() {}, add() {}, inc() {}, set() {} };
    let titleGeneration!: Promise<{ title: string; usage: typeof usage }>;
    const stream = {
      completed: Promise.resolve(),
      error: null,
      toStream: () => ({
        // eslint-disable-next-line require-yield -- This stream fails before its first event.
        async *[Symbol.asyncIterator]() {
          // The real title generator has returned its provider response before
          // the main stream fails; persistence still belongs to worker cleanup.
          await titleGeneration;
          expect(titleRequests.canRecover()).toBe(false);
          order.push("main_503");
          throw unavailable;
        },
      }),
    };
    try {
      await expect(
        runTurnStreamAttempt({
          input: {
            accountId: crypto.randomUUID(),
            workspaceId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            attemptId: crypto.randomUUID(),
          },
          settings,
          runSettings: settings,
          db: {} as db.Database,
          runtime: {
            runStream: async () => stream,
            generateSessionTitle: () => {
              titleGeneration = (async () => {
                await titleRequests.reserve(titleRequest);
                await titleRequests.observe({ ...titleRequest, outcome: "response_received" });
                return { title: "Relevant partner events", usage };
              })();
              return titleGeneration;
            },
          },
          observability: {
            metrics: { histogram: () => metric, counter: () => metric, gauge: () => metric },
            observeHistogram() {},
            incrementCounter() {},
            info() {},
            warn() {},
          },
          attempt: { turnId: crypto.randomUUID(), executionGeneration: 1 },
          turn: { id: crypto.randomUUID(), executionGeneration: 1, model: "codex/gpt-6.1-sol" },
          turnExecutionPolicy: { providerId: "openai" },
          trigger: { type: "user.message" },
          eventing: {
            modelRunSettings: settings,
            toolCancellationFenceRef: { current: null },
            firstModelRequestPreparationRecorded: true,
            publish: async () => {},
          },
          historySink: { seedHistory() {}, reconcileConversationTruth: async () => {} },
          billingState: { isCodexTurn: true },
          providerTurn: { codexSubscriptionCore: { titleRequests } },
          sandboxState: {},
          leases: { codex: { lost: false, assertUsable() {} }, xai: { lost: false } },
          media: {
            retainedScreenshotReceiptsByCallId: new Map(),
            retainedSessionImageCallIds: new Set(),
            retainedSessionImageKindsByCallId: new Map(),
          },
          videoGenerationAcceptancesByCallId: new Map(),
          generatedImageHistoryProjector: async (items: unknown) => items,
          claimedModelUsageSourceKeys: new Set(),
          emittedModelUsageSourceKeys: new Set(),
          runtimeCancellationSignal: new AbortController().signal,
          activityContext: null,
          workerPreparationStartedAt: performance.now(),
          groupBoxBackend: "none",
          agent: {},
          resolvedModel: null,
          turnTools: [],
          generateSessionTitleInParallel: true,
          sessionTitlePrompt: "Find relevant events",
          throwIfWorkerShuttingDown() {},
          throwIfTurnCancelled() {},
          recordCompanyBrainContributionReceiptOnce() {},
          withProviderRequestContext: async (operation: () => Promise<unknown>) => operation(),
          withSessionTitleProviderRequestContext: async (operation: () => Promise<unknown>) =>
            operation(),
          finalizeTurnOpStreamOps: async () => {},
        } as unknown as Parameters<typeof runTurnStreamAttempt>[0]),
      ).rejects.toBe(unavailable);
      expect(order).toEqual([
        "main_503",
        "usage_committed",
        "title_write",
        ...(persistence === "committed" ? ["title_request_settled"] : []),
      ]);
      expect(titleRequests.canRecover()).toBe(persistence === "committed");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
}
