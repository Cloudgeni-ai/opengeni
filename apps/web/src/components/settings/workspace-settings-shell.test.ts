import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceManagementLocation } from "./workspace-settings-shell";

const fallbackWorkspaceId = "33333333-3333-4333-8333-333333333333";
const navigate = mock((_options: unknown) => undefined);
const resetSessionView = mock(() => undefined);
let workspacePermissions: string[] = [];

mock.module("@/context", () => ({
  useAppContext: () => ({
    resetSessionView,
    workspaces: [{ id: fallbackWorkspaceId }],
    accessContext: {
      workspaceGrants: [
        { workspaceId: "11111111-1111-4111-8111-111111111111", permissions: workspacePermissions },
      ],
    },
  }),
}));

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search: _search,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    params?: { workspaceId?: string };
    search?: unknown;
  }) =>
    createElement(
      "a",
      { ...props, href: to.replace("$workspaceId", params?.workspaceId ?? "") },
      children,
    ),
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { search: {} } }),
}));

mock.module("@/components/rail/workspace-switcher", () => ({
  WorkspaceSwitcherMenu: () => createElement("button", { type: "button" }, "Switch workspace"),
}));

mock.module("@/components/rail/workspace-paused-banner", () => ({
  WorkspacePausedBanner: () => null,
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const {
  WorkspaceManagementShell,
  workspaceManagementLocation,
  workspaceSettingsSectionFromSearch,
} = await import("./workspace-settings-shell");

const workspaceId = "11111111-1111-4111-8111-111111111111";
const base = `/workspaces/${workspaceId}`;
const shellSource = await Bun.file(`${import.meta.dir}/workspace-settings-shell.tsx`).text();

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  navigate.mockClear();
  resetSessionView.mockClear();
  workspacePermissions = [];
});

async function renderShell(
  location: WorkspaceManagementLocation,
  overrides: Partial<ComponentProps<typeof WorkspaceManagementShell>> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        // Match the application-owned main landmark around the settings shell.
        "main",
        null,
        createElement(
          WorkspaceManagementShell,
          {
            workspaceId,
            organizationName: "CloudGeni",
            location,
            ...overrides,
          } as ComponentProps<typeof WorkspaceManagementShell>,
          createElement("p", null, "Settings content"),
        ),
      ),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("workspace settings rail", () => {
  test("lists settings plus the Agents and Insights dashboards; no Memory, Capabilities or Danger zone", async () => {
    workspacePermissions = ["workspace:admin"];
    const view = await renderShell({ kind: "settings", section: null });
    try {
      const text = view.container.textContent ?? "";
      for (const label of [
        "General",
        "Access",
        "Models",
        "API keys",
        "Variable sets",
        "Sandbox environments",
        "Machines",
        "CloudGeni",
        "Workspace activity",
        "Agents",
        "Insights",
      ]) {
        expect(text).toContain(label);
      }
      for (const label of ["Members", "Memory", "Danger zone", "Capabilities"]) {
        expect(text).not.toContain(label);
      }
    } finally {
      await view.unmount();
    }
  });

  test("hides Insights from people who are not workspace admins", async () => {
    workspacePermissions = ["sessions:create"];
    const view = await renderShell({ kind: "settings", section: null });
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("Agents");
      expect(text).not.toContain("Insights");
    } finally {
      await view.unmount();
    }
  });

  test("settings, the Agents and Insights dashboards and runtime pages open in settings mode", () => {
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId, "api-keys")).toEqual({
      kind: "settings",
      section: "api-keys",
    });
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId)).toEqual({
      kind: "settings",
      section: null,
    });
    for (const route of ["agents", "insights", "variable-sets", "rigs", "machines"]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).not.toBeNull();
    }
    expect(workspaceManagementLocation(`${base}/rigs/rig-123`, workspaceId)).toEqual({
      kind: "page",
      target: "/workspaces/$workspaceId/rigs",
    });
    for (const route of [
      "memory",
      "sessions",
      "plugins",
      "documents",
      "state",
      "schedules",
      "artifacts",
      "priority",
      "rigs-archive",
    ]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).toBeNull();
    }
  });

  test("maps older sections to the page that holds them now", () => {
    expect(workspaceSettingsSectionFromSearch(undefined)).toBeNull();
    expect(workspaceSettingsSectionFromSearch("permissions")).toBeNull();
    expect(workspaceSettingsSectionFromSearch("models")).toBe("models");
    expect(workspaceSettingsSectionFromSearch("members")).toBe("access");
    expect(workspaceSettingsSectionFromSearch("danger")).toBe("general");
  });

  test("links to organization settings at the bottom of the settings rail", () => {
    expect(shellSource).toContain('to="/workspaces/$workspaceId/organization"');
    expect(shellSource).toContain("Organization settings for ${organizationName}");
    expect(shellSource).toContain('label="Workspace settings"');
  });

  test("an organization admin without workspace access sees General and Access only", async () => {
    const rendered = await renderShell(
      { kind: "settings", section: null },
      {
        organizationManagementOnly: true,
        organizationSettingsWorkspaceId: fallbackWorkspaceId,
        workspaceName: "Managed without content access",
      },
    );
    try {
      const text = rendered.container.textContent ?? "";
      expect(text).toContain("Managed without content access");
      expect(text).toContain("General");
      expect(text).toContain("Access");
      expect(text).not.toContain("API keys");
      expect(text).not.toContain("Variable sets");
    } finally {
      await rendered.unmount();
    }
  });

  test("Agents keeps the settings rail, with Agents current and a way back to sessions", async () => {
    workspacePermissions = ["workspace:admin"];
    const view = await renderShell({ kind: "page", target: "/workspaces/$workspaceId/agents" });
    try {
      const rail = view.container.querySelector('nav[aria-label="Workspace settings"]')!;
      expect(rail).not.toBeNull();
      expect(rail.querySelector('a[aria-current="page"]')?.textContent).toBe("Agents");
      const back = Array.from(rail.querySelectorAll("a")).find(
        (link) => link.textContent === "Back to sessions",
      );
      expect(back?.getAttribute("href")).toBe(`${base}/sessions`);
      // The dashboard brings its own page; the shell adds no settings header.
      const content = view.container.querySelector('section[aria-label="Agents"]');
      expect(content).not.toBeNull();
      expect(content?.querySelector("h1")).toBeNull();
      expect(content?.textContent).toContain("Settings content");
      expect(content?.contains(rail)).toBe(false);
      expect(content?.closest("main")).not.toBeNull();
      expect(view.container.querySelectorAll('main, [role="main"]').length).toBe(1);
    } finally {
      await view.unmount();
    }
  });
});
