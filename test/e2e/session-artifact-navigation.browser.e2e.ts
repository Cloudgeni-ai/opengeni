import { afterAll, beforeAll, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let web: StartedProcess;
let baseUrl: string;
beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
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
      cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
      ready: async () =>
        (await fetch(`${baseUrl}/test/session-artifact-navigation.html`).catch(() => null))?.ok ===
        true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
}, 30_000);

test("desktop chat link opens the dock and full-page close returns to chat", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/test/session-artifact-navigation.html`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("link", { name: "Open Project overview", exact: true }).click();
    await page.getByRole("heading", { name: "Project overview", exact: true }).waitFor();
    expect(
      await page.getByRole("tab", { name: "Artifacts", exact: true }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(browser.contexts().length).toBe(1);
    expect(page.context().pages().length).toBe(1);
    await page.getByRole("link", { name: "Open Project overview full-page" }).click();
    await page.getByRole("link", { name: "Back to session" }).waitFor();
    await page
      .getByRole("heading", { name: "Build a project overview" })
      .waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Back to session" }).click();
    await page.getByRole("heading", { name: "Build a project overview" }).waitFor();
    await page.getByRole("heading", { name: "Project overview", exact: true }).waitFor();
    if (process.env.OPENGENI_ARTIFACT_NAV_SCREENSHOT)
      await page.screenshot({ path: process.env.OPENGENI_ARTIFACT_NAV_SCREENSHOT });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
