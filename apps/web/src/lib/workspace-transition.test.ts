import { describe, expect, test } from "bun:test";

import {
  beginWorkspaceOperation,
  beginWorkspaceOperationUnlessBlocked,
  beginWorkspaceTransition,
  invalidateWorkspaceTransition,
  ownsWorkspaceOperation,
  ownsWorkspaceTransition,
  runCurrentWorkspaceRequest,
  runCurrentWorkspaceOperation,
  settleWorkspaceOperation,
  type WorkspaceOperationIdentity,
} from "./workspace-transition";

describe("workspace transition identity", () => {
  test("invalidates an accepted operation when the route changes tenant", () => {
    const initial = beginWorkspaceTransition({ workspaceId: null, revision: 0 }, "workspace-a");
    const accepted = initial.identity;
    const switched = beginWorkspaceTransition(accepted, "workspace-b");

    expect(initial.changed).toBe(true);
    expect(switched.changed).toBe(true);
    expect(ownsWorkspaceTransition(switched.identity, accepted, "workspace-a")).toBe(false);
  });

  test("keeps same-workspace rerenders on the same transition identity", () => {
    const current = { workspaceId: "workspace-a", revision: 4 };
    const repeated = beginWorkspaceTransition(current, "workspace-a");

    expect(repeated).toEqual({ identity: current, changed: false });
    expect(ownsWorkspaceTransition(repeated.identity, current, "workspace-a")).toBe(true);
  });

  test("credential invalidation advances identity even when the route id will stay the same", () => {
    const accepted = { workspaceId: "workspace-a", revision: 4 };
    const invalidated = invalidateWorkspaceTransition(accepted);
    const rebound = beginWorkspaceTransition(invalidated, "workspace-a");

    expect(invalidated).toEqual({ workspaceId: null, revision: 5 });
    expect(rebound.identity).toEqual({ workspaceId: "workspace-a", revision: 6 });
    expect(ownsWorkspaceTransition(rebound.identity, accepted, "workspace-a")).toBe(false);
  });

  test("a superseded create cannot toast or settle a newer create's busy state", () => {
    const transitionA = { workspaceId: "workspace-a", revision: 1 };
    const first = beginWorkspaceOperation(0, transitionA);
    const transitionB = { workspaceId: "workspace-b", revision: 2 };
    const second = beginWorkspaceOperation(first.sequence, transitionB);
    let active: WorkspaceOperationIdentity | null = second.operation;
    let busy = true;
    let failureToasts = 0;

    // Workspace A rejects after B has begun. The catch and finally branches
    // both consult these helpers before mutating destination UI.
    if (ownsWorkspaceOperation(active, transitionB, first.operation, "workspace-a")) {
      failureToasts += 1;
    }
    const staleSettlement = settleWorkspaceOperation(active, first.operation);
    active = staleSettlement.active;
    if (staleSettlement.settledCurrent) busy = false;

    expect(failureToasts).toBe(0);
    expect(active).toEqual(second.operation);
    expect(busy).toBe(true);

    const currentSettlement = settleWorkspaceOperation(active, second.operation);
    active = currentSettlement.active;
    if (currentSettlement.settledCurrent) busy = false;
    expect(active).toBeNull();
    expect(busy).toBe(false);
  });

  test("suppresses both late resolve and late reject after abort or generation change", async () => {
    const aborted = new AbortController();
    let rejectOld!: (error: Error) => void;
    const oldRejection = new Promise<string>((_resolve, reject) => {
      rejectOld = reject;
    });
    const staleReject = runCurrentWorkspaceRequest({
      signal: aborted.signal,
      requestId: 1,
      currentRequestId: () => 2,
      request: () => oldRejection,
    });
    aborted.abort();
    rejectOld(new Error("workspace A failed"));
    expect(await staleReject).toBeNull();

    expect(
      await runCurrentWorkspaceRequest({
        requestId: 3,
        currentRequestId: () => 4,
        request: async () => "workspace A catalog",
      }),
    ).toBeNull();
  });

  for (const lateOutcome of ["resolve", "reject"] as const) {
    test(`prevents a delayed GitHub mutation ${lateOutcome} from refreshing or redirecting after a switch`, async () => {
      const transitionA = { workspaceId: "workspace-a", revision: 1 };
      const started = beginWorkspaceOperation(0, transitionA);
      let currentTransition = transitionA;
      let active: WorkspaceOperationIdentity | null = started.operation;
      let resolveRequest!: (value: string) => void;
      let rejectRequest!: (error: Error) => void;
      const request = new Promise<string>((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
      });
      const result = runCurrentWorkspaceOperation({
        activeOperation: () => active,
        currentTransition: () => currentTransition,
        operation: started.operation,
        workspaceId: "workspace-a",
        request: () => request,
      });

      currentTransition = { workspaceId: "workspace-b", revision: 2 };
      active = null;
      if (lateOutcome === "resolve") {
        resolveRequest("workspace-a result");
      } else {
        rejectRequest(new Error("workspace-a failed"));
      }

      let destinationEffects = 0;
      const settled = await result;
      if (settled.status === "current") {
        destinationEffects += 1;
      }
      expect(settled).toEqual({ status: "stale" });
      expect(destinationEffects).toBe(0);
    });
  }

  for (const mutation of ["request", "cancel"] as const) {
    test(`a polling timer cannot supersede an in-flight Slack ${mutation} mutation`, async () => {
      const transition = { workspaceId: "workspace-a", revision: 1 };
      const startedMutation = beginWorkspaceOperation(0, transition);
      let active: WorkspaceOperationIdentity | null = startedMutation.operation;
      let sequence = startedMutation.sequence;
      let mutationBusy = true;
      let requestProjectionEligible = false;
      let continuationEligible = false;
      let navigationEligible = false;
      let resolveMutation!: () => void;
      const delayedMutation = new Promise<void>((resolve) => {
        resolveMutation = resolve;
      }).then(() => {
        if (ownsWorkspaceOperation(active, transition, startedMutation.operation, "workspace-a")) {
          if (mutation === "request") {
            requestProjectionEligible = true;
          } else {
            continuationEligible = true;
            navigationEligible = true;
          }
        }
      });

      // A timer callback already queued before React tears down the interval
      // still consults the synchronous mutation-busy fence.
      const timerTick = beginWorkspaceOperationUnlessBlocked(sequence, transition, mutationBusy);
      if (timerTick) {
        sequence = timerTick.sequence;
        active = timerTick.operation;
      }
      expect(timerTick).toBeNull();
      expect(active).toEqual(startedMutation.operation);

      resolveMutation();
      await delayedMutation;
      const settlement = settleWorkspaceOperation(active, startedMutation.operation);
      active = settlement.active;
      if (settlement.settledCurrent) mutationBusy = false;

      expect(requestProjectionEligible).toBe(mutation === "request");
      expect(continuationEligible).toBe(mutation === "cancel");
      expect(navigationEligible).toBe(mutation === "cancel");
      expect(mutationBusy).toBe(false);
      expect(active).toBeNull();
      expect(sequence).toBe(startedMutation.sequence);
    });
  }
});
