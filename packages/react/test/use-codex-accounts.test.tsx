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
import {
  invalidateSharedQueries,
  retainSharedQueries,
  sharedQueryWriter,
} from "../src/hooks/shared-query";
import { recordCodexLiveUsage } from "../src/hooks/use-codex-accounts";
import type {
  CodexAccount,
  CodexAccountsResponse,
  CodexUsageWindow,
  SessionCodexAccountsResponse,
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

function sessionResponse(
  accounts: CodexAccount[],
  overrides: Partial<SessionCodexAccountsResponse> = {},
): SessionCodexAccountsResponse {
  return {
    ...response(accounts),
    currentAccount: null,
    currentSelection: null,
    pinnedAccountId: null,
    lastAccountId: null,
    ...overrides,
  };
}

describe("useCodexAccounts — cached usage + refreshUsage", () => {
  test("session projection preserves old-pool identity through drift and realtime settlement switches to new-work choices", async () => {
    let waiting = true;
    let reads = 0;
    const old = account("accepted", { source: "organization" });
    const next = account("new", { source: "workspace" });
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => {
        throw new Error("session must not fall back to workspace");
      },
      listSessionCodexAccounts: async () => {
        reads += 1;
        return sessionResponse(waiting ? [old] : [next], {
          currentSelection: waiting ? { credentialId: old.id, waiting: true } : null,
          currentAccount: waiting ? old : null,
        });
      },
    };
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useCodexAccounts({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: "session",
          codexClient,
          events,
          pollIntervalMs: 0,
        }),
      [] as SessionEvent[],
    );
    try {
      await flush();
      expect(hook.result.current.accounts.map((row) => row.id)).toEqual(["accepted"]);
      expect(hook.result.current.currentAccount?.id).toBe("accepted");
      waiting = false;
      await hook.rerender([
        {
          id: "done",
          sessionId: "session",
          workspaceId: WORKSPACE_ID,
          sequence: 1,
          type: "turn.completed",
          payload: {},
          occurredAt: new Date().toISOString(),
        },
      ]);
      await flush();
      expect(reads).toBe(2);
      expect(hook.result.current.accounts.map((row) => row.id)).toEqual(["new"]);
      expect(hook.result.current.currentAccount).toBeNull();
    } finally {
      await hook.unmount();
    }
  });

  test("a failed session-authorized projection never falls back to workspace inventory", async () => {
    let workspaceReads = 0;
    let denied = false;
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => {
        workspaceReads += 1;
        return response([account("wrong-pool")]);
      },
      listSessionCodexAccounts: async () => {
        if (denied) throw new Error("Forbidden");
        return sessionResponse([account("accepted")]);
      },
    };
    const hook = await renderHook(
      () =>
        useCodexAccounts({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: "session",
          codexClient,
          events: [],
          pollIntervalMs: 0,
        }),
      undefined,
    );
    try {
      await flush();
      expect(hook.result.current.accounts.map((row) => row.id)).toEqual(["accepted"]);
      denied = true;
      await actRun(() => hook.result.current.refresh());
      await flush();
      expect(workspaceReads).toBe(0);
      expect(hook.result.current.accounts).toEqual([]);
      expect(hook.result.current.error?.message).toBe("Forbidden");
    } finally {
      await hook.unmount();
    }
  });
  test("refreshes only after the durable post-selection event", () => {
    expect(isCodexAccountEvent({ type: "turn.started" })).toBe(false);
    expect(isCodexAccountEvent({ type: "codex.account.switched" })).toBe(true);
    expect(isCodexAccountEvent({ type: "codex.credential.selected" })).toBe(true);
    expect(isCodexAccountEvent({ type: "codex.account.selection.changed" })).toBe(true);
    expect(isCodexAccountEvent({ type: "codex.capacity.waiting" })).toBe(true);
  });

  test("keeps blocked selection separate from future preference and exposes override acknowledgement", async () => {
    let selected: string | null = null;
    let blocked = "a";
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => {
        throw new Error("must use session projection");
      },
      listSessionCodexAccounts: async () => ({
        ...sessionResponse([account("a"), account("b")]),
        activeAccountId: "b",
        pinnedAccountId: selected,
        currentSelection: { credentialId: blocked, waiting: true },
      }),
      pinSessionCodexAccount: async (_workspaceId, _sessionId, target) => {
        selected = target;
        blocked = target;
        return { pinned: target, appliedTo: "waiting_turn" };
      },
    };
    const hook = await renderHook(
      () =>
        useCodexAccounts({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: "test-session",
          codexClient,
          events: [],
          pollIntervalMs: 0,
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.effectiveAccountId).toBe("b");
    expect(hook.result.current.currentSelection).toEqual({ credentialId: "a", waiting: true });
    await actRun(() => hook.result.current.pin("b"));
    await flush();
    expect(hook.result.current.currentSelection).toEqual({ credentialId: "b", waiting: true });
    expect(hook.result.current.switchAppliedTo).toBe("waiting_turn");
    await hook.unmount();
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
        throw new Error("must use session projection");
      },
      listSessionCodexAccounts: async () => {
        reads += 1;
        return sessionResponse([account("a")]);
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

  test("a live no-data response hides misleading cached window labels", async () => {
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () =>
        response([
          account("a", {
            fiveHour: win(66, 18000),
            weekly: win(0, 604800),
          }),
        ]),
      refreshCodexUsage: async () => ({
        usage: {
          a: {
            status: "no-data",
            usage: {
              status: "no-data",
              planType: "pro",
              fiveHour: null,
              weekly: null,
              limitReached: false,
              fetchedAt: new Date().toISOString(),
            },
          },
        },
      }),
    };
    const hook = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    try {
      await flush();
      expect(hook.result.current.accounts[0]?.fiveHour?.remaining).toBe(34);
      expect(await actRun(() => hook.result.current.refreshUsage())).toBe(true);
      await flush();
      expect(hook.result.current.liveUsage.a?.status).toBe("no-data");
      expect(hook.result.current.accounts[0]?.fiveHour).toBeNull();
      expect(hook.result.current.accounts[0]?.weekly).toBeNull();
    } finally {
      await hook.unmount();
    }
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

describe("useCodexAccounts — shared cache across remounts", () => {
  test("navigating back renders the retained accounts and live usage at once", async () => {
    let reads = 0;
    let usageReads = 0;
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => {
        throw new Error("must use session projection");
      },
      listSessionCodexAccounts: async () => {
        reads += 1;
        return sessionResponse([account("a", { weekly: win(20, 604800) })], {
          currentSelection: { credentialId: "a", waiting: false },
          currentAccount: account("a", { weekly: win(20, 604800) }),
        });
      },
      refreshCodexUsage: async () => {
        usageReads += 1;
        return {
          usage: {
            a: {
              status: "ok" as const,
              usage: {
                status: "ok" as const,
                planType: "pro",
                fiveHour: win(10, 18000),
                weekly: win(30, 604800),
                limitReached: false,
                fetchedAt: new Date().toISOString(),
              },
            },
          },
        };
      },
    };
    // The host opted into keeping reads across mounts for this client.
    const release = retainSharedQueries(codexClient);
    const render = () =>
      renderHook(() => {
        const result = useCodexAccounts({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: "session",
          codexClient,
          events: [],
          pollIntervalMs: 0,
        });
        rendered.push({ loading: result.loading, accounts: result.accounts.length });
        return result;
      }, undefined);
    let rendered: { loading: boolean; accounts: number }[] = [];
    const first = await render();
    await flush();
    expect(await actRun(() => first.result.current.refreshUsage())).toBe(true);
    await flush();
    expect(first.result.current.accounts[0]?.weekly?.percent).toBe(30);
    await first.unmount();
    const readsBefore = reads;

    rendered = [];
    const second = await render();
    // Every render of the revisit already has the rows: no skeleton flash.
    expect(rendered.every((each) => !each.loading && each.accounts === 1)).toBe(true);
    expect(second.result.current.accounts[0]?.weekly?.percent).toBe(30);
    expect(second.result.current.liveUsageUpdatedAt).not.toBeNull();
    // Reopening within the reuse window does not ask the provider again.
    expect(await actRun(() => second.result.current.refreshUsage({ maxAgeMs: 30_000 }))).toBe(true);
    await flush();
    expect(usageReads).toBe(1);
    expect(reads).toBe(readsBefore);
    await second.unmount();
    release();
  });

  test("concurrent live usage refreshes share one provider read", async () => {
    let usageReads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => response([account("a")]),
      refreshCodexUsage: async () => {
        usageReads += 1;
        await gate;
        return { usage: {} };
      },
    };
    const a = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    const b = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    await flush();
    let pending!: Promise<boolean[]>;
    await actRun(async () => {
      pending = Promise.all([a.result.current.refreshUsage(), b.result.current.refreshUsage()]);
    });
    await actRun(async () => release());
    expect(await actRun(() => pending)).toEqual([true, true]);
    expect(usageReads).toBe(1);
    await a.unmount();
    await b.unmount();
  });

  test("switching accounts evicts the workspace's other retained Codex reads", async () => {
    let pinned: string | null = null;
    let workspaceReads = 0;
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => {
        workspaceReads += 1;
        return response([account("a"), account("b")]);
      },
      listSessionCodexAccounts: async () =>
        sessionResponse([account("a"), account("b")], { pinnedAccountId: pinned }),
      pinSessionCodexAccount: async (_workspaceId, _sessionId, target) => {
        pinned = target;
        return { pinned: target, appliedTo: "next_turn" };
      },
    };
    const release = retainSharedQueries(codexClient);
    const workspace = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    await flush();
    await workspace.unmount();
    expect(workspaceReads).toBe(1);

    const session = await renderHook(
      () =>
        useCodexAccounts({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: "session",
          codexClient,
          events: [],
          pollIntervalMs: 0,
        }),
      undefined,
    );
    await flush();
    expect(await actRun(() => session.result.current.pin("b"))).toBe(true);
    await flush();
    expect(session.result.current.pinnedAccountId).toBe("b");
    await session.unmount();

    // The workspace list retained before the switch is re-read, not reused.
    const again = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    await flush();
    expect(workspaceReads).toBe(2);
    await again.unmount();
    release();
  });
});

describe("useCodexAccounts — mutations reach every surface", () => {
  function pool(initialPinned: string | null = null) {
    const state = { pinned: initialPinned, workspaceReads: 0, sessionReads: 0 };
    let gate: Promise<void> | null = null;
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => {
        state.workspaceReads += 1;
        return response([account("a"), account("b")]);
      },
      listSessionCodexAccounts: async () => {
        state.sessionReads += 1;
        return sessionResponse([account("a"), account("b")], { pinnedAccountId: state.pinned });
      },
      pinSessionCodexAccount: async (_workspaceId, _sessionId, target) => {
        if (gate) await gate;
        state.pinned = target;
        return { pinned: target, appliedTo: "next_turn" };
      },
    };
    return {
      state,
      codexClient,
      hold(): () => void {
        let open!: () => void;
        gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        return open;
      },
    };
  }
  const workspaceList = (codexClient: CodexAccountsClientLike) =>
    renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
  const sessionSwitcher = (codexClient: CodexAccountsClientLike) =>
    renderHook(
      () =>
        useCodexAccounts({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: "session",
          codexClient,
          events: [],
          pollIntervalMs: 0,
        }),
      undefined,
    );

  test("pinning in the session switcher re-reads the workspace list mounted in Settings", async () => {
    const { state, codexClient } = pool();
    const settings = await workspaceList(codexClient);
    const switcher = await sessionSwitcher(codexClient);
    await flush();
    expect(state.workspaceReads).toBe(1);
    expect(await actRun(() => switcher.result.current.pin("b"))).toBe(true);
    await flush();
    expect(state.workspaceReads).toBe(2);
    expect(switcher.result.current.pinnedAccountId).toBe("b");
    await switcher.unmount();
    await settings.unmount();
  });

  test("a pin that settles after the switcher unmounted still invalidates", async () => {
    const { state, codexClient, hold } = pool();
    const release = retainSharedQueries(codexClient);
    const settings = await workspaceList(codexClient);
    const switcher = await sessionSwitcher(codexClient);
    await flush();
    const open = hold();
    let pinned!: Promise<boolean>;
    await actRun(async () => {
      pinned = switcher.result.current.pin("b");
    });
    // Navigating away while the switch is still being applied.
    await switcher.unmount();
    const sessionReadsBefore = state.sessionReads;
    await actRun(async () => open());
    await actRun(() => pinned);
    await flush();
    // The mounted Settings list re-read the moment the switch landed ...
    expect(state.workspaceReads).toBe(2);
    // ... and the retained session list is not served stale on the next visit.
    const again = await sessionSwitcher(codexClient);
    await flush();
    expect(state.sessionReads).toBe(sessionReadsBefore + 1);
    expect(again.result.current.pinnedAccountId).toBe("b");
    await again.unmount();
    await settings.unmount();
    release();
  });

  test("an invalidated workspace list is never shown stale on the next visit", async () => {
    const { state, codexClient } = pool();
    const release = retainSharedQueries(codexClient);
    const first = await workspaceList(codexClient);
    await flush();
    await first.unmount();
    await invalidateSharedQueries(codexClient, ["codex-accounts", WORKSPACE_ID]);
    const rendered: number[] = [];
    const again = await renderHook(() => {
      const result = useCodexAccounts({
        client,
        workspaceId: WORKSPACE_ID,
        codexClient,
        pollIntervalMs: 0,
      });
      rendered.push(result.accounts.length);
      return result;
    }, undefined);
    expect(rendered[0]).toBe(0);
    await flush();
    expect(state.workspaceReads).toBe(2);
    await again.unmount();
    release();
  });
});

describe("useCodexAccounts — live usage freshness is per account", () => {
  test("one account's recent reading never makes every account count as fresh", async () => {
    let usageReads = 0;
    const reading = (id: string) => ({
      [id]: {
        status: "ok" as const,
        usage: {
          status: "ok" as const,
          planType: "pro",
          fiveHour: null,
          weekly: win(40, 604800),
          limitReached: false,
          fetchedAt: new Date().toISOString(),
        },
      },
    });
    const codexClient: CodexAccountsClientLike = {
      listCodexAccounts: async () => response([account("a"), account("b")]),
      refreshCodexUsage: async () => {
        usageReads += 1;
        return { usage: { ...reading("a"), ...reading("b") } };
      },
    };
    const hook = await renderHook(
      () => useCodexAccounts({ client, workspaceId: WORKSPACE_ID, codexClient, pollIntervalMs: 0 }),
      undefined,
    );
    await flush();
    // Settings re-checked a single account (the per-account retry).
    await actRun(async () =>
      recordCodexLiveUsage(
        sharedQueryWriter(codexClient),
        codexClient,
        WORKSPACE_ID,
        reading("a"),
        "merge",
      ),
    );
    expect(hook.result.current.liveUsage.a).toBeDefined();
    // Account b has no live reading: reopening the menu must ask the provider.
    expect(await actRun(() => hook.result.current.refreshUsage({ maxAgeMs: 30_000 }))).toBe(true);
    expect(usageReads).toBe(1);
    // Now every listed account is recent: reuse instead of asking again.
    expect(await actRun(() => hook.result.current.refreshUsage({ maxAgeMs: 30_000 }))).toBe(true);
    expect(usageReads).toBe(1);
    expect(hook.result.current.liveUsageUpdatedAt).not.toBeNull();
    await hook.unmount();
  });
});
