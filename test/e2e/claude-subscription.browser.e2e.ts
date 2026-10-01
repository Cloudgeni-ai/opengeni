import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

let browser: Browser, web: StartedProcess, baseUrl: string;
const evidence = new URL("../../.agent/evidence/claude-subscription/", import.meta.url).pathname;
beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await mkdir(evidence, { recursive: true });
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
      cwd: new URL("../../apps/web", import.meta.url).pathname,
      ready: async () =>
        (
          await fetch(`${baseUrl}/test/claude-subscription.html`, {
            signal: AbortSignal.timeout(2000),
          }).catch(() => null)
        )?.ok === true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
}, 30_000);

async function accessible(page: Page) {
  // Audit the settled UI, after shared toast/overlay entrance transitions.
  await page.evaluate(async () => {
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
  });
  const axe = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}
for (const theme of ["dark", "light"] as const) {
  for (const scope of ["workspace", "organization"] as const) {
    for (const width of [1280, 390]) {
      test(`${scope} token-only setup, shared quota meters and replacement at ${width}px (${theme})`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 950 },
          colorScheme: theme,
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${baseUrl}/test/claude-subscription.html?scope=${scope}`);
          await page.getByRole("heading", { name: "Connect Claude subscription" }).waitFor();
          await page.getByRole("button", { name: "Use a setup token", exact: false }).click();
          expect(await page.locator('input[type="file"]').count()).toBe(0);
          expect(await page.getByLabel("Claude account UUID").count()).toBe(0);
          expect(await page.getByLabel("Claude device ID").count()).toBe(0);
          expect(
            await page.getByLabel("Create a Claude setup token", { exact: true }).inputValue(),
          ).toBe("claude setup-token");
          const connect = page.getByRole("button", {
            name: "Connect Claude subscription",
            exact: true,
          });
          expect(await connect.isDisabled()).toBe(true);
          await page
            .getByLabel("Claude subscription setup token")
            .fill("sk-ant-oat01-browser-fixture");
          await accessible(page);
          await page.screenshot({
            path: `${evidence}/${scope}-${width}-${theme}-connect.png`,
            fullPage: true,
          });
          await connect.click();
          await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
          await page.getByText("50% left", { exact: true }).waitFor();
          await page.getByText("Limit reached", { exact: true }).waitFor();
          const receipt = JSON.parse((await page.getByTestId("operation-receipt").textContent())!);
          expect(receipt).toMatchObject({ action: "connect", scope, tokenOnly: true });
          expect(await page.locator('[data-slot="usage-meter-group"]').count()).toBe(1);
          expect(await page.getByText(/Resets /).count()).toBeGreaterThanOrEqual(2);
          await page.getByRole("button", { name: "Check usage now" }).click();
          await page
            .locator('button[aria-label="Check usage now"][aria-disabled="true"]')
            .waitFor();
          await page
            .getByText(
              "This setup token allows model calls. Usage readings update after Claude is used. Sign in again to check current usage and reset times.",
              { exact: true },
            )
            .waitFor();
          expect(JSON.parse((await page.getByTestId("quota-request").textContent())!)).toEqual({
            path: `/v1/${scope === "workspace" ? "workspaces" : "organizations"}/22222222-2222-4222-8222-222222222222/model-providers/claude_subscription/usage/refresh`,
            contentType: "application/json",
            body: {},
          });
          await page
            .getByText(
              "This setup token allows model calls. Usage readings update after Claude is used. Sign in again to check current usage and reset times.",
              { exact: true },
            )
            .waitFor();
          expect(
            await page.getByText("Couldn't check usage. Try again.", { exact: true }).count(),
          ).toBe(0);
          await page.keyboard.press("Escape");
          await accessible(page);
          await page.screenshot({
            path: `${evidence}/${scope}-${width}-${theme}-usage.png`,
            fullPage: true,
          });
          await page
            .getByRole("button", {
              name: "More actions for Claude subscription",
              exact: true,
            })
            .click();
          await page.getByRole("menuitem", { name: "Replace setup token", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog
            .getByLabel("Claude subscription setup token")
            .fill("sk-ant-oat01-browser-replacement");
          expect(await dialog.locator('input[type="file"]').count()).toBe(0);
          await dialog.getByRole("button", { name: "Replace token", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
          await page.getByText("Claude hasn't reported usage yet.", { exact: true }).waitFor();
          expect(await page.getByText("50% left", { exact: true }).count()).toBe(0);
          expect(await page.getByText("Not reported yet", { exact: true }).count()).toBe(2);
          await page.getByRole("button", { name: "Models", exact: true }).click();
          await page.getByRole("button", { name: "Claude subscription", exact: false }).waitFor();
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);
    }
  }
}

for (const theme of ["dark", "light"] as const) {
  for (const scope of ["workspace", "organization"] as const) {
    for (const width of [1280, 390]) {
      test(`${scope} full sign-in, browser isolation, recovery and direct usage at ${width}px (${theme})`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 950 },
          colorScheme: theme,
        });
        // No provider traffic or model calls: only the official popup destination is represented.
        await context.route("https://claude.com/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><title>Claude sign-in fixture</title><p>Approve access in Claude</p><button onclick="window.close()">Close window</button>',
          }),
        );
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        try {
          await page.goto(`${baseUrl}/test/claude-subscription.html?scope=${scope}`);
          await page
            .getByRole("heading", {
              name: "Connect Claude subscription",
              exact: true,
            })
            .waitFor();
          const start = page.getByRole("button", {
            name: "Sign in to Claude",
            exact: true,
          });
          expect(await start.isEnabled()).toBe(true);
          expect(await page.getByLabel("Claude subscription setup token").isVisible()).toBe(false);
          await accessible(page);
          const popupPromise = context.waitForEvent("page");
          await start.click();
          const popup = await popupPromise;
          await popup.waitForURL("https://claude.com/**");
          await popup.getByText("Approve access in Claude", { exact: true }).waitFor();
          expect(new URL(popup.url()).origin).toBe("https://claude.com");
          expect(await popup.evaluate(() => window.opener === null)).toBe(true);
          await page.getByLabel("Claude authorization code").waitFor();
          expect(
            await page.getByRole("button", { name: "Complete sign-in", exact: true }).isDisabled(),
          ).toBe(true);
          // Navigating away and returning keeps only scoped, expiring attempt metadata.
          await page.reload();
          await page.getByLabel("Claude authorization code").waitFor();
          expect(
            await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
          ).toBe("Claude authorization code");
          await page.getByLabel("Claude authorization code").fill("wrong-code");
          await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
          await page.getByRole("alert").waitFor();
          expect(await page.getByLabel("Claude authorization code").isVisible()).toBe(true);
          await page.getByLabel("Claude authorization code").fill("fixture-code#fixture-state");
          await Promise.all([
            popup.waitForEvent("close"),
            popup.getByRole("button", { name: "Close window", exact: true }).click(),
          ]);
          await accessible(page);
          await page.screenshot({
            path: `${evidence}/${scope}-${width}-${theme}-signin.png`,
            fullPage: true,
          });
          await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
          await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
          await page.getByText("50% left", { exact: true }).waitFor();
          expect(JSON.parse((await page.getByTestId("operation-receipt").textContent())!)).toEqual({
            action: "oauth_connect",
            scope,
            fields: ["attemptId", "code"],
          });
          expect(await page.getByText(/Resets /).count()).toBeGreaterThanOrEqual(2);
          await page.getByRole("button", { name: "Check usage now", exact: true }).click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="quota-request"]')?.textContent !== "null",
          );
          expect(JSON.parse((await page.getByTestId("quota-request").textContent())!)).toEqual({
            path: `/v1/${scope === "workspace" ? "workspaces" : "organizations"}/${scopeIdForBrowser}/model-providers/claude_subscription/usage/refresh`,
            contentType: "application/json",
            body: {},
          });
          await page.waitForFunction(
            () =>
              document
                .querySelector('button[aria-label="Check usage now"]')
                ?.getAttribute("aria-disabled") !== "true",
          );
          expect(
            await page
              .getByText("This setup token allows model calls.", {
                exact: false,
              })
              .isVisible(),
          ).toBe(false);
          expect(
            await page.getByText("Couldn't check usage. Try again.", { exact: true }).count(),
          ).toBe(0);
          await accessible(page);
          await page.screenshot({
            path: `${evidence}/${scope}-${width}-${theme}-full-usage.png`,
            fullPage: true,
          });
          expect(
            await page.evaluate(
              () =>
                Object.keys(sessionStorage).filter((key) =>
                  key.startsWith("opengeni.claude-signin:"),
                ).length,
            ),
          ).toBe(0);
          await page.getByRole("button", { name: "Sign in again", exact: true }).click();
          await page
            .getByRole("heading", {
              name: "Reconnect Claude subscription",
              exact: true,
            })
            .waitFor();
          const retryPopupPromise = context.waitForEvent("page");
          await page.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
          const retryPopup = await retryPopupPromise;
          await retryPopup.getByText("Approve access in Claude", { exact: true }).waitFor();
          await page.getByLabel("Claude authorization code").waitFor();
          await page.getByRole("button", { name: "Start again", exact: true }).click();
          expect(retryPopup.isClosed()).toBe(false);
          expect(await retryPopup.evaluate(() => window.opener === null)).toBe(true);
          expect(
            await page.getByRole("button", { name: "Sign in to Claude", exact: true }).isEnabled(),
          ).toBe(true);
          expect(
            await page.evaluate(
              () =>
                Object.keys(sessionStorage).filter((key) =>
                  key.startsWith("opengeni.claude-signin:"),
                ).length,
            ),
          ).toBe(0);
          await Promise.all([
            retryPopup.waitForEvent("close"),
            retryPopup.getByRole("button", { name: "Close window", exact: true }).click(),
          ]);
          const cancelPopupPromise = context.waitForEvent("page");
          await page.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
          const cancelPopup = await cancelPopupPromise;
          await cancelPopup.getByText("Approve access in Claude", { exact: true }).waitFor();
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await page.getByRole("button", { name: "Claude subscription", exact: false }).waitFor();
          expect(await page.getByLabel("Claude authorization code").count()).toBe(0);
          expect(
            await page.evaluate(
              () =>
                Object.keys(sessionStorage).filter((key) =>
                  key.startsWith("opengeni.claude-signin:"),
                ).length,
            ),
          ).toBe(0);
          expect(cancelPopup.isClosed()).toBe(false);
          expect(await cancelPopup.evaluate(() => window.opener === null)).toBe(true);
          await Promise.all([
            cancelPopup.waitForEvent("close"),
            cancelPopup.getByRole("button", { name: "Close window", exact: true }).click(),
          ]);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);
    }
  }
}
const scopeIdForBrowser = "22222222-2222-4222-8222-222222222222";
