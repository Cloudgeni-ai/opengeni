// Checks and captures the ⌘K menu finding Sites, in the real sidebar and Site
// view with sample data. Start the server first:
//   bunx vite --config test/command-menu-sites-preview.vite.config.ts --port 4719
// then: PREVIEW_OUTPUT=<dir> bun test/command-menu-sites-preview.browser.ts
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const base =
  process.env.PREVIEW_URL ?? "http://127.0.0.1:4719/test/command-menu-sites-preview.html";
const output = process.env.PREVIEW_OUTPUT;
if (!output) throw new Error("Set PREVIEW_OUTPUT to the screenshot output directory");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.PREVIEW_CHROMIUM ? { executablePath: process.env.PREVIEW_CHROMIUM } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const errors: string[] = [];
// Hosts without the key symbols (⌘ ⇧ ↩) can name a font that has them.
const symbolFont = process.env.PREVIEW_SYMBOL_FONT
  ? await readFile(process.env.PREVIEW_SYMBOL_FONT)
  : null;

const menu = (page: Page) => page.getByRole("dialog", { name: "Command menu", exact: true });
const field = (page: Page) =>
  menu(page).getByRole("combobox", { name: "Search chats, Sites and actions", exact: true });
const group = (page: Page, label: string) =>
  menu(page).getByRole("group", { name: label, exact: true });
async function options(page: Page, label: string): Promise<string[]> {
  return (await group(page, label).getByRole("option").allInnerTexts()).map(
    (text) => text.split("\n")[0]!,
  );
}

async function open(page: Page, query = "") {
  await page.keyboard.press("Meta+KeyK");
  await field(page).waitFor();
  if (query) await field(page).fill(query);
  // Let the server searches answer and the list settle.
  await page.waitForTimeout(600);
}

async function newPage(theme: "light" | "dark", width = 1280, height = 820, search = "") {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
  // Mac key labels, as most of the team sees them.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => ({ platform: "macOS" }),
    });
  });
  if (symbolFont) {
    await page.route("**/preview-symbol-font.ttf", (route) =>
      route.fulfill({ body: symbolFont, contentType: "font/ttf" }),
    );
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent =
        '@font-face{font-family:"Preview symbols";src:url("/preview-symbol-font.ttf");unicode-range:U+2190-23FF}' +
        'kbd{font-family:"Preview symbols",var(--font-sans),sans-serif!important}';
      document.addEventListener("DOMContentLoaded", () => document.head.append(style));
    });
  }
  await page.goto(`${base}?scenario=sites&theme=${theme}${search}`);
  await page.getByRole("link", { name: /^Open Opengeni usage\. Site/ }).waitFor();
  await page.mouse.move(width - 20, height - 20);
  return page;
}

try {
  for (const theme of ["light", "dark"] as const) {
    const page = await newPage(theme);

    // Empty query: a few recent Sites from the sidebar, after recent chats.
    await open(page);
    assert.deepEqual(await options(page, "Recent Sites"), [
      "Opengeni usage",
      "IPO research dashboard",
      "Pricing calculator",
    ]);
    await page.screenshot({ path: `${output}/empty-query-${theme}.png` });

    // A query only Sites answer, including ones the sidebar has not loaded.
    await field(page).fill("dashboard");
    await page.waitForTimeout(600);
    // The Site from the sidebar (recently active) first, then the server's.
    assert.deepEqual(await options(page, "Sites"), [
      "IPO research dashboard",
      "Q4 revenue dashboard",
      "Customer health dashboard",
    ]);
    await page.screenshot({ path: `${output}/sites-query-${theme}.png` });

    // Mixed results: chats, Sites and actions in one list.
    await field(page).fill("pricing");
    await page.waitForTimeout(600);
    assert.deepEqual(await options(page, "Sites"), ["Pricing calculator"]);
    assert.ok((await options(page, "Chats")).includes("Pricing page copy"));
    // Chats still come first; Sites follow them even when a Site matches better.
    const labels = await menu(page)
      .getByRole("group")
      .evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")));
    assert.deepEqual(labels.slice(0, 2), ["Chats", "Sites"]);
    await page.screenshot({ path: `${output}/mixed-query-${theme}.png` });

    // Selecting a Site opens it in the app's Site view, like its sidebar row.
    await group(page, "Sites").getByRole("option").first().hover();
    await page.keyboard.press("Enter");
    await menu(page).waitFor({ state: "hidden" });
    await page.waitForURL(/\/workspaces\/[^/]+\/sites\/00000000-0000-4000-a000-000000000003/);
    await page.getByRole("link", { name: /^Open Pricing calculator\. Site/ }).waitFor();
    await page.waitForTimeout(800);
    await page.mouse.move(1260, 800);
    await page.screenshot({ path: `${output}/selected-site-${theme}.png` });
    await page.close();
  }

  // A failing Site search leaves the rest of the menu working.
  const failing = await newPage("light", 1280, 820, "&sites=fail");
  await open(failing, "usage");
  assert.deepEqual(await options(failing, "Sites"), ["Opengeni usage"]);
  assert.ok(await group(failing, "Messages").isVisible());
  await failing.screenshot({ path: `${output}/site-search-failed-light.png` });
  await failing.close();

  // Phone width.
  const phone = await newPage("light", 390, 844);
  await open(phone, "dash");
  assert.ok((await options(phone, "Sites")).length > 0);
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await phone.screenshot({ path: `${output}/sites-query-phone-light.png` });
  await phone.close();

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
