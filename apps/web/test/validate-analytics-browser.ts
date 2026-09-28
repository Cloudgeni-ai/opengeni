import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

// Exercise an isolated full dev stack. All telemetry is intercepted locally.
const baseUrl = process.env.OPENGENI_ANALYTICS_E2E_URL;
if (!baseUrl) throw new Error("Set OPENGENI_ANALYTICS_E2E_URL to an isolated full dev stack");
// The credit notice needs an empty-credit workspace. A stack without billing can
// opt out of those two checks explicitly; the rest still runs.
const skipCreditChecks = process.env.OPENGENI_ANALYTICS_E2E_SKIP_CREDITS === "1";
await validateAnalyticsJourney();
console.log("Analytics browser validation passed");

type RecordedEvent = { event: string; properties: Record<string, unknown> };

async function validateAnalyticsJourney() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const events: RecordedEvent[] = [];
    const consentReports: string[] = [];
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
    // The consent beacon reaches the real API; record only what the page sends.
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/v1/analytics-consent"
      )
        consentReports.push(request.postData() ?? "");
    });
    await page.exposeFunction(
      "recordJourneyTestEvent",
      (event: string, properties: Record<string, unknown>) => {
        events.push({ event, properties });
      },
    );
    await page.goto(baseUrl!);
    await page.getByText("What should the agent do?", { exact: true }).waitFor();
    assert.equal(events.length, 0);
    const workspaceId = new URL(page.url()).pathname.match(/^\/workspaces\/([^/]+)/)?.[1];
    if (!workspaceId) throw new Error("The app did not open a workspace");
    // Observe SDK capture without replacing application components or API responses.
    const source = await (
      await page.request.get(new URL("/src/lib/analytics.ts", baseUrl).href)
    ).text();
    const modulePath = source.match(/import\("([^"]*posthog-js[^"]*)"\)/)?.[1];
    if (!modulePath) throw new Error("Vite analytics module did not resolve PostHog");
    // Later full-page loads patch the provider before the app's first capture.
    await page.addInitScript(observePostHog, modulePath);
    await page.evaluate(observePostHog, modulePath);

    // Labelled package controls are present in the real composer DOM.
    assert.ok(await page.locator('button[data-analytics-action="send"]').count());

    const granted = page.waitForRequest(
      (request) =>
        request.method() === "POST" && new URL(request.url()).pathname === "/v1/analytics-consent",
    );
    await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
    await granted;
    assert.deepEqual(consentReports, [JSON.stringify({ decision: "granted" })]);
    await waitUntil(() => events.some((event) => event.event === "$pageview"));
    assert.equal(lastPageView(events)?.page, "sessions");

    // Key controls attach their closed action label to the click event.
    if (skipCreditChecks) {
      console.log("Skipped the credit notice checks (OPENGENI_ANALYTICS_E2E_SKIP_CREDITS=1)");
    } else {
      await waitUntil(() => events.some((event) => event.event === "credits_required_viewed"));
      await page.getByRole("link", { name: "Connect a model" }).first().click();
      await waitForEvent(events, "navigation_clicked", {
        action: "connect_model",
        destination_page: "settings",
        destination_section: "models",
      });
    }
    await page
      .getByRole("link", { name: /^New session/ })
      .first()
      .click();
    await waitForEvent(events, "navigation_clicked", {
      action: "new_session",
      destination_page: "sessions",
    });
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await waitForEvent(events, "navigation_clicked", { destination_page: "settings" });
    assert.ok(events.some((event) => event.event === "app_active"));
    assert.equal(
      events.some((event) => event.event === "login_completed"),
      false,
    );
    await page.getByText("Loading settings", { exact: true }).waitFor({ state: "hidden" });
    await page.screenshot({ path: "/tmp/opengeni-analytics-browser.png", fullPage: true });

    // Pages that used to be reported as "other".
    for (const [path, page_] of [
      ["agents", "agents"],
      ["variable-sets", "variable-sets"],
      ["rigs", "rigs"],
      ["plugins", "plugins"],
    ] as const) {
      await expectPageView(page, events, `/workspaces/${workspaceId}/${path}`, page_);
    }
    await expectPageView(page, events, "/device", "device");

    // Public sign-in and setup pages keep providers suspended: nothing is sent.
    for (const path of ["/reset-password", "/setup-account", "/account-auth"]) {
      const before: number = events.length;
      await page.goto(new URL(path, baseUrl).href);
      await page.waitForLoadState("networkidle");
      await Bun.sleep(500);
      assert.equal(events.length, before, `${path} must not send analytics`);
    }
    await expectPageView(page, events, `/workspaces/${workspaceId}/sessions`, "sessions");
    // Consent was already granted, so no second answer is counted.
    assert.equal(consentReports.length, 1);
  } finally {
    await browser.close();
  }
}

function observePostHog(providerModulePath: string) {
  void import(providerModulePath).then(({ default: posthog }) => {
    const capture = posthog.capture.bind(posthog);
    posthog.capture = (name: string, properties: Record<string, unknown>) => {
      (
        window as unknown as {
          recordJourneyTestEvent: (name: string, properties: Record<string, unknown>) => void;
        }
      ).recordJourneyTestEvent(name, properties);
      return capture(name, properties);
    };
  });
}

async function expectPageView(page: Page, events: RecordedEvent[], path: string, expected: string) {
  const before = events.length;
  await page.goto(new URL(path, baseUrl).href);
  await waitUntil(() =>
    events
      .slice(before)
      .some((event) => event.event === "$pageview" && event.properties.page === expected),
  );
}

async function waitForEvent(
  events: RecordedEvent[],
  name: string,
  properties: Record<string, unknown>,
) {
  await waitUntil(() =>
    events.some(
      (event) =>
        event.event === name &&
        Object.entries(properties).every(([key, value]) => event.properties[key] === value),
    ),
  );
}

function lastPageView(events: RecordedEvent[]): Record<string, unknown> | undefined {
  return events.filter((event) => event.event === "$pageview").at(-1)?.properties;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(50);
  assert.ok(predicate(), "Expected analytics event did not arrive");
}
