// Screenshots of Settings > Computer use in its four states, from the preview
// page (`this-computer-preview.vite.config.ts`). Run the preview server first.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const output =
  process.env.OPENGENI_THIS_COMPUTER_PREVIEW_OUTPUT ??
  path.join(tmpdir(), "opengeni-this-computer-preview");
const baseUrl = process.env.OPENGENI_THIS_COMPUTER_PREVIEW_URL ?? "http://127.0.0.1:3241";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const state of ["off", "mixed", "needed", "allowed"]) {
    const page = await browser.newPage({ viewport: { width: 980, height: 1200 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/test/fixtures/this-computer-preview/?state=${state}`, {
      waitUntil: "networkidle",
    });
    await page.getByText("Control the screen").waitFor();
    await page.getByText("Microphone", { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/this-computer-${state}.png`, fullPage: true });
    if (errors.length) throw new Error(`Browser errors (${state}): ${errors.join("; ")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
