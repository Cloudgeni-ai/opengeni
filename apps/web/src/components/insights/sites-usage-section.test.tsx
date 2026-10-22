import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SitePlatformUsage } from "@opengeni/contracts";
import type { InsightsSiteUsageResponse } from "@opengeni/contracts/insights-usage";
import { SectionVariantProvider } from "@opengeni/react/ui/section-variant";
import { OpenGeniApiError } from "@opengeni/sdk";

let module: typeof import("./sites-usage-section");
beforeAll(async () => {
  GlobalRegistrator.register({ url: "https://example.test" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  module = await import("./sites-usage-section");
});
afterAll(() => GlobalRegistrator.unregister());

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const siteUsage: InsightsSiteUsageResponse = {
  workspaceId: WORKSPACE,
  range: "week",
  windowStart: "2026-10-16T00:00:00Z",
  windowEnd: "2026-10-22T12:00:00Z",
  rows: [
    {
      siteId: "22222222-2222-4222-8222-222222222222",
      title: "Opengeni usage",
      kind: "site",
      calls: 50,
      pricedCalls: 50,
      chargedMicros: 0,
      apiEquivalentMicros: 608_000,
      subscriptionApiEquivalentMicros: 608_000,
      ownKeyApiEquivalentMicros: 0,
    },
  ],
};

const platformUsage: SitePlatformUsage = {
  workspaceId: WORKSPACE,
  periodStart: "2026-10-01",
  billingMode: "usage_only",
  meters: [
    {
      meter: "requests",
      used: 3_000,
      peak: 3_000,
      allowance: 1_000_000,
      priceMicros: 1,
      priceUnit: 1_000_000,
      estimatedMicros: 0,
    },
  ],
  estimatedMicros: 0,
  chargedMicros: 0,
  shadowMicros: 0,
  brake: { engaged: false, engagedAt: null },
};

type Client = Parameters<typeof module.SitesUsageSection>[0]["client"];

function client(patch: Partial<Record<keyof Client, () => Promise<unknown>>> = {}) {
  const calls: string[] = [];
  const value = {
    getWorkspaceInsightsSiteUsage: async (
      _workspaceId: string,
      query: { range: string },
    ): Promise<InsightsSiteUsageResponse> => {
      calls.push(`site-usage:${query.range}`);
      return ((await patch.getWorkspaceInsightsSiteUsage?.()) ??
        siteUsage) as InsightsSiteUsageResponse;
    },
    getSitePlatformUsage: async (): Promise<SitePlatformUsage> => {
      calls.push("platform");
      return ((await patch.getSitePlatformUsage?.()) ?? platformUsage) as SitePlatformUsage;
    },
  } as unknown as Client;
  return { value, calls };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("one flat Sites section even inside the settings shell's grouped cards", async () => {
  const { value } = client();
  const view = await render(
    <SectionVariantProvider variant="group">
      <module.SitesUsageSection client={value} workspaceId={WORKSPACE} range="week" />
    </SectionVariantProvider>,
  );
  const { container } = view;
  const sections = container.querySelectorAll('[data-slot="section"]');
  expect(sections).toHaveLength(1);
  expect(sections[0]?.getAttribute("data-variant")).toBe("open");
  expect([...container.querySelectorAll("h2, h3")].map((heading) => heading.textContent)).toEqual([
    "Sites",
  ]);
  // Rows sit on the page: no bordered card around the table or the tiles.
  expect(container.querySelector('[data-slot="section-content"]')?.className).not.toContain(
    "border",
  );
  expect(container.querySelector('[role="table"]')).not.toBeNull();
  expect(container.querySelector('[data-slot="stat-group"]')).not.toBeNull();
  await view.unmount();
});

test("a custom range skips model costs and still shows platform activity", async () => {
  const { value, calls } = client();
  const view = await render(
    <module.SitesUsageSection client={value} workspaceId={WORKSPACE} range={null} />,
  );
  expect(calls).toEqual(["platform"]);
  expect(view.container.querySelector('[role="table"]')).toBeNull();
  expect(view.container.textContent).toContain("Requests");
  await view.unmount();
});

test("nothing to show renders no heading; failures say what didn't load", async () => {
  const hidden = client({
    getSitePlatformUsage: async () => {
      throw new OpenGeniApiError(404, "missing", {});
    },
  });
  const empty = await render(
    <module.SitesUsageSection client={hidden.value} workspaceId={WORKSPACE} range={null} />,
  );
  expect(empty.container.textContent).toBe("");
  await empty.unmount();

  const failing = client({
    getWorkspaceInsightsSiteUsage: async () => {
      throw new Error("private diagnostics");
    },
    getSitePlatformUsage: async () => {
      throw new OpenGeniApiError(500, "boom", {});
    },
  });
  const failed = await render(
    <module.SitesUsageSection client={failing.value} workspaceId={WORKSPACE} range="week" />,
  );
  const text = failed.container.textContent ?? "";
  expect(text).toContain("Sites");
  expect(text).toContain("Couldn't load Site model costs.");
  expect(text).toContain("Couldn't load Site platform activity.");
  expect(text).not.toContain("private diagnostics");
  await failed.unmount();
});
