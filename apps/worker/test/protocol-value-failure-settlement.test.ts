import { describe, expect, mock, spyOn, test } from "bun:test";
import { normalizeProtocolJsonValue, UnsupportedProtocolJsonValueError } from "@opengeni/runtime";
import * as parentWake from "../src/activities/parent-wake";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import {
  UNSUPPORTED_PROTOCOL_VALUE_CODE,
  UNSUPPORTED_PROTOCOL_VALUE_MESSAGE,
} from "../src/activities/agent-turn/protocol-value-failure";

/** The error the history guard raised in the staging incident of 2 November 2026. */
function symbolKeyRejection(): UnsupportedProtocolJsonValueError {
  try {
    normalizeProtocolJsonValue({ type: "hosted_tool_call", [Symbol("mark")]: "runtime" });
  } catch (error) {
    if (error instanceof UnsupportedProtocolJsonValueError) return error;
  }
  throw new Error("expected a protocol JSON rejection");
}

function failureDeps(error: unknown, options: { turnStartedPublished?: boolean } = {}) {
  const settle = mock(async (_input: unknown) => true);
  const reconcile = mock(async () => undefined);
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
      modelRequestStarted: false,
      redispatchesAtDispatch: 0,
      triggerType: "user",
    },
    billingState: { isCodexTurn: false },
    eventing: {
      publish: async () => [],
      turnStartedPublished: options.turnStartedPublished ?? true,
      settle,
    },
    providerTurn: {
      effectiveCodexCredentialId: null,
      codexCredentialFailoverLimit: 0,
      latestCodexUsage: null,
    },
    leases: { codex: { lost: false, held: false }, xai: { lost: false } },
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

describe("a value refused by a protocol JSON boundary", () => {
  test("ends the turn with a typed failure and keeps the session usable", async () => {
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
        expect(settle).toHaveBeenCalledTimes(1);
        expect(settle.mock.calls[0]![0]).toEqual({
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
        });
        expect(control.activityStatus).toBe("idle");
        expect(control.turnMetricOutcome).toBe("failed");
      }
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally {
      deliver.mockRestore();
    }
  });

  test("a superseded settlement stays cancelled", async () => {
    const { deps, settle } = failureDeps(symbolKeyRejection());
    settle.mockImplementation(async () => false);
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "cancelled" });
  });

  test("before the turn has visibly started the error still fails the attempt", async () => {
    const error = symbolKeyRejection();
    const { deps, settle } = failureDeps(error, { turnStartedPublished: false });
    await expect(settleTurnFailure(deps as never)).rejects.toBe(error);
    expect(settle).not.toHaveBeenCalled();
  });
});
