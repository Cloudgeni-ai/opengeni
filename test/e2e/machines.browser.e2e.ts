import AxeBuilder from "@axe-core/playwright";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import { createDb, createEnrollment, createSandbox } from "@opengeni/db";
import { subjectFor } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  freePort,
  MemoryEventBus,
  startProcess,
  testSettings,
  waitFor,
  type SharedTestDatabase,
  type StartedProcess,
} from "@opengeni/testing";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";

import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";

const repoRoot = new URL("../..", import.meta.url).pathname;
const ownerHeaders = { "x-opengeni-subject": "machines-owner" };

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

describe("machines browser lifecycle (real API + disposable PostgreSQL)", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let bus: MemoryEventBus;
  let apiBaseUrl: string;
  let webBaseUrl: string;
  const stopResponders: Array<() => void> = [];

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("machines-browser");
    if (!acquired) {
      throw new Error("machines browser E2E requires real PostgreSQL; no skip is allowed");
    }
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    bus = new MemoryEventBus();
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "configured",
        delegationSecret: undefined,
        sandboxSelfhostedEnabled: true,
        selfhostedRelayUrl: "wss://relay.example.test",
      }),
      db: dbClient.db,
      bus,
      workflowClient,
    });
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch: app.fetch,
    });
    apiBaseUrl = `http://127.0.0.1:${api.port}`;

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
        env: { VITE_API_BASE_URL: apiBaseUrl },
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
    for (const stop of stopResponders.splice(0)) stop();
    await browser?.close().catch(() => undefined);
    await web?.stop().catch(() => undefined);
    api?.stop(true);
    await dbClient?.close().catch(() => undefined);
    await shared?.release();
  }, 60_000);

  test("mobile unenroll is permission-gated, accessible, retry-safe, and truthful on failure", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    await page.goto(webBaseUrl);
    const workspaceId = await workspaceFromPage(page);

    const successMachine = await seedMachine(workspaceId, "Mobile canary", "macos");
    await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/machines`);
    await openMachine(page, successMachine.sandboxId);

    const action = page.getByRole("button", { name: "Unenroll", exact: true });
    await action.waitFor();
    await action.focus();
    expect(await action.evaluate((element) => element === document.activeElement)).toBe(true);
    await expectNoAxeViolations(page, ["[data-revoke-machine]"]);
    await expectNoHorizontalOverflow(page);

    // Cancellation proves dialog semantics, focus containment, and focus return
    // before the irreversible API path is exercised.
    await action.click();
    const dialog = page.getByRole("dialog", { name: /Unenroll machine.*Mobile canary/ });
    await dialog.waitFor();
    await dialog
      .getByText(
        "Its credential stops working immediately and sessions can no longer attach to it. Run opengeni-agent enroll --force on the machine to enroll it again.",
        { exact: true },
      )
      .waitFor();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expectNoAxeViolations(page, ['[role="dialog"]']);
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await action.evaluate((element) => element === document.activeElement)).toBe(true);

    // The second confirmation traverses the real SDK + API + RLS DAO path. The
    // refreshed fleet must remove the revoked enrollment instead of treating a
    // successful HTTP response as only an optimistic UI update.
    await action.click();
    await dialog.getByRole("button", { name: "Unenroll machine" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("No machines yet", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByText("Machine unenrolled", { exact: true }).waitFor();
    expect(await enrollmentStatus(successMachine.enrollmentId)).toBe("revoked");
    await expectNoHorizontalOverflow(page);

    // Seed a second disposable machine, then intercept only its POST response.
    // A failed request must retain both the server row and the open confirmation,
    // so the UX cannot imply success after an ambiguous provider failure.
    const failedMachine = await seedMachine(workspaceId, "Failure canary", "linux");
    await page.reload();
    await openMachine(page, failedMachine.sandboxId);
    const failedAction = page.getByRole("button", { name: "Unenroll", exact: true });
    const revokeUrl = `${apiBaseUrl}/v1/workspaces/${workspaceId}/enrollments/${failedMachine.enrollmentId}/revoke`;
    await page.route(revokeUrl, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "access-control-allow-origin": webBaseUrl },
        body: JSON.stringify({ error: "disposable failure canary" }),
      });
    });
    await failedAction.click();
    const failedDialog = page.getByRole("dialog", {
      name: /Unenroll machine.*Failure canary/,
    });
    await failedDialog.getByRole("button", { name: "Unenroll machine" }).click();
    await page.getByText("Could not unenroll the machine", { exact: true }).waitFor();
    expect(await failedDialog.isVisible()).toBe(true);
    expect(await enrollmentStatus(failedMachine.enrollmentId)).toBe("active");
    await expectNoAxeViolations(page, ['[role="dialog"]']);
    await expectNoHorizontalOverflow(page);
    await page.unroute(revokeUrl);
    await failedDialog.getByRole("button", { name: "Cancel" }).click();
    await context.close();
  }, 120_000);

  async function seedMachine(
    workspaceId: string,
    name: string,
    os: "linux" | "macos",
  ): Promise<{ enrollmentId: string; sandboxId: string }> {
    const [workspace] = await shared.admin<{ accountId: string }[]>`
      select account_id as "accountId" from workspaces where id = ${workspaceId}`;
    if (!workspace) throw new Error(`workspace ${workspaceId} was not bootstrapped`);
    const enrollment = await createEnrollment(dbClient.db, {
      accountId: workspace.accountId,
      workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: true,
      os,
      arch: os === "macos" ? "aarch64" : "x86_64",
    });
    await shared.admin`update enrollments set last_seen_at = now() where id = ${enrollment.id}`;
    const sandbox = await createSandbox(dbClient.db, {
      accountId: workspace.accountId,
      workspaceId,
      kind: "selfhosted",
      name,
      enrollmentId: enrollment.id,
    });
    stopResponders.push(
      bus.subscribeRequests(subjectFor(workspaceId, enrollment.id), (payload) => {
        const request = ControlRequest.decode(payload);
        const response: ControlResponse =
          request.op?.$case === "ping"
            ? {
                requestId: request.requestId,
                result: {
                  $case: "ping",
                  ping: { nonce: request.op.ping.nonce, agentMonotonicMs: "0" },
                },
              }
            : {
                requestId: request.requestId,
                error: {
                  code: ErrorCode.ERROR_CODE_UNSUPPORTED,
                  message: "unsupported disposable canary operation",
                  retryable: false,
                  detail: {},
                },
              };
        return ControlResponse.encode(response).finish();
      }),
    );
    return { enrollmentId: enrollment.id, sandboxId: sandbox.id };
  }

  async function enrollmentStatus(enrollmentId: string): Promise<string | null> {
    const [row] = await shared.admin<{ status: string }[]>`
      select status from enrollments where id = ${enrollmentId}`;
    return row?.status ?? null;
  }
});

async function configuredContext(
  browser: Browser,
  options: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  // The configured deployment has no delegation secret, so the supported
  // x-opengeni-subject principal provides identity. This test-only placeholder
  // only satisfies the real web gate; it is not accepted as a credential.
  await context.addInitScript(() => {
    localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
  });
  return context;
}

async function workspaceFromPage(page: Page): Promise<string> {
  await waitFor(() => /\/workspaces\/[^/]+\/sessions/.test(page.url()), {
    timeoutMs: 15_000,
  });
  return page.url().match(/\/workspaces\/([^/]+)\/sessions/)![1]!;
}

async function openMachine(page: Page, sandboxId: string): Promise<void> {
  const card = page.locator(`[data-machine-card="${sandboxId}"]`);
  await card.waitFor({ timeout: 15_000 });
  await card.click();
  await page.getByRole("button", { name: "Back to machines" }).waitFor();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function expectNoAxeViolations(page: Page, includes: string[]): Promise<void> {
  let scan = new AxeBuilder({ page });
  for (const include of includes) scan = scan.include(include);
  const results = await scan.analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}
