// Checks and captures the Site view with the real sidebar, SiteView and
// SessionConversation: a Site row opens the Site with its conversations
// beside it (the newest open), a nested conversation opens the same view with
// it selected, and the conversations stay nested after another session is
// selected. Light and dark. Start the server first:
//   bunx vite --config test/session-sidebar-preview.vite.config.ts --port 4292
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const output =
  process.env.OPENGENI_SITE_VIEW_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-site-view-preview");
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
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace sidebar" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Conversations" });
const siteRow = (page: Page, title: string) =>
  sidebar(page).getByRole("link", { name: new RegExp(`^Open ${title}\\. Site`) });
const railConversation = (page: Page, title: string) =>
  sidebar(page).getByRole("link", { name: new RegExp(`^Open ${title}\\.`) });
const panelConversation = (page: Page, title: string) =>
  panel(page).getByRole("link", { name: new RegExp(`^${title}\\.`) });
async function capture(page: Page, name: string) {
  await page.mouse.move(1300, 880);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
}
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
const usageSite = "00000000-0000-4000-a000-000000000001";
const conversationId = (number: number) =>
  `00000000-0000-4000-9000-${String(number).padStart(12, "0")}`;
try {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.emulateMedia({ colorScheme: theme });
    page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
    await page.goto(`${baseUrl}/test/session-sidebar-preview.html?scenario=sites&theme=${theme}`);

    // The Site row opens the Site with its newest conversation beside it.
    await siteRow(page, "Opengeni usage").click();
    await page.waitForURL(new RegExp(`/sites/${usageSite}$`, "u"));
    await page.frameLocator("iframe").first().getByText("Weekly active users").first().waitFor();
    await panel(page)
      .getByText("The range picker at the top now filters all four graphs")
      .waitFor();
    check(
      (await panelConversation(page, "Time filters across all graphs").getAttribute(
        "aria-current",
      )) === "true",
      "the newest conversation is not the one open",
    );
    check(
      (await siteRow(page, "Opengeni usage").getAttribute("aria-current")) === "page",
      "the Site row is not marked open",
    );
    await capture(page, `site-view-${theme}`);

    // Switching in the panel keeps the Site and selects that conversation.
    await panelConversation(page, "Weekly active users by plan").click();
    await page.waitForURL(new RegExp(`conversation=${conversationId(902)}`, "u"));
    await panel(page).getByText("Weekly active users last week").waitFor();
    await railConversation(page, "Weekly active users by plan").waitFor();
    check(
      (await railConversation(page, "Weekly active users by plan").getAttribute("aria-current")) ===
        "page",
      "the selected conversation is not marked in the sidebar",
    );
    await capture(page, `site-view-selected-${theme}`);

    // A nested conversation in the sidebar opens the same view with it selected.
    await railConversation(page, "Export usage to CSV").click();
    await page.waitForURL(
      new RegExp(`/sites/${usageSite}\\?conversation=${conversationId(903)}`, "u"),
    );
    await panel(page).getByText("one row per workspace and week").waitFor();

    // New conversation: one action, the composer in the panel.
    await panel(page).getByRole("button", { name: "New" }).click();
    await panel(page).getByText("Ask about Opengeni usage").waitFor();
    await capture(page, `site-view-new-${theme}`);

    // Selecting another session keeps the Site's conversations nested.
    await railConversation(page, "Slack community connection test").click();
    await page.waitForURL(/\/sessions\//u);
    await page.waitForTimeout(300);
    for (const title of [
      "Time filters across all graphs",
      "Weekly active users by plan",
      "Export usage to CSV",
    ])
      check(
        (await railConversation(page, title).count()) === 1,
        `${title} vanished from the sidebar after selecting another session`,
      );
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length > 0) throw new Error(errors.join("\n"));
console.log(output);
