// Happy-dom harness for RailFooter account-menu tests. Web test files run in
// their own process, so these module mocks never leak into another file.
import { expect, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export type RailFooterMenuConfig = {
  managed: boolean;
  analytics: boolean;
  documentationUrl: string | null;
  /** Grants sessions:create in the workspace, which is what enables Send feedback. */
  canSendFeedback?: boolean;
  pendingInvitations?: number;
};

export async function loadRailFooterMenuHarness() {
  let footer: RailFooterMenuConfig = { managed: false, analytics: false, documentationUrl: null };
  let pendingInvitations = 0;

  mock.module("@tanstack/react-router", () => ({
    Link: ({ children }: { children: ReactNode }) => <a href="#settings">{children}</a>,
  }));

  mock.module("@/components/rail/rail-context", () => ({
    useRail: () => ({
      workspaceId: "workspace-1",
      collapsed: false,
      isMobile: true,
      toggleCollapsed: () => undefined,
    }),
  }));

  mock.module("@/components/rail/workspace-nav", () => ({
    WorkspaceNav: () => null,
  }));

  mock.module("@/context", () => ({
    useAppContext: () => ({
      client: {},
      clientConfig: {
        auth: { mode: footer.managed ? "managedSession" : "none" },
        managedAuthSessionSetMode: "legacy",
        analytics: footer.analytics
          ? { consentRequired: true, providers: { posthog: { key: "phc_test" } } }
          : null,
        documentationUrl: footer.documentationUrl,
      },
      authSession: null,
      accessContext: {
        mode: "local",
        subjectId: "local",
        subjectLabel: "Local user",
        workspaceGrants: footer.canSendFeedback
          ? [{ workspaceId: "workspace-1", permissions: ["sessions:create"] }]
          : [],
        accountGrants: [],
      },
      keyAuthRequired: false,
      forgetAccessKey: () => undefined,
      handleManagedSignOut: async () => undefined,
      revalidatePrincipalAccess: async () => undefined,
    }),
  }));

  mock.module("@/components/organization-invitations", () => ({
    accountMenuAriaLabel: () => "Account menu",
    OrganizationInvitationDot: () => null,
    OrganizationInvitationsDialog: () => null,
    OrganizationInvitationsMenuItem: ({ controller }: { controller: { pendingCount: number } }) =>
      controller.pendingCount > 0 ? (
        <DropdownMenuItem>Invitations{controller.pendingCount}</DropdownMenuItem>
      ) : null,
    useOrganizationInvitations: () => ({ pendingCount: pendingInvitations }),
  }));

  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { RailFooter } = await import("./rail-footer");
  const { DropdownMenuItem } = await import("@/components/ui/dropdown-menu");

  async function renderOpenAccountMenu(config: RailFooterMenuConfig): Promise<() => Promise<void>> {
    footer = config;
    pendingInvitations = config.pendingInvitations ?? 0;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<RailFooter />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Account menu"]');
    if (!trigger) throw new Error("Missing account menu trigger");
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return async () => {
      await act(async () => root.unmount());
      container.remove();
    };
  }

  /** The open menu's children in order: "|" per separator, else its text. */
  function menuSequence(): string[] {
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    if (!menu) throw new Error("Account menu did not open");
    return Array.from(menu.children).map((child) =>
      child.getAttribute("role") === "separator" ? "|" : (child.textContent?.trim() ?? ""),
    );
  }

  /** Opens the submenu whose trigger reads `name` (keyboard, as a user would) and lists its rows. */
  async function openSubmenu(name: string): Promise<string[]> {
    const trigger = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]'),
    ).find((element) => element.textContent?.includes(name));
    if (!trigger) throw new Error(`Missing submenu ${name}`);
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const menus = document.body.querySelectorAll<HTMLElement>('[role="menu"]');
    const sub = menus[menus.length - 1];
    return Array.from(sub?.children ?? []).map((child) => child.textContent?.trim() ?? "");
  }

  function expectNoAdjacentSeparators(sequence: string[]) {
    sequence.forEach((entry, index) => {
      if (entry === "|") expect(sequence[index + 1]).not.toBe("|");
    });
  }

  function teardown() {
    mock.restore();
    GlobalRegistrator.unregister();
  }

  return { renderOpenAccountMenu, menuSequence, openSubmenu, expectNoAdjacentSeparators, teardown };
}
