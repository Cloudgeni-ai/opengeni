import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  type ConnectionStatus,
} from "@opengeni/contracts";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "00000000-0000-4000-8000-000000000231";
const accountId = "00000000-0000-4000-8000-000000000232";
const connectionId = "00000000-0000-4000-8000-000000000233";
const bindingId = "00000000-0000-4000-8000-000000000234";
const apiContractRevision = OPENGENI_API_CONTRACT_REVISION;

type FixtureState = {
  bindingState: "active" | "quarantined" | null;
  connectionStatus: ConnectionStatus;
  installRequests: number;
};

describe("Slack installation binding browser acceptance", () => {
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

  test("shows the exact tenant/principal binding and blocks quarantined or missing repairs", async () => {
    const state: FixtureState = {
      bindingState: "active",
      connectionStatus: "active",
      installRequests: 0,
    };
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    try {
      await installApiFixture(page, state);
      const capabilitiesUrl = `${webBaseUrl}/workspaces/${workspaceId}/capabilities`;

      await page.goto(capabilitiesUrl, { waitUntil: "domcontentloaded" });
      let settings = await openSlackSettings(page, "Connected");
      await expectText(settings, "Slack Binding Team (T_BINDING_BROWSER)");
      await expectText(settings, "B_BINDING_BROWSER · user U_BINDING_BROWSER");
      await expectText(settings, "Binding Account");
      await expectText(settings, "Binding Workspace");
      await expectText(settings, "active · version 3");
      expect(((await settings.textContent()) ?? "").toLowerCase()).not.toContain("xoxb-");
      expect(((await settings.textContent()) ?? "").toLowerCase()).not.toContain("authorization");
      expect((await settings.textContent()) ?? "").not.toContain(accountId);
      expect((await settings.textContent()) ?? "").not.toContain(workspaceId);
      expect(await settings.getByRole("button", { name: "Reconnect" }).isDisabled()).toBe(false);

      state.bindingState = "quarantined";
      state.connectionStatus = "needs_reauth";
      await page.goto(capabilitiesUrl, { waitUntil: "domcontentloaded" });
      settings = await openSlackSettings(page, "Needs attention");
      await expectText(settings, "quarantined · version 3");
      await expectText(settings, "Legacy installations conflict");
      expect(await settings.getByRole("button", { name: "Reconnect" }).isDisabled()).toBe(true);

      state.bindingState = null;
      await page.goto(capabilitiesUrl, { waitUntil: "domcontentloaded" });
      settings = await openSlackSettings(page, "Needs attention");
      await expectText(settings, "No verified installation binding is available");
      expect(await settings.getByRole("button", { name: "Reconnect" }).isDisabled()).toBe(true);
      expect(state.installRequests).toBe(0);
    } finally {
      await context.close();
    }
  }, 90_000);
});

async function openSlackSettings(page: Page, chip: string) {
  const row = page.getByRole("button", { name: `Slack. ${chip}`, exact: true });
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.click();
  const settings = page.getByRole("region", { name: "Slack settings" });
  await settings.waitFor({ state: "visible", timeout: 15_000 });
  return settings;
}

async function installApiFixture(page: Page, state: FixtureState): Promise<void> {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "x-opengeni-api-contract": apiContractRevision },
        body: JSON.stringify(body),
      });
    if (url.pathname === "/v1/config/client") {
      return json({
        deploymentRevision: "slack-binding-browser-test",
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
        structuredServices: {
          fileSystem: false,
          git: false,
          terminalEvents: false,
        },
      });
    }
    if (url.pathname === "/v1/access/me") {
      return json({
        mode: "configured",
        subjectId: "binding-browser-subject",
        subjectLabel: "Binding browser test",
        accountGrants: [
          {
            accountId,
            subjectId: "binding-browser-subject",
            role: "owner",
            permissions: ["account:admin", "workspace:admin", "capabilities:read"],
          },
        ],
        workspaceGrants: [
          {
            workspaceId,
            accountId,
            subjectId: "binding-browser-subject",
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
    if (url.pathname === `/v1/workspaces/${workspaceId}`) return json(workspace());
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      return json({ items: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/skills`) return json({ skills: [] });
    if (url.pathname === `/v1/workspaces/${workspaceId}/plugins`) return json({ plugins: [] });
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations/definitions`) {
      return json({ definitions: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations`) {
      return json({ integrations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      return json({ connections: [slackConnection(state.connectionStatus)] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections/slack-bot/bindings`) {
      return json({
        bindings: state.bindingState ? [slackBinding(state.bindingState)] : [],
      });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/memory-slack-publications/configuration`) {
      return json({ current: null, history: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/memory-slack-publications/channels`) {
      return json({ channels: [], nextCursor: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/memory-slack-publications`) {
      return json({ publications: [], nextCursor: null });
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/workspaces/${workspaceId}/connections/slack-bot/install`
    ) {
      state.installRequests += 1;
      return json({ error: { message: "blocked fixture should not be called" } }, 500);
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/social/connections`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/packs`) {
      return json({ packs: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/variable-sets`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/rigs`) return json([]);
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/sessions`) {
      return json({
        sessions: [],
        pinned: [],
        pinnedTruncated: false,
        nextCursor: null,
      });
    }
    return json({});
  });
}

function workspace() {
  return {
    id: workspaceId,
    accountId,
    name: "Binding Workspace",
    slug: "binding-workspace",
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

function slackConnection(status: ConnectionStatus) {
  return {
    id: connectionId,
    accountId,
    workspaceId,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    status,
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: status === "active" ? null : "reauthorization required",
    version: 4,
    verifiedInstallAt: new Date(0).toISOString(),
    verifiedInstallVersion: 4,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: "T_BINDING_BROWSER",
      slackTeamName: "Slack Binding Team",
      botId: "B_BINDING_BROWSER",
      botUserId: "U_BINDING_BROWSER",
      botDisplayName: "OpenGeni",
      verifiedAt: new Date(0).toISOString(),
    },
    createdBySubjectId: "binding-browser-subject",
    updatedBySubjectId: "binding-browser-subject",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function slackBinding(state: "active" | "quarantined") {
  return {
    id: bindingId,
    accountId,
    accountName: "Binding Account",
    workspaceId,
    workspaceName: "Binding Workspace",
    connectionId,
    connectionStatus: state === "active" ? "active" : "needs_reauth",
    connectionVersion: 4,
    slackTeamId: "T_BINDING_BROWSER",
    slackTeamName: "Slack Binding Team",
    botId: "B_BINDING_BROWSER",
    botUserId: "U_BINDING_BROWSER",
    botDisplayName: "OpenGeni",
    state,
    quarantineReason: state === "quarantined" ? "legacy_conflicting_installations" : null,
    version: 3,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

async function expectText(locator: import("playwright").Locator, expected: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  expect((await locator.textContent()) ?? "").toContain(expected);
}
