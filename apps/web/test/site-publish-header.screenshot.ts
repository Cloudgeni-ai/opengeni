// Checks and captures the Site view header's publication control with the
// real sidebar, SiteView, version chip and publish form (sample data, in
// memory): an unpublished Site offers Publish, which opens the Site's own
// publish form in place of the Site with the chat beside it; Publishing…
// while it saves; then "Published", whose menu names the address, opens and
// copies it, and leads back to the same form. Never a second "Live". Light
// and dark, at desktop width. Start the server first:
//   bunx vite --config test/session-sidebar-preview.vite.config.ts --port 4292
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const output =
  process.env.OPENGENI_SITE_VIEW_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-site-publish-header-preview");
const baseUrl = process.env.OPENGENI_SITE_VIEW_PREVIEW_URL ?? "http://127.0.0.1:4292";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.OPENGENI_TEST_CHROMIUM
    ? { executablePath: process.env.OPENGENI_TEST_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const errors: string[] = [];
const usageSite = "00000000-0000-4000-a000-000000000001";
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace sidebar" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Chat", exact: true });
const control = (page: Page, state: "unpublished" | "published") =>
  page.locator(`[data-site-publication="${state}"]`);
const site = (page: Page) => page.frameLocator("iframe").first();
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
async function capture(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
}

/** Open the usage Site from its sidebar row, as someone who may publish it. */
async function openSite(page: Page, theme: "light" | "dark", extra: string) {
  await page.goto(
    `${baseUrl}/test/session-sidebar-preview.html?scenario=sites&publish=1&theme=${theme}${extra}`,
  );
  await sidebar(page)
    .getByRole("link", { name: /^Open Opengeni usage\. Site/u })
    .click();
  await page.waitForURL(new RegExp(`/sites/${usageSite}$`, "u"));
  await site(page).getByText("Weekly active users").first().waitFor();
  await panel(page).getByText("The range picker at the top now filters all four graphs").waitFor();
}

/** Whether the element is on screen and the topmost thing at its centre. */
const usable = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.width > 0 && hit !== null && element.contains(hit);
  });

/** Whether keyboard focus is inside the first element matching the selector. */
const focusIn = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => element.contains(document.activeElement));

async function publishFromHeader(page: Page, theme: "light" | "dark") {
  // `publishDelay=hold` keeps the first Publish pending, to capture it.
  await openSite(page, theme, "&publishable=1&publishDelay=hold");
  const publish = control(page, "unpublished");
  await publish.waitFor();
  check((await publish.textContent())?.trim() === "Publish", "an unpublished Site lacks Publish");
  // The Site frame's header (its iframe's text isn't part of it).
  const frameHeader = await page.locator("dialog").first().textContent();
  check(!frameHeader?.includes("Live"), "the header still says Live");
  check(
    (await page.locator("[data-live-status]").count()) === 0,
    "a Live label shows beside Publish",
  );
  await capture(page, `site-publish-header-unpublished-${theme}`);

  await publish.click();
  const form = page.locator("form").filter({ hasText: "Publish to web" });
  await form.waitFor();
  await form.getByText(/is available/u).waitFor();
  check(await focusIn(page, "form"), "focus didn't move into the publish form");
  check(
    (await page.locator("iframe").first().isVisible()) === false,
    "the Site still shows beside the publish form",
  );
  check(await panel(page).isVisible(), "the chat went away while publishing");
  await capture(page, `site-publish-header-form-${theme}`);

  await form.getByRole("button", { name: "Publish", exact: true }).click();
  await form.getByRole("button", { name: "Publishing…" }).waitFor();
  await capture(page, `site-publish-header-publishing-${theme}`);
}

async function publishedMenu(page: Page, theme: "light" | "dark") {
  await openSite(page, theme, "&published=1");
  const published = control(page, "published");
  await published.waitFor();
  check(
    (await published.textContent())?.trim() === "Published",
    "the header doesn't say Published",
  );
  check(
    (await page.locator("[data-live-status]").count()) === 0,
    "a Live label shows beside Published",
  );
  await capture(page, `site-publish-header-published-${theme}`);
  await published.click();
  const menu = page.getByRole("menu");
  await menu.getByText("usage.sites.opengeni.ai").waitFor();
  check(
    (await menu.getByRole("menuitem", { name: "Open" }).getAttribute("href")) ===
      "https://usage.sites.opengeni.ai/",
    "Open doesn't link to the published Site",
  );
  await menu.getByRole("menuitem", { name: "Copy link" }).waitFor();
  await menu.getByRole("menuitem", { name: "Publishing settings" }).waitFor();
  await capture(page, `site-publish-header-published-menu-${theme}`);

  // Settings opens the same form for the published Site; Back returns.
  await menu.getByRole("menuitem", { name: "Publishing settings" }).click();
  const form = page.locator("form").filter({ hasText: "Web address" });
  await form.waitFor();
  await form.getByText("usage.sites.opengeni.ai").first().waitFor();
  check(await focusIn(page, "form"), "focus didn't move into the form from the menu");
  await capture(page, `site-publish-header-settings-${theme}`);
  await form.getByRole("button", { name: "Opengeni usage" }).click();
  await published.waitFor();
  check(await page.locator("iframe").first().isVisible(), "Back didn't return to the Site");

  // In full screen the menu opens inside the frame and can be used.
  await page.getByRole("button", { name: "Open Site full screen" }).click();
  await page.locator("dialog[data-artifact-fullscreen]").waitFor();
  await published.click();
  await page.getByRole("menuitem", { name: "Copy link" }).waitFor();
  check(
    await usable(page, '[role="menuitem"]:has-text("Copy link")'),
    "the Published menu isn't usable in full screen",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator("dialog[data-artifact-fullscreen]").waitFor({ state: "detached" });
}

async function publishCompletes(page: Page, theme: "light" | "dark") {
  await openSite(page, theme, "&publishable=1&publishDelay=500");
  await control(page, "unpublished").click();
  const form = page.locator("form").filter({ hasText: "Publish to web" });
  await form.getByText(/is available/u).waitFor();
  await form.getByRole("button", { name: "Publish", exact: true }).click();
  // Back to the Site, which now says Published; focus is on it.
  await control(page, "published").waitFor();
  check(await page.locator("iframe").first().isVisible(), "Publish didn't return to the Site");
  check(
    await control(page, "published").evaluate((element) => element === document.activeElement),
    "focus didn't return to the publication control",
  );
  await capture(page, `site-publish-header-just-published-${theme}`);
}

try {
  for (const theme of ["light", "dark"] as const) {
    for (const run of [publishFromHeader, publishedMenu, publishCompletes]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.emulateMedia({ colorScheme: theme });
      page.on("pageerror", (error) => errors.push(`${theme} ${run.name}: ${error.message}`));
      await run(page, theme);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (errors.length > 0) throw new Error(errors.join("\n"));
console.log(output);
