// Checks and captures the Site view with the real sidebar, SiteView and
// SessionConversation: a Site row opens the Site with its newest conversation
// beside it as a regular chat, a nested conversation opens the same view with
// it selected, the panel resizes by drag and keyboard and hides, both
// remembered after leaving the Site and coming back, choosing a conversation
// shows a hidden panel, and the conversations stay nested after another
// session is selected. Light and dark. Start the server first:
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
const panel = (page: Page) => page.getByRole("complementary", { name: "Chat", exact: true });
const handle = (page: Page) => page.getByRole("separator", { name: "Resize chat" });
const siteRow = (page: Page, title: string) =>
  sidebar(page).getByRole("link", { name: new RegExp(`^Open ${title}\\. Site`) });
const railConversation = (page: Page, title: string) =>
  sidebar(page).getByRole("link", { name: new RegExp(`^Open ${title}\\.`) });
const panelTitle = (page: Page) => panel(page).getByRole("heading", { level: 2 });
const panelWidth = async (page: Page) =>
  Math.round((await panel(page).boundingBox())?.width ?? Number.NaN);
async function capture(page: Page, name: string) {
  // A clicked sidebar row can keep its hover card open; dismiss it so the
  // capture shows the view itself.
  const card = page.locator("[data-slot=hover-card-content]");
  if ((await card.count()) > 0) {
    await page.keyboard.press("Escape");
    await card.waitFor({ state: "detached" });
  }
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
      (await panelTitle(page).textContent()) === "Time filters across all graphs",
      "the newest conversation is not the one open",
    );
    // The sidebar lists the Site's conversations; the panel doesn't repeat them.
    check(
      (await panel(page).getByRole("navigation").count()) === 0,
      "the panel still lists conversations",
    );
    // The regular chat's composer: the model chip is there.
    await panel(page).getByRole("button", { name: /model/i }).first().waitFor();
    check(
      (await siteRow(page, "Opengeni usage").getAttribute("aria-current")) === "page",
      "the Site row is not marked open",
    );
    await capture(page, `site-view-${theme}`);

    // Switching in the sidebar keeps the Site and opens that conversation.
    await sidebar(page)
      .getByRole("button", { name: "Expand 3 conversations from Opengeni usage", exact: true })
      .click();
    await railConversation(page, "Weekly active users by plan").click();
    await page.waitForURL(new RegExp(`conversation=${conversationId(902)}`, "u"));
    await panel(page).getByText("Weekly active users last week").waitFor();
    check(
      (await panelTitle(page).textContent()) === "Weekly active users by plan",
      "the panel does not name the chosen conversation",
    );
    check(
      (await railConversation(page, "Weekly active users by plan").getAttribute("aria-current")) ===
        "page",
      "the selected conversation is not marked in the sidebar",
    );
    await capture(page, `site-view-selected-${theme}`);

    // Dragging the edge widens the chat; the keyboard moves it too.
    check((await panelWidth(page)) === 400, "the chat does not start at its default width");
    const box = (await handle(page).boundingBox())!;
    const edge = box.x + box.width / 2;
    await page.mouse.move(edge, box.y + 300);
    await page.mouse.down();
    // Over the Site's iframe: the drag must keep following the pointer.
    await page.mouse.move(edge - 80, box.y + 320, { steps: 6 });
    await page.mouse.move(edge - 160, box.y + 340, { steps: 6 });
    await page.mouse.up();
    check((await panelWidth(page)) === 560, `drag left the chat ${await panelWidth(page)}px wide`);
    await handle(page).focus();
    await page.keyboard.press("ArrowRight");
    check((await panelWidth(page)) === 544, "ArrowRight did not narrow the chat");
    await page.keyboard.press("Home");
    check((await panelWidth(page)) === 320, "Home did not narrow the chat to its minimum");
    await page.keyboard.press("End");
    check((await panelWidth(page)) === 720, "End did not widen the chat to its maximum");
    await page.keyboard.press("Shift+ArrowRight");
    check((await panelWidth(page)) === 656, "Shift+ArrowRight did not take a large step");
    await capture(page, `site-view-wide-${theme}`);

    // Hiding leaves one control to bring it back; both are remembered.
    await panel(page).getByRole("button", { name: "Hide chat" }).click();
    await page.getByRole("button", { name: "Show chat" }).waitFor();
    check(
      (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) ===
        "Show chat",
      "focus did not move to Show chat",
    );
    await capture(page, `site-view-hidden-${theme}`);
    // Leaving and coming back keeps both.
    await railConversation(page, "Slack community connection test").click();
    await page.waitForURL(/\/sessions\//u);
    await siteRow(page, "Opengeni usage").click();
    await page.waitForURL(new RegExp(`/sites/${usageSite}$`, "u"));
    await page.getByRole("button", { name: "Show chat" }).click();
    await panel(page)
      .getByText("The range picker at the top now filters all four graphs")
      .waitFor();
    check((await panelWidth(page)) === 656, "the chosen width was not remembered");
    // Double-click puts it back to the default.
    await handle(page).dblclick();
    check((await panelWidth(page)) === 400, "double-click did not restore the default width");

    // A nested conversation in the sidebar opens the same view with it
    // selected, and shows the chat if it was hidden.
    await panel(page).getByRole("button", { name: "Hide chat" }).click();
    await page.getByRole("button", { name: "Show chat" }).waitFor();
    await railConversation(page, "Export usage to CSV").click();
    await page.waitForURL(
      new RegExp(`/sites/${usageSite}\\?conversation=${conversationId(903)}`, "u"),
    );
    await panel(page).getByText("one row per workspace and week").waitFor();

    // New conversation: one action, the composer in the panel.
    await panel(page).getByRole("button", { name: "New" }).click();
    await panel(page).getByText("Ask about Opengeni usage").waitFor();
    // The composer's headline says it; the header only names it for screen readers.
    check(
      (await panelTitle(page).evaluate(
        (heading) => heading.childElementCount === 1 && heading.firstElementChild?.className,
      )) === "sr-only",
      "the header repeats the composer's headline",
    );
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
