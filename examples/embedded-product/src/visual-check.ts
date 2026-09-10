// Targeted synthetic browser acceptance. No backend key, provider or model calls.
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import type { ConnectAttempt } from "@opengeni/connect";
const output = process.env.EMBED_VISUAL_OUTPUT ?? "/workspace/.agent/embedding-ui";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.EMBED_CHROMIUM ?? "/usr/local/bin/chromium",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();
let disconnected = false;
let denied = false;
const site = {
  id: "fixture-site",
  workspaceId: "fixture-workspace",
  accountId: "fixture-org",
  title: "Team overview",
  description: "Shared team information",
  status: "active",
  currentVersion: {
    id: "fixture-version",
    revision: 1,
    requestedTools: [],
    createdAt: "2026-09-08T00:00:00Z",
  },
};
let schedule: {
  id: string;
  name: string;
  status: string;
  agentConfig: { prompt: string };
  schedule: { type: string; everySeconds: number };
} | null = null;
let triggered = false;
let attempt: ConnectAttempt = {
  id: "fixture-attempt",
  workspaceId: "fixture-workspace",
  providerId: "fixture-calendar",
  ownership: "personal",
  revision: 1,
  state: "connected_but_incomplete",
  credentialsCommitted: true,
  integrationInstalled: false,
  completionRequirement: "integration",
  nextAction: { type: "none" },
  expiresAt: "2030-01-01T00:00:00Z",
};
const provider = {
  id: "fixture-calendar",
  label: "Calendar",
  family: "fixture",
  readiness: "available",
  ownership: ["personal", "workspace"],
  setup: ["oauth"],
};
const account = {
  id: "fixture-account",
  version: 3,
  providerId: provider.id,
  label: "Taylor’s calendar",
  ownership: "personal",
  status: "connected",
};
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  const method = route.request().method();
  if (denied) return route.fulfill({ status: 403, json: { error: "denied" } });
  let json: unknown;
  if (path === "/api/schedules" && method === "GET") json = schedule ? [schedule] : [];
  else if (path === "/api/schedules" && method === "POST") {
    const input = route.request().postDataJSON();
    schedule = {
      id: "fixture-task",
      name: input.name,
      status: "paused",
      agentConfig: { prompt: input.prompt },
      schedule: input.schedule,
    };
    json = schedule;
  } else if (path === "/api/schedules/fixture-task/trigger") {
    if (!route.request().postDataJSON().triggerId)
      throw new Error("Missing manual trigger identity");
    triggered = true;
    json = schedule;
  } else if (path === "/api/schedules/fixture-task" && method === "DELETE") {
    schedule = null;
    json = {};
  } else if (path === "/api/context")
    json = { workspaceId: "fixture-workspace", returnUrl: "http://127.0.0.1:3102/?same=%2f#exact" };
  else if (path.endsWith("/catalog"))
    json = [
      provider,
      {
        ...provider,
        id: "fixture-drive",
        label: "Drive (operator setup needed)",
        readiness: "needs_configuration",
      },
    ];
  else if (path === "/api/connect/accounts") json = disconnected ? [] : [account];
  else if (path === "/api/connect/accounts/fixture-account" && method === "DELETE") {
    if (new URL(route.request().url()).searchParams.get("expectedVersion") !== "3")
      throw new Error("Missing observed version");
    disconnected = true;
    json = {};
  } else if (path === "/api/connect/attempts") json = method === "GET" ? [attempt] : attempt;
  else if (path.endsWith("/advance")) {
    const input = route.request().postDataJSON();
    if (input.action.type === "retry")
      attempt = {
        ...attempt,
        revision: 2,
        state: "preview",
        nextAction: {
          type: "preview",
          previewId: "preview",
          contentHash: "hash",
          operations: [
            { id: "read", label: "Read events", kind: "read" },
            { id: "write", label: "Create event", kind: "write" },
          ],
        },
      };
    else {
      if (JSON.stringify(input.action.operationIds) !== '["read"]')
        throw new Error("Unexpected operation expansion");
      attempt = {
        ...attempt,
        revision: 3,
        state: "complete",
        integrationInstalled: true,
        nextAction: { type: "none" },
      };
    }
    json = attempt;
  } else if (path === "/api/connect/attempts/fixture-attempt") json = attempt;
  else if (path === "/api/sites") json = { artifacts: [site], nextCursor: null, truncated: false };
  else if (path === "/api/sites/fixture-site")
    json = {
      artifact: site,
      versions: [site.currentVersion],
      events: [],
      versionsTruncated: false,
      eventsTruncated: false,
    };
  else if (path === "/api/sites/fixture-site/html") {
    if (new URL(route.request().url()).searchParams.get("versionId") !== "fixture-version")
      throw new Error("Site HTML request lost its observed version");
    json =
      "<!doctype html><html lang='en'><title>Team overview</title><body><main><h1>Team overview</h1><p>Shared information, rendered without downloading source.</p></main></body></html>";
  } else return route.fulfill({ status: 404, json: {} });
  return route.fulfill({ json });
});
try {
  await page.goto("http://127.0.0.1:3102");
  await page.getByRole("button", { name: "Disconnect Taylor’s calendar" }).waitFor();
  await page.getByRole("button", { name: "Team overview" }).click();
  await page.getByRole("button", { name: "Edit with agent" }).waitFor();
  await page
    .frameLocator('iframe[title="Team overview"]')
    .getByRole("heading", { name: "Team overview" })
    .waitFor();
  await page.screenshot({ path: `${output}/07-site-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/08-site-mobile.png`, fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error("Site mobile overflow");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole("button", { name: "Back to Sites" }).click();
  await page.screenshot({ path: `${output}/01-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "fixture-calendar — connected but incomplete" }).click();
  await page.getByRole("button", { name: "Review integration operations" }).click();
  await page.getByLabel("Read events (read)").check();
  await page.screenshot({ path: `${output}/02-explicit-selection.png`, fullPage: true });
  await page.getByRole("button", { name: "Install selected operations" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Connection ready$/ })
    .waitFor();
  await page.getByRole("button", { name: "Disconnect Taylor’s calendar" }).click();
  await page.screenshot({ path: `${output}/03-confirmation.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirm disconnect" }).click();
  await page.getByText("No connected accounts.").waitFor();
  const schedules = page.getByRole("region", { name: "Scheduled tasks" });
  await schedules.getByLabel("Name", { exact: true }).fill("Review recent work");
  await schedules
    .getByLabel("Prompt", { exact: true })
    .fill("Summarize recent changes; ask before any write.");
  await schedules.getByLabel("Deployment model ID").fill("fixture-model");
  await schedules.getByRole("button", { name: "Create paused task" }).click();
  await schedules.getByRole("heading", { name: "Review recent work — paused" }).waitFor();
  await schedules.getByRole("button", { name: "Run now…" }).click();
  if (triggered) throw new Error("Schedule triggered before confirmation");
  await page.screenshot({ path: `${output}/06-schedule-confirmation.png`, fullPage: true });
  await schedules.getByRole("button", { name: "Confirm trigger" }).click();
  await schedules.getByRole("button", { name: "Delete…" }).click();
  await schedules.getByRole("button", { name: "Confirm delete" }).click();
  await schedules
    .getByRole("heading", { name: "Review recent work — paused" })
    .waitFor({ state: "detached" });
  if (!triggered) throw new Error("Confirmed schedule trigger was not sent");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/04-mobile.png`, fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error("Mobile horizontal overflow");
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  if (accessibility.violations.length)
    throw new Error(
      `Accessibility violations: ${accessibility.violations.map((entry) => entry.id).join(", ")}`,
    );
  denied = true;
  await page.getByRole("button", { name: "Reload accounts" }).click();
  await page.getByText("Account state could not be confirmed.", { exact: false }).waitFor();
  await page.screenshot({ path: `${output}/05-access-loss.png`, fullPage: true });
  console.log(
    "PASS: version-pinned HTML-only Sites and product-owned edit UI, explicit operation selection, versioned disconnect confirmation, paused schedule creation and confirmed trigger/delete, mobile overflow, WCAG scan, access-loss state; 8 screenshots",
  );
} finally {
  await browser.close();
}
