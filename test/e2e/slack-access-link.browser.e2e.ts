import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workspaceId = "00000000-0000-4000-8000-000000000241";
const requestId = "00000000-0000-4000-8000-000000000242";
const defaultWorkspaceId = "00000000-0000-4000-8000-000000000243";
const defaultAccountId = "00000000-0000-4000-8000-000000000244";
const apiContractRevision = OPENGENI_API_CONTRACT_REVISION;
const signedLink = "signed.slack.browser.bearer";

type AccessUiState = {
  signedIn: boolean;
  hasDefaultWorkspace: boolean;
  requestStatus: "prepared" | "pending" | "completed" | "cancelled" | "expired";
  requestVersion: number;
  signInBodies: Record<string, unknown>[];
  prepareBodies: Record<string, unknown>[];
  requestBodies: Record<string, unknown>[];
  cancelBodies: Record<string, unknown>[];
  requestReads: number;
};

describe("Slack access-link browser acceptance", () => {
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

  test("retains the bearer only in memory through sign-in, requests access, and completes after approval", async () => {
    const state = freshState();
    const context = await browser.newContext({ viewport: { width: 1180, height: 850 } });
    const page = await context.newPage();
    try {
      await installAccessApi(page, state);
      await page.goto(
        `${webBaseUrl}/workspaces/${workspaceId}/capabilities#slack_link=${encodeURIComponent(signedLink)}`,
        { waitUntil: "networkidle" },
      );

      await expectVisible(page.getByRole("heading", { name: "Sign in" }));
      expect(new URL(page.url()).hash).toBe("");
      expect(new URL(page.url()).searchParams.has("slack_link")).toBe(false);
      expect(
        await page.evaluate(() => ({
          local: Object.values(localStorage),
          session: Object.values(sessionStorage),
        })),
      ).toEqual({ local: [], session: [] });

      await page.getByLabel("Email").fill("slack-link@example.test");
      await page.getByLabel("Password").fill("correct-horse-battery-staple");
      await page.locator('form button[type="submit"]').click();

      await expectText(page.locator("main"), "Workspace access required");
      await expectText(
        page.locator("main"),
        "You need access to Proven Slack Workspace to connect your Slack account.",
      );
      await expectVisible(page.getByRole("button", { name: "Request access" }));
      await expectVisible(page.getByRole("button", { name: "Cancel" }));
      expect(
        await page.locator("strong").filter({ hasText: "Proven Slack Workspace" }).count(),
      ).toBe(1);
      expect(state.prepareBodies).toEqual([{ linkToken: signedLink }]);
      expect(state.signInBodies).toHaveLength(1);
      expect(JSON.stringify(state.signInBodies)).not.toContain(signedLink);
      expect(JSON.stringify(state.signInBodies).toLowerCase()).not.toContain("returnto");
      expect(JSON.stringify(state.requestBodies)).not.toContain(signedLink);
      expect(JSON.stringify(state.cancelBodies)).not.toContain(signedLink);

      await page.getByRole("button", { name: "Request access" }).click();
      await expectText(page.locator("main"), "Access requested");
      expect(state.requestBodies).toHaveLength(1);
      expect(state.requestBodies[0]).toMatchObject({ expectedVersion: 1 });
      expect(typeof state.requestBodies[0]?.idempotencyKey).toBe("string");
      expect(JSON.stringify(state.requestBodies[0])).not.toContain(signedLink);

      state.requestStatus = "completed";
      state.requestVersion = 3;
      await expectText(page.locator("body"), "Slack identity linked", 12_000);
      expect(state.requestReads).toBeGreaterThan(0);
      expect(new URL(page.url()).hash).toBe("");
      await page.reload({ waitUntil: "networkidle" });
      await expectText(page.locator("main"), "No workspace access");
      expect(state.prepareBodies).toHaveLength(1);
      expect(await page.getByRole("button", { name: "Request access" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 90_000);

  test("cancel is an explicit token-free terminal choice and does not submit an access request", async () => {
    const state = freshState();
    state.signedIn = true;
    const context = await browser.newContext({ viewport: { width: 1180, height: 850 } });
    const page = await context.newPage();
    try {
      await installAccessApi(page, state);
      await page.goto(
        `${webBaseUrl}/workspaces/${workspaceId}/capabilities#slack_link=${encodeURIComponent(signedLink)}`,
        { waitUntil: "networkidle" },
      );
      expect(new URL(page.url()).searchParams.has("slack_link")).toBe(false);
      expect(new URL(page.url()).hash).toBe("");
      expect(
        await page.evaluate(() => ({
          local: Object.values(localStorage),
          session: Object.values(sessionStorage),
        })),
      ).toEqual({ local: [], session: [] });
      await expectVisible(page.getByRole("button", { name: "Cancel" }));
      await page.getByRole("button", { name: "Cancel" }).click();
      await waitForCondition(() => state.cancelBodies.length === 1);
      expect(state.cancelBodies[0]).toMatchObject({ expectedVersion: 1 });
      expect(typeof state.cancelBodies[0]?.idempotencyKey).toBe("string");
      expect(JSON.stringify(state.cancelBodies)).not.toContain(signedLink);
      expect(state.requestBodies).toEqual([]);
      expect(state.requestStatus).toBe("cancelled");
      expect(new URL(page.url()).hash).toBe("");
      await page.reload({ waitUntil: "networkidle" });
      await expectText(page.locator("main"), "No workspace access");
      expect(state.prepareBodies).toHaveLength(1);
      expect(await page.getByRole("button", { name: "Cancel" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("expired signed links retain only fresh-link guidance and no mutation choices", async () => {
    const state = freshState();
    state.signedIn = true;
    state.requestStatus = "expired";
    state.requestVersion = 2;
    const context = await browser.newContext({ viewport: { width: 1180, height: 850 } });
    const page = await context.newPage();
    try {
      await installAccessApi(page, state);
      await page.goto(
        `${webBaseUrl}/workspaces/${workspaceId}/capabilities#slack_link=${encodeURIComponent(signedLink)}`,
        { waitUntil: "networkidle" },
      );
      await expectText(page.locator("main"), "Slack link unavailable");
      await expectText(
        page.locator("main"),
        "This Slack link is invalid or expired. Request a fresh link from Slack.",
      );
      expect(await page.getByRole("button", { name: "Request access" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Cancel" }).count()).toBe(0);
      expect(new URL(page.url()).hash).toBe("");
      expect(state.prepareBodies).toEqual([{ linkToken: signedLink }]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("legacy query links fail closed into the ordinary unavailable-workspace state", async () => {
    const state = freshState();
    state.signedIn = true;
    state.hasDefaultWorkspace = true;
    const context = await browser.newContext({ viewport: { width: 1180, height: 850 } });
    const page = await context.newPage();
    try {
      await installAccessApi(page, state);
      await page.goto(
        `${webBaseUrl}/workspaces/${workspaceId}/capabilities?slack_link=${encodeURIComponent(signedLink)}`,
        { waitUntil: "networkidle" },
      );
      await expectText(page.locator("main"), "Workspace unavailable");
      await expectText(page.locator("main"), "You don't have access to this workspace.");
      expect(new URL(page.url()).searchParams.has("slack_link")).toBe(false);
      expect(await page.getByRole("button", { name: "Request access" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Cancel" }).count()).toBe(0);
      expect(state.prepareBodies).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

function freshState(): AccessUiState {
  return {
    signedIn: false,
    hasDefaultWorkspace: false,
    requestStatus: "prepared",
    requestVersion: 1,
    signInBodies: [],
    prepareBodies: [],
    requestBodies: [],
    cancelBodies: [],
    requestReads: 0,
  };
}

async function installAccessApi(page: Page, state: AccessUiState): Promise<void> {
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
        deploymentRevision: "slack-access-browser-test",
        apiContractRevision,
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        models: [],
        defaultReasoningEffort: "low",
        allowedReasoningEfforts: ["low"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
        productAccessMode: "managed",
        auth: { mode: "managedSession", session: "cookie" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      });
    }
    if (url.pathname === "/v1/auth/get-session") {
      return json(
        state.signedIn
          ? {
              session: { id: "browser-session", expiresAt: new Date(Date.now() + 60_000) },
              user: {
                id: "browser-user",
                name: "Slack Link Browser",
                email: "slack-link@example.test",
              },
            }
          : null,
      );
    }
    if (url.pathname === "/v1/auth/sign-in/email" && request.method() === "POST") {
      state.signInBodies.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      state.signedIn = true;
      return json({ user: { id: "browser-user" } });
    }
    if (url.pathname === "/v1/access/me") {
      return json({
        mode: "managed",
        subjectId: "user:browser-user",
        subjectLabel: "slack-link@example.test",
        accountGrants: state.hasDefaultWorkspace
          ? [
              {
                accountId: defaultAccountId,
                subjectId: "user:browser-user",
                role: "owner",
                permissions: ["workspace:admin"],
              },
            ]
          : [],
        workspaceGrants: state.hasDefaultWorkspace
          ? [
              {
                workspaceId: defaultWorkspaceId,
                accountId: defaultAccountId,
                subjectId: "user:browser-user",
                permissions: ["workspace:admin", "sessions:read"],
              },
            ]
          : [],
        defaultAccountId: state.hasDefaultWorkspace ? defaultAccountId : null,
        defaultWorkspaceId: state.hasDefaultWorkspace ? defaultWorkspaceId : null,
      });
    }
    if (url.pathname === "/v1/workspaces") {
      return json(state.hasDefaultWorkspace ? [defaultWorkspace()] : []);
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}` && state.requestStatus === "completed") {
      return json(linkedWorkspace());
    }
    if (
      url.pathname === `/v1/workspaces/${workspaceId}/integrations/slack/user-link-intents` &&
      request.method() === "POST"
    ) {
      state.prepareBodies.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      return json(accessRequest(state), 201);
    }
    if (
      url.pathname ===
        `/v1/workspaces/${workspaceId}/integrations/slack/user-link-intents/${requestId}/request-access` &&
      request.method() === "POST"
    ) {
      state.requestBodies.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      state.requestStatus = "pending";
      state.requestVersion = 2;
      return json(accessRequest(state));
    }
    if (
      url.pathname ===
        `/v1/workspaces/${workspaceId}/integrations/slack/user-link-intents/${requestId}/cancel` &&
      request.method() === "POST"
    ) {
      state.cancelBodies.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      state.requestStatus = "cancelled";
      state.requestVersion += 1;
      return json(accessRequest(state));
    }
    if (
      url.pathname ===
        `/v1/workspaces/${workspaceId}/integrations/slack/user-link-intents/${requestId}` &&
      request.method() === "GET"
    ) {
      state.requestReads += 1;
      return json(accessRequest(state));
    }
    if (url.pathname.endsWith("/sessions")) {
      return json({ sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null });
    }
    return json({});
  });
}

function accessRequest(state: AccessUiState) {
  const now = new Date().toISOString();
  return {
    id: requestId,
    workspaceId,
    workspaceDisplayName: "Proven Slack Workspace",
    subjectLabel: "slack-link@example.test",
    status: state.requestStatus,
    version: state.requestVersion,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    requestedAt: state.requestStatus === "prepared" ? null : now,
    decidedAt:
      state.requestStatus === "completed" ||
      state.requestStatus === "cancelled" ||
      state.requestStatus === "expired"
        ? now
        : null,
    completedAt: state.requestStatus === "completed" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

function defaultWorkspace() {
  return workspaceShape(defaultWorkspaceId, defaultAccountId, "Default workspace", "default");
}

function linkedWorkspace() {
  return workspaceShape(workspaceId, defaultAccountId, "Proven Slack Workspace", "proven-slack");
}

function workspaceShape(id: string, accountId: string, name: string, slug: string) {
  const timestamp = new Date(0).toISOString();
  return {
    id,
    accountId,
    name,
    slug,
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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function expectVisible(locator: import("playwright").Locator): Promise<void> {
  try {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
  } catch (error) {
    const page = locator.page();
    throw new Error(
      `${String(error)}\nURL: ${page.url()}\nBODY: ${((await page.locator("body").textContent()) ?? "").slice(0, 4_000)}`,
      { cause: error },
    );
  }
}

async function expectText(
  locator: import("playwright").Locator,
  expected: string,
  timeout = 15_000,
): Promise<void> {
  await locator.waitFor({ state: "visible", timeout });
  const deadline = Date.now() + timeout;
  while (!((await locator.textContent()) ?? "").includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for text: ${expected}`);
    await Bun.sleep(50);
  }
}

async function waitForCondition(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for browser fixture state");
    await Bun.sleep(25);
  }
}
