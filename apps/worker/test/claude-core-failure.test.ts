import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { AnthropicRequestError } from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import * as parentWake from "../src/activities/parent-wake";
import * as coreRequests from "../src/activities/agent-turn/subscription-core-requests";
import * as coreSettlementSteps from "../src/activities/agent-turn/subscription-core-settlement";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import {
  finalizeTurnAttempt,
  type TurnFinalizationDeps,
} from "../src/activities/agent-turn/finalization";
import {
  createTurnContext,
  type SubscriptionCoreTurn,
} from "../src/activities/agent-turn/turn-context";

// Failure settlement and finalization of a core-placed Claude turn (design
// 5.3, Claude track C1a): an unknown outcome is terminal, a lost lease
// recovers only after the history checkpoint, the legacy Claude receipts,
// waits and release never run, and a legacy Claude turn keeps its paths.

const restores: Array<{ mockRestore(): void }> = [];
function spy<T extends object, K extends keyof T>(target: T, key: K) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const handle = spyOn(target as any, key as any);
  restores.push(handle);
  return handle;
}
afterEach(() => {
  while (restores.length > 0) restores.pop()!.mockRestore();
});

const identity: db.SubscriptionCoreTurnIdentity = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  sessionOwnerSubjectId: "user:owner",
  sessionOwnerMembershipId: "00000000-0000-4000-8000-000000000001",
  initiatingHumanSubjectId: "user:owner",
  acceptedAuthorityV2: { version: 2, personal: [] },
};

function core(overrides: Partial<SubscriptionCoreTurn> = {}): SubscriptionCoreTurn {
  return {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 4,
    personal: false,
    ...overrides,
  };
}

function anthropic(status: number, type: string) {
  return new AnthropicRequestError(
    "Synthetic provider failure",
    status,
    "anthropic_http_error",
    { type, message: "Fixture" },
    new Headers(),
    { subscription: true },
  );
}

function lane(options: { unknown?: boolean; unresolved?: boolean } = {}) {
  return {
    checkpoint: async () => undefined,
    canRecover: () => !options.unknown && !options.unresolved,
    hasUnknownOutcome: () => options.unknown === true,
  } as unknown as SubscriptionCoreTurn["requests"];
}

function failureDeps(error: unknown, coreTurn: SubscriptionCoreTurn | null, lost = false) {
  const order: string[] = [];
  return {
    order,
    deps: {
      error,
      input: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        workflowId: "session-session-1",
      },
      settings: {},
      db: {},
      bus: {},
      observability: {
        incrementCounter: () => undefined,
        observeHistogram: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        info: () => undefined,
      },
      wakeSessionWorkflow: async () => undefined,
      cancellationSignal: undefined,
      sandboxRotationController: new AbortController(),
      noteCancellationRequested: () => undefined,
      codexWorkspaceKey: "workspace-key",
      control: {
        cancellationRequestedAt: null,
        activityStatus: "unknown",
        turnMetricOutcome: null,
        activityError: null,
      },
      attempt: {
        turnId: "turn-1",
        dispatchId: "dispatch-1",
        triggerEventId: "trigger-1",
        executionGeneration: 3,
        providerRecoveryCount: 0,
        modelRequestStarted: true,
        redispatchesAtDispatch: 0,
        triggerType: "user",
      },
      billingState: { isClaudeTurn: true },
      eventing: {
        publish: async () => [],
        turnStartedPublished: true,
        settle: async () => true,
      },
      providerTurn: {
        effectiveClaudeCredentialId: coreTurn ? "connection-core" : "credential-legacy",
        // Legacy serving evidence on both routes, so the route gate alone decides.
        effectiveClaudeCredentialVersion: 4,
        claudeAuthoritySnapshot: { version: 1, scope: "organization" },
        claudeUpstreamModelId: "claude-sonnet-5",
        claudeSubscriptionCore: coreTurn,
        xaiSubscriptionCore: null,
        codexSubscriptionCore: null,
        latestClaudeUsage: new Map(),
      },
      leases: {
        codex: { lost: false },
        xai: { lost: false },
        claude: {
          lost,
          held: true,
          subjectId: "user:owner",
          holderId: "claude-turn:session-1:turn-1",
          generation: 3,
          stopHeartbeat: () => undefined,
          releaseCurrent: async () => true,
        },
      },
      historySink: {
        reconcileConversationTruth: async () => {
          order.push("history");
        },
      },
      claimedResult: (value: Record<string, unknown>) => ({ ...value, turnId: "turn-1" }),
      flushRuntimeBatcher: async () => undefined,
      acknowledgeLostAttemptOwnership: () => undefined,
      acknowledgeRecoveryQuiescence: () => undefined,
    },
  };
}

/** The legacy Claude settlement (receipts, refresh recovery, its wait) as spies. */
function legacyClaudeSettlement() {
  return {
    goal: spy(db, "getSessionGoal").mockResolvedValue(null as never),
    others: [
      spy(db, "armClaudeCapacityWait"),
      spy(db, "reconcileClaudeCapacityWait"),
      spy(db, "loadClaudeAccountCredential"),
      spy(db, "recordClaudeAccountUsage"),
    ],
  };
}

function recovery(order: string[]) {
  spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
  return spy(db, "requestSessionTurnRecovery").mockImplementation((async () => {
    order.push("recovery");
    return { action: "recovering", events: [] };
  }) as never);
}

describe("Claude failure settlement on the core", () => {
  test("an unknown request outcome is terminal: no recovery, no legacy receipt or wait", async () => {
    const legacy = legacyClaudeSettlement();
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const error = new Error("stream broke", {
      cause: db.SUBSCRIPTION_CORE_CLAUDE.errors.requestOutcomeUnknown(),
    });
    const { deps, order } = failureDeps(error, core({ requests: lane({ unknown: true }) }), true);
    const settle = mock(async (_input: unknown) => true);
    (deps as { eventing: { settle: unknown } }).eventing.settle = settle;
    const recover = recovery(order);
    const settled = await settleTurnFailure(deps as never).catch((caught: unknown) => caught);
    expect(recover).not.toHaveBeenCalled();
    expect(JSON.stringify(settled)).not.toContain("recovering");
    const terminal = settle.mock.calls[0]![0] as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(terminal.events[0]).toMatchObject({
      type: "turn.failed",
      payload: { code: "subscription_core_request_outcome_unknown", retryable: false },
    });
    expect(legacy.goal).not.toHaveBeenCalled();
    for (const other of legacy.others) expect(other).not.toHaveBeenCalled();
  });

  test("a lost core lease recovers the same turn only after the history checkpoint", async () => {
    const recoverAfter = spy(coreRequests, "coreLanesRecoverAfterCheckpoint");
    const legacy = legacyClaudeSettlement();
    const { deps, order } = failureDeps(
      new Error("lease lost"),
      core({ requests: lane(), titleRequests: lane() }),
      true,
    );
    const recover = recovery(order);
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(recoverAfter).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1",
      expect.objectContaining({
        reason: "claude_lease_lost",
        detail: { provider: "claude-subscription" },
      }),
    );
    expect(order.indexOf("history")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("history")).toBeLessThan(order.indexOf("recovery"));
    expect(legacy.goal).not.toHaveBeenCalled();
  });

  test("a lost core lease with a request of unknown outcome never recovers", async () => {
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps, order } = failureDeps(
      new Error("lease lost"),
      core({ requests: lane(), titleRequests: lane({ unknown: true }) }),
      true,
    );
    const recover = recovery(order);
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(recover).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: "claude_lease_lost" }),
    );
  });

  test("a lost core lease with a request still unresolved (not unknown) never recovers", async () => {
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps, order } = failureDeps(
      new Error("lease lost"),
      core({ requests: lane({ unresolved: true }), titleRequests: lane() }),
      true,
    );
    const recover = recovery(order);
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(order).toContain("history");
    expect(recover).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: "claude_lease_lost" }),
    );
  });

  test("a lost core lease before the turn start was published neither checkpoints nor recovers", async () => {
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const recoverAfter = spy(coreRequests, "coreLanesRecoverAfterCheckpoint");
    const { deps, order } = failureDeps(
      new Error("lease lost"),
      core({ requests: lane(), titleRequests: lane() }),
      true,
    );
    (deps as { eventing: { turnStartedPublished: boolean } }).eventing.turnStartedPublished = false;
    const recover = recovery(order);
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(recoverAfter).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: "claude_lease_lost" }),
    );
  });

  test("a core account refusal never enters the legacy Claude receipts, refresh recovery or wait", async () => {
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const legacy = legacyClaudeSettlement();
    const { deps, order } = failureDeps(
      anthropic(429, "rate_limit_error"),
      core({ requests: lane(), titleRequests: lane() }),
    );
    recovery(order);
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(legacy.goal).not.toHaveBeenCalled();
    for (const other of legacy.others) expect(other).not.toHaveBeenCalled();
  });

  test("a legacy Claude turn keeps its paths: no core checkpoint, legacy refusal settlement", async () => {
    const recoverAfter = spy(coreRequests, "coreLanesRecoverAfterCheckpoint");
    const lost = failureDeps(new Error("lease lost"), null, true);
    const recover = recovery(lost.order);
    expect(await settleTurnFailure(lost.deps as never)).toMatchObject({ status: "recovering" });
    expect(recoverAfter).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1",
      expect.objectContaining({ reason: "claude_lease_lost" }),
    );
    // The same refusal a core turn skips enters the legacy settlement.
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const legacy = legacyClaudeSettlement();
    const refused = failureDeps(anthropic(429, "rate_limit_error"), null);
    await settleTurnFailure(refused.deps as never).catch(() => undefined);
    expect(legacy.goal).toHaveBeenCalledTimes(1);
  });
});

describe("Claude turn finalization by route", () => {
  function finalizationDeps(placedOnCore: boolean) {
    const settings = { workspaceCaptureEnabled: false } as Settings;
    const context = createTurnContext({ settings, cancellationRequestedAt: null });
    context.control.activityStatus = "idle";
    context.control.turnMetricOutcome = "completed";
    context.attempt.turnId = "turn-1";
    context.attempt.executionGeneration = 3;
    context.providerTurn.effectiveClaudeCredentialId = placedOnCore
      ? "connection-core"
      : "credential-legacy";
    if (placedOnCore) context.providerTurn.claudeSubscriptionCore = core();
    const releaseCurrent = mock(async () => true);
    return {
      releaseCurrent,
      deps: {
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
          codex: { held: false, stopHeartbeat() {} },
          xai: { held: false, stopHeartbeat() {} },
          claude: {
            held: true,
            // A subject on both routes, so the route gate alone decides.
            subjectId: "user:owner",
            holderId: "claude-turn:session-1:turn-1",
            generation: 3,
            releaseCurrent,
            stopHeartbeat() {},
          },
        },
        machineOpObserver: { drainEvents: () => [] },
        stopLeaseHeartbeat() {},
        turnCompletionMemoryCollector: { schedule() {} },
        noteCancellationRequested() {},
      } as unknown as TurnFinalizationDeps,
    };
  }

  test("the legacy route releases the legacy lease; the core finalizes its binding and releases its own lease", async () => {
    const legacyRelease = spy(db, "releaseClaudeCredentialLease").mockResolvedValue(
      undefined as never,
    );
    const finalize = spy(coreSettlementSteps, "finalizeCoreSubscriptionTurn").mockResolvedValue(
      undefined,
    );
    const legacy = finalizationDeps(false);
    await finalizeTurnAttempt(legacy.deps);
    expect(legacyRelease).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(legacy.releaseCurrent).not.toHaveBeenCalled();
    const placed = finalizationDeps(true);
    await finalizeTurnAttempt(placed.deps);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0]![0]).toMatchObject({
      provider: db.SUBSCRIPTION_CORE_CLAUDE,
      core: placed.deps.providerTurn.claudeSubscriptionCore,
    });
    expect(placed.releaseCurrent).toHaveBeenCalledTimes(1);
    // The legacy release never runs for the core lease.
    expect(legacyRelease).toHaveBeenCalledTimes(1);
  });
});
