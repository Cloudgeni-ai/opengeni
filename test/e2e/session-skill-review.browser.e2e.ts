import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const root = new URL("../..", import.meta.url).pathname;
describe("nonblocking session Skill review", () => {
  let web: StartedProcess;
  let browser: Browser;
  let url: string;
  beforeAll(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        `${root}/apps/web/test/fixtures/session-skill-review`,
        "--config",
        `${root}/apps/web/vite.config.ts`,
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: `${root}/apps/web`,
        timeoutMs: 45_000,
        ready: async () => (await fetch(url).catch(() => null))?.ok === true,
      },
    );
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });
  for (const width of [320, 1280]) {
    test(`reviews a pending Skill outside loaded history at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(url);
        const review = page.getByText("Review Release checklist", { exact: true });
        await review.waitFor();
        await page.getByRole("textbox", { name: "Message" }).fill("Keep working");
        await review.focus();
        await page.keyboard.press("Enter");
        await page.getByText("SKILL.md", { exact: true }).waitFor();
        expect(await page.locator("pre").allTextContents()).toHaveLength(2);
        expect(await page.locator("section script").count()).toBe(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
        if (process.env.OPENGENI_SESSION_SKILL_REVIEW_SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.OPENGENI_SESSION_SKILL_REVIEW_SCREENSHOTS}/session-skill-review-${width}.png`,
            fullPage: true,
          });
        await page.getByRole("button", { name: "Approve Skill", exact: true }).click();
        await page.getByRole("region", { name: "Skill review" }).waitFor({ state: "detached" });
        expect(await page.getByRole("textbox", { name: "Message" }).inputValue()).toBe(
          "Keep working",
        );
        expect(
          await page.evaluate(
            () => (window as unknown as { approval: { revisionId: string } }).approval.revisionId,
          ),
        ).toBe("33333333-3333-4333-8333-333333333333");
      } finally {
        await page.close();
      }
    }, 30_000);
  }
  test("failed file reads cannot be approved", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${url}/?fail`);
      await page.getByRole("alert").waitFor();
      expect(await page.getByRole("button", { name: "Approve Skill" }).count()).toBe(0);
      await page.getByRole("button", { name: "Reload review" }).click();
      expect(await page.getByRole("textbox", { name: "Message" }).isEnabled()).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
});
