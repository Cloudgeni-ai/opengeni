import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

test("expanded Sites keep desktop navigation clear of native controls", async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = fileURLToPath(new URL("../../.agent/artifact-desktop/", import.meta.url));
  await mkdir(output, { recursive: true });
  const web = await startProcess(
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
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      ready: async () =>
        (await fetch(`${baseUrl}/test/artifact-desktop.html`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? chromium.executablePath(),
  });
  try {
    for (const platform of ["macos", "windows", "linux", "browser"] as const) {
      for (const width of [1000, 640]) {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${baseUrl}/test/artifact-desktop.html`);
        await page
          .getByRole("button", { name: "Open Site full screen" })
          .waitFor({ timeout: 90_000 });
        await page.evaluate((hostPlatform) => {
          document.documentElement.classList.add("dark");
          if (hostPlatform !== "browser") document.documentElement.dataset.desktop = hostPlatform;
          if (hostPlatform === "windows") {
            // Chromium has no native Windows overlay. Supply the same CSS
            // environment-derived values the Electron host exposes.
            document.documentElement.style.setProperty("--og-caption-buttons-width", "138px");
            document.documentElement.style.setProperty("--og-caption-row-height", "56px");
          }
        }, platform);
        const inlineHeight = await page
          .locator("dialog > div")
          .first()
          .evaluate((el) => el.getBoundingClientRect().height);
        expect(inlineHeight).toBe(48);
        const frame = page.frameLocator("iframe");
        await frame.getByRole("button", { name: "Try the Site" }).click();
        await page.getByRole("button", { name: "Open Site full screen" }).click();
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(true);
        const back = page.getByRole("button", { name: "Back", exact: true });
        const bounds = await back.boundingBox();
        expect(bounds).not.toBeNull();
        if (platform === "macos") expect(bounds!.x).toBeGreaterThanOrEqual(84);
        else expect(bounds!.x).toBeLessThan(30);
        const header = page.locator("[data-artifact-fullscreen] > [data-window-drag]");
        expect(await header.evaluate((el) => el.getBoundingClientRect().height)).toBe(
          platform === "macos" || platform === "windows" ? 56 : 48,
        );
        expect(
          await back.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region")),
        ).not.toBe("drag");
        if (platform === "windows") {
          const reload = await page.getByRole("button", { name: "Reload Site" }).boundingBox();
          expect(reload!.x + reload!.width).toBeLessThanOrEqual(width - 138);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({ path: `${output}/${platform}-${width}.png` });
        // Pointer and keyboard both exit; neither remounts the live Site.
        await back.click();
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(false);
        await frame.getByRole("button", { name: "Site state preserved" }).waitFor();
        expect(await page.locator("[data-window-drag]").count()).toBe(0);
        await page.getByRole("button", { name: "Open Site full screen" }).click();
        await back.focus();
        await page.keyboard.press("Enter");
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(false);
        await page.getByRole("button", { name: "Open Site full screen" }).click();
        await page.keyboard.press("Escape");
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(false);
        await frame.getByRole("button", { name: "Site state preserved" }).waitFor();
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 210_000);
