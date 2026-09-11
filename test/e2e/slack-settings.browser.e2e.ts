import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { OPENGENI_SLACK_BOT_REQUESTED_SCOPES } from "@opengeni/contracts/slack-bot-scopes";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidence = `${repoRoot}/.agent/evidence/slack-settings`;
const workspaceId = "00000000-0000-4000-8000-000000000811";
const siblingId = "00000000-0000-4000-8000-000000000812";
const accountId = "00000000-0000-4000-8000-000000000813";
const connectionId = "00000000-0000-4000-8000-000000000814";
const now = "2026-09-07T00:00:00.000Z";
let browser: Browser;
let web: StartedProcess;
let baseUrl: string;

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await mkdir(evidence, { recursive: true });
  web = await startProcess(
    ["bun", "run", "vite", "dev", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: `${repoRoot}/apps/web`,
      env: { VITE_API_BASE_URL: "http://127.0.0.1:9" },
      ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
}, 30_000);

test("connected panel is compact, accessible, and keeps real routing and disconnect controls", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const state = { installed: true, routingSaves: 0, disconnects: 0 };
  try {
    await installApi(page, state);
    await page.goto(`${baseUrl}/workspaces/${workspaceId}/plugins?integration=slack`);
    const sheet = page.locator('[data-integration-sheet="slack"]');
    await sheet.getByText("Connected", { exact: true }).waitFor();
    await sheet.getByText("Where work starts", { exact: true }).waitFor();
    expect(await sheet.getByRole("button", { name: "Reconnect", exact: true }).isVisible()).toBe(
      false,
    );
    expect(await sheet.getByText("Bot", { exact: true }).isVisible()).toBe(false);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (nextTheme) => document.documentElement.setAttribute("data-og-theme", nextTheme),
        theme,
      );
      await page.waitForTimeout(600);
      const accessibility = await new AxeBuilder({ page })
        .include('[data-integration-sheet="slack"]')
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({ path: `${evidence}/connected-${theme}.png` });
    }
    await sheet.getByText("Where work starts", { exact: true }).click();
    await sheet.getByRole("button", { name: "Choose channel workspaces" }).click();
    const routing = page.getByRole("dialog", { name: "Where Slack channels start work" });
    await routing.getByRole("combobox").selectOption(siblingId);
    await routing.getByRole("button", { name: "Save", exact: true }).click();
    await routing.waitFor({ state: "hidden" });
    expect(state.routingSaves).toBe(1);
    await sheet.getByText("More options", { exact: true }).click();
    await sheet.getByRole("button", { name: "Disconnect", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Disconnect the OpenGeni Slack bot?" });
    await confirmation.getByText(/whole organization/).waitFor();
    expect(state.disconnects).toBe(0);
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 360, height: 800 });
    await sheet.getByText("Connection details", { exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).include('[data-integration-sheet="slack"]').analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: `${evidence}/expanded-mobile.png` });
  } finally {
    await context.close();
  }
}, 90_000);

test("sibling workspace finds the verified connection and opens its home settings", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await installApi(page, { installed: true, routingSaves: 0, disconnects: 0 });
    await page.goto(`${baseUrl}/workspaces/${siblingId}/plugins?integration=slack`);
    const sheet = page.locator('[data-integration-sheet="slack"]');
    await sheet.getByText("Connected", { exact: true }).waitFor();
    expect(await sheet.getByRole("button", { name: "Set up", exact: true }).count()).toBe(0);
    await sheet.getByRole("button", { name: "Open Slack settings" }).click();
    await page.waitForURL(`**/workspaces/${workspaceId}/plugins?integration=slack`);
    await page
      .locator('[data-integration-sheet="slack"]')
      .getByText("Where work starts", { exact: true })
      .waitFor();
  } finally {
    await context.close();
  }
}, 60_000);

test("OAuth conflict returns to a visible recovery message that survives reload", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const state = {
    installed: false,
    routingSaves: 0,
    disconnects: 0,
    connectionsReady: undefined as Promise<void> | undefined,
  };
  let releaseConnections = () => {};
  try {
    await installApi(page, state);
    await page.goto(
      `${baseUrl}/workspaces/${workspaceId}/capabilities?slack=error&reason=http_409`,
    );
    const sheet = page.locator('[data-integration-sheet="slack"]');
    await sheet
      .getByText("Slack is already linked to another installation", { exact: true })
      .waitFor();
    const redirected = new URL(page.url());
    expect(redirected.pathname).toBe(`/workspaces/${workspaceId}/plugins`);
    expect(redirected.searchParams.get("slack")).toBe("error");
    expect(redirected.searchParams.get("reason")).toBe("http_409");
    state.connectionsReady = new Promise<void>((resolve) => {
      releaseConnections = resolve;
    });
    await page.reload();
    await sheet
      .getByText("Slack is already linked to another installation", { exact: true })
      .waitFor();
    const setup = sheet.getByRole("button", { name: "Set up", exact: true });
    await setup.waitFor();
    expect(await setup.isDisabled()).toBe(true);
    releaseConnections();
    await sheet
      .getByText(
        "Your organization owner needs to resolve the existing Slack installation before setup can continue.",
        { exact: true },
      )
      .waitFor();
    expect(await setup.count()).toBe(0);
    await sheet.getByRole("button", { name: "Dismiss setup message" }).click();
    expect(new URL(page.url()).searchParams.has("slack")).toBe(false);
    await sheet.getByRole("button", { name: "Set up", exact: true }).waitFor();
  } finally {
    releaseConnections();
    await context.close();
  }
}, 60_000);

async function installApi(
  page: Page,
  state: {
    installed: boolean;
    routingSaves: number;
    disconnects: number;
    connectionsReady?: Promise<void>;
  },
) {
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION },
        body: JSON.stringify(body),
      });
    if (path === "/v1/config/client")
      return json({
        deploymentRevision: "slack-settings-test",
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
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
    if (path === "/v1/access/me")
      return json({
        mode: "configured",
        subjectId: "slack-test",
        subjectLabel: "Slack test",
        accountGrants: [],
        workspaceGrants: [workspaceId, siblingId].map((id) => ({
          workspaceId: id,
          accountId,
          subjectId: "slack-test",
          permissions: [
            "workspace:admin",
            "connections:read",
            "connections:write",
            "capabilities:read",
            "sessions:create",
          ],
        })),
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      });
    if (path === "/v1/workspaces")
      return json([workspace(workspaceId, "Cloudgeni"), workspace(siblingId, "Analytics")]);
    if (path.endsWith("/capabilities")) return json({ items: [], installations: [] });
    if (path.endsWith("/connections")) {
      await state.connectionsReady;
      return json({ connections: state.installed && path.includes(workspaceId) ? [bot()] : [] });
    }
    if (path.endsWith("/connections/slack-bot/bindings"))
      return json({ bindings: state.installed && path.includes(workspaceId) ? [binding()] : [] });
    if (path.endsWith("/channel-routes")) {
      if (request.method() === "PUT") {
        state.routingSaves++;
        return json({ routes: [], routingEnabled: true });
      }
      return json({ routes: [], routingEnabled: true });
    }
    if (path.endsWith("/reaction-channels"))
      return json({ channels: [{ id: "CDEV", name: "dev", isPrivate: false }], nextCursor: null });
    if (request.method() === "DELETE" && path.endsWith(connectionId)) {
      state.disconnects++;
      return json({});
    }
    if (path.endsWith("/packs")) return json({ packs: [], installations: [] });
    if (path.endsWith("/skills")) return json({ skills: [] });
    if (path.endsWith("/skills/content")) return json({ skills: [], nextCursor: null });
    if (path.endsWith("/plugins") && !path.endsWith("/discovery/plugins"))
      return json({ plugins: [] });
    if (path.endsWith("/capabilities/discovery/plugins"))
      return json({ items: [], total: 0, nextOffset: null });
    if (path.endsWith("/integrations/definitions")) return json({ definitions: [] });
    if (path.endsWith("/integrations")) return json({ integrations: [] });
    if (path.endsWith("/sessions"))
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    if (path.endsWith("/channels") || path.endsWith("/rigs") || path.endsWith("/variable-sets"))
      return json([]);
    if (path.endsWith("/github/app"))
      return json({ configured: false, missing: [], installUrl: null });
    return json({});
  });
}

function workspace(id: string, name: string) {
  return {
    id,
    accountId,
    kind: "shared",
    name,
    slug: name.toLowerCase(),
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
    createdAt: now,
    updatedAt: now,
  };
}
function bot() {
  return {
    id: connectionId,
    accountId,
    workspaceId,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    status: "active",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
    expiresAt: null,
    lastRefreshAt: now,
    lastUsedAt: now,
    lastError: null,
    version: 1,
    verifiedInstallAt: now,
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: "opengeni_slack_bot",
      credentialLabel: "OpenGeni Slack bot",
      slackTeamId: "TACME",
      slackTeamName: "Cloudgeni",
      botId: "BACME",
      botUserId: "UACME",
      botDisplayName: "OpenGeni",
    },
    createdBySubjectId: "slack-test",
    updatedBySubjectId: "slack-test",
    createdAt: now,
    updatedAt: now,
  };
}
function binding() {
  return {
    id: "00000000-0000-4000-8000-000000000815",
    accountId,
    accountName: "Cloudgeni",
    workspaceId,
    workspaceName: "Cloudgeni",
    connectionId,
    connectionStatus: "active",
    connectionVersion: 1,
    slackTeamId: "TACME",
    slackTeamName: "Cloudgeni",
    botId: "BACME",
    botUserId: "UACME",
    botDisplayName: "OpenGeni",
    state: "active",
    quarantineReason: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
