import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceManagementLocation } from "./workspace-settings-shell";

const nextWorkspaceId = "22222222-2222-4222-8222-222222222222";
const navigate = mock((_options: unknown) => undefined);
const resetSessionView = mock(() => undefined);

mock.module("@/context", () => ({
  useAppContext: () => ({ resetSessionView }),
}));

mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
  useNavigate: () => navigate,
}));

const workspaceSwitcherModule = await import("@/components/rail/workspace-switcher");

mock.module("@/components/rail/workspace-switcher", () => ({
  ...workspaceSwitcherModule,
  WorkspaceSwitcherMenu: ({
    workspaceId,
    onSelect,
  }: {
    workspaceId: string;
    onSelect: (workspaceId: string) => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": `Workspace selector for ${workspaceId}`,
        onClick: () => onSelect(nextWorkspaceId),
      },
      "Switch workspace",
    ),
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
});

async function renderShell(location: WorkspaceManagementLocation) {
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

describe("workspace management navigation", () => {
  test("keeps settings and management destinations in one shell", () => {
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId, "api-keys")).toEqual({
      kind: "settings",
      section: "api-keys",
    });

    for (const route of ["agents", "insights", "memory", "variable-sets", "rigs", "machines"]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).not.toBeNull();
    }

    expect(workspaceManagementLocation(`${base}/rigs/rig-123`, workspaceId)).toEqual({
      kind: "page",
      target: "/workspaces/$workspaceId/rigs",
    });
  });

  test("does not absorb ordinary workspace routes into management", () => {
    for (const route of [
      "sessions",
      "plugins",
      "documents",
      "state",
      "schedules",
      "artifacts",
      "priority",
    ]) {
      expect(workspaceManagementLocation(`${base}/${route}`, workspaceId)).toBeNull();
    }
  });

  test("normalizes unknown and legacy settings searches to General", () => {
    expect(workspaceSettingsSectionFromSearch(undefined)).toBe("general");
    expect(workspaceSettingsSectionFromSearch("permissions")).toBe("general");
    expect(workspaceSettingsSectionFromSearch("models")).toBe("models");
  });

  test("keeps organization settings as quiet secondary navigation", () => {
    expect(shellSource).toContain('to="/workspaces/$workspaceId/organization"');
    expect(shellSource).toContain("Organization settings for ${organizationName}");
    expect(shellSource).toContain("Workspace settings");
    expect(shellSource).toContain("{organizationName}");
    expect(shellSource).not.toContain("Organization settings</span>");
  });

  test("renders the shared selector and preserves the settings section when switching", async () => {
    const rendered = await renderShell({ kind: "settings", section: "danger" });
    try {
      const selector = rendered.container.querySelector<HTMLButtonElement>(
        `button[aria-label="Workspace selector for ${workspaceId}"]`,
      );
      expect(selector?.textContent).toBe("Switch workspace");

      await act(async () => selector?.click());

      expect(resetSessionView).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/settings",
        params: { workspaceId: nextWorkspaceId },
        search: { section: "danger" },
      });
    } finally {
      await rendered.unmount();
    }
  });

  test("preserves the management destination when switching", async () => {
    const rendered = await renderShell({
      kind: "page",
      target: "/workspaces/$workspaceId/rigs",
    });
    try {
      const selector = rendered.container.querySelector<HTMLButtonElement>(
        `button[aria-label="Workspace selector for ${workspaceId}"]`,
      );
      await act(async () => selector?.click());

      expect(resetSessionView).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/rigs",
        params: { workspaceId: nextWorkspaceId },
      });
    } finally {
      await rendered.unmount();
    }
  });
});
