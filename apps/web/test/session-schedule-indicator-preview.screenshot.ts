// Captures the schedule indicator preview: the real sidebar rows (one with an
// upcoming schedule, one whose schedules are paused or past) with their hover
// cards, and the real session header in each schedule state, light and dark.
// Start the server first:
//   bunx vite --config test/session-sidebar-preview.vite.config.ts --port 4292
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const output =
  process.env.OPENGENI_SCHEDULE_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-schedule-indicator-preview");
const baseUrl = process.env.OPENGENI_SCHEDULE_PREVIEW_URL ?? "http://127.0.0.1:4292";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
  args: ["--no-sandbox"],
});
const errors: string[] = [];
try {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
    await page.goto(`${baseUrl}/test/session-sidebar-preview.html?scenario=hover&theme=${theme}`);
    await page
      .getByText(/^Show \d+ more$/)
      .first()
      .click();
    await page.getByText("Release stabilization checkpoint").first().waitFor();
    await page.screenshot({ path: path.join(output, `sidebar-${theme}.png`) });
    for (const [name, title] of [
      ["upcoming", "Quarterly cloud cost report"],
      ["lapsed", "Release stabilization checkpoint"],
    ] as const) {
      await page.getByText(title).first().hover();
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(output, `sidebar-hover-${name}-${theme}.png`) });
      await page.mouse.move(900, 700);
      await page.waitForTimeout(400);
    }
    await page.goto(`${baseUrl}/test/session-schedule-header-preview.html?theme=${theme}`);
    await page.getByText("No schedules").waitFor();
    await page.screenshot({ path: path.join(output, `header-${theme}.png`), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length > 0) throw new Error(errors.join("\n"));
console.log(output);
