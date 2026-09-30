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
          await page.keyboard.press("Escape");
          await accessible(page);
          await page.screenshot({
            path: `${evidence}/${scope}-${width}-${theme}-usage.png`,
            fullPage: true,
          });
          await page.getByRole("button", { name: "Replace token", exact: true }).click();
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
