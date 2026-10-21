// Run with: bun apps/web/test/file-audience-browser.ts
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = process.env.OPENGENI_FILE_AUDIENCE_SCREENSHOTS ?? "/workspace/.agent/file-audience";
await mkdir(output, { recursive: true });
const web = await startProcess(
  [
    "bun",
    "run",
    "vite",
    "dev",
    ".",
    "--config",
    "test/file-audience.vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: new URL("..", import.meta.url).pathname,
    ready: async () =>
      (await fetch(`${baseUrl}/test/file-audience.html`).catch(() => null))?.ok === true,
    timeoutMs: 45_000,
  },
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
});

const changes = (page: Page) =>
  page.evaluate(
    () => (Reflect.get(window, "fileAudienceFixture") as { changes: string[] }).changes,
  );

async function open(page: Page, query: string, ready: () => Promise<void>) {
  await page.goto(`${baseUrl}/test/file-audience.html${query}`, { waitUntil: "networkidle" });
  // The first load pays Vite's cold transforms, slow on a busy machine.
  await ready();
}

async function noSeriousAxe(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(
    result.violations
      .filter((issue) => ["serious", "critical"].includes(issue.impact ?? ""))
      .map((issue) => issue.id),
    [],
  );
}

async function noOverflow(page: Page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "no horizontal overflow",
  );
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const onlyMeChip = page.getByRole("button", {
      name: "Who can open this file: Only me. Change who can open it",
    });
    const workspaceChip = page.getByRole("button", {
      name: "Who can open this file: Workspace. Change who can open it",
    });
    const share = page.getByRole("button", { name: "Share with workspace", exact: true });
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));

    // The owner of an Only me file sees who can open it and a clear Share action.
    await open(page, "", () =>
      page
        .getByRole("heading", { name: "Q3 revenue forecast.csv", level: 1 })
        .waitFor({ timeout: 90_000 }),
    );
    await onlyMeChip.waitFor();
    await share.waitFor();
    await page.screenshot({ path: `${output}/file-owner-only-me-${width}.png` });
    await noSeriousAxe(page);
    await noOverflow(page);

    // The chip's menu explains it and offers sharing; sharing confirms first.
    await onlyMeChip.click();
    await page.getByText("Only you can open this file.").waitFor();
    await page.screenshot({ path: `${output}/file-owner-menu-${width}.png` });
    await page.getByRole("menuitem", { name: "Share with workspace…" }).click();
    await dialog.getByText("Share “Q3 revenue forecast.csv” with Growth team?").waitFor();
    await page.screenshot({ path: `${output}/file-share-confirm-${width}.png` });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(await changes(page), []);
    await share.click();
    await dialog.getByRole("button", { name: "Share with workspace" }).click();
    await workspaceChip.waitFor();
    assert.deepEqual(await changes(page), ["44444444-4444-4444-8444-444444444441:workspace"]);
    await page.getByText("File shared with workspace").waitFor();
    assert.equal(await share.count(), 0, "a shared file has no Share button");
    await page.screenshot({ path: `${output}/file-shared-${width}.png` });

    // Someone else's Only me file says it is private and what to do, nothing more.
    await open(page, "?others", () =>
      page.getByText("This file is private").waitFor({ timeout: 90_000 }),
    );
    await page.getByText("Ask them to share it with the workspace.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Retry" }).count(), 0);
    await page.screenshot({ path: `${output}/file-private-no-access-${width}.png` });
    await noSeriousAxe(page);
    await noOverflow(page);

    // The library marks Only me files and offers their owner the same choice.
    await open(page, "?library", () =>
      page
        .getByRole("link", { name: "Q3 revenue forecast.csv", exact: true })
        .waitFor({ timeout: 90_000 }),
    );
    await page.getByRole("radio", { name: "List", exact: true }).click();
    const draftRow = page.locator("[data-slot=list-row]", { hasText: "Q3 revenue forecast.csv" });
    await draftRow.getByText("Only me", { exact: true }).waitFor();
    assert.equal(
      await page
        .locator("[data-slot=list-row]", { hasText: "Team roster.csv" })
        .getByText("Only me", { exact: true })
        .count(),
      0,
    );
    await page.screenshot({ path: `${output}/library-only-me-${width}.png` });
    await page
      .getByRole("button", { name: "More actions for Q3 revenue forecast.csv", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Share with workspace…" }).waitFor();
    await page.screenshot({ path: `${output}/library-menu-${width}.png` });
    await page.getByRole("menuitem", { name: "Share with workspace…" }).click();
    await dialog.getByRole("button", { name: "Share with workspace" }).click();
    await page.getByText("File shared with workspace").waitFor();
    // A teammate's file offers no audience change to anyone else.
    await page
      .getByRole("button", { name: "More actions for Board meeting notes.csv", exact: true })
      .click();
    assert.equal(
      await page.getByRole("menuitem", { name: /Share with workspace|Limit to me/ }).count(),
      0,
    );
    await page.keyboard.press("Escape");
    // Each page load starts the fixture afresh, so this is the library's one change.
    assert.deepEqual(await changes(page), ["44444444-4444-4444-8444-444444444441:workspace"]);
    await noOverflow(page);

    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `File audience ${width}: chip, menu, Share button, confirm/cancel, share, private no-access page, library marker, library share and accessibility passed.`,
    );
  }
} finally {
  await browser.close();
  await web.stop();
}
