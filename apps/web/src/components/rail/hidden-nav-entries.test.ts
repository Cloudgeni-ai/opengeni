import { describe, expect, test } from "bun:test";

import { hiddenNavEntries } from "./hidden-nav-entries";

describe("hiddenNavEntries", () => {
  test("nothing is hidden by default", () => {
    expect(hiddenNavEntries([])).toEqual({ inbox: false, targets: new Set() });
  });

  test("maps entries to the inbox and rail routes", () => {
    const hidden = hiddenNavEntries(["inbox", "knowledge", "meetings", "unknown"]);
    expect(hidden.inbox).toBe(true);
    expect([...hidden.targets].sort()).toEqual([
      "/workspaces/$workspaceId/meetings",
      "/workspaces/$workspaceId/state",
    ]);
  });

  test("Apps and Artifacts are separate pages, hidden separately", () => {
    expect([...hiddenNavEntries(["apps"]).targets]).toEqual(["/workspaces/$workspaceId/apps"]);
    expect([...hiddenNavEntries(["artifacts", "get_started"]).targets]).toEqual([
      "/workspaces/$workspaceId/artifacts",
      "/workspaces/$workspaceId/get-started",
    ]);
  });
});
