import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runCommand } from "@opengeni/testing";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("artifact library browser acceptance uses the application component harness", async () => {
  // Keep the scenarios owned by the web harness; this wrapper supplies portable
  // CI execution, browser selection, process cleanup, and ignored evidence paths.
  const result = await runCommand(
    [process.execPath, "--no-env-file", "apps/web/test/artifact-library-browser.ts"],
    {
      cwd: repoRoot,
      env: {
        OPENGENI_ARTIFACT_LIBRARY_SCREENSHOTS: join(repoRoot, ".agent", "artifact-library-browser"),
        OPENGENI_TEST_CHROMIUM: process.env.OPENGENI_TEST_CHROMIUM ?? chromium.executablePath(),
      },
      timeoutMs: 180_000,
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
}, 210_000);
