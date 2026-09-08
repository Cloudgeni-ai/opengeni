import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceCodexSubscriptionSource } from "@opengeni/sdk";
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
      await act(async () => details!.click());
      expect(container.textContent).not.toContain("Choose what this connection can be used for");
      expect(requestJson).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
