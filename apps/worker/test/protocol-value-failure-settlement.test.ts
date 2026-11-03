import { describe, expect, mock, spyOn, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { CancelledFailure } from "@temporalio/activity";
import { UnsupportedProtocolJsonValueError } from "@opengeni/runtime";
import * as parentWake from "../src/activities/parent-wake";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import {
  UNSUPPORTED_PROTOCOL_VALUE_CODE,
  UNSUPPORTED_PROTOCOL_VALUE_MESSAGE,
} from "../src/activities/agent-turn/protocol-value-failure";

/**
 * The error the history guard raised in the staging incident of 2 November
 * 2026. Normalization now converts instead, so a stricter boundary is the
 * only remaining source of this refusal.
 */
function symbolKeyRejection(): UnsupportedProtocolJsonValueError {
  return new UnsupportedProtocolJsonValueError("$", "cannot contain symbol keys");
}

/** What `JSON.stringify` throws on a bigint, from a serializer outside protocol JSON. */
function stringifyRefusal(): TypeError {
  try {
    JSON.stringify({ usage: 1n });
  } catch (error) {
    if (error instanceof TypeError) return error;
  }
  throw new Error("expected JSON.stringify to refuse a bigint");
}

function failureDeps(
  error: unknown,
  options: { turnStartedPublished?: boolean; modelRequestStarted?: boolean } = {},
) {
  const settle = mock(async (_input: unknown) => true);
  const reconcile = mock(async (_options?: { requireDurable?: boolean }) => undefined);
  const control = {
    cancellationRequestedAt: null,
    activityStatus: "unknown",
    turnMetricOutcome: null as string | null,
    activityError: null as unknown,
    acknowledgeQuiescence: false,
  };
  const deps = {
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
    },
    wakeSessionWorkflow: async () => undefined,
    cancellationSignal: undefined,
    sandboxRotationController: new AbortController(),
    noteCancellationRequested: () => undefined,
    codexWorkspaceKey: "workspace-key",
    control,
    attempt: {
      turnId: "turn-1",
      dispatchId: "dispatch-1",
      triggerEventId: "trigger-1",
      executionGeneration: 1,
      providerRecoveryCount: 0,
      modelRequestStarted: options.modelRequestStarted ?? false,
      redispatchesAtDispatch: 0,
      triggerType: "user",
    },
    billingState: { isCodexTurn: false, isXaiTurn: false, isClaudeTurn: false },
    eventing: {
      publish: async () => [],
      turnStartedPublished: options.turnStartedPublished ?? true,
      settle,
    },
    providerTurn: {
      effectiveCodexCredentialId: null,
      codexCredentialFailoverLimit: 0,
      latestCodexUsage: null,
    } as Record<string, unknown>,
    leases: {
      codex: { lost: false, held: false },
      xai: { lost: false },
      claude: { lost: false },
    },
    historySink: { reconcileConversationTruth: reconcile },
    claimedResult: (value: Record<string, unknown>) => ({
      ...value,
      turnId: "turn-1",
      attemptId: "attempt-1",
    }),
    flushRuntimeBatcher: async () => undefined,
    acknowledgeLostAttemptOwnership: () => undefined,
    acknowledgeRecoveryQuiescence: () => undefined,
  };
  return { deps, control, settle, reconcile };
}

const idleSettlement = {
  events: [
    {
      type: "turn.failed",
      payload: {
        error: UNSUPPORTED_PROTOCOL_VALUE_MESSAGE,
        code: UNSUPPORTED_PROTOCOL_VALUE_CODE,
        retryable: false,
        protocolValueError: "Protocol JSON value at $ cannot contain symbol keys",
        recovery: "user_message",
      },
    },
    { type: "session.status.changed", payload: { status: "idle" } },
  ],
  turnStatus: "failed",
  sessionStatus: "idle",
  activeTurnId: null,
  suppressGoalContinuation: true,
};

function settledSessionStatus(settle: ReturnType<typeof failureDeps>["settle"]): unknown {
  return (settle.mock.calls[0]![0] as { sessionStatus: unknown }).sessionStatus;
}

describe("a value refused by a protocol JSON boundary", () => {
  test("ends the turn with a typed failure, keeps the session usable and stops the goal", async () => {
    const deliver = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    try {
      // As it reaches settlement from turn preparation, possibly wrapped.
      for (const error of [
        symbolKeyRejection(),
        new Error("Turn input preparation failed", { cause: symbolKeyRejection() }),
      ]) {
        const { deps, control, settle, reconcile } = failureDeps(error);
        const result = await settleTurnFailure(deps as never);

        expect(result).toMatchObject({ status: "idle", turnId: "turn-1" });
        expect(reconcile).toHaveBeenCalledTimes(1);
        // Nothing ran yet: the history save keeps its ordinary policy.
        expect(reconcile.mock.calls[0]![0]).toBeUndefined();
        expect(settle).toHaveBeenCalledTimes(1);
        // A goal does not continue into the same refusal; it waits for new input.
        expect(settle.mock.calls[0]![0]).toEqual(idleSettlement);
        expect(control.activityStatus).toBe("idle");
        expect(control.turnMetricOutcome).toBe("failed");
      }
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally {
      deliver.mockRestore();
    }
  });

  test("a JSON.stringify refusal from another serializer ends the turn the same way", async () => {
    const deliver = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    try {
      const refusal = stringifyRefusal();
      const { deps, settle } = failureDeps(
        new Error("Failed to run function tools", { cause: refusal }),
      );
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
      expect(settle.mock.calls[0]![0]).toEqual({
        ...idleSettlement,
        events: [
          {
            type: "turn.failed",
            payload: {
              ...idleSettlement.events[0]!.payload,
              protocolValueError: refusal.message,
            },
          },
          idleSettlement.events[1],
        ],
      });
      // An unrelated TypeError keeps the generic failure.
      const other = failureDeps(new TypeError("x is not a function"));
      expect(await settleTurnFailure(other.deps as never)).toMatchObject({ status: "failed" });
    } finally {
      deliver.mockRestore();
    }
  });

  test("a superseded settlement stays cancelled", async () => {
    const deliver = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    try {
      const { deps, settle } = failureDeps(symbolKeyRejection());
      settle.mockImplementation(async () => false);
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "cancelled" });
      // The refusal was settled as the typed, idle failure, not the generic one.
      expect(settle.mock.calls[0]![0]).toEqual(idleSettlement);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      deliver.mockRestore();
    }
  });

  test("after a model request started, the turn's work is saved durably first", async () => {
    const deliver = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    try {
      const { deps, settle, reconcile } = failureDeps(symbolKeyRejection(), {
        modelRequestStarted: true,
      });
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
      expect(reconcile.mock.calls).toEqual([[{ requireDurable: true }]]);
      expect(settle.mock.calls[0]![0]).toEqual(idleSettlement);
    } finally {
      deliver.mockRestore();
    }
  });

  test("when the turn's work cannot be saved, the session fails instead of continuing", async () => {
    const deliver = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { deps, settle, reconcile } = failureDeps(symbolKeyRejection(), {
        modelRequestStarted: true,
      });
      // The same refusal repeats while saving the turn's items.
      reconcile.mockImplementationOnce(async () => {
        throw symbolKeyRejection();
      });
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settledSessionStatus(settle)).toBe("failed");
      expect(deps.control.activityStatus).toBe("failed");
    } finally {
      quiet.mockRestore();
      deliver.mockRestore();
    }
  });

  test("an unknown Claude request outcome keeps its own terminal failure", async () => {
    const deliver = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    try {
      const { deps, settle, reconcile } = failureDeps(symbolKeyRejection(), {
        modelRequestStarted: true,
      });
      deps.billingState.isClaudeTurn = true;
      deps.providerTurn.claudeSubscriptionCore = {
        requests: {
          hasUnknownOutcome: () => true,
          admissionRefused: () => true,
          unknownIsOwnAndSettled: () => false,
          canRecover: () => false,
          settlementsRecorded: async () => undefined,
        },
      };
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
      expect(reconcile).toHaveBeenCalledWith({ requireDurable: true });
      const settlement = settle.mock.calls[0]![0] as {
        sessionStatus: string;
        events: Array<{ type: string; payload: { code?: string } }>;
      };
      expect(settlement.sessionStatus).toBe("failed");
      expect(settlement.events[0]!.payload.code).not.toBe(UNSUPPORTED_PROTOCOL_VALUE_CODE);
    } finally {
      deliver.mockRestore();
    }
  });

  test("cancellation still wins over the refusal", async () => {
    const cancelled = new CancelledFailure("CANCELLED", [], symbolKeyRejection());
    const { deps, settle } = failureDeps(cancelled);
    await expect(settleTurnFailure(deps as never)).rejects.toBe(cancelled);
    expect(settle).not.toHaveBeenCalled();
    expect(deps.control.activityStatus).toBe("cancelled");
  });

  test("database recovery still wins over the refusal", async () => {
    const rejection = symbolKeyRejection();
    Object.assign(rejection, {
      cause: new DrizzleQueryError(
        "INSERT INTO runtime_records (payload) VALUES ($1)",
        ["fixture-value"],
        Object.assign(new Error("transaction aborted"), { name: "PostgresError", code: "40P01" }),
      ),
    });
    const { deps, settle } = failureDeps(
      new Error("History persistence failed", { cause: rejection }),
    );
    await expect(settleTurnFailure(deps as never)).rejects.toMatchObject({
      type: "OpenGeniPostClaimDatabaseRecovery",
    });
    expect(settle).not.toHaveBeenCalled();
    expect(deps.control.activityStatus).toBe("recovering");
  });

  test("before the turn has visibly started the error still fails the attempt", async () => {
    const error = symbolKeyRejection();
    const { deps, settle } = failureDeps(error, { turnStartedPublished: false });
    await expect(settleTurnFailure(deps as never)).rejects.toBe(error);
    expect(settle).not.toHaveBeenCalled();
  });
});
