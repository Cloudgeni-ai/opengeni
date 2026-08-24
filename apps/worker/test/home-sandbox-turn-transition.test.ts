import { describe, expect, mock, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import {
  ActiveBackendUnresolvableError,
  RoutingWorkspaceRootChangedError,
} from "@opengeni/runtime";
import {
  isHomeSandboxTurnTransitionError,
  sandboxRouteTransitionCode,
} from "../src/activities/agent-turn/errors";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";

describe("Connected Machine to managed-home turn transition", () => {
  test("recognizes the typed routing signal through SDK aggregate wrappers only", () => {
    const transition = new ActiveBackendUnresolvableError(
      "home_unavailable_this_turn",
      "home is available to the next attempt",
    );

    expect(isHomeSandboxTurnTransitionError(transition)).toBe(true);
    expect(
      isHomeSandboxTurnTransitionError(
        new Error("function tool batch failed", {
          cause: new AggregateError([new Error("peer failed"), transition], "tool failures"),
        }),
      ),
    ).toBe(true);
    expect(
      isHomeSandboxTurnTransitionError(
        Object.assign(new Error("cross-package typed error"), {
          name: "ActiveBackendUnresolvableError",
          code: "home_unavailable_this_turn",
        }),
      ),
    ).toBe(true);

    expect(
      isHomeSandboxTurnTransitionError(
        new Error("ActiveBackendUnresolvableError: home_unavailable_this_turn"),
      ),
    ).toBe(false);
    expect(
      sandboxRouteTransitionCode(
        new RoutingWorkspaceRootChangedError("/workspace", "/home/user/project"),
      ),
    ).toBe("workspace_root_changed_this_turn");
    expect(
      isHomeSandboxTurnTransitionError(
        new ActiveBackendUnresolvableError("stale_pointer", "sandbox row disappeared"),
      ),
    ).toBe(false);
  });

  test("checkpoints completed truth and recovers the same logical turn", async () => {
    const transition = new ActiveBackendUnresolvableError(
      "home_unavailable_this_turn",
      "home is available to the next attempt",
    );
    const error = new AggregateError([transition], "Failed to run function tools");
    const requestRecovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    });
    const flushRuntimeBatcher = mock(async () => undefined);
    const reconcileConversationTruth = mock(async () => undefined);
    const acknowledgeRecoveryQuiescence = mock(() => undefined);
    const acknowledgeLostAttemptOwnership = mock(() => undefined);
    const control = {
      cancellationRequestedAt: null,
      activityStatus: "unknown",
      turnMetricOutcome: null,
      activityError: null,
      acknowledgeQuiescence: false,
    };

    try {
      const result = await settleTurnFailure({
        error,
        input: {
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          attemptId: "attempt-1",
        },
        settings: {},
        db: {},
        bus: {},
        observability: {},
        wakeSessionWorkflow: async () => undefined,
        signalCodexCapacityWorkflow: async () => undefined,
        cancellationSignal: undefined,
        sandboxRotationController: new AbortController(),
        noteCancellationRequested: () => undefined,
        codexWorkspaceKey: "workspace-key",
        control,
        attempt: {
          turnId: "turn-1",
          triggerEventId: "trigger-1",
          executionGeneration: 1,
          providerRecoveryCount: 0,
          modelRequestStarted: true,
          redispatchesAtDispatch: 0,
          triggerType: "user",
        },
        billingState: {},
        eventing: { publish: async () => [], turnStartedPublished: true },
        providerTurn: {},
        leases: {},
        historySink: { reconcileConversationTruth },
        claimedResult: (value: Record<string, unknown>) => ({
          ...value,
          turnId: "turn-1",
          attemptId: "attempt-1",
        }),
        flushRuntimeBatcher,
        acknowledgeLostAttemptOwnership,
        acknowledgeRecoveryQuiescence,
      } as never);

      expect(result).toEqual({
        status: "recovering",
        turnId: "turn-1",
        attemptId: "attempt-1",
      });
      expect(flushRuntimeBatcher).toHaveBeenCalledTimes(1);
      expect(reconcileConversationTruth).toHaveBeenCalledWith({ requireDurable: true });
      expect(requestRecovery).toHaveBeenCalledWith({}, "workspace-1", {
        sessionId: "session-1",
        turnId: "turn-1",
        triggerEventId: "trigger-1",
        attemptId: "attempt-1",
        reason: "sandbox_route_transition",
        detail: {
          code: "home_unavailable_this_turn",
          effectiveBoundary: "next_attempt",
        },
      });
      expect(acknowledgeRecoveryQuiescence).toHaveBeenCalledTimes(1);
      expect(acknowledgeLostAttemptOwnership).not.toHaveBeenCalled();
      expect(control.activityStatus).toBe("recovering");
      expect(control.turnMetricOutcome).toBe("recovering");
      expect(control.activityError).toBe(error);
    } finally {
      requestRecovery.mockRestore();
    }
  });
});
