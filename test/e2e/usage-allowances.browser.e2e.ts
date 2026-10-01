import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const fixturePath = "/test/usage-allowances.html";

describe("usage allowances in Chromium", () => {
  let browser: Browser;
  let page: Page;
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
          (
            await fetch(`${baseUrl}${fixturePath}`, { signal: AbortSignal.timeout(2_000) }).catch(
              () => null,
            )
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    page = await context.newPage();
    await page.goto(`${baseUrl}${fixturePath}`, { waitUntil: "networkidle" });
    await page.getByRole("list", { name: "Member usage" }).waitFor();
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  const saves = () =>
    page.evaluate(() => window.usageSaves) as Promise<{ subjectId: string; rule: unknown }[]>;

  test("the share slider works by keyboard and by pointer, and oversubscription is allowed", async () => {
    await page.getByRole("button", { name: /^Change limit for Ada Okafor/ }).click();
    const slider = page.getByRole("slider", { name: "Share of the workspace budget" });
    await expect(slider.getAttribute("aria-valuenow")).resolves.toBe("25");
    const save = page.getByRole("button", { name: "Save", exact: true });
    // Opening the editor on a default member changes nothing until it moves.
    expect(await save.isDisabled()).toBe(true);
    await slider.focus();
    for (let step = 0; step < 15; step += 1) await page.keyboard.press("ArrowRight");
    await expect(slider.getAttribute("aria-valuenow")).resolves.toBe("40");
    await page.getByText("1.6× an equal share · About $200.00 at the current budget").waitFor();
    await page.getByText(/Member limits add up to 115% of the budget\. That's allowed/).waitFor();
    await save.click();
    await page.getByText("40% of budget").waitFor();
    expect(await saves()).toEqual([{ subjectId: "user:ada", rule: { share: 0.4 } }]);
    await page
      .locator('[data-og-usage-allocation="oversubscribed"]')
      .getByText("Member limits add up to 115% of the budget.")
      .waitFor();

    // Pointer: drag Linus's thumb to the far right (the whole budget).
    await page.getByRole("button", { name: /^Change limit for Linus Berg/ }).click();
    const thumb = page.getByRole("slider", { name: "Share of the workspace budget" });
    const track = await page.locator("[data-og-share-slider]").boundingBox();
    const box = await thumb.boundingBox();
    if (!box || !track) throw new Error("slider not laid out");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width + 40, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(thumb.getAttribute("aria-valuenow")).resolves.toBe("100");
    // Typing an exact share wins over the drag.
    const exact = page.getByRole("spinbutton", { name: "Share, percent" });
    await exact.fill("35");
    await expect(thumb.getAttribute("aria-valuenow")).resolves.toBe("35");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("35% of budget").waitFor();

    // A fixed amount and back to the default, through the same editor.
    await page.getByRole("button", { name: /^Change limit for Margaret Hale/ }).click();
    await page.getByText("Fixed amount", { exact: true }).click();
    await page.getByRole("spinbutton", { name: "Fixed amount" }).fill("50");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("$50.00 fixed").waitFor();
    await page.getByRole("button", { name: /^Change limit for Ada Okafor/ }).click();
    await page.getByText("Default", { exact: true }).click();
    await page.keyboard.press("Escape");
    expect(await page.getByRole("slider").count()).toBe(0);

    expect((await saves()).slice(1)).toEqual([
      { subjectId: "user:linus", rule: { share: 0.35 } },
      { subjectId: "user:margaret", rule: { credits: 50_000_000 } },
    ]);
  }, 60_000);

  test("the refusal row says who can fix it, calmly, and hosts can replace it", async () => {
    const own = page.getByRole("region", { name: "Default conversation" });
    const row = own.locator("[data-og-allowance-exhausted]");
    await row.waitFor();
    expect(await row.getAttribute("role")).toBe("status");
    const text = await row.innerText();
    expect(text).toContain("Usage limit reached");
    expect(text).toContain("A workspace admin can raise this limit.");
    expect(text).toMatch(/Resets (Oct|Nov) \d+\./);
    expect(text).not.toMatch(/API key|administrator or a full-access/);
    // The prompt stays above the refusal.
    const prompt = await own.getByText("Draft the onboarding checklist.").boundingBox();
    const notice = await row.boundingBox();
    expect(prompt && notice && prompt.y < notice.y).toBe(true);

    const host = page.getByRole("region", { name: "Host conversation" });
    await host.locator('[data-host-refusal="member"]').waitFor();
    expect(await host.locator("[data-og-allowance-exhausted]").count()).toBe(0);

    const composer = page.getByRole("region", { name: "Composer notice" });
    expect(await composer.innerText()).toContain("You've reached your usage limit.");
    expect(await composer.getByRole("button", { name: "Dismiss" }).count()).toBe(0);

    const results = await new AxeBuilder({ page }).include("main").analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  }, 60_000);
});
