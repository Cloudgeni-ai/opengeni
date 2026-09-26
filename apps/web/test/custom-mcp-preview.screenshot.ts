import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const output =
  process.env.OPENGENI_CUSTOM_MCP_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-custom-mcp-preview");
const baseUrl = process.env.OPENGENI_CUSTOM_MCP_PREVIEW_URL ?? "http://127.0.0.1:4187";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_CUSTOM_MCP_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_CUSTOM_MCP_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
try {
  for (const width of [1100, 390]) {
    for (const role of ["admin", "viewer"]) {
      const page = await browser.newPage({
        viewport: { width, height: width === 390 ? 780 : 720 },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}/test/fixtures/custom-mcp-preview/?role=${role}`, {
        waitUntil: "networkidle",
      });
      await page.getByRole("button", { name: "Review server" }).waitFor();
      await page.screenshot({ path: `${output}/suggestion-${role}-${width}.png` });
      await page.getByRole("button", { name: "Review server" }).click();
      await page.getByLabel("Server URL").waitFor();
      await page.screenshot({ path: `${output}/review-${role}-${width}.png` });
      if (errors.length)
        throw new Error(`Browser errors at ${width}px (${role}): ${errors.join("; ")}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
