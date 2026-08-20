import { describe, expect, test } from "bun:test";

import { beginWorkspaceTransition, ownsWorkspaceTransition } from "./workspace-transition";

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
});
