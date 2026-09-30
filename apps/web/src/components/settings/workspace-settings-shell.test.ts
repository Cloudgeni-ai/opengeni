import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceManagementLocation } from "./workspace-settings-shell";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const personalWorkspaceId = "22222222-2222-4222-8222-222222222222";
const northwindWorkspaceId = "33333333-3333-4333-8333-333333333333";
const northwindPersonalId = "44444444-4444-4444-8444-444444444444";
const betaWorkspaceId = "55555555-5555-4555-8555-555555555555";
const acme = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const northwind = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const beta = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const navigate = mock((_options: unknown) => undefined);
const resetSessionView = mock(() => undefined);
let workspacePermissions: string[] = [];
let acmeRole: "owner" | "admin" | "member" = "owner";

function workspace(id: string, accountId: string, name: string, kind = "shared") {
  return { id, accountId, name, kind, inferenceControl: { state: "active" } };
}
const workspaces = [
  workspace(workspaceId, acme, "Design preview"),
  workspace(personalWorkspaceId, acme, "Personal workspace", "personal"),
  workspace(northwindPersonalId, northwind, "Personal workspace", "personal"),
  workspace(northwindWorkspaceId, northwind, "General"),
  workspace(betaWorkspaceId, beta, "Launch room"),
];
function grant(accountId: string, name: string, role: "owner" | "admin" | "member") {
  return {
    accountId,
    subjectId: "user:alex",
    role,
    permissions:
      role === "member"
        ? ["account:read"]
        : ["account:read", "account:admin", "workspace:create", "billing:read", "api_keys:manage"],
    metadata: { accountName: name },
  };
}

mock.module("@/context", () => ({
  useAppContext: () => ({
    resetSessionView,
    workspaces,
    clientConfig: { productAccessMode: "managed", auth: { mode: "managedSession" } },
    authSession: { user: { id: "alex", emailVerified: true } },
    managedSelfContext: {
      identity: { credentialGeneration: 1, managedUserId: "alex", subjectId: "user:alex" },
      memberships: [
        {
          id: "membership-acme",
          organizationId: acme,
          status: "active",
          personalWorkspaceId,
        },
      ],
    },
    client: { getOrganizationAdministrationOverview: async () => null },
    accessContext: {
      mode: "managed",
      subjectId: "user:alex",
      defaultAccountId: acme,
      accountGrants: [
        grant(acme, "Acme Robotics", acmeRole),
        grant(northwind, "Northwind Labs", "owner"),
        grant(beta, "Beta Partners", "member"),
      ],
      workspaceGrants: [{ workspaceId, accountId: acme, permissions: workspacePermissions }],
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
  useRouter: () => ({ state: { location: { pathname: "/", search: {} } } }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { search: {} } }),
}));

mock.module("@/components/rail/workspace-paused-banner", () => ({
  WorkspacePausedBanner: () => createElement("p", null, "Paused banner"),
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const {
  WorkspaceManagementShell,
  workspaceManagementLocation,
  workspaceSettingsSectionFromSearch,
} = await import("./workspace-settings-shell");

const base = `/workspaces/${workspaceId}`;

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  navigate.mockClear();
  resetSessionView.mockClear();
  workspacePermissions = [];
  acmeRole = "owner";
  document.body.replaceChildren();
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
            organizationName: "Acme Robotics",
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
    rail: () => container.querySelector<HTMLElement>('nav[aria-label="Settings"]')!,
    section: (id: string) =>
      container.querySelector<HTMLElement>(`[data-settings-section="${id}"]`),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function linkLabels(section: HTMLElement | null): string[] {
  return Array.from(section?.querySelectorAll("a") ?? []).map((link) => link.textContent ?? "");
}

async function openMenu(trigger: HTMLElement) {
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
}

function menuItems(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

describe("settings rail", () => {
  test("shows workspace, organization and account pages in labeled sections of one rail", async () => {
    workspacePermissions = ["workspace:admin"];
    const view = await renderShell({ kind: "settings", section: null });
    try {
      const sections = Array.from(
        view.rail().querySelectorAll<HTMLElement>("[data-settings-section]"),
      ).map((section) => section.getAttribute("data-settings-section"));
      expect(sections).toEqual(["workspace", "organization", "account"]);

      // The one picker names the workspace and organization; headers name only the scope.
      const workspaceSection = view.section("workspace");
      expect(workspaceSection?.firstElementChild?.textContent).toBe("Workspace");
      expect(workspaceSection?.textContent).not.toContain("Design preview");
      expect(linkLabels(workspaceSection)).toEqual([
        "General",
        "Access",
        "Models",
        "API keys",
        "Developer",
        "Insights",
        "Variable sets",
        "Sandbox environments",
        "Machines",
      ]);
      // The scope header is the only heading in a section: two unlabeled groups,
      // the workspace's settings and dashboards, then its runtime.
      for (const retired of ["Activity", "Runtime", "Workspace activity"]) {
        expect(workspaceSection?.textContent).not.toContain(retired);
      }
      expect(workspaceSection?.getAttribute("aria-label")).toBe("Workspace");
      expect(
        Array.from(workspaceSection!.querySelectorAll("ul")).map((list) => list.children.length),
      ).toEqual([6, 3]);

      const organizationSection = view.section("organization");
      expect(organizationSection?.firstElementChild?.textContent).toBe("Organization");
      expect(linkLabels(organizationSection)).toEqual([
        "General",
        "People",
        "Workspaces",
        "Organization identity",
        "Models",
        "Integrations",
        "Billing & usage",
        "Developer",
        "Security & data",
      ]);
      expect(
        Array.from(organizationSection!.querySelectorAll("ul")).map((list) => list.children.length),
      ).toEqual([4, 5]);
      for (const link of Array.from(organizationSection!.querySelectorAll("a"))) {
        expect(link.getAttribute("href")).toBe(`${base}/organization`);
        expect(link.getAttribute("aria-label")).toContain("Acme Robotics organization settings");
      }

      expect(linkLabels(view.section("account"))).toEqual(["Security"]);
      expect(view.section("account")?.querySelector("a")?.getAttribute("href")).toBe(
        "/settings/security",
      );
      // No separate jump out to an organization shell any more.
      expect(view.rail().textContent).not.toContain("Organization settings for");
      for (const label of ["Members", "Memory", "Danger zone", "Capabilities"]) {
        expect(view.rail().textContent).not.toContain(label);
      }
    } finally {
      await view.unmount();
    }
  });

  test("lists only the organization pages a member can use", async () => {
    acmeRole = "member";
    workspacePermissions = ["sessions:create"];
    const view = await renderShell({ kind: "settings", section: null });
    try {
      expect(linkLabels(view.section("organization"))).toEqual([
        "Organization identity",
        "Security & data",
      ]);
      // Two pages stay one group, not two lone rows.
      expect(view.section("organization")!.querySelectorAll("ul")).toHaveLength(1);
      // Insights needs workspace admin.
      expect(linkLabels(view.section("workspace"))).toContain("General");
      expect(linkLabels(view.section("workspace"))).not.toContain("Insights");
    } finally {
      await view.unmount();
    }
  });

  test("an organization page is current in the same rail, and the page draws its own header", async () => {
    const view = await renderShell({ kind: "organization", section: "people" });
    try {
      const current = view.rail().querySelector('a[aria-current="page"]');
      expect(current?.textContent).toBe("People");
      expect(view.section("organization")?.contains(current)).toBe(true);
      const content = view.container.querySelector('section[aria-label="People"]');
      expect(content).not.toBeNull();
      expect(content?.querySelector("h1")).toBeNull();
      expect(content?.textContent).toContain("Settings content");
      // Workspace state belongs to workspace pages.
      expect(view.container.textContent).not.toContain("Paused banner");
      const back = Array.from(view.rail().querySelectorAll("a")).find(
        (link) => link.textContent === "Back to sessions",
      );
      expect(back?.getAttribute("href")).toBe(`${base}/sessions`);
    } finally {
      await view.unmount();
    }
  });

  test("a page this person can't use falls back to the first organization page they can", async () => {
    acmeRole = "member";
    const view = await renderShell({ kind: "organization", section: "people" });
    try {
      expect(view.rail().querySelector('a[aria-current="page"]')?.textContent).toBe(
        "Organization identity",
      );
    } finally {
      await view.unmount();
    }
  });

  test("one picker at the top of the rail: the main rail's workspace picker, no per-section switchers", async () => {
    const view = await renderShell({ kind: "settings", section: "models" });
    try {
      const pickers = view.rail().querySelectorAll('button[aria-haspopup="menu"]');
      expect(pickers).toHaveLength(1);
      const picker = pickers[0] as HTMLElement;
      expect(picker.closest("[data-settings-section]")).toBeNull();
      expect(picker.getAttribute("aria-label")).toBe(
        "Workspace: Design preview, in Acme Robotics. Switch workspace or organization",
      );
      await openMenu(picker);
      const labels = menuItems().map((item) => item.textContent ?? "");
      expect(labels.some((label) => label.includes("Design preview"))).toBe(true);
      expect(labels.some((label) => label.includes("Launch room"))).toBe(false);
      expect(labels).toContain("New workspace in Acme Robotics");
      expect(labels).toContain("Organization settings");
      expect(labels.slice(-3)).toEqual(["Beta Partners", "Northwind Labs", "New organization"]);
      // Switching workspace keeps the settings page.
      await act(async () =>
        menuItems()
          .find((item) => item.textContent?.includes("Personal workspace"))!
          .click(),
      );
      expect(resetSessionView).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/settings",
        params: { workspaceId: personalWorkspaceId },
        search: { section: "models" },
      });
    } finally {
      await view.unmount();
    }
  });

  test("switching organization from the picker keeps the organization page", async () => {
    const view = await renderShell({ kind: "organization", section: "people" });
    try {
      await openMenu(view.rail().querySelector<HTMLElement>('button[aria-haspopup="menu"]')!);
      await act(async () =>
        menuItems()
          .find((item) => item.textContent === "Northwind Labs")!
          .click(),
      );
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/organization",
        params: { workspaceId: northwindWorkspaceId },
        search: { section: "people" },
      });
    } finally {
      await view.unmount();
    }
  });

  test("switching organization returns to the workspace last used there", async () => {
    localStorage.setItem(
      "og.workspace.navigation.organizations:v1:user%3Aalex",
      JSON.stringify({ [northwind]: northwindPersonalId }),
    );
    const view = await renderShell({ kind: "organization", section: "people" });
    try {
      await openMenu(view.rail().querySelector<HTMLElement>('button[aria-haspopup="menu"]')!);
      await act(async () =>
        menuItems()
          .find((item) => item.textContent === "Northwind Labs")!
          .click(),
      );
      expect(navigate).toHaveBeenCalledWith({
        to: "/workspaces/$workspaceId/organization",
        params: { workspaceId: northwindPersonalId },
        search: { section: "people" },
      });
    } finally {
      localStorage.clear();
      await view.unmount();
    }
  });

  test("settings, the Insights dashboard, runtime pages and organization pages open in settings mode", () => {
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId, "api-keys")).toEqual({
      kind: "settings",
      section: "api-keys",
    });
    expect(workspaceManagementLocation(`${base}/settings`, workspaceId)).toEqual({
      kind: "settings",
      section: null,
    });
    expect(workspaceManagementLocation(`${base}/organization`, workspaceId, "people")).toEqual({
      kind: "organization",
      section: "people",
    });
    // Older organization section names land on the page that holds them now.
    expect(workspaceManagementLocation(`${base}/organization`, workspaceId, "overview")).toEqual({
      kind: "organization",
      section: "general",
    });
    expect(workspaceManagementLocation(`${base}/organization`, workspaceId)).toEqual({
      kind: "organization",
      section: null,
    });
    for (const route of ["insights", "variable-sets", "rigs", "machines"]) {
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
      "rigs-archive",
      "organization-archive",
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

  test("an organization admin without workspace access sees General and Access only", async () => {
    const managed = "66666666-6666-4666-8666-666666666666";
    const rendered = await renderShell(
      { kind: "settings", section: null },
      {
        workspaceId: managed,
        organizationManagementOnly: true,
        organizationId: acme,
        organizationSettingsWorkspaceId: workspaceId,
        workspaceName: "Managed without content access",
      },
    );
    try {
      // No picker for a workspace you can't open: the headers name it and its organization.
      expect(rendered.rail().querySelector('button[aria-haspopup="menu"]')).toBeNull();
      const workspaceSection = rendered.section("workspace");
      expect(workspaceSection?.textContent).toContain("Managed without content access");
      expect(linkLabels(workspaceSection)).toEqual(["General", "Access"]);
      for (const link of Array.from(workspaceSection!.querySelectorAll("a"))) {
        expect(link.getAttribute("href")).toBe(`/workspaces/${managed}/settings`);
      }
      // Organization pages open through an accessible workspace of the same organization.
      const organizationSection = rendered.section("organization");
      expect(organizationSection?.textContent).toContain("Acme Robotics");
      expect(organizationSection?.querySelector("a")?.getAttribute("href")).toBe(
        `${base}/organization`,
      );
      expect(rendered.rail().textContent).not.toContain("API keys");
      expect(rendered.rail().textContent).not.toContain("Variable sets");
    } finally {
      await rendered.unmount();
    }
  });

  test("Insights keeps the settings rail, with Insights current and a way back to sessions", async () => {
    workspacePermissions = ["workspace:admin"];
    const view = await renderShell({ kind: "page", target: "/workspaces/$workspaceId/insights" });
    try {
      const rail = view.rail();
      expect(rail).not.toBeNull();
      expect(rail.querySelector('a[aria-current="page"]')?.textContent).toBe("Insights");
      const back = Array.from(rail.querySelectorAll("a")).find(
        (link) => link.textContent === "Back to sessions",
      );
      expect(back?.getAttribute("href")).toBe(`${base}/sessions`);
      // The dashboard brings its own page; the shell adds no settings header.
      const content = view.container.querySelector('section[aria-label="Insights"]');
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
