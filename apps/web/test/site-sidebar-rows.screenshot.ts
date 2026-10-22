// Checks and captures Site rows in the real sidebar: a Site with conversations
// is a stable row whose conversations stay nested under it, whichever session
// is open. Light and dark. Start the server first:
//   bunx vite --config test/session-sidebar-preview.vite.config.ts --port 4292
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const output =
  process.env.OPENGENI_SITE_ROWS_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-site-sidebar-rows-preview");
const baseUrl = process.env.OPENGENI_SITE_ROWS_PREVIEW_URL ?? "http://127.0.0.1:4292";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.OPENGENI_TEST_CHROMIUM
    ? { executablePath: process.env.OPENGENI_TEST_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const errors: string[] = [];
const siteRow = (page: Page, title: string) =>
  page.getByRole("link", { name: new RegExp(`^Open ${title}\\. Site`) });
const conversation = (page: Page, title: string) =>
  page.getByRole("link", { name: new RegExp(`^Open ${title}\\.`) });
async function capture(page: Page, name: string) {
  // Let disclosure animations settle, away from any hovered row.
  await page.mouse.move(900, 700);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
}
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
try {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
    await page.goto(`${baseUrl}/test/session-sidebar-preview.html?scenario=sites&theme=${theme}`);
    await siteRow(page, "Opengeni usage").waitFor();
    // Collapsed by default with a count; nothing from the Site at the top level.
    check(
      (await conversation(page, "Time filters across all graphs").count()) === 0,
      "a Site conversation was listed while its Site was collapsed",
    );
    check(
      (await siteRow(page, "IPO research dashboard").count()) === 1,
      "the project's Site row is missing",
    );
    await capture(page, `site-rows-collapsed-${theme}`);

    await page
      .getByRole("button", { name: /^Expand 3 conversations from Opengeni usage$/ })
      .click();
    await conversation(page, "Weekly active users by plan").waitFor();
    await capture(page, `site-rows-expanded-${theme}`);

    // Open a nested conversation, collapse the Site, then select another session.
    await conversation(page, "Time filters across all graphs").click();
    await page.waitForURL(/\/sessions\//u);
    await page
      .getByRole("button", { name: /^Collapse 3 conversations from Opengeni usage$/ })
      .click();
    await conversation(page, "Time filters across all graphs").waitFor();
    await capture(page, `site-rows-selected-${theme}`);
    await conversation(page, "Slack community connection test").click();
    await page.waitForTimeout(300);
    check(
      (await siteRow(page, "Opengeni usage").count()) === 1,
      "the Site row vanished after selecting another session",
    );
    check(
      (await conversation(page, "Time filters across all graphs").count()) === 0,
      "the Site conversation leaked to the top level after selecting another session",
    );
    await page
      .getByRole("button", { name: /^Expand 3 conversations from Opengeni usage$/ })
      .click();
    await conversation(page, "Time filters across all graphs").waitFor();
    await capture(page, `site-rows-after-switch-${theme}`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length > 0) throw new Error(errors.join("\n"));
console.log(output);
