import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const output =
  process.env.OPENGENI_GITHUB_PREVIEW_OUTPUT ?? path.join(tmpdir(), "opengeni-github-preview");
const baseUrl = process.env.OPENGENI_GITHUB_PREVIEW_BASE_URL ?? "http://127.0.0.1:4177";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_GITHUB_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_GITHUB_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 780 : 720 },
      deviceScaleFactor: 1,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `${baseUrl}/test/fixtures/github-connect-preview/`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Connect GitHub App" }).waitFor();
    await page.locator(".og-session-capability-logo img").waitFor();
    await page.screenshot({ path: `${output}/github-card-ready-${width}.png` });
    await page.getByRole("button", { name: "Connect GitHub App" }).click();
    await page.getByRole("button", { name: "Opening GitHub…" }).waitFor();
    await page.screenshot({ path: `${output}/github-card-opening-${width}.png` });
    await page.goto(`${url}?state=connected`, { waitUntil: "networkidle" });
    await page.getByText("Connected to this workspace").waitFor();
    await page.screenshot({ path: `${output}/github-card-connected-${width}.png` });
    if (errors.length) throw new Error(`Browser errors at ${width}px: ${errors.join("; ")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
