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
  signInFailuresRemaining: number;
  hasDefaultWorkspace: boolean;
  requestStatus: "prepared" | "pending" | "completed" | "cancelled" | "expired";
  requestVersion: number;
  signInBodies: Record<string, unknown>[];
  prepareBodies: Record<string, unknown>[];
  requestBodies: Record<string, unknown>[];
  cancelBodies: Record<string, unknown>[];
  accessReads: number;
  workspaceListReads: number;
  workspaceDetailReads: number;
  workspaceDetailReadsBeforeRevalidation: number;
  requestReads: number;
  prepareGate: Promise<void> | null;
  requestGate: Promise<void> | null;
  cancelGate: Promise<void> | null;
  authorizeLinkedWorkspaceOnCompletion: boolean;
  linkedWorkspaceAuthorized: boolean;
  rejectWorkspaceDetail: boolean;
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
    const prepareGate = deferredGate();
    const requestGate = deferredGate();
    state.prepareGate = prepareGate.promise;
    state.requestGate = requestGate.promise;
    state.authorizeLinkedWorkspaceOnCompletion = true;
    state.rejectWorkspaceDetail = true;
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

      await expectText(page.locator("main"), "Checking Slack access");
      await expectSingleMainWithoutRail(page);
      prepareGate.resolve();
      await expectText(page.locator("main"), "Workspace access required");
      await expectSingleMainWithoutRail(page);
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
      await expectSingleMainWithoutRail(page);
      expect(await page.getByRole("button", { name: "Request access" }).isDisabled()).toBe(true);
      requestGate.resolve();
      await expectText(page.locator("main"), "Access requested");
      await expectSingleMainWithoutRail(page);
      expect(state.requestBodies).toHaveLength(1);
      expect(state.requestBodies[0]).toMatchObject({ expectedVersion: 1 });
      expect(typeof state.requestBodies[0]?.idempotencyKey).toBe("string");
      expect(JSON.stringify(state.requestBodies[0])).not.toContain(signedLink);

      state.requestStatus = "completed";
      state.requestVersion = 3;
      const readsBeforeCompletion = state.requestReads;
      const accessReadsBeforeCompletion = state.accessReads;
      const workspaceListReadsBeforeCompletion = state.workspaceListReads;
      await waitForCondition(() => state.requestReads > readsBeforeCompletion, 12_000);
      await expectVisible(page.getByRole("navigation", { name: "Primary" }));
      expect(await page.locator("main").count()).toBe(1);
      await expectMainCountNeverExceededOne(page);
      expect(state.requestReads).toBeGreaterThan(0);
      expect(state.accessReads).toBe(accessReadsBeforeCompletion + 1);
      expect(state.workspaceListReads).toBe(workspaceListReadsBeforeCompletion + 1);
      expect(state.workspaceDetailReadsBeforeRevalidation).toBe(0);
      await expectNoBrowserErrors(page);
      expect(new URL(page.url()).hash).toBe("");
      await page.reload({ waitUntil: "networkidle" });
      await expectVisible(page.getByRole("navigation", { name: "Primary" }));
      expect(await page.locator("main").count()).toBe(1);
      await expectMainCountNeverExceededOne(page);
      expect(state.prepareBodies).toHaveLength(1);
      expect(await page.getByRole("button", { name: "Request access" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 90_000);

  test("direct completion revalidates once without starting the delayed rejecting workspace refresh", async () => {
    const state = freshState();
    const prepareGate = deferredGate();
    state.signedIn = true;
    state.requestStatus = "completed";
    state.requestVersion = 2;
    state.prepareGate = prepareGate.promise;
    state.authorizeLinkedWorkspaceOnCompletion = true;
    state.rejectWorkspaceDetail = true;
    const context = await browser.newContext({ viewport: { width: 1180, height: 850 } });
    const page = await context.newPage();
    try {
      await installAccessApi(page, state);
      await page.goto(
        `${webBaseUrl}/workspaces/${workspaceId}/capabilities#slack_link=${encodeURIComponent(signedLink)}`,
        { waitUntil: "domcontentloaded" },
      );

      await expectText(page.locator("main"), "Checking Slack access");
      await expectSingleMainWithoutRail(page);
      expect(state.accessReads).toBe(1);
      expect(state.workspaceListReads).toBe(1);
      prepareGate.resolve();

      await expectVisible(page.getByRole("navigation", { name: "Primary" }));
      expect(state.accessReads).toBe(2);
      expect(state.workspaceListReads).toBe(2);
      expect(state.workspaceDetailReadsBeforeRevalidation).toBe(0);
      // The authorized shell renders from the refreshed list before its live
      // provider starts the workspace-detail read. Wait for that independent
      // effect instead of racing it against the first visible navigation row.
      await waitForCondition(() => state.workspaceDetailReads > 0, 5_000);
      expect(state.workspaceDetailReads).toBeGreaterThan(0);
      expect(await page.locator("main").count()).toBe(1);
      await expectMainCountNeverExceededOne(page);
      await expectNoBrowserErrors(page);
      expect(await page.getByText("Slack link unavailable").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Request access" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("keeps the scrubbed one-shot bearer across a failed managed sign-in retry", async () => {
    const state = freshState();
    state.signInFailuresRemaining = 1;
    const context = await browser.newContext({ viewport: { width: 1180, height: 850 } });
    const page = await context.newPage();
    try {
      await installAccessApi(page, state);
      await page.goto(
        `${webBaseUrl}/workspaces/${workspaceId}/capabilities#slack_link=${encodeURIComponent(signedLink)}`,
        { waitUntil: "networkidle" },
      );

      await expectVisible(page.getByRole("heading", { name: "Sign in" }));
      await expectSingleMainWithoutRail(page);
      expect(new URL(page.url()).hash).toBe("");
      expect(
        await page.evaluate(() => ({
          local: Object.values(localStorage),
          session: Object.values(sessionStorage),
        })),
      ).toEqual({ local: [], session: [] });

      await page.getByLabel("Email").fill("slack-link@example.test");
      await page.getByLabel("Password").fill("correct-horse-battery-staple");
      await page.locator('form button[type="submit"]').click();
      // The managed panel keeps a failed attempt inline on the form instead of
      // in a toast, so the failure is part of the sign-in surface itself.
      await expectText(page.locator("body"), "Couldn't sign in");
      await expectText(page.locator("body"), "Email or password is incorrect.");
      await expectSingleMainWithoutRail(page);
      expect(state.prepareBodies).toEqual([]);

      await page.locator('form button[type="submit"]').click();
      await expectText(page.locator("main"), "Workspace access required");
      await expectSingleMainWithoutRail(page);
      expect(state.signInBodies).toHaveLength(2);
      expect(state.prepareBodies).toEqual([{ linkToken: signedLink }]);
      expect(new URL(page.url()).hash).toBe("");
    } finally {
      await context.close();
    }
  }, 90_000);

  test("cancel is an explicit token-free terminal choice and does not submit an access request", async () => {
    const state = freshState();
    const cancelGate = deferredGate();
    state.cancelGate = cancelGate.promise;
    state.signedIn = true;
    const context = await browser.newContext({ viewport: { width: 1180, height: 850 } });
    const page = await context.newPage();
    try {
      await installAccessApi(page, state);
      await page.goto(
        `${webBaseUrl}/workspaces/${workspaceId}/capabilities#slack_link=${encodeURIComponent(signedLink)}`,
        { waitUntil: "networkidle" },
      );
      await expectVisible(page.getByRole("button", { name: "Cancel" }));
      expect(new URL(page.url()).searchParams.has("slack_link")).toBe(false);
      expect(new URL(page.url()).hash).toBe("");
      expect(
        await page.evaluate(() => ({
          local: Object.values(localStorage),
          session: Object.values(sessionStorage),
        })),
      ).toEqual({ local: [], session: [] });
      await expectSingleMainWithoutRail(page);
      await page.getByRole("button", { name: "Cancel" }).click();
      await expectSingleMainWithoutRail(page);
      expect(await page.getByRole("button", { name: "Cancel" }).isDisabled()).toBe(true);
      cancelGate.resolve();
      await waitForCondition(() => state.cancelBodies.length === 1);
      expect(state.cancelBodies[0]).toMatchObject({ expectedVersion: 1 });
      expect(typeof state.cancelBodies[0]?.idempotencyKey).toBe("string");
      expect(JSON.stringify(state.cancelBodies)).not.toContain(signedLink);
      expect(state.requestBodies).toEqual([]);
      expect(state.requestStatus).toBe("cancelled");
      expect(new URL(page.url()).hash).toBe("");
      await page.reload({ waitUntil: "networkidle" });
      // A managed principal with no workspace access lands on organization
      // onboarding; the bare "No workspace access" panel is the unmanaged path.
      await expectText(page.locator("main"), "Create your organization");
      await expectVisible(page.getByLabel("Organization name"));
      await expectSingleMainWithoutRail(page);
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
      await expectSingleMainWithoutRail(page);
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
      await expectSingleMainWithoutRail(page);
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
    signInFailuresRemaining: 0,
    hasDefaultWorkspace: false,
    requestStatus: "prepared",
    requestVersion: 1,
    signInBodies: [],
    prepareBodies: [],
    requestBodies: [],
    cancelBodies: [],
    accessReads: 0,
    workspaceListReads: 0,
    workspaceDetailReads: 0,
    workspaceDetailReadsBeforeRevalidation: 0,
    requestReads: 0,
    prepareGate: null,
    requestGate: null,
    cancelGate: null,
    authorizeLinkedWorkspaceOnCompletion: false,
    linkedWorkspaceAuthorized: false,
    rejectWorkspaceDetail: false,
  };
}

async function installAccessApi(page: Page, state: AccessUiState): Promise<void> {
  await page.addInitScript(() => {
    const mainCounts: number[] = [];
    Object.defineProperty(window, "__opengeniMainCounts", { value: mainCounts });
    const browserErrors: string[] = [];
    Object.defineProperty(window, "__opengeniBrowserErrors", { value: browserErrors });
    window.addEventListener("error", (event) => browserErrors.push(event.message));
    window.addEventListener("unhandledrejection", (event) =>
      browserErrors.push(String(event.reason)),
    );
    const record = () => mainCounts.push(document.querySelectorAll("main").length);
    new MutationObserver(record).observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", record, { once: true });
  });
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
      if (state.signInFailuresRemaining > 0) {
        state.signInFailuresRemaining -= 1;
        return json(
          {
            code: "INVALID_EMAIL_OR_PASSWORD",
            message: "Invalid email or password",
          },
          401,
        );
      }
      state.signedIn = true;
      return json({ user: { id: "browser-user" } });
    }
    if (url.pathname === "/v1/auth/organization-onboarding" && request.method() === "GET") {
      return json({ state: "required" });
    }
    if (url.pathname === "/v1/access/me") {
      state.accessReads += 1;
      const linkedWorkspaceAuthorized = state.linkedWorkspaceAuthorized;
      return json({
        mode: "managed",
        subjectId: "user:browser-user",
        subjectLabel: "slack-link@example.test",
        accountGrants:
          state.hasDefaultWorkspace || linkedWorkspaceAuthorized
            ? [
                {
                  accountId: defaultAccountId,
                  subjectId: "user:browser-user",
                  role: "owner",
                  permissions: ["workspace:admin"],
                },
              ]
            : [],
        workspaceGrants: [
          ...(state.hasDefaultWorkspace
            ? [
                {
                  workspaceId: defaultWorkspaceId,
                  accountId: defaultAccountId,
                  subjectId: "user:browser-user",
                  permissions: ["workspace:admin", "sessions:read"],
                },
              ]
            : []),
          ...(linkedWorkspaceAuthorized
            ? [
                {
                  workspaceId,
                  accountId: defaultAccountId,
                  subjectId: "user:browser-user",
                  permissions: ["workspace:admin", "sessions:read"],
                },
              ]
            : []),
        ],
        defaultAccountId:
          state.hasDefaultWorkspace || linkedWorkspaceAuthorized ? defaultAccountId : null,
        defaultWorkspaceId: linkedWorkspaceAuthorized
          ? workspaceId
          : state.hasDefaultWorkspace
            ? defaultWorkspaceId
            : null,
      });
    }
    if (url.pathname === "/v1/organization-memberships") {
      return json({ memberships: [] });
    }
    if (url.pathname === "/v1/workspaces") {
      state.workspaceListReads += 1;
      return json([
        ...(state.hasDefaultWorkspace ? [defaultWorkspace()] : []),
        ...(state.linkedWorkspaceAuthorized ? [linkedWorkspace()] : []),
      ]);
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}`) {
      state.workspaceDetailReads += 1;
      const beforeRevalidation = Math.min(state.accessReads, state.workspaceListReads) < 2;
      if (beforeRevalidation) state.workspaceDetailReadsBeforeRevalidation += 1;
      if (state.rejectWorkspaceDetail && beforeRevalidation) {
        await Bun.sleep(100);
        return json({ error: { message: "delayed workspace refresh rejection" } }, 503);
      }
      return json(linkedWorkspace());
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/channels`) {
      // The workspace channels route returns the channel list directly. Keep
      // this browser API fixture on that wire contract so the typed SDK hook
      // never hands an envelope to the rail's array-only grouping helper.
      return json([]);
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
    if (
      url.pathname === `/v1/workspaces/${workspaceId}/rigs` ||
      url.pathname === `/v1/workspaces/${workspaceId}/variable-sets` ||
      url.pathname === `/v1/workspaces/${workspaceId}/social/connections`
    ) {
      return json([]);
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/capabilities`) {
      return json({ items: [], installations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections`) {
      return json({ connections: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/connections/slack-bot/bindings`) {
      return json({ bindings: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations/definitions`) {
      return json({ definitions: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/integrations`) {
      return json({ integrations: [] });
    }
    if (url.pathname === `/v1/workspaces/${workspaceId}/github/app`) {
      return json({ configured: false, missing: [], installUrl: null });
    }
    if (
      url.pathname === `/v1/workspaces/${workspaceId}/integrations/slack/user-link-intents` &&
      request.method() === "POST"
    ) {
      state.prepareBodies.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      await state.prepareGate;
      if (state.authorizeLinkedWorkspaceOnCompletion && state.requestStatus === "completed") {
        state.linkedWorkspaceAuthorized = true;
      }
      return json(accessRequest(state), 201);
    }
    if (
      url.pathname ===
        `/v1/workspaces/${workspaceId}/integrations/slack/user-link-intents/${requestId}/request-access` &&
      request.method() === "POST"
    ) {
      state.requestBodies.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      await state.requestGate;
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
      await state.cancelGate;
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
      if (state.authorizeLinkedWorkspaceOnCompletion && state.requestStatus === "completed") {
        state.linkedWorkspaceAuthorized = true;
      }
      return json(accessRequest(state));
    }
    if (url.pathname === "/v1/organization-invitations") {
      return json({ invitations: [], nextCursor: null });
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
    kind: "shared",
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

async function expectSingleMainWithoutRail(page: Page): Promise<void> {
  expect(await page.locator("main").count()).toBe(1);
  expect(await page.getByRole("navigation", { name: "Primary" }).count()).toBe(0);
  await expectMainCountNeverExceededOne(page);
}

async function expectMainCountNeverExceededOne(page: Page): Promise<void> {
  expect(
    await page.evaluate(() =>
      Math.max(
        0,
        ...((window as typeof window & { __opengeniMainCounts?: number[] }).__opengeniMainCounts ??
          []),
      ),
    ),
  ).toBe(1);
}

async function expectNoBrowserErrors(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __opengeniBrowserErrors?: string[] })
          .__opengeniBrowserErrors ?? [],
    ),
  ).toEqual([]);
  expect(await page.locator('[data-sonner-toast][data-type="error"]').count()).toBe(0);
  expect((await page.locator("body").textContent()) ?? "").not.toContain("Something went wrong");
}

function deferredGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
