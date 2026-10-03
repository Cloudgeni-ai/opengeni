// Captures the Insights preview: workspace and organization pages at 1440 and
// 390, light and dark, plus the truncated private list and the empty, error
// and loading states. Fails on a page error or horizontal overflow. Start the
// server first:
//   bun run vite dev . --config test/insights-preview.vite.config.ts --port 4291
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const output =
  process.env.OPENGENI_INSIGHTS_PREVIEW_OUTPUT ?? path.join(tmpdir(), "opengeni-insights-preview");
const baseUrl = process.env.OPENGENI_INSIGHTS_PREVIEW_URL ?? "http://127.0.0.1:4291";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
  args: ["--no-sandbox"],
});

async function settle(page: Page, state: string) {
  if (state === "loading") {
    await page.locator('[role="status"][aria-label^="Loading"]').first().waitFor();
  } else if (state === "error") {
    await page
      .getByText(/couldn't load/i)
      .first()
      .waitFor();
  } else if (state === "empty") {
    await page
      .getByText(/No (model calls|usage recorded)/)
      .first()
      .waitFor();
  } else if (state === "truncated") {
    await page.getByText("Showing the largest 200.").last().waitFor();
  } else {
    await page.getByText("Private chats", { exact: true }).last().waitFor();
  }
  // Charts and count-ups animate in; screenshot the settled frame.
  await page.waitForTimeout(1200);
}

const shots: Array<{ page: "workspace" | "org"; state: string; width: number; theme: string }> = [];
for (const page of ["workspace", "org"] as const) {
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) shots.push({ page, state: "data", width, theme });
  }
  shots.push({ page, state: "truncated", width: 1440, theme: "light" });
  for (const state of ["empty", "error", "loading"]) {
    shots.push({ page, state, width: 1440, theme: "light" });
    shots.push({ page, state, width: 390, theme: "dark" });
  }
}

const problems: string[] = [];
try {
  for (const shot of shots) {
    const page = await browser.newPage({
      viewport: { width: shot.width, height: shot.width === 390 ? 844 : 900 },
      reducedMotion: "reduce",
      colorScheme: shot.theme === "dark" ? "dark" : "light",
    });
    const name = `${shot.page}-${shot.state}-${shot.width}-${shot.theme}`;
    page.on("pageerror", (error) => problems.push(`${name}: ${error.message}`));
    await page.goto(
      `${baseUrl}/test/insights-preview.html?page=${shot.page}&state=${shot.state}&theme=${shot.theme}`,
    );
    await settle(page, shot.state);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) problems.push(`${name}: ${overflow}px horizontal overflow`);
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}
if (problems.length > 0) throw new Error(problems.join("\n"));
console.log(`Saved ${shots.length} screenshots to ${output}`);
