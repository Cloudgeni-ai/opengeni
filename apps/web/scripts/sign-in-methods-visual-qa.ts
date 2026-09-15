import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

// Run against the web dev server. This verifies actual production components
// with explicitly simulated provider outcomes; it does not exercise OAuth.
const base = process.env.OPENGENI_VISUAL_QA_URL ?? "http://127.0.0.1:3000";
const output = process.env.OPENGENI_VISUAL_QA_OUTPUT ?? "/workspace/sign-in-methods-qa";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
try {
  await page.goto(`${base}/dev/onboarding?view=security`);
  await page.getByRole("heading", { name: "Security", exact: true }).waitFor();
  assert(
    await page.getByRole("button", { name: "Disconnect Google" }).isDisabled(),
    "Last method must be protected",
  );
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Reconnect GitHub" }).click();
  await page.getByRole("status").filter({ hasText: "sign-in method connected" }).waitFor();
  await page.getByRole("button", { name: "Disconnect GitHub" }).click();
  await page.getByRole("dialog").waitFor();
  assert(
    await page
      .getByRole("button", { name: "Cancel", exact: true })
      .evaluate((node) => node === document.activeElement),
    "Disconnect must focus the safe action",
  );
  await page.screenshot({ path: `${output}/disconnect.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByLabel("New password", { exact: true }).fill("preview-new-password");
  await page.getByLabel("Confirm new password", { exact: true }).fill("preview-other-password");
  await page.getByRole("button", { name: "Save password" }).click();
  await page.getByRole("alert").filter({ hasText: "passwords don't match" }).waitFor();
  await page.screenshot({ path: `${output}/password-validation.png`, fullPage: true });
  await page.getByLabel("Confirm new password", { exact: true }).fill("preview-new-password");
  await page.getByRole("button", { name: "Save password" }).click();
  await page.getByRole("button", { name: "Change password" }).waitFor();
  await page.goto(`${base}/dev/onboarding?view=security&state=reauth`);
  await page.getByRole("button", { name: "Sign in again" }).waitFor();
  assert(
    await page.getByRole("button", { name: "Reconnect GitHub" }).isDisabled(),
    "Stale authentication must lock changes",
  );
  await page.screenshot({ path: `${output}/reauth.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Narrow screen must not overflow horizontally",
  );
  await page.getByRole("button", { name: "Open personal settings menu" }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: `${output}/mobile-menu.png`, fullPage: true });
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({ passed: true, output, screenshots: 6, errors }));
} finally {
  await browser.close();
}
