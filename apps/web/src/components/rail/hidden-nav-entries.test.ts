import { describe, expect, test } from "bun:test";

import { hiddenNavEntries, navEntryKey } from "./hidden-nav-entries";
import {
  groupedWorkspaceItems,
  navItemKey,
  primaryWorkspaceItems,
  WORKSPACE_BROWSE_ITEMS,
} from "./workspace-nav-data";

describe("navEntryKey", () => {
  test("every rail entry has a short, distinct key a saved order accepts", () => {
    const items = [true, false].flatMap((simplified) => [
      ...primaryWorkspaceItems(simplified),
      ...groupedWorkspaceItems(simplified).items,
    ]);
    const byTarget = new Map(
      [...items, ...WORKSPACE_BROWSE_ITEMS].map((item) => [
        navItemKey(item),
        navEntryKey(navItemKey(item)),
      ]),
    );
    for (const key of byTarget.values()) expect(key).toMatch(/^[a-z_]{1,40}$/);
    expect(new Set(byTarget.values()).size).toBe(byTarget.size);
    expect(navEntryKey("/workspaces/$workspaceId/insights")).toBe("insights");
  });
});

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

  test("Apps hides alone; hiding Artifacts hides Apps too, as before", () => {
    expect([...hiddenNavEntries(["apps"]).targets]).toEqual(["/workspaces/$workspaceId/apps"]);
    expect([...hiddenNavEntries(["artifacts", "get_started"]).targets]).toEqual([
      "/workspaces/$workspaceId/artifacts",
      "/workspaces/$workspaceId/get-started",
      "/workspaces/$workspaceId/apps",
    ]);
  });
});
