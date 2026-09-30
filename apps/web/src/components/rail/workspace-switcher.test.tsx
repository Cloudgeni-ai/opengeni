import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { Workspace } from "@/types";

const acme = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const northwind = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const beta = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const empty = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function workspace(id: string, accountId: string, name: string, kind = "shared"): Workspace {
  return { id, accountId, name, kind, inferenceControl: { state: "active" } } as Workspace;
}
const workspaces = [
  workspace("ws-design", acme, "Design preview"),
  workspace("ws-acme-personal", acme, "Personal workspace", "personal"),
  workspace("ws-production", acme, "Production"),
  // Personal first by name here: switching lands on the shared workspace anyway.
  workspace("ws-northwind-personal", northwind, "Alpha personal", "personal"),
  workspace("ws-northwind", northwind, "General"),
  workspace("ws-launch", beta, "Launch room"),
];
function grant(accountId: string, name: string, role: "owner" | "member") {
  return {
    accountId,
    subjectId: "user:alex",
    role,
    permissions:
      role === "owner" ? ["account:read", "account:admin", "workspace:create"] : ["account:read"],
    metadata: { accountName: name },
  };
}

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params: { workspaceId: string };
    search?: Record<string, string>;
  }) => {
    const query = search ? `?${new URLSearchParams(search).toString()}` : "";
    return (
      <a {...props} href={`${to.replace("$workspaceId", params.workspaceId)}${query}`}>
        {children}
      </a>
    );
  },
}));
// A configured deployment (key or token) has no organization administrator session.
let authMode = "managedSession";
const createRequests: unknown[] = [];
mock.module("@/context", () => ({
  useAppContext: () => ({
    workspaces,
    managedSelfContext: null,
    clientConfig: { productAccessMode: "managed", auth: { mode: authMode } },
    captureWorkspaceInvocation: () => ({ token: 1 }),
    ownsWorkspaceInvocation: () => true,
    createWorkspace: async (request: { name: string; accountId: string }) => {
      createRequests.push(request);
      return workspace("ws-created", request.accountId, request.name);
    },
    accessContext: {
      mode: "managed",
      subjectId: "user:alex",
      defaultAccountId: acme,
      accountGrants: [
        grant(acme, "Acme Robotics", "owner"),
        grant(northwind, "Northwind Labs", "owner"),
        grant(beta, "Beta Partners", "member"),
        grant(empty, "Empty Org", "member"),
      ],
      workspaceGrants: [],
    },
  }),
}));

GlobalRegistrator.register({ url: "http://homeserver/workspaces/ws-design/sessions" });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { WorkspaceSwitcherMenu } = await import("./workspace-switcher");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  authMode = "managedSession";
  createRequests.length = 0;
  localStorage.clear();
  document.body.replaceChildren();
});

async function renderPicker(workspaceId: string, onCreateOrganization?: () => void) {
  const selected: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <WorkspaceSwitcherMenu
        workspaceId={workspaceId}
        collapsed={false}
        align="start"
        onSelect={(id) => selected.push(id)}
        onCreateOrganization={onCreateOrganization}
      />,
    ),
  );
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  return {
    trigger,
    selected,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function items(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}
function item(text: string): HTMLElement | undefined {
  return items().find((candidate) => candidate.textContent?.includes(text));
}
function menuText(): string {
  return document.body.querySelector('[role="menu"]')?.textContent ?? "";
}

describe("workspace picker", () => {
  test("names the workspace and its organization on the trigger", async () => {
    const picker = await renderPicker("ws-design");
    try {
      expect(picker.trigger.textContent).toContain("Design preview");
      expect(picker.trigger.textContent).toContain("Acme Robotics");
      expect(picker.trigger.getAttribute("aria-label")).toBe(
        "Workspace: Design preview, in Acme Robotics. Switch workspace or organization",
      );
    } finally {
      await picker.unmount();
    }
  });

  test('a Personal workspace reads as a lock tile and "Private · <organization>", not a chip', async () => {
    const picker = await renderPicker("ws-acme-personal");
    try {
      expect(picker.trigger.textContent).toBe("Personal workspacePrivate · Acme Robotics");
      expect(picker.trigger.getAttribute("aria-label")).toContain(
        "Personal workspace, private to you:",
      );
      expect(picker.trigger.querySelector("svg.lucide-lock")).not.toBeNull();
      const row = item("Personal workspace")!;
      expect(row.querySelector("svg.lucide-lock")).not.toBeNull();
      // No chip: the name keeps the width; screen readers still hear it.
      expect(row.textContent).toBe("Personal workspace, your Personal workspace, private to you");
    } finally {
      await picker.unmount();
    }
  });

  test("lists only the current organization's workspaces, then the other organizations", async () => {
    const picker = await renderPicker("ws-design", () => undefined);
    try {
      const group = document.body.querySelector(
        '[role="group"][aria-label="Workspaces in Acme Robotics"]',
      );
      expect(group?.textContent).toContain("Acme Robotics");
      expect(group?.textContent).toContain("Organization");
      const workspaceRows = Array.from(group!.querySelectorAll('[role="menuitem"]')).map(
        (row) => row.textContent ?? "",
      );
      expect(workspaceRows).toHaveLength(4);
      expect(workspaceRows[0]).toContain("Design preview");
      expect(workspaceRows[1]).toContain("Personal workspace");
      expect(workspaceRows[2]).toContain("Production");
      expect(workspaceRows[3]).toBe("New workspace in Acme Robotics");
      expect(menuText()).not.toContain("Launch room");

      const switchGroup = document.body.querySelector(
        '[role="group"][aria-label="Switch organization"]',
      );
      expect(
        Array.from(switchGroup!.querySelectorAll('[role="menuitem"]')).map(
          (row) => row.textContent,
        ),
      ).toEqual(["Beta Partners", "Northwind Labs", "New organization"]);
      // An organization with nothing open to this person can't be switched to.
      expect(menuText()).not.toContain("Empty Org");

      const settings = item("Organization settings");
      expect(settings?.getAttribute("href")).toBe("/workspaces/ws-design/organization");
    } finally {
      await picker.unmount();
    }
  });

  test("switching organization opens that organization's shared workspace", async () => {
    const picker = await renderPicker("ws-design");
    try {
      await act(async () => item("Northwind Labs")!.click());
      expect(picker.selected).toEqual(["ws-northwind"]);
    } finally {
      await picker.unmount();
    }
  });

  test("New organization shows only when the person can create one", async () => {
    const picker = await renderPicker("ws-design");
    try {
      expect(item("New organization")).toBeUndefined();
    } finally {
      await picker.unmount();
    }
  });

  test("switching organization returns to the workspace last used there", async () => {
    localStorage.setItem(
      "og.workspace.navigation.organizations:v1:user%3Aalex",
      JSON.stringify({ [northwind]: "ws-northwind-personal", [beta]: "ws-gone" }),
    );
    const picker = await renderPicker("ws-design");
    try {
      await act(async () => item("Northwind Labs")!.click());
      expect(picker.selected).toEqual(["ws-northwind-personal"]);
    } finally {
      await picker.unmount();
    }
    // A remembered workspace that is no longer open falls back to the first shared one.
    const again = await renderPicker("ws-design");
    try {
      await act(async () => item("Beta Partners")!.click());
      expect(again.selected).toEqual(["ws-launch"]);
    } finally {
      await again.unmount();
    }
  });

  test("New workspace opens the organization's one create page, named and returning here", async () => {
    const picker = await renderPicker("ws-design");
    try {
      const create = item("New workspace in Acme Robotics")!;
      const href = new URL(create.getAttribute("href")!, "http://homeserver");
      expect(href.pathname).toBe("/workspaces/ws-design/organization");
      expect(Object.fromEntries(href.searchParams)).toEqual({
        section: "workspaces",
        view: "new-workspace",
        from: "/workspaces/ws-design/sessions",
        fromLabel: "Design preview",
      });
    } finally {
      await picker.unmount();
    }
  });

  test("a member can't create a workspace in their organization, and nothing is created elsewhere", async () => {
    const picker = await renderPicker("ws-launch");
    try {
      const create = item("New workspace in Beta Partners")!;
      expect(create.hasAttribute("data-disabled")).toBe(true);
      expect(create.textContent).toContain("Only owners and admins can create workspaces here.");
      expect(create.getAttribute("href")).toBeNull();
      await act(async () => create.click());
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      // Creating in an organization they administer starts by switching to it.
      expect(item("Acme Robotics")).toBeDefined();
    } finally {
      await picker.unmount();
    }
  });

  test("a configured deployment key that may create workspaces names one here, in this organization", async () => {
    authMode = "deploymentKey";
    const picker = await renderPicker("ws-design");
    try {
      const create = item("New workspace in Acme Robotics")!;
      expect(create.hasAttribute("data-disabled")).toBe(false);
      expect(create.getAttribute("href")).toBeNull();
      await act(async () => create.click());
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.textContent).toContain("New workspace");
      const input = dialog.querySelector<HTMLInputElement>("#workspace-name")!;
      await act(async () => {
        input.value = "Staging";
        // happy-dom does not route input events through React's value tracker.
        const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"))!;
        (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!.onChange(
          { target: input, currentTarget: input },
        );
      });
      await act(async () => {
        dialog.querySelector<HTMLFormElement>("form")!.requestSubmit();
      });
      expect(createRequests).toEqual([{ name: "Staging", accountId: acme }]);
      expect(picker.selected).toEqual(["ws-created"]);
    } finally {
      await picker.unmount();
    }
  });
});
