import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "22222222-2222-4222-8222-222222222222";
let canRead = true;
let nextSnapshot: WorkspaceInsightsSnapshot;
let nextError: Error | null = null;
let pendingResponse: Promise<never> | null = null;

const getWorkspaceInsights = mock(async () => {
  if (pendingResponse) return pendingResponse;
  if (nextError) throw nextError;
  return { snapshot: nextSnapshot };
});

const context = {
  workspaces: [{ id: workspaceId, name: "Product" }],
  get accessContext() {
    return {
      workspaceGrants: [{ workspaceId, permissions: canRead ? ["workspace:admin"] : [] }],
    };
  },
  client: { getWorkspaceInsights },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
// Chart interaction and animated counting have their own component tests; these
// route tests exercise the real toolbar, states, tables, and request wiring.
mock.module("@/components/insights/charts", () => ({
  AreaChart: () => <div data-test-chart="area" />,
  DonutChart: () => <div data-test-chart="donut" />,
  UsageMeter: ({ label }: { label: string }) => <div>{label}</div>,
  donutTone: () => "text-brand",
}));
mock.module("@/components/insights/count-up", () => ({
  CountUp: ({ value }: { value: number }) => <span>{value}</span>,
}));
const navigate = mock(async (_options: unknown) => undefined);
const RouterPackage = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({ ...RouterPackage, useNavigate: () => navigate }));

function snapshot(overrides: Partial<WorkspaceInsightsSnapshot> = {}): WorkspaceInsightsSnapshot {
  return {
    range: "week",
    rangeLabel: "Last 7 days (UTC)",
    priorLabel: "Prior 7 days",
    seriesLabel: "Token usage / UTC day",
    cacheSeriesLabel: "Cache hit % / UTC day",
    windowStart: "2026-09-18T00:00:00.000Z",
    windowEnd: "2026-09-25T00:00:00.000Z",
    generatedAt: "2026-09-25T00:00:00.000Z",
    timezone: "UTC",
    models: [
      {
        id: "openai:gpt-5:opengeni_credits",
        model: "gpt-5",
        provider: "openai",
        billing: "opengeni_credits",
        calls: 10,
        inputTokens: 1000,
        outputTokens: 100,
        cachedTokens: 400,
        cacheInputTokens: 1000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1100,
        tokenKnownCalls: 10,
        cacheKnownCalls: 10,
        creditUsd: 2.5,
        estimatedProviderUsd: 2,
        estimatedProviderCostKnownCalls: 8,
        equivalentCreditUsd: 2.1,
        equivalentCreditCostKnownCalls: 8,
      },
    ],
    facets: [{ provider: "openai", model: "gpt-5" }],
    series: [],
    depth: [],
    drivers: [],
    projects: [],
    schedules: [],
    recentCalls: [],
    promptContributions: {
      estimatedTokens: 0,
      utf8Bytes: 0,
      coveredCalls: 0,
      totalCalls: 0,
      sources: [],
    },
    warmSeconds: 0,
    priorWarmSeconds: 0,
    warmGroups: [],
    liveWarm: [],
    floor: [],
    selfhostedEnabled: false,
    machinesOnline: 0,
    workspaceCreditUsd: 3,
    priorWorkspaceCreditUsd: 1,
    creditUsd: 2.5,
    priorCreditUsd: 1,
    estimatedProviderUsd: 2,
    priorEstimatedProviderUsd: 1,
    estimatedProviderCostKnownCalls: 8,
    priorEstimatedProviderCostKnownCalls: 4,
    equivalentCreditUsd: 2.1,
    priorEquivalentCreditUsd: 1.05,
    equivalentCreditCostKnownCalls: 8,
    priorEquivalentCreditCostKnownCalls: 4,
    modelCalls: 10,
    priorInputTokens: 500,
    priorTotalTokens: 550,
    priorCacheHitPct: 20,
    priorCalls: 4,
    goalsActive: 1,
    goalsCompleted: 2,
    sessionsTouched: 3,
    rootSessions: 3,
    deepestDepth: 0,
    deepestSessionTitle: "",
    avgDepth: 0,
    warmIdleNow: 0,
    billableTokensUsed: 1000,
    billableTokenCap: 10_000,
    agentRunsUsed: 5,
    agentRunCap: 100,
    modelFilterActive: false,
    dataThrough: "2026-07-07T23:59:00.000Z",
    cacheHitPct: 40,
    scope: { rootSessionId: null, sessionId: null },
    driverGroups: 0,
    driversTruncated: false,
    facetsTruncated: false,
    recentCallsTruncated: false,
    privateChats: [],
    privateChatsTruncated: false,
    ...overrides,
  };
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
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
  canRead = true;
  nextSnapshot = snapshot();
  nextError = null;
  pendingResponse = null;
  getWorkspaceInsights.mockClear();
});

const { InsightsRoute } = await import("./insights");

async function renderRoute(props: Partial<Parameters<typeof InsightsRoute>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<InsightsRoute workspaceId={workspaceId} {...props} />);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function click(button: HTMLButtonElement | null) {
  expect(button).not.toBeNull();
  await act(async () => {
    button?.click();
  });
}

function tableRows(container: HTMLElement, label: string): string[][] {
  const table = container.querySelector(`[role="table"][aria-label="${label}"]`);
  return [...(table?.querySelectorAll('[role="rowgroup"]:last-child > [role="row"]') ?? [])].map(
    (row) =>
      [
        row.querySelector('[role="rowheader"] [id]')?.textContent ?? "",
        ...[...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent ?? ""),
      ].filter((cell, index, all) => !(index === all.length - 1 && cell === "")),
  );
}

function rowButton(container: HTMLElement, label: string, title: string): HTMLButtonElement | null {
  const table = container.querySelector(`[role="table"][aria-label="${label}"]`);
  return (
    [...(table?.querySelectorAll<HTMLButtonElement>("button[data-row-action]") ?? [])].find(
      (button) => button.textContent === title,
    ) ?? null
  );
}

describe("Insights route presentation", () => {
  test("shows loading tiles during the initial request", async () => {
    pendingResponse = new Promise<never>(() => undefined);
    const rendered = await renderRoute();
    try {
      expect(
        rendered.container.querySelector(
          '[role="status"][aria-label="Loading workspace insights"]',
        ),
      ).not.toBeNull();
      expect(
        rendered.container.querySelectorAll('[data-slot="stat-tile"][aria-busy]'),
      ).toHaveLength(4);
      expect(getWorkspaceInsights).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("opened from Billing & usage, the back link returns there", async () => {
    const rendered = await renderRoute({
      returnTo: { path: "/workspaces/w/organization?section=billing", label: "Billing & usage" },
    });
    try {
      const back = Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Billing & usage",
      );
      await click(back ?? null);
      expect(navigate).toHaveBeenCalledWith({ href: "/workspaces/w/organization?section=billing" });
    } finally {
      await rendered.unmount();
    }
    const plain = await renderRoute();
    try {
      expect(plain.container.textContent).not.toContain("Billing & usage");
    } finally {
      await plain.unmount();
    }
  });

  test("shows a calm permission line without requesting usage", async () => {
    canRead = false;
    const rendered = await renderRoute();
    try {
      expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Only workspace admins can see Insights",
      );
      expect(rendered.container.querySelector("button")).toBeNull();
      expect(getWorkspaceInsights).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  test("retries a failed load through the same insights API", async () => {
    nextError = new Error("Service unavailable");
    const rendered = await renderRoute();
    try {
      expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Insights couldn't load",
      );
      expect(rendered.container.textContent).not.toContain("Service unavailable");
      nextError = null;
      const retry = Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Try again",
      );
      await click(retry ?? null);
      expect(getWorkspaceInsights).toHaveBeenCalledTimes(2);
      expect(rendered.container.textContent).toContain("Paid with");
    } finally {
      await rendered.unmount();
    }
  });

  test("a refusal from the server reads as missing access, without the raw API string", async () => {
    nextError = Object.assign(
      new Error("OpenGeni API 403: missing permission: workspace:admin Reference: req_403."),
      { status: 403 },
    );
    const rendered = await renderRoute();
    try {
      const alert = rendered.container.querySelector('[role="alert"]')?.textContent ?? "";
      expect(alert).toContain("Only workspace admins can see Insights");
      expect(alert).not.toContain("Insights couldn't load");
      expect(rendered.container.textContent).not.toContain("OpenGeni API");
      expect(rendered.container.textContent).not.toContain("req_403");
      expect(
        Array.from(rendered.container.querySelectorAll("button")).some(
          (button) => button.textContent === "Try again",
        ),
      ).toBe(false);
    } finally {
      nextError = null;
      await rendered.unmount();
    }
  });

  test("an empty period keeps the period control and says why nothing shows", async () => {
    nextSnapshot = snapshot({ models: [], modelCalls: 0 });
    const rendered = await renderRoute();
    try {
      expect(rendered.container.textContent).toContain("No model calls in this period");
      expect(
        rendered.container.querySelector(
          '[role="radiogroup"][aria-label="Period"], [aria-label="Period"]',
        ),
      ).not.toBeNull();
      expect(rendered.container.textContent).not.toContain("Paid with");
    } finally {
      await rendered.unmount();
    }
  });

  test("splits spend by who pays: credits charged, plans and own keys at list price", async () => {
    const base = snapshot().models[0]!;
    nextSnapshot = snapshot({
      models: [
        base,
        {
          ...base,
          id: "codex-subscription:gpt-6:external",
          provider: "codex-subscription",
          model: "gpt-6",
          billing: "external",
          creditUsd: 0,
          estimatedProviderUsd: 4,
          estimatedProviderCostKnownCalls: 10,
        },
        {
          ...base,
          id: "workspace-gateway:claude:external",
          provider: "workspace-gateway",
          model: "claude",
          billing: "external",
          creditUsd: 0,
          estimatedProviderUsd: 1,
          estimatedProviderCostKnownCalls: 4,
        },
      ],
    });
    const rendered = await renderRoute();
    try {
      expect(tableRows(rendered.container, "Spend by who pays")).toEqual([
        ["Opengeni credits", "$2.50", "10", "1.1K"],
        ["Subscriptions", "~$4.00", "10", "1.1K"],
        ["Your API keys", "~$1.00", "10", "1.1K"],
      ]);
      expect(rendered.container.textContent).toContain("4 of 10 calls priced");
      const models = tableRows(rendered.container, "Usage by model");
      expect(models.map((row) => [row[0], row[1]])).toEqual([
        ["gpt-5", "$2.50"],
        ["gpt-6", "~$4.00"],
        ["claude", "~$1.00"],
      ]);
      const table = rendered.container.querySelector('[role="table"][aria-label="Usage by model"]');
      expect(table?.textContent).toContain("ChatGPT plan");
      expect(table?.textContent).toContain("Your API key");
    } finally {
      await rendered.unmount();
    }
  });

  const privateChats = (overrides: Partial<WorkspaceInsightsSnapshot> = {}) =>
    snapshot({
      privateChats: [
        {
          ownerKey: "owner-2",
          name: "Kari Hansen",
          you: false,
          calls: 1,
          tokens: 200,
          creditUsd: 0,
          estimatedProviderUsd: 1.5,
          estimatedProviderCostKnownCalls: 1,
        },
        {
          ownerKey: "owner-1",
          name: "Ola Nordmann",
          you: false,
          calls: 3,
          tokens: 900,
          creditUsd: 12.4,
          estimatedProviderUsd: 6,
          estimatedProviderCostKnownCalls: 3,
        },
      ],
      ...overrides,
    });

  test("lists other people's private chats as plain amounts per person, largest first", async () => {
    nextSnapshot = privateChats();
    const rendered = await renderRoute();
    try {
      expect(tableRows(rendered.container, "Private chats by person")).toEqual([
        ["Ola Nordmann", "$12.40", "~$6.00", "900", "3"],
        ["Kari Hansen", "$0.00", "~$1.50", "200", "1"],
      ]);
      const table = rendered.container.querySelector(
        '[role="table"][aria-label="Private chats by person"]',
      );
      // Amounts only: no row is a link, a button or anything focusable.
      expect(
        table?.querySelectorAll("a, button, [role=button], [role=link], [tabindex]"),
      ).toHaveLength(0);
      expect(table?.querySelector(".cursor-pointer")).toBeNull();
      expect(tableRows(rendered.container, "Usage by session")).toEqual([]);
      expect(rendered.container.textContent).toContain(
        "Other people's Only me chats, already counted above. Amounts only.",
      );
      expect(rendered.container.textContent).not.toContain("Showing the largest 200.");
      for (const caveat of ["isn't included", "aren't included", "not included"]) {
        expect(rendered.container.textContent).not.toContain(caveat);
      }
    } finally {
      await rendered.unmount();
    }
  });

  test("says when the private list is cut to the largest 200", async () => {
    nextSnapshot = privateChats({ privateChatsTruncated: true });
    const rendered = await renderRoute();
    try {
      expect(rendered.container.textContent).toContain("Showing the largest 200.");
    } finally {
      await rendered.unmount();
    }
  });

  test("a session scope hides every private-chat line instead of showing it empty", async () => {
    nextSnapshot = privateChats({
      projects: [
        {
          id: "unavailable",
          kind: "unavailable",
          label: "Unavailable",
          projects: 0,
          rootSessions: 1,
          calls: 2,
          tokens: 300,
          creditUsd: 1,
          estimatedProviderUsd: 0,
          estimatedProviderCostKnownCalls: 0,
          cacheHitPct: null,
        },
      ],
    });
    const rendered = await renderRoute({
      search: { root: "33333333-3333-4333-8333-333333333333" },
    });
    try {
      expect(
        rendered.container.querySelector('[role="table"][aria-label="Private chats by person"]'),
      ).toBeNull();
      expect(rendered.container.textContent).not.toContain("Only me");
      expect(rendered.container.textContent).not.toContain("private ones included");
      expect(rendered.container.textContent).not.toContain("Private chats");
    } finally {
      await rendered.unmount();
    }
  });

  test("a failed refresh keeps the last data and gives advice, not the raw error", async () => {
    const rendered = await renderRoute();
    try {
      nextError = Object.assign(new Error("OpenGeni API 500: boom Reference: req_500."), {
        status: 500,
      });
      const month = Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Month",
      );
      await click(month ?? null);
      const alert = rendered.container.querySelector('[role="alert"]')?.textContent ?? "";
      expect(alert).toContain("Couldn't refresh Insights");
      expect(alert).toContain("Try again");
      expect(rendered.container.textContent).not.toContain("OpenGeni API");
      expect(rendered.container.textContent).not.toContain("req_500");
      expect(rendered.container.textContent).toContain("Paid with");
    } finally {
      nextError = null;
      await rendered.unmount();
    }
  });

  test("scopes to a root session from its row", async () => {
    const rootSessionId = "33333333-3333-4333-8333-333333333333";
    nextSnapshot = snapshot({
      drivers: [
        {
          id: `root:${rootSessionId}`,
          groupBy: "root_session",
          label: "Refactor billing ledger",
          creditUsd: 2.5,
          estimatedProviderUsd: 2,
          estimatedProviderCostKnownCalls: 8,
          equivalentCreditUsd: 2.1,
          equivalentCreditCostKnownCalls: 8,
          tokens: 1100,
          cacheHitPct: 40,
          pctOfCreditUsd: 100,
          pctOfTokens: 100,
          deltaUsdVsPrior: 0,
        },
      ],
      driverGroups: 1,
    });
    const rendered = await renderRoute();
    try {
      await click(rowButton(rendered.container, "Usage by session", "Refactor billing ledger"));
      expect(getWorkspaceInsights).toHaveBeenLastCalledWith(
        workspaceId,
        expect.objectContaining({ range: "week", rootSessionId }),
      );
      expect(rendered.container.textContent).toContain("SessionRefactor billing ledger");
    } finally {
      await rendered.unmount();
    }
  });

  test("states exactly how much of the charged ledger the breakdown covers", async () => {
    const rendered = await renderRoute();
    try {
      expect(rendered.container.querySelector("[data-insights-ledger-gap]")?.textContent).toContain(
        "$0.50 of the $3.00 charged has no per-call record yet",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("lists project usage with an explicit unfiled row and unknown list prices", async () => {
    const row = {
      projects: 1,
      rootSessions: 1,
      calls: 2,
      creditUsd: 1.5,
      estimatedProviderUsd: 0,
      estimatedProviderCostKnownCalls: 0,
      cacheHitPct: null,
    };
    nextSnapshot = snapshot({
      projects: [
        {
          ...row,
          id: "project:billing",
          kind: "project",
          label: "Billing",
          tokens: 750,
          estimatedProviderUsd: 1.25,
          estimatedProviderCostKnownCalls: 1,
        },
        { ...row, id: "unfiled", kind: "unfiled", label: "No project", tokens: 250 },
        { ...row, id: "unavailable", kind: "unavailable", label: "Unavailable", tokens: 0 },
      ],
    });
    const rendered = await renderRoute();
    try {
      const rows = tableRows(rendered.container, "Usage by project");
      expect(rows.map((cells) => [cells[0], cells[3], cells[5]])).toEqual([
        ["Billing", "75%", "~$1.25"],
        ["No project", "25%", "Unknown"],
        ["Private chats", "0%", "Unknown"],
      ]);
    } finally {
      await rendered.unmount();
    }
  });

  test("pushes filter changes to history and replaces only an invalid URL", async () => {
    const onSearchChange = mock((..._args: unknown[]) => undefined);
    const rendered = await renderRoute({
      search: { range: "bogus", provider: "openai", root: "not-a-uuid" },
      onSearchChange,
    });
    try {
      expect(onSearchChange).toHaveBeenCalledWith({ provider: "openai" }, { replace: true });
      onSearchChange.mockClear();
      await click(rowButton(rendered.container, "Usage by model", "gpt-5"));
      expect(onSearchChange).toHaveBeenCalledTimes(1);
      expect(onSearchChange.mock.calls[0]).toEqual([{ provider: "openai", model: "gpt-5" }]);
    } finally {
      await rendered.unmount();
    }
  });

  test("shows unknown token and cache values instead of zero", async () => {
    nextSnapshot = snapshot({
      models: [
        {
          ...snapshot().models[0]!,
          totalTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          tokenKnownCalls: 0,
          cacheKnownCalls: 0,
        },
      ],
    });
    const rendered = await renderRoute();
    try {
      const [cells] = tableRows(rendered.container, "Usage by model");
      expect(cells?.[2]).toBe("Unknown");
      expect(cells?.[4]).toBe("Unknown");
    } finally {
      await rendered.unmount();
    }
  });

  test("filters by a model from its row and preserves the request shape", async () => {
    const rendered = await renderRoute();
    try {
      await click(rowButton(rendered.container, "Usage by model", "gpt-5"));
      expect(getWorkspaceInsights).toHaveBeenLastCalledWith(
        workspaceId,
        expect.objectContaining({
          range: "week",
          provider: "openai",
          model: "gpt-5",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(rowButton(rendered.container, "Usage by model", "gpt-5")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  test("the Activity tab holds the workspace-wide sections", async () => {
    const rendered = await renderRoute();
    try {
      const activity = Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Activity",
      );
      await click(activity ?? null);
      expect(rendered.container.textContent).toContain("Live now");
      expect(rendered.container.textContent).toContain("Sandbox time");
      expect(rendered.container.textContent).not.toContain("Paid with");
    } finally {
      await rendered.unmount();
    }
  });
});
