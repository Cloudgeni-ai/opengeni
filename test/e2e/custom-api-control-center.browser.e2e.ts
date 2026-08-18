import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

import { INTEGRATION_DEFINITION_PRESENTATIONS } from "@opengeni/capabilities";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir = new URL("../../.agent/evidence/capabilities-custom-api/", import.meta.url)
  .pathname;
const workspaceId = "00000000-0000-4000-8000-000000000617";
const accountId = "00000000-0000-4000-8000-000000000618";
const subjectId = "user:capabilities-browser";
const financeConnectionId = "00000000-0000-4000-8000-000000000619";
const salesConnectionId = "00000000-0000-4000-8000-000000000620";
const outlookConnectionId = "00000000-0000-4000-8000-000000000621";
const apiContractRevision = OPENGENI_API_CONTRACT_REVISION;
let webBaseUrl = "";

type UiState = {
  canManage: boolean;
  connectionsUnavailable: boolean;
  dense: boolean;
  loading: boolean;
  /** Renders the curated Outlook Mail account as needing reauth (offers Reconnect). */
  unhealthyAccount?: boolean;
  mailInboxBinding: ReturnType<typeof mailInboxBinding> | null;
  oauthFailuresRemaining: number;
  oauthStarts: Array<{
    definitionId: string;
    ownership: "personal" | "workspace";
    returnPath: string;
  }>;
};

describe("custom API control center browser acceptance", () => {
  let browser: Browser;
  let web: StartedProcess;

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

  test("pass 1: desktop light shows two independently identified Linear instances", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const diagnostics = collectRuntimeDiagnostics(page);
    try {
      await installApi(page, readyState());
      await openCapabilities(page);
      await setTheme(page, "light");

      await expectCustomInstances(page);
      await expectText(page.locator('[data-custom-api-instance="finance"]'), "Finance credential");
      await expectText(page.locator('[data-custom-api-instance="sales"]'), "Sales credential");
      await assertAccessibleAndBounded(page, '[aria-labelledby="custom-apis-heading"]');
      await page.screenshot({ path: `${evidenceDir}pass-1-desktop-light.png`, fullPage: true });
      expect(diagnostics).toEqual([]);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nRuntime diagnostics:\n${diagnostics.join("\n") || "(none)"}`,
        { cause: error },
      );
    } finally {
      await context.close();
    }
  }, 60_000);

  test("pass 2: mobile light keeps cards and actions within the viewport", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    try {
      await installApi(page, readyState());
      await openCapabilities(page);
      await setTheme(page, "light");

      await expectCustomInstances(page);
      const connect = page.getByRole("button", { name: "Connect custom API" });
      const box = await connect.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
      await assertAccessibleAndBounded(page, '[aria-labelledby="custom-apis-heading"]');
      await page.screenshot({ path: `${evidenceDir}pass-2-mobile-light.png`, fullPage: true });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("pass 3: failed unauthenticated GraphQL preview preserves context and opens auth", async () => {
    const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    const page = await context.newPage();
    try {
      await installApi(page, readyState());
      await openCapabilities(page);
      await page.getByRole("button", { name: "Connect custom API" }).click();
      const dialog = page.getByRole("dialog");
      await expectVisible(dialog);
      await dialog.getByLabel("API URL or domain").fill("linear.example.test/graphql");
      await dialog.getByRole("button", { name: "Detect and preview" }).click();

      await expectText(dialog, "GraphQL introspection requires authentication");
      await expectText(dialog, "Create a new Connection");
      await expectText(dialog, "Personal");
      await assertAccessibleAndBounded(page, '[role="dialog"]');
      await page.screenshot({ path: `${evidenceDir}pass-3-auth-error.png`, fullPage: true });

      await dialog.getByRole("button", { name: "Back" }).click();
      expect(await dialog.getByLabel("API URL or domain").inputValue()).toBe(
        "linear.example.test/graphql",
      );
    } finally {
      await context.close();
    }
  }, 60_000);

  test("pass 4: desktop dark update review keeps new tools opt-in", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    try {
      await installApi(page, readyState());
      await openCapabilities(page);
      await setTheme(page, "dark");
      const finance = page.locator('[data-custom-api-instance="finance"]');
      await finance.getByRole("button", { name: "Check for updates" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Detect and preview" }).click();

      await expectText(dialog, "Immutable preview ready");
      await expectText(dialog, "1 added, 0 removed, 2 unchanged tools");
      await expectText(dialog, "Tools installed for this exact instance (2/3)");
      expect(await dialog.getByLabel("Create issue").isChecked()).toBe(false);
      await assertAccessibleAndBounded(page, '[role="dialog"]');
      await page.screenshot({ path: `${evidenceDir}pass-4-update-dark.png`, fullPage: true });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("pass 5: unavailable, permission, loading, and dense states stay truthful", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const unavailable = await context.newPage();
      await installApi(unavailable, { ...readyState(), connectionsUnavailable: true, dense: true });
      await openCapabilities(unavailable);
      await expectText(
        unavailable.locator('[data-custom-api-instance="finance"]'),
        "Connection status unavailable",
      );
      await expectText(
        unavailable.locator('[data-custom-api-instance="finance"]'),
        "Connection data unavailable",
      );
      await expectText(
        unavailable.getByRole("heading", { name: "Linear — Operations 8" }),
        "Linear — Operations 8",
      );
      await assertAccessibleAndBounded(unavailable, '[aria-labelledby="custom-apis-heading"]');
      await unavailable.screenshot({
        path: `${evidenceDir}pass-5a-unavailable-dense.png`,
        fullPage: true,
      });

      const permission = await context.newPage();
      await installApi(permission, { ...readyState(), canManage: false });
      await openCapabilities(permission);
      expect(
        await permission.getByRole("button", { name: "Connect custom API" }).isDisabled(),
      ).toBe(true);
      expect(
        await permission
          .locator('[data-custom-api-instance="finance"]')
          .getByRole("button", { name: "Remove" })
          .isDisabled(),
      ).toBe(true);
      await permission.screenshot({
        path: `${evidenceDir}pass-5b-permission.png`,
        fullPage: true,
      });

      const loading = await context.newPage();
      await installApi(loading, { ...readyState(), loading: true });
      await loading.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
        waitUntil: "domcontentloaded",
      });
      const refresh = loading.getByRole("button", { name: "Refresh", exact: true });
      await expectVisible(refresh);
      expect(await refresh.isDisabled()).toBe(true);
      await loading.screenshot({ path: `${evidenceDir}pass-5c-loading.png`, fullPage: true });
    } finally {
      await context.close();
    }
  }, 90_000);

  test("pass 6: per-account facets configure and pause without exposing provider state", async () => {
    const context = await browser.newContext({ viewport: { width: 1180, height: 960 } });
    const page = await context.newPage();
    try {
      const state = readyState();
      await installApi(page, state);
      await openCapabilities(page);
      // Facets are reachable per exact account inside that provider's one row.
      const sheet = await openOutlookMailSheet(page);
      const account = sheet.locator('[data-integration-access-item="account-finance"]');
      await expectText(account, "Outlook Mail — Finance");
      await account
        .getByRole("button", { name: "Manage facets for Outlook Mail — Finance" })
        .click();
      const facets = account.locator('[data-integration-facets="account-finance"]');
      await expectText(facets, "Mail inbox");
      await expectText(facets, "Mail delivery");
      await expectText(facets, "Account identity");

      const inbox = account.locator('[data-integration-facet="mail-inbox"]');
      await inbox.getByRole("button", { name: "Configure" }).click();
      const dialog = page.locator('[data-slot="dialog-content"]').filter({ hasText: "Mail inbox" });
      await dialog.getByLabel("Folder").fill("INBOX");
      await dialog.getByLabel("Unread Only").check();
      await dialog.getByRole("button", { name: "Enable facet" }).click();
      await expectText(inbox, "Active");
      expect(JSON.stringify(state.mailInboxBinding)).not.toContain("history_id");

      await inbox.getByRole("button", { name: "Pause" }).click();
      await expectText(inbox, "Paused");
      await assertAccessibleAndBounded(page, '[data-integration-sheet="outlook-mail"]');
      await page.screenshot({ path: `${evidenceDir}pass-6-account-facets.png`, fullPage: true });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("pass 7: adding an account redirects straight to consent and retries one exact account", async () => {
    const context = await browser.newContext({ viewport: { width: 1180, height: 960 } });
    const page = await context.newPage();
    const state = readyState();
    try {
      await installApi(page, state);
      await openCapabilities(page);
      await setTheme(page, "light");

      // Every curated definition is oauth2-reviewed, so adding an account is a
      // zero-dialog straight redirect - no local account-naming form.
      let sheet = await openOutlookMailSheet(page);
      const addAccount = sheet.getByRole("button", { name: "+ Add account" });
      await expectVisible(addAccount);
      await Promise.all([page.waitForURL(`${webBaseUrl}/provider-consent`), addAccount.click()]);
      expect(state.oauthStarts).toHaveLength(1);
      const added = new URL(state.oauthStarts[0]!.returnPath, webBaseUrl);
      expect(added.searchParams.get("api_integration_instance")).toMatch(/^account-/);
      expect(added.searchParams.get("api_integration_instance")).not.toBe("account-finance");
      expect(added.searchParams.get("api_integration_name")).toBe("Outlook Mail - Account 2");
      expect(added.searchParams.get("api_integration_expected")).toBeNull();
      expect(state.oauthStarts[0]).toMatchObject({
        definitionId: "microsoft-outlook-mail",
        ownership: "workspace",
      });

      // Reconnect targets the exact existing account, keeping its instance key
      // and its optimistic version, and a failed start never creates one.
      const repair = await context.newPage();
      const repairState = { ...readyState(), unhealthyAccount: true, oauthFailuresRemaining: 1 };
      await installApi(repair, repairState);
      await openCapabilities(repair);
      sheet = await openOutlookMailSheet(repair);
      const account = sheet.locator('[data-integration-access-item="account-finance"]');
      await expectText(account, "Needs attention");
      const reconnect = account.getByRole("button", { name: "Reconnect" });
      await reconnect.click();
      await expectVisible(repair.getByText("Couldn't start account connection"));
      expect(repairState.oauthStarts).toHaveLength(1);
      expect(repair.url()).toBe(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`);
      await assertAccessibleAndBounded(repair, '[data-integration-sheet="outlook-mail"]');
      await repair.screenshot({
        path: `${evidenceDir}pass-7-add-and-reconnect.png`,
        fullPage: true,
      });

      await Promise.all([repair.waitForURL(`${webBaseUrl}/provider-consent`), reconnect.click()]);
      expect(repairState.oauthStarts).toHaveLength(2);
      const firstReturn = new URL(repairState.oauthStarts[0]!.returnPath, webBaseUrl);
      const retriedReturn = new URL(repairState.oauthStarts[1]!.returnPath, webBaseUrl);
      expect(firstReturn.searchParams.get("api_integration_instance")).toBe("account-finance");
      expect(retriedReturn.searchParams.get("api_integration_instance")).toBe("account-finance");
      expect(retriedReturn.searchParams.get("api_integration_name")).toBe("Outlook Mail — Finance");
      expect(retriedReturn.searchParams.get("api_integration_expected")).toBe("2");
      expect(repairState.oauthStarts[1]).toMatchObject({
        definitionId: "microsoft-outlook-mail",
        ownership: "workspace",
      });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("pass 8: mobile permission-disabled journey remains usable and bounded", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme: "dark",
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    try {
      await installApi(page, { ...readyState(), canManage: false });
      await openCapabilities(page);
      await setTheme(page, "dark");

      const row = page.getByRole("button", { name: "Outlook Mail. Connected", exact: true });
      await expectVisible(row);
      // Keyboard journey: opening from the focused row must return focus to it.
      await row.focus();
      await row.press("Enter");
      const sheet = page.locator('[data-integration-sheet="outlook-mail"]');
      await expectVisible(sheet);
      // Read-only: the account is listed, but nothing here can mutate it.
      await expectText(
        sheet.locator('[data-integration-access-item="account-finance"]'),
        "Outlook Mail — Finance",
      );
      await expectText(sheet, "A workspace administrator manages these accounts.");
      expect(await sheet.getByRole("button", { name: "+ Add account" }).count()).toBe(0);
      expect(await sheet.getByRole("button", { name: "Remove" }).count()).toBe(0);
      const box = await sheet.boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(390);
      expect(box?.height ?? 0).toBeLessThanOrEqual(844);
      await assertAccessibleAndBounded(page, '[data-integration-sheet="outlook-mail"]');
      await page.screenshot({
        path: `${evidenceDir}pass-8-mobile-permission-forced-colors.png`,
        fullPage: true,
      });

      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden" });
      await expectFocused(row);
    } finally {
      await context.close();
    }
  }, 60_000);
});

function readyState(): UiState {
  return {
    canManage: true,
    connectionsUnavailable: false,
    dense: false,
    loading: false,
    mailInboxBinding: null,
    oauthFailuresRemaining: 0,
    oauthStarts: [],
  };
}

function collectRuntimeDiagnostics(page: Page): string[] {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => diagnostics.push(`page:${error.message}`));
  page.on("requestfailed", (request) => {
    diagnostics.push(
      `request:${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  return diagnostics;
}

async function openCapabilities(page: Page): Promise<void> {
  await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/capabilities`, {
    waitUntil: "networkidle",
  });
  await expectVisible(page.getByRole("heading", { name: "Custom APIs" }));
}

/** Opens the one Outlook Mail provider row's detail sheet (its accounts live there). */
async function openOutlookMailSheet(page: Page) {
  const row = page.getByRole("button", { name: /^Outlook Mail\. / });
  await expectVisible(row);
  await row.click();
  const sheet = page.locator('[data-integration-sheet="outlook-mail"]');
  await expectVisible(sheet);
  return sheet;
}

async function expectCustomInstances(page: Page): Promise<void> {
  await expectVisible(page.getByRole("heading", { name: "Linear — Finance" }));
  await expectVisible(page.getByRole("heading", { name: "Linear — Sales" }));
  expect(await page.locator("[data-custom-api-instance]").count()).toBe(2);
}

async function installApi(page: Page, state: UiState): Promise<void> {
  await page.route(`${webBaseUrl}/provider-consent`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Provider consent</title><h1>Provider consent</h1>",
    }),
  );
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
        deploymentRevision: "capabilities-browser",
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
    if (url.pathname === "/v1/access/me") return json(access(state.canManage));
    if (url.pathname === "/v1/workspaces") return json([workspace()]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      return json({ items: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      if (state.connectionsUnavailable)
        return json({ message: "Connection data unavailable" }, 503);
      return json({ connections: connections(state.dense) });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/packs`) {
      return json({ packs: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/skills`) return json({ skills: [] });
    if (url.pathname === `/v1/workspaces/${workspaceId}/plugins`) return json({ plugins: [] });
    if (url.pathname === `/v1/workspaces/${workspaceId}/variable-sets`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/rigs`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations/definitions`) {
      if (state.loading) await new Promise((resolve) => setTimeout(resolve, 8_000));
      return json({ definitions: integrationDefinitions() });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations`) {
      if (state.loading) await new Promise((resolve) => setTimeout(resolve, 8_000));
      return json({ integrations: instances(state.dense, state.unhealthyAccount === true) });
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/integrations/oauth/start`
    ) {
      state.oauthStarts.push(
        request.postDataJSON() as {
          definitionId: string;
          ownership: "personal" | "workspace";
          returnPath: string;
        },
      );
      if (state.oauthFailuresRemaining > 0) {
        state.oauthFailuresRemaining -= 1;
        return json({ message: "provider-oauth-debug-body" }, 503);
      }
      return json({ authorizationUrl: `${webBaseUrl}/provider-consent` });
    }
    if (
      request.method() === "GET" &&
      url.pathname.endsWith(
        "/integrations/api%3Amicrosoft-outlook-mail/instances/account-finance/facets",
      )
    ) {
      return json(mailFacets(state));
    }
    if (url.pathname.endsWith("/facets/mail-inbox")) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as {
          displayName: string;
          config: Record<string, unknown>;
        };
        state.mailInboxBinding = mailInboxBinding(
          state.mailInboxBinding?.version ? state.mailInboxBinding.version + 1 : 1,
          "active",
          body.config,
        );
        return json({
          capabilityId: "api:microsoft-outlook-mail",
          instanceKey: "account-finance",
          facetKey: "mail-inbox",
          status: "configured",
          binding: state.mailInboxBinding,
        });
      }
      if (request.method() === "DELETE") {
        state.mailInboxBinding = state.mailInboxBinding
          ? {
              ...state.mailInboxBinding,
              status: "disabled",
              version: state.mailInboxBinding.version + 1,
            }
          : null;
        return json({
          capabilityId: "api:microsoft-outlook-mail",
          instanceKey: "account-finance",
          facetKey: "mail-inbox",
          status: "removed",
          binding: state.mailInboxBinding,
          remainingOwners: [],
        });
      }
    }
    if (request.method() === "POST" && url.pathname.endsWith("/facets/mail-inbox/pause")) {
      state.mailInboxBinding = {
        ...state.mailInboxBinding!,
        status: "paused",
        version: state.mailInboxBinding!.version + 1,
      };
      return json({
        capabilityId: "api:microsoft-outlook-mail",
        instanceKey: "account-finance",
        facetKey: "mail-inbox",
        status: "paused",
        binding: state.mailInboxBinding,
      });
    }
    if (request.method() === "POST" && url.pathname.endsWith("/facets/mail-inbox/resume")) {
      state.mailInboxBinding = {
        ...state.mailInboxBinding!,
        status: "active",
        version: state.mailInboxBinding!.version + 1,
      };
      return json({
        capabilityId: "api:microsoft-outlook-mail",
        instanceKey: "account-finance",
        facetKey: "mail-inbox",
        status: "active",
        binding: state.mailInboxBinding,
      });
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/integrations/preview`
    ) {
      const body = request.postDataJSON() as { connectionId?: string; source: unknown };
      if (!body.connectionId) {
        return json({ message: "GraphQL introspection requires authentication" }, 422);
      }
      return json(preview());
    }
    return json({});
  });
}

function access(canManage: boolean) {
  const workspacePermissions = canManage
    ? [
        "workspace:admin",
        "capabilities:read",
        "capabilities:write",
        "connections:read",
        "connections:write",
      ]
    : ["capabilities:read", "connections:read"];
  return {
    mode: "configured",
    subjectId,
    subjectLabel: "Capabilities browser",
    accountGrants: [
      {
        accountId,
        subjectId,
        role: canManage ? "owner" : "member",
        permissions: workspacePermissions,
      },
    ],
    workspaceGrants: [{ workspaceId, accountId, subjectId, permissions: workspacePermissions }],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
}

function workspace() {
  return {
    id: workspaceId,
    accountId,
    name: "API Acceptance Workspace",
    slug: "api-acceptance",
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
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function integrationDefinitions() {
  const scopes: Record<string, string[]> = {
    "google-drive": ["openid", "email", "profile", "https://www.googleapis.com/auth/drive"],
    "microsoft-outlook-mail": [
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "MailboxSettings.ReadWrite",
    ],
    "microsoft-outlook-calendar": ["offline_access", "User.Read", "Calendars.ReadWrite"],
    "microsoft-outlook-contacts": [
      "offline_access",
      "User.Read",
      "Contacts.ReadWrite",
      "People.Read.All",
    ],
    "microsoft-onedrive": [
      "offline_access",
      "User.Read",
      "Files.ReadWrite.All",
      "Sites.ReadWrite.All",
    ],
  };
  return [
    ["google-drive", "Google Drive", "google", "www.googleapis.com"],
    ["microsoft-outlook-mail", "Outlook Mail", "microsoft", "graph.microsoft.com"],
    ["microsoft-outlook-calendar", "Outlook Calendar", "microsoft", "graph.microsoft.com"],
    ["microsoft-outlook-contacts", "Outlook Contacts", "microsoft", "graph.microsoft.com"],
    ["microsoft-onedrive", "OneDrive", "microsoft", "graph.microsoft.com"],
  ].map(([id, name, providerId, providerDomain]) => ({
    id,
    name,
    summary: `${name} Integration Definition`,
    protocol: "openapi",
    provider: { id: providerId, domain: providerDomain },
    authentication: { kind: "oauth2", scopes: scopes[id!] ?? [] },
    ...(INTEGRATION_DEFINITION_PRESENTATIONS[id!]
      ? { presentation: INTEGRATION_DEFINITION_PRESENTATIONS[id!] }
      : {}),
    facets: id === "microsoft-outlook-mail" ? mailFacetDefinitions() : [],
  }));
}

function connections(dense: boolean) {
  const values = [
    connection(financeConnectionId, "Finance credential", null),
    connection(salesConnectionId, "Sales credential", subjectId),
    {
      ...connection(outlookConnectionId, "Outlook Finance credential", subjectId),
      providerDomain: "graph.microsoft.com",
      grantedScopes: ["Mail.ReadWrite", "Mail.Send"],
    },
  ];
  if (dense) {
    for (let index = 3; index <= 8; index += 1) {
      values.push(
        connection(
          `00000000-0000-4000-8000-${String(620 + index).padStart(12, "0")}`,
          `Operations ${index} credential`,
          null,
        ),
      );
    }
  }
  return values;
}

function connection(id: string, credentialLabel: string, subject: string | null) {
  return {
    id,
    accountId,
    workspaceId,
    subjectId: subject,
    providerDomain: "linear.example.test",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["issues:read", "issues:write"],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { credentialLabel },
    createdBySubjectId: subjectId,
    updatedBySubjectId: subjectId,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function instances(dense: boolean, unhealthyAccount = false) {
  const values = [
    instance("finance", "Linear — Finance", financeConnectionId, "workspace"),
    instance("sales", "Linear — Sales", salesConnectionId, "personal"),
    {
      ...instance("account-finance", "Outlook Mail — Finance", outlookConnectionId, "workspace"),
      capabilityId: "api:microsoft-outlook-mail",
      pluginKey: "integration/microsoft-outlook-mail",
      serverId: "api_microsoft_outlook_mail_account_finance",
      name: "Outlook Mail — Finance",
      description: "Messages, folders, attachments, settings, and sending mail.",
      protocol: "openapi",
      definitionId: "microsoft-outlook-mail",
      definitionProvenance: "curated",
      providerDomain: "graph.microsoft.com",
      baseUrl: "https://graph.microsoft.com/v1.0/",
      sourceUrl: "https://graph.microsoft.com/v1.0/$metadata",
      connected: !unhealthyAccount,
      allowedTools: ["outlook_mail_messages_list", "outlook_mail_messages_send"],
      revisionId: "openapi:outlook-mail-v1",
      contentSha256: "c".repeat(64),
    },
  ];
  if (dense) {
    for (let index = 3; index <= 8; index += 1) {
      values.push(
        instance(
          `operations-${index}`,
          `Linear — Operations ${index}`,
          `00000000-0000-4000-8000-${String(620 + index).padStart(12, "0")}`,
          "workspace",
        ),
      );
    }
  }
  return values;
}

function mailFacetDefinitions() {
  return [
    {
      facetKey: "mail-inbox",
      kind: "inbound_trigger",
      configSchema: {
        type: "object",
        properties: {
          folder: { type: "string", minLength: 1, maxLength: 256 },
          unreadOnly: { type: "boolean" },
        },
        additionalProperties: false,
      },
      capabilities: {
        provider: "microsoft-outlook-mail",
        connectionRequired: true,
        cursor: "history_id",
      },
    },
    {
      facetKey: "mail-delivery",
      kind: "delivery_destination",
      configSchema: {
        type: "object",
        properties: { fromAlias: { type: "string", minLength: 1, maxLength: 512 } },
        additionalProperties: false,
      },
      capabilities: {
        provider: "microsoft-outlook-mail",
        connectionRequired: true,
        delivery: "email",
      },
    },
    {
      facetKey: "account-identity",
      kind: "identity_link",
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      capabilities: { provider: "microsoft", connectionRequired: true },
    },
  ];
}

function mailFacets(state: UiState) {
  return {
    capabilityId: "api:microsoft-outlook-mail",
    instanceKey: "account-finance",
    providerDomain: "graph.microsoft.com",
    connectionId: outlookConnectionId,
    facets: mailFacetDefinitions().map((definition) => ({
      definition,
      binding: definition.facetKey === "mail-inbox" ? state.mailInboxBinding : null,
    })),
  };
}

function mailInboxBinding(
  version: number,
  status: "active" | "paused" | "disabled",
  config: Record<string, unknown>,
) {
  return {
    id: "00000000-0000-4000-8000-000000000622",
    facetKey: "mail-inbox",
    kind: "inbound_trigger" as const,
    bindingKey: "account-finance",
    displayName: "Outlook Mail — Finance — Mail inbox",
    connectionId: outlookConnectionId,
    status,
    config,
    version,
    hasCursor: false,
    lastSuccessAt: null,
    lastErrorCode: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    directlyOwned: true,
    owners: [
      {
        kind: "direct" as const,
        id: "facet:d358a95c79124370ff2e8e3c9d366cd95ff8ddf1f30dfde2c79dffc61d3627af",
        removable: true,
      },
    ],
  };
}

function instance(
  instanceKey: string,
  displayName: string,
  connectionId: string,
  ownership: "workspace" | "personal",
) {
  return {
    capabilityId: "api:linear-like",
    pluginKey: "integration/linear-like",
    installationVersion: 4,
    instanceId: `00000000-0000-4000-8000-${String(instanceKey.length + displayName.length).padStart(12, "0")}`,
    instanceKey,
    displayName,
    instanceVersion: 2,
    serverId: `api_linear_like_${instanceKey.replaceAll("-", "_")}`,
    name: displayName,
    description: "Linear-like deterministic GraphQL API",
    protocol: "graphql",
    definitionId: "linear-like",
    definitionProvenance: "workspace",
    providerDomain: "linear.example.test",
    baseUrl: "https://linear.example.test/graphql",
    sourceUrl: "https://linear.example.test/graphql",
    connected: true,
    requiresConnection: true,
    connectionId,
    ownership,
    allowedTools: ["issues_list", "issues_update"],
    toolCount: 2,
    approvalRequiredToolCount: 1,
    revisionId: "graphql:linear-v1",
    contentSha256: "a".repeat(64),
  };
}

function preview() {
  return {
    source: {
      kind: "graphql",
      endpoint: "https://linear.example.test/graphql",
      name: "Linear — Finance",
    },
    definitionId: "linear-like",
    definitionProvenance: "workspace",
    protocol: "graphql",
    capabilityId: "api:linear-like",
    pluginKey: "integration/linear-like",
    serverId: "api_linear_like",
    name: "Linear-like API",
    description: "Linear-like deterministic GraphQL API",
    provider: null,
    providerDomain: "linear.example.test",
    baseUrl: "https://linear.example.test/graphql",
    sourceUrl: "https://linear.example.test/graphql",
    revisionId: "graphql:linear-v2",
    contentSha256: "b".repeat(64),
    auth: {
      kind: "oauth2",
      providerDomain: "linear.example.test",
      scopes: ["issues:read", "issues:write"],
    },
    connectionId: financeConnectionId,
    connectionOwnership: "workspace",
    tools: [
      tool("issues_list", "List issues", "read", "never"),
      tool("issues_update", "Update issue", "write", "ask"),
      tool("issues_create", "Create issue", "write", "ask"),
    ],
    warnings: ["One new write tool requires explicit opt-in."],
  };
}

function tool(id: string, name: string, safety: "read" | "write", approvalMode: "never" | "ask") {
  return {
    id,
    operationKey: id.replaceAll("_", "."),
    name,
    description: `${name} through the Linear-like emulator.`,
    safety,
    approvalMode,
    deprecated: false,
  };
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (nextTheme) => {
    document.documentElement.setAttribute("data-og-theme", nextTheme);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, theme);
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

/** Focus restoration happens on the closing layer's unmount, so poll for it. */
async function expectFocused(locator: import("playwright").Locator): Promise<void> {
  const deadline = Date.now() + 10_000;
  let focused = false;
  while (Date.now() < deadline) {
    focused = await locator.evaluate((element) => element === document.activeElement);
    if (focused) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(focused).toBe(true);
}

async function expectVisible(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
}

async function expectText(locator: import("playwright").Locator, expected: string): Promise<void> {
  await locator.filter({ hasText: expected }).waitFor({ state: "visible", timeout: 15_000 });
  expect((await locator.textContent()) ?? "").toContain(expected);
}
