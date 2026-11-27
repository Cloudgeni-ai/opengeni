import { describe, expect, test } from "bun:test";

import {
  PRIMARY_WORKSPACE_ITEMS,
  WORKSPACE_CONFIG_GROUPS,
  interfaceListsDestination,
  interfaceListsOrganizationSection,
  interfaceListsSettingsSection,
  isConfigItemActive,
  isWorkspaceConfigPath,
  itemDescription,
  groupedWorkspaceItems,
  isNavItemActive,
  navItemKey,
  primaryWorkspaceItems,
} from "./workspace-nav-data";

const workspaceNavSource = await Bun.file(`${import.meta.dir}/workspace-nav.tsx`).text();
const workspaceRouteSource = await Bun.file(`${import.meta.dir}/../../routes/workspace.tsx`).text();

describe("workspace rail destinations", () => {
  test("labels the settings entry without changing its destination", () => {
    expect(workspaceNavSource).toContain('aria-label="Settings"');
    expect(workspaceNavSource).toContain(
      '<TooltipContent side={rail.collapsed ? "right" : "top"}>Settings</TooltipContent>',
    );
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
      "/workspaces/$workspaceId/state",
      "/workspaces/$workspaceId/automations",
      "/workspaces/$workspaceId/agents",
      "/workspaces/$workspaceId/meetings",
      "/workspaces/$workspaceId/artifacts",
    ]);
    expect(PRIMARY_WORKSPACE_ITEMS.map((item) => item.label)).not.toContain("Documents");
    expect(settingsTargets.filter((target) => primaryTargets.includes(target))).toEqual([]);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/automations", "ws-1")).toBe(false);
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

  test("settings mode swaps the main rail for the settings rail", () => {
    // The footer Settings entry is the way in; the management shell replaces RailShell.
    // Workspace and organization settings share that one management shell.
    const shell = workspaceRouteSource.slice(
      workspaceRouteSource.indexOf("{managementLocation ? ("),
    );
    const management = shell.indexOf("<WorkspaceManagementShell");
    expect(management).toBeGreaterThan(0);
    expect(management).toBeLessThan(shell.indexOf("<RailShell>"));
    expect(shell.slice(management, shell.indexOf("</WorkspaceManagementShell>"))).not.toContain(
      "<RailShell>",
    );
  });
});

describe("simplified interface navigation", () => {
  test("without it every destination is listed: Agents and Apps up front, the rest under Setup", () => {
    expect(primaryWorkspaceItems(false).map((item) => item.label)).toEqual(["Agents", "Apps"]);
    const setup = groupedWorkspaceItems(false);
    expect(setup.label).toBe("Setup");
    expect(setup.items.map((item) => item.label)).toEqual([
      "Get started",
      "Capabilities",
      "Automations",
      "Knowledge",
      "Artifacts",
      "Meetings",
    ]);
    // Nothing is left out: every destination is up front or under Setup.
    const listed = new Set([...primaryWorkspaceItems(false), ...setup.items].map(navItemKey));
    for (const item of PRIMARY_WORKSPACE_ITEMS) expect(listed.has(navItemKey(item))).toBe(true);
    for (const item of WORKSPACE_CONFIG_GROUPS.flatMap((group) => group.items)) {
      expect(interfaceListsDestination(false, item.to)).toBe(true);
    }
    expect(interfaceListsSettingsSection(false, "developer")).toBe(true);
    expect(interfaceListsSettingsSection(false, "api-keys")).toBe(true);
    expect(interfaceListsOrganizationSection(false, "developer")).toBe(true);
    expect(interfaceListsOrganizationSection(false, "insights")).toBe(true);
  });

  test("Apps is its own page and an app's view; Artifacts is the rest", () => {
    const apps = primaryWorkspaceItems(false).find((item) => item.label === "Apps")!;
    const artifacts = PRIMARY_WORKSPACE_ITEMS.find((item) => item.label === "Artifacts")!;
    const at = (pathname: string, kind?: string) => ({ pathname, kind });
    expect(isNavItemActive(at("/workspaces/w/apps"), "w", apps)).toBe(true);
    expect(isNavItemActive(at("/workspaces/w/apps"), "w", artifacts)).toBe(false);
    // An app opened from the sidebar has its own rail link.
    expect(isNavItemActive(at("/workspaces/w/apps/a1/"), "w", apps)).toBe(false);
    expect(isNavItemActive(at("/workspaces/w/artifacts", "site"), "w", apps)).toBe(true);
    expect(isNavItemActive(at("/workspaces/w/artifacts", "site"), "w", artifacts)).toBe(false);
    expect(isNavItemActive(at("/workspaces/w/sites/s1"), "w", apps)).toBe(true);
    expect(isNavItemActive(at("/workspaces/w/artifacts"), "w", apps)).toBe(false);
    expect(isNavItemActive(at("/workspaces/w/artifacts"), "w", artifacts)).toBe(true);
    expect(isNavItemActive(at("/workspaces/w/artifacts/a1"), "w", artifacts)).toBe(true);
    expect(navItemKey(apps)).not.toBe(navItemKey(artifacts));
  });

  test("a destination's tooltip names the product the way the interface does", () => {
    const artifacts = PRIMARY_WORKSPACE_ITEMS.find((item) => item.label === "Artifacts")!;
    expect(itemDescription(artifacts, "Opengeni")).toBe(
      "Images, documents, and files built with Opengeni",
    );
    expect(itemDescription(artifacts, "Geni")).toBe("Images, documents, and files built with Geni");
    for (const item of WORKSPACE_CONFIG_GROUPS.flatMap((group) => group.items)) {
      expect(itemDescription(item, "Geni")).not.toContain("Opengeni");
    }
    for (const item of PRIMARY_WORKSPACE_ITEMS) {
      expect(itemDescription(item, "Geni")).not.toContain("Opengeni");
    }
  });

  test("the simplified interface lists a shorter rail and no platform pages", () => {
    expect(primaryWorkspaceItems(true).map((item) => item.label)).toEqual([
      "Capabilities",
      "Agents",
      "Apps",
      "Artifacts",
    ]);
    expect(groupedWorkspaceItems(true).items.map((item) => item.label)).toEqual([
      "Knowledge",
      "Automations",
    ]);
    const listed = WORKSPACE_CONFIG_GROUPS.flatMap((group) => group.items)
      .filter((item) => interfaceListsDestination(true, item.to))
      .map((item) => item.label);
    expect(listed).toEqual(["Workspace settings"]);
  });

  test("its settings list the workspace, its people, billing and nothing about models", () => {
    const workspaceSections = [
      "general",
      "access",
      "available",
      "learning",
      "usage",
      "api-keys",
      "developer",
      "mine",
    ];
    expect(
      workspaceSections.filter((section) => interfaceListsSettingsSection(true, section)),
    ).toEqual(["general", "access"]);
    const organizationSections = [
      "general",
      "people",
      "workspaces",
      "identity",
      "shared",
      "models",
      "integrations",
      "agents",
      "insights",
      "billing",
      "developer",
      "security",
    ];
    expect(
      organizationSections.filter((section) => interfaceListsOrganizationSection(true, section)),
    ).toEqual(["general", "people", "billing"]);
  });

  test("an unlisted page keeps its route", () => {
    // The flag never removes a page: it is only left out of the lists.
    expect(isWorkspaceConfigPath("/workspaces/ws-1/machines", "ws-1")).toBe(true);
    expect(
      isConfigItemActive("/workspaces/ws-1/meetings", "ws-1", "/workspaces/$workspaceId/meetings"),
    ).toBe(true);
  });
});
