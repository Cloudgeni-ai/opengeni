import { describe, expect, test } from "bun:test";

import {
  SessionTenancyOperationController,
  type SessionTenancyOperationScope,
} from "./session-tenancy-operation-controller";

const scope = {
  principalId: "principal-a",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  workspaceTransitionRevision: 1,
} satisfies SessionTenancyOperationScope;

describe("SessionTenancyOperationController", () => {
  test("retains both attempts for the exact app-lifetime target", () => {
    const controller = new SessionTenancyOperationController();
    let generated = 0;
    const key = () => `operation-${++generated}`;
    const visibility = controller.prepareVisibility(
      scope,
      { visibility: "private", expectedAuthorityEpoch: 4 },
      key,
    );
    const fork = controller.prepareFork(scope, key);

    expect(
      controller.prepareVisibility(
        { ...scope },
        { visibility: "private", expectedAuthorityEpoch: 4 },
        key,
      ),
    ).toBe(visibility);
    expect(
      controller.prepareVisibility(
        { ...scope },
        { visibility: "workspace", expectedAuthorityEpoch: 9 },
        key,
      ),
    ).toBe(visibility);
    expect(controller.prepareFork({ ...scope }, key)).toBe(fork);
    expect(generated).toBe(2);
  });

  for (const [name, changed] of [
    ["principal", { principalId: "principal-b" }],
    ["workspace", { workspaceId: "workspace-b", workspaceTransitionRevision: 2 }],
    ["session", { sessionId: "session-b" }],
    ["workspace transition", { workspaceTransitionRevision: 2 }],
  ] as const) {
    test(`never carries old keys across a ${name} change`, () => {
      const controller = new SessionTenancyOperationController();
      const original = controller.prepareVisibility(
        scope,
        { visibility: "private", expectedAuthorityEpoch: 4 },
        () => "old-key",
      );
      const nextScope = { ...scope, ...changed };
      expect(controller.snapshot(nextScope)).toEqual({ visibility: null, fork: null });
      const next = controller.prepareVisibility(
        nextScope,
        { visibility: "private", expectedAuthorityEpoch: 4 },
        () => "new-key",
      );
      expect(next.idempotencyKey).toBe("new-key");
      controller.settleVisibility(scope, original);
      expect(controller.snapshot(nextScope).visibility).toBe(next);
    });
  }

  test("clears only the matching settled attempt", () => {
    const controller = new SessionTenancyOperationController();
    const visibility = controller.prepareVisibility(
      scope,
      { visibility: "private", expectedAuthorityEpoch: 4 },
      () => "visibility-key",
    );
    const fork = controller.prepareFork(scope, () => "fork-key");

    controller.settleVisibility(scope, { ...visibility, idempotencyKey: "other-key" });
    expect(controller.snapshot(scope).visibility).toBe(visibility);
    controller.settleVisibility(scope, visibility);
    expect(controller.snapshot(scope)).toEqual({ visibility: null, fork });
  });
});
