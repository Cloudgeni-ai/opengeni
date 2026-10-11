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
    for (const result of ["connected", "rejected", "access-failed", "viewer"]) {
      const page = await browser.newPage({ viewport: { width, height: 820 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const theme = width === 390 ? "dark" : "light";
      await page.goto(
        `${baseUrl}/test/fixtures/custom-mcp-preview/?prepared=true&scope=workspace&result=${result}&role=${result === "viewer" ? "viewer" : "admin"}&theme=${theme}`,
        { waitUntil: "networkidle" },
      );
      if (result === "viewer") {
        await page.getByText("Someone with connection and integration management access").waitFor();
      } else {
        await page.getByLabel("API key").waitFor();
        if (result === "connected")
          await page.screenshot({ path: `${output}/prepared-input-${width}.png` });
        await page.getByLabel("API key").fill("synthetic-key");
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await page
          .getByText(
            result === "connected"
              ? "Its tools are available"
              : result === "rejected"
                ? "Nothing was connected"
                : "Your key is saved",
            { exact: false },
          )
          .waitFor();
        if (result === "rejected" && (await page.getByLabel("API key").inputValue()) !== "")
          throw new Error("Submitted key retained in DOM");
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      if (overflow) throw new Error(`Prepared form overflows at ${width}px`);
      await page.screenshot({ path: `${output}/prepared-${result}-${width}.png` });
      if (errors.length) throw new Error(`Prepared form errors: ${errors.join("; ")}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
