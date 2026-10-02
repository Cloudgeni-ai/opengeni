#!/usr/bin/env bun
/**
 * Capture docs-site/images/embedded-conversation.png: OpenGeniChat with
 * fixture data (packages/react/demo/embedded-chat.tsx), light theme,
 * 1600x1000. Real components and projection; only the client is scripted.
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

const repoRoot = new URL("..", import.meta.url).pathname;
const output = join(repoRoot, "docs-site/images/embedded-conversation.png");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const demo = await startProcess(
  [
    "bun",
    "run",
    "vite",
    "dev",
    "demo",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: join(repoRoot, "packages/react"),
    ready: async () =>
      (
        await fetch(`${baseUrl}/embedded-chat.html`, { signal: AbortSignal.timeout(2_000) }).catch(
          () => null,
        )
      )?.ok === true,
    timeoutMs: 60_000,
  },
);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch(
  executablePath && existsSync(executablePath) ? { executablePath } : undefined,
);
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await page.goto(`${baseUrl}/embedded-chat.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve" }).first().waitFor({ timeout: 30_000 });
  // Show the tool calls: expand the turn's collapsed activity summary.
  const summary = page.getByRole("button", { name: /steps/ }).first();
  if (await summary.isVisible()) await summary.click();
  await page.waitForTimeout(300);
  const jump = page.getByRole("button", { name: "Jump to latest" });
  if (await jump.isVisible()) await jump.click();
  await page.waitForTimeout(500);
  await mkdir(dirname(output), { recursive: true });
  await page.screenshot({ path: output });
  process.stdout.write(`wrote ${output}\n`);
} finally {
  await browser.close();
  await demo.stop();
}
