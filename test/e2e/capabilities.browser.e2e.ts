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
const mobbinCapabilityId = "mcp:integrations-sh:mobbin-com-browser-fixture";
const mobbinConnectionId = "00000000-0000-4000-8000-000000000120";
const evidenceDir = new URL("../../.agent/evidence/capabilities-focus/", import.meta.url).pathname;
const mobbinEvidenceDir = new URL("../../.agent/evidence/mobbin-mcp/", import.meta.url).pathname;
const apiContractRevision = "2026-07-turn-instructions-v1";

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
      await expectText(page.getByRole("dialog"), "Search real-world UI & UX design references");
      await expectText(page.getByRole("dialog"), "docs.mobbin.com");
      await expectVisible(page.getByRole("dialog").getByRole("button", { name: "Connect Mobbin" }));
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
        page.getByRole("dialog").getByRole("button", { name: "Connect Mobbin" }).click(),
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
      await expectText(page.getByRole("dialog"), "Connected to mobbin.com");
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
      await expectText(mobilePage.getByRole("dialog"), "Reconnect to restore access");
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
  expect((await locator.textContent()) ?? "").toContain(expected);
}

async function installCapabilityApi(
  page: Page,
  state: CapabilityState | MobbinUiState,
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
      return json({
        items: ["mode" in state ? mobbinCapability(state.mode) : capability(state.enabled)],
        installations: [],
      });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      return json({ connections: "mode" in state ? mobbinConnections(state.mode) : [] });
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

function mobbinCapability(mode: MobbinUiState["mode"]) {
  const enabled = mode !== "disconnected";
  return {
    id: mobbinCapabilityId,
    kind: "mcp",
    source: "registry",
    name: "Mobbin",
    description:
      "Search real-world UI & UX design references for mobile apps, web apps, and websites with Mobbin.",
    category: "integrations",
    tags: ["mcp", "integration", "verified", "oauth2"],
    homepageUrl: "https://mobbin.com/mcp",
    endpointUrl: "https://api.mobbin.com/mcp",
    installUrl: "https://docs.mobbin.com/mcp",
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
    enabled,
    enabledReason: enabled ? "explicit" : null,
    connectionRef: enabled
      ? { connectionId: mobbinConnectionId, providerDomain: "mobbin.com", kind: "oauth2" }
      : null,
    metadata: {
      registry: "integrations.sh",
      providerDomain: "mobbin.com",
      scopesHint: ["openid"],
      logoSource: "generic_monogram",
      documentationUrl: "https://docs.mobbin.com/mcp",
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
