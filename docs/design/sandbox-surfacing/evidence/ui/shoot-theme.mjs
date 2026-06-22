// Theme-consistency proof: capture the Files surface in light mode to show the
// dock + Pierre diff + tree retrack the design tokens when data-og-theme flips.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "final");
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(__dirname, "../../../../../");
const { chromium } = await import(path.join(REPO, "node_modules/playwright/index.mjs"));
const EXE = path.join(REPO, "result/bin/chromium");

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer", "--disable-gpu-compositing"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
await page.goto("http://localhost:3100/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
// Flip to light.
await page.locator('button:has-text("Light")').first().click();
await page.waitForTimeout(700);
await page.locator('[role="tab"]:has-text("Files")').first().click();
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(OUT, "files-light.png") });
console.log("[shoot-theme] wrote files-light.png");
await browser.close();
