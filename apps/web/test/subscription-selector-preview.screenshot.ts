import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

// Screenshots of the session-header account control and the composer model
// picker for Codex and Claude, with the hover text of every control listed
// beside them. Serve with:
//   bun x vite --config test/subscription-selector-preview.vite.config.ts --port 4391
const output =
  process.env.OPENGENI_SUBSCRIPTION_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-subscription-selector-preview");
const base = process.env.OPENGENI_SUBSCRIPTION_PREVIEW_URL ?? "http://127.0.0.1:4391";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_SUBSCRIPTION_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_SUBSCRIPTION_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const hover: Record<string, Record<string, string[]>> = {};
const brand: Record<string, string> = { codex: "Codex", claude: "Claude" };
try {
  for (const theme of ["light", "dark"]) {
    for (const provider of ["codex", "claude"]) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const url = (open: string) =>
        `${base}/test/fixtures/subscription-selector-preview/?provider=${provider}&theme=${theme}&open=${open}`;
      const shot = (name: string) =>
        page.screenshot({ path: `${output}/${name}-${provider}-${theme}.png` });

      await page.goto(url("none"), { waitUntil: "networkidle" });
      await page.locator("header").waitFor();
      await page.waitForTimeout(300);
      hover[provider] = {
        header: await page
          .locator("header [title], header [aria-label]")
          .evaluateAll((nodes) =>
            nodes
              .map((node) => node.getAttribute("title") ?? node.getAttribute("aria-label") ?? "")
              .filter(Boolean),
          ),
      };
      await shot("header");

      // Every subscription session shows the same account control in its header.
      const account = page.getByRole("button", {
        name: `${brand[provider]} account`,
        exact: false,
      });
      hover[provider]!.accountTrigger = [(await account.getAttribute("title")) ?? ""];
      await account.click();
      await page.getByRole("menu").waitFor();
      await page.getByText("Use for next turn").waitFor();
      await page
        .getByText(/% used/)
        .first()
        .waitFor();
      hover[provider]!.accountMenu = await page
        .getByRole("menu")
        .locator("[title]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title") ?? ""));
      const rows = await page.getByRole("menuitem").allTextContents();
      if (rows.length !== 4) throw new Error(`${provider}: unexpected rows ${rows.join(" | ")}`);
      await shot("account");

      await page.goto(url("model"), { waitUntil: "networkidle" });
      await page.getByTestId("model-picker-menu").waitFor();
      await page.waitForTimeout(300);
      hover[provider]!.modelMenu = await page
        .getByTestId("model-picker-menu")
        .locator("[title]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title") ?? ""));
      await shot("model");
      if (errors.length > 0) throw new Error(`${provider}: ${errors.join("; ")}`);
      await page.close();
    }
  }
  await writeFile(`${output}/hover.json`, JSON.stringify(hover, null, 2));
} finally {
  await browser.close();
}
