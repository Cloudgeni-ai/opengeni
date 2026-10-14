// Run with: bun apps/web/test/site-audience-browser.ts
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { freePort, startProcess } from "@opengeni/testing";

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = process.env.OPENGENI_SITE_AUDIENCE_SCREENSHOTS ?? "/workspace/.agent/site-audience";
await mkdir(output, { recursive: true });
const web = await startProcess(
  [
    "bun",
    "run",
    "vite",
    "dev",
    ".",
    "--config",
    "test/site-audience.vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: new URL("..", import.meta.url).pathname,
    ready: async () =>
      (await fetch(`${baseUrl}/test/site-audience.html`).catch(() => null))?.ok === true,
    timeoutMs: 45_000,
  },
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
});

const changes = (page: Page) =>
  page.evaluate(
    () => (Reflect.get(window, "siteAudienceFixture") as { changes: string[] }).changes,
  );

async function open(page: Page, query = "") {
  await page.goto(`${baseUrl}/test/site-audience.html${query}`, { waitUntil: "networkidle" });
  // The first load pays Vite's cold transforms, slow on a busy machine.
  await (
    query.includes("library")
      ? page.getByRole("link", { name: "Product analytics", exact: true })
      : page.getByRole("heading", { name: "Product analytics", level: 1 })
  ).waitFor({ timeout: 90_000 });
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

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const onlyMeChip = page.getByRole("button", {
      name: "Who can see this Site: Only me. Change who can see it",
    });
    const workspaceChip = page.getByRole("button", {
      name: "Who can see this Site: Workspace. Change who can see it",
    });
    const share = page.getByRole("button", { name: "Share with workspace", exact: true });
    // The Site viewer is a dialog element too; name the confirmation.
    const dialog = page.getByRole("dialog", { name: /with Growth team\?|to you\?/ });

    // The owner of an Only me Site sees who can see it and a clear Share action.
    await open(page);
    await onlyMeChip.waitFor();
    await share.waitFor();
    await page.screenshot({ path: `${output}/owner-only-me-${width}.png` });
    await noSeriousAxe(page);
    // Share, Edit and ⋯ all fit, even on a phone.
    const more = await page
      .getByRole("button", { name: "More actions for Product analytics" })
      .boundingBox();
    assert.ok(more && more.x + more.width <= width, "the ⋯ menu stays on screen");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "no horizontal overflow",
    );

    // The chip's menu explains the audience and offers sharing.
    await onlyMeChip.click();
    await page.getByText("Only you can see and open this Site.").waitFor();
    await page.screenshot({ path: `${output}/owner-menu-${width}.png` });
    await page.getByRole("menuitem", { name: "Share with workspace…" }).click();
    await dialog.waitFor();
    await dialog.getByText("Share “Product analytics” with Growth team?").waitFor();
    await page.screenshot({ path: `${output}/share-confirm-${width}.png` });
    // Cancel keeps it Only me and changes nothing.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(await changes(page), []);

    // The Share button confirms, then shares.
    await share.click();
    await dialog.getByRole("button", { name: "Share with workspace" }).click();
    await workspaceChip.waitFor();
    await page.getByText("Site shared with workspace").waitFor();
    assert.equal(await share.count(), 0, "a shared Site has no Share button");
    assert.deepEqual(await changes(page), ["workspace"]);
    await page.screenshot({ path: `${output}/shared-${width}.png` });

    // A shared Site can be limited to its owner again, after confirming.
    await workspaceChip.click();
    await page.getByRole("menuitem", { name: "Limit to me…" }).click();
    await dialog.getByText("Limit “Product analytics” to you?").waitFor();
    await dialog.getByRole("button", { name: "Limit to me" }).click();
    await onlyMeChip.waitFor();
    assert.deepEqual(await changes(page), ["workspace", "private"]);

    // When Only me is off, limiting is offered but disabled, with the reason.
    await open(page, "?audience=workspace&only-me-off");
    await workspaceChip.click();
    const limit = page.getByRole("menuitem", { name: /Limit to me/ });
    await limit.waitFor();
    assert.equal(await limit.getAttribute("aria-disabled"), "true");
    await page.getByText("Only me is turned off for this organization.").waitFor();
    await page.screenshot({ path: `${output}/only-me-off-${width}.png` });
    await page.keyboard.press("Escape");

    // A failed change says so, keeps the confirmation open to retry, and
    // leaves the audience as it was.
    await open(page, "?share-error");
    await share.click();
    await dialog.getByRole("button", { name: "Share with workspace" }).click();
    await page.getByText("Couldn't share Site").waitFor();
    await page.screenshot({ path: `${output}/share-error-${width}.png` });
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await onlyMeChip.waitFor();

    // Anyone else sees the audience but cannot change it.
    await open(page, "?viewer=other&audience=workspace");
    await page
      .getByLabel(
        "Who can see this Site: Workspace. Everyone in Growth team can see and open this Site.",
      )
      .waitFor();
    assert.equal(await page.getByRole("button", { name: /Change who can see it/ }).count(), 0);
    assert.equal(await share.count(), 0);
    await page.screenshot({ path: `${output}/other-member-${width}.png` });

    // The library marks an Only me Site.
    await open(page, "?library");
    await page.getByText("Only me", { exact: true }).first().waitFor();
    await page.screenshot({ path: `${output}/library-${width}.png` });

    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `Site audience ${width}: chip, menu, Share button, confirm/cancel, share, limit, Only me off, error, read-only member, library marker and accessibility passed.`,
    );
  }
} finally {
  await browser.close();
  await web.stop();
}
