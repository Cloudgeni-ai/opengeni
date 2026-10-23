// Browser check for the Schedules list switch over the real components.
// Start the preview first:
//   bunx vite --config test/schedules-toggle-preview.vite.config.ts --port 4517
// then run `bun test/schedules-toggle-preview.browser.ts` from apps/web.
// OPENGENI_SCHEDULES_TOGGLE_PREVIEW_OUTPUT saves screenshots there.
import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "playwright/test";

const base = process.env.OPENGENI_SCHEDULES_TOGGLE_PREVIEW_URL ?? "http://127.0.0.1:4517";
const output = process.env.OPENGENI_SCHEDULES_TOGGLE_PREVIEW_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 720 },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}/test/schedules-toggle-preview.html?theme=${theme}`, {
        waitUntil: "networkidle",
      });
      const brief = page.getByRole("switch", { name: "Daily kitchen prevention brief" });
      const briefRow = page.locator("li", { has: brief });
      await expect(brief).toHaveAttribute("aria-checked", "false");
      await expect(page.getByRole("button", { name: /resume/i })).toHaveCount(0);
      await expect(page.getByRole("switch")).toHaveCount(5);

      // One click resumes; Next run changes at once and the page stays put.
      const url = page.url();
      await brief.click();
      await expect(brief).toHaveAttribute("aria-checked", "true");
      await expect(briefRow).not.toContainText("Paused");
      await expect(brief).not.toHaveAttribute("aria-busy", "true");
      expect(page.url()).toBe(url);

      // Opening the just-switched row's menu keeps the row in place, even as
      // the pointer moves into the menu (now active, it would sort higher).
      const titles = () =>
        page.locator("[role=switch]").evaluateAll((nodes) => nodes.map((node) => node.ariaLabel));
      const order = await titles();
      await page
        .getByRole("button", { name: "More actions for Daily kitchen prevention brief" })
        .click();
      await page.getByRole("menuitem", { name: "Edit" }).hover();
      await page.waitForTimeout(100);
      expect(await titles()).toEqual(order);
      await page.keyboard.press("Escape");
      // The closing menu returns focus to ⋯; wait for it before moving focus.
      await expect(
        page.getByRole("button", { name: "More actions for Daily kitchen prevention brief" }),
      ).toBeFocused();

      // Space on the focused switch pauses it again; focus stays on it.
      await brief.focus();
      await page.keyboard.press("Space");
      await expect(brief).toHaveAttribute("aria-checked", "false");
      await expect(briefRow).toContainText("Paused");
      await expect(brief).toBeFocused();
      await expect(brief).not.toHaveAttribute("aria-busy", "true");

      // The menu keeps the other actions only.
      await page
        .getByRole("button", { name: "More actions for Daily kitchen prevention brief" })
        .click();
      await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /^(Pause|Resume)$/ })).toHaveCount(0);

      await page.keyboard.press("Escape");

      const axe = await new AxeBuilder({ page })
        .include("main")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(axe.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      if (output) await page.screenshot({ path: `${output}/schedules-${theme}-${width}.png` });
      expect(errors).toEqual([]);
      await context.close();
    }
  }

  // A failed change puts the switch back and says what failed.
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(`${base}/test/schedules-toggle-preview.html?fail=1`, {
    waitUntil: "networkidle",
  });
  const radar = page.getByRole("switch", { name: "Oslo demand and surplus radar" });
  await radar.click();
  await expect(radar).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Couldn't pause the schedule")).toBeVisible();
  await expect(radar).toHaveAttribute("aria-checked", "true");
  await context.close();
  console.log("schedules toggle preview: ok");
} finally {
  await browser.close();
}
