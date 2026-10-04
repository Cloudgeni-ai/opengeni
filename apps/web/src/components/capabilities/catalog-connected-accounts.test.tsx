import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import { CatalogConnectedAccounts } from "./catalog-connected-accounts";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

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

const item = {
  id: "mcp:slack",
  kind: "mcp",
  name: "Slack",
  surfaceType: "mcp",
  authKind: "oauth2",
  mcpUrl: "https://mcp.slack.com/mcp",
  connectionRef: {
    providerDomain: "mcp.slack.com",
    kind: "oauth2",
    accountSelection: "all_eligible",
    subjectScope: "subject",
  },
} as CapabilityCatalogItem;
function account(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    authorityId: crypto.randomUUID(),
    subjectId: "owner",
    providerDomain: "mcp.slack.com",
    kind: "oauth2",
    status: "active",
    metadata: { email: "member@example.test", slackTeamName: "Community", resource: item.mcpUrl },
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    createdBySubjectId: "owner",
    updatedBySubjectId: "owner",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    ...overrides,
  };
}

describe("catalog connected accounts", () => {
  test("saved accounts remain visible when a connector is disabled", async () => {
    const view = await render(
      <CatalogConnectedAccounts
        item={{ ...item, enabled: false, providerDomain: "mcp.slack.com", connectionRef: null }}
        connections={[account()]}
      />,
    );
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    expect(view.container.textContent).toContain("Your saved accounts remain connected");
    expect(view.container.textContent).not.toContain("No accounts connected");
    await view.unmount();
  });

  test("OAuth audiences may differ from the saved MCP transport endpoint", async () => {
    const view = await render(
      <CatalogConnectedAccounts
        item={item}
        connections={[
          account({
            metadata: {
              resource: "urn:slack:workspace",
              mcpUrl: item.mcpUrl,
              email: "member@example.test",
            },
          }),
        ]}
      />,
    );
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    await view.unmount();
  });
  test("lists all matching personal and shared accounts, including those needing reconnection", async () => {
    const accounts = [
      account(),
      account({
        subjectId: null,
        status: "needs_reauth",
        metadata: { slackUserName: "member", slackTeamName: "Team" },
      }),
      account({ status: "error" }),
      account({ status: "revoked" }),
    ];
    const view = await render(<CatalogConnectedAccounts item={item} connections={accounts} />);
    const text = view.container.textContent;
    expect(view.container.querySelectorAll("li")).toHaveLength(4);
    for (const label of [
      "member@example.test · Community",
      "member · Team",
      "Only me",
      "This workspace",
      "Connected",
      "Needs reconnect",
      "Failed",
      "Not connected",
    ])
      expect(text).toContain(label);
    expect(text).toContain(`Account ${accounts[0]!.id.slice(0, 8)}`);
    await view.unmount();
  });

  test("the same section supports API-key MCP accounts such as PostHog", async () => {
    const posthog = {
      ...item,
      name: "PostHog",
      authKind: "api_key",
      mcpUrl: "https://mcp.posthog.com/mcp",
      connectionRef: { providerDomain: "mcp.posthog.com", kind: "api_key" },
    } as CapabilityCatalogItem;
    const view = await render(
      <CatalogConnectedAccounts
        item={posthog}
        connections={[
          account({
            providerDomain: "mcp.posthog.com",
            kind: "api_key",
            subjectId: null,
            metadata: { accountName: "Product analytics" },
          }),
        ]}
      />,
    );
    expect(view.container.textContent).toContain("Product analytics");
    expect(
      view.container.querySelector('ul[aria-label="PostHog connected accounts"]'),
    ).not.toBeNull();
    await view.unmount();
  });

  test("does not mix bot grants, other endpoints, hidden personal authorities, or exact pins", async () => {
    const visible = account();
    const connections = [
      visible,
      account({ kind: "app_install" }),
      account({ providerDomain: "other.example.test" }),
      account({
        metadata: {
          resource: "https://mcp.slack.com/other",
          mcpUrl: "https://mcp.slack.com/other",
        },
      }),
      account({ metadata: { mcpUrl: "https://mcp.slack.com/other" } }),
      account({ authorityId: undefined }),
    ];
    for (const ref of [
      item.connectionRef,
      { ...item.connectionRef!, resource: `${item.mcpUrl}/` },
      { ...item.connectionRef!, connectionId: visible.id },
    ]) {
      const view = await render(
        <CatalogConnectedAccounts
          item={{ ...item, connectionRef: ref }}
          connections={connections}
        />,
      );
      expect(view.container.querySelectorAll("li")).toHaveLength(1);
      await view.unmount();
    }
    const host = await render(
      <CatalogConnectedAccounts
        item={{ ...item, connectionRef: { ...item.connectionRef!, authoritySource: "host" } }}
        connections={[visible]}
      />,
    );
    expect(host.container.textContent).toBe("");
    await host.unmount();
  });

  test("loading, denied access and failed refresh cannot masquerade as empty accounts", async () => {
    for (const state of ["loading", "denied", "failed"] as const) {
      const retry = mock(() => {});
      const view = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={state === "loading" ? null : [account()]}
          accessDenied={state === "denied"}
          loadFailed={state === "failed"}
          onRetry={retry}
        />,
      );
      expect(view.container.textContent).not.toContain("No accounts connected");
      expect(view.container.textContent).not.toContain("member@example.test");
      expect(view.container.textContent).toContain(
        state === "loading"
          ? "Loading connected accounts"
          : state === "denied"
            ? "don't have permission"
            : "Couldn't load connected accounts",
      );
      if (state === "failed") {
        await act(async () => view.container.querySelector("button")!.click());
        expect(retry).toHaveBeenCalledTimes(1);
      }
      await view.unmount();
    }
    const empty = await render(<CatalogConnectedAccounts item={item} connections={[]} />);
    expect(empty.container.textContent).toContain("No accounts connected");
    await empty.unmount();
  });
});
