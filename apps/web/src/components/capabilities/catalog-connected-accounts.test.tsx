import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
// The Radix dialog is a portal; this inline stand-in keeps its contract.
mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    confirmLabel,
    onOpenChange,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    confirmLabel: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => Promise<void | boolean>;
  }) =>
    open ? (
      <div role="dialog">
        <p>{title}</p>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const result = await onConfirm();
              if (result !== false) onOpenChange(false);
            })();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

const { CatalogConnectedAccounts } = await import("./catalog-connected-accounts");
const { catalogAddAccountOwnership } = await import("./catalog-item-page");
type CatalogConnectedAccountsManagement =
  import("./catalog-connected-accounts").CatalogConnectedAccountsManagement;

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
      // A removed account is gone, not a dead "Not connected" row.
      account({ status: "revoked", metadata: { email: "removed@example.test" } }),
    ];
    const view = await render(<CatalogConnectedAccounts item={item} connections={accounts} />);
    const text = view.container.textContent;
    expect(view.container.querySelectorAll("li")).toHaveLength(3);
    for (const label of [
      "member@example.test · Community",
      "member · Team",
      "Only me",
      "This workspace",
      "Connected",
      "Needs reconnect",
      "Failed",
    ])
      expect(text).toContain(label);
    expect(text).not.toContain("removed@example.test");
    expect(text).not.toContain("Not connected");
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

  describe("per-account management", () => {
    function management(
      overrides: Partial<CatalogConnectedAccountsManagement> = {},
    ): CatalogConnectedAccountsManagement & {
      onReconnect: ReturnType<typeof mock>;
      onRemove: ReturnType<typeof mock>;
      onAdd: ReturnType<typeof mock>;
    } {
      return {
        viewerSubjectId: "owner",
        canWrite: true,
        onReconnect: mock(() => {}),
        onRemove: mock(async () => true),
        onAdd: mock(() => {}),
        ...overrides,
      } as never;
    }
    const buttons = (root: ParentNode) =>
      [...root.querySelectorAll("button")].map(
        (button) => button.getAttribute("aria-label") ?? button.textContent?.trim(),
      );

    test("Reconnect appears only on an unhealthy OAuth account; Remove on every account the viewer owns", async () => {
      const healthy = account({ metadata: { email: "ok@example.test" } });
      const broken = account({
        status: "needs_reauth",
        metadata: { email: "broken@example.test" },
      });
      const shared = account({ subjectId: null, metadata: { email: "team@example.test" } });
      const keyAccount = account({
        kind: "api_key",
        status: "error",
        metadata: { email: "key@example.test" },
      });
      const actions = management();
      const view = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[healthy, broken, shared]}
          management={actions}
        />,
      );
      expect(buttons(view.container)).toEqual([
        "Add account",
        "Remove ok@example.test",
        "Reconnect broken@example.test",
        "Remove broken@example.test",
        "Remove team@example.test",
      ]);
      await act(async () =>
        (
          view.container.querySelector(
            'button[aria-label="Reconnect broken@example.test"]',
          ) as HTMLButtonElement
        ).click(),
      );
      expect(actions.onReconnect).toHaveBeenCalledWith(broken);
      await act(async () => (view.container.querySelector("button") as HTMLButtonElement).click());
      expect(actions.onAdd).toHaveBeenCalledTimes(1);
      await view.unmount();

      // An API-key account is repaired by pasting a new key, not by sign-in.
      const posthog = {
        ...item,
        name: "PostHog",
        authKind: "api_key",
        mcpUrl: "https://mcp.posthog.com/mcp",
        connectionRef: { providerDomain: "mcp.posthog.com", kind: "api_key" },
      } as CapabilityCatalogItem;
      const keyView = await render(
        <CatalogConnectedAccounts
          item={posthog}
          connections={[{ ...keyAccount, providerDomain: "mcp.posthog.com" }]}
          management={management()}
        />,
      );
      expect(buttons(keyView.container)).toEqual(["Add account", "Remove key@example.test"]);
      await keyView.unmount();
    });

    test("Remove asks for confirmation, then disconnects exactly that account", async () => {
      const target = account({ metadata: { email: "gone@example.test" } });
      const actions = management();
      const view = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[account(), target]}
          management={actions}
        />,
      );
      await act(async () =>
        (
          view.container.querySelector(
            'button[aria-label="Remove gone@example.test"]',
          ) as HTMLButtonElement
        ).click(),
      );
      // Nothing is removed until the person confirms.
      expect(actions.onRemove).not.toHaveBeenCalled();
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Remove gone@example.test?");
      const confirm = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove account",
      )!;
      await act(async () => confirm.click());
      expect(actions.onRemove).toHaveBeenCalledTimes(1);
      expect(actions.onRemove).toHaveBeenCalledWith(target);
      await view.unmount();
    });

    test("without permission nothing is removable, and another person's account never is", async () => {
      const others = account({
        subjectId: "someone-else",
        metadata: { email: "other@example.test" },
      });
      const shared = account({ subjectId: null, status: "needs_reauth" });
      const mine = account({ status: "needs_reauth", metadata: { email: "mine@example.test" } });
      const readOnly = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[shared, mine]}
          management={management({ canWrite: false })}
        />,
      );
      expect(buttons(readOnly.container)).toEqual([]);
      await readOnly.unmount();

      const writer = await render(
        <CatalogConnectedAccounts item={item} connections={[others]} management={management()} />,
      );
      expect(writer.container.textContent).toContain("other@example.test");
      expect(buttons(writer.container)).toEqual(["Add account"]);
      await writer.unmount();

      const signedOut = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[mine]}
          management={management({ viewerSubjectId: null })}
        />,
      );
      expect(buttons(signedOut.container)).toEqual(["Add account"]);
      await signedOut.unmount();
    });

    test("an account whose sign-in never finished says so and can be removed", async () => {
      const unfinished = account({
        status: "needs_reauth",
        metadata: { mcpUrl: item.mcpUrl, resource: item.mcpUrl },
      });
      const view = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[unfinished]}
          management={management()}
        />,
      );
      expect(view.container.textContent).toContain("Sign-in not finished");
      expect(view.container.textContent).toContain(`Account ${unfinished.id.slice(0, 8)}`);
      expect(buttons(view.container)).toContain("Remove Slack account");
      await view.unmount();
    });

    test("Add account is offered only where a further account joins rather than replaces", () => {
      const enabled = { ...item, enabled: true };
      expect(catalogAddAccountOwnership(enabled, false)).toBe("personal");
      expect(
        catalogAddAccountOwnership(
          {
            ...enabled,
            connectionRef: {
              providerDomain: "mcp.slack.com",
              kind: "oauth2",
              accountSelection: "all_eligible",
            },
          },
          false,
        ),
      ).toBe("workspace");
      for (const blocked of [
        { ...enabled, enabled: false },
        {
          ...enabled,
          connectionRef: { providerDomain: "mcp.slack.com", kind: "oauth2", connectionId: "pin" },
        },
        {
          ...enabled,
          connectionRef: {
            providerDomain: "mcp.slack.com",
            kind: "api_key",
            subjectScope: "subject",
          },
        },
        { ...enabled, connectionRef: { ...item.connectionRef!, authoritySource: "host" } },
        { ...enabled, connectionRef: null },
      ] as CapabilityCatalogItem[])
        expect(catalogAddAccountOwnership(blocked, false)).toBeNull();
    });
  });
});
