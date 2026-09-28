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
// Settings > General > Agent activity: "Running" with Pause, or "Paused" with Change and Resume.
const runtime = () => page.getByRole("region", { name: "Agent activity" });
const dialog = () => page.getByRole("dialog");
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
  context.on("page", (opened) => opened.on("pageerror", (error) => pageErrors.push(String(error))));
  page = await context.newPage();
  await page.goto(webUrl);
  await page.waitForURL(/\/workspaces\/[^/]+\/sessions/, { timeout: 60000 });
  workspaceId = page.url().match(/\/workspaces\/([^/]+)/)![1]!;
  await page.goto(`${webUrl}/workspaces/${workspaceId}/settings`);
  await runtime().waitFor();
  await mkdir(shots, { recursive: true });
}, 180000);
afterAll(async () => {
  await browser?.close();
  await web?.stop();
  await api?.stop(false);
  await db?.close();
  await shared?.release();
}, 60000);
async function capture(name: string, inDialog = false) {
  await page.screenshot({ path: `${shots}/${name}-full.png`, fullPage: false });
  await (inDialog ? dialog() : runtime()).screenshot({
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
  // A fresh page rather than page.reload(): repeated reloads of the unbundled
  // Vite app in one renderer can fail with net::ERR_INSUFFICIENT_RESOURCES.
  const previous = page;
  page = await previous.context().newPage();
  await previous.close();
  await page.goto(previous.url());
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
  await runtime()
    .getByText(timer.action === "pause" ? /Pausing…\.$/ : /Resuming…\.$/)
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

async function setTimer(timer: { pauseInSeconds: number; pauseForSeconds?: number | null }) {
  const control = (await getWorkspace(db.db, workspaceId))!.inferenceControl;
  const response = await post("pause-timer", {
    action: "set",
    ...timer,
    expectedRevision: control.revision,
    clientEventId: crypto.randomUUID(),
  });
  expect(response.status).toBe(200);
}
async function inferenceControl() {
  return (await getWorkspace(db.db, workspaceId))!.inferenceControl;
}
function localInput(at: number) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const choice = (name: string) => dialog().getByRole("radio", { name, exact: true });
const submit = () => dialog().locator('button[type="submit"]');

test("all timer states through the real settings UI and API", async () => {
  await runtime().getByText("Running", { exact: true }).waitFor();
  await capture("01-active");
  // A delayed pause with a resume (set through the API; the dialog only pauses
  // now) shows in the row, then fires and resumes on its own timer.
  await setTimer({ pauseInSeconds: 1800, pauseForSeconds: 7200 });
  await refresh();
  await runtime()
    .getByText(/Pauses in 30 min · for 2 hr/)
    .waitFor();
  await capture("04-delayed-finite");
  await dueAndFire();
  await refresh();
  await runtime().getByText("Paused", { exact: true }).waitFor();
  await runtime()
    .getByText(/Resumes in 2 hr/)
    .waitFor();
  await capture("05-paused-finite");
  // Change while paused: the scheduled resume is preselected as a picked time.
  await runtime().getByRole("button", { name: "Change", exact: true }).click();
  await dialog().getByRole("heading", { name: "Change pause" }).waitFor();
  expect(await choice("Pick a time").isChecked()).toBe(true);
  await capture("06-resume-editor", true);
  // "Until I resume" cancels the resume timer and keeps the workspace paused.
  await choice("Until I resume").click();
  await submit().click();
  await dialog().waitFor({ state: "hidden" });
  await runtime()
    .getByText("New sessions and scheduled runs wait until someone resumes.", { exact: true })
    .waitFor();
  expect(await inferenceControl()).toMatchObject({ state: "paused", timer: null });
  await capture("07-paused-indefinite");
  await runtime().getByRole("button", { name: "Resume", exact: true }).click();
  await runtime().getByRole("button", { name: "Pause", exact: true }).waitFor();
  expect((await inferenceControl()).state).toBe("active");
  // A delayed indefinite pause can be cancelled from the Pause dialog.
  await setTimer({ pauseInSeconds: 3600 });
  await refresh();
  await runtime()
    .getByText(/Pauses in 1 hr · until resumed/)
    .waitFor();
  await capture("08-delayed-indefinite");
  await runtime().getByRole("button", { name: "Pause", exact: true }).click();
  await dialog().getByRole("button", { name: "Cancel scheduled pause", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await runtime()
    .getByText("Agents can start new sessions and scheduled runs.", { exact: true })
    .waitFor();
  expect(await inferenceControl()).toMatchObject({ state: "active", timer: null });
  // The default editor, a picked time, and an invalid picked time.
  await runtime().getByRole("button", { name: "Pause", exact: true }).click();
  await dialog().getByRole("heading", { name: "Pause agent work" }).waitFor();
  expect(await choice("For 30 minutes").isChecked()).toBe(true);
  for (const name of ["For 1 hour", "Until I resume", "Pick a time"])
    expect(await choice(name).count()).toBe(1);
  expect(await choice("Until tomorrow morning").or(choice("Until this morning")).count()).toBe(1);
  await capture("02-default-editor", true);
  await choice("Pick a time").click();
  const resumeAt = dialog().getByLabel("Resume at", { exact: true });
  await resumeAt.fill(localInput(Date.now() + 90 * 60_000));
  await capture("09-custom-duration", true);
  await resumeAt.fill(localInput(Date.now() - 60 * 60_000));
  await submit().click();
  await dialog().getByText("Pick a time at least a minute from now.", { exact: true }).waitFor();
  expect(await dialog().isVisible()).toBe(true);
  expect((await inferenceControl()).state).toBe("active");
  await capture("10-invalid-duration", true);
  await resumeAt.fill(localInput(Date.now() + 90 * 60_000));
  const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(accessibility.violations).toEqual([]);
  await submit().click();
  await dialog().waitFor({ state: "hidden" });
  await runtime()
    .getByText(/Resumes in 1 hr (29|30) min/)
    .waitFor();
  expect((await inferenceControl()).timer).toMatchObject({ action: "resume" });
  await runtime().getByRole("button", { name: "Resume", exact: true }).click();
  await runtime().getByRole("button", { name: "Pause", exact: true }).waitFor();
  expect(await inferenceControl()).toMatchObject({ state: "active", timer: null });
  // Pause for a preset while the save is held, then exercise the actual
  // automatic resume transition.
  await runtime().getByRole("button", { name: "Pause", exact: true }).click();
  await choice("For 1 hour").click();
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
  await submit().click();
  await submit().filter({ hasText: "Pausing…" }).waitFor();
  await capture("14-saving", true);
  expect(await submit().getAttribute("aria-disabled")).toBe("true");
  releaseSave();
  await dialog().waitFor({ state: "hidden" });
  await runtime()
    .getByText(/Resumes in 1 hr/)
    .waitFor();
  expect((await inferenceControl()).state).toBe("paused");
  await dueAndFire();
  await refresh();
  expect((await inferenceControl()).state).toBe("active");
  await runtime().getByText("Running", { exact: true }).waitFor();
  await capture("11-resumed");
  // Another admin changes the workspace while the editor is open.
  await runtime().getByRole("button", { name: "Pause", exact: true }).click();
  await dialog().waitFor();
  await post("inference-control", { action: "pause", clientEventId: crypto.randomUUID() });
  await submit().click();
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "Someone changed agent activity just now" })
    .waitFor();
  await capture("15-stale-edit", true);
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  // Settings swap the rail (a drawer on phones), so General stays open.
  await runtime().getByRole("button", { name: "Change", exact: true }).click();
  await dialog().waitFor();
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
