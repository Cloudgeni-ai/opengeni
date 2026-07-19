import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import {
  advanceAskUserReminder,
  appendBackgroundJobLog,
  applySessionTurnSettlement,
  attachBackgroundJobProvider,
  bootstrapWorkspace,
  claimBackgroundJobStart,
  claimSessionWorkForAttempt,
  createBackgroundJobAttempt,
  createBackgroundJobForTurn,
  createDb,
  createPassiveDurableWaitForTurn,
  createSession,
  getBackgroundJob,
  initializeSessionStartAtomically,
  insertBackgroundJobArtifact,
  listDurableWaits,
  markSessionWorkflowWakeDelivered,
  resolveAskUserWait,
  saveRunState,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
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
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const delegationSecret = "ope20-durable-browser-delegation-secret";

describe("durable waits browser acceptance (signed bearer + real PostgreSQL)", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let webBaseUrl: string;
  let bearer: string;
  let grant: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
  const approvalSignals: Array<Parameters<SessionWorkflowClient["signalApprovalDecision"]>[0]> = [];
  const signedArtifactKeys: string[] = [];

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("durable-waits-browser");
    if (!acquired) {
      throw new Error("OPE-20 browser acceptance requires real PostgreSQL; no skip is allowed");
    }
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "ope20-browser",
      accountExternalId: "account",
      accountName: "OPE-20 Browser",
      workspaceExternalSource: "ope20-browser",
      workspaceExternalId: "workspace",
      workspaceName: "OPE-20 Durable Waits",
      subjectId: "user:ope20-browser",
      subjectLabel: "OPE-20 browser operator",
    });
    grant = access.workspaceGrants[0]!;
    bearer = await signDelegatedAccessToken(delegationSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      permissions: grant.permissions,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });

    const workflowClient: SessionWorkflowClient = {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
      signalApprovalDecision: async (input) => {
        approvalSignals.push(input);
      },
      signalSessionControl: async () => undefined,
      syncScheduledTask: async () => undefined,
      deleteScheduledTaskSchedule: async () => undefined,
      triggerScheduledTask: async () => undefined,
      startRigVerification: async () => undefined,
    };
    const objectStorage: ObjectStorage = {
      bucket: "ope20-browser",
      backend: "s3-compatible",
      maxSinglePutSizeBytes: 5_000_000_000,
      createPutUrl: async () => {
        throw new Error("OPE-20 browser acceptance does not upload files");
      },
      createGetUrl: async ({ key }) => {
        signedArtifactKeys.push(key);
        return {
          url: `https://signed.example/${encodeURIComponent(key)}`,
          expiresAt: new Date(Date.now() + 5 * 60_000),
        };
      },
      headFile: async () => {
        throw new Error("OPE-20 browser acceptance does not inspect file assets");
      },
      getFileBytes: async () => {
        throw new Error("OPE-20 browser acceptance does not read file assets");
      },
      getObjectBytes: async () => null,
      putObject: async () => undefined,
      deleteObject: async () => undefined,
    };
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "configured",
        delegationSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
      objectStorage,
    });
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch: app.fetch,
    });

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
        env: { VITE_API_BASE_URL: `http://127.0.0.1:${api.port}` },
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
    await browser?.close().catch(() => undefined);
    await web?.stop().catch(() => undefined);
    api?.stop(true);
    await dbClient?.close().catch(() => undefined);
    await shared?.release();
  }, 60_000);

  test("answers, cancels, reminds, and times out through keyboard-accessible durable UI", async () => {
    const answer = await askFixture("answer", {
      requestKey: "browser-answer",
      title: "Release confirmation",
      description: "This answer resumes the saved run state.",
      questions: [
        {
          id: "confirmation",
          type: "text",
          prompt: "What should the release note say?",
          required: true,
          minLength: 3,
        },
      ],
      reminderIntervalSeconds: 60,
    });
    const reminded = await advanceAskUserReminder(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: answer.fixture.session.id,
      waitId: answer.wait.id,
      now: new Date(Date.now() + 61_000),
    });
    expect(reminded.action).toBe("reminded");

    const cancelled = await askFixture("cancel", {
      requestKey: "browser-cancel",
      title: "Optional deployment input",
      questions: [
        {
          id: "region",
          type: "single_select",
          prompt: "Choose a deployment region",
          required: true,
          options: [
            { value: "eu", label: "Europe" },
            { value: "us", label: "United States" },
          ],
        },
      ],
    });
    const timedOut = await askFixture("timeout", {
      requestKey: "browser-timeout",
      title: "Expired approval",
      questions: [
        {
          id: "reason",
          type: "text",
          prompt: "Why should this continue?",
          required: true,
        },
      ],
      timeoutAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(
      (
        await resolveAskUserWait(dbClient.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: timedOut.fixture.session.id,
          waitId: timedOut.wait.id,
          outcome: "timed_out",
          now: new Date(),
        })
      ).action,
    ).toBe("accepted");

    const context = await authenticatedContext({ width: 1440, height: 960 });
    const page = await context.newPage();
    await page.goto(sessionUrl(answer.fixture.session.id));
    await page.getByText("Reminder 1: this session is still waiting for your answer.").waitFor();
    await setTheme(page, "light");
    await expectNoAxeViolations(page);
    await page.screenshot({ path: "/tmp/ope20-durable-desktop-light.png", fullPage: true });

    const answerField = page.getByRole("textbox", { name: "What should the release note say?" });
    await tabTo(page, answerField);
    await page.keyboard.type("Ship the durable wait architecture");
    const submit = page.getByRole("button", { name: "Submit answers" });
    await tabTo(page, submit);
    await page.keyboard.press("Enter");
    await page.getByText("Answered and resumed.").waitFor();
    expect(approvalSignals).toHaveLength(1);
    await page.reload();
    await page.getByText("Answered and resumed.").waitFor();

    await page.goto(sessionUrl(cancelled.fixture.session.id));
    const cancel = page.getByRole("button", { name: "Cancel wait" });
    await tabTo(page, cancel);
    await page.keyboard.press("Enter");
    await page.getByText("Cancelled without an answer.").waitFor();
    expect(approvalSignals).toHaveLength(2);
    await page.reload();
    await page.getByText("Cancelled without an answer.").waitFor();

    const mobile = await authenticatedContext({ width: 375, height: 812 }, true);
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(sessionUrl(timedOut.fixture.session.id));
    await mobilePage.getByText("Timed out without an answer.").waitFor();
    await setTheme(mobilePage, "light");
    await expectNoPageOverflow(mobilePage);
    await expectNoAxeViolations(mobilePage);
    await mobilePage.screenshot({ path: "/tmp/ope20-durable-mobile-light.png", fullPage: true });

    await mobile.close();
    await context.close();
  }, 120_000);

  test("reconstructs passive waits and job logs/artifacts, then cancels durably", async () => {
    const fixture = await runningFixture("background");
    await createPassiveDurableWaitForTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: fixture.session.id,
      turnId: fixture.turn.id,
      expectedExecutionGeneration: fixture.turn.executionGeneration,
      expectedAttemptId: fixture.attemptId,
      requestKey: "browser-until",
      kind: "until",
      wakeAt: new Date(Date.now() + 60 * 60_000),
      description: "Wait for the maintenance window",
    });
    await createPassiveDurableWaitForTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: fixture.session.id,
      turnId: fixture.turn.id,
      expectedExecutionGeneration: fixture.turn.executionGeneration,
      expectedAttemptId: fixture.attemptId,
      requestKey: "browser-event",
      kind: "event",
      eventSourceIdentity: grant.subjectId,
      eventType: "deployment.completed",
      eventCorrelationKey: "browser-deploy-42",
      eventSubject: "production",
    });
    const created = await createBackgroundJobForTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: fixture.session.id,
      turnId: fixture.turn.id,
      expectedExecutionGeneration: fixture.turn.executionGeneration,
      expectedAttemptId: fixture.attemptId,
      provider: "modal",
      requestKey: "browser-background-job",
      spec: {
        command: "/bin/sh",
        args: ["-lc", "printf 'report ready\\n'"],
        artifactPaths: ["/tmp/report.txt"],
        metadata: { title: "Build release report" },
        timeoutSeconds: 300,
      },
    });
    await settleTurn(fixture, "completed");
    const attempt = await createBackgroundJobAttempt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      jobId: created.job.id,
      controllerId: "ope20-browser-observer",
    });
    expect(
      (await claimBackgroundJobStart(dbClient.db, grant.workspaceId, created.job.id)).action,
    ).toBe("start");
    expect(
      await attachBackgroundJobProvider(dbClient.db, {
        workspaceId: grant.workspaceId,
        jobId: created.job.id,
        attemptId: attempt.id,
        providerRef: "modal:sandbox:ope20-browser",
        providerInstanceId: "ope20-browser-provider",
        startedAt: new Date(),
      }),
    ).toMatchObject({ status: "running", startCount: 1 });
    await appendBackgroundJobLog(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      jobId: created.job.id,
      attemptId: attempt.id,
      providerOffset: 0,
      stream: "stdout",
      text: "Preparing release report…\nReport ready.\n",
    });
    const artifact = await insertBackgroundJobArtifact(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      jobId: created.job.id,
      path: "/tmp/report.txt",
      filename: "report.txt",
      contentType: "text/plain; charset=utf-8",
      sizeBytes: 13,
      sha256: "a".repeat(64),
      storageKey: `background-jobs/${grant.workspaceId}/${created.job.id}/report.txt`,
    });

    const desktop = await authenticatedContext({ width: 1440, height: 960 });
    await installWindowOpenCapture(desktop);
    const page = await desktop.newPage();
    await page.goto(sessionUrl(fixture.session.id));
    await page.getByText("Waiting until a scheduled time").waitFor();
    await page.getByText("Waiting for an event").waitFor();
    await page.getByText("Preparing release report…", { exact: false }).waitFor();
    await setTheme(page, "dark");
    await expectNoAxeViolations(page);
    await page.screenshot({ path: "/tmp/ope20-durable-desktop-dark.png", fullPage: true });

    await page.getByRole("button", { name: /report\.txt/ }).click();
    await expectOpenedUrl(page, artifact.storageKey);
    expect(signedArtifactKeys).toEqual([artifact.storageKey]);

    const mobile = await authenticatedContext({ width: 375, height: 812 }, true);
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(sessionUrl(fixture.session.id));
    await mobilePage.getByText("Preparing release report…", { exact: false }).waitFor();
    await setTheme(mobilePage, "dark");
    await expectNoPageOverflow(mobilePage);
    await expectNoAxeViolations(mobilePage);
    await mobilePage.screenshot({ path: "/tmp/ope20-durable-mobile-dark.png", fullPage: true });

    await page.getByRole("button", { name: "Cancel job" }).click();
    await page.getByText("Cancelling", { exact: true }).waitFor({ timeout: 10_000 });
    expect(await getBackgroundJob(dbClient.db, grant.workspaceId, created.job.id)).toMatchObject({
      status: "cancelling",
      startCount: 1,
    });
    await page.reload();
    await page.getByText("Cancelling", { exact: true }).waitFor();
    await page.getByText("Preparing release report…", { exact: false }).waitFor();

    await mobile.close();
    await desktop.close();
  }, 120_000);

  async function runningFixture(label: string) {
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: `OPE-20 browser ${label}`,
      resources: [],
      metadata: { title: `OPE-20 ${label}` },
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const initialized = await initializeSessionStartAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    if (initialized.workflowWakeRevision !== null) {
      await markSessionWorkflowWakeDelivered(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        temporalWorkflowId: initialized.temporalWorkflowId,
        wakeRevision: initialized.workflowWakeRevision,
      });
    }
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(dbClient.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") {
      throw new Error(`OPE-20 browser fixture was not claimed: ${claim.reason}`);
    }
    return { session, turn: claim.turn, attemptId };
  }

  async function askFixture(
    label: string,
    request: Parameters<typeof saveRunState>[1]["askUser"] extends infer Ask
      ? Ask extends { request: infer Request }
        ? Request
        : never
      : never,
  ) {
    const fixture = await runningFixture(label);
    const approvalId = `approval-${crypto.randomUUID()}`;
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: fixture.session.id,
      turnId: fixture.turn.id,
      expectedExecutionGeneration: fixture.turn.executionGeneration,
      expectedAttemptId: fixture.attemptId,
      serializedRunState: `ope20-browser-${label}-run-state`,
      pendingApprovals: [{ id: approvalId }],
      askUser: { approvalId, request },
    });
    await settleTurn(fixture, "requires_action", approvalId);
    const wait = (await listDurableWaits(dbClient.db, grant.workspaceId, fixture.session.id))[0];
    if (!wait) throw new Error(`OPE-20 ${label} ask wait was not created`);
    return { fixture, wait };
  }

  async function settleTurn(
    fixture: Awaited<ReturnType<typeof runningFixture>>,
    status: "completed" | "requires_action",
    approvalId?: string,
  ) {
    const requiresAction = status === "requires_action";
    const result = await applySessionTurnSettlement(dbClient.db, grant.workspaceId, {
      sessionId: fixture.session.id,
      turnId: fixture.turn.id,
      triggerEventId: fixture.turn.triggerEventId,
      attemptId: fixture.attemptId,
      turnStatus: requiresAction ? "requires_action" : "completed",
      sessionStatus: requiresAction ? "requires_action" : "idle",
      activeTurnId: requiresAction ? fixture.turn.id : null,
      events: requiresAction
        ? [
            {
              type: "session.requiresAction",
              payload: { approvals: [{ id: approvalId }] },
            },
            { type: "session.status.changed", payload: { status: "requires_action" } },
          ]
        : [
            { type: "turn.completed", payload: { output: "durable wait registered" } },
            { type: "session.status.changed", payload: { status: "idle" } },
          ],
    });
    expect(result.action).toBe("settled");
  }

  async function authenticatedContext(
    viewport: { width: number; height: number },
    mobile = false,
  ): Promise<BrowserContext> {
    const context = await browser.newContext({
      viewport,
      isMobile: mobile,
      hasTouch: mobile,
    });
    await context.addInitScript((token) => {
      localStorage.setItem("opengeni.accessKey", token);
    }, bearer);
    return context;
  }

  function sessionUrl(sessionId: string): string {
    return `${webBaseUrl}/workspaces/${grant.workspaceId}/sessions/${sessionId}`;
  }
});

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (nextTheme) => {
    if (nextTheme === "light") {
      document.documentElement.setAttribute("data-og-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-og-theme");
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, theme);
}

async function tabTo(page: Page, locator: ReturnType<Page["getByRole"]>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Keyboard focus never reached ${await locator.getAttribute("aria-label")}`);
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const report = await new AxeBuilder({ page })
    .include('[aria-label="Durable actions"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    report.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        [...document.querySelectorAll('[aria-label="Durable actions"]')].every(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
    ),
  ).toBe(true);
}

async function installWindowOpenCapture(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    (window as unknown as { __ope20OpenedUrls: string[] }).__ope20OpenedUrls = [];
    window.open = ((url?: string | URL) => {
      if (url) {
        (window as unknown as { __ope20OpenedUrls: string[] }).__ope20OpenedUrls.push(String(url));
      }
      return null;
    }) as typeof window.open;
  });
}

async function expectOpenedUrl(page: Page, storageKey: string): Promise<void> {
  const expected = `https://signed.example/${encodeURIComponent(storageKey)}`;
  await waitFor(
    async () =>
      (await page.evaluate(() =>
        (window as unknown as { __ope20OpenedUrls: string[] }).__ope20OpenedUrls.at(-1),
      )) === expected,
    { describe: () => `window.open did not receive ${expected}` },
  );
}
