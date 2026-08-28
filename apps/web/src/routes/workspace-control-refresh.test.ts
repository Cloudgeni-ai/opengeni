import { describe, expect, test } from "bun:test";

import { workspaceControlEventInvalidatesWorkspace } from "./workspace";

describe("workspace control refresh", () => {
  test("refetches the workspace only for workspace-wide control changes", () => {
    expect(workspaceControlEventInvalidatesWorkspace({ scope: "workspace" })).toBe(true);
    expect(workspaceControlEventInvalidatesWorkspace({ scope: "session" })).toBe(false);
  });
});
