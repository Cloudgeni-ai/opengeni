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
const option = (name: string) => page.getByRole("region", { name: `Option ${name}`, exact: true });
try {
  await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle" });
  await mkdir(resolve(output, "qa"), { recursive: true });
  await page.getByRole("heading", { name: "Connector layouts", exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, "qa/connector-directions.png") });
  const a11y = await new AxeBuilder({ page }).analyze();
  check(
    !a11y.violations.some((issue) => issue.impact === "critical" || issue.impact === "serious"),
    `Accessibility: ${a11y.violations.map((item) => item.id).join(", ")}`,
  );
  const cards = option("A: Capability cards");
  check((await cards.locator(".connector-tile").count()) === 3, "Missing actual catalog cards");
  check((await cards.locator('[data-status="added"]').count()) === 2, "Wrong check states");
  check((await cards.locator('[data-status="available"]').count()) === 1, "Missing plus state");
  check(
    (await cards.locator(".og-capability-catalog-notice").count()) === 0,
    "Unexpected visible status badges",
  );
  check(
    await cards
      .locator("img")
      .evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
    "Connector artwork failed to load",
  );
  await cards.getByRole("button", { name: /Notion.*Add connection/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add to examples", exact: true })
    .click();
  check((await cards.locator('[data-status="added"]').count()) === 3, "Plus did not become check");
  await page.getByRole("button", { name: "Reset examples", exact: true }).click();
  await option("C: Connector browser").getByRole("button", { name: "Slack", exact: true }).click();
  check(
    await option("C: Connector browser")
      .locator(".connector-browser-detail")
      .innerText()
      .then((text) => text.includes("Slack")),
    "Browser did not change focused connector",
  );
  await cards.getByRole("button", { name: "Prefer A", exact: true }).click();
  await page.getByLabel("Comparison layout").selectOption("focus");
  check(
    (await page.getByRole("region", { name: /^Option / }).count()) === 1,
    "Focus mode did not isolate option",
  );
  await page.screenshot({ path: resolve(output, "qa/capability-cards-wide.png") });
  await page.getByLabel("Comparison layout").selectOption("compare");
  await category("Preference layouts");
  const tiles = option("A: Interactive tiles");
  await tiles.getByRole("switch", { name: "Voice input", exact: true }).click();
  for (const control of await page.getByRole("switch", { name: "Voice input", exact: true }).all())
    check(
      (await control.getAttribute("aria-checked")) === "false",
      "Preference examples did not synchronize",
    );
  await page.getByLabel("Show disabled state").check();
  check(
    await tiles.getByRole("switch", { name: "Voice input", exact: true }).isDisabled(),
    "Disabled state not applied",
  );
  await page.getByLabel("Show disabled state").uncheck();
  await option("C: Settings navigator")
    .getByRole("navigation")
    .getByRole("button", { name: "Notification sounds", exact: true })
    .click();
  await option("C: Settings navigator")
    .getByRole("switch", { name: "Notification sounds", exact: true })
    .waitFor();
  await page.screenshot({ path: resolve(output, "qa/preference-directions.png") });
  await category("Tabs & view switching");
  await page.getByRole("tab", { name: "My tools", exact: true }).first().click();
  check(
    (await page.getByRole("button", { name: /Notion.*Add connection/ }).count()) === 0,
    "Views did not synchronize",
  );
  await page.getByRole("tab", { name: "All tools", exact: true }).first().focus();
  await page.keyboard.press("ArrowRight");
  await category("Search & filters");
  await page
    .getByRole("searchbox", { name: "Search connections", exact: true })
    .first()
    .fill("no-match");
  check(
    (await page.getByText("No matching connections", { exact: true }).count()) === 2,
    "Empty states did not synchronize",
  );
  await page
    .getByRole("searchbox", { name: "Search connections", exact: true })
    .first()
    .fill("Linear");
  check(
    (await page.getByRole("button", { name: /Linear.*Connected/ }).count()) === 2,
    "Search did not match",
  );
  await page.getByRole("button", { name: "Reset examples", exact: true }).click();
  await page.screenshot({ path: resolve(output, "qa/search-directions.png") });
  await category("Detailed configuration");
  for (const name of ["A: Inline expansion", "B: Side panel", "C: Focused dialog"]) {
    const region = option(name);
    await region.getByRole("button", { name: "Edit details", exact: true }).click();
    const host = name.startsWith("A") ? region : page.getByRole("dialog");
    await host.getByRole("textbox", { name: /^Connection name/ }).fill(`Updated ${name[0]}`);
    await host.getByRole("button", { name: "Apply to examples", exact: true }).click();
    check(
      (await page.getByText(`Updated ${name[0]}`, { exact: true }).count()) === 3,
      "Detail forms did not synchronize",
    );
  }
  await category("Selection controls");
  await page.getByRole("combobox", { name: /^Sort connections/ }).selectOption("name");
  check(
    await page.getByRole("radio", { name: /A–Z/ }).isChecked(),
    "Visual radio state differs from select",
  );
  await category("Multiple selection");
  await page.getByRole("checkbox", { name: "Slack", exact: true }).first().click();
  for (const control of await page.getByRole("checkbox", { name: "Slack", exact: true }).all())
    check(
      (await control.getAttribute("aria-checked")) === "true",
      "Tile and chip selections differ",
    );
  await page.getByRole("button", { name: "Remove Slack", exact: true }).click();
  check(
    (await page
      .getByRole("checkbox", { name: "Slack", exact: true })
      .first()
      .getAttribute("aria-checked")) === "false",
    "Chip removal did not update tiles",
  );
  await page.getByRole("button", { name: /Your choices/ }).click();
  await page
    .getByLabel("Anything you would change?", { exact: true })
    .fill("Prefer capability cards. Keep Insights unchanged.");
  check(
    (await page.getByLabel("Selection summary", { exact: true }).inputValue()).includes(
      "Connector layouts: Capability cards",
    ),
    "Favorite not reflected in summary",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download choices", exact: true }).click();
  check(
    (await downloadPromise).suggestedFilename() === "opengeni-component-preferences.txt",
    "Export filename changed",
  );
  await page.getByRole("button", { name: "Copy choices", exact: true }).click();
  await page.keyboard.press("Escape");
  await category("Connector layouts");
  await page.getByRole("button", { name: "Use light theme", exact: true }).click();
  await page.screenshot({ path: resolve(output, "qa/light-connectors.png") });
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
    .selectOption("lists");
  await page.screenshot({ path: resolve(output, "qa/mobile-connectors.png") });
  await page
    .getByRole("combobox", { name: "Component category", exact: true })
    .selectOption("details");
  await option("B: Side panel").getByRole("button", { name: "Edit details", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  check(errors.length === 0, errors.join("; "));
  console.log(
    JSON.stringify({
      categories: 7,
      alternatives: 17,
      desktopAndMobile: "passed",
      plusCheckActions: "passed",
      realCatalogComponent: true,
      browserErrors: errors,
      seriousCriticalAxe: 0,
    }),
  );
} finally {
  await browser.close();
  server.stop(true);
}
