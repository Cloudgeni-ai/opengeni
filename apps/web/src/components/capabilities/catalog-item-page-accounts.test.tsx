import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Radix portals (the ⋯ menu) decide at import time whether a DOM exists.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterAll(() => GlobalRegistrator.unregister());

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CatalogItemPage } = await import("./catalog-item-page");
type CapabilityCatalogItem = import("@opengeni/react/app/types").CapabilityCatalogItem;

async function render(node: import("react").ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
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

function buttons(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === label,
  );
}

function item(overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    id: "mcp:gmail",
    kind: "mcp",
    source: "registry",
    name: "Gmail",
    description: "Search and read Gmail.",
    category: "communication",
    tags: ["mcp", "oauth2"],
    homepageUrl: null,
    endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    installUrl: null,
    providerDomain: "gmailmcp.googleapis.com",
    surfaceType: "mcp",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    authKind: "oauth2",
    runtime: { available: true },
    actions: ["connect"],
    enabled: false,
    connectionRef: null,
    stale: false,
    metadata: { curation: { curated: true, featured: true, official: true } },
    ...overrides,
  } as unknown as CapabilityCatalogItem;
}

const common = {
  workspaceId: "ws",
  health: { state: "none" } as const,
  logoSrc: null,
  busy: false,
  errorMessage: null,
  socialConnections: [],
  canManageSocial: true,
  canManageSkills: true,
  canTurnOnOrOff: true,
  onBack: () => {},
};

describe("connector page account management", () => {
  test("1Password opens its protected setup and management pages instead of generic MCP setup", async () => {
    for (const enabled of [false, true]) {
      const action = mock(() => {});
      const view = await render(
        <CatalogItemPage
          {...common}
          item={item({
            id: "api:1password",
            kind: "api",
            source: "built_in",
            name: "1Password",
            providerDomain: "1password.com",
            surfaceType: "first_party_onepassword",
            enabled,
            authKind: "api_key",
            mcpUrl: null,
            endpointUrl: null,
          })}
          onAction={action}
        />,
      );
      try {
        const link = view.container.querySelector<HTMLAnchorElement>('a[href*="/secrets"]');
        expect(link?.getAttribute("href")).toBe(
          `/workspaces/ws/secrets${enabled ? "" : "?view=connect-1password"}`,
        );
        expect(link?.textContent).toContain(enabled ? "Manage 1Password" : "Connect 1Password");
        expect(view.container.querySelector('input[type="password"]')).toBeNull();
        expect(action).not.toHaveBeenCalled();
      } finally {
        await view.unmount();
      }
    }
  });
  test("the header action that only disables the connector says so, and accounts are managed per row", async () => {
    const enabled = item({
      enabled: true,
      actions: ["connect", "disconnect"],
      connectionRef: {
        providerDomain: "gmailmcp.googleapis.com",
        kind: "oauth2",
        subjectScope: "subject",
      },
    } as Partial<CapabilityCatalogItem>);
    const broken = {
      id: "00000000-0000-4000-8000-0000000000a1",
      accountId: "acct",
      workspaceId: "personal-ws",
      authorityId: "authority-a",
      subjectId: "me",
      providerDomain: "gmailmcp.googleapis.com",
      kind: "oauth2",
      status: "needs_reauth",
      metadata: { gmailEmail: "me@example.test", mcpUrl: enabled.mcpUrl },
      grantedScopes: [],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: null,
      version: 3,
      createdBySubjectId: "me",
      updatedBySubjectId: "me",
      createdAt: "2026-10-04T00:00:00Z",
      updatedAt: "2026-10-04T00:00:00Z",
    } as const;
    const onAction = mock(() => {});
    const view = await render(
      <CatalogItemPage
        {...common}
        item={enabled}
        health={{ state: "connected", connection: null } as never}
        onAction={onAction}
        connectionAccounts={{ connections: [broken] as never }}
        accountManagement={{ viewerSubjectId: "me", canWrite: true, onRemove: async () => true }}
      />,
    );
    const trigger = view.container.querySelector(
      'button[aria-label^="More actions"]',
    ) as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, ctrlKey: false, bubbles: true }),
      );
    });
    const menu = [...document.querySelectorAll('[role="menuitem"]')].map((node) =>
      node.textContent?.trim(),
    );
    expect(menu).toContain("Turn off for this workspace");
    expect(menu).not.toContain("Disconnect");
    const turnOff = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent?.trim() === "Turn off for this workspace",
    )!;
    await act(async () => turnOff.click());
    // Turning the connector off is not removing accounts.
    expect(onAction).toHaveBeenLastCalledWith({ type: "disconnect", item: enabled });

    await act(async () => buttons(view.container, "Add account")[0]!.click());
    expect(onAction).toHaveBeenLastCalledWith({
      type: "add_oauth_account",
      item: enabled,
      ownership: "personal",
    });
    await act(async () =>
      (
        view.container.querySelector(
          'button[aria-label="Reconnect me@example.test"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onAction).toHaveBeenLastCalledWith({
      type: "reconnect_oauth",
      item: enabled,
      connectionId: broken.id,
      ownership: "personal",
      connectionWorkspaceId: "personal-ws",
    });
    await view.unmount();
  });

  test("someone who can't turn the connector off for everyone isn't offered it", async () => {
    const enabled = item({
      enabled: true,
      actions: ["connect", "disconnect"],
    } as Partial<CapabilityCatalogItem>);
    const view = await render(
      <CatalogItemPage
        {...common}
        canTurnOnOrOff={false}
        item={enabled}
        health={{ state: "connected", connection: null } as never}
        onAction={mock(() => {})}
      />,
    );
    const trigger = view.container.querySelector(
      'button[aria-label^="More actions"]',
    ) as HTMLButtonElement | null;
    if (trigger)
      await act(async () => {
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", { button: 0, ctrlKey: false, bubbles: true }),
        );
      });
    const menu = [...document.querySelectorAll('[role="menuitem"]')].map((node) =>
      node.textContent?.trim(),
    );
    expect(menu).not.toContain("Turn off for this workspace");
    expect(view.container.textContent).not.toContain("Turn off for this workspace");
    await view.unmount();
  });

  test("a member is offered Remove for a custom server exactly when the server says they may", async () => {
    for (const canRemove of [true, false, undefined]) {
      const custom = item({
        id: "mcp:team-tools",
        source: "manual",
        name: "Team tools",
        enabled: true,
        actions: ["connect", "disconnect"],
        metadata: {},
        ...(canRemove === undefined ? {} : { canRemove }),
      } as Partial<CapabilityCatalogItem>);
      const onAction = mock(() => {});
      const view = await render(
        <CatalogItemPage
          {...common}
          canTurnOnOrOff={false}
          item={custom}
          health={{ state: "connected", connection: null } as never}
          onAction={onAction}
        />,
      );
      try {
        const trigger = view.container.querySelector(
          'button[aria-label^="More actions"]',
        ) as HTMLButtonElement | null;
        if (trigger)
          await act(async () => {
            trigger.dispatchEvent(
              new PointerEvent("pointerdown", { button: 0, ctrlKey: false, bubbles: true }),
            );
          });
        const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const remove = items.find(
          (node) => node.textContent?.trim() === "Remove from this workspace",
        );
        expect(items.map((node) => node.textContent?.trim())).not.toContain(
          "Turn off for this workspace",
        );
        if (canRemove !== true) {
          expect(remove).toBeUndefined();
          continue;
        }
        expect(remove).toBeDefined();
        await act(async () => remove!.click());
        expect(onAction).toHaveBeenLastCalledWith({ type: "remove_server", item: custom });
      } finally {
        await view.unmount();
      }
    }
  });

  test("an admin keeps Turn off, not Remove, on a server they may remove", async () => {
    const custom = item({
      id: "mcp:team-tools",
      source: "manual",
      name: "Team tools",
      enabled: true,
      actions: ["connect", "disconnect"],
      metadata: {},
      canRemove: true,
    } as Partial<CapabilityCatalogItem>);
    const view = await render(
      <CatalogItemPage
        {...common}
        item={custom}
        health={{ state: "connected", connection: null } as never}
        onAction={mock(() => {})}
      />,
    );
    const trigger = view.container.querySelector(
      'button[aria-label^="More actions"]',
    ) as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, ctrlKey: false, bubbles: true }),
      );
    });
    const menu = [...document.querySelectorAll('[role="menuitem"]')].map((node) =>
      node.textContent?.trim(),
    );
    expect(menu).toContain("Turn off for this workspace");
    expect(menu).not.toContain("Remove from this workspace");
    await view.unmount();
  });

  test("an organization connector turned off here turns back on with the organization's setup", async () => {
    const off = item({
      id: "registry:linear",
      name: "Linear",
      providerDomain: "mcp.linear.app",
      endpointUrl: "https://mcp.linear.app/mcp",
      mcpUrl: "https://mcp.linear.app/mcp",
      lifecycle: {
        status: "available",
        readiness: "setup_required",
        detail: "From your organization. Turned off in this workspace.",
        managedBy: "organization",
      },
      actions: ["connect", "inspect"],
      metadata: {
        organizationConnector: { id: "c1", generation: 1, login: "each_person", source: "catalog" },
      },
    } as Partial<CapabilityCatalogItem>);
    for (const canTurnOnOrOff of [true, false]) {
      const onAction = mock(() => {});
      const view = await render(
        <CatalogItemPage
          {...common}
          item={off}
          canTurnOnOrOff={canTurnOnOrOff}
          onAction={onAction}
          onConnectAccount={() => {}}
        />,
      );
      try {
        // No sign-in or key of its own: one button that uses the organization's setup.
        expect(buttons(view.container, "Connect Linear")).toHaveLength(0);
        expect(view.container.querySelector('input[type="password"]')).toBeNull();
        const turnOn = buttons(view.container, "Turn on for this workspace")[0]!;
        expect(view.container.textContent).toContain("Turned off in this workspace");
        expect(turnOn.disabled).toBe(!canTurnOnOrOff);
        if (canTurnOnOrOff) {
          await act(async () => turnOn.click());
          expect(onAction).toHaveBeenLastCalledWith({ type: "enable", item: off });
        } else {
          expect(view.container.textContent).toContain("Ask a workspace admin to turn it back on.");
        }
      } finally {
        await view.unmount();
      }
    }
  });
});
