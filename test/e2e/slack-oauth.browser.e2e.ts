import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "00000000-0000-4000-8000-000000000217";
const accountId = "00000000-0000-4000-8000-000000000218";
const botConnectionId = "00000000-0000-4000-8000-000000000219";
const personalSlackCapabilityId = "mcp:slack-personal-browser-fixture";
const apiContractRevision = "2026-07-turn-instructions-v1";
const slackAuthorizationUrl =
  "https://slack.com/oauth/v2/authorize?client_id=browser-fixture&scope=chat%3Awrite&state=server-signed-browser-fixture";

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type SlackUiState = {
  connected: boolean;
  installRequests: Record<string, unknown>[];
  connectionReads: number;
};

describe("Slack OAuth browser acceptance", () => {
  let browser: Browser;
  let web: StartedProcess;
  let webBaseUrl: string;

  beforeAll(async () => {
    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
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

  test("uses official Add to Slack visual and preserves separate no-token principals", async () => {
    const state: SlackUiState = {
      connected: false,
      installRequests: [],
      connectionReads: 0,
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    let slackNavigations = 0;
    try {
      await installSlackCapabilityApi(page, state);
      await page.route("https://platform.slack-edge.com/img/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/png", body: transparentPng });
      });
      await page.route("https://slack.com/**", async (route) => {
        const url = new URL(route.request().url());
        expect(url.pathname).toBe("/oauth/v2/authorize");
        expect(url.searchParams.get("client_id")).toBe("browser-fixture");
        expect(url.searchParams.get("state")).toBe("server-signed-browser-fixture");
        slackNavigations += 1;
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html lang='en'><title>Slack consent fixture</title><body><h1>Slack workspace consent</h1></body></html>",
        });
      });

      const capabilitiesUrl = `${webBaseUrl}/workspaces/${workspaceId}/capabilities`;
      await page.goto(capabilitiesUrl, { waitUntil: "networkidle" });

      const personalSlack = page.getByRole("button").filter({ hasText: "Slack personal" }).first();
      await expectVisible(personalSlack);
      await personalSlack.click();
      const dialog = page.getByRole("dialog");
      await expectVisible(dialog);
      await expectText(
        dialog,
        "Authorize your own Slack account. Messages are sent as you using @OpenGeni.",
      );
      const personalText = ((await dialog.textContent()) ?? "").toLowerCase();
      expect(personalText).not.toContain("client secret");
      expect(personalText).not.toContain("client id");
      expect(personalText).not.toContain("xoxb");
      expect(personalText).not.toContain("requested by");
      expect(await dialog.locator("input").count()).toBe(0);
      await page.keyboard.press("Escape");
      await expectHidden(dialog);

      const install = page.getByRole("button", { name: "Install OpenGeni in Slack" });
      await expectVisible(install);
      const artwork = install.locator("img");
      expect(await artwork.getAttribute("src")).toBe(
        "https://platform.slack-edge.com/img/add_to_slack.png",
      );
      expect(await artwork.getAttribute("srcset")).toBe(
        "https://platform.slack-edge.com/img/add_to_slack@2x.png 2x",
      );
      expect(await install.evaluate((element) => element.closest("a"))).toBeNull();

      await Promise.all([page.waitForURL("https://slack.com/**"), install.click()]);
      await expectVisible(page.getByRole("heading", { name: "Slack workspace consent" }));
      expect(state.installRequests).toEqual([{}]);
      expect(JSON.stringify(state.installRequests).toLowerCase()).not.toContain("token");
      expect(JSON.stringify(state.installRequests).toLowerCase()).not.toContain("secret");

      state.connected = true;
      await page.goto(`${capabilitiesUrl}?slack=connected&connection_id=${botConnectionId}`, {
        waitUntil: "networkidle",
      });
      await expectText(page.getByRole("region", { name: "OpenGeni Slack bot" }), "Connected");
      expect(new URL(page.url()).search).toBe("");
      expect(state.connectionReads).toBeGreaterThanOrEqual(2);

      const reinstall = page.getByRole("button", { name: "Reinstall OpenGeni in Slack" });
      await expectVisible(reinstall);
      await Promise.all([page.waitForURL("https://slack.com/**"), reinstall.click()]);
      expect(state.installRequests[1]).toEqual({ connectionId: botConnectionId });

      await page.goto(capabilitiesUrl, { waitUntil: "networkidle" });
      const botRegion = page.getByRole("region", { name: "OpenGeni Slack bot" });
      await expectText(
        botRegion,
        "Existing scheduled tasks stay bound to their current Slack workspace/bot until explicitly changed.",
      );
      const installAnother = botRegion.getByRole("button", {
        name: "Install another Slack workspace/bot",
      });
      await Promise.all([page.waitForURL("https://slack.com/**"), installAnother.click()]);
      expect(state.installRequests[2]).toEqual({});
      expect(JSON.stringify(state.installRequests[2]).toLowerCase()).not.toContain("schedule");
      expect(slackNavigations).toBe(3);
    } finally {
      await context.close();
    }
  }, 90_000);
});

async function installSlackCapabilityApi(page: Page, state: SlackUiState): Promise<void> {
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
        deploymentRevision: "slack-browser-test",
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
        subjectId: "slack-browser-subject",
        subjectLabel: "Slack browser test",
        accountGrants: [
          {
            accountId,
            subjectId: "slack-browser-subject",
            role: "owner",
            permissions: ["workspace:admin", "capabilities:read", "capabilities:write"],
          },
        ],
        workspaceGrants: [
          {
            workspaceId,
            accountId,
            subjectId: "slack-browser-subject",
            permissions: [
              "workspace:admin",
              "capabilities:read",
              "capabilities:write",
              "connections:read",
              "connections:write",
            ],
          },
        ],
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      });
    }
    if (url.pathname === "/v1/workspaces") return json([workspace()]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      return json({ items: [personalSlackCapability()], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      state.connectionReads += 1;
      return json({ connections: state.connected ? [sharedSlackBotConnection()] : [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/packs`) {
      return json({ packs: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/variable-sets`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/connections/slack-bot/install`
    ) {
      state.installRequests.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({
        authorizationUrl: slackAuthorizationUrl,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    return json({});
  });
}

function workspace() {
  return {
    id: workspaceId,
    accountId,
    name: "Slack Browser Workspace",
    slug: "slack-browser",
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

function personalSlackCapability() {
  return {
    id: personalSlackCapabilityId,
    kind: "mcp",
    source: "registry",
    name: "Slack personal",
    description: "Use the authenticating Slack user's own hosted MCP connection.",
    category: "integrations",
    tags: ["slack", "oauth2", "mcp"],
    homepageUrl: "https://slack.com",
    endpointUrl: "https://mcp.slack.com/mcp",
    installUrl: null,
    authModel: "credential_ref",
    providerDomain: "slack.com",
    surfaceType: "mcp",
    transport: "streamable-http",
    mcpUrl: "https://mcp.slack.com/mcp",
    authKind: "oauth2",
    credentialFacts: [],
    tier: "verified",
    provenance: "browser-fixture",
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: {
      available: true,
      mcpServerId: "slack-personal-browser-fixture",
      transport: "streamable-http",
      notes: null,
      catalogTrust: { state: "trusted", reason: "browser_fixture" },
    },
    enabled: false,
    enabledReason: null,
    connectionRef: null,
    metadata: { providerDomain: "slack.com" },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function sharedSlackBotConnection() {
  return {
    id: botConnectionId,
    accountId,
    workspaceId,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    status: "active",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    verifiedInstallAt: new Date(0).toISOString(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: "T_BROWSER",
      slackTeamName: "Slack Browser Workspace",
      botUserId: "U_BROWSER_BOT",
      botId: "B_BROWSER",
      botDisplayName: "OpenGeni",
      verifiedAt: new Date(0).toISOString(),
    },
    createdBySubjectId: "slack-browser-subject",
    updatedBySubjectId: "slack-browser-subject",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

async function expectVisible(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
}

async function expectHidden(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ state: "hidden", timeout: 15_000 });
}

async function expectText(locator: import("playwright").Locator, expected: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  expect((await locator.textContent()) ?? "").toContain(expected);
}
