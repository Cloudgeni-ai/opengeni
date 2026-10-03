import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { UsageResponse, UsageScope } from "./usage-contract";
import { fixtureUsage } from "./usage-fixtures";
import type { UsageSearch } from "./usage-search";

let nextUsage: UsageResponse;
let nextError: unknown = null;
let nextCalls: unknown[] = [];
const requests: Array<{ path: string; query: Record<string, string> }> = [];

const requestJson = mock(
  async (_method: string, path: string, _body: unknown, query: Record<string, string>) => {
    requests.push({ path, query });
    if (nextError) throw nextError;
    if (path.endsWith("/calls")) return { calls: nextCalls, nextCursor: null };
    return nextUsage;
  },
);
const context = { client: { requestJson } };
mock.module("@/context", () => ({ useAppContext: () => context }));

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  nextUsage = fixtureUsage();
  nextError = null;
  nextCalls = [];
  resetUsageSourceMemo();
  requests.length = 0;
  requestJson.mockClear();
});

const { UsageDashboard } = await import("./usage-dashboard");
const { resetUsageSourceMemo } = await import("./usage-source");

const WORKSPACE: UsageScope = {
  kind: "workspace",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
};

async function render(search: UsageSearch = {}, scope: UsageScope = WORKSPACE) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changes: UsageSearch[] = [];
  const opened: Array<[string, string | null]> = [];
  await act(async () => {
    root.render(
      <UsageDashboard
        scope={scope}
        search={search}
        onSearchChange={(next) => changes.push(next)}
        onOpenSession={(sessionId, workspaceId) => opened.push([sessionId, workspaceId])}
        deniedMessage="No access."
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    changes,
    opened,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function breakdownTitles(container: HTMLElement): string[] {
  const table = container.querySelector('[role="table"][aria-label^="Usage by"]');
  return [...(table?.querySelectorAll('[role="rowgroup"]:last-child > [role="row"]') ?? [])].map(
    (row) => row.querySelector('[role="rowheader"] [id]')?.textContent ?? "",
  );
}

function rowAction(container: HTMLElement, title: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button[data-row-action]")].find(
      (button) => button.textContent === title,
    ) ?? null
  );
}

describe("Insights usage dashboard", () => {
  test("asks the usage API with the selection and shows KPIs with token classes", async () => {
    const view = await render({
      range: "30d",
      group: "model",
      model: "codex-subscription/codex/gpt-6.1-sol",
    });
    try {
      expect(requests[0]?.path).toBe(`/v1/workspaces/${WORKSPACE.workspaceId}/insights/usage`);
      expect(requests[0]?.query).toMatchObject({
        range: "30d",
        groupBy: "model",
        model: "codex-subscription/codex/gpt-6.1-sol",
      });
      const text = view.container.textContent ?? "";
      expect(text).toContain("Spend");
      expect(text).toContain("Cache hit rate");
      // Every token class with its share of cost.
      for (const label of ["Input", "Cache reads", "Cache writes", "Output"]) {
        expect(text).toContain(label);
      }
      expect(
        view.container.querySelector('[role="table"][aria-label="Tokens and cost by type"]'),
      ).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("names models and providers for people, never raw ids", async () => {
    const view = await render();
    try {
      const titles = breakdownTitles(view.container);
      expect(titles).toContain("GPT-6.1 Sol");
      expect(titles).toContain("Claude Opus 5.5");
      expect(titles).toContain("Grok 4.6");
      const text = view.container.textContent ?? "";
      expect(text).not.toContain("codex/gpt-6.1-sol");
      expect(text).not.toContain("organization-claude-subscription");
      expect(text).toContain("ChatGPT plan");
      expect(text).toContain("Claude plan");
    } finally {
      await view.unmount();
    }
  });

  test("an unpriced model reads as a dash, not $0.00 or Unknown", async () => {
    const view = await render();
    try {
      const grok = [...view.container.querySelectorAll('[role="row"]')].find((row) =>
        row.textContent?.includes("Grok 4.6"),
      );
      expect(grok?.textContent).toContain("—");
      expect(grok?.textContent).not.toContain("$0.00");
      expect(view.container.textContent).not.toContain("Unknown");
    } finally {
      await view.unmount();
    }
  });

  test("selecting a row filters to it and drills one level down", async () => {
    const view = await render();
    try {
      await act(async () => rowAction(view.container, "GPT-6.1 Sol")?.click());
      expect(view.changes.at(-1)).toEqual({
        group: "rootSession",
        model: "codex-subscription/codex/gpt-6.1-sol",
      });
    } finally {
      await view.unmount();
    }
  });

  test("switching the group-by keeps the filters", async () => {
    nextUsage = fixtureUsage({ groupBy: "payer" });
    const view = await render({ group: "payer", prov: "anthropic" });
    try {
      expect(breakdownTitles(view.container)).toEqual([
        "Plans",
        "Opengeni credits",
        "Your API keys",
      ]);
      expect(requests[0]?.query).toMatchObject({ groupBy: "payer", provider: "anthropic" });
    } finally {
      await view.unmount();
    }
  });

  test("other people's private chats are amount rows: no title, no link, not filterable", async () => {
    nextUsage = fixtureUsage({ groupBy: "rootSession" });
    const view = await render({ group: "rootSession" });
    try {
      const titles = breakdownTitles(view.container);
      expect(titles).toContain("Private chats");
      expect(titles).toContain("Deleted chats");
      expect(titles).toContain("Insights redesign");
      // The private row names the person only, and can't be opened or filtered.
      const privateRow = [...view.container.querySelectorAll('[role="row"]')].find((row) =>
        row.textContent?.startsWith("Private chats"),
      );
      expect(privateRow?.textContent).toContain("Ada Lovelace");
      expect(privateRow?.querySelector("button[data-row-action]")).toBeNull();
      const deletedRow = [...view.container.querySelectorAll('[role="row"]')].find((row) =>
        row.textContent?.startsWith("Deleted chats"),
      );
      expect(deletedRow?.querySelector("button[data-row-action]")).toBeNull();
      expect(deletedRow?.textContent).not.toContain("Private");
      // Readable sessions drill into their models.
      await act(async () => rowAction(view.container, "Insights redesign")?.click());
      expect(view.changes.at(-1)).toEqual({
        root: "aaaaaaaa-0000-4000-8000-000000000002",
      });
    } finally {
      await view.unmount();
    }
  });

  test("organization scope groups by workspace with Personal workspaces as amounts", async () => {
    nextUsage = fixtureUsage({
      groupBy: "workspace",
      scope: {
        kind: "organization",
        accountId: "22222222-2222-4222-8222-222222222222",
        workspaceId: null,
      },
    });
    const view = await render(
      { group: "workspace" },
      {
        kind: "organization",
        accountId: "22222222-2222-4222-8222-222222222222",
        workspaceId: null,
      },
    );
    try {
      expect(requests[0]?.path).toBe(
        "/v1/organizations/22222222-2222-4222-8222-222222222222/insights/usage",
      );
      const titles = breakdownTitles(view.container);
      expect(titles).toEqual(
        expect.arrayContaining([
          "Platform engineering",
          "Customer success",
          "Ada Lovelace's Personal",
        ]),
      );
      const personal = [...view.container.querySelectorAll('[role="row"]')].find((row) =>
        row.textContent?.startsWith("Ada Lovelace's Personal"),
      );
      expect(personal?.querySelector("button[data-row-action]")).toBeNull();
      await act(async () => rowAction(view.container, "Customer success")?.click());
      // Model is the default group-by, so the URL leaves it out.
      expect(view.changes.at(-1)).toEqual({ ws: "33333333-0000-4000-8000-000000000002" });
    } finally {
      await view.unmount();
    }
  });

  test("no comparison when the prior window had no calls", async () => {
    nextUsage = fixtureUsage({ prior: false });
    const view = await render();
    try {
      expect(view.container.textContent).not.toContain("vs the 30 days before");
    } finally {
      await view.unmount();
    }
  });

  test("recent calls never link other people's private or deleted chats", async () => {
    const call = (
      id: string,
      sessionKind: string,
      sessionId: string | null,
      title: string | null,
    ) => ({
      id,
      occurredAt: "2026-10-03T10:00:00.000Z",
      workspaceId: WORKSPACE.workspaceId,
      sessionId,
      sessionTitle: title,
      sessionKind,
      provider: "codex-subscription",
      model: "codex/gpt-6.1-sol",
      payer: "subscription",
      tokens: { uncachedInput: 10, cacheRead: 90, cacheWrite: 0, output: 5, reasoning: 1 },
      chargedMicros: 0,
      listMicros: 1_000,
    });
    nextCalls = [
      call("c1", "visible", "aaaaaaaa-0000-4000-8000-000000000009", "Ship it"),
      call("c2", "private", null, null),
      call("c3", "deleted", null, null),
    ];
    const view = await render({ tab: "calls" });
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(requests.some((request) => request.path.endsWith("/insights/calls"))).toBe(true);
      const text = view.container.textContent ?? "";
      expect(text).toContain("Private chat");
      expect(text).toContain("Deleted chat");
      const actions = [
        ...view.container.querySelectorAll<HTMLButtonElement>("button[data-row-action]"),
      ];
      expect(actions.map((button) => button.textContent)).toEqual(["Ship it"]);
      await act(async () => actions[0]?.click());
      expect(view.opened).toEqual([
        ["aaaaaaaa-0000-4000-8000-000000000009", WORKSPACE.workspaceId],
      ]);
    } finally {
      await view.unmount();
    }
  });

  test("one filter option per model name applies every id behind it", async () => {
    nextUsage = fixtureUsage();
    nextUsage.facets.models = [
      { provider: "organization-claude-subscription", model: "claude-opus-5-5" },
      { provider: "workspace-claude-subscription", model: "claude-opus-5-5" },
      { provider: "anthropic", model: "claude-opus-5-5" },
    ];
    const view = await render({
      model:
        "organization-claude-subscription/claude-opus-5-5,workspace-claude-subscription/claude-opus-5-5",
    });
    try {
      const chips = [...view.container.querySelectorAll('[aria-label="Active filters"] li')].map(
        (chip) => chip.textContent,
      );
      expect(chips).toEqual(["Model:Claude Opus 5.5 · Claude plan"]);
      await act(async () =>
        view.container
          .querySelector<HTMLButtonElement>('[aria-label^="Remove filter Model"]')
          ?.click(),
      );
      expect(view.changes.at(-1)).toEqual({});
    } finally {
      await view.unmount();
    }
  });

  test("a different workspace never shows the previous one's numbers", async () => {
    const view = await render();
    try {
      expect(breakdownTitles(view.container)).toContain("GPT-6.1 Sol");
    } finally {
      await view.unmount();
    }
    nextError = Object.assign(new Error("denied"), { status: 403 });
    const other = await render(
      {},
      { ...WORKSPACE, workspaceId: "99999999-9999-4999-8999-999999999999" },
    );
    try {
      expect(breakdownTitles(other.container)).toEqual([]);
    } finally {
      await other.unmount();
    }
  });

  test("falls back to the older Insights endpoint only when the route is missing", async () => {
    nextError = Object.assign(new Error("Resource not found."), { status: 404 });
    const getWorkspaceInsights = mock(async () => ({
      snapshot: {
        range: "week",
        windowStart: "2026-09-26T00:00:00.000Z",
        windowEnd: "2026-10-03T00:00:00.000Z",
        generatedAt: "2026-10-03T00:00:00.000Z",
        models: [
          {
            id: "m",
            model: "codex/gpt-6.1-sol",
            provider: "codex-subscription",
            billing: "external",
            calls: 10,
            inputTokens: 1_000,
            outputTokens: 100,
            cachedTokens: 900,
            cacheInputTokens: 1_000,
            cacheWriteTokens: 0,
            reasoningTokens: 20,
            totalTokens: 1_100,
            tokenKnownCalls: 10,
            cacheKnownCalls: 10,
            creditUsd: 0,
            estimatedProviderUsd: 2.5,
            estimatedProviderCostKnownCalls: 10,
            equivalentCreditUsd: 2.6,
            equivalentCreditCostKnownCalls: 10,
          },
        ],
        projects: [],
        drivers: [],
        privateChats: [],
        schedules: [],
        series: [],
        recentCalls: [],
        facets: [],
        priorCalls: 0,
        priorTotalTokens: 0,
        priorCreditUsd: 0,
        priorEstimatedProviderUsd: 0,
        priorEstimatedProviderCostKnownCalls: 0,
        driverGroups: 0,
        driversTruncated: false,
        dataThrough: null,
      },
    }));
    (context.client as Record<string, unknown>).getWorkspaceInsights = getWorkspaceInsights;
    const view = await render({ payer: "own_key" });
    try {
      expect(getWorkspaceInsights).toHaveBeenCalledTimes(1);
      expect(breakdownTitles(view.container)).toEqual(["GPT-6.1 Sol"]);
      expect(view.container.textContent).toContain("~$2.50");
      // The older endpoint can't filter by payer, and the page says so.
      expect(view.container.textContent).toContain("can't filter by paid with yet");
    } finally {
      await view.unmount();
    }
    // A handler's own 404 (an unknown workspace) is an error, not a missing route.
    resetUsageSourceMemo();
    nextError = Object.assign(new Error("workspace not found"), { status: 404 });
    getWorkspaceInsights.mockClear();
    const missing = await render();
    try {
      expect(getWorkspaceInsights).not.toHaveBeenCalled();
      expect(missing.container.textContent).toContain("Insights couldn't load");
    } finally {
      await missing.unmount();
    }
  });
});
