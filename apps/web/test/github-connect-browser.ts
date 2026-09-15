// UI proof uses a simulated provider; installation authority is covered by the
// PostgreSQL-backed embedded-github-app-connect test, never by popup messages.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const base = process.env.GITHUB_CONNECT_FIXTURE_URL ?? "http://127.0.0.1:4318";
const output = process.env.GITHUB_CONNECT_SCREENSHOTS ?? "/tmp/github-connect-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // No request is sent to GitHub or any real account.
  await context.route("https://github.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Fixture GitHub authorization</h1><button>Authorize</button>",
    }),
  );
  await context.route(`${base}/github-fixture-callback`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Connection authorized</h1>",
    }),
  );
  for (const accountId of ["42", "new"]) {
    const page = await context.newPage();
    const url = `${base}/test/embedded-connect.html?state=github-account`;
    await page.goto(url);
    await page.getByRole("combobox", { name: "Account", exact: true }).selectOption(accountId);
    const opened = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const popup = await opened;
    await popup.getByRole("heading", { name: "Fixture GitHub authorization" }).waitFor();
    if (await popup.evaluate(() => window.opener !== null))
      throw new Error("Provider retained the opener");
    if (page.url() !== url) throw new Error("Original chat navigated away");
    await page.bringToFront();
    await page.screenshot({
      path: `${output}/account-${accountId}-waiting.png`,
      animations: "disabled",
    });
    await popup.getByRole("button", { name: "Authorize", exact: true }).click();
    // The real callback returns the isolated provider window to the host.
    // An opener cannot close it while it is still on a foreign origin.
    await popup.goto(`${base}/github-fixture-callback`);
    await popup.evaluate(() => localStorage.setItem("github-connect-fixture-complete", "yes"));
    await page.getByText("Account setup finished.", { exact: true }).waitFor();
    // Browsers can detach the original WindowProxy after opener isolation.
    // Completion must still arrive through polling, independent of close().
    if (!popup.isClosed()) await popup.close();
    await page.screenshot({ path: `${output}/account-${accountId}-complete.png` });
    await page.close();
  }
  console.log(
    "Browser checks passed: both account choices open one isolated popup, preserve the original page, and finish from backend polling.",
  );
} finally {
  await browser.close();
}
