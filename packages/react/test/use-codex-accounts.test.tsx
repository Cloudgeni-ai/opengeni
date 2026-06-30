/* ----------------------------------------------------------------------------
   useCodexAccounts (P2): the cached usage windows ride along on `accounts`, and
   `refreshUsage()` drives the batched LIVE provider refresh then re-reads the
   cached metadata so the fresh windows land. Dual-consumer safe via the
   structural CodexAccountsClientLike surface.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { useCodexAccounts, type CodexAccountsClientLike } from "../src/hooks/use-codex-accounts";
import type { CodexAccount, CodexAccountsResponse, CodexUsageWindow } from "@opengeni/sdk";

registerDom();

const client = fakeClient({});

function win(percent: number, limitWindowSeconds: number): CodexUsageWindow {
  return { used: percent, limit: 100, remaining: 100 - percent, percent, resetAt: null, resetAfterSeconds: 3600, limitWindowSeconds };
}

function account(id: string, over: Partial<CodexAccount> = {}): CodexAccount {
  return { id, label: `acct ${id}`, status: "active", active: id === "a", ...over };
}

function response(accounts: CodexAccount[]): CodexAccountsResponse {
  return { accounts, activeAccountId: "a", settings: { rotationEnabled: false, rotationStrategy: "most_remaining", activeCredentialId: "a" } };
}

describe("useCodexAccounts — cached usage + refreshUsage", () => {
  test("cached fiveHour/weekly windows ride along on accounts", async () => {
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => response([account("a", { fiveHour: win(40, 18000), weekly: win(12, 604800), usageCheckedAt: new Date().toISOString() })]),
    };
    const hook = await renderHook(() => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }), undefined);
    await flush();
    expect(hook.result.current.accounts[0]?.fiveHour?.remaining).toBe(60);
    expect(hook.result.current.accounts[0]?.weekly?.percent).toBe(12);
  });

  test("refreshUsage() calls the batched refresh then re-reads accounts with the fresh windows", async () => {
    let refreshed = false;
    const codexClient: CodexAccountsClientLike = {
      // First read: no cached windows. After refreshCodexUsage runs, the re-read
      // returns the fresh windows (the server wrote the cache).
      listCodexAccounts: async () => response([account("a", refreshed ? { fiveHour: win(55, 18000) } : {})]),
      refreshCodexUsage: async () => { refreshed = true; return { usage: {} }; },
    };
    const hook = await renderHook(() => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }), undefined);
    await flush();
    expect(hook.result.current.accounts[0]?.fiveHour).toBeUndefined();

    let returned: boolean | undefined;
    await flush();
    await (async () => { returned = await hook.result.current.refreshUsage(); })();
    await flush();
    expect(returned).toBe(true);
    expect(hook.result.current.accounts[0]?.fiveHour?.percent).toBe(55);
  });

  test("refreshUsage() is a no-op (false) when the client can't refresh usage", async () => {
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => response([account("a")]),
      // refreshCodexUsage intentionally omitted.
    };
    const hook = await renderHook(() => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }), undefined);
    await flush();
    let returned: boolean | undefined;
    await (async () => { returned = await hook.result.current.refreshUsage(); })();
    await flush();
    expect(returned).toBe(false);
  });
});
