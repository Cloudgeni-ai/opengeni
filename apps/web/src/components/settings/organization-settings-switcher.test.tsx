import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Workspace } from "@/types";
import { organizationSettingsWorkspaceId } from "@/lib/org";

const workspaces = [
  { id: "ws-member", accountId: "member", name: "Member workspace" },
  { id: "ws-a", accountId: "a", name: "Main" },
  { id: "ws-b-z", accountId: "b", name: "Zulu" },
  { id: "ws-b-a", accountId: "b", name: "Alpha" },
] as Workspace[];
const navigate = mock(() => undefined);
const resetSessionView = mock(() => undefined);
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({
    children,
    params,
    ...props
  }: {
    children: ReactNode;
    params: { workspaceId: string };
  }) => (
    <a {...props} href={`/workspaces/${params.workspaceId}/organization`}>
      {children}
    </a>
  ),
}));
mock.module("@/context", () => ({
  useAppContext: () => ({
    workspaces,
    resetSessionView,
    accessContext: {
      subjectId: "user:test",
      accountGrants: ["a", "b", "empty", "member"].map((accountId) => ({
        accountId,
        subjectId: "user:test",
        role: accountId === "member" ? "member" : "owner",
        permissions: ["account:read"],
        metadata: { accountName: `Organization ${accountId}` },
      })),
      workspaceGrants: [],
      defaultAccountId: "a",
    },
  }),
}));
GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { OrganizationSettingsSwitcher } = await import("./organization-settings-switcher");
const { WorkspaceMenu } = await import("../rail/workspace-switcher");
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  navigate.mockClear();
  resetSessionView.mockClear();
});
async function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await act(async () => {
    host
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

test("selects an accessible workspace belonging to the requested organization", () => {
  expect(organizationSettingsWorkspaceId(workspaces, "a", "ws-a")).toBe("ws-a");
  expect(organizationSettingsWorkspaceId(workspaces, "b", "ws-a")).toBe("ws-b-a");
  expect(organizationSettingsWorkspaceId(workspaces, "b", "ws-b-z")).toBe("ws-b-z");
  expect(organizationSettingsWorkspaceId(workspaces, "empty", "ws-a")).toBeNull();
});
test("switches organization while preserving settings section and resetting session state", async () => {
  const unmount = await render(
    <OrganizationSettingsSwitcher
      workspaceId="ws-a"
      organizationLabel="Organization a"
      section="people"
    />,
  );
  try {
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(
      items
        .find((item) => item.textContent?.includes("Organization empty"))
        ?.hasAttribute("data-disabled"),
    ).toBe(true);
    const member = items.find((item) => item.textContent?.includes("Organization member"))!;
    expect(member.hasAttribute("data-disabled")).toBe(true);
    await act(async () => member.click());
    expect(navigate).not.toHaveBeenCalled();
    expect(resetSessionView).not.toHaveBeenCalled();
    await act(async () => items.find((item) => item.textContent === "Organization a")!.click());
    expect(navigate).not.toHaveBeenCalled();
    // Reopen after selecting the current organization.
    await act(async () =>
      document
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Organization b")!
        .click(),
    );
    expect(resetSessionView).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      to: "/workspaces/$workspaceId/organization",
      params: { workspaceId: "ws-b-a" },
      search: { section: "people" },
    });
  } finally {
    await unmount();
  }
});
test("organization heading settings links target their own organization", async () => {
  const unmount = await render(
    <WorkspaceMenu
      collapsed={false}
      orgs={["a", "b", "empty", "member"].map((accountId) => ({
        accountId,
        label: `Organization ${accountId}`,
        canManage: accountId !== "member",
      }))}
      workspaces={workspaces.map(
        (workspace) => ({ ...workspace, inferenceControl: { state: "active" } }) as Workspace,
      )}
      activeWorkspaceId="ws-a"
      canCreate={false}
      onSelect={() => {}}
      onCreate={() => {}}
      managedSelfContext={null}
      align="start"
    >
      <button>Open workspaces</button>
    </WorkspaceMenu>,
  );
  try {
    expect(
      document.querySelector('a[aria-label="Organization settings for Organization member"]'),
    ).toBeNull();
    expect(
      document
        .querySelector('a[aria-label="Organization settings for Organization a"]')
        ?.getAttribute("href"),
    ).toBe("/workspaces/ws-a/organization");
    expect(
      document
        .querySelector('a[aria-label="Organization settings for Organization b"]')
        ?.getAttribute("href"),
    ).toBe("/workspaces/ws-b-a/organization");
    expect(
      document.querySelector('a[aria-label="Organization settings for Organization empty"]'),
    ).toBeNull();
  } finally {
    await unmount();
  }
});
