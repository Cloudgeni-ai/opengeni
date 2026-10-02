import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDirectory = process.env.OPENGENI_ERROR_BRANDING_EVIDENCE_DIR;

describe("native embedded error presentation", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;
  beforeAll(async () => {
    if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    demo = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "demo",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/error-branding-test.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 60_000,
      },
    );
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 30_000);

  for (const { width, theme } of [390, 1440].flatMap((candidateWidth) =>
    ["light", "dark"].map((candidateTheme) => ({ width: candidateWidth, theme: candidateTheme })),
  )) {
    test(`neutral defaults and host customization at ${width}px in ${theme}`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (!url.startsWith(`${baseUrl}/`) || new URL(url).pathname.startsWith("/v1/")) {
          failures.push(`Unexpected non-fixture request: ${new URL(url).pathname}`);
          await route.abort();
          return;
        }
        await route.continue();
      });
      try {
        for (const mode of ["api", "setup", "allowance", "unknown", "transport"]) {
          await page.goto(`${baseUrl}/error-branding-test.html?mode=${mode}&theme=${theme}`);
          const input = page.locator("[data-og-new-chat-composer] textarea");
          await input.fill("A private ACME question");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          const alert = page.getByRole("alert");
          await alert.waitFor();
          expect(await alert.innerText()).not.toMatch(/opengeni/i);
          expect(await input.inputValue()).toBe("A private ACME question");
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          expect(
            await page
              .locator("[data-error-preview]")
              .evaluate((node) => getComputedStyle(node).colorScheme),
          ).toBe(theme);
          expect(
            await page
              .locator("[data-og-chat]")
              .evaluate((node) => getComputedStyle(node).getPropertyValue("--og-color-bg").trim()),
          ).toBe(
            await page
              .locator("[data-error-preview]")
              .evaluate((node) => getComputedStyle(node).getPropertyValue("--og-color-bg").trim()),
          );
          expect(await input.evaluate((node) => getComputedStyle(node).fontFamily)).not.toBe("");
          const field = page.locator("[data-og-new-chat-composer] > div");
          expect(await field.evaluate((node) => getComputedStyle(node).borderRadius)).not.toBe(
            "0px",
          );
          if (mode === "unknown")
            expect(await alert.innerText()).toContain("Check its status before retrying");
          if (evidenceDirectory)
            await page.screenshot({
              path: `${evidenceDirectory}/${width}-${theme}-${mode}.png`,
              fullPage: true,
            });
        }
        if (width === 390) {
          await page.getByRole("button", { name: "Open chats", exact: true }).click();
          const drawer = page.locator("[data-og-chat-drawer] > div");
          await drawer.waitFor();
          const box = await drawer.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          expect(await drawer.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
            await page
              .locator("[data-error-preview]")
              .evaluate((node) => getComputedStyle(node).backgroundColor),
          );
          if (evidenceDirectory)
            await page.screenshot({
              path: `${evidenceDirectory}/${width}-${theme}-drawer.png`,
              fullPage: true,
            });
          await drawer.getByRole("button", { name: "Close chats", exact: true }).click();
        }
        await page.goto(
          `${baseUrl}/error-branding-test.html?mode=unknown&custom&composer&theme=${theme}`,
        );
        await page
          .getByText("ACME Assistant: The request could not be confirmed", { exact: false })
          .first()
          .waitFor();
        expect(await page.locator("body").innerText()).toContain("Reference: acme-preview.");
        expect(await page.locator("body").innerText()).not.toMatch(/opengeni/i);
        expect(
          await page.getByRole("button", { name: "Retry", exact: true }).count(),
        ).toBeGreaterThan(0);
        expect(
          await page.evaluate(() =>
            [
              ...document.querySelectorAll<HTMLElement>(
                "[data-error-preview], [data-error-preview] *",
              ),
            ]
              .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
              .map((node) => ({
                tag: node.tagName,
                className: node.className,
                right: node.getBoundingClientRect().right,
                width: node.getBoundingClientRect().width,
                boxSizing: getComputedStyle(node).boxSizing,
              })),
          ),
        ).toEqual([]);
        if (evidenceDirectory)
          await page.screenshot({
            path: `${evidenceDirectory}/${width}-${theme}-custom-unknown-composer.png`,
            fullPage: true,
          });
        expect(failures).toEqual([]);
      } finally {
        await context.close();
      }
    }, 150_000);
  }
});
