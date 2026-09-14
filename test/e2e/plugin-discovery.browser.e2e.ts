import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

test("plugin rows and centered details preserve keyboard focus, scrolling, and installation states", async () => {
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
  const evidence = new URL("../../.agent/evidence/plugin-discovery/", import.meta.url).pathname;
  await mkdir(evidence, { recursive: true });
  try {
    for (const width of [1440, 390, 320]) {
      for (const query of ["", "?long", "?installed", "?readonly"]) {
        const height = query.includes("long") ? 500 : 900;
        const page = await browser.newPage({
          viewport: { width, height },
          reducedMotion: "reduce",
        });
        await page.goto(`${origin}/test/plugin-discovery.html${query}`);
        const opener = page.locator(
          query.includes("installed") ? ".og-connection-installed button" : "[data-plugin-id]",
        );
        await opener.waitFor();
        expect(await opener.locator("button").count()).toBe(0);
        expect(await opener.locator(".og-connection-logo").count()).toBe(1);
        if (query.includes("installed")) {
          expect(await opener.getAttribute("aria-label")).toContain("Installed");
        } else {
          expect(await opener.locator("[data-status]").getAttribute("data-status")).toBe(
            "available",
          );
        }
        await opener.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ state: "visible" });
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
        if (width >= 640) {
          expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
          expect(Math.abs(box.y + box.height / 2 - height / 2)).toBeLessThan(2);
          expect(box.width).toBeGreaterThan(600);
        }
        expect(await dialog.locator("h2:not(.sr-only)").count()).toBe(1);
        expect(await dialog.locator(".og-connection-logo").count()).toBe(1);
        expect(await dialog.getByText("Requires a local runtime").count()).toBe(1);
        if (query.includes("installed")) {
          expect(
            await dialog.getByRole("button", { name: "Installed", exact: true }).isDisabled(),
          ).toBe(true);
          const discoveredInstalled = page.locator('[data-plugin-id] [data-status="added"]');
          await discoveredInstalled.waitFor({ state: "attached" });
          expect(await discoveredInstalled.count()).toBe(1);
        } else if (query.includes("readonly")) {
          expect(
            await dialog.getByRole("button", { name: "Install plugin", exact: true }).count(),
          ).toBe(0);
          expect(await dialog.getByRole("button", { name: "Connect", exact: true }).count()).toBe(
            0,
          );
        } else {
          expect(
            await dialog.getByRole("button", { name: "Install plugin", exact: true }).isEnabled(),
          ).toBe(true);
        }
        if (query.includes("long")) {
          expect(
            await dialog.locator(".overflow-y-auto").evaluate((node) => {
              node.scrollTop = node.scrollHeight;
              return node.clientHeight > 0 && node.scrollTop > 0;
            }),
          ).toBe(true);
        }
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        await page.screenshot({
          path: `${evidence}${width}-${query.slice(1) || "available"}.png`,
          fullPage: true,
        });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() =>
          document.activeElement?.matches("[data-plugin-id], .og-connection-installed button"),
        );
        expect(await opener.evaluate((node) => document.activeElement === node)).toBe(true);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 120_000);
