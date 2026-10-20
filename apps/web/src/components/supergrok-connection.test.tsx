import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { SuperGrokDeviceCodePanel, useSuperGrokSubscriptions } from "./supergrok-connection";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { peekSharedQuery, retainSharedQueries, sharedQueryWriter } from "@/lib/shared-query";

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
});
