import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  retainSessionRestartAttemptAfterFailure,
  SessionRestartOperationController,
  type SessionRestartOperationScope,
} from "./session-restart-operation-controller";

const scope = {
  principalId: "principal-a:1",
  workspaceId: "workspace-a",
  sessionId: "session-a",
} satisfies SessionRestartOperationScope;

describe("SessionRestartOperationController", () => {
  test("retries an outcome-unknown fork with the same key and exact ordered setup", () => {
    const controller = new SessionRestartOperationController();
    let generated = 0;
    const first = controller.prepare(
      scope,
      {
        visibility: "workspace",
        rigId: "rig-a",
        variableSetIds: ["set-low", "set-high"],
      },
      () => `restart-${++generated}`,
    );
    const unknown = new OpenGeniApiError(503, "gateway unavailable", {
      outcomeUnknown: true,
    });

    expect(retainSessionRestartAttemptAfterFailure(unknown, false)).toBe(true);
    const retry = controller.prepare(
      { ...scope },
      {
        visibility: "workspace",
        rigId: "rig-edited-after-timeout",
        variableSetIds: ["set-high", "set-low"],
      },
      () => `restart-${++generated}`,
    );

    expect(retry).toBe(first);
    expect(retry).toMatchObject({
      idempotencyKey: "restart-1",
      rigId: "rig-a",
      variableSetIds: ["set-low", "set-high"],
    });
    expect(generated).toBe(1);

    controller.settle(scope, retry);
    expect(controller.snapshot(scope)).toBeNull();
  });

  test("retires an attempt when principal, workspace, or session scope changes", () => {
    const controller = new SessionRestartOperationController();
    controller.prepare(
      scope,
      { visibility: "private", rigId: null, variableSetIds: [] },
      () => "old-key",
    );

    expect(controller.snapshot({ ...scope, sessionId: "session-b" })).toBeNull();
    expect(
      controller.prepare(
        { ...scope, sessionId: "session-b" },
        { visibility: "private", rigId: null, variableSetIds: [] },
        () => "new-key",
      ).idempotencyKey,
    ).toBe("new-key");
  });

  test("clears definitive failures but retains retryable destination reconciliation", () => {
    expect(retainSessionRestartAttemptAfterFailure(new Error("denied"), false)).toBe(false);
    expect(retainSessionRestartAttemptAfterFailure(new TypeError("network"), true)).toBe(true);
  });
});
