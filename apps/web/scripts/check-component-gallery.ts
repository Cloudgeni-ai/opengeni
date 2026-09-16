import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
const output = resolve(import.meta.dirname, "../dist-component-gallery");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(Bun.file(resolve(output, "index.html"))),
});
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
async function category(name: string) {
  await page
    .getByRole("navigation", { name: "Component categories" })
    .getByRole("button", { name, exact: true })
    .click();
}
try {
  await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle" });
  await mkdir(resolve(output, "qa"), { recursive: true });
  await page.screenshot({ path: resolve(output, "qa/settings-rows.png") });
  const a11y = await new AxeBuilder({ page }).analyze();
  check(
    !a11y.violations.some((issue) => issue.impact === "critical" || issue.impact === "serious"),
    `Accessibility: ${a11y.violations.map((item) => item.id).join(", ")}`,
  );
  const rows = page.getByRole("region", { name: "Option A: Compact rows", exact: true });
  await rows.getByRole("switch", { name: "Voice input", exact: true }).click();
  for (const control of await page.getByRole("switch", { name: "Voice input", exact: true }).all())
    check((await control.getAttribute("aria-checked")) === "false", "Examples did not synchronize");
  await page.getByLabel("Show disabled state").check();
  check(
    await rows.getByRole("switch", { name: "Voice input", exact: true }).isDisabled(),
    "Disabled state not applied",
  );
  await page.getByLabel("Show disabled state").uncheck();
  await page
    .getByRole("region", { name: "Option B: Comfortable rows", exact: true })
    .getByRole("button", { name: "Prefer B", exact: true })
    .click();
  await page.getByLabel("Comparison layout").selectOption("focus");
  await page.getByLabel("Focused option").selectOption("comfortable");
  check(
    (await page.getByRole("region", { name: /^Option / }).count()) === 1,
    "Focus mode did not isolate option",
  );
  await page.getByLabel("Comparison layout").selectOption("compare");
  await category("Resource lists");
  await page.screenshot({ path: resolve(output, "qa/resource-lists.png") });
  await page.getByRole("button", { name: "Actions for GitHub", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "View details", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await category("Tabs & view switching");
  await page.getByRole("tab", { name: "Connected · 2", exact: true }).first().click();
  check(
    (await page.getByText("Google Drive", { exact: true }).count()) === 0,
    "Tabs did not synchronize",
  );
  await page.getByRole("tab", { name: "All · 3", exact: true }).first().focus();
  await page.keyboard.press("ArrowRight");
  await category("Search & filters");
  await page
    .getByRole("searchbox", { name: "Search active view", exact: true })
    .first()
    .fill("no-match");
  check(
    (await page.getByText("No matching connections", { exact: true }).count()) === 2,
    "Empty results did not match",
  );
  await page
    .getByRole("searchbox", { name: "Search active view", exact: true })
    .first()
    .fill("GitHub");
  check((await page.getByText("GitHub", { exact: true }).count()) === 2, "Search did not match");
  await category("Detailed configuration");
  for (const option of ["A: Inline expansion", "B: Side panel", "C: Focused dialog"]) {
    const region = page.getByRole("region", { name: `Option ${option}`, exact: true });
    await region.getByRole("button", { name: "Edit details", exact: true }).click();
    const host = option.startsWith("A") ? region : page.getByRole("dialog");
    await host.getByRole("textbox", { name: /^Connection name/ }).fill(`Updated ${option[0]}`);
    await host.getByRole("button", { name: "Apply to examples", exact: true }).click();
    check(
      (await page.getByText(`Updated ${option[0]}`, { exact: true }).count()) === 3,
      "Saved name not shared",
    );
  }
  await category("Selection controls");
  await page.getByRole("combobox", { name: /^Sort connections/ }).selectOption("name");
  check(
    await page.getByRole("radio", { name: /Name Show connections/ }).isChecked(),
    "Radio/select state did not match",
  );
  await category("Multiple selection");
  await page.getByRole("button", { name: /Include connections/ }).click();
  await page.getByRole("checkbox", { name: "Slack", exact: true }).first().check();
  for (const control of await page.getByRole("checkbox", { name: "Slack", exact: true }).all())
    check(await control.isChecked(), "Checkbox state did not match");
  await page.getByRole("button", { name: /Your choices/ }).click();
  await page
    .getByLabel("Anything you would change?", { exact: true })
    .fill("Keep existing icons and Insights.");
  const summary = await page.getByLabel("Selection summary", { exact: true }).inputValue();
  check(
    summary.includes("Settings rows: Comfortable rows") && summary.includes("Keep existing icons"),
    "Choices not captured",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download choices", exact: true }).click();
  const download = await downloadPromise;
  check(
    download.suggestedFilename() === "opengeni-component-preferences.txt",
    "Wrong download name",
  );
  await page.getByRole("button", { name: "Copy choices", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Use light theme", exact: true }).click();
  await category("Settings rows");
  await page.screenshot({ path: resolve(output, "qa/light-rows.png") });
  await page.getByRole("button", { name: "Use dark theme", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of ["rows", "lists", "tabs", "search", "details", "selection", "multiple"]) {
    await page.getByRole("combobox", { name: "Component category", exact: true }).selectOption(id);
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Mobile overflow: ${id}`,
    );
  }
  await page
    .getByRole("combobox", { name: "Component category", exact: true })
    .selectOption("details");
  await page
    .getByRole("region", { name: "Option B: Side panel", exact: true })
    .getByRole("button", { name: "Edit details", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: resolve(output, "qa/mobile-sheet.png") });
  await page.keyboard.press("Escape");
  await page
    .getByRole("combobox", { name: "Component category", exact: true })
    .selectOption("rows");
  await page.screenshot({ path: resolve(output, "qa/mobile-rows.png") });
  check(errors.length === 0, errors.join("; "));
  console.log(
    JSON.stringify({
      categories: 7,
      alternatives: 17,
      desktopAndMobile: "passed",
      interactions:
        "synchronized switches, disabled state, favorites, focused mode, menus, tabs, keyboard, search, empty state, all three detail surfaces, radio/select, checkboxes, notes, copy fallback, download, themes",
      browserErrors: errors,
      seriousCriticalAxe: 0,
    }),
  );
} finally {
  await browser.close();
  server.stop(true);
}
