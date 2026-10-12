import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { fakeClient, WORKSPACE_ID } from "../../../../../packages/react/test/fake-client";

{
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
}
const { OpenGeniProvider } = await import("@opengeni/react");
const { CodexAccountIndicator } = await import("./codex-account-indicator");
const { retainSharedQueries } = await import("@/lib/shared-query");
afterAll(() => GlobalRegistrator.unregister());

test("running accepted account remains labeled while the switcher offers only the new pool", async () => {
  const client = Object.assign(fakeClient({}), {
    listSessionCodexAccounts: async () => ({
      accounts: [
        { id: "next", label: "New workspace account", status: "active", allocatorEnabled: true },
      ],
      currentAccount: {
        id: "accepted",
        label: "Accepted organization account",
        status: "active",
        allocatorEnabled: true,
      },
      currentSelection: { credentialId: "accepted", waiting: false },
      pinnedAccountId: null,
      lastAccountId: "accepted",
      activeAccountId: "next",
      settings: { rotationEnabled: true, rotationStrategy: "sharded", activeCredentialId: "next" },
    }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
          <CodexAccountIndicator
            workspaceId={WORKSPACE_ID}
            sessionId="running"
            model="codex/gpt-5.6-sol"
            events={[]}
          />
        </OpenGeniProvider>,
      ),
    );
    const trigger = container.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toContain(
      "Current account · Accepted organization account",
    );
    await act(async () =>
      trigger.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
      ),
    );
    const choices = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
      (row) => row.textContent,
    );
    expect(choices.some((choice) => choice?.includes("New workspace account"))).toBe(true);
    expect(choices.some((choice) => choice?.includes("Accepted organization account"))).toBe(false);
    expect(document.body.textContent).toContain("Use for next turn");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("shows the blocked account instead of a healthy default and permits repeating Auto", async () => {
  const calls: string[] = [];
  const client = Object.assign(fakeClient({}), {
    listCodexAccounts: async () => {
      throw new Error("workspace pool must not drive a session retry picker");
    },
    refreshCodexUsage: async () => ({
      usage: {
        blocked: {
          status: "limit_reached" as const,
          usage: {
            status: "limit_reached" as const,
            planType: "pro",
            fiveHour: {
              used: 100,
              limit: 100,
              remaining: 0,
              percent: 100,
              resetAt: null,
              resetAfterSeconds: null,
              limitWindowSeconds: 18000,
            },
            weekly: {
              used: 10,
              limit: 100,
              remaining: 90,
              percent: 10,
              resetAt: null,
              resetAfterSeconds: null,
              limitWindowSeconds: 604800,
            },
            limitReached: true,
            fetchedAt: new Date().toISOString(),
          },
        },
      },
    }),
    listSessionCodexAccounts: async () => ({
      pinnedAccountId: null,
      lastAccountId: null,
      currentAccount: null,
      currentSelection: { credentialId: "blocked", waiting: true },
      accounts: [
        {
          id: "blocked",
          label: "Blocked account",
          fiveHour: { percent: 100, remaining: 0 },
          weekly: { percent: 10, remaining: 90 },
          status: "active",
          plan: "pro",
          allocatorEnabled: true,
        },
        {
          id: "healthy",
          label: "Healthy default",
          status: "active",
          plan: "pro",
          allocatorEnabled: true,
        },
      ],
      activeAccountId: "healthy",
      settings: {
        rotationEnabled: true,
        rotationStrategy: "sharded",
        activeCredentialId: "healthy",
      },
    }),
    pinSessionCodexAccount: async (_workspace: string, _session: string, target: string) => {
      calls.push(target);
      return { pinned: target, appliedTo: "waiting_turn" };
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
          <CodexAccountIndicator
            workspaceId={WORKSPACE_ID}
            sessionId="session"
            model="codex/gpt-5.6-sol"
            events={[]}
          />
        </OpenGeniProvider>,
      ),
    );
    const trigger = container.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toContain("Limit reached · Blocked account");
    await act(async () =>
      trigger.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
      ),
    );
    expect(document.body.textContent).toContain("Retry with");
    const bars = document.querySelectorAll<HTMLElement>('[role="progressbar"]');
    expect(bars.length).toBe(2);
    expect(bars[0]!.getAttribute("aria-valuetext")).toBe("0% remaining");
    expect(bars[1]!.getAttribute("aria-valuetext")).toBe("90% remaining");
    expect((bars[1]!.firstElementChild as HTMLElement).style.width).toBe("90%");
    const blockedOption = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.includes("Blocked account"),
    );
    expect(blockedOption?.textContent).toContain("0% remaining");
    const auto = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes("Auto"),
    );
    expect(auto).toBeDefined();
    await act(async () => auto!.click());
    expect(calls).toEqual(["auto"]);
    expect(document.body.textContent).toContain("Selection saved. Capacity is being rechecked.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("weekly-only live usage replaces a mislabeled cached 5-hour reading", async () => {
  const client = Object.assign(fakeClient({}), {
    listSessionCodexAccounts: async () => ({
      accounts: [
        {
          id: "weekly-only",
          label: "Weekly-only account",
          status: "active",
          plan: "pro",
          allocatorEnabled: true,
          fiveHour: { percent: 66, remaining: 34 },
          weekly: { percent: 0, remaining: 100 },
        },
      ],
      currentAccount: {
        id: "weekly-only",
        label: "Weekly-only account",
        status: "active",
        plan: "pro",
        allocatorEnabled: true,
        fiveHour: { percent: 66, remaining: 34 },
        weekly: { percent: 0, remaining: 100 },
      },
      currentSelection: { credentialId: "weekly-only", waiting: false },
      pinnedAccountId: "weekly-only",
      lastAccountId: "weekly-only",
      activeAccountId: "weekly-only",
      settings: {
        rotationEnabled: true,
        rotationStrategy: "sharded",
        activeCredentialId: "weekly-only",
      },
    }),
    refreshCodexUsage: async () => ({
      usage: {
        "weekly-only": {
          status: "ok" as const,
          usage: {
            status: "ok" as const,
            planType: "pro",
            fiveHour: null,
            weekly: {
              used: 66,
              limit: 100,
              remaining: 34,
              percent: 66,
              resetAt: null,
              resetAfterSeconds: null,
              limitWindowSeconds: 604800,
            },
            limitReached: false,
            fetchedAt: new Date().toISOString(),
          },
        },
      },
    }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
          <CodexAccountIndicator
            workspaceId={WORKSPACE_ID}
            sessionId="weekly"
            model="codex/gpt-5.6-sol"
            events={[]}
          />
        </OpenGeniProvider>,
      ),
    );
    await act(async () =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })),
    );
    const bars = document.querySelectorAll<HTMLElement>('[role="progressbar"]');
    expect(bars).toHaveLength(1);
    expect(bars[0]!.getAttribute("aria-label")).toBe("Week remaining");
    expect(bars[0]!.getAttribute("aria-valuetext")).toBe("34% remaining");
    expect(document.body.textContent).not.toContain("5h");
    expect(document.body.textContent).not.toContain("100% remaining");
    expect(document.body.textContent).toContain("Weekly-only account");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("navigating back and reopening keeps the last account and live usage on screen", async () => {
  let listReads = 0;
  let usageReads = 0;
  let releaseUsage: (() => void) | null = null;
  const reading = (remaining: number) => ({
    used: 100 - remaining,
    limit: 100,
    remaining,
    percent: 100 - remaining,
    resetAt: null,
    resetAfterSeconds: null,
    limitWindowSeconds: 604800,
  });
  const account = {
    id: "team",
    label: "Team account",
    status: "active",
    plan: "pro",
    allocatorEnabled: true,
    weekly: { percent: 10, remaining: 90 },
  };
  const client = Object.assign(fakeClient({}), {
    listSessionCodexAccounts: async () => {
      listReads += 1;
      return {
        accounts: [account],
        currentAccount: account,
        currentSelection: { credentialId: "team", waiting: false },
        pinnedAccountId: null,
        lastAccountId: "team",
        activeAccountId: "team",
        settings: {
          rotationEnabled: true,
          rotationStrategy: "sharded",
          activeCredentialId: "team",
        },
      };
    },
    refreshCodexUsage: async () => {
      usageReads += 1;
      // The second check is slow: the menu must not blank out meanwhile.
      if (usageReads > 1) await new Promise<void>((resolve) => (releaseUsage = resolve));
      return {
        usage: {
          team: {
            status: "ok" as const,
            usage: {
              status: "ok" as const,
              planType: "pro",
              fiveHour: null,
              weekly: reading(usageReads > 1 ? 55 : 72),
              limitReached: false,
              fetchedAt: new Date().toISOString(),
            },
          },
        },
      };
    },
  });
  const indicator = (
    <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
      <CodexAccountIndicator
        workspaceId={WORKSPACE_ID}
        sessionId="cached"
        model="codex/gpt-5.6-sol"
        events={[]}
      />
    </OpenGeniProvider>
  );
  const open = (container: HTMLElement) =>
    act(async () =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })),
    );
  const close = () =>
    act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
  const weeklyBar = () =>
    document.querySelector<HTMLElement>('[role="progressbar"][aria-label="Week remaining"]');

  // The console retains reads for its client above the routed pages, so
  // leaving the session page (and its provider subtree) keeps them.
  const release = retainSharedQueries(client);
  const first = document.createElement("div");
  document.body.append(first);
  const firstRoot = createRoot(first);
  await act(async () => firstRoot.render(indicator));
  await open(first);
  expect(weeklyBar()?.getAttribute("aria-valuetext")).toBe("72% remaining");
  await close();
  // Let the post-check account re-read settle before leaving.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const readsBeforeLeaving = listReads;
  // Click away to another page: the session header unmounts.
  await act(async () => firstRoot.unmount());
  first.remove();

  // Back to the session: the first frame already shows the account control,
  // not the loading skeleton, and nothing waits on the network.
  const second = document.createElement("div");
  document.body.append(second);
  const secondRoot = createRoot(second);
  let skeletonOnFirstFrame: boolean | null = null;
  try {
    act(() => secondRoot.render(indicator));
    skeletonOnFirstFrame = second.querySelector('[aria-label="Loading Codex account"]') !== null;
    await act(async () => undefined);
    expect(skeletonOnFirstFrame).toBe(false);
    expect(second.querySelector("button")?.getAttribute("aria-label")).toContain(
      "Current account · Team account",
    );
    expect(listReads).toBe(readsBeforeLeaving);

    // Reopening within the reuse window shows the last live reading at once
    // and does not ask the provider again.
    await open(second);
    expect(document.body.textContent).not.toContain("Checking usage");
    expect(weeklyBar()?.getAttribute("aria-valuetext")).toBe("72% remaining");
    expect(usageReads).toBe(1);
    await close();

    // A later re-check keeps the previous reading visible until the new one lands.
    // Age the retained reading past the reuse window.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      await open(second);
      expect(usageReads).toBe(2);
      expect(document.body.textContent).not.toContain("Checking usage");
      expect(weeklyBar()?.getAttribute("aria-valuetext")).toBe("72% remaining");
    } finally {
      Date.now = realNow;
    }
    await act(async () => releaseUsage?.());
    await act(async () => undefined);
    expect(weeklyBar()?.getAttribute("aria-valuetext")).toBe("55% remaining");
  } finally {
    await act(async () => secondRoot.unmount());
    second.remove();
    release();
  }
});
