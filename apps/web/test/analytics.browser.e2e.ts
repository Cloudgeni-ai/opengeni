import { expect, test } from "bun:test";
import { chromium } from "playwright";

// Exercise an isolated full dev stack. All telemetry is intercepted locally.
const baseUrl = process.env.OPENGENI_ANALYTICS_E2E_URL;
test.skipIf(!baseUrl)(
  "real composer emits consented browsing and visible credit blockers",
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
      await page.route("**/v1/config/client", async (route) => {
        const response = await route.fetch();
        const config = await response.json();
        config.analytics = {
          consentRequired: true,
          providers: {
            posthog: {
              projectKey: "phc_analytics_test",
              host: new URL("/posthog-test", baseUrl).href,
            },
          },
        };
        await route.fulfill({ response, json: config });
      });
      await page.route("**/posthog-test/**", async (route) => {
        // Never forward the synthetic project to an external provider.
        await route.fulfill({ json: { status: 1, featureFlags: {}, supportedCompression: [] } });
      });
      await page.exposeFunction(
        "recordJourneyTestEvent",
        (event: string, properties: Record<string, unknown>) => {
          events.push({ event, properties });
        },
      );
      await page.goto(baseUrl!);
      await page.getByText("What should the agent do?", { exact: true }).waitFor();
      expect(events.length).toBe(0);
      // Observe SDK capture without replacing application components or API responses.
      const source = await (
        await page.request.get(new URL("/src/lib/analytics.ts", baseUrl).href)
      ).text();
      const modulePath = source.match(/import\("([^"]*posthog-js[^"]*)"\)/)?.[1];
      if (!modulePath) throw new Error("Vite analytics module did not resolve PostHog");
      await page.evaluate(async (providerModulePath: string) => {
        const { default: posthog } = await import(providerModulePath);
        const capture = posthog.capture.bind(posthog);
        posthog.capture = (name: string, properties: Record<string, unknown>) => {
          (
            window as unknown as {
              recordJourneyTestEvent: (name: string, properties: Record<string, unknown>) => void;
            }
          ).recordJourneyTestEvent(name, properties);
          return capture(name, properties);
        };
      }, modulePath);
      await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
      await waitUntil(() => events.some((event) => event.event === "$pageview"));
      await waitUntil(() => events.some((event) => event.event === "credits_required_viewed"));
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await waitUntil(() => events.some((event) => event.event === "navigation_clicked"));
      expect(events.some((event) => event.event === "app_active")).toBe(true);
      expect(events.some((event) => event.event === "login_completed")).toBe(false);
      await page.getByText("Loading settings", { exact: true }).waitFor({ state: "hidden" });
    await page.screenshot({ path: "/tmp/opengeni-analytics-browser.png", fullPage: true });
    } finally {
      await browser.close();
    }
  },
  60_000,
);

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(50);
  expect(predicate()).toBe(true);
}
