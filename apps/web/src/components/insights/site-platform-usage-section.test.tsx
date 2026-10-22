import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SitePlatformUsage } from "@opengeni/contracts";

let module: typeof import("./site-platform-usage-section");
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  module = await import("./site-platform-usage-section");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const platformUsage = (patch: Partial<SitePlatformUsage> = {}): SitePlatformUsage => ({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  periodStart: "2026-10-01",
  billingMode: "usage_only",
  meters: [
    meter("requests", 250_000, 1_000_000),
    meter("sql_rows_read", 1_200_000, 10_000_000),
    meter("sql_rows_written", 4_000, 100_000),
    meter("storage_bytes", 350_000_000, 1_000_000_000),
  ],
  estimatedMicros: 0,
  chargedMicros: 0,
  shadowMicros: 0,
  brake: { engaged: false, engagedAt: null },
  ...patch,
});

function meter(
  name: SitePlatformUsage["meters"][number]["meter"],
  used: number,
  allowance: number,
) {
  return {
    meter: name,
    used,
    peak: used,
    allowance,
    priceMicros: 1,
    priceUnit: 1_000_000,
    estimatedMicros: 0,
  };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function tiles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-slot="stat-tile"]')].map((tile) =>
    [...tile.querySelectorAll("p")].map((line) => line.textContent ?? "").join("|"),
  );
}

test("usage_only shows plain values like the KPI tiles, with no bars or limits", async () => {
  const view = await render(<module.SitePlatformUsageView usage={platformUsage()} />);
  const { container } = view;
  expect(container.querySelector('[data-slot="stat-group"]')).not.toBeNull();
  expect(tiles(container)).toEqual([
    "Requests|250K",
    "Rows read|1.2M",
    "Rows written|4K",
    "Storage|350 MB",
  ]);
  expect(container.querySelector('[data-slot="usage-meter"], [role="progressbar"]')).toBeNull();
  const text = container.textContent ?? "";
  expect(text).toContain("Platform activity this month. Not charged.");
  expect(text).not.toContain("included");
  expect(text).not.toContain("Sites are paused");
  await view.unmount();
});

test("credits mode shows what's included and charged, and an engaged brake explains the pause", async () => {
  const view = await render(
    <module.SitePlatformUsageView
      usage={platformUsage({
        billingMode: "credits",
        chargedMicros: 1_500_000,
        brake: { engaged: true, engagedAt: "2026-10-14T10:00:00.000Z" },
      })}
    />,
  );
  expect(tiles(view.container)[0]).toBe("Requests|250K|of 1M included");
  const text = view.container.textContent ?? "";
  expect(text).toContain("Use above what's included is paid with credits; $1.50 charged so far.");
  expect(text).toContain("Sites are paused");
  await view.unmount();
});

test("shadow mode shows what would have been charged", async () => {
  const view = await render(
    <module.SitePlatformUsageView
      usage={platformUsage({ billingMode: "shadow", shadowMicros: 400_000 })}
    />,
  );
  expect(view.container.textContent).toContain("Not charged yet; $0.40 would have been charged.");
  await view.unmount();
});

test("no meters draws no empty tile frame", async () => {
  const view = await render(<module.SitePlatformUsageView usage={platformUsage({ meters: [] })} />);
  expect(view.container.querySelector('[data-slot="stat-group"]')).toBeNull();
  await view.unmount();
});
