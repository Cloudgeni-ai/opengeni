import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
describe("exact Skill review browser acceptance", () => {
  let web: StartedProcess;
  let browser: Browser;
  let baseUrl: string;
  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        `${repoRoot}/packages/react/demo/skill-review-fixture`,
        "--config",
        `${repoRoot}/packages/react/demo/vite.config.ts`,
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: `${repoRoot}/packages/react/demo`,
        ready: async () =>
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  for (const width of [320, 1280]) {
    test(`renders full inert files and submits one keyboard Save at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(baseUrl);
        await page.locator("pre").first().waitFor();
        const exact = await page.evaluate(() => {
          const fixture = (window as any).skillReviewFixture;
          const files = [...document.querySelectorAll("pre")];
          return (
            files.length === 2 &&
            files[0]!.textContent === fixture.content &&
            files[1]!.textContent === fixture.sibling
          );
        });
        expect(exact).toBe(true);
        const sibling = page.locator("summary").filter({ hasText: "scripts/helper.txt" });
        await sibling.focus();
        await page.keyboard.press("Enter");
        expect(await sibling.locator("..").getAttribute("open")).not.toBeNull();
        expect(await page.evaluate(() => Boolean((window as any).unexpectedExecution))).toBe(false);
        expect(await page.locator("[data-skill-review] script").count()).toBe(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
        await page.screenshot({ path: `/tmp/qa-skill-review-${width}.png`, fullPage: true });
        const save = page.getByRole("radio", { name: "Save", exact: true });
        await save.focus();
        await page.keyboard.press("Space");
        const submit = page.getByRole("button", { name: "Send answers", exact: true });
        await submit.focus();
        await page.keyboard.press("Enter");
        expect(await page.evaluate(() => (window as any).skillReviewFixture.responses)).toEqual([
          { outcome: "answered", answers: [{ questionId: "skill:revision", values: ["save"] }] },
        ]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
  test("failed preview blocks Save and still permits decline", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    try {
      await page.goto(`${baseUrl}/?fail=1`);
      await page.getByText("Preview unavailable", { exact: true }).waitFor();
      await page.getByRole("radio", { name: "Save", exact: true }).check();
      await page.getByRole("button", { name: "Send answers", exact: true }).click();
      expect(await page.evaluate(() => (window as any).skillReviewFixture.responses)).toEqual([]);
      expect(await page.locator("pre").count()).toBe(0);
      await page.getByRole("radio", { name: "Don't save", exact: true }).check();
      await page.getByRole("button", { name: "Send answers", exact: true }).click();
      expect(await page.evaluate(() => (window as any).skillReviewFixture.responses)).toEqual([
        { outcome: "answered", answers: [{ questionId: "skill:revision", values: ["skip"] }] },
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
