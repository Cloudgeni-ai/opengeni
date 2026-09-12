import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

test("capability details are centered, bounded, and restore the single catalog opener", async () => {
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
  const evidence = new URL("../../.agent/evidence/capability-details/", import.meta.url).pathname;
  await mkdir(evidence, { recursive: true });
  try {
    for (const { width, height, query } of [
      ...[1440, 390, 320].flatMap((viewportWidth) => [
        { width: viewportWidth, height: 900, query: "" },
        { width: viewportWidth, height: 900, query: "?plugin" },
        { width: viewportWidth, height: 500, query: "?long" },
        { width: viewportWidth, height: 500, query: "?plugin&long" },
      ]),
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        reducedMotion: "reduce",
      });
      await page.goto(`${origin}/test/capability-details.html${query}`);
      const opener = page.locator(".og-connection-catalog button");
      expect(await opener.count()).toBe(1);
      await opener.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible" });
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
      if (width >= 640) {
        expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(2);
        expect(Math.abs(box!.y + box!.height / 2 - height / 2)).toBeLessThan(2);
        expect(box!.width).toBeGreaterThan(600);
      }
      if (query.includes("long")) {
        const scroll = dialog.locator(".overflow-y-auto");
        expect(await scroll.count()).toBe(1);
        expect(
          await scroll.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
            return node.clientHeight > 0 && node.scrollTop > 0;
          }),
        ).toBe(true);
      }
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      await page.screenshot({
        path: `${evidence}${width}-${height}-${query.includes("plugin") ? "plugin" : "integration"}.png`,
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.waitForFunction(() =>
        document.activeElement?.matches(".og-connection-catalog button"),
      );
      expect(await opener.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.close();
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 120_000);
