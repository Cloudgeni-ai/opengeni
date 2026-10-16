// Actual Insights and WorkspaceUsagePage components. No provider calls.
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = process.env.OPENGENI_SITE_AI_PREVIEW_OUTPUT;
if (!output) throw new Error("Set OPENGENI_SITE_AI_PREVIEW_OUTPUT to an owned output directory");
const base = process.env.OPENGENI_SITE_AI_PREVIEW_URL ?? "http://127.0.0.1:4293";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/opt/google/chrome/chrome",
  args: ["--no-sandbox"],
});
const failures: string[] = [];
try {
  for (const pageName of ["workspace", "limits"])
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport: { width, height: width === 390 ? 844 : 1000 },
          reducedMotion: "reduce",
          colorScheme: theme as "light" | "dark",
        });
        const name = `${pageName}-${width}-${theme}`;
        page.on("pageerror", (error) => failures.push(`${name}: ${error.message}`));
        await page.goto(`${base}/test/insights-preview.html?page=${pageName}&theme=${theme}`);
        if (pageName === "workspace") {
          await page.getByText("Customer research", { exact: true }).waitFor();
          const sites = page
            .locator("section")
            .filter({ has: page.getByRole("heading", { name: "Sites", exact: true, level: 2 }) });
          await sites
            .getByRole("heading", { name: "Model costs", exact: true, level: 3 })
            .waitFor();
          await sites
            .getByRole("heading", { name: "Platform activity", exact: true, level: 3 })
            .waitFor();
          if (await page.getByRole("heading", { name: "Site AI", exact: true }).count())
            failures.push(`${name}: narrowed Site AI heading remains`);
          if (await page.locator('a[href*="/sessions/"]').count())
            failures.push(`${name}: unexpected private conversation link`);
        } else {
          await page.getByText("Workspace budget", { exact: true }).waitFor();
          if (await page.getByText("Platform activity", { exact: true }).count())
            failures.push(`${name}: platform analytics remain in Usage`);
          if (await page.getByText("Model costs", { exact: true }).count())
            failures.push(`${name}: AI analytics remain in Usage`);
        }
        await page.waitForTimeout(500);
        if (
          await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          )
        )
          failures.push(`${name}: horizontal overflow`);
        await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
        await page.close();
      }
} finally {
  await browser.close();
}
if (failures.length) throw new Error(failures.join("\n"));
console.log("Eight actual-component previews passed: desktop/mobile, light/dark, Insights/Usage.");
