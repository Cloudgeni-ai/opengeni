import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

test("connections, skills, and plugins share row geometry and a single dialog action", async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const web = await startProcess(
    ["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: new URL("../../apps/web", import.meta.url).pathname,
      ready: async () => (await fetch(origin).catch(() => null))?.ok === true,
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
  const evidence = new URL("../../.agent/evidence/capability-catalog/", import.meta.url).pathname;
  await mkdir(evidence, { recursive: true });
  try {
    for (const width of [1440, 390, 320]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/test/capability-catalog.html`);
      const rows = page.locator("button.og-capability-catalog-row");
      await rows.nth(4).waitFor();
      expect(await rows.count()).toBe(5);
      const geometry = await rows.evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return [
            style.minHeight,
            style.padding,
            style.borderRadius,
            style.gap,
            getComputedStyle(node.querySelector("strong")!).fontSize,
          ].join("|");
        }),
      );
      expect(new Set(geometry).size).toBe(1);
      expect(await rows.locator("button").count()).toBe(0);
      expect(await rows.locator(".lucide-plus").count()).toBe(3);
      expect(await rows.locator(".lucide-check").count()).toBe(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const row of await rows.all()) {
        expect(await row.locator(".og-capability-catalog-copy").innerText()).not.toMatch(
          /Plugin ·|\d+ skills|Not connected|Connected/,
        );
        const label = await row.locator(".og-capability-catalog-sr-only").boundingBox();
        expect(label!.width).toBe(1);
        expect(label!.height).toBe(1);
      }
      await page.screenshot({ path: `${evidence}${width}-catalog.png`, fullPage: true });
      const notion = rows.filter({ hasText: "Notion" });
      for (const target of [notion.locator("strong"), notion.locator(".lucide-plus")]) {
        await target.click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        expect(await page.getByRole("dialog").count()).toBe(1);
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
        await page.getByText("You’ll sign in with your own account.", { exact: true }).waitFor();
        await page
          .getByText("Workspace agents and automations can act through your account.", {
            exact: true,
          })
          .waitFor();
        await page.screenshot({ path: `${evidence}${width}-setup.png`, fullPage: true });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        expect(await notion.evaluate((node) => node === document.activeElement)).toBe(true);
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 120_000);
