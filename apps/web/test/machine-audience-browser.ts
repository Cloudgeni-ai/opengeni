// Run with: bun apps/web/test/machine-audience-browser.ts
// Renders "Who can use it?" for a connected machine at desktop and phone
// widths, walks the one-step narrowing flow and checks accessibility.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { freePort, startProcess } from "@opengeni/testing";

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output =
  process.env.OPENGENI_MACHINE_AUDIENCE_SCREENSHOTS ?? "/workspace/.agent/machine-audience";
await mkdir(output, { recursive: true });
const web = await startProcess(
  ["bun", "run", "vite", "dev", ".", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: new URL("..", import.meta.url).pathname,
    ready: async () =>
      (await fetch(`${baseUrl}/test/machine-audience.html`).catch(() => null))?.ok === true,
    timeoutMs: 45_000,
  },
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
});

async function noSeriousAxe(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(
    result.violations
      .filter((issue) => ["serious", "critical"].includes(issue.impact ?? ""))
      .map(
        (issue) => `${issue.id}: ${issue.nodes.map((node) => node.target.join(" ")).join(", ")}`,
      ),
    [],
  );
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `page overflows horizontally by ${overflow}px`);
}

try {
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 1500 }],
    ["phone", { width: 390, height: 2200 }],
  ] as const) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/test/machine-audience.html`, { waitUntil: "networkidle" });
    const row = page.getByRole("button", { name: /Who can use Build box: This workspace/ });
    await row.waitFor({ timeout: 90_000 });
    await page.screenshot({ path: `${output}/${name}-detail.png`, fullPage: true });
    await noHorizontalOverflow(page);

    await row.click();
    const dialog = page.getByRole("dialog", { name: "Who can use Build box?" });
    await dialog.waitFor();
    await dialog.getByText("2 chats from other people move off it.", { exact: false }).waitFor();
    const submit = dialog.getByRole("button", { name: "Switch to Only me" });
    assert.equal(await submit.isDisabled(), false);
    await page.screenshot({ path: `${output}/${name}-summary.png`, fullPage: true });
    await noHorizontalOverflow(page);
    await noSeriousAxe(page);

    // The itemized list is one click away.
    await dialog.getByRole("button", { name: /Chats and schedules affected/ }).click();
    await dialog.getByText("Release checklist for the March launch").waitFor();
    await dialog.getByText("Someone's private chat").waitFor();
    await page.screenshot({ path: `${output}/${name}-items.png`, fullPage: true });
    await noSeriousAxe(page);

    // One confirmation applies all of it.
    await submit.click();
    await page.getByRole("button", { name: /Who can use Build box: Only me/ }).waitFor();
    await dialog.waitFor({ state: "detached" });
    const changes = await page.evaluate(
      () =>
        (
          Reflect.get(window, "machineAudienceFixture") as {
            changes: Array<Record<string, unknown>>;
          }
        ).changes,
    );
    assert.deepEqual(changes, [{ audience: "only_me", expectedGeneration: 4 }]);
    await page.screenshot({ path: `${output}/${name}-done.png`, fullPage: true });
    await context.close();
  }
  console.log(`machine audience browser check passed; screenshots in ${output}`);
} finally {
  await browser.close();
  await web.stop();
}
