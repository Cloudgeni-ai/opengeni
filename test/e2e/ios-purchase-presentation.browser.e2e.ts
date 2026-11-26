import { afterAll, beforeAll, expect, test } from "bun:test";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

let web: StartedProcess;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
      env: { VITE_API_BASE_URL: "" },
      ready: async () => (await fetch(origin).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
});

function phone(): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
  });
}

const onboarding = "/dev/onboarding?view=models";
const billing = "/test/credit-billing-preview.html?plans";
const composer = "/test/credit-billing-preview.html?plans&composer";
const inbox = "/test/credit-billing-preview.html?inbox";
const refusal = "/test/credit-billing-preview.html?refusal";
const organizationFixture = "/test/organization-workspace-administration.html";
const modelPicker = "/dev/own-subscription-plan?view=picker";
const peoplePath = "#/workspaces/22222222-2222-4222-8222-222222222222/organization?section=people";
const purchaseCopy =
  /get pro|get max|start with pro|\$20\s*\/\s*month|have a code|open stripe|promo code|manage billing|add (a card|credits)|set up card|update card|(turn on|save) automatic top-up|talk to us|upgrade (the|your|to)|ask .* to (add|buy|upgrade)/i;

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.OPENGENI_IOS_PURCHASE_SCREENSHOTS) {
    await page.screenshot({
      path: `${process.env.OPENGENI_IOS_PURCHASE_SCREENSHOTS}/${name}.png`,
      animations: "disabled",
    });
  }
}

test("the iOS model picker keeps the choice without naming the paid plan", async () => {
  const context = await phone();
  try {
    const page = await context.newPage();
    await page.goto(origin + modelPicker);
    const row = page.getByTestId("model-picker-choice-codex/gpt-6.2-astra");
    await row.getByText("Needs Pro", { exact: true }).waitFor();
    expect(await page.getByText("ChatGPT / Codex plan", { exact: true }).count()).toBe(1);
    expect(await row.isEnabled()).toBe(true);
    await capture(page, "model-picker-unmarked");

    await page.goto(`${origin}${modelPicker}&client=ios`);
    await row.getByText("Not available on your current plan", { exact: true }).waitFor();
    expect(await row.isEnabled()).toBe(true);
    expect(await page.getByText("Needs Pro", { exact: true }).count()).toBe(0);
    expect(await page.getByText("ChatGPT / Codex plan", { exact: true }).count()).toBe(0);
    await capture(page, "model-picker-ios");
  } finally {
    await context.close();
  }
}, 60_000);

test("hosted iOS entry removes offers, keeps setup and balance, and lasts across reloads in only that tab", async () => {
  const context = await phone();
  try {
    const page = await context.newPage();
    await page.goto(origin + onboarding);
    await page.getByRole("button", { name: "Get Pro", exact: true }).waitFor();
    await capture(page, "onboarding-unmarked");
    await page.goto(origin + billing);
    await page.getByRole("button", { name: "Open Stripe", exact: true }).waitFor();
    await page.getByRole("button", { name: "Manage billing", exact: true }).waitFor();
    await capture(page, "billing-unmarked");

    await page.goto(`${origin}${onboarding}&client=ios`);
    await page.getByRole("heading", { name: "Choose how to power your chats" }).waitFor();
    await capture(page, "onboarding-ios");
    await page.getByRole("button", { name: "Use your own provider account" }).click();
    await page.getByRole("button", { name: "OpenAI", exact: true }).waitFor();
    expect(await page.locator("body").innerText()).not.toMatch(purchaseCopy);
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("heading", { name: "Onboarding complete" }).waitFor();

    await page.goto(origin + billing);
    await page.getByText("Plan: Free", { exact: true }).waitFor();
    await page.getByText("$25.00", { exact: true }).first().waitFor();
    await page.getByRole("heading", { name: "Workspace budgets" }).waitFor();
    await page.getByRole("button", { name: "Open Insights" }).waitFor();
    const disable = page.getByRole("button", { name: "Turn off automatic top-up", exact: true });
    await disable.waitFor();
    await capture(page, "billing-ios");
    await disable.scrollIntoViewIfNeeded();
    await capture(page, "billing-stop-topup-ios");
    await disable.click();
    await page.getByText("Automatic top-up is off.", { exact: true }).waitFor();
    expect(await page.locator("body").innerText()).not.toMatch(purchaseCopy);
    expect(await page.locator('a[href*="stripe"]').count()).toBe(0);
    await page.reload();
    await page.getByText("Plan: Free", { exact: true }).waitFor();
    expect(await page.locator("body").innerText()).not.toMatch(purchaseCopy);

    const newTab = await context.newPage();
    await newTab.goto(origin + onboarding);
    await newTab.getByRole("button", { name: "Get Pro", exact: true }).waitFor();
  } finally {
    await context.close();
  }
}, 45_000);

test("the iOS inbox keeps spending warnings without purchase remedies", async () => {
  const context = await phone();
  try {
    const page = await context.newPage();
    await page.goto(origin + inbox);
    await page.getByRole("link", { name: "Manage billing" }).first().waitFor();
    await capture(page, "inbox-unmarked");
    await page.goto(`${origin}${inbox}&client=ios`);
    await page.getByText("Spending is higher than usual", { exact: true }).waitFor();
    await page
      .getByText("$18.50 used in the last hour. Review your recent usage.", { exact: true })
      .waitFor();
    await page.getByText("No credits were added.", { exact: true }).waitFor();
    expect(await page.locator("body").innerText()).not.toMatch(
      /manage billing|review your payment method|review your top-up limit/i,
    );
    await capture(page, "inbox-ios");
  } finally {
    await context.close();
  }
}, 45_000);

test("the iOS composer omits card verification and members can still be invited", async () => {
  const context = await phone();
  try {
    const page = await context.newPage();
    await page.goto(origin + composer);
    await page.getByText("Add a card for Free credit", { exact: true }).waitFor();
    await capture(page, "composer-unmarked");
    await page.goto(`${origin}${organizationFixture}${peoplePath}`);
    await page.getByText("Ada Member", { exact: true }).first().waitFor();
    await capture(page, "organization-unmarked");
    await page.goto(origin + refusal);
    await page.getByRole("button", { name: "Ask about the meeting" }).click();
    await page.getByRole("dialog").waitFor();
    await capture(page, "meeting-refusal-unmarked");

    await page.goto(`${origin}${composer}&client=ios`);
    await page.getByText("No credits left", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Use your own provider account" }).waitFor();
    expect(await page.locator("body").innerText()).not.toMatch(purchaseCopy);
    await capture(page, "composer-ios");
    await page.goto(`${origin}${organizationFixture}${peoplePath}`);
    await page.getByText("Ada Member", { exact: true }).first().waitFor();
    await capture(page, "organization-ios");
    await page.getByRole("button", { name: "Invite people", exact: true }).click();
    const email = page.getByRole("textbox", { name: "Email addresses" });
    await email.fill("new-member@example.test");
    await email.press("Enter");
    await page.getByRole("checkbox", { name: "Product engineering" }).check();
    await page.getByRole("button", { name: "Send invitation", exact: true }).click();
    await page.getByText("Invited new-member@example.test", { exact: true }).waitFor();
    await page.goto(origin + refusal);
    await page.getByRole("button", { name: "Ask about the meeting" }).click();
    await page.getByRole("heading", { name: "Couldn’t start the request" }).waitFor();
    expect(await page.getByRole("dialog").innerText()).not.toMatch(purchaseCopy);
    await capture(page, "meeting-refusal-ios");
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  } finally {
    await context.close();
  }
}, 45_000);

test.each(["ios", "android"])(
  "native %s sign-in marks only iOS before the signed-out view",
  async (platform) => {
    const context = await phone();
    try {
      await context.route("**/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const headers = { "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION };
        if (path === "/v1/config/client")
          return route.fulfill({
            headers,
            json: {
              apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
              defaultModel: "gpt-5.6-sol",
              allowedModels: ["gpt-5.6-sol"],
              models: [],
              defaultReasoningEffort: "low",
              allowedReasoningEfforts: ["low"],
              mcpServers: [],
              fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
              productAccessMode: "managed",
              managedAuthSessionSetMode: "legacy",
              auth: {
                mode: "managedSession",
                socialProviders: ["google", "github"],
                emailVerificationRequired: true,
              },
              structuredServices: { fileSystem: false, git: false, terminalEvents: false },
            },
          });
        if (path === "/v1/auth/get-session")
          return route.fulfill({ headers, body: "null", contentType: "application/json" });
        return route.fulfill({ status: 404, headers, json: {} });
      });
      const page = await context.newPage();
      await page.goto(
        `${origin}/native-sign-in?platform=${platform}&redirect_uri=opengeni%3A%2F%2Fauth%2Fcallback&code_challenge=fixture&state=fixture`,
      );
      await page
        .getByRole("heading", { level: 1 })
        .and(page.locator("#signed-out-heading"))
        .waitFor();
      expect(await page.locator("body").innerText()).not.toMatch(purchaseCopy);
      await capture(page, `native-sign-in-${platform}`);
      await page.goto(origin + onboarding);
      if (platform === "ios") {
        await page.getByRole("heading", { name: "Choose how to power your chats" }).waitFor();
        expect(await page.locator("body").innerText()).not.toMatch(purchaseCopy);
      } else {
        await page.getByRole("button", { name: "Get Pro", exact: true }).waitFor();
      }
    } finally {
      await context.close();
    }
  },
  45_000,
);
