import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import * as runInput from "../src/activities/run-input";
import * as openSuffix from "../src/activities/open-suffix-resume";
import { BudgetExhaustedError } from "../src/activities/agent-turn/admission";
import { runTurnStreamAttempt } from "../src/activities/agent-turn/stream-attempt";

test("stream component retains the completed compaction checkpoint before refusing every paid dispatch", async () => {
  const checkpoint = [{ type: "message", role: "user", content: "Completed summary" }];
  const settings = testSettings({ billingMode: "disabled", usageLimitsMode: "none" });
  const refusal = {
    code: "allowance_exhausted" as const,
    scope: "member" as const,
    subjectId: "user:frozen-initiator",
    resetsAt: "2026-10-01T00:00:00.000Z",
    message: "Member allowance exhausted",
  };
  const order: string[] = [];
  let paidDispatches = 0;
  const prepared = spyOn(runInput, "turnInput").mockResolvedValue({
    input: { input: checkpoint },
    persistedHistoryCount: checkpoint.length,
    providerArtifactCandidates: { knownHistoryItemIds: [], historyItemIds: [] },
  } as Awaited<ReturnType<typeof runInput.turnInput>>);
  const suffix = spyOn(openSuffix, "settleOpenSuffixResumeIfNeeded").mockResolvedValue({
    action: "continue",
  } as Awaited<ReturnType<typeof openSuffix.settleOpenSuffixResumeIfNeeded>>);
  const position = spyOn(db, "nextSessionHistoryPosition").mockResolvedValue(2);
  const allowance = spyOn(db, "checkWorkspaceAllowance").mockImplementation(async (_db, input) => {
    order.push("admission");
    expect(input.subjectId).toBe("user:frozen-initiator");
    return refusal;
  });
  const metrics = {
    histogram: () => ({ record() {}, observe() {} }),
    counter: () => ({ add() {}, inc() {} }),
  };
  const runtime = {
    generateSessionTitle: async () => {
      paidDispatches++;
      throw new Error("paid title dispatched");
    },
    runStream: async () => {
      paidDispatches++;
      throw new Error("paid inference dispatched");
    },
  };
  try {
    let error: unknown;
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
        runtime,
        observability: { metrics, observeHistogram() {}, incrementCounter() {}, info() {} },
        attempt: { turnId: crypto.randomUUID(), executionGeneration: 1 },
        turn: {
          id: crypto.randomUUID(),
          executionGeneration: 1,
          model: "scripted-model",
          initiatingHumanSubjectId: "user:frozen-initiator",
        },
        turnExecutionPolicy: { providerId: "openai" },
        trigger: { type: "user.message" },
        eventing: { modelRunSettings: settings },
        historySink: {
          seedHistory: (history: unknown) => {
            expect(history).toEqual(checkpoint);
            order.push("checkpoint");
          },
          reconcileConversationTruth: async (options: unknown) => {
            expect(options).toEqual({ requireDurable: true });
            order.push("durable");
          },
        },
        billingState: {
          isExternallyBilledTurn: false,
          chargesOpenGeniCredits: true,
          countsTowardTokenCap: true,
        },
        media: {},
        generatedImageHistoryProjector: async (items: unknown) => items,
        claimedModelUsageSourceKeys: new Set(),
        runtimeCancellationSignal: new AbortController().signal,
        generateSessionTitleInParallel: true,
        groupBoxBackend: "none",
        agent: {},
      } as unknown as Parameters<typeof runTurnStreamAttempt>[0]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(error).toMatchObject({ allowance: refusal });
    expect(order).toEqual(["checkpoint", "durable", "admission"]);
    expect(paidDispatches).toBe(0);
  } finally {
    prepared.mockRestore();
    suffix.mockRestore();
    position.mockRestore();
    allowance.mockRestore();
  }
});
