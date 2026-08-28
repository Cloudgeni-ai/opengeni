import { describe, expect, test } from "bun:test";

import {
  filterWorkspaceItemsByFeatures,
  PRIMARY_WORKSPACE_ITEMS,
  WORKSPACE_CONFIG_GROUPS,
  isWorkspaceConfigPath,
} from "./workspace-nav-data";

const workspaceNavSource = await Bun.file(`${import.meta.dir}/workspace-nav.tsx`).text();

describe("workspace rail destinations", () => {
  test("labels the settings entry without changing its destination", () => {
    expect(workspaceNavSource).toContain('aria-label="Settings"');
    expect(workspaceNavSource).toContain('title={rail.collapsed ? "Settings" : undefined}');
    expect(workspaceNavSource).toContain('<span className="min-w-0 truncate">Settings</span>');
    expect(workspaceNavSource).toContain('to="/workspaces/$workspaceId/settings"');
    expect(workspaceNavSource).toContain('search={{ section: "general" }}');
  });

  test("keeps primary product destinations out of workspace administration", () => {
    const primaryTargets = PRIMARY_WORKSPACE_ITEMS.map((item) => item.to);
    const settingsTargets = WORKSPACE_CONFIG_GROUPS.flatMap((group) => group.items).map(
      (item) => item.to,
    );

    expect(primaryTargets).toEqual([
      "/workspaces/$workspaceId/plugins",
      "/workspaces/$workspaceId/documents",
      "/workspaces/$workspaceId/state",
      "/workspaces/$workspaceId/schedules",
      "/workspaces/$workspaceId/artifacts",
      "/workspaces/$workspaceId/sites",
      "/workspaces/$workspaceId/applications",
    ]);
    expect(settingsTargets.filter((target) => primaryTargets.includes(target))).toEqual([]);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/schedules", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/artifacts", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/documents", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/state", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/settings", "ws-1")).toBe(true);
  });

  test("keeps both independent surfaces absent by default", () => {
    const labels = filterWorkspaceItemsByFeatures(PRIMARY_WORKSPACE_ITEMS).map(
      (item) => item.label,
    );
    expect(labels).not.toContain("Sites");
    expect(labels).not.toContain("Advanced deployments");
  });

  test("shows each surface only under its own feature gate", () => {
    const labels = (sites: boolean, advanced: boolean) =>
      filterWorkspaceItemsByFeatures(PRIMARY_WORKSPACE_ITEMS, sites, advanced).map(
        (item) => item.label,
      );
    expect(labels(true, false)).toContain("Sites");
    expect(labels(true, false)).not.toContain("Advanced deployments");
    expect(labels(false, true)).not.toContain("Sites");
    expect(labels(false, true)).toContain("Advanced deployments");
  });
});
