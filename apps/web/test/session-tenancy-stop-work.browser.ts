import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Serve with: bunx vite --config test/model-quota-preview.vite.config.ts (port 4331).
// Limiting a session with work in progress shows one summary of what stops and
// one confirmation; a block that stopping work would not clear disables it.
const output = process.env.PREVIEW_OUTPUT ?? "/tmp/session-tenancy-stop-work";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PREVIEW_CHROMIUM ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const base = "http://127.0.0.1:4331/test/session-tenancy-control.html";

async function noHorizontalOverflow(page: Page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

try {
  for (const [name, viewport] of [
    ["desktop", { width: 1200, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const scenario of ["work", "blocked"] as const) {
      const page = await browser.newPage({ viewport, hasTouch: name === "phone" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}?case=${scenario}`);
      await page.getByRole("button", { name: /Manage session access/ }).click();
      await page.getByRole("menuitem", { name: "Limit this session to me…" }).click();
      const dialog = page.getByRole("dialog", { name: "Limit this session to you?" });
      await dialog.waitFor();
      if (scenario === "work") {
        await dialog.getByText("This also stops work in progress").waitFor();
        for (const line of [
          "Stop the response that is in progress",
          "Cancel 2 queued messages",
          "Pause the active goal",
        ]) {
          await dialog.getByText(line).waitFor();
        }
        const confirm = dialog.getByRole("button", { name: "Stop work and limit to me" });
        assert(await confirm.isEnabled());
        await noHorizontalOverflow(page);
        await page.screenshot({ path: `${output}/${name}-work-summary.png` });
        await confirm.click();
        await dialog.getByRole("button", { name: "Stopping work…" }).waitFor();
        await page.screenshot({ path: `${output}/${name}-work-stopping.png` });
      } else {
        await dialog.getByText("This session can't be limited to you yet").waitFor();
        await dialog
          .getByText("Pause the scheduled task that targets this session first.")
          .waitFor();
        assert(await dialog.getByRole("button", { name: "Limit to me", exact: true }).isDisabled());
        await noHorizontalOverflow(page);
        await page.screenshot({ path: `${output}/${name}-blocked.png` });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
