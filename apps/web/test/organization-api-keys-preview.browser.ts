import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = process.env.OPENGENI_ORG_KEYS_PREVIEW_OUTPUT;
const baseUrl = process.env.OPENGENI_ORG_KEYS_PREVIEW_URL ?? "http://127.0.0.1:4336";
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_ORG_KEYS_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_ORG_KEYS_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});

try {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}/test/organization-api-keys-preview.html`, {
        waitUntil: "networkidle",
      });
      await page.locator("html").evaluate((node, selectedTheme) => {
        node.dataset.ogTheme = selectedTheme;
        node.classList.toggle("dark", selectedTheme === "dark");
      }, theme);
      await page.getByRole("combobox", { name: "Access" }).click();
      await page.getByRole("option", { name: /^Developer setup/ }).click();
      await page
        .getByText(/Includes broad workspace administration and expires after 24 hours/)
        .waitFor();
      if (await page.getByText("All permissions", { exact: true }).count()) {
        throw new Error("All-permissions fallback must not be offered");
      }
      const axe = await new AxeBuilder({ page })
        .include("main")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      if (axe.violations.length) throw new Error(JSON.stringify(axe.violations));
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
        throw new Error(`Overflow at ${width}px`);
      }
      if (output) {
        await page.screenshot({
          path: `${output}/developer-setup-${theme}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
      await page.getByRole("button", { name: "Create API key", exact: true }).click();
      await page.getByText(/Preview only: no real key was created/).waitFor();
      const submitted = await page.evaluate(
        () => (window as unknown as { submittedRequests: unknown[] }).submittedRequests,
      );
      if (
        JSON.stringify(submitted) !==
        JSON.stringify([{ name: "Organization automation", preset: "developer_setup" }])
      ) {
        throw new Error(`Incorrect setup payload: ${JSON.stringify(submitted)}`);
      }
      if (errors.length) throw new Error(errors.join("; "));
      await context.close();
    }
  }
  console.log(
    "Production organization key component passed desktop/mobile light/dark, accessibility, exact setup payload, no overflow or browser errors.",
  );
} finally {
  await browser.close();
}
