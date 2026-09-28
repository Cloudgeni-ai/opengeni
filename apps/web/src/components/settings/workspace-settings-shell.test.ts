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
  Link: ({ children, ...props }: { children?: ReactNode; className?: string }) =>
    createElement("a", { className: props.className }, children),
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { search: {} } }),
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
        WorkspaceManagementShell,
        {
          workspaceId,
          organizationName: "CloudGeni",
          location,
          ...overrides,
        } as ComponentProps<typeof WorkspaceManagementShell>,
        createElement("p", null, "Settings content"),
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

describe("workspace settings frame", () => {
  test("lists settings plus the Agents and Insights dashboards; no Memory, Capabilities or Danger zone", async () => {
    workspacePermissions = ["workspace:admin"];
    // The settings list itself (narrow frames show it as a page).
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

  test("keeps settings and runtime pages in the frame, and dashboards out of it", () => {
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId, "api-keys")).toEqual({
      kind: "settings",
      section: "api-keys",
    });
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId)).toEqual({
      kind: "settings",
      section: null,
    });
    for (const route of ["variable-sets", "rigs", "machines"]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).not.toBeNull();
    }
    expect(workspaceManagementLocation(`${base}/rigs/rig-123`, workspaceId)).toEqual({
      kind: "page",
      target: "/workspaces/$workspaceId/rigs",
    });
    for (const route of [
      "agents",
      "insights",
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

  test("links to organization settings under the sub-nav", () => {
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
});
