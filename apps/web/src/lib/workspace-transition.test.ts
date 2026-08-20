import { describe, expect, test } from "bun:test";

import {
  beginWorkspaceOperation,
  beginWorkspaceTransition,
  invalidatePrincipalTransition,
  invalidateWorkspaceTransition,
  ownsPrincipalTransition,
  ownsWorkspaceOperation,
  ownsWorkspaceTransition,
  runCurrentWorkspaceRequest,
  runCurrentWorkspaceOperation,
  runCurrentTransitionInvocation,
  settleWorkspaceOperation,
  type WorkspaceOperationIdentity,
} from "./workspace-transition";

describe("workspace transition identity", () => {
  test("principal generations invalidate old access work without depending on route cleanup", () => {
    const accepted = { revision: 7 };
    const current = invalidatePrincipalTransition(accepted);

    expect(current).toEqual({ revision: 8 });
    expect(ownsPrincipalTransition(current, accepted)).toBe(false);
    expect(ownsPrincipalTransition(current, current)).toBe(true);
  });

  for (const lateOutcome of ["resolve", "reject"] as const) {
    test(`suppresses a delayed principal-scoped ${lateOutcome} after credential replacement`, async () => {
      let current = { revision: 3 };
      const accepted = current;
      let resolveRequest!: (value: string) => void;
      let rejectRequest!: (error: Error) => void;
      const request = new Promise<string>((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
      });
      const result = runCurrentTransitionInvocation({
        isCurrent: () => ownsPrincipalTransition(current, accepted),
        request: () => request,
      });

      current = invalidatePrincipalTransition(current);
      if (lateOutcome === "resolve") {
        resolveRequest("old access context");
      } else {
        rejectRequest(new Error("old access request failed"));
      }

      expect(await result).toEqual({ status: "stale" });
    });
  }

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
});
