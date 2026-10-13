import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ToolCallError } from "@openai/agents";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { ToolCallCommandNotStartedError } from "@opengeni/runtime";
import { ModalCommandStartPreDispatchUnavailableError } from "../../../packages/runtime/src/sandbox/providers/modal-command-router-wire";
import * as parentWake from "../src/activities/parent-wake";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import { createCoreSubscriptionRequests } from "../src/activities/agent-turn/subscription-core-requests";
import type { SubscriptionCoreTurn } from "../src/activities/agent-turn/turn-context";

// The exact production sequence: a subscription-core model answered with an
// exec_command call, and the command router was not ready before the command
// was sent. The answered request is still in the lane's custody while the
// tool runs, so recovery must checkpoint it, settle the call as not started,
// and use the connectivity backoff and limit.

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

async function notStartedExecFailure(): Promise<Error> {
  const proof = await ModalCommandStartPreDispatchUnavailableError.ensureReady({
    waitForReady: (_deadline: number, callback: (error: Error) => void) =>
      callback(new Error("router not ready")),
  } as never).catch((failure: Error) => failure);
  // The SDK rethrows the tool's failure in its own wrapper.
  return new ToolCallError(
    "Error running tool",
    new ToolCallCommandNotStartedError("call-exec", proof),
  );
}

/** A lane holding the answered request that asked for the tool. */
async function answeredLane(settles: string[]) {
  const lane = createCoreSubscriptionRequests({
    reserve: async (request) => ({ operationId: request.requestId }),
    settle: async ({ operationId, outcome }) => {
      settles.push(`${operationId}:${outcome}`);
    },
    displayName: "Provider",
    outcomeUnknown: () =>
      Object.assign(new Error("unknown"), { code: "subscription_core_request_outcome_unknown" }),
    isOutcomeUnknown: () => false,
  });
  const first = { requestId: "first", transportAttempt: 1 };
  await lane.reserve(first);
  await lane.observe({ ...first, outcome: "response_received" });
  expect(lane.canRecover()).toBe(false);
  return lane;
}

type Provider = "Codex" | "SuperGrok" | "Claude";

function deps(error: unknown, provider: Provider, requests: SubscriptionCoreTurn["requests"]) {
  const settle = mock(async (_input: unknown) => true);
  const core: SubscriptionCoreTurn = {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 4,
    personal: false,
    productModelId: "organization-subscription/model",
    requests,
  };
  const reconcile = mock(async (_options?: unknown) => undefined);
  return {
    settle,
    reconcile,
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
        // The model response that requested the tool reset the budget.
        providerRecoveryCount: 0,
        modelRequestStarted: true,
        redispatchesAtDispatch: 0,
        triggerType: "user",
      },
      billingState: {
        isCodexTurn: provider === "Codex",
        isXaiTurn: provider === "SuperGrok",
        isClaudeTurn: provider === "Claude",
      },
      eventing: { publish: async () => [], turnStartedPublished: true, settle },
      providerTurn: {
        codexSubscriptionCore: provider === "Codex" ? core : null,
        xaiSubscriptionCore: provider === "SuperGrok" ? core : null,
        claudeSubscriptionCore: provider === "Claude" ? core : null,
        latestClaudeUsage: new Map(),
      },
      leases: {
        codex: { lost: false },
        xai: { lost: false },
        claude: { lost: false, held: true, stopHeartbeat: () => undefined },
      },
      historySink: { reconcileConversationTruth: reconcile },
      claimedResult: (value: Record<string, unknown>) => ({ ...value, turnId: "turn-1" }),
      flushRuntimeBatcher: async () => undefined,
      acknowledgeLostAttemptOwnership: () => undefined,
      acknowledgeRecoveryQuiescence: () => undefined,
    },
  };
}

function coreRuntime() {
  spy(db, "subscriptionCoreSettlement").mockReturnValue({
    applySubscriptionCoreRefusal: async () => ({ receipt: false, health: false }),
  } as never);
  spy(db, "subscriptionCoreTurns").mockReturnValue({
    countSubscriptionCoreTurnRefusals: async () => 0,
    touchSubscriptionCoreBinding: async () => true,
  } as never);
  spy(db, "subscriptionCoreRequests").mockReturnValue({
    isSubscriptionCoreSourceDisconnected: async () => false,
  } as never);
  spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
  spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
}

function toolProgress(toolInterruptedRecoveries: number, toolCallInFlight = true) {
  return spy(db, "readSessionTurnToolProgressRecoveryState").mockResolvedValue({
    toolCallInFlight,
    toolInterruptedRecoveries,
  });
}

describe("a command that never started inside a tool call", () => {
  for (const provider of ["Codex", "SuperGrok", "Claude"] as const) {
    test(`recovers the same turn on a ${provider} core lane and settles the call as not started`, async () => {
      coreRuntime();
      toolProgress(0);
      const recovery = spy(db, "requestSessionTurnRecovery").mockResolvedValue({
        action: "recovering",
        events: [],
      } as never);
      const settles: string[] = [];
      const { deps: input, settle } = deps(
        await notStartedExecFailure(),
        provider,
        await answeredLane(settles),
      );
      expect(await settleTurnFailure(input as never)).toMatchObject({
        status: "recovering",
        continueDelayMs: 2_000,
      });
      // The answered request is checkpointed after its history commits.
      expect(settles).toEqual(["first:response_received"]);
      expect(settle).not.toHaveBeenCalled();
      expect(recovery).toHaveBeenCalledTimes(1);
      expect(recovery.mock.calls[0]![2]).toMatchObject({
        turnId: "turn-1",
        attemptId: "attempt-1",
        reason: "sandbox_command_start_unavailable",
        providerRecoveryCount: 1,
        notStartedToolCallIds: ["call-exec"],
        detail: {
          code: "sandbox_command_start_unavailable",
          retryable: true,
          continueDelayMs: 2_000,
          maxProviderRecoveryCount: 5,
        },
      });
    });
  }

  test("recoveries since the last tool progress keep the connectivity backoff and limit", async () => {
    coreRuntime();
    const recovery = spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    for (const [prior, continueDelayMs] of [2_000, 5_000, 15_000, 30_000, 60_000].entries()) {
      toolProgress(prior);
      const { deps: input } = deps(await notStartedExecFailure(), "Codex", await answeredLane([]));
      expect(await settleTurnFailure(input as never)).toMatchObject({
        status: "recovering",
        continueDelayMs,
      });
      expect(recovery.mock.calls.at(-1)![2]).toMatchObject({
        providerRecoveryCount: prior + 1,
      });
    }
  });

  test("exhaustion fails the turn with a not-started call, so Retry stays available", async () => {
    coreRuntime();
    toolProgress(5);
    const recovery = spy(db, "requestSessionTurnRecovery");
    const { deps: input, settle } = deps(
      await notStartedExecFailure(),
      "Codex",
      await answeredLane([]),
    );
    expect(await settleTurnFailure(input as never)).toMatchObject({ status: "failed" });
    expect(recovery).not.toHaveBeenCalled();
    const settled = settle.mock.calls[0]![0] as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
      notStartedToolCallIds?: string[];
    };
    expect(settled.notStartedToolCallIds).toEqual(["call-exec"]);
    expect(settled.events[0]).toMatchObject({
      type: "turn.failed",
      payload: {
        code: "sandbox_command_start_unavailable",
        retryable: false,
        recoveryExhausted: true,
        providerRecoveryCount: 5,
        maxProviderRecoveryCount: 5,
      },
    });
    expect(String(settled.events[0]!.payload.error)).toBe(
      "The sandbox isn't ready yet. Opengeni retried 5 times without success. Try again in a few minutes.",
    );
  });

  test("a turn without an in-flight tool keeps the model-response budget", async () => {
    coreRuntime();
    toolProgress(4, false);
    const recovery = spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    const { deps: input } = deps(await notStartedExecFailure(), "Codex", await answeredLane([]));
    expect(await settleTurnFailure(input as never)).toMatchObject({ continueDelayMs: 2_000 });
    expect(recovery.mock.calls[0]![2]).toMatchObject({ providerRecoveryCount: 1 });
  });

  test("a lane that cannot be made replay safe fails without promising a retry", async () => {
    coreRuntime();
    toolProgress(0);
    const recovery = spy(db, "requestSessionTurnRecovery");
    const unrecoverable = {
      checkpoint: async () => undefined,
      canRecover: () => false,
      hasUnknownOutcome: () => false,
      unknownIsOwnAndSettled: () => false,
    } as unknown as SubscriptionCoreTurn["requests"];
    const { deps: input, settle } = deps(await notStartedExecFailure(), "Codex", unrecoverable);
    expect(await settleTurnFailure(input as never)).toMatchObject({ status: "failed" });
    expect(recovery).not.toHaveBeenCalled();
    const settled = settle.mock.calls[0]![0] as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
      notStartedToolCallIds?: string[];
    };
    expect(settled.notStartedToolCallIds).toEqual(["call-exec"]);
    expect(settled.events[0]!.payload).toMatchObject({
      code: "sandbox_command_start_unavailable",
      retryable: false,
      automaticRecovery: "unavailable",
      error:
        "The sandbox isn't ready yet. Opengeni couldn't retry this turn automatically. Try again, or send a message to continue.",
    });
    expect(String(settled.events[0]!.payload.error)).not.toContain("will retry");
  });
});
