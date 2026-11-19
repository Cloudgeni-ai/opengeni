import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError } from "@opengeni/sdk";
import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  OwnResourceReachWorkspace,
} from "@opengeni/sdk";
// The Radix dialog is a portal; this inline stand-in keeps its contract.
mock.module("@opengeni/react/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    onOpenChange,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => Promise<void | boolean>;
  }) =>
    open ? (
      <div role="dialog">
        <p>{title}</p>
        {description ? <p>{description}</p> : null}
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

// Same for the form dialog: render its fields and submit inline.
mock.module("@opengeni/react/ui/form-dialog", () => ({
  FormDialog: ({
    open,
    title,
    description,
    submitLabel,
    children,
    onOpenChange,
    onSubmit,
  }: {
    open: boolean;
    title: ReactNode;
    description?: ReactNode;
    submitLabel: ReactNode;
    children?: ReactNode;
    onOpenChange: (open: boolean) => void;
    onSubmit: () => Promise<boolean | void>;
  }) =>
    open ? (
      <div role="dialog">
        <p>{title}</p>
        {description ? <p>{description}</p> : null}
        {children}
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const result = await onSubmit();
              if (result !== false) onOpenChange(false);
            })();
          }}
        >
          {submitLabel}
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
      "Yours",
      "Shared",
      "Connected",
      "Needs reconnect",
      "Failed",
    ])
      expect(text).toContain(label);
    expect(text).not.toContain("removed@example.test");
    expect(text).not.toContain("Not connected");
    for (const connection of accounts) {
      expect(text).not.toContain(connection.id);
      expect(text).not.toContain(connection.id.slice(0, 8));
    }
    await view.unmount();
  });

  test("accounts without a readable identity show the connector name without internal IDs", async () => {
    const unnamed = account({
      metadata: { resource: item.mcpUrl, slackUserId: "U_INTERNAL", slackTeamId: "T_INTERNAL" },
    });
    const view = await render(<CatalogConnectedAccounts item={item} connections={[unnamed]} />);
    expect(view.container.textContent).toContain("Slack account");
    expect(view.container.textContent).toContain("Connected");
    for (const internal of [unnamed.id, unnamed.id.slice(0, 8), "U_INTERNAL", "T_INTERNAL"])
      expect(view.container.textContent).not.toContain(internal);
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

    test("your own account from another workspace names where it came from and stays yours to manage", async () => {
      const here = "shared-workspace";
      const personal = "personal-workspace";
      const workspaces = [
        { id: here, name: "Acme", kind: "shared" as const },
        { id: personal, name: "Mia", kind: "personal" as const },
      ];
      const local = account({ workspaceId: here, metadata: { email: "mia@work.test" } });
      const fromPersonal = account({
        workspaceId: personal,
        status: "needs_reauth",
        metadata: { email: "mia@home.test" },
      });
      const fromElsewhere = account({
        workspaceId: "unlisted-workspace",
        metadata: { email: "mia@other.test" },
      });
      const sharedFromElsewhere = account({
        workspaceId: "unlisted-workspace",
        subjectId: null,
        metadata: { email: "team@other.test" },
      });
      // Mia may manage her own accounts here and in her Personal workspace,
      // not in a workspace she can't see.
      const mine = (workspaceId: string) => workspaceId === here || workspaceId === personal;
      const actions = management({ canRemoveOwnIn: mine, canReconnectOwnIn: mine });
      const view = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[local, fromPersonal, fromElsewhere, sharedFromElsewhere]}
          management={actions}
          workspaceId={here}
          workspaces={workspaces}
        />,
      );
      const rows = [...view.container.querySelectorAll("li")].map((row) => row.textContent);
      expect(rows[0]).toContain("mia@work.test");
      expect(rows[0]).not.toContain("From");
      expect(rows[1]).toContain("Yours · From Personal workspace");
      expect(rows[2]).toContain("Yours · From another workspace");
      expect(rows[3]).toContain("Shared · From another workspace");
      expect(rows[3]).not.toContain("Yours");
      // Her own account is removed or reconnected where it was added, so it is
      // offered when she may manage her accounts there. A shared account from
      // another workspace is that workspace's to manage.
      expect(buttons(view.container)).toEqual([
        "Add account",
        "Remove mia@work.test",
        "Reconnect mia@home.test",
        "Remove mia@home.test",
      ]);
      await act(async () =>
        (
          view.container.querySelector(
            'button[aria-label="Remove mia@home.test"]',
          ) as HTMLButtonElement
        ).click(),
      );
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("here and in Personal workspace, where it was added");
      const confirm = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove account",
      )!;
      await act(async () => confirm.click());
      expect(actions.onRemove).toHaveBeenCalledWith(fromPersonal);
      await view.unmount();
    });

    test("a member who may only connect their own accounts can remove them, not sign them in again", async () => {
      // Signing in again needs connections:write, which this member lacks.
      const mine = account({ status: "needs_reauth", metadata: { email: "mine@example.test" } });
      const shared = account({
        subjectId: null,
        status: "needs_reauth",
        metadata: { email: "team@example.test" },
      });
      const view = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[mine, shared]}
          management={management({
            canWrite: false,
            canRemoveOwnIn: () => true,
            canReconnectOwnIn: () => false,
          })}
        />,
      );
      expect(buttons(view.container)).toEqual(["Remove mine@example.test"]);
      await view.unmount();
    });

    describe("naming an account", () => {
      const keyItem = {
        ...item,
        name: "Example MCP",
        authKind: "api_key",
        mcpUrl: "https://mcp.example.test/mcp",
        connectionRef: { providerDomain: "mcp.example.test", kind: "api_key" },
      } as CapabilityCatalogItem;
      const key = (overrides: Partial<ConnectionMetadata> = {}) =>
        account({
          providerDomain: "mcp.example.test",
          kind: "api_key",
          metadata: { mcpUrl: keyItem.mcpUrl, resource: keyItem.mcpUrl },
          ...overrides,
        });
      async function type(input: HTMLInputElement, value: string) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        await act(async () => {
          input.focus();
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          // React DOM loaded before the DOM shim here, so it watches the
          // focused field's keys instead of input events.
          input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
        });
      }

      test("a named key shows its name; unnamed keys say when each was connected", async () => {
        const view = await render(
          <CatalogConnectedAccounts
            item={keyItem}
            connections={[
              key({ label: "Team inbox" }),
              key({ createdAt: "2026-10-01T09:00:00Z" }),
              key({ createdAt: "2026-10-20T09:00:00Z" }),
            ]}
          />,
        );
        const labels = [...view.container.querySelectorAll("li p")].map((node) => node.textContent);
        expect(labels[0]).toBe("Team inbox");
        expect(new Set(labels).size).toBe(3);
        for (const label of labels.slice(1))
          expect(label).toMatch(/^Example MCP account · Connected /);
        await view.unmount();
      });

      test("Rename is offered only where the service doesn't say who the account is", async () => {
        const identified = account({ metadata: { email: "known@example.test" } });
        const unnamed = key();
        const others = key({ subjectId: "someone-else" });
        const view = await render(
          <CatalogConnectedAccounts
            item={keyItem}
            connections={[unnamed, others]}
            management={management({ onRename: mock(async () => true) })}
          />,
        );
        // Your own unnamed key can be named; another person's key is theirs to name.
        const renames = buttons(view.container).filter((label) => label?.startsWith("Rename"));
        expect(renames).toHaveLength(1);
        expect(renames[0]).toStartWith("Rename Example MCP account");
        await view.unmount();
        const oauth = await render(
          <CatalogConnectedAccounts
            item={item}
            connections={[identified]}
            management={management({ onRename: mock(async () => true) })}
          />,
        );
        expect(buttons(oauth.container)).not.toContain("Rename known@example.test");
        await oauth.unmount();
        const withoutRename = await render(
          <CatalogConnectedAccounts
            item={keyItem}
            connections={[unnamed]}
            management={management()}
          />,
        );
        expect(buttons(withoutRename.container).some((label) => label?.startsWith("Rename"))).toBe(
          false,
        );
        await withoutRename.unmount();
      });

      test("Rename saves a trimmed name for exactly that account; blank removes it", async () => {
        const target = key({ label: "Old name" });
        const onRename = mock(async () => true);
        const view = await render(
          <CatalogConnectedAccounts
            item={keyItem}
            connections={[key(), target]}
            management={management({ onRename })}
          />,
        );
        const open = async () =>
          act(async () =>
            (
              view.container.querySelector(
                'button[aria-label="Rename Old name"]',
              ) as HTMLButtonElement
            ).click(),
          );
        const save = async () => {
          const dialog = document.querySelector('[role="dialog"]')!;
          const button = [...dialog.querySelectorAll("button")].find(
            (candidate) => candidate.textContent === "Save name",
          )!;
          await act(async () => button.click());
        };
        await open();
        const dialog = document.querySelector('[role="dialog"]')!;
        expect(dialog.textContent).toContain("Name this account");
        const input = dialog.querySelector("input") as HTMLInputElement;
        expect(input.value).toBe("Old name");
        // Unchanged: nothing to save.
        await save();
        expect(onRename).not.toHaveBeenCalled();
        await open();
        await type(
          document.querySelector('[role="dialog"] input') as HTMLInputElement,
          "  Team inbox ",
        );
        await save();
        expect(onRename).toHaveBeenCalledWith(target, "Team inbox");
        await open();
        await type(document.querySelector('[role="dialog"] input') as HTMLInputElement, "   ");
        await save();
        expect(onRename).toHaveBeenLastCalledWith(target, null);
        await view.unmount();
      });
    });

    test("accounts that would read the same say when each was connected", async () => {
      const first = account({ metadata: {}, createdAt: "2026-10-01T09:00:00Z" });
      const second = account({ metadata: {}, createdAt: "2026-10-20T09:00:00Z" });
      const view = await render(
        <CatalogConnectedAccounts item={item} connections={[first, second]} />,
      );
      const labels = [...view.container.querySelectorAll("li p")].map((node) => node.textContent);
      expect(labels).toHaveLength(2);
      expect(new Set(labels).size).toBe(2);
      for (const label of labels) expect(label).toMatch(/^Slack account · Connected /);
      await view.unmount();
    });

    test("an opaque account that completed OAuth truthfully needs reconnect", async () => {
      const opaque = account({
        status: "needs_reauth",
        metadata: {
          resource: item.mcpUrl,
          tokenEndpoint: "https://provider.example.test/token",
          clientId: "internal-client",
          authorizationServerIssuer: "https://provider.example.test",
          mcpToolsVerification: { status: "verified" },
        },
      });
      const view = await render(
        <CatalogConnectedAccounts item={item} connections={[opaque]} management={management()} />,
      );
      expect(view.container.textContent).toContain("Needs reconnect");
      expect(view.container.textContent).not.toContain("Sign-in not finished");
      expect(view.container.textContent).not.toContain(opaque.id.slice(0, 8));
      expect(buttons(view.container)).toContain("Reconnect Slack account");
      await view.unmount();
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
      expect(view.container.textContent).not.toContain(unfinished.id.slice(0, 8));
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

    test("your own login lists where it works; nobody else's does", async () => {
      const mine = account({ metadata: { email: "mine@example.test", resource: item.mcpUrl } });
      // Only your Personal workspace, where it always works: nothing to choose, no list.
      const personalOnly = account({
        metadata: { email: "personal@example.test", resource: item.mcpUrl },
      });
      const someoneElse = account({
        subjectId: "teammate",
        metadata: { email: "teammate@example.test", resource: item.mcpUrl },
      });
      const shared = account({
        subjectId: null,
        metadata: { email: "team@example.test", resource: item.mcpUrl },
      });
      const personalRow = {
        workspaceId: "personal",
        name: "Personal",
        personal: true,
        current: false,
        on: true,
        alwaysOn: true,
        canChange: false,
      };
      const teamRow = {
        workspaceId: "team",
        name: "Team",
        personal: false,
        current: true,
        on: false,
        alwaysOn: false,
        canChange: true,
      };
      const getOwnResourceReach = mock(
        async (_workspaceId: string, resource: { resourceKind: string; resourceId: string }) => ({
          resourceKind: "connection" as const,
          resourceId: resource.resourceId,
          workspaces: resource.resourceId === mine.id ? [personalRow, teamRow] : [personalRow],
        }),
      );
      const setOwnResourceReach = mock(async (workspaceId: string, request: { on: boolean }) => ({
        workspace: { ...teamRow, workspaceId, on: request.on },
      }));
      const client = { getOwnResourceReach, setOwnResourceReach };
      const view = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[mine, personalOnly, someoneElse, shared]}
          management={management()}
          ownReach={{ client, workspaceId: "team" }}
        />,
      );
      await act(async () => {});
      // Asked only for your own logins, from the workspace being viewed.
      expect(
        getOwnResourceReach.mock.calls.map(([workspaceId, resource]) => [
          workspaceId,
          resource.resourceId,
        ]),
      ).toEqual([
        ["team", mine.id],
        ["team", personalOnly.id],
      ]);
      expect(view.container.textContent).toContain("Where it works");
      const switches = [...view.container.querySelectorAll('[role="switch"]')];
      expect(switches.map((entry) => entry.getAttribute("aria-label"))).toEqual([
        "Use mine@example.test in Personal",
        "Use mine@example.test in Team",
      ]);
      expect(switches.map((entry) => entry.getAttribute("aria-checked"))).toEqual([
        "true",
        "false",
      ]);
      // Your Personal workspace can't be turned off; the switch says why.
      expect(switches[0]?.getAttribute("aria-disabled")).toBe("true");
      await act(async () => (switches[0] as HTMLButtonElement).click());
      expect(setOwnResourceReach).not.toHaveBeenCalled();
      await act(async () => (switches[1] as HTMLButtonElement).click());
      expect(setOwnResourceReach).toHaveBeenCalledWith("team", {
        resourceKind: "connection",
        resourceId: mine.id,
        on: true,
      });
      expect(
        view.container
          .querySelector('[aria-label="Use mine@example.test in Team"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      await view.unmount();
    });

    test("your own login where the connector isn't on reads as off, and one switch turns both on", async () => {
      const mine = account({ metadata: { email: "mine@example.test", mcpUrl: item.mcpUrl } });
      const row = (
        overrides: Pick<OwnResourceReachWorkspace, "workspaceId" | "name"> &
          Partial<OwnResourceReachWorkspace>,
      ): OwnResourceReachWorkspace => ({
        personal: false,
        current: false,
        on: true,
        alwaysOn: false,
        canChange: true,
        ...overrides,
      });
      const getOwnResourceReach = mock(
        async (_workspaceId: string, resource: { resourceKind: string; resourceId: string }) => ({
          resourceKind: "connection" as const,
          resourceId: resource.resourceId,
          workspaces: [
            row({ workspaceId: "personal", name: "Personal", personal: true, alwaysOn: true }),
            // On through a standing grant, but Slack isn't on in either.
            row({ workspaceId: "design", name: "Design", connectorOff: true }),
            row({ workspaceId: "team", name: "Team", current: true, connectorOff: true }),
          ],
        }),
      );
      const setOwnResourceReach = mock(
        async (
          workspaceId: string,
          request: { resourceKind: string; resourceId: string; on: boolean },
        ) => {
          if (workspaceId === "design")
            throw new OpenGeniApiError(
              403,
              JSON.stringify({
                error: {
                  code: "forbidden",
                  message:
                    "Only an admin can turn Slack on in this workspace. Ask one to turn it on, then use your login here.",
                  details: { code: "own_login_connector_needs_admin" },
                },
              }),
              { mutation: true },
            );
          return {
            workspace: row({ workspaceId, name: "Team", on: request.on }),
          };
        },
      );
      const turnedOn = mock((_workspaceId: string) => undefined);
      const view = await render(
        <CatalogConnectedAccounts
          item={{ ...item, enabled: false }}
          connections={[mine]}
          management={management()}
          ownReach={{
            client: { getOwnResourceReach, setOwnResourceReach },
            workspaceId: "team",
            onConnectorTurnedOn: turnedOn,
          }}
        />,
      );
      await act(async () => {});
      const switches = () =>
        Object.fromEntries(
          [...view.container.querySelectorAll('[role="switch"]')].map((entry) => [
            entry.getAttribute("aria-label"),
            entry.getAttribute("aria-checked"),
          ]),
        );
      // "On" would read as usable: nothing there uses it until Slack is on.
      expect(switches()).toEqual({
        "Use mine@example.test in Personal": "true",
        "Use mine@example.test in Design": "false",
        "Use mine@example.test in Team": "false",
      });
      expect(view.container.textContent).toContain(
        "This workspace. Not used here yet. Turning it on turns Slack on here too",
      );
      expect(view.container.textContent).not.toContain("Use it here");

      // One switch: the server turns Slack on here with the login.
      const toggle = (label: string) =>
        act(async () =>
          (view.container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click(),
        );
      await toggle("Use mine@example.test in Team");
      expect(setOwnResourceReach).toHaveBeenCalledWith("team", {
        resourceKind: "connection",
        resourceId: mine.id,
        on: true,
      });
      expect(switches()["Use mine@example.test in Team"]).toBe("true");
      expect(turnedOn.mock.calls).toEqual([["team"]]);

      // Where only an admin may turn Slack on, it says so and nothing moves.
      await toggle("Use mine@example.test in Design");
      expect(switches()["Use mine@example.test in Design"]).toBe("false");
      expect(view.container.textContent).toContain(
        "Only an admin can turn Slack on in this workspace. Ask one to turn it on, then use your login here.",
      );
      expect(turnedOn).toHaveBeenCalledTimes(1);
      await view.unmount();
    });

    test("a service that can't identify accounts offers no Add, and says why", async () => {
      const mine = account({ accountIdentity: "single", metadata: { email: "me@example.test" } });
      const view = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[mine]}
          management={management({ addOwnership: "personal" })}
        />,
      );
      expect(buttons(view.container)).toEqual(["Remove me@example.test"]);
      expect(view.container.textContent).toContain(
        "This service doesn't tell us which account you signed in with, so you can connect one account. Disconnect it to use a different one.",
      );
      await view.unmount();

      // Someone else's personal account is invisible to the rule.
      const theirs = account({ subjectId: "someone-else", accountIdentity: "single" });
      const shared = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[theirs]}
          management={management({ addOwnership: "workspace" })}
        />,
      );
      expect(buttons(shared.container)).toEqual(["Add account"]);
      await shared.unmount();
    });

    test("an account from before identity is reconnected once before another is added", async () => {
      const legacy = account({
        accountIdentity: "reconnect",
        metadata: { email: "me@example.test" },
      });
      const actions = management({ addOwnership: "personal" });
      const view = await render(
        <CatalogConnectedAccounts item={item} connections={[legacy]} management={actions} />,
      );
      expect(buttons(view.container)).toEqual([
        "Reconnect me@example.test",
        "Remove me@example.test",
      ]);
      expect(view.container.textContent).toContain(
        "Reconnect your existing account once, then add another.",
      );
      await view.unmount();

      const verified = await render(
        <CatalogConnectedAccounts
          item={item}
          connections={[{ ...legacy, accountIdentity: "verified" }]}
          management={actions}
        />,
      );
      expect(buttons(verified.container)).toEqual(["Add account", "Remove me@example.test"]);
      await verified.unmount();
    });
  });
});
