import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${process.env.OPENGENI_INTEGRATIONS_FIXTURE_URL ?? "http://127.0.0.1:4181"}/test/organization-integrations.html`);
    const slack = page.getByRole("checkbox", { name: /Slack/ });
    await slack.waitFor();
    await slack.focus();
    await page.keyboard.press("Space");
    if (!(await slack.isChecked())) throw new Error("Keyboard selection failed");
    const search = page.getByRole("searchbox", { name: "Search integrations by name or stable key" });
    await search.fill("no-matching-integration");
    if (!(await page.getByText("1 selected", { exact: true }).isVisible())) throw new Error("Search changed selected count");
    if (await page.getByText("Saving will block all new", { exact: false }).count()) throw new Error("Filtered empty mislabeled deny-all");
    await search.fill("custom:graphql");
    await page.getByRole("checkbox", { name: /Custom GraphQL/ }).check();
    await search.fill("");
    const save = page.getByRole("button", { name: "Save changes", exact: true });
    await save.focus(); await page.keyboard.press("Enter");
    await page.getByText("Integration settings saved.", { exact: true }).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Horizontal overflow");
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`${viewport.width}px: keyboard selection/save, search, custom choice, preserved count, no overflow or page errors passed`);
    await page.close();
  }
} finally { await browser.close(); }