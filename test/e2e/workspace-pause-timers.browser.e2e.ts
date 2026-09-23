import { createWorkflowWakeActivities } from "../../apps/worker/src/activities/workflow-wake";
import type { ControlActivityServices } from "../../apps/worker/src/activities/types";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { createDb, getWorkspace, withWorkspaceRls } from "@opengeni/db";
import { sql } from "drizzle-orm";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  freePort,
  startProcess,
  type SharedTestDatabase,
  type StartedProcess,
} from "@opengeni/testing";
const repoRoot = new URL("../..", import.meta.url).pathname;
const shots = process.env.OPENGENI_TIMER_SCREENSHOTS ?? "/tmp/opengeni-pause-timer-screenshots";
const workflowClient: SessionWorkflowClient = {
  signalUserMessage: async () => {},
  wakeSessionWorkflow: async () => {},
  requestSessionWorkflowWakeDispatch: async () => {},
  signalApprovalDecision: async () => {},
  signalSessionControl: async () => {},
  syncScheduledTask: async () => {},
  deleteScheduledTaskSchedule: async () => {},
  triggerScheduledTask: async () => {},
  startRigVerification: async () => {},
};
const bus = new MemoryEventBus();
let shared: SharedTestDatabase;
let db: ReturnType<typeof createDb>;
let api: ReturnType<typeof Bun.serve>;
let web: StartedProcess;
let browser: Browser;
let page: Page;
let apiUrl: string;
let webUrl: string;
let workspaceId: string;
const pageErrors: string[] = [];
beforeAll(async () => {
  shared = (await acquireSharedTestDatabase("pause-timers-browser"))!;
  if (!shared) throw new Error("PostgreSQL required");
  db = createDb(shared.appUrl);
  const apiPort = await freePort();
  const webPort = await freePort();
  apiUrl = `http://127.0.0.1:${apiPort}`;
  webUrl = `http://127.0.0.1:${webPort}`;
  const app = createApp({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "configured",
      delegationSecret: undefined,
    }),
    db: db.db,
    bus,
    workflowClient,
  });
  api = Bun.serve({ hostname: "127.0.0.1", port: apiPort, idleTimeout: 120, fetch: app.fetch });
  web = await startProcess(
    ["bun", "run", "vite", "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: `${repoRoot}/apps/web`,
      env: { VITE_API_BASE_URL: apiUrl },
      ready: async () => (await fetch(webUrl).catch(() => null))?.ok === true,
      timeoutMs: 60000,
    },
  );
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { "x-opengeni-subject": "timer-owner" },
  });
  await context.addInitScript(() => {
    if (location.origin !== "null")
      localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(webUrl);
  await page.waitForURL(/\/workspaces\/[^/]+\/sessions/, { timeout: 60000 });
  workspaceId = page.url().match(/\/workspaces\/([^/]+)/)![1]!;
  await page.goto(`${webUrl}/workspaces/${workspaceId}/settings`);
  await page.getByRole("region", { name: "Workspace runtime" }).waitFor();
  await mkdir(shots, { recursive: true });
}, 180000);
afterAll(async () => {
  await browser?.close();
  await web?.stop();
  await api?.stop(false);
  await db?.close();
  await shared?.release();
}, 60000);
const runtime = () => page.getByRole("region", { name: "Workspace runtime" });
async function capture(name: string, dialog = false) {
  await page.screenshot({ path: `${shots}/${name}-full.png`, fullPage: false });
  await (dialog ? page.getByRole("dialog") : runtime()).screenshot({
    path: `${shots}/${name}.png`,
  });
}
async function post(path: string, body: unknown, subject = "timer-owner") {
  return await fetch(`${apiUrl}/v1/workspaces/${workspaceId}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opengeni-subject": subject },
    body: JSON.stringify(body),
  });
}
async function refresh() {
  await page.reload();
  await runtime().waitFor();
}
async function dueAndFire() {
  const timer = (await getWorkspace(db.db, workspaceId))!.inferenceControl.timer!;
  await withWorkspaceRls(db.db, workspaceId, (scoped) =>
    scoped.execute(
      sql`update workspace_inference_controls set timer_due_at = clock_timestamp() - interval '1 second' where workspace_id = ${workspaceId}`,
    ),
  );
  await refresh();
  await page
    .getByText(timer.action === "pause" ? "Pausing…" : "Resuming…", { exact: true })
    .waitFor();
  await capture(timer.action === "pause" ? "12-pausing" : "13-resuming");
  const service = {
    db: db.db,
    bus,
    wakeSessionWorkflow: null,
    observability: { info() {}, warn() {}, incrementCounter() {}, observeHistogram() {} },
  } as unknown as ControlActivityServices;
  await createWorkflowWakeActivities(async () => service).dispatchSessionWorkflowWakes();
}

test("all timer states through the real settings UI and API", async () => {
  await capture("01-active");
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  await capture("02-default-editor", true);
  await page.getByLabel("Pause in", { exact: true }).selectOption("1800");
  await page.getByLabel("Pause for", { exact: true }).selectOption("7200");
  await capture("03-combined-editor", true);
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/pause-timer",
    async (route) => {
      await saveGate;
      await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Set timer", exact: true }).click();
  await capture("14-saving", true);
  expect(await page.getByRole("button", { name: "Set timer", exact: true }).isDisabled()).toBe(
    true,
  );
  releaseSave();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText(/Pauses in 30 min · for 2 hr/).waitFor();
  await capture("04-delayed-finite");
  await dueAndFire();
  await refresh();
  await page.getByText(/Resumes in 2 hr/).waitFor();
  await capture("05-paused-finite");
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  await capture("06-resume-editor", true);
  await page.getByRole("button", { name: "Cancel timer", exact: true }).click();
  await page.getByText("Paused until you resume", { exact: true }).waitFor();
  await capture("07-paused-indefinite");
  await page.getByRole("button", { name: "Resume workspace", exact: true }).click();
  await page.getByRole("button", { name: "Pause workspace", exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  await page.getByLabel("Pause in", { exact: true }).selectOption("3600");
  await page.getByRole("button", { name: "Set timer", exact: true }).click();
  await page.getByText(/Pauses in 1 hr · until resumed/).waitFor();
  await capture("08-delayed-indefinite");
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  await page.getByLabel("Pause for", { exact: true }).selectOption("custom");
  await page.getByLabel("Pause for amount", { exact: true }).fill("90");
  await capture("09-custom-duration", true);
  await page.getByLabel("Pause for amount", { exact: true }).fill("0");
  expect(await page.getByRole("button", { name: "Set timer", exact: true }).isDisabled()).toBe(
    true,
  );
  await capture("10-invalid-duration", true);
  await page.getByLabel("Pause for amount", { exact: true }).fill("90");
  const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  await page.getByRole("button", { name: "Cancel timer", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  // Pause now for 15 minutes, then exercise the actual automatic resume transition.
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  await page.getByLabel("Pause for", { exact: true }).selectOption("900");
  await page.getByRole("button", { name: "Pause now", exact: true }).click();
  await page.getByText(/Resumes in 15 min/).waitFor();
  await dueAndFire();
  await refresh();
  expect((await getWorkspace(db.db, workspaceId))!.inferenceControl.state).toBe("active");
  await capture("11-resumed");
  // Another admin changes the workspace while the editor is open.
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  await post("inference-control", { action: "pause", clientEventId: crypto.randomUUID() });
  await page.getByRole("button", { name: "Pause now", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Workspace changed" }).waitFor();
  await capture("15-stale-edit", true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  await capture("16-mobile-editor", true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(pageErrors).toEqual([]);
}, 120000);

test("API validates input, conflicts and paused-state errors", async () => {
  const control = (await getWorkspace(db.db, workspaceId))!.inferenceControl;
  const request = {
    action: "set",
    pauseInSeconds: 60,
    expectedRevision: control.revision,
    clientEventId: crypto.randomUUID(),
  };
  expect((await post("pause-timer", { ...request, pauseInSeconds: -1 })).status).toBe(400);
  expect((await post("pause-timer", { ...request, expectedRevision: 0 })).status).toBe(409);
  expect(
    (await post("inference-control", { action: "pause", clientEventId: crypto.randomUUID() }))
      .status,
  ).toBe(200);
  const paused = (await getWorkspace(db.db, workspaceId))!.inferenceControl;
  expect(
    (await post("pause-timer", { ...request, expectedRevision: paused.revision })).status,
  ).toBe(400);
});
