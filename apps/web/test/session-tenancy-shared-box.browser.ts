import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Serve with: bunx vite --config test/model-quota-preview.vite.config.ts (port 4331).
// Limiting a session that shares its sandbox or Connected Machine is allowed;
// the confirmation says what stays shared.
const output = process.env.PREVIEW_OUTPUT ?? "/tmp/session-tenancy-shared-box";
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

const expected = {
  machine: "Files on its connected machine stay available to whoever can use that machine.",
  sandbox: "Files in its sandbox stay available to other sessions that share it.",
} as const;

try {
  for (const [name, viewport] of [
    ["desktop", { width: 1200, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const box of ["machine", "sandbox"] as const) {
      const page = await browser.newPage({ viewport, hasTouch: name === "phone" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}?case=${box}`);
      await page.getByRole("button", { name: /Manage session access/ }).click();
      await page.getByRole("menuitem", { name: "Limit this session to me…" }).click();
      const dialog = page.getByRole("dialog", { name: "Limit this session to you?" });
      await dialog.waitFor();
      await dialog.getByText(expected[box], { exact: false }).waitFor();
      assert.equal(await dialog.getByText("own sandbox", { exact: false }).count(), 0);
      await noHorizontalOverflow(page);
      await page.screenshot({ path: `${output}/${name}-${box}-limit-dialog.png` });
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
