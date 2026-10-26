// Checks and captures Sites without conversations in the real sidebar: a Site
// a chat made is a row in that chat's project, and opening a Site keeps its
// place. Light and dark. Start the server first:
//   bunx vite --config test/session-sidebar-preview.vite.config.ts --port 4292
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const output =
  process.env.OPENGENI_SITE_ROWS_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-site-rows-general-preview");
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
const firstInDefault = (page: Page) =>
  page.evaluate(() => {
    const folder = document.querySelector('[role="group"][aria-label="Default"]');
    return folder?.querySelector("a[data-session-row], [data-site-row] a")?.textContent ?? "";
  });
async function capture(page: Page, name: string) {
  await page.mouse.move(900, 700);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
}
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
try {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 760 },
      colorScheme: theme,
    });
    page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
    await page.goto(`${baseUrl}/test/session-sidebar-preview.html?scenario=sites&theme=${theme}`);
    await siteRow(page, "Pricing calculator").waitFor();
    check(
      (await page.getByRole("button", { name: /from Pricing calculator$/ }).count()) === 0,
      "a Site without conversations offered a disclosure",
    );
    await capture(page, `site-rows-created-${theme}`);

    await page.getByRole("button", { name: "Show 4 more sessions in Default" }).click();
    await siteRow(page, "Launch checklist").waitFor();
    check(
      !(await firstInDefault(page)).includes("Launch checklist"),
      "an untouched Site did not sort down",
    );
    await capture(page, `site-rows-untouched-${theme}`);

    await siteRow(page, "Launch checklist").click();
    await page.getByRole("complementary", { name: "Chat", exact: true }).waitFor();
    check(
      !(await firstInDefault(page)).includes("Launch checklist"),
      "opening a Site moved its row",
    );
    await capture(page, `site-rows-opened-${theme}`);
    await page.close();
  }
  check(errors.length === 0, errors.join("\n"));
} finally {
  await browser.close();
}
console.log(output);
