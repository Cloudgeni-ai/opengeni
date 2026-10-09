import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

let browser: Browser, web: StartedProcess, baseUrl: string;
const evidence = new URL("../../.agent/evidence/codex-account/", import.meta.url).pathname;
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
        (await fetch(`${baseUrl}/test/codex-account.html`).catch(() => null))?.ok === true,
      timeoutMs: 45000,
    },
  );
  browser = await chromium.launch();
}, 60000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
}, 30000);

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`paused account credits and independent consent at ${width}px (${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: 950 },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${baseUrl}/test/codex-account.html`);
        await page.getByText("120.50", { exact: true }).waitFor();
        const consent = page.getByRole("switch", {
          name: "Use extra credits on subscription@example.test",
        });
        const allocation = page.getByRole("switch", {
          name: "subscription@example.test is available for new chats",
        });
        expect(await consent.getAttribute("aria-checked")).toBe("false");
        expect(await allocation.getAttribute("aria-checked")).toBe("false");
        await consent.focus();
        expect(await consent.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.screenshot({ path: `${evidence}/${width}-${theme}.png`, fullPage: true });
        const audit = await new AxeBuilder({ page })
          .include("main")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        expect(audit.violations).toEqual([]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
        await consent.press("Space");
        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Use extra credits on subscription@example.test"]')
              ?.getAttribute("aria-checked") === "true",
        );
        expect(await allocation.getAttribute("aria-checked")).toBe("false");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);
  }
}
