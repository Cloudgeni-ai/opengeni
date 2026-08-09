import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import {
  createDb,
  createEnrollment,
  createSandbox,
  grantWorkspaceAccess,
  type DbClient,
} from "@opengeni/db";
import {
  MemoryEventBus,
  acquireSharedTestDatabase,
  freePort,
  runCommand,
  startProcess,
  testSettings,
  type SharedTestDatabase,
  type StartedProcess,
} from "@opengeni/testing";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import postgres from "postgres";

const repoRoot = new URL("../..", import.meta.url).pathname;
const localAdminUrl = process.env.OPENGENI_CONNECTED_MACHINE_BROWSER_ADMIN_URL?.trim();
const localAppUrl = process.env.OPENGENI_CONNECTED_MACHINE_BROWSER_APP_URL?.trim();
const subjectId = "connected-machine-removal-browser-owner";

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

describe("connected machine removal browser e2e", () => {
  let shared: SharedTestDatabase | null = null;
  let admin: postgres.Sql;
  let dbClient: DbClient;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let webBaseUrl: string;

  async function workspaceAccount(workspaceId: string): Promise<string> {
    const [row] = await admin<{ accountId: string }[]>`
      select account_id as "accountId" from workspaces where id = ${workspaceId}`;
    if (!row) throw new Error(`workspace ${workspaceId} was not found`);
    return row.accountId;
  }

  async function seedMachine(
    workspaceId: string,
    name: string,
    publicKeySuffix: string,
  ): Promise<{ enrollmentId: string; sandboxId: string }> {
    const accountId = await workspaceAccount(workspaceId);
    const enrollment = await createEnrollment(dbClient.db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:browser-removal-${publicKeySuffix}-${crypto.randomUUID()}`,
      os: "macos",
      arch: "arm64",
    });
    const sandbox = await createSandbox(dbClient.db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name,
      enrollmentId: enrollment.id,
    });
    await admin`
      update enrollments
      set last_seen_at = ${new Date("2026-08-04T09:13:46.102Z")}, updated_at = now()
      where id = ${enrollment.id}`;
    return { enrollmentId: enrollment.id, sandboxId: sandbox.id };
  }

  async function configuredContext(options: {
    viewport: { width: number; height: number };
    isMobile?: boolean;
    hasTouch?: boolean;
  }): Promise<BrowserContext> {
    const context = await browser.newContext({
      ...options,
      extraHTTPHeaders: { "x-opengeni-subject": subjectId },
    });
    await context.addInitScript(() => {
      if (window.location.origin !== "null") {
        localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
      }
    });
    return context;
  }

  async function workspaceFromPage(page: Page): Promise<string> {
    await page.waitForURL(/\/workspaces\/[^/]+\/sessions/, { timeout: 15_000 });
    return page.url().match(/\/workspaces\/([^/]+)\/sessions/)![1]!;
  }

  beforeAll(async () => {
    if (localAdminUrl && localAppUrl) {
      admin = postgres(localAdminUrl, { max: 2, prepare: false });
      dbClient = createDb(localAppUrl, { max: 4 });
    } else {
      shared = await acquireSharedTestDatabase("connected-machine-removal-browser");
      if (!shared) throw new Error("connected-machine browser E2E requires PostgreSQL");
      admin = shared.admin;
      dbClient = createDb(shared.appUrl);
    }

    const app = createApp({
      settings: testSettings({
        databaseUrl: localAppUrl ?? shared!.appUrl,
        productAccessMode: "configured",
        delegationSecret: undefined,
        sandboxSelfhostedEnabled: true,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    api = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: app.fetch });
    const apiBaseUrl = `http://127.0.0.1:${api.port}`;
    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    const webEnv = { NODE_ENV: "production", VITE_API_BASE_URL: apiBaseUrl };
    const build = await runCommand(["bun", "run", "build"], {
      cwd: `${repoRoot}/apps/web`,
      env: webEnv,
      timeoutMs: 120_000,
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
    browser = await chromium.launch();
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
    await api?.stop(false);
    await dbClient?.close().catch(() => undefined);
    if (localAdminUrl) await admin?.end().catch(() => undefined);
    await shared?.release();
  }, 60_000);

  test("desktop keyboard removal confirms exact details and reconciles the active list", async () => {
    const context = await configuredContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      await grantWorkspaceAccess(dbClient.db, {
        accountId: await workspaceAccount(workspaceId),
        workspaceId,
        subjectId,
        permissions: ["enrollments:read", "enrollments:manage"],
      });
      const machine = await seedMachine(workspaceId, "Jrgens-MacBook-Pro-2.local", "desktop");
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/machines`);
      const card = page.locator(`[data-machine-card="${machine.sandboxId}"]`);
      await card.waitFor({ timeout: 15_000 });
      await card.focus();
      await page.keyboard.press("Enter");
      const remove = page.getByRole("button", {
        name: "Remove machine Jrgens-MacBook-Pro-2.local",
      });
      await remove.waitFor();
      await remove.focus();
      expect(await remove.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.screenshot({
        path: "artifacts/connected-machine-removal/desktop-detail.png",
        fullPage: true,
      });
      await page.keyboard.press("Enter");

      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain("Jrgens-MacBook-Pro-2.local");
      expect(await dialog.textContent()).toContain("Last seen");
      expect(await dialog.textContent()).toContain(
        "Access will be revoked immediately while the machine is offline",
      );
      await page.screenshot({
        path: "artifacts/connected-machine-removal/desktop-confirm.png",
        fullPage: true,
      });
      const confirm = dialog.getByRole("button", { name: "Remove machine", exact: true });
      await confirm.focus();
      expect(await confirm.evaluate((element) => element === document.activeElement)).toBe(true);
      await confirm.press("Enter");
      await card.waitFor({ state: "detached", timeout: 15_000 });
    } finally {
      await context.close();
    }
  }, 90_000);

  test("narrow mobile confirmation keeps the destructive action reachable and cancellable", async () => {
    const context = await configuredContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      await grantWorkspaceAccess(dbClient.db, {
        accountId: await workspaceAccount(workspaceId),
        workspaceId,
        subjectId,
        permissions: ["enrollments:read", "enrollments:manage"],
      });
      const machine = await seedMachine(workspaceId, "Jrgens-MacBook-Pro-2.local", "mobile");
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/machines`);
      const card = page.locator(`[data-machine-card="${machine.sandboxId}"]`);
      await card.waitFor({ timeout: 15_000 });
      await card.tap();
      const remove = page.getByRole("button", {
        name: "Remove machine Jrgens-MacBook-Pro-2.local",
      });
      await remove.waitFor();
      expect(await remove.getAttribute("data-remove-machine")).toBe("true");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await remove.tap();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain("Jrgens-MacBook-Pro-2.local");
      await page.screenshot({
        path: "artifacts/connected-machine-removal/mobile-confirm.png",
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
      await dialog.waitFor({ state: "hidden" });
      await remove.waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  }, 90_000);
});
