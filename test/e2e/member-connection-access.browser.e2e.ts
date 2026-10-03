import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

test("the production connection-access notice is clear and bounded at desktop and mobile widths", async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const web = await startProcess(
    ["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: new URL("../../apps/web", import.meta.url).pathname,
      ready: async () =>
        (await fetch(`${origin}/test/capabilities-populated.html`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  const browser = await chromium
    .launch({
      headless: true,
      ...(existsSync("/usr/local/bin/chromium")
        ? { executablePath: "/usr/local/bin/chromium" }
        : {}),
    })
    .catch(async (error) => {
      await web.stop();
      throw error;
    });
  const evidence = new URL("../../.agent/evidence/member-connection-access/", import.meta.url)
    .pathname;
  await mkdir(evidence, { recursive: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${origin}/test/capabilities-populated.html`);
      const notice = page.getByText("Connection access required");
      await notice.waitFor({ state: "visible" });
      expect(await page.locator("body").innerText()).toContain(
        "Ask a workspace admin for connection access to use connected tools here and in chat.",
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `${evidence}denied-${width}.png`, fullPage: true });

      await page.getByRole("button", { name: "Show member with connection access" }).click();
      expect(await notice.count()).toBe(0);
      await page.screenshot({ path: `${evidence}allowed-${width}.png`, fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 120_000);
