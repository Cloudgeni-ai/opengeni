import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { SuperGrokDeviceCodePanel, useSuperGrokSubscriptions } from "./supergrok-connection";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  peekSharedQuery,
  retainSharedQueries,
  sharedQueryWriter,
} from "@opengeni/react/app/lib/shared-query";
import { ModelsRefreshControl } from "./models/models-refresh-control";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("SuperGrok device login", () => {
  test("renders the exact xAI code without adding a consent prompt", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SuperGrokDeviceCodePanel userCode="XAI-1234" verificationUri="https://auth.x.ai/device" />,
      );
    });
    expect(container.querySelector("[data-supergrok-device-code]")?.textContent).toBe("XAI-1234");
    expect(container.querySelector<HTMLAnchorElement>("a")?.href).toBe("https://auth.x.ai/device");
    expect(container.textContent?.toLowerCase()).not.toContain("consent");
    await act(async () => root.unmount());
  });

  test("sign-in refreshes the pool and invalidates retained Models and account-switcher reads", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let connected = false,
      reads = 0;
    const account = {
      id: "new-account",
      subject: "person",
      scope: "workspace",
      allocatorVersion: 1,
    };
    const client = {
      supergrokStatus: async () => ({ connected }),
      listSuperGrokAccounts: async () => {
        reads++;
        return {
          accounts: connected ? [account] : [],
          activeAccountId: connected ? account.id : null,
          settings: {
            rotationEnabled: false,
            rotationStrategy: "sharded",
            activeCredentialId: null,
          },
        };
      },
      supergrokConnectStart: async () => ({
        userCode: "CODE",
        verificationUri: "https://auth.x.ai/device",
        state: "state",
        intervalSeconds: 1,
        expiresInSeconds: 60,
      }),
      supergrokConnectPoll: async () => {
        connected = true;
        return { status: "connected", accountId: account.id, scope: "workspace" };
      },
    } as unknown as OpenGeniBrowserClient;
    const retain = retainSharedQueries(client);
    const open = spyOn(window, "open").mockReturnValue(null);
    let state!: ReturnType<typeof useSuperGrokSubscriptions>;
    function Harness() {
      state = useSuperGrokSubscriptions({ client, workspaceId: "workspace", canManage: true });
      return null;
    }
    try {
      await act(async () => root.render(<Harness />));
      const write = sharedQueryWriter(client);
      write(["subscription-pool", "SuperGrok", "workspace", "other"], { accounts: [] });
      write(["supergrok-accounts", "workspace"], { accounts: [] });
      write(["model-settings", "fixture"], { connected: false });
      let done!: () => void;
      const completed = new Promise<void>((resolve) => {
        done = resolve;
      });
      await act(async () => {
        await state.connect("workspace", { onConnected: done });
        await completed;
      });
      expect(reads).toBe(2);
      expect(state.accounts.map((item) => item.id)).toEqual(["new-account"]);
      expect(
        peekSharedQuery(client, ["subscription-pool", "SuperGrok", "workspace", "other"]),
      ).toBeNull();
      expect(peekSharedQuery(client, ["supergrok-accounts", "workspace"])).toBeNull();
      expect(peekSharedQuery(client, ["model-settings", "fixture"])).toBeNull();
    } finally {
      await act(async () => root.unmount());
      open.mockRestore();
      retain();
    }
  });

  test("workspace status is probed before listing on cold, stale and global refresh, not a fresh mount", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let checks = 0,
      reads = 0,
      now = Date.now(),
      usedPercent = 10;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const client = {
      supergrokStatus: async () => {
        checks++;
        usedPercent += 10;
        return { connected: true, valid: true };
      },
      listSuperGrokAccounts: async () => {
        reads++;
        return {
          accounts: [
            {
              id: "account",
              subject: "person",
              scope: "user",
              allocatorVersion: 1,
              quota: { usedPercent, checkedAt: new Date(now).toISOString() },
            },
          ],
          activeAccountId: "account",
          settings: {
            rotationEnabled: false,
            rotationStrategy: "sharded",
            activeCredentialId: "account",
          },
        };
      },
    } as unknown as OpenGeniBrowserClient;
    const retain = retainSharedQueries(client);
    let state!: ReturnType<typeof useSuperGrokSubscriptions>;
    function Harness() {
      state = useSuperGrokSubscriptions({ client, workspaceId: "workspace", canManage: true });
      return <ModelsRefreshControl client={client} />;
    }
    try {
      await act(async () => root.render(<Harness />));
      expect([checks, reads, state.accounts[0]?.quota?.usedPercent]).toEqual([1, 1, 20]);
      await act(async () => root.render(<></>));
      now += 5 * 60_000 - 1;
      await act(async () => root.render(<Harness />));
      expect([checks, reads]).toEqual([1, 1]);
      await act(async () => root.render(<></>));
      now++;
      await act(async () => root.render(<Harness />));
      expect([checks, reads, state.accounts[0]?.quota?.usedPercent]).toEqual([2, 2, 30]);
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      expect([checks, reads, state.accounts[0]?.quota?.usedPercent]).toEqual([3, 3, 40]);
    } finally {
      await act(async () => root.unmount());
      clock.mockRestore();
      retain();
    }
  });

  test("a failed status probe preserves readable saved account quotas", async () => {
    const root = createRoot(document.createElement("div"));
    const checkedAt = "2026-10-20T00:00:00.000Z";
    const client = {
      supergrokStatus: async () => {
        throw new Error("provider unavailable");
      },
      listSuperGrokAccounts: async () => ({
        accounts: [{ id: "account", quota: { usedPercent: 25, checkedAt } }],
        settings: { rotationEnabled: false },
        activeAccountId: "account",
      }),
    } as unknown as OpenGeniBrowserClient;
    let state!: ReturnType<typeof useSuperGrokSubscriptions>;
    function Harness() {
      state = useSuperGrokSubscriptions({ client, workspaceId: "workspace", canManage: true });
      return null;
    }
    try {
      await act(async () => root.render(<Harness />));
      expect(state.accounts[0]?.quota).toMatchObject({ usedPercent: 25, checkedAt });
      expect(state.loadError).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("organization refresh re-reads saved quotas without pretending there is a live organization endpoint", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let reads = 0,
      probes = 0;
    const client = {
      supergrokStatus: async () => {
        probes++;
        return { connected: true };
      },
      listOrganizationSuperGrokAccounts: async () => {
        reads++;
        return { accounts: [], settings: { rotationEnabled: false }, activeAccountId: null };
      },
    } as unknown as OpenGeniBrowserClient;
    function Harness() {
      useSuperGrokSubscriptions({ client, organizationId: "org", canManage: true });
      return <ModelsRefreshControl client={client} />;
    }
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      expect(reads).toBe(2);
      expect(probes).toBe(0);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
