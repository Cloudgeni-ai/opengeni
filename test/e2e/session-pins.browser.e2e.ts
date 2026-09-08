import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import {
  appendSessionEventsAndUpdateSession,
  addSessionSystemUpdate,
  createDb,
  appendSessionEvents,
  createSession,
  grantWorkspaceAccess,
  removeWorkspaceMember,
  updateSessionTitle,
} from "@opengeni/db";
import { signDelegatedAccessToken, type Permission, type SessionEvent } from "@opengeni/contracts";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import {
  acquireSharedTestDatabase,
  freePort,
  MemoryEventBus,
  runCommand,
  startProcess,
  testSettings,
  waitFor,
  type SharedTestDatabase,
  type StartedProcess,
} from "@opengeni/testing";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Response as PlaywrightResponse,
  type Route,
} from "playwright";
import postgres from "postgres";

const repoRoot = new URL("../..", import.meta.url).pathname;
const ownerHeaders = { "x-opengeni-subject": "sessionpin-owner" };
const otherMemberHeaders = { "x-opengeni-subject": "sessionpin-other-member" };
const ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;
const workflowClient: SessionWorkflowClient = {
  signalUserMessage: async () => undefined,
  wakeSessionWorkflow: async () => undefined,
  requestSessionWorkflowWakeDispatch: async () => undefined,
  signalApprovalDecision: async () => undefined,
  signalSessionControl: async () => undefined,
  syncScheduledTask: async () => undefined,
  deleteScheduledTaskSchedule: async () => undefined,
  triggerScheduledTask: async () => undefined,
  startRigVerification: async () => undefined,
};

describe("session pins browser e2e (real API + non-superuser PostgreSQL)", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let apiBaseUrl: string;
  let webBaseUrl: string;

  beforeAll(async () => {
    // Build before acquiring/migrating the real database and starting the API.
    // The production bundle is the memory-heavy part of this acceptance gate;
    // keeping the database fixture and server out of that peak prevents the
    // CI knowledge lane from killing the nested build before browser launch.
    const apiPort = await freePort();
    apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    const webEnv = {
      NODE_ENV: "production",
      VITE_API_BASE_URL: apiBaseUrl,
    };
    const build = await runCommand(["bun", "run", "build"], {
      cwd: `${repoRoot}/apps/web`,
      env: webEnv,
      timeoutMs: 120_000,
    });
    if (build.exitCode !== 0) {
      throw new Error(
        `Production web build failed (exit ${build.exitCode}, timedOut=${String(build.timedOut)}):\n${build.stderr}\n${build.stdout}`,
      );
    }

    const acquired = await acquireSharedTestDatabase("session-pins-browser");
    if (!acquired) {
      throw new Error("session pin browser E2E requires real PostgreSQL; no skip is allowed");
    }
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    const app = createApp({
      // Exercise the normal configured-principal access path so independent
      // contexts can represent either the same member on another device or a
      // different member in the same bootstrapped workspace. This is not a DB
      // or localStorage identity shortcut; every request still traverses the
      // public access, membership, subject-GUC, and FORCE-RLS boundaries.
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "configured",
        delegationSecret: undefined,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: apiPort,
      idleTimeout: 120,
      fetch: app.fetch,
    });
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
    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
    // Closing the browser stops new polling first; then drain requests that
    // already entered the API before closing its database pool. Force-stopping
    // the listener and immediately ending the pool races those handlers and
    // turns clean teardown into CONNECTION_ENDED noise (or an unhandled error).
    await api?.stop(false);
    await dbClient?.close().catch(() => undefined);
    await shared?.release();
  }, 60_000);

  test("renders goal landmarks through the production session chunk graph", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /React error|Element type is invalid/.test(message.text())
      ) {
        errors.push(message.text());
      }
    });
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const session = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Goal landmark production proof",
      );
      await appendSessionEvents(dbClient.db, workspaceId, session.id, [
        { type: "goal.set", payload: { text: "Review the candidate" } },
        { type: "goal.held", payload: { reason: "Waiting for review" } },
        { type: "goal.continuation", payload: { text: "Review the candidate" } },
      ]);
      // A fresh page follows the same lazy route import order as the stock app.
      // Isolated MessageTimeline builds do not reproduce this chunk cycle.
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${session.id}`);
      await page
        .getByText("Continuing toward the goal: Review the candidate", { exact: true })
        .waitFor();
      expect(await page.getByText("Timeline item unavailable", { exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
      const landmark = page.getByText("Continuing toward the goal: Review the candidate", {
        exact: true,
      });
      expect(await landmark.locator("..").locator("svg").count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("keeps the selected session grouping after a page refresh", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      await createSessionThroughApi(page, apiBaseUrl, workspaceId, "Grouping preference proof");
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions`);
      await page.getByRole("link", { name: /^Open Grouping preference proof/ }).waitFor();

      await page.getByRole("button", { name: "Session filters" }).click();
      await page.getByRole("menuitemradio", { name: "Creator" }).click();
      await page.getByRole("button", { name: "Session filters, active" }).waitFor();

      await page.reload();
      await page.getByRole("link", { name: /^Open Grouping preference proof/ }).waitFor();
      await page.getByRole("button", { name: "Session filters, active" }).click();
      expect(
        await page.getByRole("menuitemradio", { name: "Creator" }).getAttribute("aria-checked"),
      ).toBe("true");
    } finally {
      await context.close();
    }
  }, 60_000);

  test("loads the settings interface only when opening a management page", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const managementRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("/assets/workspace-management-surfaces-"))
        managementRequests.push(request.url());
    });
    try {
      await page.goto(webBaseUrl);
      await workspaceFromPage(page);
      const settings = page.getByRole("link", { name: "Settings", exact: true });
      await settings.waitFor();
      expect(managementRequests).toHaveLength(0);
      await settings.click();
      await page.getByRole("heading", { name: "General", exact: true }).waitFor();
      expect(managementRequests.length).toBeGreaterThan(0);
      await page.getByRole("link", { name: "Back to sessions", exact: true }).click();
      await page.getByRole("link", { name: "Settings", exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("adapts rail shortcuts to viewport height without hiding them on tall screens", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      await workspaceFromPage(page);
      await page.getByRole("link", { name: "Plugins", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "More", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Less", exact: true }).count()).toBe(0);
      await page.setViewportSize({ width: 1280, height: 600 });
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("link", { name: "Plugins", exact: true }).waitFor();
      await page.getByRole("button", { name: "Less", exact: true }).click();
      expect(await page.getByRole("link", { name: "Plugins", exact: true }).count()).toBe(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole("link", { name: "Plugins", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "More", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Less", exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("loads older sessions only in the project whose end enters the viewport", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const suffix = Date.now();
      const projectA = await createChannelThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        `Pagination project A ${suffix}`,
      );
      const projectB = await createChannelThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        `Pagination project B ${suffix}`,
      );
      for (let index = 0; index < 56; index += 1) {
        await createSession(dbClient.db, {
          accountId: projectA.accountId,
          workspaceId,
          initialMessage: `Project A older row ${index + 1}`,
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          channelId: projectA.id,
        });
        await createSession(dbClient.db, {
          accountId: projectB.accountId,
          workspaceId,
          initialMessage: `Project B older row ${index + 1}`,
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          channelId: projectB.id,
        });
      }

      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions`);
      const projectAGroup = page.getByRole("group", { name: projectA.name });
      const projectBGroup = page.getByRole("group", { name: projectB.name });
      await projectAGroup.waitFor();
      await projectBGroup.waitFor();
      const projectARows = projectAGroup.locator("a[data-session-row]");
      const projectBRows = projectBGroup.locator("a[data-session-row]");
      const initialProjectACount = await projectARows.count();
      const initialProjectBCount = await projectBRows.count();
      expect(initialProjectACount).toBeGreaterThan(0);
      expect(initialProjectBCount).toBeGreaterThan(0);
      expect(initialProjectACount + initialProjectBCount).toBe(50);

      const filteredRequests: URL[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          request.method() === "GET" &&
          url.pathname === `/v1/workspaces/${workspaceId}/sessions` &&
          url.searchParams.get("view") === "page" &&
          url.searchParams.has("channelId")
        ) {
          filteredRequests.push(url);
        }
      });
      const loadProjectA = projectAGroup.getByRole("button", {
        name: `Load older sessions in ${projectA.name}`,
      });
      await loadProjectA.waitFor();
      const footerBefore = await page
        .getByRole("link", { name: "Settings", exact: true })
        .boundingBox();
      await loadProjectA.scrollIntoViewIfNeeded();
      await waitFor(async () => (await projectARows.count()) > initialProjectACount, {
        timeoutMs: 30_000,
      });

      const scroll = await page.locator("[data-rail-scroll-viewport]").evaluate((element) => ({
        top: element.scrollTop,
        height: element.clientHeight,
        total: element.scrollHeight,
        listOverflow: getComputedStyle(element.querySelector("[data-sessionpin-session-list]")!)
          .overflowY,
      }));
      expect(scroll.top).toBeGreaterThan(0);
      expect(scroll.total).toBeGreaterThan(scroll.height);
      expect(scroll.listOverflow).toBe("visible");
      const footerAfter = await page
        .getByRole("link", { name: "Settings", exact: true })
        .boundingBox();
      expect(footerAfter?.y).toBe(footerBefore?.y);
      expect(await projectBRows.count()).toBe(initialProjectBCount);
      expect(filteredRequests.length).toBeGreaterThan(0);
      expect(
        filteredRequests.every((request) => request.searchParams.get("channelId") === projectA.id),
      ).toBe(true);
      expect(
        filteredRequests.some((request) => request.searchParams.get("channelId") === projectB.id),
      ).toBe(false);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("normalizes search-only creators and counts hierarchical browse roots", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Created grouping unrelated root",
      );
      const manager = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Created grouping manager",
      );
      const child = await createTitledSession(dbClient.db, {
        accountId: manager.accountId,
        workspaceId,
        initialMessage: "Created grouping child",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: manager.id,
        createdBy: {
          kind: "subject",
          subjectId: "sessionpin-child-only-creator",
          label: "Child-only creator",
        },
      });

      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions`);
      const rail = page.locator("[data-sessionpin-session-list]");
      const managerRow = rail.locator(`a[data-session-row="${manager.id}"]`);
      await managerRow.waitFor();

      const search = page.getByRole("searchbox", { name: "Search sessions" });
      await search.fill("Created grouping child");
      await page.getByText("1 matching session.").waitFor();
      await page.getByRole("button", { name: "Session filters" }).click();
      await page.getByRole("menuitem", { name: /^Creator/ }).hover();
      await page.getByRole("menuitemradio", { name: "Child-only creator" }).click();

      // A creator offered only by flat child search is not a valid root filter.
      // Leaving search clears that scoped choice instead of painting an empty
      // hierarchy or leaving the submenu with a generic "Selected" value.
      await search.fill("");
      await managerRow.waitFor();
      await page.getByRole("button", { name: "Session filters" }).click();
      expect(await page.getByText("Selected", { exact: true }).count()).toBe(0);
      await page.getByRole("menuitemradio", { name: "Created date" }).click();
      await page.getByRole("button", { name: "Session filters, active" }).waitFor();
      const liveRegion = rail.locator('[aria-live="polite"]');
      await page.waitForFunction(() => {
        const message = document.querySelector(
          '[data-sessionpin-session-list] [aria-live="polite"]',
        )?.textContent;
        return Boolean(message && message !== "1 matching session.");
      });
      const rootCountAnnouncement = await liveRegion.textContent();
      expect(rootCountAnnouncement).toMatch(/^\d+ matching sessions?\.$/);

      // Browse grouping keeps root-only pagination and lazy child loading. The
      // child must not appear beside its manager as another top-level result.
      expect(await rail.locator(`a[data-session-row="${child.id}"]`).count()).toBe(0);
      const managerItem = managerRow.locator("xpath=../..");
      await managerItem.getByRole("button", { name: "Expand spawned sessions" }).click();
      const childRow = rail.locator(`a[data-session-row="${child.id}"]`);
      await childRow.waitFor();
      await page.waitForTimeout(250);
      expect(await liveRegion.textContent()).toBe(rootCountAnnouncement);
      expect(
        await childRow.evaluate((element) =>
          element.closest('[role="list"]')?.getAttribute("aria-label"),
        ),
      ).toBe("Spawned sessions from Created grouping manager");
      expect(await rail.locator(`a[data-session-row="${child.id}"]`).count()).toBe(1);
      await expectNoAxeViolations(page, ["[data-sessionpin-session-list]"]);
      await page.screenshot({
        path: "/tmp/opengeni-session-created-group-hierarchy.png",
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("acknowledges later output without leaving and reopening the active chat", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    let releaseFirstAcknowledgement = () => {};
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const target = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Unread active chat",
      );
      const attentionPath = `/v1/workspaces/${workspaceId}/sessions/${target.id}/attention`;
      let acknowledgementAttempts = 0;
      const firstAcknowledgementRelease = new Promise<void>((resolve) => {
        releaseFirstAcknowledgement = resolve;
      });
      let markFirstAcknowledgementStarted = () => {};
      const firstAcknowledgementStarted = new Promise<void>((resolve) => {
        markFirstAcknowledgementStarted = resolve;
      });
      await page.route(`**${attentionPath}`, async (route) => {
        acknowledgementAttempts += 1;
        if (acknowledgementAttempts === 1) {
          markFirstAcknowledgementStarted();
          await firstAcknowledgementRelease;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "transient acknowledgement failure" }),
          });
          return;
        }
        await route.continue();
      });
      const firstAcknowledgement = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === attentionPath &&
          response.status() === 200,
        { timeout: ACKNOWLEDGEMENT_TIMEOUT_MS },
      );
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${target.id}`);
      await firstAcknowledgementStarted;
      const targetRow = page.locator(`a[data-session-row="${target.id}"]`);
      await targetRow.waitFor({ state: "visible", timeout: 10_000 });
      expect(await targetRow.getAttribute("aria-label")).not.toContain("unread");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(100);
      releaseFirstAcknowledgement();
      const firstAcknowledgementResponse = await firstAcknowledgement;
      const firstReadThrough = Number(
        firstAcknowledgementResponse.request().postDataJSON().acknowledgedThroughSequence,
      );
      expect(acknowledgementAttempts).toBeGreaterThanOrEqual(2);
      expect(Number.isSafeInteger(firstReadThrough)).toBe(true);
      // Let every initial tail/load projection settle so the next mutation can
      // only be caused by the event appended below, not by a second initial
      // render of the same chat.
      await page.waitForTimeout(1_500);
      await page.evaluate((sessionId) => {
        const observedWindow = window as Window & { __activeSessionUnreadFlash?: boolean };
        observedWindow.__activeSessionUnreadFlash = false;
        const row = document.querySelector(`a[data-session-row="${sessionId}"]`);
        if (!row) throw new Error("active session row is missing");
        const observeLabel = () => {
          if (row.getAttribute("aria-label")?.includes("unread")) {
            observedWindow.__activeSessionUnreadFlash = true;
          }
        };
        observeLabel();
        new MutationObserver(observeLabel).observe(row, {
          attributes: true,
          attributeFilter: ["aria-label"],
        });
      }, target.id);

      const laterAcknowledgement = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === attentionPath,
        { timeout: ACKNOWLEDGEMENT_TIMEOUT_MS },
      );
      const sendResponse = await page.evaluate(
        async ({ browserApiBaseUrl, targetWorkspaceId, targetSessionId }) => {
          const response = await fetch(
            `${browserApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/sessions/${targetSessionId}/events`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                type: "user.message",
                clientEventId: crypto.randomUUID(),
                payload: { text: "Later output arrived while the chat stayed open" },
              }),
            },
          );
          return { status: response.status, body: await response.text() };
        },
        {
          browserApiBaseUrl: apiBaseUrl,
          targetWorkspaceId: workspaceId,
          targetSessionId: target.id,
        },
      );
      expect(sendResponse).toEqual({ status: 202, body: expect.any(String) });
      const laterAcknowledgementResponse = await laterAcknowledgement;
      expect(laterAcknowledgementResponse.status()).toBe(200);
      expect(
        Number(laterAcknowledgementResponse.request().postDataJSON().acknowledgedThroughSequence),
      ).toBeGreaterThan(firstReadThrough);
      await page
        .locator(`a[data-session-row="${target.id}"]`)
        .waitFor({ state: "visible", timeout: 10_000 });
      expect(await targetRow.getAttribute("aria-label")).not.toContain("unread");
      expect(
        await page.evaluate(
          () =>
            (window as Window & { __activeSessionUnreadFlash?: boolean })
              .__activeSessionUnreadFlash,
        ),
      ).toBe(false);
    } finally {
      releaseFirstAcknowledgement();
      await context.close();
    }
  }, 60_000);

  for (const transition of ["frontier", "workspace"] as const) {
    test(`does not retry an obsolete attention frontier after a ${transition} change`, async () => {
      const context = await configuredContext(browser, {
        viewport: { width: 1280, height: 800 },
        extraHTTPHeaders: ownerHeaders,
      });
      const page = await context.newPage();
      let release = () => {};
      try {
        await page.goto(webBaseUrl);
        const workspaceId = await workspaceFromPage(page);
        const target = await createSessionThroughApi(
          page,
          apiBaseUrl,
          workspaceId,
          `Attention ${transition} fence`,
        );
        let nextWorkspaceId = workspaceId;
        if (transition === "workspace") {
          const response = await fetch(`${apiBaseUrl}/v1/workspaces`, {
            method: "POST",
            headers: { ...ownerHeaders, "content-type": "application/json" },
            body: JSON.stringify({ name: "Attention alternate workspace" }),
          });
          expect(response.status).toBe(201);
          nextWorkspaceId = (await response.json()).id;
        }
        const attentionPath = `/v1/workspaces/${workspaceId}/sessions/${target.id}/attention`;
        let markStarted = () => {};
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const attempts: number[] = [];
        await page.route(`**${attentionPath}`, async (route) => {
          attempts.push(Number(route.request().postDataJSON().acknowledgedThroughSequence));
          if (attempts.length === 1) {
            markStarted();
            await released;
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ message: "held acknowledgement failure" }),
            });
          } else await route.continue();
        });
        await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${target.id}`);
        await started;
        const firstSequence = attempts[0]!;
        const firstFailure = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            new URL(response.url()).pathname === attentionPath &&
            response.status() === 503,
        );
        if (transition === "frontier") {
          const newer = page.waitForResponse(
            (response) =>
              response.request().method() === "PUT" &&
              new URL(response.url()).pathname === attentionPath &&
              response.ok() &&
              Number(response.request().postDataJSON().acknowledgedThroughSequence) > firstSequence,
          );
          const message = await fetch(
            `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${target.id}/events`,
            {
              method: "POST",
              headers: { ...ownerHeaders, "content-type": "application/json" },
              body: JSON.stringify({
                type: "user.message",
                clientEventId: crypto.randomUUID(),
                payload: { text: "A newer visible frontier" },
              }),
            },
          );
          expect(message.status).toBe(202);
          await newer;
        } else {
          const documentMarker = await page.evaluate(() => {
            const marker = crypto.randomUUID();
            (window as Window & { __attentionFenceDocument?: string }).__attentionFenceDocument =
              marker;
            return marker;
          });
          await page.getByRole("button", { name: /Switch workspace/ }).click();
          await page
            .getByRole("menuitem", { name: "Attention alternate workspace", exact: true })
            .click();
          await page.waitForURL(`**/workspaces/${nextWorkspaceId}/sessions`);
          expect(
            await page.evaluate(
              () =>
                (window as Window & { __attentionFenceDocument?: string }).__attentionFenceDocument,
            ),
          ).toBe(documentMarker);
        }
        release();
        expect((await firstFailure).status()).toBe(503);
        await page.waitForTimeout(300);
        expect(attempts.filter((sequence) => sequence === firstSequence)).toHaveLength(1);
      } finally {
        release();
        await context.close();
      }
    }, 60_000);
  }

  test("keeps a rapidly viewed chat read after switching to another chat", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const first = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Rapid read first chat",
      );
      const second = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Rapid read second chat",
      );
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions`);
      await page.locator(`a[data-session-row="${first.id}"]`).waitFor();
      await page.locator(`a[data-session-row="${second.id}"]`).waitFor();

      // Exercise the real rail links inside the old 750 ms acknowledgement
      // window. Merely visiting the first chat must commit its read receipt;
      // changing routes cannot cancel or roll back that receipt.
      await page.evaluate(
        ({ firstId, secondId }) => {
          document.querySelector<HTMLElement>(`a[data-session-row="${firstId}"]`)?.click();
          window.setTimeout(() => {
            document.querySelector<HTMLElement>(`a[data-session-row="${secondId}"]`)?.click();
          }, 50);
        },
        { firstId: first.id, secondId: second.id },
      );
      await page.waitForURL(`**/sessions/${second.id}`);
      await page.waitForResponse(
        (response) =>
          response.ok() &&
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname ===
            `/v1/workspaces/${workspaceId}/sessions/${second.id}/attention`,
        { timeout: 10_000 },
      );

      await page.reload();
      const firstRow = page.locator(`a[data-session-row="${first.id}"]`);
      await firstRow.waitFor();
      const pageAfterSwitch = await listPageFromBrowser(page, apiBaseUrl, workspaceId, {
        limit: 50,
      });
      expect(pageAfterSwitch.sessions.find((session) => session.id === first.id)?.unread).toBe(
        false,
      );
    } finally {
      await context.close();
    }
  }, 60_000);

  test("pins through UI, reconciles another device, and stays above newer paged/search rows", async () => {
    const deviceA = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const pageA = await deviceA.newPage();
    await pageA.goto(webBaseUrl);
    const workspaceId = await workspaceFromPage(pageA);
    const longTitle = `Master pin target ${"with a deliberately long title ".repeat(6)}`.slice(
      0,
      200,
    );
    const target = await createSessionThroughApi(pageA, apiBaseUrl, workspaceId, longTitle);
    await Bun.sleep(10);
    await createSessionThroughApi(
      pageA,
      apiBaseUrl,
      workspaceId,
      "Ordinary session before the pin",
    );

    const targetUrl = `${webBaseUrl}/workspaces/${workspaceId}/sessions/${target.id}`;
    const initialCommits = await reactCommitCount(pageA);
    expect(initialCommits).toBeGreaterThan(0);
    const successfulTargetPinMutation = (response: PlaywrightResponse): boolean => {
      const url = new URL(response.url());
      return (
        response.ok() &&
        response.request().method() === "PUT" &&
        url.pathname === `/v1/workspaces/${workspaceId}/sessions/${target.id}/pin`
      );
    };
    await pageA.goto(targetUrl);
    // Pin from the ordinary list-row action, not just the header. The header
    // must reconcile from the same server-authoritative member relation.
    const pinMenuItem = pageA
      .locator(`a[data-session-row="${target.id}"]`)
      .locator("xpath=..")
      .getByRole("button", { name: "Pin session", exact: true });
    await pinMenuItem.waitFor();
    const initialPinMutation = pageA.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "PUT" &&
          url.pathname === `/v1/workspaces/${workspaceId}/sessions/${target.id}/pin`
        );
      },
      {
        timeout: 10_000,
      },
    );
    // Press through the locator so the keyboard action remains bound to the
    // menu item even if Radix completes its initial-focus microtask after the
    // item first becomes visible.
    await pinMenuItem.press("Enter");
    const initialPinResponse = await initialPinMutation;
    expect({
      status: initialPinResponse.status(),
      body: await initialPinResponse.text(),
    }).toEqual({ status: 200, body: expect.any(String) });
    await pageA.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();
    // Session navigation now starts the real capture-backed workbench while the
    // session record is still loading. Keep a bounded render budget that includes
    // that intentional parallel surface instead of measuring the rail alone.
    expect((await reactCommitCount(pageA)) - initialCommits).toBeLessThanOrEqual(72);
    const pinnedA = pageA.getByRole("group", { name: "Pinned" });
    await pinnedA.getByRole("link", { name: /^Open Master pin target/ }).waitFor();
    await pageA.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Unpin session",
    );
    expect(await pageA.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Unpin session",
    );

    // A sibling tab in the same browser context must reconcile through the
    // document-scoped invalidation channel without a reload or the 15s poll.
    // Wait for its actual rail row so the subscription is mounted before the
    // mutation, then require an observable list GET inside a strict 10s bound.
    const sameDeviceTab = await deviceA.newPage();
    await sameDeviceTab.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions`);
    const sameTabPinned = sameDeviceTab.getByRole("group", { name: "Pinned" });
    const sameTabPinnedTarget = sameTabPinned.getByRole("link", {
      name: /^Open Master pin target/,
    });
    await sameTabPinnedTarget.waitFor();
    const sameTabUnpinRefresh = sameDeviceTab.waitForResponse(
      (response) => successfulSessionPageResponse(response, workspaceId),
      { timeout: 10_000 },
    );
    const unpinMutation = pageA.waitForResponse(successfulTargetPinMutation, {
      timeout: 10_000,
    });
    await pageA.locator("header").getByRole("button", { name: "Unpin session" }).click();
    await pageA.locator("header").getByRole("button", { name: "Pin session" }).waitFor();
    await Promise.all([unpinMutation, sameTabUnpinRefresh]);
    await sameTabPinnedTarget.waitFor({ state: "detached" });

    const sameTabRepinRefresh = sameDeviceTab.waitForResponse(
      (response) => successfulSessionPageResponse(response, workspaceId),
      { timeout: 10_000 },
    );
    const repinMutation = pageA.waitForResponse(successfulTargetPinMutation, {
      timeout: 10_000,
    });
    await pageA.locator("header").getByRole("button", { name: "Pin session" }).click();
    await pageA.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();
    await Promise.all([repinMutation, sameTabRepinRefresh]);
    await sameTabPinnedTarget.waitFor();
    expect((await reactCommitCount(pageA)) - initialCommits).toBeLessThanOrEqual(128);

    // A genuinely separate browser context represents another device: it owns
    // independent document, cache, BroadcastChannel, and focus state, while the
    // local-mode authenticated principal is intentionally the same human.
    const deviceB = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const pageB = await deviceB.newPage();
    await pageB.goto(targetUrl);
    await pageB.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();
    await createSessionThroughApi(pageB, apiBaseUrl, workspaceId, "Newer unrelated activity");
    await pageB.reload();
    await pageB.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();
    const pinnedB = pageB.getByRole("group", { name: "Pinned" });
    await pinnedB.getByRole("link", { name: /^Open Master pin target/ }).waitFor();
    expect(
      await pinnedB
        .getByRole("link", { name: /^Open / })
        .first()
        .getAttribute("aria-label"),
    ).toStartWith("Open Master pin target");

    // A different member in the same workspace must keep their own ordinary
    // ordering and header state. This context uses the same public configured
    // access path but a distinct authenticated subject; owner pins never leak.
    const otherMember = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: otherMemberHeaders,
    });
    const otherPage = await otherMember.newPage();
    await otherPage.goto(targetUrl);
    await otherPage.locator("header").getByRole("button", { name: "Pin session" }).waitFor();
    expect(await otherPage.getByRole("group", { name: "Pinned" }).count()).toBe(0);

    // Search is server-backed: a matching pin remains in the pin section while
    // unrelated ordinary rows disappear instead of being forced through.
    const search = pageB.getByRole("searchbox", { name: "Search sessions" });
    await search.fill("Master pin target");
    await pageB.getByText("1 matching session.").waitFor();
    await pinnedB.getByRole("link", { name: /^Open Master pin target/ }).waitFor();
    expect(await pageB.getByRole("link", { name: /^Open Newer unrelated activity/ }).count()).toBe(
      0,
    );
    await search.fill("");
    await pageB
      .getByRole("link", { name: /^Open Newer unrelated activity/ })
      .waitFor({ timeout: 10_000 });

    // Pagination is also exercised through the normal authenticated browser API
    // path. Pins are complete on every page and never consume/duplicate an
    // ordinary cursor slot.
    const firstPage = await listPageFromBrowser(pageB, apiBaseUrl, workspaceId, { limit: 1 });
    expect(firstPage.pinned.map((session) => session.id)).toEqual([target.id]);
    expect(firstPage.sessions.map((session) => session.id)).not.toContain(target.id);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await listPageFromBrowser(pageB, apiBaseUrl, workspaceId, {
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.pinned.map((session) => session.id)).toEqual([target.id]);
    expect(secondPage.sessions.map((session) => session.id)).not.toContain(target.id);
    const filtered = await listPageFromBrowser(pageB, apiBaseUrl, workspaceId, {
      limit: 1,
      search: "Master pin target",
    });
    expect(filtered.pinned.map((session) => session.id)).toEqual([target.id]);
    expect(filtered.sessions).toEqual([]);

    // The rail uses real roving focus. Arrow navigation changes document focus,
    // Home returns to the pin, and Enter activates the currently focused row.
    const targetRow = pinnedB.getByRole("link", {
      name: /^Open Master pin target/,
    });

    // A boundary key is a navigation no-op. If it records the already-current
    // row as an intent, moving to that row's actions and then refreshing the
    // list incorrectly steals focus back to the row.
    const boundaryRow = pageB.locator("[data-sessionpin-session-list] a[data-session-row]").first();
    const boundarySessionId = await boundaryRow.getAttribute("data-session-row");
    if (!boundarySessionId) throw new Error("expected a visible boundary session row");
    await boundaryRow.focus();
    await pageB.keyboard.press("Home");
    const boundaryActions = pageB.locator(
      `button[data-session-actions="${boundarySessionId}"][data-session-actions-mode="quick"]:not([data-session-action="archive"])`,
    );
    await boundaryActions.focus();
    const boundaryRefresh = pageB.waitForResponse(
      (response) => successfulSessionPageResponse(response, workspaceId),
      { timeout: 10_000 },
    );
    await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
    await boundaryRefresh;
    expect(
      await pageB.evaluate(() => document.activeElement?.getAttribute("data-session-actions")),
    ).toBe(boundarySessionId);

    await targetRow.focus();
    await pageB.keyboard.press("ArrowDown");
    expect(
      await pageB.evaluate(() => document.activeElement?.getAttribute("data-session-focus")),
    ).not.toBeNull();
    expect(
      await pageB.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).not.toStartWith("Open Master pin target");
    await pageB.keyboard.press("Home");
    expect(
      await pageB.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).toStartWith("Open Master pin target");

    // A data refresh must preserve the keyboard user's still-visible roving
    // target rather than jumping focus back to the route-active pinned row.
    await pageB.keyboard.press("ArrowDown");
    const focusedBeforeRefresh = await pageB.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );
    expect(focusedBeforeRefresh).not.toBeNull();
    expect(focusedBeforeRefresh).not.toStartWith("Open Master pin target");
    await createSessionThroughApi(pageB, apiBaseUrl, workspaceId, "Refresh-only activity");
    await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
    await pageB
      .getByRole("link", { name: /^Open Refresh-only activity/ })
      .waitFor({ timeout: 10_000 });
    expect(await pageB.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      focusedBeforeRefresh,
    );

    // Validate semantic/contrast regressions in both desktop themes while the
    // real pinned rail and session header are visible, and retain inspectable
    // visual evidence outside the source tree.
    for (const theme of ["light", "dark"] as const) {
      await setTheme(pageB, theme);
      await expectNoPageOverflow(pageB);
      await expectNoAxeViolations(pageB, ["header", "[data-sessionpin-session-list]"]);
      await pageB.screenshot({
        path: `/tmp/sessionpin-session-pin-desktop-${theme}.png`,
        fullPage: true,
      });
    }

    // Offline failure rolls the exact optimistic projection back. Retrying
    // online through the same header action succeeds without a second logical
    // pin state or an OCC dead end.
    await deviceB.setOffline(true);
    await pageB.locator("header").getByRole("button", { name: "Unpin session" }).click();
    await pageB.getByText("Couldn't unpin session", { exact: true }).waitFor();
    await pageB.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();
    await deviceB.setOffline(false);
    await pageB.locator("header").getByRole("button", { name: "Unpin session" }).click();
    await pageB.locator("header").getByRole("button", { name: "Pin session" }).waitFor();

    // A different device has no shared browser channel. Returning focus must
    // trigger a real server reconciliation without reloading the document.
    const crossDeviceRefresh = pageA.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          successfulSessionPageResponse(response, workspaceId) &&
          url.searchParams.get("pinsOnly") === "true"
        );
      },
      { timeout: 10_000 },
    );
    await pageA.evaluate(() => window.dispatchEvent(new Event("focus")));
    await crossDeviceRefresh;
    await pageA.locator("header").getByRole("button", { name: "Pin session" }).waitFor();
    await pageA.getByRole("group", { name: "Pinned" }).waitFor({ state: "detached" });
    expect(await pageA.getByRole("group", { name: "Pinned" }).count()).toBe(0);

    // Pin from the header as a fresh OCC revision, then prove both the second
    // owner device and the other member reconcile to their respective truths.
    await pageA.locator("header").getByRole("button", { name: "Pin session" }).click();
    await pageA.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();
    await pageB.reload();
    await pageB.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();
    await otherPage.reload();
    await otherPage.locator("header").getByRole("button", { name: "Pin session" }).waitFor();
    expect(await otherPage.getByRole("group", { name: "Pinned" }).count()).toBe(0);

    expect(browserPageErrors.get(deviceA)).toEqual([]);
    expect(browserPageErrors.get(deviceB)).toEqual([]);
    expect(browserPageErrors.get(otherMember)).toEqual([]);

    await otherMember.close();
    await deviceB.close();
    await deviceA.close();
  }, 150_000);

  test("shows pin and archive on hover, opens the full menu on right-click, and restores quick-action focus", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const target = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Failed row-menu rollback target",
      );
      await setSessionPinThroughApi(page, apiBaseUrl, workspaceId, target, true);
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${target.id}`);
      const targetLink = page.locator(`a[data-session-row="${target.id}"]`);
      const targetRow = targetLink.locator("xpath=..");
      const quickActions = targetRow.locator(`[data-session-quick-actions="${target.id}"]`);
      const overflow = targetRow.locator(
        `button[data-session-actions="${target.id}"][data-session-actions-mode="overflow"]`,
      );
      const unpin = targetRow.getByRole("button", { name: "Unpin session", exact: true });

      await targetLink.waitFor();
      await page.mouse.move(1000, 700);
      await page.waitForFunction((sessionId) => {
        const actions = document.querySelector(`[data-session-quick-actions="${sessionId}"]`);
        return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "0";
      }, target.id);
      expect(await quickActions.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
      expect(await overflow.evaluate((element) => getComputedStyle(element).display)).toBe("none");
      await targetLink.hover();
      await page.waitForFunction((sessionId) => {
        const actions = document.querySelector(`[data-session-quick-actions="${sessionId}"]`);
        return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "1";
      }, target.id);
      await unpin.waitFor();
      await targetRow.getByRole("button", { name: "Archive session", exact: true }).waitFor();
      await page.screenshot({
        path: "/tmp/opengeni-session-row-quick-actions.png",
        fullPage: true,
      });

      await targetLink.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
      await page.getByRole("menuitem", { name: "Unpin", exact: true }).waitFor();
      await page.getByRole("menuitem", { name: "Archive", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await unpin.focus();

      let putAttempts = 0;
      let authoritativeGets = 0;
      const pinUrl = `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${target.id}/pin`;
      await page.route(pinUrl, async (route) => {
        if (route.request().method() === "PUT") {
          putAttempts += 1;
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "synthetic row-menu failure" }),
          });
          return;
        }
        await route.continue();
      });
      const sessionUrl = `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${target.id}`;
      await page.route(sessionUrl, async (route) => {
        if (route.request().method() === "GET") authoritativeGets += 1;
        await route.continue();
      });

      // Route registration yields to background refreshes. Address the direct
      // action so a refresh cannot move focus before keyboard activation.
      await unpin.press("Enter");
      await page.getByText("Couldn't unpin session", { exact: true }).waitFor();
      await targetRow.getByRole("button", { name: "Unpin session" }).waitFor();
      await page.waitForFunction(
        (sessionId) =>
          document.activeElement?.getAttribute("data-session-actions") === sessionId &&
          document.activeElement?.getAttribute("data-session-actions-mode") === "quick",
        target.id,
      );
      expect(putAttempts).toBe(1);
      expect(authoritativeGets).toBeGreaterThan(0);
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("data-session-actions")),
      ).toBe(target.id);
      expect(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("data-session-actions-mode"),
        ),
      ).toBe("quick");

      const archiveUrl = `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${target.id}/archive`;
      await page.route(archiveUrl, async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "synthetic archive failure" }),
        });
      });
      await targetRow.getByRole("button", { name: "Archive session", exact: true }).press("Enter");
      await page.getByText("Couldn't archive the chat.", { exact: true }).waitFor();
      await targetRow.getByRole("button", { name: "Archive session", exact: true }).waitFor();
      await page.waitForFunction(
        (sessionId) =>
          document.activeElement?.getAttribute("data-session-actions") === sessionId &&
          document.activeElement?.getAttribute("aria-label") === "Archive session",
        target.id,
        { timeout: 5000 },
      );
    } finally {
      await context.close();
    }
  }, 90_000);

  test("retains group rows and leaves unrelated pagination failures retryable", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const batch = `Expired cursor batch ${Date.now()}`;
      let sentinel: BrowserSession | null = null;
      // Bootstrap authority through the public API, then seed the remaining
      // fixture rows through the normal DB lifecycle. Listing, pagination and
      // mutations remain real API operations.
      sentinel = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Pagination sentinel prompt",
      );
      // Search also matches the immutable initial prompt. Give this root a
      // matching title only, so a later rename really removes its membership.
      const namedSentinel = await page.request.patch(
        `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${sentinel.id}`,
        { data: { title: `${batch} oldest sentinel` } },
      );
      expect(namedSentinel.ok()).toBe(true);
      await appendSessionEventsAndUpdateSession(
        dbClient.db,
        workspaceId,
        sentinel.id,
        [{ type: "agent.updated", payload: { source: "pagination fixture settled" } }],
        { status: "idle" },
      );
      for (let index = 1; index < 106; index += 1) {
        const seeded = await createTitledSession(dbClient.db, {
          accountId: sentinel.accountId,
          workspaceId,
          initialMessage: `${batch} row ${index + 1}`,
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: "sessionpin-owner" },
        });
        await appendSessionEventsAndUpdateSession(
          dbClient.db,
          workspaceId,
          seeded.id,
          [{ type: "agent.updated", payload: { source: "pagination fixture settled" } }],
          { status: "idle" },
        );
      }

      // Stay in the mounted workspace; search performs the real list refresh.
      const search = page.getByRole("searchbox", { name: "Search sessions" });
      await search.waitFor();
      await page.locator("[data-sessionpin-session-list] a[data-session-row]").first().waitFor({
        timeout: 30_000,
      });
      const firstPageResponse = page.waitForResponse(
        (response) =>
          successfulSessionPageResponse(response, workspaceId, {
            search: batch,
            cursor: null,
          }),
        { timeout: 30_000 },
      );
      await search.fill(batch);
      const firstPage = (await (await firstPageResponse).json()) as BrowserSessionPage;
      expect(firstPage.sessions).toHaveLength(50);
      expect(firstPage.nextCursor).toBeTruthy();

      const todayGroup = page.getByRole("group", { name: "Today" });
      const loadOlder = todayGroup.getByRole("button", {
        name: "Load older sessions in Today",
      });
      await loadOlder.waitFor({ timeout: 15_000 });
      const filteredFirstPageResponse = page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            successfulSessionPageResponse(response, workspaceId, {
              search: batch,
              cursor: null,
            }) &&
            url.searchParams.has("updatedFrom") &&
            !url.searchParams.has("updatedBefore")
          );
        },
        { timeout: 10_000 },
      );
      await loadOlder.scrollIntoViewIfNeeded();
      const filteredFirstPage = (await (
        await filteredFirstPageResponse
      ).json()) as BrowserSessionPage;
      expect(filteredFirstPage.sessions).toHaveLength(100);
      expect(filteredFirstPage.nextCursor).toBeTruthy();
      const retainedId = filteredFirstPage.sessions[0]!.id;
      const visibleRows = page.locator("[data-sessionpin-session-list] a[data-session-row]");
      await page.locator(`a[data-session-row="${retainedId}"]`).waitFor();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("[data-sessionpin-session-list] a[data-session-row]").length ===
          100,
      );
      expect(await visibleRows.count()).toBe(100);

      // A generic 500 is not treated as cursor expiry: loaded rows stay put and
      // the exact current cursor remains explicitly retryable.
      let injectedFailure = false;
      await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions?**`, async (route) => {
        const url = new URL(route.request().url());
        if (
          !injectedFailure &&
          url.searchParams.get("cursor") === filteredFirstPage.nextCursor &&
          url.searchParams.get("search") === batch
        ) {
          injectedFailure = true;
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "synthetic unrelated failure" }),
          });
          return;
        }
        await route.continue();
      });
      await loadOlder.scrollIntoViewIfNeeded();
      const retryOlder = todayGroup.getByRole("button", {
        name: "Retry older sessions in Today",
      });
      await retryOlder.waitFor({ timeout: 10_000 });
      expect(injectedFailure).toBe(true);
      await page.waitForFunction(
        () =>
          document.querySelectorAll("[data-sessionpin-session-list] a[data-session-row]").length ===
          100,
      );
      expect(await visibleRows.count()).toBe(100);
      await page.locator(`a[data-session-row="${retainedId}"]`).waitFor();

      // The stateless keyset remains retryable after an unrelated failure; no
      // server snapshot expires or forces a page-one rebase. The exact cursor
      // resumes at the final six rows and keeps all previously painted rows.
      const finalPageResponse = page.waitForResponse(
        (response) =>
          successfulSessionPageResponse(response, workspaceId, {
            search: batch,
            cursor: filteredFirstPage.nextCursor,
          }),
        { timeout: 10_000 },
      );
      await retryOlder.focus();
      await retryOlder.press("Enter");
      const finalPage = (await (await finalPageResponse).json()) as BrowserSessionPage;
      expect(finalPage.sessions).toHaveLength(6);
      expect(finalPage.nextCursor).toBeNull();
      await page.locator(`a[data-session-row="${sentinel!.id}"]`).waitFor();
      await page.waitForFunction(
        () => document.activeElement?.id === "session-group-today",
        undefined,
        { timeout: 10_000 },
      );
      const visibleIds = await visibleRows.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-session-row")),
      );
      expect(visibleIds).toHaveLength(106);
      expect(new Set(visibleIds).size).toBe(106);
      // A write from another device can change membership outside page one.
      // The exhausted group must revalidate its loaded window on the ordinary
      // poll, without requiring navigation or discarding the other 105 rows.
      const rename = await page.request.patch(
        `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${sentinel!.id}`,
        { data: { title: "Moved outside the current search" } },
      );
      expect(rename.ok()).toBe(true);
      await page.locator(`a[data-session-row="${sentinel!.id}"]`).waitFor({
        state: "detached",
        timeout: 30_000,
      });
      expect(await visibleRows.count()).toBe(105);
    } finally {
      await context.close();
    }
  }, 180_000);

  test("keeps lazy hierarchy, nested pins, keyboard order, and nested-list semantics truthful", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const manager = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Pinned hierarchy manager",
      );
      const ordinaryChild = await createTitledSession(dbClient.db, {
        accountId: manager.accountId,
        workspaceId,
        initialMessage: "Ordinary manager child",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: manager.id,
      });
      const intermediary = await createTitledSession(dbClient.db, {
        accountId: manager.accountId,
        workspaceId,
        initialMessage: "Lazy hierarchy intermediary",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: manager.id,
      });
      const intermediarySibling = await createTitledSession(dbClient.db, {
        accountId: manager.accountId,
        workspaceId,
        initialMessage: "Ordinary intermediary child",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: intermediary.id,
      });
      const descendant = await createTitledSession(dbClient.db, {
        accountId: manager.accountId,
        workspaceId,
        initialMessage: "Pinned hierarchy descendant",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: intermediary.id,
      });
      const leaf = await createTitledSession(dbClient.db, {
        accountId: manager.accountId,
        workspaceId,
        initialMessage: "Descendant-owned leaf",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: descendant.id,
      });

      await setSessionPinThroughApi(page, apiBaseUrl, workspaceId, manager, true);
      await Bun.sleep(10);
      const pinnedDescendant = await setSessionPinThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        descendant,
        true,
      );

      // A direct child route hydrates its parent branch in the background.
      // Hold that request open so any transient tree feedback remains visible
      // long enough to catch: route reconciliation must not append a loading
      // row beneath the workstream.
      const childPagePattern = `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions?**`;
      let releaseChildPage!: () => void;
      let markChildPageStarted!: () => void;
      let markChildPageFinished!: () => void;
      let childPageRequestStarted = false;
      const childPageGate = new Promise<void>((resolve) => {
        releaseChildPage = resolve;
      });
      const childPageStarted = new Promise<void>((resolve) => {
        markChildPageStarted = resolve;
      });
      const childPageFinished = new Promise<void>((resolve) => {
        markChildPageFinished = resolve;
      });
      const holdChildPage = async (route: Route): Promise<void> => {
        const url = new URL(route.request().url());
        if (
          url.searchParams.get("parentSessionId") !== manager.id ||
          url.searchParams.has("cursor")
        ) {
          await route.continue();
          return;
        }
        childPageRequestStarted = true;
        markChildPageStarted();
        await childPageGate;
        await route.continue();
        markChildPageFinished();
      };
      await page.route(childPagePattern, holdChildPage);
      try {
        await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${ordinaryChild.id}`);
        await page
          .getByTestId("session-timeline")
          .getByText("Ordinary manager child", { exact: true })
          .waitFor();
        await childPageStarted;
        expect(
          await page
            .locator("[data-sessionpin-session-list]")
            .getByText("Loading sessions…", { exact: true })
            .count(),
        ).toBe(0);
      } finally {
        releaseChildPage();
        if (childPageRequestStarted) await childPageFinished;
        await page.unroute(childPagePattern, holdChildPage);
      }

      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${manager.id}`);

      const pinnedList = page.getByRole("list", { name: "Pinned sessions" });
      await pinnedList.waitFor();
      const topLevelPin = (sessionId: string) =>
        pinnedList.locator(`:scope > [role="listitem"] > div > a[data-session-row="${sessionId}"]`);
      const topLevelPinItem = (sessionId: string) => topLevelPin(sessionId).locator("xpath=../..");
      await topLevelPin(descendant.id).waitFor();
      await topLevelPin(manager.id).waitFor();
      const hierarchyPinOrder = await pinnedList
        .locator(':scope > [role="listitem"] > div > a[data-session-row]')
        .evaluateAll(
          (rows, hierarchyIds) =>
            rows
              .map((row) => row.getAttribute("data-session-row"))
              .filter((id): id is string => id !== null && hierarchyIds.includes(id)),
          [descendant.id, manager.id],
        );
      // Other scenarios deliberately retain their own pins in this real
      // workspace. Assert the deterministic order of this hierarchy's two
      // explicit pin roots without assuming the authenticated member has no
      // unrelated personal pins.
      expect(hierarchyPinOrder).toEqual([descendant.id, manager.id]);

      // The manager arrives with only a server hierarchy summary. Expanding it
      // loads the two direct children, but the explicit nested pin remains an
      // independent top-level shortcut and is pruned from the manager branch.
      const managerItem = topLevelPinItem(manager.id);
      await managerItem.getByRole("button", { name: "Expand spawned sessions" }).click();
      const managerChildren = managerItem.getByRole("list", {
        name: "Spawned sessions from Pinned hierarchy manager",
      });
      await managerChildren.getByRole("link", { name: /^Open Ordinary manager child/ }).waitFor();
      await managerChildren
        .getByRole("link", { name: /^Open Lazy hierarchy intermediary/ })
        .waitFor();
      expect(await topLevelPin(descendant.id).count()).toBe(1);
      expect(await managerChildren.locator(`a[data-session-row="${descendant.id}"]`).count()).toBe(
        0,
      );

      // The intermediary retains an expand affordance for its ordinary child
      // even while pin ownership prunes the direct pinned child. Its lazy page
      // returns both projections, which puts the descendant's positive pin in
      // the child-page cache without rendering it twice. A later remote unpin
      // must reconcile that cached revision rather than leave a permanent stale
      // top-level shortcut.
      const intermediaryChildPage = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          successfulSessionPageResponse(response, workspaceId) &&
          url.searchParams.get("parentSessionId") === intermediary.id
        );
      });
      await managerChildren.getByRole("button", { name: "Expand spawned sessions" }).click();
      await intermediaryChildPage;
      const intermediaryChildren = managerChildren.getByRole("list", {
        name: "Spawned sessions from Lazy hierarchy intermediary",
      });
      await intermediaryChildren
        .locator(`a[data-session-row="${intermediarySibling.id}"]`)
        .waitFor();
      expect(
        await intermediaryChildren.locator(`a[data-session-row="${descendant.id}"]`).count(),
      ).toBe(0);

      // The descendant shortcut owns its unpinned leaf. Its nested list is
      // explicit to assistive technology, and keyboard order includes every
      // expanded descendant once before advancing to the next pin root.
      const descendantItem = topLevelPinItem(descendant.id);
      await descendantItem.getByRole("button", { name: "Expand spawned sessions" }).click();
      const descendantChildren = descendantItem.getByRole("list", {
        name: "Spawned sessions from Pinned hierarchy descendant",
      });
      await descendantChildren.locator(`a[data-session-row="${leaf.id}"]`).waitFor();
      const descendantRow = topLevelPin(descendant.id);
      await descendantRow.focus();
      await page.keyboard.press("ArrowDown");
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("data-session-row")),
      ).toBe(leaf.id);
      await page.keyboard.press("ArrowDown");
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("data-session-row")),
      ).toBe(manager.id);
      const visiblePinIds = await pinnedList
        .locator("a[data-session-row]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-row")));
      expect(new Set(visiblePinIds).size).toBe(visiblePinIds.length);
      await expectNoAxeViolations(page, ["[data-sessionpin-session-list]"]);

      // Unpin from a different device/API context while the manager—not the
      // descendant—is the active route. Focus reconciliation refreshes the
      // complete pins-only page, then point-reads the absent cached pin revision.
      const pinsOnlyRefresh = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          successfulSessionPageResponse(response, workspaceId) &&
          url.searchParams.get("pinsOnly") === "true"
        );
      });
      const descendantPointRead = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.ok() &&
          response.request().method() === "GET" &&
          url.pathname === `/v1/workspaces/${workspaceId}/sessions/${descendant.id}`
        );
      });
      // Install both observers before the remote mutation. The ordinary 15s
      // pin poll may otherwise reconcile between the mutation response and the
      // explicit focus refresh, making a truthful point read invisible to the
      // acceptance harness.
      await setSessionPinThroughApi(page, apiBaseUrl, workspaceId, pinnedDescendant, false);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await Promise.all([pinsOnlyRefresh, descendantPointRead]);
      const topLevelPinnedDescendant = page.locator(
        `[role="list"][aria-label="Pinned sessions"] > [role="listitem"] > div > a[data-session-row="${descendant.id}"]`,
      );
      await waitFor(async () => (await topLevelPinnedDescendant.count()) === 0, {
        timeoutMs: 10_000,
      });
      await intermediaryChildren.locator(`a[data-session-row="${descendant.id}"]`).waitFor();
      expect(ordinaryChild.id).toBeTruthy();
    } finally {
      await context.close();
    }
  }, 120_000);

  test("continues a failed session through normal Send and opens the constrained model picker", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const owner = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Failure fixture owner",
      );
      const failed = await createTitledSession(dbClient.db, {
        accountId: owner.accountId,
        workspaceId,
        initialMessage: "Failed session actions",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: "sessionpin-owner" },
      });
      await appendSessionEventsAndUpdateSession(
        dbClient.db,
        workspaceId,
        failed.id,
        [
          {
            type: "session.status.changed",
            payload: { status: "failed", code: "pre_claim_failure" },
          },
        ],
        { status: "failed" },
      );
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${failed.id}`);
      const banner = page.getByTestId("failed-session-banner");
      const chooseModel = banner.getByRole("button", { name: "Choose another model", exact: true });
      await chooseModel.waitFor();
      await waitFor(async () => !(await chooseModel.isDisabled()));
      await chooseModel.click();
      await page.getByRole("dialog", { name: "Model and effort", exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Search models or providers" }).waitFor();
      await page.keyboard.press("Escape");
      const continueButton = banner.getByRole("button", { name: "Continue", exact: true });
      await waitFor(async () => !(await continueButton.isDisabled()));
      let submissions = 0;
      await page.route(
        `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${failed.id}/composer-draft/submit`,
        async (route) => {
          submissions++;
          if (submissions === 1)
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "Fixture temporarily unavailable" }),
            });
          else await route.continue();
        },
      );
      const submission = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/composer-draft/submit"),
      );
      await continueButton.click();
      const receipt = await submission;
      expect(receipt.status()).toBe(503);
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      expect(
        await banner.getByRole("button", { name: "Continue requested", exact: true }).isDisabled(),
      ).toBe(true);
      await page.setViewportSize({ width: 375, height: 812 });
      await banner
        .getByText("Retry or remove the unsent message below before continuing.")
        .waitFor();
      expect(await banner.getByRole("button", { name: "Continue", exact: true }).isDisabled()).toBe(
        true,
      );
      const retryReceipt = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/composer-draft/submit"),
      );
      await retry.click();
      expect((await retryReceipt).ok()).toBe(true);
      expect(submissions).toBe(2);
      const text = "Continue from the last failure. Check current progress before repeating work.";
      await page.getByText(text, { exact: true }).waitFor();
      const evidence = await page.evaluate(
        async ({ apiBaseUrl: fixtureApiUrl, workspaceId: fixtureWorkspaceId, id }) => {
          const response = await fetch(
            `${fixtureApiUrl}/v1/workspaces/${fixtureWorkspaceId}/sessions/${id}/events`,
          );
          if (!response.ok) throw new Error(`events failed: ${response.status}`);
          return await response.json();
        },
        { apiBaseUrl, workspaceId, id: failed.id },
      );
      expect(
        evidence.filter(
          (event: { type: string; payload: { text?: string } }) =>
            event.type === "user.message" && event.payload.text === text,
        ),
      ).toHaveLength(1);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("opens the exact child from pending and delivered results without claiming the failed parent completed", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const parent = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Failed result parent",
      );
      const child = await createTitledSession(dbClient.db, {
        accountId: parent.accountId,
        workspaceId,
        initialMessage: "Child with verified PR result",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: parent.id,
        createdBy: { kind: "subject", subjectId: "sessionpin-owner" },
      });
      // Historical delivered receipts and current pending receipts are distinct.
      // Both travel through the actual API and event projection in the browser.
      await appendSessionEvents(dbClient.db, workspaceId, parent.id, [
        {
          type: "system.update.delivered",
          payload: {
            historyItemId: crypto.randomUUID(),
            count: 2,
            members: [0, 1].map((index) => ({
              id: crypto.randomUUID(),
              kind: "child_terminal_result",
              classification: index === 0 ? "success" : "failure",
              sourceId: child.id,
              summary:
                index === 0
                  ? "Earlier turn went idle waiting for CI."
                  : "Earlier review turn failed.",
            })),
          },
        },
      ]);
      for (let index = 0; index < 9; index += 1) {
        await addSessionSystemUpdate(dbClient.db, {
          accountId: parent.accountId,
          workspaceId,
          sessionId: parent.id,
          kind: "child_terminal_result",
          classification: "success",
          sourceId: child.id,
          dedupeKey: `child-result-browser:${parent.id}:${index}`,
          summary:
            index === 8
              ? "The child reports that its PR merged after review and green CI."
              : "The child went idle while waiting for CI; its goal is not complete.",
          payload: { type: "child_terminal_result", childSessionId: child.id, status: "idle" },
        });
      }
      await appendSessionEventsAndUpdateSession(
        dbClient.db,
        workspaceId,
        parent.id,
        [
          {
            type: "session.status.changed",
            payload: { status: "failed", code: "pre_claim_failure" },
          },
        ],
        { status: "failed" },
      );
      const parentUrl = `${webBaseUrl}/workspaces/${workspaceId}/sessions/${parent.id}`;
      await page.goto(parentUrl);
      await page.getByTestId("failed-session-banner").waitFor();
      const delivered = page.locator("details[data-og-machine-input-batch]");
      await delivered.getByText("2 agent results received", { exact: true }).click();
      expect(
        await delivered.getByRole("button", { name: "View session", exact: true }).count(),
      ).toBe(2);
      await delivered.getByRole("button", { name: "View session", exact: true }).first().click();
      await page.waitForURL(`**/sessions/${child.id}`);
      expect(new URL(page.url()).pathname.endsWith(child.id)).toBe(true);
      await page.goBack();
      await page.getByTestId("failed-session-banner").waitFor();
      await page.getByRole("button", { name: "Session activity", exact: true }).click();
      const incoming = page.getByRole("list", { name: "Incoming updates", exact: true });
      await incoming.waitFor();
      await page.getByText("Waiting to be included in an agent turn.", { exact: true }).waitFor();
      expect(await incoming.getByRole("listitem").count()).toBe(9);
      expect(
        await incoming.getByRole("button", { name: "View session", exact: true }).count(),
      ).toBe(9);
      expect(await page.getByTestId("failed-session-banner").isVisible()).toBe(true);
      const mobileContext = await configuredContext(browser, {
        viewport: { width: 375, height: 812 },
        extraHTTPHeaders: ownerHeaders,
      });
      try {
        const mobilePage = await mobileContext.newPage();
        mobilePage.on("pageerror", (error) => errors.push(error.message));
        await mobilePage.goto(parentUrl);
        await mobilePage.getByTestId("failed-session-banner").waitFor();
        await mobilePage.getByRole("button", { name: "Session activity", exact: true }).click();
        const mobileIncoming = mobilePage.getByRole("list", {
          name: "Incoming updates",
          exact: true,
        });
        await mobileIncoming.waitFor();
        await mobilePage
          .getByText("Waiting to be included in an agent turn.", { exact: true })
          .scrollIntoViewIfNeeded();
        expect(
          await mobilePage.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await mobilePage.screenshot({
          path: `${process.env.TMPDIR ?? "/tmp"}/opengeni-child-results-mobile.png`,
        });
        await mobileIncoming
          .getByRole("button", { name: "View session", exact: true })
          .last()
          .click();
        await mobilePage.waitForURL(`**/sessions/${child.id}`);
        expect(new URL(mobilePage.url()).pathname.endsWith(child.id)).toBe(true);
      } finally {
        await mobileContext.close();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  test("opens waiting descendants at every depth from a failed parent in For you", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const parent = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Attention failed parent",
      );
      const makeChild = (parentSessionId: string, title: string) =>
        createTitledSession(dbClient.db, {
          accountId: parent.accountId,
          workspaceId,
          initialMessage: title,
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          parentSessionId,
          createdBy: { kind: "subject", subjectId: "sessionpin-owner" },
        });
      const child = await makeChild(parent.id, "Attention direct child");
      const grandchild = await makeChild(child.id, "Attention nested child");
      // Fixture lifecycle events use the ordinary scoped event/status adapter.
      for (const [id, status] of [
        [parent.id, "failed"],
        [child.id, "requires_action"],
        [grandchild.id, "requires_action"],
      ] as const) {
        await appendSessionEventsAndUpdateSession(
          dbClient.db,
          workspaceId,
          id,
          [{ type: "session.status.changed", payload: { status } }],
          { status },
        );
      }
      const evidence = await page.evaluate(
        async ({
          apiBaseUrl: fixtureApiUrl,
          workspaceId: fixtureWorkspaceId,
          rootId,
          grandchildId,
        }) => {
          const root = `${fixtureApiUrl}/v1/workspaces/${fixtureWorkspaceId}`;
          const pause = await fetch(`${root}/sessions/${grandchildId}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "pause", clientEventId: crypto.randomUUID() }),
          });
          if (!pause.ok)
            throw new Error(`Pause fixture failed: ${pause.status} ${await pause.text()}`);
          const query = new URLSearchParams({
            rootSessionId: rootId,
            statuses: "requires_action",
            limit: "1",
          });
          const first = await fetch(`${root}/agent-topology?${query}`).then((r) => r.json());
          if (!first.nextCursor) throw new Error("Expected a cursor for two waiting depths");
          query.set("cursor", first.nextCursor);
          const second = await fetch(`${root}/agent-topology?${query}`).then((r) => r.json());
          const direct = await fetch(
            `${root}/agent-topology?${new URLSearchParams({ rootSessionId: rootId, parentSessionId: rootId, statuses: "requires_action" })}`,
          ).then((r) => r.json());
          return {
            all: [...first.sessions, ...second.sessions].map((s) => ({
              id: s.id,
              depth: s.nestedAgentDepth,
              pause: s.pause.state,
            })),
            direct: direct.sessions.map((s) => s.id),
          };
        },
        {
          apiBaseUrl,
          workspaceId,
          rootId: parent.id,
          grandchildId: grandchild.id,
        },
      );
      expect(evidence.all.map((s) => s.id).sort()).toEqual([child.id, grandchild.id].sort());
      expect(evidence.all.find((s) => s.id === grandchild.id)).toMatchObject({
        depth: 2,
        pause: "paused",
      });
      expect(evidence.direct).toEqual([child.id]);
      await page.getByRole("link", { name: /^For you/ }).click();
      const row = page
        .getByRole("listitem")
        .filter({ has: page.getByRole("link", { name: "Attention failed parent", exact: true }) });
      await row.getByRole("button", { name: "Show waiting agents", exact: true }).click();
      const nested = row.getByRole("link", { name: "Attention nested child", exact: true });
      await nested.waitFor();
      expect(await nested.getAttribute("href")).toBe(
        `/workspaces/${workspaceId}/sessions/${grandchild.id}`,
      );
      await row.getByText("Paused; request still pending", { exact: true }).waitFor();
      expect(await row.innerText()).toContain("Failed");
      await page.screenshot({ path: "/tmp/ux-priority-child-routing.png", fullPage: true });
      await nested.click();
      await waitFor(() => page.url().endsWith(`/sessions/${grandchild.id}`));
    } finally {
      await context.close();
    }
  }, 60_000);

  test("renders one truthful queue, goal, and agents stack above the composer", async () => {
    const desktop = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    let mobile: BrowserContext | null = null;
    try {
      const desktopPage = await desktop.newPage();
      await desktopPage.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(desktopPage);
      const manager = await createSessionThroughApi(
        desktopPage,
        apiBaseUrl,
        workspaceId,
        "Inspect the full session-control surface",
        {
          goal: {
            text: "Make queueing, goals, and agent activity completely understandable",
            successCriteria: "The UI has one compact and truthful surface for each concept.",
          },
        },
      );

      // Child lineage is intentionally not caller-forgeable through the public
      // create-session API: only a worker-signed parent grant may create it. This
      // browser fixture seeds that trusted relationship directly, then exercises
      // the ordinary authenticated lineage read and production UI rendering.
      const childSessionIds: string[] = [];
      for (const index of [1, 2]) {
        const child = await createTitledSession(dbClient.db, {
          accountId: manager.accountId,
          workspaceId,
          initialMessage: `Trusted child agent ${index}`,
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          parentSessionId: manager.id,
        });
        childSessionIds.push(child.id);
      }
      const grandchild = await createTitledSession(dbClient.db, {
        accountId: manager.accountId,
        workspaceId,
        initialMessage: `Intermediate agent ${"with a long descriptive title ".repeat(4)}`.slice(
          0,
          200,
        ),
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: childSessionIds[0]!,
      });
      const deepChild = await createTitledSession(dbClient.db, {
        accountId: manager.accountId,
        workspaceId,
        initialMessage: `Deep nested agent ${"with a long descriptive title ".repeat(5)}`.slice(
          0,
          200,
        ),
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        parentSessionId: grandchild.id,
      });

      const managerUrl = `${webBaseUrl}/workspaces/${workspaceId}/sessions/${manager.id}`;
      await desktopPage.goto(managerUrl);
      const chrome = desktopPage.getByTestId("session-chrome");
      const queueChip = desktopPage.getByTestId("session-chrome-queue");
      const goalChip = desktopPage.getByTestId("session-chrome-goal");
      const activityButton = desktopPage.getByRole("button", {
        name: "Session activity",
        exact: true,
      });
      const composer = desktopPage.getByLabel("Message the agent");
      const timeline = desktopPage.getByTestId("session-timeline");
      await timeline
        .getByText("Inspect the full session-control surface", { exact: true })
        .waitFor();
      expect(await queueChip.count()).toBe(0);
      await goalChip.waitFor();
      await activityButton.waitFor();
      await activityButton.click();
      await chrome.getByRole("button", { name: /^\d+ agents?$/ }).waitFor();
      await activityButton.click();
      await composer.waitFor();
      expect(await desktopPage.getByTestId("session-chrome").count()).toBe(1);
      expect(
        await desktopPage.getByRole("button", { name: "Session activity", exact: true }).count(),
      ).toBe(1);
      const [chromeBounds, composerBounds] = await Promise.all([
        chrome.boundingBox(),
        composer.locator("xpath=ancestor::*[@data-og-composer-id][1]").boundingBox(),
      ]);
      expect(chromeBounds).not.toBeNull();
      expect(composerBounds).not.toBeNull();
      expect(Math.abs((chromeBounds?.x ?? 0) - (composerBounds?.x ?? 0))).toBeLessThanOrEqual(1);
      expect(
        Math.abs((chromeBounds?.width ?? 0) - (composerBounds?.width ?? 0)),
      ).toBeLessThanOrEqual(1);

      // The initial prompt is already in chat, never presented as queued. Later
      // sends wait in the one visible queue because the inert workflow client
      // deliberately leaves the accepted initial turn pending.
      await composer.fill("A first prompt queued from the composer");
      await submitQueuedComposerPrompt(
        desktopPage,
        apiBaseUrl,
        workspaceId,
        manager.id,
        "A first prompt queued from the composer",
      );
      await queueChip.getByText("1 queued", { exact: true }).waitFor({ timeout: 20_000 });
      await composer.fill("A second prompt queued from the composer");
      await submitQueuedComposerPrompt(
        desktopPage,
        apiBaseUrl,
        workspaceId,
        manager.id,
        "A second prompt queued from the composer",
      );
      await queueChip.getByText("2 queued", { exact: true }).waitFor({ timeout: 20_000 });
      // Queue receipts pulse the compact control; open it to inspect the prompts.
      if ((await queueChip.getAttribute("aria-expanded")) !== "true") {
        await queueChip.click();
      }
      await chrome.getByRole("list", { name: "Queued prompts" }).waitFor();
      const queuePanel = chrome.locator('[data-og-session-chrome-panel-frame="queue"]');
      await waitFor(
        async () =>
          (await queuePanel.evaluate((element) => Number(getComputedStyle(element).opacity))) >= 1,
        { timeoutMs: 2_000 },
      );
      const queuedRows = chrome.getByRole("list", { name: "Queued prompts" }).getByRole("listitem");
      expect(await queuedRows.count()).toBe(2);
      expect(await queuedRows.nth(0).innerText()).toContain(
        "A first prompt queued from the composer",
      );
      expect(await queuedRows.nth(1).innerText()).toContain(
        "A second prompt queued from the composer",
      );

      // Retain the fully expanded queue—not only its compact summary—as
      // inspectable release evidence in both themes. This is the exact surface
      // where users reorder, edit, steer, or delete a waiting prompt.
      for (const theme of ["light", "dark"] as const) {
        await setTheme(desktopPage, theme);
        // Keep the hover-revealed actions visible while Axe inspects their text.
        const steerAction = chrome.getByRole("button", {
          name: "Steer queued prompt 2",
          exact: true,
        });
        await steerAction.focus();
        await steerAction.evaluate(async (node) => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await Promise.all(
            node
              .parentElement!.getAnimations()
              .map((animation) => animation.finished.catch(() => undefined)),
          );
        });
        await expectNoPageOverflow(desktopPage);
        await expectNoAxeViolations(desktopPage, ["[data-testid=session-chrome]"]);
        await desktopPage.screenshot({
          path: `/tmp/opengeni-session-control-queue-expanded-${theme}.png`,
          fullPage: true,
        });
      }

      // Move controls mutate the one durable queue. The server remains the
      // order authority after every operation.
      await chrome.getByRole("button", { name: "Move queued prompt 2 up" }).click();
      await expectRowPrompt(queuedRows, 0, "A second prompt queued from the composer");
      await chrome.getByRole("button", { name: "Move queued prompt 1 down" }).click();
      await expectRowPrompt(queuedRows, 0, "A first prompt queued from the composer");

      // Edit is a checkout: it removes the exact queue row and restores the
      // complete durable prompt into the composer, where Enter submits it again.
      // A pre-existing draft is never silently destroyed: the queue row stays
      // put until the user explicitly confirms replacement.
      await composer.fill("Unsent local draft that must not be overwritten");
      await chrome.getByRole("button", { name: "Edit queued prompt 2" }).click();
      await chrome.getByText("Replace it with this queued prompt?").waitFor();
      expect(await queuedRows.count()).toBe(2);
      expect(await composer.inputValue()).toBe("Unsent local draft that must not be overwritten");
      await chrome.getByRole("button", { name: "Keep current draft" }).click();
      expect(await queuedRows.count()).toBe(2);
      // The confirmation above is intentionally exercised while the local
      // draft may still be unsaved. Settle that accepted draft before clearing
      // it so cleanup cannot race two opposite autosaves under a loaded runner.
      await waitForComposerDraftText(
        desktopPage,
        apiBaseUrl,
        workspaceId,
        manager.id,
        "Unsent local draft that must not be overwritten",
      );
      await composer.fill("");
      await waitForComposerDraftText(desktopPage, apiBaseUrl, workspaceId, manager.id, "");
      await chrome.getByRole("button", { name: "Edit queued prompt 2" }).click();
      await waitFor(
        async () => (await composer.inputValue()) === "A second prompt queued from the composer",
        { timeoutMs: 10_000 },
      );
      await queueChip.getByText("1 queued", { exact: true }).waitFor();
      await composer.fill("A second prompt queued from the composer (edited)");
      await submitQueuedComposerPrompt(
        desktopPage,
        apiBaseUrl,
        workspaceId,
        manager.id,
        "A second prompt queued from the composer (edited)",
      );
      await queueChip.getByText("2 queued", { exact: true }).waitFor();

      // Pause is a durable workstream barrier. Row Steer is one atomic action:
      // it moves that row to the head and resumes the branch. The accepted row
      // is presented separately as the active direction, never as still queued.
      await desktopPage.getByRole("button", { name: "Pause this workstream" }).click();
      await desktopPage.getByRole("button", { name: "Resume this workstream" }).waitFor();
      await chrome.getByRole("button", { name: "Steer queued prompt 2" }).click();
      await desktopPage.getByRole("button", { name: "Pause this workstream" }).waitFor();
      try {
        await timeline
          .getByText("A second prompt queued from the composer (edited)", { exact: true })
          .waitFor({ timeout: 10_000 });
      } catch (cause) {
        const eventResponse = await fetch(
          `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${manager.id}/events?limit=100&payloadMode=full`,
          { headers: ownerHeaders },
        );
        const eventDiagnostics = (await eventResponse.json()) as SessionEvent[];
        throw new Error(
          `Steered queue prompt did not enter chat. Timeline=${JSON.stringify(await timeline.innerText())}; relevantEvents=${JSON.stringify(eventDiagnostics.filter((event) => event.type === "user.message" || event.type === "turn.queued" || event.type === "session.control.steer_requested"))}`,
          { cause },
        );
      }
      expect(await chrome.getByText("Changing direction…", { exact: true }).count()).toBe(0);
      await queueChip.getByText("1 queued", { exact: true }).waitFor();
      await expectRowPrompt(queuedRows, 0, "A first prompt queued from the composer");

      // Remove deletes only the selected waiting prompt. Add one final prompt so
      // the queue surface can still be exercised in the mobile pass.
      await chrome.getByRole("button", { name: "Remove queued prompt 1" }).click();
      await queueChip.waitFor({ state: "detached" });
      await composer.fill("A replacement prompt after delete");
      await submitQueuedComposerPrompt(
        desktopPage,
        apiBaseUrl,
        workspaceId,
        manager.id,
        "A replacement prompt after delete",
      );
      await queueChip.getByText("1 queued", { exact: true }).waitFor();
      expect(
        await timeline
          .getByText("Inspect the full session-control surface", { exact: true })
          .count(),
      ).toBe(1);
      const withdrawnPromptCount = await timeline
        .getByText("A second prompt queued from the composer", { exact: true })
        .count();
      if (withdrawnPromptCount !== 0) {
        const eventResponse = await fetch(
          `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${manager.id}/events?limit=100&payloadMode=full`,
          { headers: ownerHeaders },
        );
        const eventDiagnostics = (await eventResponse.json()) as SessionEvent[];
        throw new Error(
          `Withdrawn queue prompt remained in chat. Timeline=${JSON.stringify(await timeline.innerText())}; relevantEvents=${JSON.stringify(eventDiagnostics.filter((event) => event.type === "user.message" || event.type === "turn.queued" || event.type === "session.queue.changed" || event.type === "session.control.steer_requested"))}`,
        );
      }

      // A recursive Pause is visible and actionable from a deeply nested
      // session. Sending there remains inert in that selected branch's queue;
      // it does not silently resume the child, manager, or workspace. The
      // header breadcrumb remains bounded and exposes every
      // ancestor (the middle ancestors collapse into one explicit menu).
      await desktopPage.getByRole("button", { name: "Pause this workstream" }).click();
      await desktopPage.getByRole("button", { name: "Resume this workstream" }).waitFor();
      const deepChildUrl = `${webBaseUrl}/workspaces/${workspaceId}/sessions/${deepChild.id}`;
      await desktopPage.goto(deepChildUrl);
      const ancestry = desktopPage.getByRole("navigation", {
        name: "Session ancestry",
      });
      await ancestry.waitFor();
      await ancestry.getByRole("button", { name: "1 intermediate ancestor sessions" }).waitFor();
      expect(await ancestry.getByRole("link").count()).toBe(2);
      await desktopPage
        .getByRole("button", {
          name: /^Paused by .*\. Open workstream controls$/,
        })
        .waitFor();
      await desktopPage.getByRole("button", { name: "Resume this workstream" }).waitFor();
      await expectContainedInViewport(ancestry, 1280);
      const deepComposer = desktopPage.getByLabel("Message the agent");
      await deepComposer.fill("Run this selected nested session through the parent Pause");
      await submitQueuedComposerPrompt(
        desktopPage,
        apiBaseUrl,
        workspaceId,
        deepChild.id,
        "Run this selected nested session through the parent Pause",
      );
      await desktopPage.getByRole("button", { name: "Resume this workstream" }).waitFor();
      await desktopPage
        .getByTestId("session-chrome-queue")
        .getByText("1 queued", { exact: true })
        .waitFor();

      // The manager remains paused: queueing in a descendant is never a hidden
      // workspace/ancestor Resume.
      await desktopPage.goto(managerUrl);
      await desktopPage.getByRole("button", { name: "Resume this workstream" }).waitFor();
      await desktopPage.getByRole("button", { name: "Resume this workstream" }).click();
      await desktopPage.getByRole("button", { name: "Pause this workstream" }).waitFor();
      // The session record and lineage tree are independent reads. Navigation
      // must not require one to block the other, so await both independently
      // owned chips before asserting the settled control stack.
      await goalChip.waitFor();
      await activityButton.waitFor();

      const boxes = await Promise.all([chrome.boundingBox(), composer.boundingBox()]);
      for (const box of boxes) expect(box).not.toBeNull();
      expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
      expect(await goalChip.count()).toBe(1);
      expect(await activityButton.count()).toBe(1);

      for (const theme of ["light", "dark"] as const) {
        await setTheme(desktopPage, theme);
        await expectNoPageOverflow(desktopPage);
        await expectNoAxeViolations(desktopPage, [
          "[data-testid=session-chrome]",
          "textarea[aria-label='Message the agent']",
        ]);
        await desktopPage.screenshot({
          path: `/tmp/opengeni-session-control-stack-desktop-${theme}.png`,
          fullPage: true,
        });
      }

      mobile = await configuredContext(browser, {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        extraHTTPHeaders: ownerHeaders,
      });
      const mobilePage = await mobile.newPage();
      await mobilePage.goto(deepChildUrl);
      const mobileAncestry = mobilePage.getByRole("navigation", {
        name: "Session ancestry",
      });
      await mobileAncestry.waitFor();
      expect(await mobileAncestry.getByRole("link").count()).toBe(1);
      await expectContainedInViewport(mobileAncestry, 390);
      await expectNoPageOverflow(mobilePage);
      await mobilePage.goto(managerUrl);
      await mobilePage.getByTestId("session-chrome").waitFor();
      await mobilePage.getByTestId("session-chrome-goal").waitFor();
      await mobilePage.getByRole("button", { name: "Session activity", exact: true }).waitFor();
      await expectNoPageOverflow(mobilePage);
      await expectTouchTarget(mobilePage.getByTestId("session-chrome-queue"));
      await expectTouchTarget(
        mobilePage.getByRole("button", { name: "Session activity", exact: true }),
      );
      await mobilePage.screenshot({
        path: "/tmp/opengeni-session-control-stack-mobile.png",
        fullPage: true,
      });
    } finally {
      await mobile?.close().catch(() => undefined);
      await desktop.close().catch(() => undefined);
    }
  }, 150_000);

  test("keeps the pin/header/rail usable at 320px and 375px in light and dark themes", async () => {
    const mobileViewports = [
      { width: 320, height: 740, artifactSuffix: "" },
      { width: 375, height: 812, artifactSuffix: "-375" },
    ] as const;
    const context = await configuredContext(browser, {
      viewport: mobileViewports[0],
      hasTouch: true,
      isMobile: true,
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    await page.goto(webBaseUrl);
    const workspaceId = await workspaceFromPage(page);
    const target = await createSessionThroughApi(
      page,
      apiBaseUrl,
      workspaceId,
      `Mobile pin ${"long title ".repeat(20)}`.slice(0, 200),
    );
    await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${target.id}`);
    // Wait for the session shell before sampling React commits — a cold goto can
    // read the probe at 0 before the first paint registers.
    await page.locator("header").getByRole("button", { name: "Pin session" }).waitFor();
    const initialCommits = await reactCommitCount(page);
    expect(initialCommits).toBeGreaterThan(0);
    await page.locator("header").getByRole("button", { name: "Pin session" }).click();
    await page.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();
    expect((await reactCommitCount(page)) - initialCommits).toBeLessThanOrEqual(64);

    // Stress the compact pinned section with many long rows through the normal
    // browser-authenticated API. No direct DB mutation is used.
    for (let index = 0; index < 7; index += 1) {
      const extra = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        `Pinned mobile stress ${index + 1} ${"long title ".repeat(14)}`.slice(0, 200),
      );
      await setSessionPinThroughApi(page, apiBaseUrl, workspaceId, extra, true);
    }
    // The stress rows above are test fixtures inserted through raw fetches,
    // intentionally bypassing the application's mutation invalidation. Start
    // the responsive assertion from a fresh server projection instead of
    // racing the rail's 15-second background reconciliation interval.
    await page.reload();
    await page.locator("header").getByRole("button", { name: "Unpin session" }).waitFor();

    for (const viewport of mobileViewports) {
      await page.setViewportSize(viewport);
      for (const theme of ["light", "dark"] as const) {
        await setTheme(page, theme);
        await expectNoPageOverflow(page);
        const pin = page.locator("header").getByRole("button", { name: /^(Pin|Unpin) session$/ });
        const inspector = page.getByRole("button", { name: /^(Open|Hide) workspace$/ });
        const hamburger = page.getByRole("button", { name: "Open navigation" });
        for (const control of [pin, inspector, hamburger]) {
          const box = await control.boundingBox();
          expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        }

        // Capture the actual opened drawer and pinned section in each theme, not
        // merely the header behind a closed drawer.
        await page.getByRole("button", { name: "Open navigation" }).click();
        const navigation = page.getByRole("navigation", { name: "Primary" });
        expect(await navigation.count()).toBe(1);
        await navigation.waitFor();
        expect(await page.getByRole("dialog").getAttribute("aria-label")).toBe(
          "Session navigation",
        );
        const targetRow = navigation.getByRole("link", { name: /^Open Mobile pin/ });
        await targetRow.waitFor();
        // The active route row can render from its point read before the global
        // pin page arrives. Wait for a seeded shortcut so the count below
        // measures the fully loaded pinned section rather than that transient.
        await navigation.getByRole("link", { name: /^Open Pinned mobile stress 7/ }).waitFor();
        expect(await navigation.getByRole("group", { name: "Pinned" }).count()).toBe(1);
        expect(
          await navigation.getByRole("link", { name: /^Open Pinned mobile stress/ }).count(),
        ).toBe(7);
        await expectTouchTarget(targetRow);
        await expectTouchTarget(
          navigation.getByRole("button", { name: /^Actions for Mobile pin/ }),
        );
        await expectTouchTarget(navigation.getByRole("searchbox", { name: "Search sessions" }));
        await expectContainedInViewport(navigation, viewport.width);
        await expectNoPageOverflow(page);
        await expectNoAxeViolations(page, ["header", "[data-sessionpin-session-list]"]);
        await page.screenshot({
          path: `/tmp/sessionpin-session-pin-mobile${viewport.artifactSuffix}-${theme}.png`,
          fullPage: true,
        });

        await page.keyboard.press("Escape");
        await page.getByRole("navigation", { name: "Primary" }).waitFor({ state: "hidden" });
        // Radix restores focus after the drawer's close animation settles. Wait
        // for that observable contract rather than racing the animation frame.
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("aria-label") === "Open navigation",
        );
        expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
          "Open navigation",
        );
      }
    }
    expect(browserPageErrors.get(context)).toEqual([]);
    await context.close();
  }, 90_000);

  test("keeps token-carried listing alive when removal wins, with personal state cleaned", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    const barrier = postgres(shared.adminUrl, { max: 1 });
    const removalClient = createDb(shared.appUrl, { max: 1 });
    const raceSecret = "sessionpin-browser-race-secret";
    const raceSubject = "configured:sessionpin-browser-race";
    const barrierClass = 81326028;
    const removalLock = 1;
    const triggerFunction = "sessionpin_browser_removal_first_barrier";
    const triggerName = "sessionpin_browser_removal_first_membership_barrier";
    let removalPromise: Promise<boolean> | null = null;
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const [workspace] = await shared.admin<{ accountId: string }[]>`
        select account_id as "accountId" from workspaces where id = ${workspaceId}`;
      expect(workspace?.accountId).toBeTruthy();
      await grantWorkspaceAccess(dbClient.db, {
        accountId: workspace!.accountId,
        workspaceId,
        subjectId: raceSubject,
        permissions: ["sessions:read"] satisfies Permission[],
      });
      await createSessionThroughApi(page, apiBaseUrl, workspaceId, "API race first");
      await createSessionThroughApi(page, apiBaseUrl, workspaceId, "API race second");

      const raceApp = createApp({
        settings: testSettings({
          databaseUrl: shared.appUrl,
          productAccessMode: "configured",
          delegationSecret: raceSecret,
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient,
      });
      const token = await signDelegatedAccessToken(raceSecret, {
        accountId: workspace!.accountId,
        workspaceId,
        subjectId: raceSubject,
        permissions: ["sessions:read"],
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${barrierClass}, ${removalLock});
          return old;
        end
        $$;
        create trigger ${triggerName}
          before delete on workspace_memberships
          for each row when (
            old.workspace_id = '${workspaceId}'::uuid
            and old.subject_id = '${raceSubject}'
          ) execute function ${triggerFunction}();
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${removalLock})`;

      removalPromise = (async () => {
        const removerSubjectId = `user:remover-${crypto.randomUUID()}`;
        await grantWorkspaceAccess(removalClient.db, {
          accountId: workspace!.accountId,
          workspaceId,
          subjectId: removerSubjectId,
          permissions: ["workspace:admin"],
        });
        return await removeWorkspaceMember(removalClient.db, {
          accountId: workspace!.accountId,
          workspaceId,
          actorSubjectId: removerSubjectId,
          targetSubjectId: raceSubject,
        });
      })();
      await waitForAdvisoryWait(barrier, barrierClass, removalLock);

      const listingPromise = raceApp.request(
        `/v1/workspaces/${workspaceId}/sessions?view=page&limit=1`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      await waitForDatabaseQueryWait(barrier, "pg_advisory_xact_lock_shared");
      await barrier`select pg_advisory_unlock(${barrierClass}, ${removalLock})`;
      expect(await removalPromise).toBe(true);

      // The delegated token carries its own workspace grant — losing the
      // membership row must not revoke listing (that same over-reach 403'd
      // every workspace-scoped api_key principal in production). Membership
      // is personalization for non-user subjects, not authorization: removal
      // cleans their pins, while the post-removal keyset creates no durable
      // per-subject listing state.
      const response = await listingPromise;
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        pinned: unknown[];
        sessions: { id: string }[];
      };
      expect(body.pinned).toEqual([]);
      expect(body.sessions.length).toBe(1);

      const [counts] = await shared.admin<{ pins: number; unboundedSnapshots: number }[]>`
        select
          (select count(*)::int from session_pins
            where workspace_id = ${workspaceId} and subject_id = ${raceSubject}) as pins,
          (select count(*)::int from session_list_snapshots
            where workspace_id = ${workspaceId}
              and subject_id = ${raceSubject}
              and expires_at > now() + interval '11 minutes') as "unboundedSnapshots"`;
      expect(counts).toEqual({ pins: 0, unboundedSnapshots: 0 });
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${triggerName} on workspace_memberships;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([removalPromise].filter(Boolean));
      await removalClient.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 60_000);

  test("returns authenticated 403 when removal wins a concurrent pin mutation", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    const barrier = postgres(shared.adminUrl, { max: 1 });
    const removalClient = createDb(shared.appUrl, { max: 1 });
    const raceSecret = "sessionpin-browser-pin-race-secret";
    const raceSubject = "configured:sessionpin-browser-pin-race";
    const barrierClass = 81326031;
    const removalLock = 1;
    const triggerFunction = "sessionpin_browser_pin_removal_first_barrier";
    const triggerName = "sessionpin_browser_pin_removal_first_membership_barrier";
    let removalPromise: Promise<boolean> | null = null;
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const [workspace] = await shared.admin<{ accountId: string }[]>`
        select account_id as "accountId" from workspaces where id = ${workspaceId}`;
      expect(workspace?.accountId).toBeTruthy();
      await grantWorkspaceAccess(dbClient.db, {
        accountId: workspace!.accountId,
        workspaceId,
        subjectId: raceSubject,
        permissions: ["sessions:read"] satisfies Permission[],
      });
      const target = await createSessionThroughApi(page, apiBaseUrl, workspaceId, "API pin race");

      const raceApp = createApp({
        settings: testSettings({
          databaseUrl: shared.appUrl,
          productAccessMode: "configured",
          delegationSecret: raceSecret,
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient,
      });
      const token = await signDelegatedAccessToken(raceSecret, {
        accountId: workspace!.accountId,
        workspaceId,
        subjectId: raceSubject,
        permissions: ["sessions:read"],
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${barrierClass}, ${removalLock});
          return old;
        end
        $$;
        create trigger ${triggerName}
          before delete on workspace_memberships
          for each row when (
            old.workspace_id = '${workspaceId}'::uuid
            and old.subject_id = '${raceSubject}'
          ) execute function ${triggerFunction}();
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${removalLock})`;

      removalPromise = (async () => {
        const removerSubjectId = `user:remover-${crypto.randomUUID()}`;
        await grantWorkspaceAccess(removalClient.db, {
          accountId: workspace!.accountId,
          workspaceId,
          subjectId: removerSubjectId,
          permissions: ["workspace:admin"],
        });
        return await removeWorkspaceMember(removalClient.db, {
          accountId: workspace!.accountId,
          workspaceId,
          actorSubjectId: removerSubjectId,
          targetSubjectId: raceSubject,
        });
      })();
      await waitForAdvisoryWait(barrier, barrierClass, removalLock);

      const pinPromise = raceApp.request(
        `/v1/workspaces/${workspaceId}/sessions/${target.id}/pin`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ pinned: true, expectedVersion: 0 }),
        },
      );
      await waitForDatabaseQueryWait(barrier, "pg_advisory_xact_lock");
      await barrier`select pg_advisory_unlock(${barrierClass}, ${removalLock})`;
      expect(await removalPromise).toBe(true);

      const response = await pinPromise;
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("workspace access denied");

      const [counts] = await shared.admin<{ memberships: number; pins: number; orphans: number }[]>`
        select
          (select count(*)::int from workspace_memberships
            where workspace_id = ${workspaceId} and subject_id = ${raceSubject}) as memberships,
          (select count(*)::int from session_pins
            where workspace_id = ${workspaceId} and subject_id = ${raceSubject}) as pins,
          (select count(*)::int
            from session_pins pin
            left join workspace_memberships membership
              on membership.workspace_id = pin.workspace_id
             and membership.subject_id = pin.subject_id
            where pin.workspace_id = ${workspaceId}
              and membership.id is null) as orphans`;
      expect(counts).toEqual({ memberships: 0, pins: 0, orphans: 0 });
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${triggerName} on workspace_memberships;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([removalPromise].filter(Boolean));
      await removalClient.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 60_000);
  test("discovers older active roots and active descendants through explicit Active pagination", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    let workspaceId = "";
    const activatedIds: string[] = [];
    try {
      await page.goto(webBaseUrl);
      workspaceId = await workspaceFromPage(page);
      const bootstrap = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        "Active discovery bootstrap",
      );
      await appendSessionEventsAndUpdateSession(
        dbClient.db,
        workspaceId,
        bootstrap.id,
        [{ type: "agent.updated", payload: { source: "active pagination fixture settled" } }],
        { status: "idle" },
      );
      const seed = async (title: string, parentSessionId?: string) => {
        const seeded = await createTitledSession(dbClient.db, {
          accountId: bootstrap.accountId,
          workspaceId,
          initialMessage: title,
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          ...(parentSessionId ? { parentSessionId } : {}),
          createdBy: { kind: "subject", subjectId: "sessionpin-owner" },
        });
        await appendSessionEventsAndUpdateSession(
          dbClient.db,
          workspaceId,
          seeded.id,
          [{ type: "agent.updated", payload: { source: "active pagination fixture settled" } }],
          { status: "idle" },
        );
        return seeded;
      };
      const activeRoot = await seed("Older active root");
      const ancestor = await seed("Older root with active child");
      const activeChild = await seed("Older active child", ancestor.id);
      for (const session of [activeRoot, activeChild]) {
        await appendSessionEventsAndUpdateSession(
          dbClient.db,
          workspaceId,
          session.id,
          [{ type: "agent.updated", payload: { source: "active pagination fixture" } }],
          { status: "running" },
        );
        activatedIds.push(session.id);
      }
      for (let index = 0; index < 60; index += 1) await seed(`Newer idle root ${index}`);
      const discoveryPage = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          successfulSessionPageResponse(response, workspaceId) &&
          url.searchParams.get("limit") === "50" &&
          url.searchParams.get("parentSessionId") === "null" &&
          !url.searchParams.has("archivedOnly")
        );
      });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const discovery = (await (await discoveryPage).json()) as BrowserSessionPage;
      expect(
        discovery.sessions.some((row) => row.id === activeRoot.id || row.id === ancestor.id),
      ).toBe(false);
      expect(discovery.nextCursor).toBeTruthy();
      await page.getByRole("button", { name: "Session filters", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Creator", exact: true }).click();
      const activeGroup = page.getByRole("group", { name: "Active", exact: true });
      const discoverOlder = activeGroup.getByRole("button", {
        name: "Load older sessions in Active",
        exact: true,
      });
      await discoverOlder.waitFor();
      expect(await activeGroup.locator("a[data-session-row]").count()).toBe(0);
      await discoverOlder.click();
      await activeGroup.locator(`a[data-session-row="${activeRoot.id}"]`).waitFor();
      await activeGroup.locator(`a[data-session-row="${ancestor.id}"]`).waitFor();
      // Other scenarios in this shared workspace can also leave active roots.
      expect(await activeGroup.locator("a[data-session-row]").count()).toBeGreaterThanOrEqual(2);
    } finally {
      for (const sessionId of activatedIds) {
        await appendSessionEventsAndUpdateSession(
          dbClient.db,
          workspaceId,
          sessionId,
          [{ type: "agent.updated", payload: { source: "active pagination fixture cleanup" } }],
          { status: "idle" },
        );
      }
      await context.close();
    }
  }, 90_000);
});

type BrowserSession = {
  id: string;
  accountId: string;
  pinned: boolean;
  pinVersion: number;
};
type BrowserChannel = {
  id: string;
  accountId: string;
  name: string;
};
type BrowserSessionPage = {
  pinned: BrowserSession[];
  sessions: BrowserSession[];
  nextCursor: string | null;
};

function sessionPageResponse(
  response: PlaywrightResponse,
  workspaceId: string,
  filters: { search?: string; cursor?: string | null } = {},
): boolean {
  const url = new URL(response.url());
  if (
    response.request().method() !== "GET" ||
    url.pathname !== `/v1/workspaces/${workspaceId}/sessions` ||
    url.searchParams.get("view") !== "page"
  ) {
    return false;
  }
  if (filters.search !== undefined && url.searchParams.get("search") !== filters.search) {
    return false;
  }
  if (
    filters.cursor !== undefined &&
    (filters.cursor === null
      ? url.searchParams.has("cursor")
      : url.searchParams.get("cursor") !== filters.cursor)
  ) {
    return false;
  }
  return true;
}

function successfulSessionPageResponse(
  response: PlaywrightResponse,
  workspaceId: string,
  filters: { search?: string; cursor?: string | null } = {},
): boolean {
  return response.ok() && sessionPageResponse(response, workspaceId, filters);
}

const browserDiagnostics = new WeakMap<BrowserContext, string[]>();
const browserPageErrors = new WeakMap<BrowserContext, string[]>();

async function configuredContext(
  browser: Browser,
  options: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  const diagnostics: string[] = [];
  const pageErrors: string[] = [];
  browserDiagnostics.set(context, diagnostics);
  browserPageErrors.set(context, pageErrors);
  context.on("requestfailed", (request) => {
    diagnostics.push(
      `request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
    );
  });
  context.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.push(
        `response ${response.status()}: ${response.request().method()} ${response.url()}`,
      );
    }
  });
  context.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  context.on("page", (page) => {
    page.on("pageerror", (error) => pageErrors.push(String(error)));
  });
  await context.addInitScript(() => {
    const windowWithReactProbe = window as Window & {
      __opengeniReactCommitCount?: number;
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
        supportsFiber?: boolean;
        inject?: (renderer: unknown) => number;
        onCommitFiberRoot?: (...args: unknown[]) => void;
        onCommitFiberUnmount?: (...args: unknown[]) => void;
      };
    };
    windowWithReactProbe.__opengeniReactCommitCount = 0;
    const hook = windowWithReactProbe.__REACT_DEVTOOLS_GLOBAL_HOOK__ ?? {};
    hook.supportsFiber = true;
    hook.inject ??= () => 1;
    hook.onCommitFiberRoot = () => {
      windowWithReactProbe.__opengeniReactCommitCount =
        (windowWithReactProbe.__opengeniReactCommitCount ?? 0) + 1;
    };
    hook.onCommitFiberUnmount ??= () => undefined;
    windowWithReactProbe.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  });
  // The console's configured-token panel stores the supplied value under this
  // key. In this test-only configured deployment there is intentionally no
  // delegation secret, so the API uses its supported x-opengeni-subject
  // principal fallback; the placeholder merely satisfies the real console
  // gate and is never treated as a credential or persisted outside context.
  await context.addInitScript(() => {
    // Playwright runs init scripts for the initial opaque about:blank document
    // too. That document has no storage origin; avoid turning this test-owned
    // setup into a pageerror that obscures application failures.
    if (window.location.origin === "null") {
      return;
    }
    localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
  });
  return context;
}

async function reactCommitCount(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      (window as Window & { __opengeniReactCommitCount?: number }).__opengeniReactCommitCount ?? 0,
  );
}

async function workspaceFromPage(page: Page): Promise<string> {
  try {
    await waitFor(() => /\/workspaces\/[^/]+\/sessions/.test(page.url()), {
      timeoutMs: 15_000,
    });
  } catch (error) {
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "<body unavailable>");
    throw new Error(
      `Workspace route did not load at ${page.url()}: ${String(error)}\n${body.slice(0, 2_000)}\n${(browserDiagnostics.get(page.context()) ?? []).slice(-20).join("\n")}`,
      { cause: error },
    );
  }
  return page.url().match(/\/workspaces\/([^/]+)\/sessions/)![1]!;
}

async function createSessionThroughApi(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  initialMessage: string,
  options: {
    channelId?: string;
    goal?: {
      text: string;
      successCriteria?: string;
    };
  } = {},
): Promise<BrowserSession> {
  return await page.evaluate(
    async ({
      apiBaseUrl: browserApiBaseUrl,
      workspaceId: targetWorkspaceId,
      initialMessage: sessionMessage,
      options: sessionOptions,
    }) => {
      const response = await fetch(
        `${browserApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            initialMessage: sessionMessage,
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
            ...sessionOptions,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`session create failed: ${response.status} ${await response.text()}`);
      }
      const created = (await response.json()) as BrowserSession;
      // Session-pin acceptance needs stable, human-readable fixture identities.
      // Set those identities through the public manual-rename path instead of
      // relying on the first prompt to become a display title.
      const renameResponse = await fetch(
        `${browserApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/sessions/${created.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: sessionMessage }),
        },
      );
      if (!renameResponse.ok) {
        throw new Error(
          `session rename failed: ${renameResponse.status} ${await renameResponse.text()}`,
        );
      }
      return (await renameResponse.json()) as BrowserSession;
    },
    { apiBaseUrl, workspaceId, initialMessage, options },
  );
}

async function createChannelThroughApi(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  name: string,
): Promise<BrowserChannel> {
  return await page.evaluate(
    async ({
      apiBaseUrl: browserApiBaseUrl,
      workspaceId: targetWorkspaceId,
      name: projectName,
    }) => {
      const response = await fetch(
        `${browserApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/channels`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: projectName }),
        },
      );
      if (!response.ok) {
        throw new Error(`channel create failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as BrowserChannel;
    },
    { apiBaseUrl, workspaceId, name },
  );
}

async function createTitledSession(
  db: Parameters<typeof createSession>[0],
  input: Parameters<typeof createSession>[1],
): Promise<Awaited<ReturnType<typeof createSession>>> {
  const session = await createSession(db, input);
  const result = await updateSessionTitle(db, {
    workspaceId: input.workspaceId,
    sessionId: session.id,
    title: input.initialMessage,
    source: "user",
  });
  if (!result.updated || result.title !== input.initialMessage) {
    throw new Error(`failed to assign explicit fixture title to session ${session.id}`);
  }
  return {
    ...session,
    title: result.title,
    titleSource: "user",
  };
}

async function setSessionPinThroughApi(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  session: BrowserSession,
  pinned: boolean,
): Promise<BrowserSession> {
  return await page.evaluate(
    async ({
      apiBaseUrl: browserApiBaseUrl,
      workspaceId: targetWorkspaceId,
      session: targetSession,
      pinned: nextPinned,
    }) => {
      const response = await fetch(
        `${browserApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/sessions/${targetSession.id}/pin`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pinned: nextPinned,
            expectedVersion: targetSession.pinVersion ?? 0,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`session pin failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as BrowserSession;
    },
    { apiBaseUrl, workspaceId, session, pinned },
  );
}

async function submitQueuedComposerPrompt(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  sessionId: string,
  expectedText: string,
): Promise<void> {
  await waitForComposerDraftText(page, apiBaseUrl, workspaceId, sessionId, expectedText);
  const send = page.getByRole("button", { name: /Send message|Add message to queue/ });
  await waitFor(async () => !(await send.isDisabled()), { timeoutMs: 10_000 });
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/composer-draft/submit"),
    { timeout: 15_000 },
  );
  await send.click();
  const response = await submitted;
  if (!response.ok()) {
    throw new Error(`composer submit failed: ${response.status()} ${await response.text()}`);
  }
}

async function waitForComposerDraftText(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  sessionId: string,
  expectedText: string,
): Promise<void> {
  // Let the 500 ms client debounce settle first. Clearing an unsaved local
  // draft is an idempotent no-op and correctly emits no PUT; if an earlier
  // autosave did start, poll until its serialized follow-up is authoritative.
  await page.waitForTimeout(600);
  await waitFor(
    async () => {
      if (await page.getByText("Saving draft…", { exact: true }).isVisible()) return false;
      return await page.evaluate(
        async ({
          apiBaseUrl: browserApiBaseUrl,
          workspaceId: targetWorkspaceId,
          sessionId: targetSessionId,
          expectedText: targetText,
        }) => {
          const response = await fetch(
            `${browserApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/sessions/${targetSessionId}/composer-draft`,
          );
          if (!response.ok) return false;
          const draft = (await response.json()) as { text?: unknown; revision?: unknown };
          return (
            draft.text === targetText &&
            typeof draft.revision === "number" &&
            (targetText === "" || draft.revision >= 1)
          );
        },
        { apiBaseUrl, workspaceId, sessionId, expectedText },
      );
    },
    { timeoutMs: 10_000 },
  );
}

async function listPageFromBrowser(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  options: { limit: number; cursor?: string; search?: string },
): Promise<BrowserSessionPage> {
  return await page.evaluate(
    async ({
      apiBaseUrl: browserApiBaseUrl,
      workspaceId: targetWorkspaceId,
      options: pageOptions,
    }) => {
      const query = new URLSearchParams({
        view: "page",
        limit: String(pageOptions.limit),
      });
      if (pageOptions.cursor) query.set("cursor", pageOptions.cursor);
      if (pageOptions.search) query.set("search", pageOptions.search);
      const response = await fetch(
        `${browserApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/sessions?${query.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`session page failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as BrowserSessionPage;
    },
    { apiBaseUrl, workspaceId, options },
  );
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        [...document.querySelectorAll("header")].every(
          (header) => header.scrollWidth <= header.clientWidth,
        ),
    ),
  ).toBe(true);
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (nextTheme) => {
    if (nextTheme === "light") {
      document.documentElement.setAttribute("data-og-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-og-theme");
    }
    // Theme tokens affect independently composited panels. Let the browser
    // start their CSS transitions, then wait for the session chrome transitions
    // themselves so neither Axe nor retained evidence sees mixed-theme colors.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const transitions = document.getAnimations().filter((animation) => {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      return (
        animation.constructor.name === "CSSTransition" &&
        target instanceof Element &&
        target.closest('[data-testid="session-chrome"]') !== null
      );
    });
    await Promise.all(
      transitions.map(async (transition) => await transition.finished.catch(() => undefined)),
    );
  }, theme);
}

async function expectRowPrompt(
  rows: ReturnType<Page["getByRole"]>,
  index: number,
  prompt: string,
): Promise<void> {
  try {
    await rows.nth(index).getByText(prompt, { exact: true }).waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `Queue row ${index + 1} did not contain ${JSON.stringify(prompt)}: ${String(error)}\n${(browserDiagnostics.get(rows.page().context()) ?? []).slice(-20).join("\n")}`,
      { cause: error },
    );
  }
}

async function expectTouchTarget(locator: ReturnType<Page["getByRole"]>): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

async function expectContainedInViewport(
  locator: ReturnType<Page["getByRole"]>,
  viewportWidth: number,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
}

async function expectNoAxeViolations(page: Page, includes: string[]): Promise<void> {
  let scan = new AxeBuilder({ page });
  for (const include of includes) scan = scan.include(include);
  const results = await scan.analyze();

  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary,
        checks: node.any.map((check) => ({ message: check.message, data: check.data })),
      })),
    })),
  ).toEqual([]);
}

async function waitForAdvisoryWait(
  connection: postgres.Sql,
  classId: number,
  objectId: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_locks
        where locktype = 'advisory'
          and classid = ${classId}
          and objid = ${objectId}
          and not granted
      ) as waiting`;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for advisory lock ${classId}/${objectId}`);
}

async function waitForDatabaseQueryWait(
  connection: postgres.Sql,
  queryFragment: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query like ${`%${queryFragment}%`}
      ) as waiting`;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for database query containing ${queryFragment}`);
}
