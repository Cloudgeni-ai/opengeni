import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CodexOverviewResponse, WorkspaceCodexSubscriptionSource } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CodexSourceSettings, codexSourceSummary } from "./codex-source-settings";
import { CodexSubscriptionsCardWithClient } from "./codex-connection";
import { SuperGrokSubscriptionsCardWithClient } from "./supergrok-connection";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const source: WorkspaceCodexSubscriptionSource = {
  accountId: "organization-a",
  workspaceId: "workspace-a",
  workspaceKind: "shared",
  mode: "automatic",
  effectiveSource: "organization",
  workspaceAvailable: false,
  organizationAvailable: true,
};

for (const outcome of ["weekly", "empty", "error"] as const) {
  test(`Codex waits for initial overview without flashing cached limits: ${outcome}`, async () => {
    let resolve!: (value: CodexOverviewResponse) => void;
    let reject!: (error: Error) => void;
    const overview = new Promise<CodexOverviewResponse>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const window = {
      used: 90,
      limit: 100,
      remaining: 10,
      percent: 90,
      resetAt: null,
      resetAfterSeconds: null,
      limitWindowSeconds: 18000,
    };
    const client = {
      listCodexAccounts: async () => ({
        accounts: [
          {
            id: "subscription",
            source: "organization",
            label: "Team plan",
            status: "active",
            active: true,
            allocatorEnabled: true,
            fiveHour: window,
            weekly: window,
          },
        ],
        activeAccountId: "subscription",
        source,
        settings: { rotationEnabled: false },
      }),
      codexOverview: () => overview,
    } as unknown as OpenGeniBrowserClient;
    const route = createRootRoute({
      component: () => (
        <CodexSubscriptionsCardWithClient client={client} workspaceId="workspace-a" canManage />
      ),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      expect(container.textContent).toContain("Team plan");
      expect(container.querySelector('[aria-label="Checking usage"]')).not.toBeNull();
      expect(container.textContent).not.toContain("remaining");
      await act(async () => {
        if (outcome === "error") reject(new Error("Provider unavailable"));
        else
          resolve({
            accounts: {
              subscription: {
                accountId: "subscription",
                usage: {
                  source: "provider",
                  fetchedAt: null,
                  stale: false,
                  error: null,
                  value:
                    outcome === "empty"
                      ? null
                      : {
                          status: "ok",
                          planType: null,
                          fiveHour: null,
                          weekly: {
                            ...window,
                            used: 25,
                            remaining: 75,
                            percent: 25,
                            limitWindowSeconds: 604800,
                          },
                          limitReached: false,
                          fetchedAt: new Date().toISOString(),
                        },
                },
                resetCredits: {
                  source: "none",
                  fetchedAt: null,
                  stale: false,
                  error: null,
                  detailState: "unknown",
                  detailsComplete: false,
                  availableCount: null,
                  credits: [],
                },
                canRedeem: false,
                canResumeRedemption: false,
                redemptions: [],
                redemptionAccess: { ownership: "unowned", canClaimUnownedViaReconnect: false },
              },
            },
          });
      });
      expect(container.querySelector('[aria-label="Checking usage"]')).toBeNull();
      expect(container.textContent).not.toContain("10% remaining");
      if (outcome === "weekly") {
        expect(container.textContent).toContain("75% remaining");
        expect(container.textContent).not.toContain("5h");
      } else {
        expect(container.textContent).toContain(
          outcome === "error" ? "Usage unavailable" : "Usage not reported",
        );
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

describe("Codex subscription source", () => {
  test("reports the effective source, including disconnected and disabled states", () => {
    expect(codexSourceSummary(source)).toBe("Using organization subscriptions");
    expect(codexSourceSummary({ ...source, organizationAvailable: false })).toBe(
      "No organization subscription connected",
    );
    expect(
      codexSourceSummary({ ...source, effectiveSource: "workspace", workspaceAvailable: true }),
    ).toBe("Using workspace subscriptions");
    expect(codexSourceSummary({ ...source, effectiveSource: "workspace" })).toBe(
      "No workspace subscription connected",
    );
    expect(codexSourceSummary({ ...source, effectiveSource: "disabled" })).toBe(
      "Codex is turned off",
    );
  });

  test("shows current source first and changes policy only after an explicit selection", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const change = mock(() => {});
    try {
      await act(async () =>
        root.render(<CodexSourceSettings source={source} busy={false} onChange={change} />),
      );
      expect(container.textContent).toContain("Using organization subscriptions");
      expect(container.querySelector("select")).toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      const select = container.querySelector<HTMLSelectElement>("select")!;
      expect(select.value).toBe("automatic");
      expect(container.textContent).toContain("Changes apply to new work.");
      expect(container.textContent).toContain(
        "Work already in progress keeps its subscription source.",
      );
      expect(change).not.toHaveBeenCalled();
      await act(async () => {
        select.value = "workspace";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(change).toHaveBeenCalledWith("workspace");
      await act(async () =>
        root.render(
          <CodexSourceSettings
            source={{ ...source, mode: "workspace", effectiveSource: "workspace" }}
            busy
            onChange={change}
          />,
        ),
      );
      expect(container.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
      expect(container.textContent).toContain("No workspace subscription connected");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

for (const provider of ["Codex", "SuperGrok"] as const) {
  test(`${provider} distinguishes a failed connection read from an empty account list and retries`, async () => {
    let failed = true;
    const read = mock(async () => {
      if (failed) throw new Error("Connection request failed");
      return { accounts: [], activeAccountId: null, settings: { rotationEnabled: false } };
    });
    const client = {
      listCodexAccounts: read,
      listSuperGrokAccounts: read,
    } as unknown as OpenGeniBrowserClient;
    const Card =
      provider === "Codex"
        ? CodexSubscriptionsCardWithClient
        : SuperGrokSubscriptionsCardWithClient;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<Card client={client} workspaceId="workspace-a" canManage />),
      );
      expect(container.querySelector("summary")?.textContent).toContain("Unavailable");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Connection request failed",
      );
      expect(container.textContent).not.toContain("Connect account");
      failed = false;
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry",
      )!;
      await act(async () => retry.click());
      expect(read).toHaveBeenCalledTimes(2);
      expect(container.querySelector("summary")?.textContent).toContain("Not connected");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain("Connect account");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

for (const mode of ["automatic", "organization", "disabled"] as const) {
  for (const canManage of [true, false]) {
    test(`workspace connect is independent of ${mode} source (canManage: ${canManage})`, async () => {
      const connect = mock(async () => {
        // Stop before opening an external authentication window or starting a poll.
        throw new Error("Device authorization unavailable in fixture");
      });
      const changeSource = mock(async () => {});
      const client = {
        listCodexAccounts: async () => ({
          accounts: [],
          activeAccountId: null,
          source: {
            ...source,
            mode,
            effectiveSource: mode === "disabled" ? "disabled" : "organization",
          },
          settings: { rotationEnabled: false },
        }),
        codexConnectStart: connect,
        requestJson: changeSource,
      } as unknown as OpenGeniBrowserClient;
      const route = createRootRoute({
        component: () => (
          <CodexSubscriptionsCardWithClient
            client={client}
            workspaceId="workspace-a"
            canManage={canManage}
          />
        ),
      });
      const router = createRouter({
        routeTree: route,
        history: createMemoryHistory({ initialEntries: ["/"] }),
      });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          await router.load();
          root.render(<RouterProvider router={router} />);
        });
        const button = container.querySelector<HTMLButtonElement>(
          '[data-analytics-action="connect_codex"]',
        );
        if (canManage) {
          expect(button?.textContent).toContain("Connect workspace account");
          expect(button?.disabled).toBe(false);
          expect(container.textContent).toContain(
            mode === "disabled"
              ? "Connecting an account keeps Codex turned off."
              : mode === "automatic"
                ? "Connect a workspace account to use it for new work."
                : "Organization subscriptions remain selected.",
          );
          await act(async () => button!.click());
          expect(connect).toHaveBeenCalledWith("workspace-a");
          expect(changeSource).not.toHaveBeenCalled();
        } else {
          expect(button).toBeNull();
          expect(connect).not.toHaveBeenCalled();
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }
}

for (const includeSource of [true, false]) {
  test(`inherited Codex accounts do not request workspace access settings (source metadata: ${includeSource})`, async () => {
    const requestJson = mock(async () => {
      throw new Error("Inherited policy must not use a workspace endpoint");
    });
    const client = {
      listCodexAccounts: async () => ({
        accounts: [
          {
            id: "subscription",
            source: "organization",
            label: "Team plan",
            status: "active",
            active: true,
            allocatorEnabled: true,
          },
        ],
        activeAccountId: "subscription",
        ...(includeSource ? { source } : {}),
        settings: { rotationEnabled: false },
      }),
      getCodexOverview: async () => ({ accounts: {} }),
      requestJson,
    } as unknown as OpenGeniBrowserClient;
    const route = createRootRoute({
      component: () => (
        <CodexSubscriptionsCardWithClient client={client} workspaceId="workspace-a" canManage />
      ),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      const details = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Team plan",
      );
      expect(details).toBeDefined();
      expect(
        container.querySelector('[data-analytics-action="connect_codex"]')?.textContent,
      ).toContain(includeSource ? "Connect workspace account" : "Connect another account");
      await act(async () => details!.click());
      expect(container.textContent).not.toContain("Choose what this connection can be used for");
      expect(requestJson).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
