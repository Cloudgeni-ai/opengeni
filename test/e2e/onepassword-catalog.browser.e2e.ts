import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

test("1Password catalog and chat cards reach protected setup at desktop and mobile widths", async () => {
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
  const evidence = new URL("../../.agent/evidence/onepassword-catalog/", import.meta.url).pathname;
  await mkdir(evidence, { recursive: true });
  try {
    for (const width of [1440, 390]) {
      for (const chat of [false, true]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/test/capability-details.html?onepassword${chat ? "&chat" : ""}`);
        const connect = page.getByRole("link", { name: "Connect 1Password", exact: true });
        await connect.waitFor();
        expect(await connect.getAttribute("href")).toBe(
          "/workspaces/ws/secrets?view=connect-1password",
        );
        expect(await connect.getAttribute("target")).toBe(chat ? "_blank" : null);
        expect(await page.locator('input[type="password"]').count()).toBe(0);
        await connect.focus();
        expect(await connect.evaluate((node) => node === document.activeElement)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: `${evidence}${width}-${chat ? "chat" : "catalog"}.png`,
          fullPage: true,
        });
        // Only navigation is intercepted; the protected destination's install/link
        // behavior is covered by the real-PostgreSQL vault-provider API suite.
        await page
          .context()
          .route("**/workspaces/ws/secrets?view=connect-1password", (route) =>
            route.fulfill({ contentType: "text/html", body: "<h1>Protected Secrets setup</h1>" }),
          );
        if (chat) {
          const popup = page.waitForEvent("popup");
          await connect.click();
          const setup = await popup;
          await setup.getByRole("heading", { name: "Protected Secrets setup" }).waitFor();
          expect(page.url()).toContain("onepassword&chat");
          await setup.close();
        } else {
          await connect.click();
          await page.getByRole("heading", { name: "Protected Secrets setup" }).waitFor();
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 120_000);
