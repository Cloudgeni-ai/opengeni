// An archived chat reads as Archived on every surface of the real app: the
// production web build against the real API and PostgreSQL, archived through
// the real Archive route and the step that stops its work at the end of the
// undo window. That step cancels the running turn, so the session's internal
// status becomes `cancelled`; a person must never read that word.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import { stopArchivedSessionWork } from "@opengeni/core";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { freePort } from "@opengeni/testing/compose";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { runCommand, startProcess, waitFor, type StartedProcess } from "@opengeni/testing/process";
import { testSettings } from "@opengeni/testing/settings";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const OWNER = "archived-chat-owner";
const ownerHeaders = { "x-opengeni-subject": OWNER };
const screenshotPhase =
  process.env.ARCHIVED_CHAT_SCREENSHOT_PHASE === "before" ? "before" : "after";
const screenshotDir = process.env.ARCHIVED_CHAT_SCREENSHOT_DIR ?? "/tmp";

type ScheduledArchive = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  subjectId: string;
  archivedAt: string;
};
const scheduledArchives: ScheduledArchive[] = [];

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
  scheduleSessionArchive: async (input: ScheduledArchive) => {
    scheduledArchives.push(input);
  },
} as SessionWorkflowClient;

const viewports = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
] as const;

describe("archived chat status in the production app", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let apiBaseUrl: string;
  let webBaseUrl: string;
  let bus: MemoryEventBus;
  let accountId: string;
  let workspaceId: string;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("archived-chat-status-browser");
    if (!acquired) {
      throw new Error("archived chat browser E2E requires real PostgreSQL; no skip is allowed");
    }
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    bus = new MemoryEventBus();
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "configured",
        delegationSecret: undefined,
      }),
      db: dbClient.db,
      bus,
      workflowClient,
    });
    api = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: app.fetch });
    apiBaseUrl = `http://127.0.0.1:${api.port}`;

    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    const webEnv = { NODE_ENV: "production", VITE_API_BASE_URL: apiBaseUrl };
    const build = await runCommand(["bun", "run", "build"], {
      cwd: `${repoRoot}/apps/web`,
      env: webEnv,
      timeoutMs: 180_000,
    });
    if (build.exitCode !== 0) {
      throw new Error(`Production web build failed:\n${build.stdout}\n${build.stderr}`);
    }
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
          (await fetch(webBaseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))
            ?.ok === true,
        timeoutMs: 45_000,
      },
    );
    // OPENGENI_TEST_CHROMIUM points at a system Chromium where Playwright's
    // own build can't load, as other browser tests allow.
    browser = await chromium.launch(
      process.env.OPENGENI_TEST_CHROMIUM
        ? { executablePath: process.env.OPENGENI_TEST_CHROMIUM, args: ["--no-sandbox"] }
        : {},
    );
    const bootstrap = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    try {
      const page = await bootstrap.newPage();
      await page.goto(webBaseUrl);
      await waitFor(() => /\/workspaces\/[^/]+\/sessions/.test(page.url()), { timeoutMs: 15_000 });
      workspaceId = page.url().match(/\/workspaces\/([^/]+)\/sessions/)![1]!;
      const [workspace] = await shared.admin<{ accountId: string }[]>`
        select account_id as "accountId" from workspaces where id = ${workspaceId}`;
      if (!workspace) throw new Error("bootstrapped workspace disappeared");
      accountId = workspace.accountId;
    } finally {
      await bootstrap.close();
    }
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
    await api?.stop(false);
    await dbClient?.close().catch(() => undefined);
    await shared?.release();
  }, 60_000);

  /** A chat whose first turn is running, as when someone archives a busy chat. */
  async function runningChat(initialMessage: string): Promise<string> {
    const session = await createSession(dbClient.db, {
      accountId,
      workspaceId,
      initialMessage,
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(dbClient.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const claimed = await claimSessionWorkForAttempt(dbClient.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("archived chat fixture turn not claimed");
    return session.id;
  }

  /** Archive through the real route, then run the step that ends the undo window. */
  async function archive(sessionId: string): Promise<void> {
    const response = await fetch(
      `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${sessionId}/archive`,
      {
        method: "PUT",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      },
    );
    if (!response.ok)
      throw new Error(`archive failed: ${response.status} ${await response.text()}`);
    const step = scheduledArchives.findLast((entry) => entry.sessionId === sessionId);
    if (!step) throw new Error("archive scheduled no stop step");
    await stopArchivedSessionWork(
      {
        db: dbClient.db,
        bus,
        workflowClient,
        schedulePromptPostCommit: (task: () => Promise<void>) => void task().catch(() => undefined),
      } as never,
      step,
    );
  }

  test("a chat archived while it ran reads Archived, never cancelled, at desktop and phone widths", async () => {
    const sessionId = await runningChat("Draft the release notes for the November update");
    await archive(sessionId);
    const [row] = await shared.admin<{ status: string }[]>`
      select status from sessions where id = ${sessionId}`;
    // The internal status the archive leaves behind; the app must not show it.
    expect(row?.status).toBe("cancelled");

    const contexts: BrowserContext[] = [];
    try {
      // Render (and capture) every width first, so a failure still leaves each screenshot.
      const pages: Page[] = [];
      for (const { name, ...options } of viewports) {
        const context = await configuredContext(browser, {
          ...options,
          extraHTTPHeaders: ownerHeaders,
        });
        contexts.push(context);
        const page = await context.newPage();
        pages.push(page);
        await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${sessionId}`);
        await page.getByText("Draft the release notes for the November update").first().waitFor();
        // The read-only notice above the conversation (before this fix it said "cancelled").
        await page
          .getByText(/^(This chat is archived|This session was cancelled.*)$/)
          .first()
          .waitFor();
        await settle(page);
        await page.screenshot({
          path: `${screenshotDir}/archived-chat-${screenshotPhase}-${name}.png`,
        });
      }
      for (const [index, page] of pages.entries()) {
        expect(await visibleText(page)).not.toMatch(/cancel/i);
        await page.getByText("This chat is archived", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Continue in a new chat" }).waitFor();
        const header = page.locator("header");
        const status = header.locator('[data-status="archived"]:visible').first();
        expect(await status.innerText()).toMatch(/^(Archived)?$/);
        expect(
          await header
            .locator("[data-status]")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-status"))),
        ).not.toContain("cancelled");
        expect(await header.innerText()).not.toMatch(/paused|waiting/i);
        const composer = page.locator("textarea").first();
        if (await composer.count()) {
          expect(await composer.getAttribute("placeholder")).toBe("This chat is archived.");
        }
        expect(pageErrors.get(contexts[index]!) ?? []).toEqual([]);
      }
    } finally {
      await Promise.allSettled(contexts.map((context) => context.close()));
    }
  }, 120_000);

  test("an idle chat that was archived reads Archived, not Idle", async () => {
    const session = await createSession(dbClient.db, {
      accountId,
      workspaceId,
      initialMessage: "Summarize last week's support tickets",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await archive(session.id);
    const context = await configuredContext(browser, {
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: ownerHeaders,
    });
    try {
      const page = await context.newPage();
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${session.id}`);
      await page.getByText("This chat is archived", { exact: true }).waitFor();
      await settle(page);
      const header = page.locator("header");
      await header.locator('[data-status="archived"]:visible').first().waitFor();
      expect(await header.innerText()).not.toMatch(/idle|cancel|paused/i);
      expect(await visibleText(page)).not.toMatch(/cancel/i);
    } finally {
      await context.close();
    }
  }, 60_000);
});

const pageErrors = new WeakMap<BrowserContext, string[]>();

async function configuredContext(
  browser: Browser,
  options: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  const errors: string[] = [];
  pageErrors.set(context, errors);
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(String(error))));
  await context.addInitScript(() => {
    if (window.location.origin !== "null") {
      localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
    }
  });
  return context;
}

/** Everything a person can read on the page, including accessible names of controls. */
async function visibleText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const labels = [...document.querySelectorAll("[aria-label], [title], [placeholder]")]
      .filter((node) => (node as HTMLElement).offsetParent !== null)
      .map((node) =>
        ["aria-label", "title", "placeholder"]
          .map((name) => node.getAttribute(name) ?? "")
          .join(" "),
      );
    return `${document.body.innerText}\n${labels.join("\n")}`;
  });
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    async () =>
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.waitForTimeout(400);
}
