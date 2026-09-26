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
mock.module("@/components/insights/causal-sheet", () => ({ CausalSheet: () => null }));

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

async function renderRoute() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<InsightsRoute workspaceId={workspaceId} />);
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

describe("Insights route presentation", () => {
  test("shows a skeleton during the initial request", async () => {
    pendingResponse = new Promise<never>(() => undefined);
    const rendered = await renderRoute();
    try {
      expect(
        rendered.container.querySelector(
          '[role="status"][aria-label="Loading workspace insights"]',
        ),
      ).not.toBeNull();
      expect(rendered.container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
      expect(getWorkspaceInsights).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("shows a permission message without requesting usage", async () => {
    canRead = false;
    const rendered = await renderRoute();
    try {
      expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Workspace access required",
      );
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
      nextError = null;
      await click(rendered.container.querySelector<HTMLButtonElement>("button"));
      expect(getWorkspaceInsights).toHaveBeenCalledTimes(2);
      expect(rendered.container.textContent).toContain("Credits spent");
    } finally {
      await rendered.unmount();
    }
  });

  test("keeps filters, measure, and range available when usage is empty", async () => {
    nextSnapshot = snapshot({ models: [], modelCalls: 0 });
    const rendered = await renderRoute();
    try {
      expect(rendered.container.textContent).toContain("No model calls in this window");
      expect(rendered.container.querySelectorAll("select")).toHaveLength(2);
      expect(
        rendered.container.querySelector('[role="group"][aria-label="Usage measure"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[role="group"][aria-label="Time range"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[role="region"][aria-label="Usage by model"]'),
      ).not.toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  test("scopes to a root session through a keyboard-reachable driver action", async () => {
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
      await click(
        rendered.container.querySelector<HTMLButtonElement>(
          'button[aria-label="Scope to root session Refactor billing ledger"]',
        ),
      );
      expect(getWorkspaceInsights).toHaveBeenLastCalledWith(
        workspaceId,
        expect.objectContaining({ range: "week", rootSessionId }),
      );
      expect(rendered.container.textContent).toContain("Root session");
    } finally {
      await rendered.unmount();
    }
  });

  test("states exactly how much of the charged ledger the breakdown covers", async () => {
    const rendered = await renderRoute();
    try {
      expect(rendered.container.querySelector("[data-insights-ledger-gap]")?.textContent).toContain(
        "Per-model breakdowns cover $2.50 of the $3.00 charged. $0.50 has no per-call record yet",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("filters through a keyboard-reachable model action and preserves request shape", async () => {
    const rendered = await renderRoute();
    try {
      const button = rendered.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Filter by gpt-5 from OpenAI"]',
      );
      await click(button);
      expect(getWorkspaceInsights).toHaveBeenLastCalledWith(
        workspaceId,
        expect.objectContaining({
          range: "week",
          provider: "openai",
          model: "gpt-5",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(
        rendered.container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]'),
      ).not.toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});
