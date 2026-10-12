import { describe, expect, test } from "bun:test";
import type { SuperGrokAccountsResponse } from "@opengeni/sdk";

import { retainSharedQueries } from "../src/hooks/shared-query";
import { useSuperGrokAccounts } from "../src/hooks/use-supergrok-accounts";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

function response(activeAccountId: string): SuperGrokAccountsResponse {
  return {
    accounts: [
      {
        id: "xai-1",
        scope: "workspace",
        subject: "xai-user-1",
        status: "active",
        active: activeAccountId === "xai-1",
        allocatorEnabled: true,
        allocatorVersion: 1,
      },
    ],
    activeAccountId,
    settings: {
      rotationEnabled: false,
      rotationStrategy: "sharded",
      activeCredentialId: activeAccountId,
    },
  };
}

describe("useSuperGrokAccounts", () => {
  test("loads workspace-default accounts and refreshes after activation", async () => {
    let active = "";
    let reads = 0;
    const supergrokClient = {
      listSuperGrokAccounts: async () => {
        reads += 1;
        return response(active);
      },
      activateSuperGrokAccount: async (_workspaceId: string, accountId: string) => {
        active = accountId;
        return { activated: true, accountId };
      },
    };
    const hook = await renderHook(
      () =>
        useSuperGrokAccounts({
          client: fakeClient({}),
          workspaceId: WORKSPACE_ID,
          supergrokClient,
          pollIntervalMs: 0,
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.accounts[0]?.scope).toBe("workspace");
    expect(hook.result.current.activeAccountId).toBe("");
    expect(await actRun(() => hook.result.current.activate("xai-1"))).toBe(true);
    await flush();
    expect(hook.result.current.activeAccountId).toBe("xai-1");
    expect(reads).toBe(2);
    await hook.unmount();
  });

  test("an activation that settles after unmount still invalidates the retained list", async () => {
    let active = "";
    let reads = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const supergrokClient = {
      listSuperGrokAccounts: async () => {
        reads += 1;
        return response(active);
      },
      activateSuperGrokAccount: async (_workspaceId: string, accountId: string) => {
        await gate;
        active = accountId;
        return { activated: true, accountId };
      },
    };
    const release = retainSharedQueries(supergrokClient);
    const render = () =>
      renderHook(
        () =>
          useSuperGrokAccounts({
            client: fakeClient({}),
            workspaceId: WORKSPACE_ID,
            supergrokClient,
            pollIntervalMs: 0,
          }),
        undefined,
      );
    const hook = await render();
    await flush();
    let activated!: Promise<boolean>;
    await actRun(async () => {
      activated = hook.result.current.activate("xai-1");
    });
    await hook.unmount();
    await actRun(async () => open());
    await actRun(() => activated);
    // The next visit re-reads instead of showing the old primary account.
    const again = await render();
    await flush();
    expect(reads).toBe(2);
    expect(again.result.current.activeAccountId).toBe("xai-1");
    await again.unmount();
    release();
  });
});
