import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  capabilityDescription,
  isCommunityCapability,
  personalOnlyCapability,
} from "./capability-copy";
import { CatalogItemPage } from "./catalog-item-page";
import { IntegrationPage } from "./integration-page";
import type { IntegrationViewModel } from "./integration-view-model";
import { ProviderPage } from "./provider-page";
import type { CapabilityCatalogItem } from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function render(node: ReactNode) {
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

/** The page's text outside collapsed disclosures (Technical details). */
function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const node of copy.querySelectorAll("[data-slot=disclosure]")) {
    const trigger = node.querySelector("[aria-expanded]");
    if (trigger?.getAttribute("aria-expanded") === "false") {
      trigger.remove();
      node.textContent = "Technical details";
    }
  }
  return copy.textContent ?? "";
}

function buttons(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === label,
  );
}

function model(overrides: Partial<IntegrationViewModel> = {}): IntegrationViewModel {
  return {
    id: "outlook-mail",
    name: "Outlook Mail",
    description: "Read, send, and organize mail in a connected Outlook mailbox.",
    mark: { monogram: "O" },
    chip: { label: "Not connected", tone: "idle" },
    connection: [],
    options: [],
    footer: { kind: "setup", onSetup: () => {} },
    ...overrides,
  };
}

function item(overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    id: "mcp:gmail",
    kind: "mcp",
    source: "registry",
    name: "Gmail",
    description: "Search and read Gmail through OpenGeni's reviewed Gmail bridge.",
    category: "communication",
    tags: ["mcp", "oauth2"],
    homepageUrl: "https://developers.google.com/gmail",
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

describe("capability copy", () => {
  test("Gmail and Slack's hosted connection are personal-only", () => {
    expect(personalOnlyCapability(item())).toBe(true);
    expect(
      personalOnlyCapability(item({ mcpUrl: "https://mcp.slack.com/mcp", endpointUrl: null })),
    ).toBe(true);
    expect(personalOnlyCapability(item({ mcpUrl: "https://mcp.linear.app/mcp" }))).toBe(false);
  });

  test("names the outcome instead of the backend bridge", () => {
    expect(capabilityDescription(item())).toBe(
      "Search, read, draft, and send email from your Gmail.",
    );
  });

  test("labels uncurated registry entries as community", () => {
    expect(isCommunityCapability(item())).toBe(false);
    expect(isCommunityCapability(item({ metadata: {} }))).toBe(true);
  });
});

describe("IntegrationPage", () => {
  test("the setup action names the product and runs the adapter's setup", async () => {
    const onSetup = mock(() => {});
    const view = await render(
      <IntegrationPage model={model({ footer: { kind: "setup", onSetup } })} onBack={() => {}} />,
    );
    const connect = buttons(view.container, "Connect Outlook Mail");
    expect(connect).toHaveLength(1);
    await act(async () => connect[0]!.click());
    expect(onSetup).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Built by OpenGeni");
    await view.unmount();
  });

  test("a connected integration keeps Disconnect behind the ⋯ menu and has a back link", async () => {
    const onBack = mock(() => {});
    const view = await render(
      <IntegrationPage
        model={model({
          chip: { label: "Connected", tone: "ok" },
          footer: { kind: "connected", onReconnect: () => {}, onDisconnect: () => {} },
        })}
        onBack={onBack}
      />,
    );
    expect(buttons(view.container, "Disconnect")).toHaveLength(0);
    expect(
      view.container.querySelector('button[aria-label="More actions for Outlook Mail"]'),
    ).not.toBeNull();
    expect(view.container.textContent).toContain("Connected");
    await act(async () => buttons(view.container, "Capabilities")[0]!.click());
    expect(onBack).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  test("tool names sit behind a collapsed Technical details", async () => {
    const view = await render(
      <IntegrationPage
        model={model({ tools: { tools: ["mail_send", "mail_list"] } })}
        onBack={() => {}}
      />,
    );
    expect(view.container.textContent).toContain("Technical details");
    expect(visibleText(view.container)).not.toContain("mail_send");
    await view.unmount();
  });
});

describe("CatalogItemPage", () => {
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

  test("a personal-only sign-in offers no ownership choice and opens the short connect step", async () => {
    const onConnectAccount = mock(() => {});
    const view = await render(
      <CatalogItemPage
        {...common}
        item={item()}
        onAction={() => {}}
        onConnectAccount={onConnectAccount}
      />,
    );
    const text = visibleText(view.container);
    expect(text).not.toContain("Everyone in this workspace");
    expect(text).toContain("By Google");
    expect(text).toContain("Each person connects their own account");
    expect(text).not.toContain("gmailmcp.googleapis.com");
    expect(text).not.toContain("oauth2");
    await act(async () => buttons(view.container, "Connect Gmail")[0]!.click());
    expect(onConnectAccount).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  test("a shared-capable API key connection asks who can use it", async () => {
    const view = await render(
      <CatalogItemPage
        {...common}
        item={item({
          id: "mcp:acme",
          name: "Acme",
          providerDomain: "acme.dev",
          mcpUrl: "https://mcp.acme.dev",
          endpointUrl: "https://mcp.acme.dev",
          authKind: "api_key",
          metadata: {},
        })}
        onAction={() => {}}
      />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain("Who can use it?");
    expect(text).toContain("Everyone in this workspace");
    expect(text).toContain("Community");
    await view.unmount();
  });

  test("an enabled connection disconnects from the ⋯ menu, never an inline button", async () => {
    const view = await render(
      <CatalogItemPage
        {...common}
        workspaceId=""
        item={item({ enabled: true, actions: ["disconnect"] })}
        onAction={() => {}}
      />,
    );
    expect(buttons(view.container, "Disconnect")).toHaveLength(0);
    expect(view.container.querySelector('button[aria-label="More actions for Gmail"]')).not.toBe(
      null,
    );
    expect(view.container.textContent).not.toContain("Manage this capability");
    await view.unmount();
  });
});

describe("ProviderPage", () => {
  test("lists each mode as an outcome row that opens its own page", async () => {
    const openBot = mock(() => {});
    const view = await render(
      <ProviderPage
        name="Slack"
        mark={null}
        description="Chat with OpenGeni in Slack, or let it read and send messages as you."
        onBack={() => {}}
        modes={[
          {
            id: "bot",
            title: "Add OpenGeni to Slack",
            description: "Everyone can mention or message OpenGeni.",
            onOpen: openBot,
          },
          {
            id: "you",
            title: "Connect your own Slack",
            description: "Agents read and send messages as you.",
            status: "Connected",
            onOpen: () => {},
          },
        ]}
      />,
    );
    const row = Array.from(view.container.querySelectorAll("[data-row-action]")).find((node) =>
      node.textContent?.includes("Add OpenGeni to Slack"),
    ) as HTMLElement | undefined;
    expect(row).toBeDefined();
    await act(async () => row!.click());
    expect(openBot).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Connected");
    await view.unmount();
  });
});
