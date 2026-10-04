#!/usr/bin/env bun
/**
 * Capture docs-site/images/embedded-conversation{,-dark}.png: OpenGeniChat with
 * fixture data inside a plain host app (packages/react/demo/embedded-chat.tsx),
 * light and dark, 1440x900 at 2x. Real components and projection; only the
 * client is scripted.
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

const repoRoot = new URL("..", import.meta.url).pathname;
const outputs = [
  { theme: "light", path: join(repoRoot, "docs-site/images/embedded-conversation.png") },
  { theme: "dark", path: join(repoRoot, "docs-site/images/embedded-conversation-dark.png") },
] as const;
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
  for (const { theme, path } of outputs) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    await page.goto(`${baseUrl}/embedded-chat.html?theme=${theme}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Approve" }).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await mkdir(dirname(path), { recursive: true });
    await page.screenshot({ path });
    await page.close();
    process.stdout.write(`wrote ${path}\n`);
  }
} finally {
  await browser.close();
  await demo.stop();
}
