import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const managedUserId = "user-one";
let emailVerified = true;
let collapsed = false;

mock.module("@/context", () => ({
  useAppContext: () => ({
    clientConfig: { auth: { mode: "managedSession" } },
    authSession: { user: { id: managedUserId, emailVerified } },
    managedSelfContext: {
      identity: {
        credentialGeneration: 1,
        managedUserId,
        subjectId: `user:${managedUserId}`,
      },
      memberships: [
        {
          id: "membership-one",
          organizationId: "22222222-2222-4222-8222-222222222222",
          status: "active",
          personalWorkspaceId: workspaceId,
        },
      ],
    },
  }),
}));

mock.module("@/components/rail/rail-context", () => ({
  useRail: () => ({
    workspaceId,
    collapsed,
    openWorkspace: () => undefined,
  }),
}));

mock.module("@/components/rail/workspace-switcher", () => ({
  WorkspaceSwitcherMenu: ({
    workspaceId: selectedWorkspaceId,
    collapsed: menuCollapsed,
    onCreateOrganization,
  }: {
    workspaceId: string;
    collapsed: boolean;
    onCreateOrganization?: () => void;
  }) => (
    <button
      type="button"
      data-testid="production-workspace-menu"
      data-workspace-id={selectedWorkspaceId}
      data-collapsed={String(menuCollapsed)}
      data-can-create-organization={String(onCreateOrganization !== undefined)}
      onClick={onCreateOrganization}
    >
      Workspace menu
    </button>
  ),
}));

mock.module("@/components/rail/create-organization-dialog", () => ({
  CreateOrganizationDialog: () => <div data-testid="create-organization-dialog" />,
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { SwitcherBlock } = await import("./switcher-block");

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

describe("SwitcherBlock production workspace menu wiring", () => {
  test("forwards the route and opens organization creation for an eligible user", async () => {
    const rendered = await render(<SwitcherBlock />);
    try {
      const menu = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="production-workspace-menu"]',
      );
      expect(menu?.dataset.workspaceId).toBe(workspaceId);
      expect(menu?.dataset.collapsed).toBe("false");
      expect(menu?.dataset.canCreateOrganization).toBe("true");

      await act(async () => {
        menu?.click();
        await Promise.resolve();
      });
      expect(
        rendered.container.querySelector('[data-testid="create-organization-dialog"]'),
      ).not.toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  test("omits organization creation when the managed identity is ineligible", async () => {
    emailVerified = false;
    const rendered = await render(<SwitcherBlock />);
    try {
      const menu = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="production-workspace-menu"]',
      );
      expect(menu?.dataset.canCreateOrganization).toBe("false");
      await act(async () => menu?.click());
      expect(
        rendered.container.querySelector('[data-testid="create-organization-dialog"]'),
      ).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});
