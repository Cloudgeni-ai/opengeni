import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SitePlatformUsage } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";

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

const usage = (patch: Partial<SitePlatformUsage> = {}): SitePlatformUsage => ({
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

test("shows each meter against its monthly allowance, not charged in usage_only", async () => {
  const view = await render(<module.SitePlatformUsageView usage={usage()} />);
  const text = view.container.textContent ?? "";
  expect(text).toContain("Published Sites");
  expect(text).toContain("Not charged.");
  expect(text).toContain("Requests");
  expect(text).toContain("Rows written");
  expect(text).toContain("of 1 GB");
  expect(text).not.toContain("Sites are paused");
  expect(text).not.toContain("charged this month");
  await view.unmount();
});

test("credits mode shows what was charged and an engaged brake explains the pause", async () => {
  const view = await render(
    <module.SitePlatformUsageView
      usage={usage({
        billingMode: "credits",
        chargedMicros: 1_500_000,
        brake: { engaged: true, engagedAt: "2026-10-14T10:00:00.000Z" },
      })}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Use above it is paid with credits.");
  expect(text).toContain("charged this month");
  expect(text).toContain("Sites are paused");
  await view.unmount();
});

test("shadow mode shows what would have been charged", async () => {
  const view = await render(
    <module.SitePlatformUsageView
      usage={usage({ billingMode: "shadow", shadowMicros: 400_000 })}
    />,
  );
  expect(view.container.textContent).toContain("would have been charged this month");
  await view.unmount();
});

test("the section hides where Sites aren't published and loads the usage otherwise", async () => {
  const hidden = await render(
    <module.SitePlatformUsageSection
      workspaceId="ws"
      client={{
        getSitePlatformUsage: async () => {
          throw new OpenGeniApiError(404, "missing", {});
        },
      }}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(hidden.container.textContent).toBe("");
  await hidden.unmount();

  const shown = await render(
    <module.SitePlatformUsageSection
      workspaceId="ws"
      client={{ getSitePlatformUsage: async () => usage() }}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(shown.container.textContent).toContain("Rows read");
  await shown.unmount();
});
