import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

import { freePort, runCommand, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "00000000-0000-4000-8000-000000000017";
const accountId = "00000000-0000-4000-8000-000000000018";
const capabilityId = "mcp:browser-focus";
const capabilityName = "Example capability connector with a deterministically long provider name";
const mobbinCapabilityId = "mcp:integrations-sh:mobbin-com-browser-fixture";
const mobbinConnectionId = "00000000-0000-4000-8000-000000000120";
const driveCapabilityId = "api:openapi:google-drive-browser-fixture";
const driveConnectionId = "00000000-0000-4000-8000-000000000130";
const driveInstanceId = "00000000-0000-4000-8000-000000000131";
const evidenceDir = new URL("../../.agent/evidence/capabilities-focus/", import.meta.url).pathname;
const mobbinEvidenceDir = new URL("../../.agent/evidence/mobbin-mcp/", import.meta.url).pathname;
const apiContractRevision = OPENGENI_API_CONTRACT_REVISION;

type CapabilityState = {
  enabled: boolean;
  failNextEnable: boolean;
  enableCalls: number;
};

type MobbinUiState = {
  mode: "disconnected" | "connected" | "revoked";
  oauthStarts: number;
  oauthRequest: Record<string, unknown> | null;
};

type DriveUiState = {
  driveSaves: number;
  sourceRequest: Record<string, unknown> | null;
  binding: Record<string, unknown> | null;
};

describe("capabilities browser e2e", () => {
  let browser: Browser;
  let web: StartedProcess;
  let webBaseUrl: string;

  beforeAll(async () => {
    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    await Promise.all([
      mkdir(evidenceDir, { recursive: true }),
      mkdir(mobbinEvidenceDir, { recursive: true }),
    ]);
    const webEnv = {
      NODE_ENV: "production",
      VITE_API_BASE_URL: "http://127.0.0.1:9",
    };
    const build = await runCommand(["bun", "run", "build"], {
      cwd: `${repoRoot}/apps/web`,
      env: webEnv,
      timeoutMs: 120_000,
    });
    if (build.exitCode !== 0) {
      throw new Error(`Production web build failed:\n${build.stdout}\n${build.stderr}`);
    }
    await expectNoCapabilitiesChunkCycle(`${repoRoot}/apps/web/dist/assets`);
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "preview",
        "--port",
        String(webPort),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        env: webEnv,
        ready: async () =>
          (
            await fetch(webBaseUrl, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    const executablePath = existsSync("/usr/local/bin/chromium")
      ? "/usr/local/bin/chromium"
      : undefined;
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("successful enable focuses the rendered Enabled control and preserves keyboard flow", async () => {
    const state: CapabilityState = { enabled: false, failNextEnable: false, enableCalls: 0 };
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installCapabilityApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });

      const browseOpener = await openBrowseSheet(page);
      await page.getByRole("dialog").getByRole("button", { name: "Enable" }).click();

      const enabledControl = page.locator(
        `[data-capability-focus-target][data-capability-id="${capabilityId}"]`,
      );
      await expectVisible(enabledControl);
      await expectFocused(enabledControl);
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BUTTON");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-hidden"))).toBe(
        null,
      );
      expect(await browseOpener.count()).toBe(0);

      await page.keyboard.press("Tab");
      await expectFocused(page.getByRole("button", { name: "Disconnect" }));

      await page.screenshot({ path: `${evidenceDir}success-desktop-1440x900.png`, fullPage: true });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("default-dark Enable action preserves WCAG AA text contrast", async () => {
    const state: CapabilityState = { enabled: false, failNextEnable: false, enableCalls: 0 };
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installCapabilityApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });

      expect(
        await page.evaluate(() => document.documentElement.hasAttribute("data-og-theme")),
      ).toBe(false);
      await openBrowseSheet(page);
      await expectVisible(page.getByRole("dialog").getByRole("button", { name: "Enable" }));

      const axe = await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withRules(["color-contrast"])
        .analyze();
      expect(axe.violations).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("Escape and an enable error restore the exact opener on a coarse pointer", async () => {
    const state: CapabilityState = { enabled: false, failNextEnable: false, enableCalls: 0 };
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    try {
      await installCapabilityApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });

      const escapeOpener = await openBrowseSheet(page);
      await page.keyboard.press("Escape");
      await expectHidden(page.getByRole("dialog"));
      await expectFocused(escapeOpener);

      const errorOpener = await openBrowseSheet(page);
      state.failNextEnable = true;
      await page.getByRole("dialog").getByRole("button", { name: "Enable" }).click();
      await expectText(page.getByRole("dialog"), "simulated enable failure");
      expect(await page.getByRole("dialog").isVisible()).toBe(true);

      await page.keyboard.press("Escape");
      await expectHidden(page.getByRole("dialog"));
      await expectFocused(errorOpener);
      expect(state.enableCalls).toBe(1);

      const disable = page.getByRole("button", { name: "Disconnect" });
      expect(await disable.count()).toBe(0);
      const browseBox = await errorOpener.boundingBox();
      expect(browseBox?.width ?? 0).toBeGreaterThan(0);
      await page.screenshot({ path: `${evidenceDir}error-mobile-390x844.png`, fullPage: true });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("coarse Enabled controls retain the existing 44px target and modal semantics", async () => {
    const state: CapabilityState = { enabled: true, failNextEnable: false, enableCalls: 0 };
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    try {
      await installCapabilityApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });

      const enabledControl = page.locator(
        `[data-capability-focus-target][data-capability-id="${capabilityId}"]`,
      );
      await expectVisible(enabledControl);
      await enabledControl.click();
      const dialog = page.getByRole("dialog");
      await expectVisible(dialog);
      const disable = dialog.getByRole("button", { name: "Disconnect" });
      const disableBox = await disable.boundingBox();
      expect(disableBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(await dialog.getAttribute("aria-describedby")).not.toBeNull();

      const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      expect(axe.violations).toEqual([]);
      await page.screenshot({ path: `${evidenceDir}enabled-mobile-390x844.png`, fullPage: true });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("responsive theme matrix stays bounded from 320px through 1440px", async () => {
    const viewports = [
      { name: "320", width: 320, height: 700, mobile: true },
      { name: "375", width: 375, height: 812, mobile: true },
      { name: "768", width: 768, height: 900, mobile: false },
      { name: "1280", width: 1280, height: 900, mobile: false },
      { name: "1440", width: 1440, height: 900, mobile: false },
    ] as const;

    for (const viewport of viewports) {
      const state: CapabilityState = { enabled: false, failNextEnable: false, enableCalls: 0 };
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.mobile,
        isMobile: viewport.mobile,
      });
      const page = await context.newPage();
      try {
        await installCapabilityApi(page, state);
        await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
          waitUntil: "networkidle",
        });

        for (const theme of ["light", "dark"] as const) {
          await setTheme(page, theme);
          await expectVisible(page.getByLabel("Search connectors"));
          expect(await page.getByLabel("Search connectors").count()).toBe(1);
          await assertAccessibleAndBounded(page, '[role="region"][aria-label="Capabilities"]');
          await page.screenshot({
            path: `${evidenceDir}responsive-${viewport.name}-${theme}.png`,
            fullPage: true,
          });
        }
      } finally {
        await context.close();
      }
    }
  }, 150_000);

  test("four-column tiles preserve readable names and non-overlapping metadata", async () => {
    const state: CapabilityState = { enabled: false, failNextEnable: false, enableCalls: 0 };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await installCapabilityApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });

      const tile = page.locator(`[data-capability-catalog-tile="${capabilityId}"]`);
      await expectVisible(tile);
      const layout = await tile.evaluate((element) => {
        const bounds = (node: Element) => {
          const box = node.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
          };
        };
        const rect = (selector: string) => {
          const node = element.querySelector<HTMLElement>(selector);
          if (!node) throw new Error(`Missing tile element: ${selector}`);
          return bounds(node);
        };
        const name = element.querySelector<HTMLElement>("[data-capability-name]");
        if (!name) throw new Error("Missing capability name");
        const style = getComputedStyle(name);
        const grid = element.parentElement;
        return {
          gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
          tile: bounds(element),
          name: rect("[data-capability-name]"),
          official: rect("[data-capability-official]"),
          metadata: rect("[data-capability-metadata]"),
          kind: rect("[data-capability-kind]"),
          state: rect(":scope > span:last-child"),
          nameScrollWidth: name.scrollWidth,
          nameClientWidth: name.clientWidth,
          nameOverflow: style.overflow,
          nameTextOverflow: style.textOverflow,
          nameWhiteSpace: style.whiteSpace,
          nameTitle: name.title,
        };
      });

      expect(layout.gridColumns).toBe(4);
      expect(layout.name.width).toBeGreaterThanOrEqual(120);
      expect(layout.nameScrollWidth).toBeGreaterThan(layout.nameClientWidth);
      expect(layout.nameOverflow).toBe("hidden");
      expect(layout.nameTextOverflow).toBe("ellipsis");
      expect(layout.nameWhiteSpace).toBe("nowrap");
      expect(layout.nameTitle).toBe(capabilityName);
      expect(layout.name.bottom).toBeLessThanOrEqual(layout.metadata.top);
      expect(layout.official.right).toBeLessThanOrEqual(layout.kind.left);
      expect(layout.metadata.left).toBeGreaterThanOrEqual(layout.tile.left);
      expect(layout.metadata.right).toBeLessThanOrEqual(layout.state.left);
      expect(layout.state.right).toBeLessThanOrEqual(layout.tile.right);
      expect(await tile.locator("button").count()).toBe(2);

      await assertAccessibleAndBounded(page, '[role="region"][aria-label="Capabilities"]');
      await page.screenshot({
        path: `${evidenceDir}tile-layout-four-column-1440.png`,
        fullPage: true,
      });
      await tile.screenshot({ path: `${evidenceDir}tile-layout-four-column-tile.png` });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("forced-colors and reduced-motion preserve the complete control surface", async () => {
    const state: CapabilityState = { enabled: false, failNextEnable: false, enableCalls: 0 };
    const context = await browser.newContext({
      viewport: { width: 768, height: 900 },
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    try {
      await installCapabilityApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
      expect(
        await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      ).toBe(true);
      const tile = page.locator(`[data-capability-catalog-tile="${capabilityId}"]`);
      await expectVisible(tile);
      const transitionMs = await tile.evaluate((element) => {
        const value = getComputedStyle(element).transitionDuration.split(",")[0]?.trim() ?? "0s";
        return value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000;
      });
      expect(transitionMs).toBeLessThanOrEqual(0.01);
      await assertBounded(page);
      await page.screenshot({
        path: `${evidenceDir}forced-colors-reduced-motion-768.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a delayed five-thousand-item catalog renders one bounded window and filters responsively", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await installLargeCatalogApi(page, 1_500);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "domcontentloaded",
      });
      await expectVisible(page.locator("[data-capability-catalog-skeleton]"));

      const tiles = page.locator("[data-capability-catalog-tile]");
      await expectVisible(tiles.first());
      const initialCount = await tiles.count();
      expect(initialCount).toBe(48);

      const seeMore = page.getByRole("button", { name: "See more" });
      await expectVisible(seeMore);
      await page.getByRole("heading", { name: "Bundles" }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      expect(await tiles.count()).toBe(initialCount);

      await seeMore.click();
      expect(await tiles.count()).toBe(96);

      const startedAt = performance.now();
      await page.getByLabel("Search connectors").fill("Capability 4999");
      await expectVisible(page.locator('[data-capability-catalog-tile="mcp:large-4999"]'));
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(await tiles.count()).toBe(1);
      await assertAccessibleAndBounded(page, '[role="region"][aria-label="Plugins"]');
      await page.screenshot({
        path: `${evidenceDir}large-catalog-filtered-1280.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 90_000);

  test("Google Drive folders configure only the exact named Integration instance", async () => {
    const state: DriveUiState = {
      driveSaves: 0,
      sourceRequest: null,
      binding: null,
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await installCapabilityApi(page, state);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });

      // One Google Drive row folds every account in: the primary knowledge
      // connection plus each named Drive account (its own tool namespace).
      // The row's accessible name carries the state, and the accounts - with
      // their per-instance facets - live in the row's detail sheet.
      const driveRow = page.getByRole("button", {
        name: "Google Drive. Not connected",
        exact: true,
      });
      await expectVisible(driveRow);
      await driveRow.click();
      const sheet = page.locator('[data-integration-sheet="google-drive"]');
      await expectVisible(sheet);
      const instance = sheet.locator('[data-integration-access-item="finance"]');
      await expectVisible(instance);
      await expectText(instance, "Google Drive — Finance");
      await instance
        .getByRole("button", { name: "Manage facets for Google Drive — Finance" })
        .click();
      const facet = instance.locator('[data-integration-facet="drive-content"]');
      await expectVisible(facet);
      await facet.getByRole("button", { name: "Configure" }).click();

      const dialog = page.locator('[data-slot="dialog-content"]').filter({
        hasText: "Google Drive locations · Google Drive — Finance",
      });
      await expectVisible(dialog);
      await expectText(dialog, "Google Drive locations · Google Drive — Finance");
      await dialog.getByRole("checkbox", { name: "Connect My Drive" }).check();
      await assertAccessibleAndBounded(page, '[data-slot="dialog-content"]');
      await dialog.getByRole("button", { name: "Save 1 location" }).click();
      await expectHidden(dialog);

      expect(state.driveSaves).toBe(1);
      expect(state.sourceRequest).toMatchObject({
        sources: [
          {
            id: "root",
            name: "My Drive",
            mimeType: "application/vnd.google-apps.folder",
            driveId: null,
          },
        ],
        destination: { authorityKind: "workspace", collectionId: null },
        syncCadence: "hourly",
        readPolicy: "allow",
      });
      await expectText(facet, "Active");
    } finally {
      await context.close();
    }
  }, 60_000);

  test("Mobbin OAuth states stay truthful, bounded, accessible, and responsive", async () => {
    const state: MobbinUiState = {
      mode: "disconnected",
      oauthStarts: 0,
      oauthRequest: null,
    };
    const authorizationOrigin = "https://ujasntkfphywizsdaapi.supabase.co";
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktop.newPage();
    try {
      await installCapabilityApi(page, state);
      await page.route(`${authorizationOrigin}/**`, async (route) => {
        const url = new URL(route.request().url());
        expect(url.pathname).toBe("/auth/v1/oauth/authorize");
        expect(url.searchParams.get("resource")).toBe("https://api.mobbin.com/mcp");
        expect(url.searchParams.get("scope")).toBe("openid");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html>
            <html lang="en" style="color-scheme:dark">
              <head>
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>Mobbin authorization fixture</title>
                <style>
                  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#f2f4f8;font:16px system-ui,sans-serif;padding:24px}
                  main{width:min(100%,460px);padding:32px;border:1px solid #30363d;border-radius:20px;background:#161b22;box-shadow:0 24px 80px #0008}
                  .brand{display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:#282f3a;color:#dce3ee;font-weight:700}
                  h1{font-size:25px;margin:20px 0 10px} p{line-height:1.55;color:#aeb8c7} code{color:#d7e3f4} .fixture{font-size:12px;color:#8994a3;border-top:1px solid #30363d;margin-top:24px;padding-top:18px}
                </style>
              </head>
              <body><main aria-labelledby="authorization-heading"><div class="brand" aria-hidden="true">M</div><h1 id="authorization-heading">Authorize Mobbin for OpenGeni</h1><p>Requested access: <code>openid</code></p><p>You would return to OpenGeni after approving access.</p><p class="fixture">Browser evidence fixture - no account, client, credential, or token was used.</p></main></body>
            </html>`,
        });
      });

      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });
      await setTheme(page, "light");
      await openMobbinSheet(page, false);
      await expectText(
        page.getByRole("dialog"),
        "Search Mobbin’s library for real-world product screens, flows, and UI/UX references. Requires a paid Mobbin plan (Pro, Team, or Enterprise). Provider-managed usage credits apply.",
      );
      const setupLink = page
        .getByRole("dialog")
        .getByRole("link", { name: "docs.mobbin.com", exact: true });
      await expectVisible(setupLink);
      expect(await setupLink.getAttribute("href")).toBe(
        "https://docs.mobbin.com/mcp/clients/overview",
      );
      await expectVisible(
        page.getByRole("dialog").getByRole("button", { name: "Connect for workspace" }),
      );
      await assertAccessibleAndBounded(page, '[role="dialog"]');
      await page.screenshot({
        path: `${mobbinEvidenceDir}disconnected-desktop-light.png`,
        fullPage: true,
      });

      await setTheme(page, "dark");
      await page.screenshot({
        path: `${mobbinEvidenceDir}connect-desktop-dark.png`,
        fullPage: true,
      });
      await Promise.all([
        page.waitForURL(`${authorizationOrigin}/**`),
        page.getByRole("dialog").getByRole("button", { name: "Connect for workspace" }).click(),
      ]);
      await expectVisible(page.getByRole("heading", { name: "Authorize Mobbin for OpenGeni" }));
      expect(state.oauthStarts).toBe(1);
      expect(state.oauthRequest).toMatchObject({
        mcpUrl: "https://api.mobbin.com/mcp",
        providerDomain: "mobbin.com",
      });
      await assertAccessibleAndBounded(page, "main");
      await page.screenshot({
        path: `${mobbinEvidenceDir}authorization-desktop-dark.png`,
        fullPage: true,
      });

      state.mode = "connected";
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });
      await setTheme(page, "dark");
      await openMobbinSheet(page, true);
      await expectText(page.getByRole("dialog"), "Personal connection to mobbin.com");
      await assertAccessibleAndBounded(page, '[role="dialog"]');
      await page.screenshot({
        path: `${mobbinEvidenceDir}connected-desktop-dark.png`,
        fullPage: true,
      });
    } finally {
      await desktop.close();
    }

    state.mode = "revoked";
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme: "dark",
    });
    const mobilePage = await mobile.newPage();
    try {
      await installCapabilityApi(mobilePage, state);
      await mobilePage.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "networkidle",
      });
      await setTheme(mobilePage, "dark");
      await expectText(mobilePage.getByRole("region", { name: "Capabilities" }), "Needs attention");
      await openMobbinSheet(mobilePage, true);
      await expectText(
        mobilePage.getByRole("dialog"),
        "Personal connection needs to be reconnected",
      );
      await expectVisible(
        mobilePage.getByRole("dialog").getByRole("button", { name: "Reconnect Mobbin" }),
      );
      await assertAccessibleAndBounded(mobilePage, '[role="dialog"]');
      await mobilePage.screenshot({
        path: `${mobbinEvidenceDir}revoked-needs-attention-mobile-dark.png`,
        fullPage: true,
      });
    } finally {
      await mobile.close();
    }
  }, 90_000);
});

async function openBrowseSheet(page: Page) {
  const opener = page
    .locator("button:not([data-capability-focus-target])")
    .filter({ hasText: "Example capability" })
    .first();
  await expectVisible(opener);
  await opener.focus();
  await expectFocused(opener);
  await page.keyboard.press("Enter");
  await expectVisible(page.getByRole("dialog"));
  await expectText(page.getByRole("dialog"), "Example capability");
  return opener;
}

async function openMobbinSheet(page: Page, enabled: boolean): Promise<void> {
  const opener = enabled
    ? page.locator(`[data-capability-focus-target][data-capability-id="${mobbinCapabilityId}"]`)
    : page.getByRole("button").filter({ hasText: "Mobbin" }).first();
  await expectVisible(opener);
  await opener.click();
  await expectVisible(page.getByRole("dialog"));
  await expectText(page.getByRole("dialog"), "Mobbin");
}

async function assertAccessibleAndBounded(page: Page, selector: string): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  expect(axe.violations).toEqual([]);
  await assertBounded(page);
}

async function assertBounded(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (nextTheme) => {
    document.documentElement.setAttribute("data-og-theme", nextTheme);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }, theme);
}

async function expectVisible(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
}

async function expectHidden(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "hidden", timeout: 15_000 });
}

async function expectFocused(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "attached", timeout: 15_000 });
  expect(await locator.evaluate((element) => element === document.activeElement)).toBe(true);
}

async function expectText(locator: import("playwright").Locator, expected: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  const deadline = Date.now() + 15_000;
  let text = "";
  while (Date.now() < deadline) {
    text = (await locator.textContent()) ?? "";
    if (text.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(text).toContain(expected);
}

async function expectNoCapabilitiesChunkCycle(assetsDir: string): Promise<void> {
  const assets = (await readdir(assetsDir)).filter((asset) => asset.endsWith(".js"));
  const graph = new Map<string, string[]>();
  await Promise.all(
    assets.map(async (asset) => {
      const source = await readFile(`${assetsDir}/${asset}`, "utf8");
      const imports = [...source.matchAll(/(?:\bfrom|\bimport)["']\.\/([^"']+\.js)["']/g)].map(
        (match) => match[1]!,
      );
      graph.set(asset, imports);
    }),
  );

  const active = new Set<string>();
  const complete = new Set<string>();
  const path: string[] = [];

  function visit(asset: string): string[] | null {
    if (active.has(asset)) {
      const cycle = [...path.slice(path.indexOf(asset)), asset];
      return cycle.some(
        (member) =>
          member.startsWith("capabilities-services-") ||
          member.startsWith("integration-account-facets-") ||
          member.startsWith("integration-facets-panel-") ||
          member.startsWith("custom-api-setup-dialog-") ||
          member.startsWith("google-drive-folder-dialog-") ||
          member.startsWith("google-drive-knowledge-source-dialog-"),
      )
        ? cycle
        : null;
    }
    if (complete.has(asset)) return null;
    active.add(asset);
    path.push(asset);
    for (const dependency of graph.get(asset) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    active.delete(asset);
    complete.add(asset);
    return null;
  }

  for (const asset of assets) {
    const cycle = visit(asset);
    if (cycle) {
      throw new Error(
        `Capabilities production chunks contain a static import cycle: ${cycle.join(" -> ")}`,
      );
    }
  }
}

async function installCapabilityApi(
  page: Page,
  state: CapabilityState | MobbinUiState | DriveUiState,
): Promise<void> {
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "x-opengeni-api-contract": apiContractRevision };
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/v1/config/client") {
      return json({
        deploymentRevision: "browser-focus-test",
        apiContractRevision,
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        models: [],
        defaultReasoningEffort: "low",
        allowedReasoningEfforts: ["low"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
        productAccessMode: "configured",
        auth: { mode: "none" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      });
    }
    if (url.pathname === "/v1/access/me") {
      return json({
        mode: "configured",
        subjectId: "browser-focus-subject",
        subjectLabel: "Browser focus test",
        accountGrants: [
          {
            accountId,
            subjectId: "browser-focus-subject",
            role: "owner",
            permissions: [
              "account:admin",
              "workspace:admin",
              "capabilities:read",
              "capabilities:write",
            ],
          },
        ],
        workspaceGrants: [
          {
            workspaceId,
            accountId,
            subjectId: "browser-focus-subject",
            permissions: [
              "workspace:admin",
              "capabilities:read",
              "capabilities:write",
              "connections:read",
            ],
          },
        ],
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      });
    }
    if (url.pathname === "/v1/workspaces") {
      return json([workspace()]);
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/channels`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      return json({
        items:
          "driveSaves" in state
            ? []
            : ["mode" in state ? mobbinCapability(state.mode) : capability(state.enabled)],
        installations: [],
      });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      return json({
        connections:
          "driveSaves" in state
            ? [driveConnection()]
            : "mode" in state
              ? mobbinConnections(state.mode)
              : [],
      });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations/definitions`) {
      return json({ definitions: "driveSaves" in state ? [driveDefinition()] : [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations`) {
      return json({ integrations: "driveSaves" in state ? [driveInstallation()] : [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/skills`) {
      return json({ skills: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/plugins`) {
      return json({ plugins: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/social/connections`) {
      return json([]);
    }
    if (
      "driveSaves" in state &&
      request.method() === "GET" &&
      url.pathname ===
        `/v1/workspaces/${workspaceId}/integrations/${encodeURIComponent(driveCapabilityId)}/instances/finance/facets`
    ) {
      return json(driveFeatures(state.binding));
    }
    if (
      "driveSaves" in state &&
      request.method() === "GET" &&
      url.pathname ===
        `/v1/workspaces/${workspaceId}/integrations/${encodeURIComponent(driveCapabilityId)}/instances/finance/facets/drive-content/browse`
    ) {
      return json(driveBrowse());
    }
    if (
      "driveSaves" in state &&
      request.method() === "PUT" &&
      url.pathname ===
        `/v1/workspaces/${workspaceId}/integrations/${encodeURIComponent(driveCapabilityId)}/instances/finance/facets/drive-content/source`
    ) {
      state.driveSaves += 1;
      state.sourceRequest = request.postDataJSON() as Record<string, unknown>;
      state.binding = driveBinding(state.sourceRequest);
      return json({
        capabilityId: driveCapabilityId,
        instanceKey: "finance",
        facetKey: "drive-content",
        status: "configured",
        binding: state.binding,
      });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/packs`) {
      return json({ packs: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/variable-sets`) {
      return json([]);
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/rigs`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    }
    if (
      "mode" in state &&
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/connections/oauth/start`
    ) {
      state.oauthStarts += 1;
      state.oauthRequest = request.postDataJSON() as Record<string, unknown>;
      return json({
        state: "mobbin-browser-fixture",
        authorizationUrl:
          "https://ujasntkfphywizsdaapi.supabase.co/auth/v1/oauth/authorize?resource=https%3A%2F%2Fapi.mobbin.com%2Fmcp&scope=openid&code_challenge_method=S256",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (
      !("mode" in state) &&
      request.method() === "POST" &&
      url.pathname ===
        `/v1/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/enable`
    ) {
      state.enableCalls += 1;
      if (state.failNextEnable) {
        state.failNextEnable = false;
        return json({ message: "simulated enable failure" }, 500);
      }
      state.enabled = true;
      return json({
        id: "00000000-0000-4000-8000-000000000019",
        accountId,
        workspaceId,
        capabilityId,
        kind: "mcp",
        status: "active",
        config: {},
        metadata: {},
        enabledAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
    }
    return json({});
  });
}

async function installLargeCatalogApi(page: Page, catalogDelayMs: number): Promise<void> {
  const catalog = Array.from({ length: 5_000 }, (_, index) => ({
    ...capability(false),
    id: `mcp:large-${index}`,
    kind: "mcp",
    source: "public_registry",
    name: `Capability ${index}`,
    description: `Large catalog performance fixture ${index}.`,
    category: "integrations",
    tags: ["large-catalog", `row-${index}`],
    surfaceType: "mcp",
  }));

  await page.route("http://127.0.0.1:9/**", async (route) => {
    const url = new URL(route.request().url());
    const headers = { "x-opengeni-api-contract": apiContractRevision };
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/v1/config/client") {
      return json({
        deploymentRevision: "large-catalog-browser-test",
        apiContractRevision,
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        models: [],
        defaultReasoningEffort: "low",
        allowedReasoningEfforts: ["low"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
        productAccessMode: "configured",
        auth: { mode: "none" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      });
    }
    if (url.pathname === "/v1/access/me") {
      return json({
        mode: "configured",
        subjectId: "large-catalog-subject",
        subjectLabel: "Large catalog test",
        accountGrants: [
          {
            accountId,
            subjectId: "large-catalog-subject",
            role: "owner",
            permissions: ["account:admin", "workspace:admin", "capabilities:read"],
          },
        ],
        workspaceGrants: [
          {
            workspaceId,
            accountId,
            subjectId: "large-catalog-subject",
            permissions: ["workspace:admin", "capabilities:read", "connections:read"],
          },
        ],
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      });
    }
    if (url.pathname === "/v1/workspaces") return json([workspace()]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/channels`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      await new Promise((resolve) => setTimeout(resolve, catalogDelayMs));
      return json({ items: catalog, installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      return json({ connections: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/social/connections`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations/definitions`) {
      return json({ definitions: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations`) {
      return json({ integrations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/skills`) {
      return json({ skills: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/plugins`) {
      return json({ plugins: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/packs`) {
      return json({ packs: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/variable-sets`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/rigs`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    }
    return json({});
  });
}

function workspace() {
  return {
    id: workspaceId,
    accountId,
    kind: "shared",
    name: "Focus Test Workspace",
    slug: "focus-test",
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    defaultRigId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function capability(enabled: boolean) {
  return {
    id: capabilityId,
    accountId,
    workspaceId,
    kind: "mcp",
    source: "manual",
    name: capabilityName,
    description: "A browser-only capability used to verify focus restoration.",
    category: "integrations",
    tags: ["browser", "focus"],
    homepageUrl: "https://example.com/capability",
    endpointUrl: "https://example.com/mcp",
    installUrl: null,
    authModel: null,
    providerDomain: "example.com",
    surfaceType: "mcp",
    transport: "streamable-http",
    mcpUrl: "https://example.com/mcp",
    authKind: "none",
    credentialFacts: [],
    tier: "verified",
    provenance: "Browser focus regression fixture",
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: {
      available: true,
      mcpServerId: "browser-focus",
      transport: "streamable-http",
      notes: null,
    },
    lifecycle: {
      status: enabled ? "ready" : "available",
      readiness: enabled ? "ready" : "setup_required",
      detail: enabled ? "enabled" : "available",
      managedBy: "workspace",
    },
    actions: enabled ? ["configure", "disconnect", "inspect"] : ["install", "inspect"],
    enabled,
    enabledReason: enabled ? "explicit" : null,
    connectionRef: null,
    metadata: { curation: { featured: false, official: true } },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function mobbinCapability(mode: MobbinUiState["mode"]) {
  const enabled = mode !== "disconnected";
  return {
    id: mobbinCapabilityId,
    kind: "mcp",
    source: "registry",
    name: "Mobbin",
    description:
      "Search Mobbin’s library for real-world product screens, flows, and UI/UX references. Requires a paid Mobbin plan (Pro, Team, or Enterprise). Provider-managed usage credits apply.",
    category: "integrations",
    tags: ["mcp", "integration", "verified", "oauth2"],
    homepageUrl: "https://mobbin.com/mcp",
    endpointUrl: "https://api.mobbin.com/mcp",
    installUrl: "https://docs.mobbin.com/mcp/clients/overview",
    authModel: "credential_ref",
    providerDomain: "mobbin.com",
    surfaceType: "mcp",
    transport: "streamable-http",
    mcpUrl: "https://api.mobbin.com/mcp",
    authKind: "oauth2",
    credentialFacts: [],
    tier: "verified",
    provenance: "official:mcp-registry:com.mobbin/mobbin@1.0.1",
    logoAssetPath: null,
    importBatchId: "00000000-0000-4000-8000-000000000121",
    stale: false,
    staleAt: null,
    tools: [],
    runtime: {
      available: true,
      mcpServerId: "cap-integrations-sh-mobbin-com-browser-fixture",
      transport: "streamable-http",
      notes: "Requires a connected OAuth credential.",
      catalogTrust: { state: "trusted", reason: "verified_probe" },
    },
    lifecycle: {
      status:
        mode === "disconnected"
          ? "available"
          : mode === "connected"
            ? "connected"
            : "needs_attention",
      readiness:
        mode === "disconnected" ? "setup_required" : mode === "connected" ? "ready" : "attention",
      detail:
        mode === "disconnected"
          ? "OAuth connection required"
          : mode === "connected"
            ? "connected"
            : "authorization revoked",
      managedBy: "workspace",
    },
    actions:
      mode === "disconnected"
        ? ["connect", "inspect"]
        : ["configure", "repair", "disconnect", "inspect"],
    enabled,
    enabledReason: enabled ? "explicit" : null,
    connectionRef: enabled
      ? { providerDomain: "mobbin.com", kind: "oauth2", subjectScope: "subject" }
      : null,
    metadata: {
      registry: "integrations.sh",
      providerDomain: "mobbin.com",
      scopesHint: ["openid"],
      logoSource: "generic_monogram",
      documentationUrl: "https://docs.mobbin.com/mcp/introduction",
      officialMcpRegistry: {
        name: "com.mobbin/mobbin",
        version: "1.0.1",
        status: "active",
        isLatest: true,
      },
      mcpProbe: { status: "real", reason: "auth_challenge", httpStatus: 401 },
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function mobbinConnections(mode: MobbinUiState["mode"]) {
  if (mode === "disconnected") return [];
  return [
    {
      id: mobbinConnectionId,
      accountId,
      workspaceId,
      subjectId: "browser-focus-subject",
      providerDomain: "mobbin.com",
      kind: "oauth2",
      status: mode === "connected" ? "active" : "revoked",
      grantedScopes: ["openid"],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: mode === "revoked" ? "Authorization was revoked." : null,
      version: 1,
      metadata: {},
      createdBySubjectId: "browser-focus-subject",
      updatedBySubjectId: "browser-focus-subject",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ];
}

function driveDefinition() {
  return {
    id: "google-drive",
    name: "Google Drive",
    summary: "Files, folders, permissions, and shared drives.",
    protocol: "openapi",
    provider: { id: "google", domain: "www.googleapis.com" },
    authentication: {
      kind: "oauth2",
      scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/drive"],
    },
    facets: [driveFacetDefinition(), driveIdentityDefinition()],
  };
}

function driveInstallation() {
  return {
    capabilityId: driveCapabilityId,
    pluginKey: "integration/google-drive-browser-fixture",
    installationVersion: 1,
    instanceId: driveInstanceId,
    instanceKey: "finance",
    displayName: "Google Drive — Finance",
    instanceVersion: 1,
    serverId: "google_drive_browser_fixture",
    name: "Google Drive",
    description: "Files, folders, permissions, and shared drives.",
    protocol: "openapi",
    definitionId: "google-drive",
    definitionProvenance: "curated",
    providerDomain: "www.googleapis.com",
    baseUrl: "https://www.googleapis.com/drive/v3/",
    sourceUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    connected: true,
    requiresConnection: true,
    connectionId: driveConnectionId,
    ownership: "personal",
    allowedTools: ["drive_files_list"],
    toolCount: 1,
    approvalRequiredToolCount: 0,
    revisionId: "openapi:444444444444444444444444",
    contentSha256: "4".repeat(64),
  };
}

function driveConnection() {
  return {
    id: driveConnectionId,
    accountId,
    workspaceId,
    subjectId: "browser-focus-subject",
    providerDomain: "www.googleapis.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["https://www.googleapis.com/auth/drive"],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {
      credentialRole: "api_integration_oauth",
      providerFamily: "google",
      providerPrincipalId: "google-finance",
      providerEmail: "finance@example.com",
      providerDisplayName: "Finance",
      authorizedDefinitionIds: ["google-drive"],
      verifiedAt: new Date(0).toISOString(),
    },
    createdBySubjectId: "browser-focus-subject",
    updatedBySubjectId: "browser-focus-subject",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function driveFeatures(binding: Record<string, unknown> | null) {
  return {
    capabilityId: driveCapabilityId,
    instanceKey: "finance",
    providerDomain: "www.googleapis.com",
    connectionId: driveConnectionId,
    facets: [
      { definition: driveIdentityDefinition(), binding: null },
      { definition: driveFacetDefinition(), binding },
    ],
  };
}

function driveFacetDefinition() {
  return {
    facetKey: "drive-content",
    kind: "knowledge_source",
    configSchema: {
      type: "object",
      required: ["sources", "destination", "syncCadence", "readPolicy"],
      properties: {
        sources: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } },
        destination: { type: "object" },
        syncCadence: { type: "string", enum: ["manual", "hourly", "daily"] },
        readPolicy: { type: "string", enum: ["allow", "ask", "block"] },
      },
    },
    capabilities: { provider: "google-drive", connectionRequired: true },
  };
}

function driveIdentityDefinition() {
  return {
    facetKey: "account-identity",
    kind: "identity_link",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    capabilities: { provider: "google", connectionRequired: true },
  };
}

function driveBrowse() {
  return {
    connection: driveConnection(),
    parentId: "root",
    current: {
      id: "root",
      name: "My Drive",
      mimeType: "application/vnd.google-apps.folder",
      kind: "folder",
      driveId: null,
      modifiedTime: null,
      size: null,
      webViewLink: "https://drive.google.com/drive/my-drive",
    },
    items: [
      {
        id: "folder-1",
        name: "Product",
        mimeType: "application/vnd.google-apps.folder",
        kind: "folder",
        driveId: null,
        modifiedTime: "2026-08-11T00:00:00.000Z",
        size: null,
        webViewLink: "https://drive.google.com/drive/folders/folder-1",
      },
    ],
    nextPageToken: null,
    incompleteSearch: false,
  };
}

function driveBinding(request: Record<string, unknown>) {
  const sources = Array.isArray(request.sources) ? request.sources : [];
  return {
    id: "00000000-0000-4000-8000-000000000132",
    facetKey: "drive-content",
    kind: "knowledge_source",
    bindingKey: "finance",
    displayName: "Google Drive — Finance — Drive Content",
    connectionId: driveConnectionId,
    status: "active",
    config: {
      sources: sources.map((source) => ({
        ...(source as Record<string, unknown>),
        sourceKind: (source as Record<string, unknown>).id === "root" ? "my_drive" : "folder",
        includeDescendants: true,
      })),
      destination: {
        authorityKind: "workspace",
        authorityAccountId: accountId,
        authorityWorkspaceId: workspaceId,
      },
      syncCadence: request.syncCadence,
      readPolicy: request.readPolicy,
    },
    version: 1,
    hasCursor: false,
    lastSuccessAt: null,
    lastErrorCode: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    directlyOwned: true,
    owners: [{ kind: "direct", id: "finance", removable: true }],
  };
}
