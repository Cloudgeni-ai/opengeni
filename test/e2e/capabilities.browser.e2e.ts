import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "00000000-0000-4000-8000-000000000017";
const accountId = "00000000-0000-4000-8000-000000000018";
const capabilityId = "skill:browser-focus";
const evidenceDir = new URL("../../.agent/evidence/capabilities-focus/", import.meta.url).pathname;
const apiContractRevision = "2026-07-human-input-v1";

type CapabilityState = {
  enabled: boolean;
  failNextEnable: boolean;
  enableCalls: number;
};

describe("capabilities focus restoration browser e2e", () => {
  let browser: Browser;
  let web: StartedProcess;
  let webBaseUrl: string;

  beforeAll(async () => {
    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    await mkdir(evidenceDir, { recursive: true });
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "--port",
        String(webPort),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        env: { VITE_API_BASE_URL: "http://127.0.0.1:9" },
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
  }, 90_000);

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
      await expectFocused(page.getByRole("button", { name: "Disable" }));

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

      const disable = page.getByRole("button", { name: "Disable" });
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
      const disable = dialog.getByRole("button", { name: "Disable" });
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
  expect((await locator.textContent()) ?? "").toContain(expected);
}

async function installCapabilityApi(page: Page, state: CapabilityState): Promise<void> {
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
            permissions: ["workspace:admin", "capabilities:read", "capabilities:write"],
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
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      return json({ items: [capability(state.enabled)], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      return json({ connections: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/packs`) {
      return json({ packs: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/variable-sets`) {
      return json([]);
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    }
    if (
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
        kind: "skill",
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

function workspace() {
  return {
    id: workspaceId,
    accountId,
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
    kind: "skill",
    source: "library",
    name: "Example capability",
    description: "A browser-only capability used to verify focus restoration.",
    category: "skills",
    tags: ["browser", "focus"],
    homepageUrl: "https://example.com/capability",
    endpointUrl: null,
    installUrl: null,
    authModel: null,
    providerDomain: null,
    surfaceType: "skill",
    transport: null,
    mcpUrl: null,
    authKind: "none",
    credentialFacts: [],
    tier: "verified",
    provenance: "Browser focus regression fixture",
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: { available: true, notes: null },
    enabled,
    enabledReason: enabled ? "explicit" : null,
    connectionRef: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
