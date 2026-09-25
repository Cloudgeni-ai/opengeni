// Shared happy-dom harness for RailFooter account-menu tests. Each test file
// runs in its own process, so a file may add its own module mocks (for example
// a failing Help chunk) before loading this harness.
import { expect, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export type RailFooterMenuConfig = {
  managed: boolean;
  analytics: boolean;
  documentationUrl: string | null;
};

export async function loadRailFooterMenuHarness() {
  let footer: RailFooterMenuConfig = { managed: false, analytics: false, documentationUrl: null };

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
        workspaceGrants: [],
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
    OrganizationInvitationCountBadge: () => null,
    OrganizationInvitationRailNotice: () => null,
    OrganizationInvitationsDialog: () => null,
    OrganizationInvitationsMenuItem: () => null,
    useOrganizationInvitations: () => ({ pendingCount: 0 }),
  }));

  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { RailFooter } = await import("./rail-footer");

  async function renderOpenAccountMenu(
    config: RailFooterMenuConfig,
  ): Promise<() => Promise<void>> {
    footer = config;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<RailFooter />));
    // RailFooter starts the Help chunk on mount; let it settle before opening.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Account menu"]',
    );
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

  function expectNoAdjacentSeparators(sequence: string[]) {
    sequence.forEach((entry, index) => {
      if (entry === "|") expect(sequence[index + 1]).not.toBe("|");
    });
  }

  function teardown() {
    mock.restore();
    GlobalRegistrator.unregister();
  }

  return { renderOpenAccountMenu, menuSequence, expectNoAdjacentSeparators, teardown };
}
