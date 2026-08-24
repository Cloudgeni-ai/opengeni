import { describe, expect, test } from "bun:test";

import {
  PRIMARY_WORKSPACE_ITEMS,
  WORKSPACE_CONFIG_GROUPS,
  isWorkspaceConfigPath,
} from "./workspace-nav-data";

describe("workspace rail destinations", () => {
  test("keeps primary product destinations out of workspace administration", () => {
    const primaryTargets = PRIMARY_WORKSPACE_ITEMS.map((item) => item.to);
    const settingsTargets = WORKSPACE_CONFIG_GROUPS.flatMap((group) => group.items).map(
      (item) => item.to,
    );

    expect(primaryTargets).toEqual([
      "/workspaces/$workspaceId/plugins",
      "/workspaces/$workspaceId/schedules",
      "/workspaces/$workspaceId/artifacts",
    ]);
    expect(settingsTargets.filter((target) => primaryTargets.includes(target))).toEqual([]);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/schedules", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/artifacts", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/settings", "ws-1")).toBe(true);
  });
});
