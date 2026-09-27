import { describe, expect, test } from "bun:test";

import {
  PRIMARY_WORKSPACE_ITEMS,
  isConfigItemActive,
  isWorkspaceSettingsPath,
  primaryWorkspaceItemsFor,
} from "./workspace-nav-data";

describe("main rail destinations", () => {
  test("lists every destination once, with Settings last and no settings pages", () => {
    expect(PRIMARY_WORKSPACE_ITEMS.map((item) => item.to)).toEqual([
      "/workspaces/$workspaceId/agents",
      "/workspaces/$workspaceId/schedules",
      "/workspaces/$workspaceId/artifacts",
      "/workspaces/$workspaceId/state",
      "/workspaces/$workspaceId/plugins",
      "/workspaces/$workspaceId/insights",
      "/workspaces/$workspaceId/settings",
    ]);
    const labels = PRIMARY_WORKSPACE_ITEMS.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(PRIMARY_WORKSPACE_ITEMS.map((item) => item.icon)).size).toBe(labels.length);
    expect(labels).not.toContain("Memory");
    expect(labels).not.toContain("Documents");
  });

  test("shows Insights to workspace admins only", () => {
    expect(primaryWorkspaceItemsFor(false).map((item) => item.label)).not.toContain("Insights");
    expect(primaryWorkspaceItemsFor(true).map((item) => item.label)).toContain("Insights");
  });

  test("marks Settings current on every page inside the settings frame", () => {
    const settings = "/workspaces/$workspaceId/settings" as const;
    for (const path of ["settings", "variable-sets", "rigs", "rigs/rig-1", "machines"]) {
      expect(isWorkspaceSettingsPath(`/workspaces/ws-1/${path}`, "ws-1")).toBe(true);
      expect(isConfigItemActive(`/workspaces/ws-1/${path}`, "ws-1", settings)).toBe(true);
    }
    for (const path of ["schedules", "artifacts", "state", "agents", "insights", "rigs-archive"]) {
      expect(isWorkspaceSettingsPath(`/workspaces/ws-1/${path}`, "ws-1")).toBe(false);
    }
    expect(
      isConfigItemActive(
        "/workspaces/ws-1/artifacts/site-1",
        "ws-1",
        "/workspaces/$workspaceId/artifacts",
      ),
    ).toBe(true);
  });
});
