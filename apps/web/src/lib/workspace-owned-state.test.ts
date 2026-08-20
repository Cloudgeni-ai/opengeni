import { describe, expect, test } from "bun:test";

import {
  updateWorkspaceOwnedState,
  workspaceOwnedValue,
  type WorkspaceOwnedState,
} from "./workspace-owned-state";

const workspaceRouteSource = await Bun.file(`${import.meta.dir}/../routes/workspace.tsx`).text();

type SlackState = { requestName: string | null; error: string | null; busy: boolean };

const emptySlackState = (): SlackState => ({ requestName: null, error: null, busy: false });

describe("workspace-owned local state", () => {
  test("never projects workspace A Slack UI under an authorized or unavailable B route", () => {
    const pendingA: WorkspaceOwnedState<SlackState> = {
      workspaceId: "workspace-a",
      value: { requestName: "Workspace A", error: null, busy: true },
    };

    expect(workspaceOwnedValue(pendingA, "workspace-b", emptySlackState())).toEqual(
      emptySlackState(),
    );
  });

  test("a stale A polling completion cannot mutate B state", () => {
    const readyB: WorkspaceOwnedState<SlackState> = {
      workspaceId: "workspace-b",
      value: emptySlackState(),
    };
    const afterStaleResponse = updateWorkspaceOwnedState(readyB, "workspace-a", () => ({
      requestName: "Workspace A",
      error: null,
      busy: false,
    }));
    const afterStaleError = updateWorkspaceOwnedState(
      afterStaleResponse,
      "workspace-a",
      (value) => ({
        ...value,
        error: "stale A polling failed",
      }),
    );

    expect(afterStaleResponse).toBe(readyB);
    expect(afterStaleError).toBe(readyB);
    expect(workspaceOwnedValue(afterStaleError, "workspace-b", emptySlackState())).toEqual(
      emptySlackState(),
    );
  });

  for (const lateOutcome of ["response", "error"] as const) {
    test(`ignores a delayed workspace A Slack polling ${lateOutcome} after B owns state`, async () => {
      let state: WorkspaceOwnedState<SlackState> = {
        workspaceId: "workspace-a",
        value: { requestName: "Workspace A", error: null, busy: true },
      };
      let resolvePoll!: (value: string) => void;
      let rejectPoll!: (error: Error) => void;
      const polling = new Promise<string>((resolve, reject) => {
        resolvePoll = resolve;
        rejectPoll = reject;
      }).then(
        (requestName) => {
          state = updateWorkspaceOwnedState(state, "workspace-a", (value) => ({
            ...value,
            requestName,
          }));
        },
        (error: Error) => {
          state = updateWorkspaceOwnedState(state, "workspace-a", (value) => ({
            ...value,
            error: error.message,
          }));
        },
      );

      state = { workspaceId: "workspace-b", value: emptySlackState() };
      if (lateOutcome === "response") {
        resolvePoll("Workspace A late response");
      } else {
        rejectPoll(new Error("Workspace A late failure"));
      }
      await polling;

      expect(state).toEqual({ workspaceId: "workspace-b", value: emptySlackState() });
    });
  }

  test("the Slack route binds render state and async effects to these guards", () => {
    expect(workspaceRouteSource).toContain(
      "workspaceOwnedValue(ownedSlackAccess, workspaceId, emptySlackAccessState())",
    );
    expect(workspaceRouteSource).toContain("updateWorkspaceOwnedState(current, ownedWorkspaceId");
    expect(workspaceRouteSource).toContain("captureWorkspaceInvocation(workspaceId)");
    expect(workspaceRouteSource).toContain("ownsWorkspaceInvocation(workspaceId");
  });
});
