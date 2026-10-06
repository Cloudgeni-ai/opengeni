import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import type { SandboxV2TurnExecution } from "../src/sandbox-v2-execution";
import { SandboxV2AttemptWritersPendingError } from "../src/sandbox-v2-execution";
import {
  finalizeTurnAttempt,
  type TurnFinalizationDeps,
} from "../src/activities/agent-turn/finalization";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";

// Exercise the real worker finalizer as a consumer of control settlement.
// Physical proof production is tested separately against the native provider
// and Postgres; these synthetic states grant no physical authority.
function fixture() {
  const order: string[] = [];
  const metrics: string[] = [];
  const settings = { workspaceCaptureEnabled: true } as Settings;
  const context = createTurnContext({ settings, cancellationRequestedAt: performance.now() });
  context.control.activityStatus = "cancelled";
  context.control.turnMetricOutcome = "cancelled";
  context.control.acknowledgeQuiescence = true;
  context.attempt.turnId = crypto.randomUUID();
  context.attempt.executionGeneration = 3;
  const settled = Promise.withResolvers<Awaited<ReturnType<SandboxV2TurnExecution["finalize"]>>>();
  const credentialRenewal = {
    stop: async () => {
      order.push("renewal-stop");
    },
  };
  const runMcpCredentials = {
    close: () => {
      order.push("mcp-close");
    },
  };
  context.sandboxState.nativeTurn = {
    credentialRenewal,
    runMcpCredentials,
    closeAndDrain: async () => {
      runMcpCredentials.close();
      await credentialRenewal.stop();
    },
    finalize: async () => {
      order.push("native-finalize");
      return await settled.promise;
    },
  } as SandboxV2TurnExecution;
  context.renewals.runCredentialRenewal = credentialRenewal;
  context.renewals.runMcpCredentials = runMcpCredentials;
  context.eventing.preparedTools = {
    close: async () => {
      order.push("tools-close");
    },
  } as typeof context.eventing.preparedTools;
  const deps = {
    ...context,
    db: {},
    input: {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      workflowId: "synthetic-workflow",
      workflowRunId: "synthetic-run",
    },
    dispatchId: "synthetic-activity",
    settings,
    activityStarted: performance.now(),
    activitySpan: { end() {} },
    sandboxResumeController: new AbortController(),
    activityContext: { heartbeat() {} },
    observability: {
      incrementCounter() {},
      incrementGauge() {},
      setGauge() {},
      observeHistogram: ({ name }: { name: string }) => {
        metrics.push(name);
      },
      info: (message: string) => {
        order.push(message);
      },
      error() {},
      recordWorkerActivity: ({ status }: { status: string }) => {
        order.push(status);
      },
    },
    leases: {
      codex: { held: false, stopHeartbeat() {} },
      xai: { held: false, stopHeartbeat() {} },
    },
    machineOpObserver: { drainEvents: () => [] },
    stopLeaseHeartbeat() {},
    turnCompletionMemoryCollector: { schedule() {} },
    noteCancellationRequested() {},
  } as unknown as TurnFinalizationDeps;
  context.sandboxState.nativeTurn.machine = {
    authority: {
      accountId: deps.input.accountId,
      workspaceId: deps.input.workspaceId,
      sessionId: deps.input.sessionId,
      attemptId: deps.input.attemptId,
      turnId: context.attempt.turnId!,
      executionGeneration: context.attempt.executionGeneration,
      machineId: crypto.randomUUID(),
      instance: {
        id: "synthetic-instance",
        bootId: "a".repeat(64),
        diskLineage: crypto.randomUUID(),
      },
    },
  } as SandboxV2TurnExecution["machine"];
  return { context, deps, settled, order, metrics };
}

test.each([true, false])(
  "pending native settlement withholds the receipt for interruption=%s",
  async (interrupted) => {
    const f = fixture();
    f.context.control.acknowledgeQuiescence = interrupted;
    if (!interrupted) f.context.control.activityStatus = "completed";
    const commit = spyOn(db, "commitSessionAttemptQuiescence").mockImplementation(async () => {
      throw Error("No receipt is licensed by pending native settlement");
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const finalizing = finalizeTurnAttempt(f.deps);
      const outcome = finalizing.catch((error) => error);
      await Bun.sleep(0);
      expect(f.context.sandboxState.attemptWritersDrained).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      f.settled.resolve({ state: "held", items: [], nextOperationId: null });
      expect(await outcome).toBeInstanceOf(SandboxV2AttemptWritersPendingError);
      expect(f.context.sandboxState.attemptWritersDrained).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      expect(f.metrics).not.toContain("opengeni_turn_physical_cancellation_duration_seconds");
      expect(f.order).not.toContain("agent turn physical cancellation completed");
      expect(f.order).toContain("cleanup_failed");
      expect(f.order).toContain("tools-close");
      expect(f.order.indexOf("tools-close")).toBeGreaterThan(f.order.indexOf("renewal-stop"));
      expect(f.order.filter((entry) => entry === "mcp-close")).toHaveLength(1);
      expect(f.order.filter((entry) => entry === "renewal-stop")).toHaveLength(1);
      expect(f.context.eventing.heartbeatTimer).toBeUndefined();
    } finally {
      commit.mockRestore();
      errors.mockRestore();
    }
  },
);

test("drained native settlement crosses the same exact receipt and ordinary cleanup boundary", async () => {
  const f = fixture();
  const commit = spyOn(db, "commitSessionAttemptQuiescence").mockImplementation(async () => {
    f.order.push("receipt");
    return { events: [], workflowWake: null };
  });
  try {
    const finalizing = finalizeTurnAttempt(f.deps);
    await Bun.sleep(0);
    expect(commit).not.toHaveBeenCalled();
    f.settled.resolve({ state: "drained", items: [], nextOperationId: null });
    await finalizing;
    expect(f.context.sandboxState.attemptWritersDrained).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(f.deps.db, {
      accountId: f.deps.input.accountId,
      workspaceId: f.deps.input.workspaceId,
      sessionId: f.deps.input.sessionId,
      attemptId: f.deps.input.attemptId,
      temporalWorkflowId: f.deps.input.workflowId,
      temporalWorkflowRunId: f.deps.input.workflowRunId,
      temporalActivityId: f.deps.dispatchId,
      allowUninterrupted: true,
      nativeAuthority: f.context.sandboxState.nativeTurn!.machine.authority,
    });
    expect(f.order.indexOf("receipt")).toBeGreaterThan(f.order.indexOf("renewal-stop"));
    expect(f.order.indexOf("tools-close")).toBeGreaterThan(f.order.indexOf("receipt"));
    expect(f.order.filter((entry) => entry === "mcp-close")).toHaveLength(1);
    expect(f.order.filter((entry) => entry === "renewal-stop")).toHaveLength(1);
    expect(f.order).toContain("cancelled");
    expect(f.metrics).toContain("opengeni_turn_physical_cancellation_duration_seconds");
    expect(f.context.eventing.heartbeatTimer).toBeUndefined();
  } finally {
    commit.mockRestore();
  }
});

test("ordinary native completion delivers its original physical receipt without an interruption", async () => {
  const f = fixture();
  f.context.control.acknowledgeQuiescence = false;
  f.context.control.activityStatus = "completed";
  f.context.control.turnMetricOutcome = "completed";
  const commit = spyOn(db, "commitSessionAttemptQuiescence").mockImplementation(async () => {
    f.order.push("receipt");
    return { events: [], workflowWake: null };
  });
  try {
    const finalizing = finalizeTurnAttempt(f.deps);
    await Bun.sleep(0);
    expect(commit).not.toHaveBeenCalled();
    f.settled.resolve({ state: "drained", items: [], nextOperationId: null });
    await finalizing;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![1].nativeAuthority).toEqual(
      f.context.sandboxState.nativeTurn!.machine.authority,
    );
    expect(f.order.indexOf("receipt")).toBeGreaterThan(f.order.indexOf("native-finalize"));
    expect(f.order).toContain("completed");
    expect(f.context.sandboxState.attemptWritersDrained).toBe(true);
  } finally {
    commit.mockRestore();
  }
});

test("native receipt recovery keeps the original owner snapshot after persistence failure", async () => {
  const f = fixture();
  f.context.control.acknowledgeQuiescence = false;
  f.context.control.activityStatus = "completed";
  f.context.control.turnMetricOutcome = "completed";
  const original = structuredClone(f.context.sandboxState.nativeTurn!.machine.authority);
  const signals: unknown[] = [];
  f.deps.signalSessionAttemptQuiesced = async (proof) => {
    signals.push(structuredClone(proof));
  };
  const commit = spyOn(db, "commitSessionAttemptQuiescence").mockImplementation(async () => {
    f.context.sandboxState.nativeTurn!.machine.authority.instance.bootId = "b".repeat(64);
    throw Error("Synthetic receipt persistence unavailable");
  });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    f.settled.resolve({ state: "drained", items: [], nextOperationId: null });
    await finalizeTurnAttempt(f.deps);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(signals).toEqual([
      {
        accountId: f.deps.input.accountId,
        workspaceId: f.deps.input.workspaceId,
        sessionId: f.deps.input.sessionId,
        attemptId: f.deps.input.attemptId,
        workflowId: f.deps.input.workflowId,
        workflowRunId: f.deps.input.workflowRunId,
        activityId: f.deps.dispatchId,
        nativeAuthority: original,
      },
    ]);
    expect(f.order).toContain("agent turn quiescence proof handed to workflow recovery");
  } finally {
    commit.mockRestore();
    errors.mockRestore();
  }
});
