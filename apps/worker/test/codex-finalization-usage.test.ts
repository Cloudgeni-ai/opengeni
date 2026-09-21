import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  finalizeTurnAttempt,
  type TurnFinalizationDeps,
} from "../src/activities/agent-turn/finalization";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";

test("finalization flushes scraped usage with its exact cleanup authority before releasing the lease", async () => {
  const order: string[] = [];
  const write = spyOn(db, "recordCodexAccountUsageForFinalization").mockImplementation(async () => {
    order.push("usage");
    return { result: true, wakeTargets: [] };
  });
  const release = spyOn(db, "releaseCodexCredentialLease").mockImplementation(async () => {
    order.push("release");
    return true;
  });
  const settings = { workspaceCaptureEnabled: false } as Settings;
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  context.control.activityStatus = "idle";
  context.control.turnMetricOutcome = "completed";
  context.attempt.turnId = "turn-1";
  context.attempt.executionGeneration = 7;
  context.providerTurn.effectiveCodexCredentialId = "credential-1";
  context.providerTurn.effectiveCodexCredentialVersion = 3;
  context.providerTurn.latestCodexUsage = {
    checkedAt: new Date(),
    primaryUsedPercent: 21,
    primaryResetAt: null,
    secondaryUsedPercent: 34,
    secondaryResetAt: null,
  };
  const deps = {
    ...context,
    db: {},
    input: {
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
    },
    settings,
    activityStarted: performance.now(),
    activitySpan: { end() {} },
    sandboxResumeController: new AbortController(),
    activityContext: { heartbeat() {} },
    observability: {
      incrementCounter() {},
      incrementGauge() {},
      setGauge() {},
      observeHistogram() {},
      error() {},
      recordWorkerActivity() {},
    },
    leases: {
      codex: { held: true, holderId: "holder-1", generation: 2, stopHeartbeat() {} },
      xai: { held: false, stopHeartbeat() {} },
    },
    machineOpObserver: { drainEvents: () => [] },
    stopLeaseHeartbeat() {},
    turnCompletionMemoryCollector: { schedule() {} },
    noteCancellationRequested() {},
  } as unknown as TurnFinalizationDeps;
  try {
    await finalizeTurnAttempt(deps);
    expect(write).toHaveBeenCalledWith(
      deps.db,
      "workspace-1",
      "credential-1",
      context.providerTurn.latestCodexUsage,
      {
        turnId: "turn-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        executionGeneration: 7,
        holderId: "holder-1",
        generation: 2,
        credentialVersion: 3,
      },
    );
    expect(order).toEqual(["usage", "release"]);
  } finally {
    write.mockRestore();
    release.mockRestore();
  }
});
