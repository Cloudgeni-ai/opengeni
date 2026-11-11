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
    {
      siteId: "33333333-3333-4333-8333-333333333333",
      title: "Unpriced app",
      kind: "site",
      calls: 3,
      pricedCalls: 0,
      chargedMicros: 0,
      apiEquivalentMicros: 0,
      subscriptionApiEquivalentMicros: 0,
      ownKeyApiEquivalentMicros: 0,
    },
  ],
};

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function cellTexts(container: HTMLElement, title: string): string[] {
  const row = [...container.querySelectorAll('[role="row"]')].find((candidate) =>
    candidate.textContent?.includes(title),
  );
  return [...(row?.querySelectorAll('[role="cell"]') ?? [])].map((cell) =>
    (cell.textContent ?? "").trim(),
  );
}

test("model costs by Site use the Breakdown table with its money formatting", async () => {
  const view = await render(<components.SiteAiUsageTable usage={usage} />);
  const { container } = view;
  const table = container.querySelector('[role="table"]');
  expect(table?.getAttribute("aria-label")).toBe("Model costs by Site");
  const headers = [...container.querySelectorAll('[role="columnheader"]')].map((cell) =>
    (cell.textContent ?? "").trim(),
  );
  expect(headers.slice(0, 4)).toEqual(["Site", "Calls", "Charged", "API-equivalent"]);
  // Estimates carry the page's "~"; a partly priced amount gets the Breakdown asterisk.
  expect(cellTexts(container, "Operations app").join("|")).toContain("20|$3.00|~$9.00*");
  expect(cellTexts(container, "Private or unavailable Sites").join("|")).toContain(
    "4|$0.00|~$1.00",
  );
  // Nothing priced: a dash with its reason, never a misleading $0.
  expect(cellTexts(container, "Unpriced app").join("|")).toContain("3|$0.00|—");
  expect(container.querySelector('[aria-label="Not priced"]')).not.toBeNull();
  // The subscription / own-key split is a focusable tooltip, not a hover-only title.
  expect(container.querySelector("[title]")).toBeNull();
  const estimate = [...container.querySelectorAll<HTMLElement>('[tabindex="0"]')].find(
    (element) => element.textContent === "~$9.00",
  );
  expect(estimate).toBeDefined();
  await act(async () => estimate!.click());
  expect(estimate!.getAttribute("data-state")).toEndWith("open");
  // Radix skips portals when it first loaded without a DOM (other files in one process).
  const tooltip = document.querySelector('[data-slot="reason-tooltip"]');
  if (tooltip) expect(tooltip.textContent).toContain("Subscriptions: $5.00; own API keys: $1.00.");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  // Folded on a phone, a row keeps the charge and the estimate, not just the estimate.
  const phoneHidden = [...container.querySelectorAll("span")]
    .filter((span) => span.textContent === "Charged " || span.textContent === "API-equivalent ")
    .map((label) => label.parentElement?.className.includes("@max-[479px]/list:hidden"));
  expect(phoneHidden.length).toBeGreaterThan(0);
  expect(phoneHidden.every((hidden) => hidden === false)).toBe(true);
  expect(container.querySelectorAll("a")).toHaveLength(0);
  expect(container.innerHTML).not.toContain(usage.rows[0]!.siteId!);
  await view.unmount();
});

test("an empty period says so instead of drawing an empty table", async () => {
  const view = await render(<components.SiteAiUsageTable usage={{ ...usage, rows: [] }} />);
  expect(view.container.querySelector('[role="table"]')).toBeNull();
  expect(view.container.textContent).toBe("No model usage attributed to Sites in this period.");
  await view.unmount();
});
