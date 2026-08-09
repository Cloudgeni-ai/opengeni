import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, runCommand, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("sandbox code editor browser acceptance", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const build = await runCommand(["bun", "run", "vite", "build", "demo"], {
      cwd: `${repoRoot}/packages/react`,
      timeoutMs: 45_000,
    });
    if (build.exitCode !== 0) {
      throw new Error(`Workbench demo build failed:\n${build.stdout}\n${build.stderr}`);
    }
    const executablePath = existsSync("/usr/local/bin/chromium")
      ? "/usr/local/bin/chromium"
      : undefined;
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    demo = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "preview",
        "demo",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/workbench-dock.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 60_000);

  test("real keyboard input marks the buffer dirty and save re-baselines it", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? String(error)));
    try {
      const { editor, editable, save } = await openEditor(page, baseUrl);
      expect(await editor.getAttribute("data-opengeni-editor-dirty")).toBe("false");
      expect(await save.isDisabled()).toBe(true);

      await editable.click();
      await editable.press("Control+End");
      await editable.press("Enter");
      await editable.pressSequentially("ui edit persisted");

      await waitForDirty(page, true);
      expect(await editable.textContent()).toContain("ui edit persisted");
      expect(await save.isDisabled()).toBe(false);

      await save.click();
      await waitForDirty(page, false);
      await page.getByText("Saved", { exact: true }).waitFor();
      expect(await save.isDisabled()).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("undoing the same keyboard edit returns to the clean baseline", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? String(error)));
    try {
      const { editable, save } = await openEditor(page, baseUrl);
      await editable.click();
      await editable.press("Control+End");
      await editable.pressSequentially("x");
      await waitForDirty(page, true);

      await editable.press("Control+Z");
      await waitForDirty(page, false);
      expect(await save.isDisabled()).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

async function openEditor(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/workbench-dock.html?state=warm-live&theme=dark&tab=files`, {
    waitUntil: "networkidle",
  });
  const file = page.getByRole("treeitem").filter({ hasText: "README.md" }).first();
  await file.getByRole("button").click();
  const viewer = page.locator("#sandbox-files-viewer");
  await viewer.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = viewer.locator("[data-opengeni-code-editor]");
  const editable = editor.locator(".cm-content");
  await editable.waitFor();
  return {
    editor,
    editable,
    save: editor.getByRole("button", { name: "Save", exact: true }),
  };
}

async function waitForDirty(page: Page, dirty: boolean): Promise<void> {
  await page.waitForFunction(
    ({ selector, expected }) =>
      document.querySelector(selector)?.getAttribute("data-opengeni-editor-dirty") === expected,
    {
      selector: "#sandbox-files-viewer [data-opengeni-code-editor]",
      expected: dirty ? "true" : "false",
    },
    { timeout: 5_000 },
  );
}
