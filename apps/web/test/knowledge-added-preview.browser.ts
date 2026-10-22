import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "playwright/test";

const output = process.env.OPENGENI_KNOWLEDGE_ADDED_PREVIEW_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_KNOWLEDGE_ADDED_CHROMIUM
    ? { executablePath: process.env.OPENGENI_KNOWLEDGE_ADDED_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
try {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `${process.env.OPENGENI_KNOWLEDGE_ADDED_PREVIEW_URL ?? "http://127.0.0.1:4340"}/test/knowledge-added-preview.html`,
        { waitUntil: "networkidle" },
      );
      await page.locator("html").evaluate((node, selected) => {
        node.dataset.ogTheme = selected;
        node.classList.toggle("dark", selected === "dark");
      }, theme);
      await expect(page.getByText("Customer onboarding checklist", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Last 24 hours" })).toBeVisible();
      await page.getByRole("menuitemcheckbox", { name: "Last 7 days" }).click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Last 7 days" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      if (output)
        await page.screenshot({
          path: `${output}/added-menu-${theme}-${width}.png`,
          fullPage: true,
        });
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Remove filter Added: Last 7 days" }),
      ).toBeVisible();
      const cutoff = await page.evaluate(() => window.knowledgeAddedRequests.at(-1)!.createdSince);
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(page.getByText("Support handoff", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.knowledgeAddedRequests.at(-1)!.createdSince)).toBe(
        cutoff,
      );
      await expect(page.getByText("Older knowledge edited today", { exact: true })).toHaveCount(0);
      if (output)
        await page.screenshot({
          path: `${output}/added-week-${theme}-${width}.png`,
          fullPage: true,
        });
      const axe = await new AxeBuilder({ page })
        .include("main")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(axe.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );

      // Replacing a window is single-choice, not an intersection of two dates.
      await page.getByRole("button", { name: /^Filter/ }).click();
      await page.getByRole("menuitemcheckbox", { name: "Last 24 hours" }).click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Last 7 days" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await page.keyboard.press("Escape");
      await expect(page.getByText("Release verification", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Remove filter Added: Last 24 hours" }).click();
      await expect(page.getByText("Release verification", { exact: true })).toBeVisible();

      // The window composes with Type and search, and an empty result remains clearable.
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await page.getByRole("menuitemcheckbox", { name: "Last 30 days" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Fact", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByText("Support handoff", { exact: true })).toBeVisible();
      await expect(page.getByText("Older knowledge edited today", { exact: true })).toHaveCount(0);
      await page.getByRole("searchbox").fill("no match");
      await expect(page.getByText('No matches for "no match".')).toBeVisible();
      await page.getByRole("button", { name: "Clear search", exact: true }).first().click();
      await expect(page.getByText("Support handoff", { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
      await context.close();
    }
  }
  console.log(
    "Added filter: desktop/mobile light/dark, window replacement, pagination cutoff, Type/search, empty state, accessibility and overflow passed. Preview uses sample data and production UI.",
  );
} finally {
  await browser.close();
}
