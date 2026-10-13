import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { SESSION_USAGE_LIMIT_BASIS } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import * as runInput from "../src/activities/run-input";
import * as openSuffix from "../src/activities/open-suffix-resume";
import {
  BudgetExhaustedError,
  ensureRunAllowedBetweenModelCalls,
  ensureSessionUsageLimitAllowsBetweenModelCalls,
} from "../src/activities/agent-turn/admission";
import { runTurnStreamAttempt } from "../src/activities/agent-turn/stream-attempt";

// Per-task usage limit admission at the paid-request boundaries that a
// session-level test cannot isolate: the first request with the parallel
// title request, every between-request call (including the portable
// compaction summarizer), and the Codex remote compaction request.

const scope = () => ({
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
});

function reachedRefusal(rootSessionId: string) {
  return {
    code: "session_usage_limit_reached" as const,
    basis: SESSION_USAGE_LIMIT_BASIS,
    rootSessionId,
    limitMicros: 1_000_000,
    usedMicros: 1_250_000,
    message: "This task reached its usage limit.",
  };
}

test("the remote compaction boundary turns a reached limit into the typed between-request stop", async () => {
  const input = scope();
  const refusal = reachedRefusal(input.sessionId);
  const check = spyOn(db, "checkSessionUsageLimitAdmission").mockResolvedValue({
    allowed: false,
    refusal,
    state: null,
  } as never);
  try {
    let error: unknown;
    try {
      await ensureSessionUsageLimitAllowsBetweenModelCalls({} as db.Database, input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(error).toMatchObject({ sessionUsageLimit: refusal, allowance: null });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![1]).toEqual(input);
  } finally {
    check.mockRestore();
  }
});

test("the remote compaction boundary admits an unreached limit and never hides an unreadable one", async () => {
  const input = scope();
  const allowed = spyOn(db, "checkSessionUsageLimitAdmission").mockResolvedValue({
    allowed: true,
    state: null,
  } as never);
  try {
    await ensureSessionUsageLimitAllowsBetweenModelCalls({} as db.Database, input);
  } finally {
    allowed.mockRestore();
  }
  const unavailable = new db.SessionUsageLimitUnavailableError("unreadable");
  const failing = spyOn(db, "checkSessionUsageLimitAdmission").mockRejectedValue(unavailable);
  try {
    await expect(
      ensureSessionUsageLimitAllowsBetweenModelCalls({} as db.Database, input),
    ).rejects.toBe(unavailable);
  } finally {
    failing.mockRestore();
  }
});

test("a between-request call (and the compaction summarizer) checks the task limit before any allowance", async () => {
  const input = scope();
  const refusal = reachedRefusal(input.sessionId);
  const check = spyOn(db, "checkSessionUsageLimitAdmission").mockResolvedValue({
    allowed: false,
    refusal,
    state: null,
  } as never);
  const allowance = spyOn(db, "checkWorkspaceAllowance").mockResolvedValue(null);
  try {
    let error: unknown;
    try {
      await ensureRunAllowedBetweenModelCalls({
        settings: testSettings({ billingMode: "disabled", usageLimitsMode: "none" }),
        db: {} as db.Database,
        ...input,
        isExternallyBilledTurn: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: false,
        initiatingHumanSubjectId: null,
        serializedRunState: () => "serialized-run-state",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(error).toMatchObject({
      sessionUsageLimit: refusal,
      allowance: null,
      serializedRunState: "serialized-run-state",
    });
    expect(allowance).not.toHaveBeenCalled();
  } finally {
    check.mockRestore();
    allowance.mockRestore();
  }
});

test("a reached limit refuses the first request and the parallel title request before any dispatch", async () => {
  const checkpoint = [{ type: "message", role: "user", content: "Synthetic request" }];
  const settings = testSettings({ billingMode: "disabled", usageLimitsMode: "none" });
  const input = { ...scope(), attemptId: crypto.randomUUID() };
  const refusal = reachedRefusal(input.sessionId);
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
  const operations = spyOn(db, "listTurnCodemodeApprovals").mockResolvedValue([]);
  const check = spyOn(db, "checkSessionUsageLimitAdmission").mockResolvedValue({
    allowed: false,
    refusal,
    state: null,
  } as never);
  const allowance = spyOn(db, "checkWorkspaceAllowance").mockResolvedValue(null);
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
        input,
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
        providerTurn: {},
        trigger: { type: "user.message" },
        eventing: { modelRunSettings: settings },
        historySink: {
          seedHistory: () => undefined,
          reconcileConversationTruth: async () => undefined,
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
    expect(error).toMatchObject({ sessionUsageLimit: refusal, allowance: null });
    expect(check).toHaveBeenCalled();
    expect(check.mock.calls[0]![1]).toMatchObject({ sessionId: input.sessionId });
    expect(allowance).not.toHaveBeenCalled();
    expect(paidDispatches).toBe(0);
  } finally {
    prepared.mockRestore();
    suffix.mockRestore();
    position.mockRestore();
    operations.mockRestore();
    check.mockRestore();
    allowance.mockRestore();
  }
});
