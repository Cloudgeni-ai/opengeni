import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { Workspace } from "@/types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const managedUserId = "user-one";
let emailVerified = true;
let collapsed = false;
const workspace = {
  id: workspaceId,
  accountId,
  kind: "personal",
  name: "Personal workspace",
  inferenceControl: { state: "active" },
} as Workspace;

mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#organization">{children}</a>,
}));

mock.module("@/context", () => ({
  useAppContext: () => ({
    clientConfig: { auth: { mode: "managedSession" } },
    authSession: { user: { id: managedUserId, emailVerified } },
    accessContext: {
      mode: "managed",
      subjectId: `user:${managedUserId}`,
      accountGrants: [
        {
          accountId,
          subjectId: `user:${managedUserId}`,
          role: "owner",
          permissions: ["workspace:create"],
          metadata: { accountName: "CloudGeni" },
        },
      ],
      workspaceGrants: [],
      defaultAccountId: accountId,
      defaultWorkspaceId: workspaceId,
    },
    workspaces: [workspace],
    managedSelfContext: {
      identity: {
        credentialGeneration: 1,
        managedUserId,
        subjectId: `user:${managedUserId}`,
      },
      memberships: [
        {
          id: "membership-one",
          organizationId: accountId,
          status: "active",
          personalWorkspaceId: workspaceId,
        },
      ],
    },
    captureWorkspaceInvocation: () => ({ workspaceId, revision: 1 }),
    ownsWorkspaceInvocation: () => true,
    createWorkspace: async () => null,
  }),
}));

mock.module("@/components/rail/rail-context", () => ({
  useRail: () => ({
    workspaceId,
    collapsed,
    openWorkspace: () => undefined,
  }),
}));

mock.module("@/components/rail/create-organization-dialog", () => ({
  CreateOrganizationDialog: () => <div data-testid="create-organization-dialog" />,
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { SwitcherBlock, useNewOrganizationMenuItem } = await import("./switcher-block");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } =
  await import("@/components/ui/dropdown-menu");

function AccountMenuProbe() {
  const newOrganization = useNewOrganizationMenuItem();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Account</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>{newOrganization.item}</DropdownMenuContent>
      </DropdownMenu>
      {newOrganization.dialog}
    </>
  );
}

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
  emailVerified = true;
  collapsed = false;
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function workspaceMenuTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!trigger) throw new Error("Missing production workspace menu trigger");
  return trigger;
}

async function openMenu(trigger: HTMLButtonElement) {
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
    );
    await Promise.resolve();
  });
}

function menuItem(label: string): HTMLElement | null {
  return (
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
}

describe("SwitcherBlock production workspace menu wiring", () => {
  test("the picker only lists workspaces: no organization actions, even for an eligible user", async () => {
    const rendered = await render(<SwitcherBlock />);
    try {
      const trigger = workspaceMenuTrigger(rendered.container);
      expect(trigger.getAttribute("aria-label")).toContain("Personal workspace");
      await openMenu(trigger);
      expect(
        menuItem("Personal workspace, your Personal workspace, private to you"),
      ).not.toBeNull();
      expect(menuItem("New organization")).toBeNull();
      expect(menuItem("Organization settings")).toBeNull();
      expect(
        Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((item) =>
          item.textContent?.trim(),
        ),
      ).not.toContain("New workspace in CloudGeni");
    } finally {
      await rendered.unmount();
    }
  });
});

describe("account menu New organization", () => {
  test("opens organization creation for an eligible user", async () => {
    const rendered = await render(<AccountMenuProbe />);
    try {
      await openMenu(workspaceMenuTrigger(rendered.container));
      const createOrganization = menuItem("New organization");
      expect(createOrganization).not.toBeNull();
      await act(async () => {
        createOrganization?.click();
        await Promise.resolve();
      });
      expect(
        document.body.querySelector('[data-testid="create-organization-dialog"]'),
      ).not.toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  test("is omitted when the managed identity is ineligible", async () => {
    emailVerified = false;
    const rendered = await render(<AccountMenuProbe />);
    try {
      await openMenu(workspaceMenuTrigger(rendered.container));
      expect(menuItem("New organization")).toBeNull();
      expect(document.body.querySelector('[data-testid="create-organization-dialog"]')).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});
