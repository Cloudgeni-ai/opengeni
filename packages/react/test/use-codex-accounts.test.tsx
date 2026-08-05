/* ----------------------------------------------------------------------------
   useCodexAccounts (P2): the cached usage windows ride along on `accounts`, and
   `refreshUsage()` drives the batched LIVE provider refresh then re-reads the
   cached metadata so the fresh windows land. Dual-consumer safe via the
   structural CodexAccountsClientLike surface.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { actRun, registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import {
  isCodexAccountEvent,
  useCodexAccounts,
  type CodexAccountsClientLike,
} from "../src/hooks/use-codex-accounts";
import type {
  CodexAccount,
  CodexAccountsResponse,
  CodexUsageWindow,
  SessionEvent,
} from "@opengeni/sdk";

registerDom();

const client = fakeClient({});

function win(percent: number, limitWindowSeconds: number): CodexUsageWindow {
  return {
    used: percent,
    limit: 100,
    remaining: 100 - percent,
    percent,
    resetAt: null,
    resetAfterSeconds: 3600,
    limitWindowSeconds,
  };
}

function account(id: string, over: Partial<CodexAccount> = {}): CodexAccount {
  return {
    id,
    label: `acct ${id}`,
    status: "active",
    active: id === "a",
    allocatorEnabled: true,
    allocatorVersion: 1,
    appsDesignated: false,
    canEnableApps: false,
    ...over,
  };
}

function response(accounts: CodexAccount[]): CodexAccountsResponse {
  return {
    accounts,
    activeAccountId: "a",
    apps: {
      available: true,
      credentialId: null,
      version: 0,
      designatedAt: null,
      canDisable: false,
    },
    settings: {
      rotationEnabled: false,
      rotationStrategy: "sharded",
      activeCredentialId: "a",
    },
  };
}

describe("useCodexAccounts — cached usage + refreshUsage", () => {
  test("refreshes only after the durable post-selection event", () => {
    expect(isCodexAccountEvent({ type: "turn.started" })).toBe(false);
    expect(isCodexAccountEvent({ type: "codex.account.switched" })).toBe(true);
  });

  test("an empty shared feed never opens a fallback session stream", async () => {
    let reads = 0;
    let streams = 0;
    const streamSafeClient = fakeClient({
      streamEvents: () => {
        streams += 1;
        throw new Error("must not self-stream");
      },
    });
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => {
        reads += 1;
        return response([account("a")]);
      },
    };
    const turnStarted = {
      id: "turn-started",
      workspaceId: WORKSPACE_ID,
      sessionId: "session-a",
      sequence: 1,
      type: "turn.started",
      payload: {},
      occurredAt: new Date().toISOString(),
    } as SessionEvent;
    const switched = {
      ...turnStarted,
      id: "switched",
      sequence: 2,
      type: "codex.account.switched",
    } as SessionEvent;
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useCodexAccounts({
          client: streamSafeClient,
          workspaceId: WORKSPACE_ID,
          codexClient,
          sessionId: "session-a",
          events,
          pollIntervalMs: 0,
        }),
      [] as SessionEvent[],
    );
    await flush();
    expect(reads).toBe(1);
    expect(streams).toBe(0);
    await hook.rerender([turnStarted]);
    await flush();
    expect(reads).toBe(1);
    await hook.rerender([turnStarted, switched]);
    await flush();
    expect(reads).toBe(2);
    expect(streams).toBe(0);
    await hook.unmount();
  });

  test("cached fiveHour/weekly windows ride along on accounts", async () => {
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () =>
        response([
          account("a", {
            fiveHour: win(40, 18000),
            weekly: win(12, 604800),
            usageCheckedAt: new Date().toISOString(),
          }),
        ]),
    };
    const hook = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    await flush();
    expect(hook.result.current.accounts[0]?.fiveHour?.remaining).toBe(60);
    expect(hook.result.current.accounts[0]?.weekly?.percent).toBe(12);
    await hook.unmount();
  });

  test("refreshUsage() calls the batched refresh then re-reads accounts with the fresh windows", async () => {
    let refreshed = false;
    const codexClient: CodexAccountsClientLike = {
      // First read: no cached windows. After refreshCodexUsage runs, the re-read
      // returns the fresh windows (the server wrote the cache).
      listCodexAccounts: async () =>
        response([account("a", refreshed ? { fiveHour: win(55, 18000) } : {})]),
      refreshCodexUsage: async () => {
        refreshed = true;
        return { usage: {} };
      },
    };
    const hook = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    await flush();
    expect(hook.result.current.accounts[0]?.fiveHour).toBeUndefined();

    let returned: boolean | undefined;
    await flush();
    returned = await actRun(() => hook.result.current.refreshUsage());
    await flush();
    expect(returned).toBe(true);
    expect(hook.result.current.accounts[0]?.fiveHour?.percent).toBe(55);
    await hook.unmount();
  });

  test("refreshUsage() is a no-op (false) when the client can't refresh usage", async () => {
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => response([account("a")]),
      // refreshCodexUsage intentionally omitted.
    };
    const hook = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    await flush();
    let returned: boolean | undefined;
    returned = await actRun(() => hook.result.current.refreshUsage());
    await flush();
    expect(returned).toBe(false);
    await hook.unmount();
  });
});
