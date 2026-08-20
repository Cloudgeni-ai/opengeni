import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { WorkspaceScopeNavigationContent } from "./workspace-scope-nav";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => GlobalRegistrator.unregister());

describe("WorkspaceScopeNavigationContent", () => {
  test("exposes exact scope and resource destinations without raw authority ids", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkspaceScopeNavigationContent
          scope={{
            organizationId: "11111111-1111-4111-8111-111111111111",
            organizationLabel: "Northstar",
            workspaceId: "22222222-2222-4222-8222-222222222222",
            workspaceLabel: "Operations",
            workspaceKind: "shared",
            personalWorkspaceId: "33333333-3333-4333-8333-333333333333",
          }}
          links={[
            {
              href: "/organization",
              label: "Northstar",
              description: "Organization administration",
            },
            {
              href: "/personal",
              label: "Personal",
              description: "Open your owner-only workspace",
            },
          ]}
          resources={[
            {
              href: "/variable-sets",
              label: "Variable sets",
              description: "Organization, Workspace, or Only me",
            },
          ]}
        />,
      );
    });

    const nav = container.querySelector('nav[aria-label="Scope and access"]');
    expect(nav).not.toBeNull();
    expect(nav?.textContent).toContain("Shared workspace inside this organization");
    expect(nav?.textContent).toContain("Organization, Workspace, or Only me");
    expect(nav?.textContent).not.toContain("11111111-1111");
    expect(nav?.querySelectorAll("a")).toHaveLength(3);
    const navigation = new MouseEvent("click", { bubbles: true, cancelable: true });
    expect(nav?.querySelector("a")?.dispatchEvent(navigation)).toBe(true);
    expect(navigation.defaultPrevented).toBe(false);
    await act(async () => root.unmount());
  });
});
