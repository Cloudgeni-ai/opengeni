import { describe, expect, test } from "bun:test";

import {
  PRIMARY_WORKSPACE_ITEMS,
  WORKSPACE_CONFIG_GROUPS,
  isConfigItemActive,
  isWorkspaceConfigPath,
} from "./workspace-nav-data";

const workspaceNavSource = await Bun.file(`${import.meta.dir}/workspace-nav.tsx`).text();
const primaryNavSource = await Bun.file(`${import.meta.dir}/primary-nav.tsx`).text();

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
    ]);
    expect(settingsTargets.filter((target) => primaryTargets.includes(target))).toEqual([]);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/schedules", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/artifacts", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/documents", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/state", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/settings", "ws-1")).toBe(true);
    expect(
      isConfigItemActive(
        "/workspaces/ws-1/artifacts/site-1",
        "ws-1",
        "/workspaces/$workspaceId/artifacts",
      ),
    ).toBe(true);
  });

  test("nests recent individual Sites beneath the primary Sites destination", () => {
    expect(primaryNavSource).toContain("import { RecentSitesNav }");
    expect(primaryNavSource).toContain("<RecentSitesNav />");
    expect(primaryNavSource).toContain('item.to === "/workspaces/$workspaceId/artifacts"');
  });
});
