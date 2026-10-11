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
type CapabilityCatalogItem = import("@/types").CapabilityCatalogItem;

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
  onBack: () => {},
};

describe("connector page account management", () => {
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
});
