import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { InsightsSiteUsageResponse } from "@opengeni/contracts/insights-usage";

let components: typeof import("./site-ai-usage-section");
beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  components = await import("./site-ai-usage-section");
});
afterAll(() => GlobalRegistrator.unregister());

const usage: InsightsSiteUsageResponse = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  range: "month",
  windowStart: "2026-10-01T00:00:00Z",
  windowEnd: "2026-10-16T00:00:00Z",
  rows: [
    {
      siteId: "22222222-2222-4222-8222-222222222222",
      title: "Operations app",
      kind: "site",
      calls: 20,
      pricedCalls: 18,
      chargedMicros: 3_000_000,
      apiEquivalentMicros: 9_000_000,
      subscriptionApiEquivalentMicros: 5_000_000,
      ownKeyApiEquivalentMicros: 1_000_000,
    },
    {
      siteId: null,
      title: "Private or unavailable Sites",
      kind: "restricted",
      calls: 4,
      pricedCalls: 4,
      chargedMicros: 0,
      apiEquivalentMicros: 1_000_000,
      subscriptionApiEquivalentMicros: 1_000_000,
      ownKeyApiEquivalentMicros: 0,
    },
  ],
};

test("Site AI distinguishes actual charges and incomplete estimates without conversation links", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<components.SiteAiUsageView usage={usage} />));
    expect(container.querySelector("h3")?.textContent).toBe("Model costs");
    expect(container.textContent).not.toContain("Site AI");
    expect(container.textContent).toContain("Credits charged");
    expect(container.textContent).toContain("API-equivalent");
    expect(container.textContent).toContain("partial");
    expect(container.textContent).toContain("Private or unavailable Sites");
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.innerHTML).not.toContain(usage.rows[0]!.siteId!);
    expect(container.querySelector("td[title]")?.getAttribute("title")).toContain(
      "18 of 20 calls priced",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Site AI gives an explicit empty state and a bounded failure state", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<components.SiteAiUsageView usage={{ ...usage, rows: [] }} />),
    );
    expect(container.textContent).toContain("No model usage attributed to Sites");
    await act(async () =>
      root.render(
        <components.SiteAiUsageSection
          workspaceId={usage.workspaceId}
          range="month"
          client={{
            getWorkspaceInsightsSiteUsage: async () => {
              throw new Error("private diagnostics");
            },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain("Couldn’t load Site model costs.");
    expect(container.textContent).not.toContain("private diagnostics");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
