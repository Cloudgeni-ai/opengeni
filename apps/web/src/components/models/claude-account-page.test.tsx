import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
let createRoot: typeof import("react-dom/client").createRoot;
let useClaude: typeof import("./use-claude-subscriptions").useClaudeSubscriptions;
let ClaudeAccountPage: typeof import("./claude-subscription-models").ClaudeAccountPage;
let pool: ReturnType<typeof useClaude>, root: Root, container: HTMLDivElement;
const id = "10000000-0000-4000-8000-000000000001",
  workspaceId = "10000000-0000-4000-8000-000000000002";
beforeAll(async () => {
  GlobalRegistrator.register({ url: "https://console.example.test" });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  ({ useClaudeSubscriptions: useClaude } = await import("./use-claude-subscriptions"));
  ({ ClaudeAccountPage } = await import("./claude-subscription-models"));
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());
const account = {
  id,
  subject: "fixture-provider-account",
  email: "account@example.test",
  label: null,
  scope: "workspace",
  version: 1,
  allocatorEnabled: true,
  allocatorVersion: 1,
  status: "active",
  active: true,
  lastError: null,
  expiresAt: null,
};
const baseUsage = {
  connected: true,
  credentialVersion: 1,
  windows: [],
  observedAt: null,
  source: null,
  refreshStatus: "not_checked",
  refreshCheckedAt: null,
};
const places = {
  scopeName: "Example workspace",
  organizationName: "Example organization",
  scope: {
    organization: "Shared",
    everyone: "Everyone",
    selected: "Selected workspaces",
    none: "No workspaces",
    workspace: "This workspace",
    user: "Only you",
  },
  openAccount: () => {},
  openConnect: () => {},
  openAccess: () => {},
  backToList: () => {},
};

test("Enable account shows Enabled or Disabled and still maps to the allocator", async () => {
  let enabled = true;
  const calls: unknown[] = [];
  const list = async () => ({
    accounts: [{ ...account, allocatorEnabled: enabled, allocatorVersion: enabled ? 1 : 2 }],
    activeAccountId: id,
    source: "workspace",
    settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: id },
  });
  const client = {
    listClaudeSubscriptionAccounts: list,
    getClaudeSubscriptionAccountUsage: async () => baseUsage,
    getModelConnectionAccess: async () => null,
    setClaudeSubscriptionAccountAllocator: async (...args: unknown[]) => {
      calls.push(args);
      enabled = false;
    },
  };
  function Harness({ canManage }: { canManage: boolean }) {
    pool = useClaude({
      client: client as unknown as OpenGeniBrowserClient,
      canManage,
      workspaceId,
    });
    return createElement(ClaudeAccountPage, { claude: pool, accountId: id, places });
  }
  await act(async () => root.render(createElement(Harness, { canManage: true })));
  const toggle = container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Enable account@example.test"]',
  )!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  const text = () => container.textContent ?? "";
  expect(text()).toContain("Enable account");
  expect(text()).toContain(
    "Allow this account to be used for new work. Turning it off won’t interrupt running work.",
  );
  expect(text()).toContain("Enabled");
  expect(text()).not.toContain("Use for new work");
  const badge = () =>
    container.querySelector('[data-slot="detail-page-header"] [data-slot="status-badge"]');
  // A healthy, enabled account carries no header status.
  expect(badge()).toBeNull();
  await act(async () => toggle.click());
  expect(calls).toEqual([[workspaceId, id, { enabled: false, expectedVersion: 1 }]]);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(badge()?.textContent).toBe("Disabled");
  expect(text()).not.toContain("Paused");
  // People who can't manage the account read the same words as a fact.
  await act(async () => root.render(createElement(Harness, { canManage: false })));
  expect(container.querySelector('button[role="switch"]')).toBeNull();
  expect(text()).toContain("AccountDisabled");
  expect(text()).not.toContain("Paused");
});
for (const [organization, poll] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
]) {
  test(
    "same-version reconnect receipt reloads account metadata (organization=" +
      organization +
      ", poll=" +
      poll +
      ")",
    async () => {
      let reads = 0,
        reconnect = false;
      const list = async () => {
        reads++;
        return {
          accounts: [
            {
              ...account,
              scope: organization ? "organization" : "workspace",
              status: reconnect ? "needs_relogin" : "active",
              lastError: reconnect ? "Sign in to Claude again." : null,
            },
          ],
          activeAccountId: id,
          source: organization ? "organization" : "workspace",
          settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: id },
        };
      };
      const read = async () => ({
        ...baseUsage,
        refreshStatus: reconnect ? "reconnect" : "not_checked",
      });
      const refresh = async () => {
        reconnect = true;
        return read();
      };
      const client = {
        listClaudeSubscriptionAccounts: list,
        listOrganizationClaudeSubscriptionAccounts: list,
        getClaudeSubscriptionAccountUsage: read,
        getOrganizationClaudeSubscriptionAccountUsage: read,
        refreshClaudeSubscriptionAccountUsage: refresh,
        refreshOrganizationClaudeSubscriptionAccountUsage: refresh,
        getModelConnectionAccess: async () => null,
      };
      function Harness() {
        pool = useClaude({
          client: client as unknown as OpenGeniBrowserClient,
          canManage: true,
          ...(organization ? { organizationId: workspaceId } : { workspaceId }),
        });
        return createElement(ClaudeAccountPage, { claude: pool, accountId: id, places });
      }
      await act(async () => root.render(createElement(Harness)));
      expect(reads).toBe(1);
      expect(pool.accounts[0]!.status).toBe("active");
      const refreshButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Check usage now"]',
      )!;
      await act(async () => {
        if (poll) {
          reconnect = true;
          document.dispatchEvent(new Event("visibilitychange"));
        } else refreshButton.click();
      });
      expect(container.textContent).toContain("Claude no longer accepts this token.");
      expect(container.querySelector('[data-slot="notice"]')).not.toBeNull();
      expect(reads).toBe(2);
      expect(pool.accounts[0]!.status).toBe("needs_relogin");
      expect(container.textContent).toContain("Sign in to Claude again");
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(reads).toBe(2);
    },
  );
}

for (const [outcome, changeScope] of [
  ["success", true],
  ["failure", true],
  ["success", false],
  ["failure", false],
]) {
  test(
    "late " +
      outcome +
      " disconnect keeps navigation in the current page (changeScope=" +
      changeScope +
      ")",
    async () => {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const pending = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let disconnects = 0,
        disconnected = false;
      const navigations: string[] = [];
      const client = {
        listClaudeSubscriptionAccounts: async (scope: string) => ({
          accounts: disconnected && scope === id ? [] : [{ ...account, id: scope, label: scope }],
          activeAccountId: scope,
          source: "workspace",
          settings: {
            rotationEnabled: false,
            rotationStrategy: "sharded",
            activeCredentialId: scope,
          },
        }),
        getClaudeSubscriptionAccountUsage: async () => baseUsage,
        getModelConnectionAccess: async () => null,
        disconnectClaudeSubscriptionAccount: async () => {
          disconnects++;
          await pending;
          disconnected = true;
        },
      };
      function Harness({ identity }: { identity: string }) {
        const current = useClaude({
          client: client as unknown as OpenGeniBrowserClient,
          canManage: true,
          workspaceId: identity,
        });
        return createElement(ClaudeAccountPage, {
          claude: current,
          accountId: identity,
          places: { ...places, backToList: () => navigations.push(identity) },
        });
      }
      await act(async () => root.render(createElement(Harness, { identity: id, key: id })));
      const more = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="More actions"]',
      )!;
      await act(async () =>
        more.dispatchEvent(
          new window.PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            ctrlKey: false,
            pointerType: "mouse",
          }),
        ),
      );
      const menuItem = document.querySelector<HTMLElement>(
        '[role="menuitem"][data-variant="destructive"]',
      )!;
      expect(menuItem).not.toBeNull();
      await act(async () => menuItem.click());
      const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!;
      expect(form).not.toBeNull();
      await act(async () =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(disconnects).toBe(1);
      const next = "10000000-0000-4000-8000-000000000003";
      if (changeScope) {
        await act(async () => root.render(createElement(Harness, { identity: next, key: next })));
        expect(container.querySelector("h1")?.textContent).toBe(next);
      }
      await act(async () => {
        if (outcome === "success") resolve();
        else reject(new Error("Fixture disconnect failed"));
        await Promise.resolve();
      });
      expect(navigations).toEqual(!changeScope && outcome === "success" ? [id] : []);
    },
  );
}
