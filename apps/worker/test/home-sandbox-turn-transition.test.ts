import { describe, expect, mock, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import {
  ActiveBackendUnresolvableError,
  RoutingWorkspaceRootChangedError,
} from "@opengeni/runtime";
import {
  isHomeSandboxTurnTransitionError,
  sandboxLifecycleTransitionDiagnostic,
  sandboxRouteTransitionCode,
} from "../src/activities/agent-turn/errors";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import {
  isLazySandboxProvisionRetryable,
  ORGANIZATION_SANDBOX_CAPACITY_RETRY_MS,
} from "../src/activities/agent-turn/sandbox-provision";

describe("Connected Machine to managed-home turn transition", () => {
  test("recognizes sandbox lifecycle transitions through SDK aggregate wrappers only", () => {
    const transition = new opengeniDb.SandboxLeaseTransitionError(
      "group-1",
      5,
      "capture_in_progress",
      "modal",
      "sb-1",
      "draining",
    );

    expect(
      sandboxLifecycleTransitionDiagnostic(
        new Error("Failed to run function tools", {
          cause: new AggregateError([new Error("peer failed"), transition], "tool failures"),
        }),
      ),
    ).toEqual({
      sandboxGroupId: "group-1",
      leaseEpoch: 5,
      reason: "capture_in_progress",
    });
    expect(
      sandboxLifecycleTransitionDiagnostic(
        new Error("SandboxLeaseTransitionError: capture_in_progress"),
      ),
    ).toBeNull();
  });

  test("recovers a lifecycle transition wrapped by function-tool execution", async () => {
    const transition = new opengeniDb.SandboxLeaseTransitionError(
      "group-1",
      5,
      "capture_in_progress",
      "modal",
      "sb-1",
      "draining",
    );
    const error = new AggregateError([transition], "Failed to run function tools");
    const requestRecovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    });
    const readLease = spyOn(opengeniDb, "readLease").mockResolvedValue({
      leaseEpoch: 6,
      rotationRequestedAt: new Date(),
      rotationReason: "operator",
    } as never);
    const acknowledgeRecoveryQuiescence = mock(() => undefined);
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
        settings: { sandboxLeaseReaperPeriodMs: 10_000 },
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
        historySink: { reconcileConversationTruth: async () => undefined },
        claimedResult: (value: Record<string, unknown>) => ({
          ...value,
          turnId: "turn-1",
          attemptId: "attempt-1",
        }),
        flushRuntimeBatcher: async () => undefined,
        acknowledgeLostAttemptOwnership: () => undefined,
        acknowledgeRecoveryQuiescence,
      } as never);

      expect(result).toEqual({
        status: "recovering",
        turnId: "turn-1",
        attemptId: "attempt-1",
      });
      expect(requestRecovery).toHaveBeenCalledWith({}, "workspace-1", {
        sessionId: "session-1",
        turnId: "turn-1",
        triggerEventId: "trigger-1",
        attemptId: "attempt-1",
        reason: "sandbox_lifecycle_transition",
        detail: {
          sandboxGroupId: "group-1",
          leaseEpoch: 5,
          rotationReason: "operator",
          transitionReason: "capture_in_progress",
        },
        sandboxLifecycleWait: {
          version: 1,
          sandboxGroupId: "group-1",
          leaseEpoch: 6,
          reason: "rotation_in_progress",
        },
      });
      expect(acknowledgeRecoveryQuiescence).toHaveBeenCalledTimes(1);
      expect(control.activityStatus).toBe("recovering");
      expect(control.turnMetricOutcome).toBe("recovering");
      // A lifecycle transition of the box itself is still a sandbox recovery.
      expect((control as Record<string, unknown>).turnRecoveryCause).toBe("sandbox");
    } finally {
      requestRecovery.mockRestore();
      readLease.mockRestore();
    }
  });

  test("keeps the existing paced retry for a non-rotation capture transition", async () => {
    const transition = new opengeniDb.SandboxLeaseTransitionError(
      "group-1",
      5,
      "capture_in_progress",
      "modal",
      "sb-1",
      "draining",
    );
    const requestRecovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    });
    const readLease = spyOn(opengeniDb, "readLease").mockResolvedValue({
      rotationRequestedAt: null,
      rotationReason: null,
    } as never);

    try {
      const result = await settleTurnFailure({
        error: transition,
        input: {
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          attemptId: "attempt-1",
        },
        settings: { sandboxLeaseReaperPeriodMs: 10_000 },
        db: {},
        bus: {},
        observability: {},
        wakeSessionWorkflow: async () => undefined,
        signalCodexCapacityWorkflow: async () => undefined,
        cancellationSignal: undefined,
        sandboxRotationController: new AbortController(),
        noteCancellationRequested: () => undefined,
        codexWorkspaceKey: "workspace-key",
        control: {
          cancellationRequestedAt: null,
          activityStatus: "unknown",
          turnMetricOutcome: null,
          activityError: null,
          acknowledgeQuiescence: false,
        },
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
        historySink: { reconcileConversationTruth: async () => undefined },
        claimedResult: (value: Record<string, unknown>) => ({
          ...value,
          turnId: "turn-1",
          attemptId: "attempt-1",
        }),
        flushRuntimeBatcher: async () => undefined,
        acknowledgeLostAttemptOwnership: () => undefined,
        acknowledgeRecoveryQuiescence: () => undefined,
      } as never);

      expect(result).toEqual({
        status: "recovering",
        continueDelayMs: 5_000,
        turnId: "turn-1",
        attemptId: "attempt-1",
      });
      expect(requestRecovery.mock.calls[0]?.[2]).not.toHaveProperty("sandboxLifecycleWait");
    } finally {
      requestRecovery.mockRestore();
      readLease.mockRestore();
    }
  });

  test("parks a turn at its organization's running-box limit for a minute, with no retry budget", async () => {
    const transition = new opengeniDb.SandboxLeaseTransitionError(
      "group-1",
      0,
      "organization_sandbox_capacity",
      "modal",
      null,
      "cold",
      3,
    );
    expect(
      sandboxLifecycleTransitionDiagnostic(
        new Error("Failed to run function tools", {
          cause: new AggregateError([transition], "tool failures"),
        }),
      ),
    ).toEqual({
      sandboxGroupId: "group-1",
      leaseEpoch: 0,
      reason: "organization_sandbox_capacity",
      organizationBoxLimit: 3,
    });
    // The lazy provisioner never retries it in place: that would hold the
    // turn worker while waiting for another box to drain.
    expect(isLazySandboxProvisionRetryable(transition)).toBe(false);

    const requestRecovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    });
    const readLease = spyOn(opengeniDb, "readLease").mockResolvedValue({
      rotationRequestedAt: null,
      rotationReason: null,
    } as never);
    const control: Record<string, unknown> = {
      cancellationRequestedAt: null,
      activityStatus: "unknown",
      turnMetricOutcome: null,
      activityError: null,
      acknowledgeQuiescence: false,
    };
    try {
      const result = await settleTurnFailure({
        error: transition,
        input: {
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          attemptId: "attempt-1",
        },
        settings: { sandboxLeaseReaperPeriodMs: 10_000 },
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
        historySink: { reconcileConversationTruth: async () => undefined },
        claimedResult: (value: Record<string, unknown>) => ({
          ...value,
          turnId: "turn-1",
          attemptId: "attempt-1",
        }),
        flushRuntimeBatcher: async () => undefined,
        acknowledgeLostAttemptOwnership: () => undefined,
        acknowledgeRecoveryQuiescence: () => undefined,
      } as never);

      expect(result).toEqual({
        status: "recovering",
        continueDelayMs: ORGANIZATION_SANDBOX_CAPACITY_RETRY_MS,
        turnId: "turn-1",
        attemptId: "attempt-1",
      });
      // A designed wait for one of the organization's own boxes, not a
      // sandbox fault: it counts under its own recovery cause.
      expect(control).toMatchObject({
        turnMetricOutcome: "recovering",
        turnRecoveryCause: "organization_limit",
      });
      const recovery = requestRecovery.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(recovery).toMatchObject({
        reason: "sandbox_lifecycle_transition",
        detail: {
          sandboxGroupId: "group-1",
          leaseEpoch: 0,
          transitionReason: "organization_sandbox_capacity",
          organizationBoxLimit: 3,
        },
        retryAfterMs: ORGANIZATION_SANDBOX_CAPACITY_RETRY_MS,
      });
      expect(recovery).not.toHaveProperty("sandboxLifecycleWait");
    } finally {
      requestRecovery.mockRestore();
      readLease.mockRestore();
    }
  });

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

  test.each([
    ["home_unavailable_this_turn", "recovering"],
    ["native_capabilities_changed_this_attempt", "recovering"],
    ["native_capabilities_changed_this_attempt", "stale"],
  ] as const)(
    "checkpoints completed truth and respects exact attempt ownership: %s / %s",
    async (code, action) => {
      const transition = new ActiveBackendUnresolvableError(
        "home_unavailable_this_turn",
        "home is available to the next attempt",
      );
      const signal =
        code === "home_unavailable_this_turn"
          ? transition
          : Object.assign(new Error("native capabilities changed"), {
              name: "SandboxCapabilitiesChangedError",
              code,
            });
      const error = new AggregateError([signal], "Failed to run function tools");
      const requestRecovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
        action,
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
          status: action === "stale" ? "cancelled" : "recovering",
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
            code,
            effectiveBoundary: "next_attempt",
          },
        });
        expect(acknowledgeRecoveryQuiescence).toHaveBeenCalledTimes(action === "stale" ? 0 : 1);
        expect(acknowledgeLostAttemptOwnership).toHaveBeenCalledTimes(action === "stale" ? 1 : 0);
        expect(control.activityStatus).toBe(action === "stale" ? "cancelled" : "recovering");
        expect(control.turnMetricOutcome).toBe(action === "stale" ? "cancelled" : "recovering");
        if (action === "recovering") {
          expect(control.activityError).toBe(error);
          // A deliberate route move is the designed boundary, not a sandbox fault.
          expect(control.turnRecoveryCause).toBe("route_change");
        }
      } finally {
        requestRecovery.mockRestore();
      }
    },
  );
});
