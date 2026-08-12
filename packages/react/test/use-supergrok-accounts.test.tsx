import { describe, expect, test } from "bun:test";
import type { SuperGrokAccountsResponse } from "@opengeni/sdk";

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
});
