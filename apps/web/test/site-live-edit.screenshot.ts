// Checks and captures live Site editing with the real sidebar, SiteView,
// SessionConversation and version chip: a message in the Site's side chat
// publishes a new version and the preview beside it reloads in place, the
// chip shows the history and Undo puts the previous version back, a version
// published elsewhere shows within seconds, and Edit with Opengeni (`?new`)
// opens a new conversation with its composer focused. On a Site published to
// the web, Updating shows beside the header's link and the link's tooltips
// work in full screen. Light and dark, plus a
// screen recording of the edit going live. Start the server first:
//   bunx vite --config test/session-sidebar-preview.vite.config.ts --port 4292
import { mkdir, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const output =
  process.env.OPENGENI_SITE_VIEW_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-site-live-edit-preview");
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
const workspaceId = "11111111-1111-4111-8111-111111111111";
const usageSite = "00000000-0000-4000-a000-000000000001";
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace sidebar" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Chat", exact: true });
const chip = (page: Page) => page.locator("[data-site-version-chip]");
const liveLabel = (page: Page) => page.locator("[data-live-status]");
const site = (page: Page) => page.frameLocator("iframe").first();
const headerBackground = (page: Page) =>
  site(page)
    .locator("h1")
    .evaluate((heading) => getComputedStyle(heading).backgroundColor);
const blue = "rgb(49, 87, 245)";
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
async function waitUntil(condition: () => Promise<boolean>, message: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await condition().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function capture(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
}

/** Open the usage Site from its sidebar row, with its newest conversation beside it. */
async function openSite(page: Page, theme: "light" | "dark", extra = "") {
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

/** Ask the side chat for a change; the agent publishes it and the preview reloads. */
async function editLive(page: Page) {
  check((await chip(page).textContent())?.trim() === "v4", "the chip doesn't show version 4");
  check((await liveLabel(page).textContent()) === "Live", "the Site isn't marked Live");
  check((await headerBackground(page)) !== blue, "the header is already blue");
  const composer = panel(page).getByRole("textbox").first();
  await composer.click();
  await composer.pressSequentially("Make the header blue", { delay: 35 });
  await page.keyboard.press("Enter");
  await panel(page).getByText("Make the header blue").first().waitFor();
  await waitUntil(
    async () => (await headerBackground(page)) === blue,
    "the preview didn't reload with the published version",
  );
  check((await chip(page).textContent())?.trim() === "v5", "the chip didn't follow to version 5");
  await panel(page).getByText("The header is now a blue band").waitFor();
  await waitUntil(
    async () => (await liveLabel(page).textContent()) === "Live",
    "the Site didn't settle back to Live",
  );
}

/** Undo from the chip puts version 4 back. */
async function undo(page: Page, name?: string) {
  await chip(page).click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: /Undo last change/u }).waitFor();
  if (name) await capture(page, name);
  await menu.getByRole("menuitem", { name: /Undo last change/u }).click();
  await page.getByText("Version 4 is live again").waitFor();
  await waitUntil(
    async () => (await headerBackground(page)) !== blue,
    "Undo didn't put the previous version back",
  );
  check((await chip(page).textContent())?.trim() === "v4", "the chip didn't go back to version 4");
}

/** In full screen the chip's menu opens inside the full-screen frame and can be used. */
async function fullScreenMenu(page: Page, name: string) {
  await page.getByRole("button", { name: "Open Site full screen" }).click();
  await page.locator("dialog[data-artifact-fullscreen]").waitFor();
  await chip(page).click();
  const item = page.getByRole("menuitem", { name: /Undo restore/u });
  await item.waitFor();
  check(
    await item.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return (
        element.closest("dialog[data-artifact-fullscreen]") !== null &&
        hit !== null &&
        element.contains(hit)
      );
    }),
    "the version menu isn't usable in full screen",
  );
  await capture(page, name);
  await page.keyboard.press("Escape");
  await item.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator("dialog[data-artifact-fullscreen]").waitFor({ state: "detached" });
}

/**
 * A Site on the web: the header's link to the published Site stands in for
 * Live, Updating shows beside it while a new version loads, and the link's
 * tooltips work in full screen.
 */
async function publishedHeader(page: Page, theme: "light" | "dark") {
  await openSite(page, theme, "&published=1&htmlDelay=1500");
  const link = page.locator("[data-site-public-link] a");
  await link.waitFor();
  check(
    (await link.getAttribute("href")) === "https://usage.sites.opengeni.ai/",
    "the header doesn't link to the published Site",
  );
  check((await liveLabel(page).count()) === 0, "a published Site shows a second Live label");
  const composer = panel(page).getByRole("textbox").first();
  await composer.click();
  await composer.pressSequentially("Make the header blue", { delay: 20 });
  await page.keyboard.press("Enter");
  await waitUntil(
    async () => (await liveLabel(page).textContent()) === "Updating",
    "Updating didn't show beside the published link",
  );
  check(await link.isVisible(), "the published link went away while updating");
  await capture(page, `site-live-updating-published-${theme}`);
  await waitUntil(
    async () => (await headerBackground(page)) === blue,
    "the preview didn't reload with the published version",
  );
  await waitUntil(
    async () => (await liveLabel(page).count()) === 0,
    "Updating didn't clear once the version loaded",
  );
  await page.getByRole("button", { name: "Open Site full screen" }).click();
  await page.locator("dialog[data-artifact-fullscreen]").waitFor();
  await page.getByRole("button", { name: "Copy link" }).hover();
  const tooltip = page
    .locator("[data-radix-popper-content-wrapper]")
    .filter({ hasText: "Copy link" });
  await tooltip.waitFor();
  check(
    await tooltip.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return (
        element.closest("dialog[data-artifact-fullscreen]") !== null &&
        hit !== null &&
        element.contains(hit)
      );
    }),
    "the published link's tooltip is hidden in full screen",
  );
  await capture(page, `site-live-fullscreen-link-${theme}`);
  await page.mouse.move(700, 600);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator("dialog[data-artifact-fullscreen]").waitFor({ state: "detached" });
}

try {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.emulateMedia({ colorScheme: theme });
    page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
    await openSite(page, theme);
    await capture(page, `site-live-before-${theme}`);
    await editLive(page);
    await page.mouse.move(700, 600);
    await capture(page, `site-live-published-${theme}`);
    await undo(page, `site-live-history-${theme}`);
    await capture(page, `site-live-undone-${theme}`);
    await fullScreenMenu(page, `site-live-fullscreen-menu-${theme}`);

    // A version published elsewhere shows without anything done here.
    await page.evaluate(() =>
      (
        window as unknown as { sitePreviewPublishElsewhere: () => void }
      ).sitePreviewPublishElsewhere(),
    );
    await waitUntil(
      async () => (await site(page).locator("h1").textContent()) === "Opengeni usage · Q4",
      "a version published elsewhere didn't show",
      9_000,
    );
    check((await chip(page).textContent())?.trim() === "v6", "the chip didn't follow to version 6");

    // Edit with Opengeni: a new conversation beside the Site, composer focused.
    await page.evaluate(
      ([workspace, siteId]) => {
        history.pushState({}, "", `/workspaces/${workspace}/sites/${siteId}?new=true`);
        dispatchEvent(new PopStateEvent("popstate"));
      },
      [workspaceId, usageSite] as const,
    );
    await panel(page).getByText("Ask about Opengeni usage").waitFor();
    await page.waitForURL(new RegExp(`/sites/${usageSite}$`, "u"));
    await waitUntil(
      async () =>
        await page.evaluate(
          () =>
            document.activeElement instanceof HTMLTextAreaElement &&
            document.activeElement.closest("aside[aria-label='Chat']") !== null,
        ),
      "the new conversation's composer isn't focused",
    );
    await capture(page, `site-live-new-${theme}`);
    await page.close();

    const published = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await published.emulateMedia({ colorScheme: theme });
    published.on("pageerror", (error) => errors.push(`${theme} published: ${error.message}`));
    await publishedHeader(published, theme);
    await published.close();
  }

  // A short recording of an edit going live, then Undo.
  const videos = path.join(output, "video");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: videos, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "light" });
  page.on("pageerror", (error) => errors.push(`video: ${error.message}`));
  await openSite(page, "light");
  await page.waitForTimeout(800);
  await editLive(page);
  await page.waitForTimeout(1_500);
  await undo(page);
  await page.waitForTimeout(1_500);
  await context.close();
  const [recorded] = await readdir(videos);
  if (recorded) await rename(path.join(videos, recorded), path.join(output, "site-live-edit.webm"));
} finally {
  await browser.close();
}
if (errors.length > 0) throw new Error(errors.join("\n"));
console.log(output);
