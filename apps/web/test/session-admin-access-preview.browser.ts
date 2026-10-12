import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Serve with: bunx vite --config test/model-quota-preview.vite.config.ts (port 4331).
const output = process.env.PREVIEW_OUTPUT ?? "/tmp/session-admin-access-preview";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PREVIEW_CHROMIUM ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const base = "http://127.0.0.1:4331/test/session-admin-access-preview.html";

async function noHorizontalOverflow(page: Page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

try {
  for (const [name, viewport] of [
    ["desktop", { width: 1200, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    const page = await browser.newPage({ viewport, hasTouch: name === "phone" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const toggle = page.getByRole("switch", { name: "Admin access for agent sessions" });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `${output}/${name}-overview.png`, fullPage: true });

    // The shield is the only always-visible sign; the menu explains and turns it off.
    const on = page.getByTestId("header-on");
    const shield = on.locator("[data-session-admin-access]");
    await shield.waitFor();
    assert.equal(
      await page.getByTestId("header-off").locator("[data-session-admin-access]").count(),
      0,
    );
    await shield.click();
    await page.getByText("acts as them", { exact: false }).waitFor();
    await page.screenshot({ path: `${output}/${name}-shield-menu.png` });
    await page.getByRole("menuitem", { name: "Turn off admin access" }).click();
    await shield.waitFor({ state: "detached" });

    // Giving access goes through a confirmation that defaults focus to Cancel.
    const off = page.getByTestId("header-off");
    await off.getByRole("button", { name: "More session actions" }).click();
    await page.getByRole("menuitem", { name: "Give admin access…" }).click();
    const dialog = page.getByRole("dialog", { name: "Give this session admin access?" });
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel");
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `${output}/${name}-grant-dialog.png` });
    await dialog.getByRole("button", { name: "Give admin access" }).click();
    await dialog.waitFor({ state: "detached" });
    await off.locator("[data-session-admin-access]").waitFor();

    // Turning the organization setting off asks first.
    await toggle.click();
    const confirm = page.getByRole("dialog", { name: "Turn off admin access for agents?" });
    await confirm.waitFor();
    await page.screenshot({ path: `${output}/${name}-org-off-confirm.png` });
    await confirm.getByRole("button", { name: "Turn off" }).click();
    await confirm.waitFor({ state: "detached" });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Admin access for agent sessions"]')
          ?.getAttribute("aria-checked") === "false",
    );
    await toggle.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Admin access for agent sessions"]')
          ?.getAttribute("aria-checked") === "true",
    );
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}: org switch, shield menu, revoke, grant confirmation`);
    await page.close();
  }
} finally {
  await browser.close();
}
