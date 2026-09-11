import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import {
  createDb,
  createSession,
  withSessionRlsActorContext,
  saveAgentLearningSettings,
  saveKnowledgeEntry,
  getKnowledgeEntry,
  type KnowledgeContext,
} from "@opengeni/db";
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
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type Route,
} from "playwright";
import {
  isExpectedDisabledMachinesConsoleError,
  isExpectedDisabledMachinesResponse,
} from "./knowledge-surfaces.diagnostics";

const repoRoot = new URL("../..", import.meta.url).pathname;
const ownerHeaders = { "x-opengeni-subject": "knowledge-surfaces-owner" };
const secretSentinel = "KNOWLEDGE-SECRET-MUST-NEVER-RENDER-7d9d5d";
const longVariableNames = Array.from({ length: 18 }, (_, index) =>
  `KNOWLEDGE_KEY_${String(index + 1).padStart(2, "0")}_${"RESPONSIVE_INSPECTABLE_VARIABLE_".repeat(4)}`.slice(
    0,
    128,
  ),
);
const longVariableName = longVariableNames[0]!;
const lastVariableName = longVariableNames[longVariableNames.length - 1]!;
const longVariableSetName =
  `Responsive production variable set ${"with long context ".repeat(6)}`.slice(0, 120);
const longBaseName = `Long document base ${"inspectable-title-".repeat(7)}`;
const activeKnowledgeText =
  "Saved knowledge: keep responsive knowledge surfaces compact, deeply inspectable, and keyboard operable. " +
  "This intentionally long record proves ordinary prose wraps without hiding the durable fact. ".repeat(
    4,
  );
const unbrokenKnowledgeText = `Overflow sentinel ${"unbrokenresponsiveknowledge".repeat(18)}`;
const proposedKnowledgeText =
  "Proposed knowledge awaiting a human decision with approve and reject controls.";
const knowledgeTopics = [
  "alpha river mapping",
  "bravo basalt inventory",
  "charlie cedar pruning",
  "delta desert navigation",
  "echo ember inspection",
  "foxtrot frost monitoring",
  "golf garden irrigation",
  "hotel harbor scheduling",
  "india island surveying",
  "juliet jasmine propagation",
  "kilo kitchen provisioning",
  "lima lunar observation",
  "mike meadow restoration",
  "november night calibration",
  "oscar orchard rotation",
  "papa prairie sampling",
  "quebec quartz cataloging",
  "romeo railway maintenance",
] as const;
const knowledgeTexts = knowledgeTopics.map(
  (topic, index) =>
    `Knowledge entry ${String(index + 1).padStart(2, "0")}: ${topic} is a distinct durable record that remains reachable through the shared page scroll owner. ` +
    `Fixture marker KNOWLEDGE_ENTRY_${String(index + 1).padStart(2, "0")}_${topic.replaceAll(" ", "_")} proves the keyboard-operable content wraps without widening the viewport.`,
);
// The tree orders loaded entries by title; entry 20 is the last fixture row.
const tailKnowledgeText = unbrokenKnowledgeText;

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

// The browser fixture intentionally exercises the default deployment contract:
// Connected Machines are disabled, so only its exact invisible list endpoint
// may return 404. The API route and enabled/disabled behavior are covered by
// apps/api/test/machines-routes.test.ts.
const browserTestSettings = testSettings({
  productAccessMode: "local",
  delegationSecret: undefined,
  environmentsEncryptionKey: Buffer.alloc(32, 15).toString("base64"),
  documentEmbeddingProvider: "deterministic",
  sandboxSelfhostedEnabled: false,
});

describe("responsive knowledge surfaces (real API + PostgreSQL)", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let apiBaseUrl: string;
  let webBaseUrl: string;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("knowledge-surfaces-browser");
    if (!acquired) {
      throw new Error(
        "Knowledge-surface browser acceptance requires real PostgreSQL; no skip is allowed",
      );
    }
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    const app = createApp({
      settings: { ...browserTestSettings, databaseUrl: shared.appUrl },
      db: dbClient.db,
      bus: new MemoryEventBus(),
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
    await browser?.close().catch(() => undefined);
    await web?.stop().catch(() => undefined);
    api?.stop(true);
    await dbClient?.close().catch(() => undefined);
    await shared?.release();
  }, 60_000);

  test("ships responsive, accessible variable sets, files, and unified Knowledge", async () => {
    const bootstrap = await configuredContext(
      browser,
      {
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: ownerHeaders,
      },
      browserTestSettings.sandboxSelfhostedEnabled,
    );
    let workspaceId: string;
    let fixtures: SeededFixtures;
    try {
      const page = await bootstrap.newPage();
      await page.goto(webBaseUrl);
      workspaceId = await workspaceFromPage(page);
      fixtures = await seedKnowledgeSurfaces(page, apiBaseUrl, workspaceId);
      // Refresh the real client workspace projection after enabling memory via
      // the public settings route; no internal context or database shortcut is used.
      await page.reload();
      await workspaceFromPage(page);

      await exerciseTruthfulStates(page, workspaceId, fixtures);
      await exerciseKeyboardAndDisclosure(page, workspaceId, fixtures);
      expect(unexpectedDiagnostics(bootstrap)).toEqual([]);
    } finally {
      await bootstrap.close();
    }

    const matrix: MatrixCase[] = [
      {
        label: "320",
        viewport: { width: 320, height: 720 },
        isMobile: true,
        hasTouch: true,
        screenshotSurface: "memory",
      },
      {
        label: "375",
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
        screenshotSurface: "variable-sets",
      },
      {
        label: "768",
        viewport: { width: 768, height: 1024 },
        isMobile: true,
        hasTouch: true,
        screenshotSurface: "documents",
      },
      {
        label: "desktop",
        viewport: { width: 1280, height: 900 },
        screenshotSurface: "memory",
      },
    ];

    for (const matrixCase of matrix) {
      const context = await configuredContext(
        browser,
        {
          viewport: matrixCase.viewport,
          isMobile: matrixCase.isMobile,
          hasTouch: matrixCase.hasTouch,
          extraHTTPHeaders: ownerHeaders,
        },
        browserTestSettings.sandboxSelfhostedEnabled,
      );
      try {
        const page = await context.newPage();
        for (const theme of ["light", "dark"] as const) {
          for (const surface of ["variable-sets", "documents", "memory"] as const) {
            await openSurface(page, webBaseUrl, workspaceId, fixtures, surface, {
              focusMemory: false,
            });
            await setTheme(page, theme);
            expect(await page.locator("main").count()).toBe(1);
            await expectNoPageOverflow(page);
            await expectNoAxeViolations(
              page,
              "[data-slot='content-page']",
              `${matrixCase.label}/${theme}/${surface}`,
            );

            if (matrixCase.hasTouch) {
              await expectOwnedTouchTargets(page, surface);
            }
            if (matrixCase.label === "desktop" && surface !== "variable-sets") {
              for (const name of ["Knowledge", "Files", "Instructions", "Skills"])
                await page.getByRole("tab", { name, exact: true }).waitFor();
            }
            if (surface === "variable-sets") {
              await ensureVariableSetExpanded(page);
              await expectContentPageScrollAndFocus(
                page,
                page.getByRole("button", { name: `Rotate variable ${lastVariableName}` }),
              );
            } else if (surface === "memory") {
              await expectContentPageScrollAndFocus(
                page,
                page.getByRole("button", { name: "Retained entry 20", exact: true }),
              );
            }
            if (surface === matrixCase.screenshotSurface) {
              await resetSurfaceCaptureViewport(page);
              await page.screenshot({
                path: `/tmp/knowledge-surfaces-${matrixCase.label}-${theme}-${surface}.png`,
                fullPage: true,
              });
            }
          }
        }
        expect(unexpectedDiagnostics(context)).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 240_000);

  test("keeps a long schedules list inside the workspace scroll owner", async () => {
    const desktop = await configuredContext(
      browser,
      {
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: ownerHeaders,
      },
      browserTestSettings.sandboxSelfhostedEnabled,
    );
    let workspaceId: string;
    let tailTask: SeededScheduledTask;
    try {
      const page = await desktop.newPage();
      await page.goto(webBaseUrl);
      workspaceId = await workspaceFromPage(page);
      tailTask = await seedScheduledTasks(page, apiBaseUrl, workspaceId);
      await expectSchedulesScroll(page, webBaseUrl, workspaceId, tailTask);
      expect(unexpectedDiagnostics(desktop)).toEqual([]);
    } finally {
      await desktop.close();
    }

    const constrained = await configuredContext(
      browser,
      {
        viewport: { width: 375, height: 720 },
        extraHTTPHeaders: ownerHeaders,
      },
      browserTestSettings.sandboxSelfhostedEnabled,
    );
    try {
      const page = await constrained.newPage();
      await expectSchedulesScroll(page, webBaseUrl, workspaceId, tailTask);
      expect(unexpectedDiagnostics(constrained)).toEqual([]);
    } finally {
      await constrained.close();
    }
  }, 120_000);

  test("scheduled learning changes remain drafts until Save and Cancel discards them", async () => {
    const context = await configuredContext(
      browser,
      { viewport: { width: 1280, height: 900 }, extraHTTPHeaders: ownerHeaders },
      false,
    );
    try {
      const page = await context.newPage();
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const task = await page.evaluate(
        async ({ apiBaseUrl: apiUrl, workspaceId: workspace }) => {
          const response = await fetch(`${apiUrl}/v1/workspaces/${workspace}/scheduled-tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Review ingestion",
              status: "paused",
              schedule: { type: "manual" },
              agentConfig: { prompt: "Read useful updates" },
            }),
          });
          if (!response.ok) throw new Error(await response.text());
          return (await response.json()) as { id: string; name: string };
        },
        { apiBaseUrl, workspaceId },
      );
      const read = () =>
        page.evaluate(
          async ({ apiBaseUrl: apiUrl, workspaceId: workspace, taskId }) => {
            const response = await fetch(
              `${apiUrl}/v1/workspaces/${workspace}/agent-learning/read`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  scope: "workspace",
                  source: { kind: "scheduled_task", id: taskId },
                }),
              },
            );
            if (!response.ok) throw new Error(await response.text());
            return (await response.json()) as { version: number; settings: Record<string, string> };
          },
          { apiBaseUrl, workspaceId, taskId: task.id },
        );
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/schedules`);
      await page.getByRole("button", { name: /^View all/ }).click();
      const card = page.locator(`[data-scheduled-task-id="${task.id}"]`);
      const edit = async () => {
        await card.getByRole("button", { name: `More actions for ${task.name}` }).click();
        await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
        await card.getByRole("button", { name: /^Agent learning/ }).click();
        await card.getByRole("combobox", { name: "Knowledge", exact: true }).waitFor();
      };
      await edit();
      await card
        .getByRole("combobox", { name: "Knowledge", exact: true })
        .selectOption("review_first");
      expect((await read()).settings).toEqual({});
      await card.getByRole("button", { name: "Cancel", exact: true }).click();
      expect((await read()).settings).toEqual({});
      await edit();
      expect(
        await card.getByRole("combobox", { name: "Knowledge", exact: true }).inputValue(),
      ).toBe("inherit");
      await card
        .getByRole("combobox", { name: "Knowledge", exact: true })
        .selectOption("review_first");
      await card.getByRole("button", { name: "Save changes", exact: true }).click();
      await card
        .getByRole("button", { name: "Save changes", exact: true })
        .waitFor({ state: "hidden" });
      expect((await read()).settings).toEqual({ knowledge: "review_first" });
      const savedPolicy = await read();
      const settingsPattern = /\/agent-learning\/read$/;
      await page.route(settingsPattern, async (route) => {
        if (route.request().postDataJSON()?.scope === "context")
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Learning settings unavailable" }),
          });
        else await route.continue();
      });
      await card.getByRole("button", { name: `More actions for ${task.name}` }).click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      await card.getByRole("button", { name: /^Agent learning/ }).click();
      await card
        .getByText("Learning settings are unavailable. You can still save other task changes.", {
          exact: false,
        })
        .waitFor();
      await card.getByPlaceholder("Daily infrastructure review").fill("Renamed ingestion");
      const submitted = page.waitForRequest(
        (request) =>
          request.method() === "PATCH" && request.url().endsWith(`/scheduled-tasks/${task.id}`),
      );
      await card.getByRole("button", { name: "Save changes", exact: true }).click();
      expect((await submitted).postDataJSON().agentLearning).toBeUndefined();
      await card
        .getByRole("button", { name: "Save changes", exact: true })
        .waitFor({ state: "hidden" });
      await card.getByText("Renamed ingestion", { exact: true }).waitFor();
      await page.unroute(settingsPattern);
      expect(await read()).toEqual(savedPolicy);
      expect(unexpectedDiagnostics(context)).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  test("keeps the Agent Knowledge overview truthful across responsive breakpoints", async () => {
    const bootstrap = await configuredContext(
      browser,
      {
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: ownerHeaders,
      },
      browserTestSettings.sandboxSelfhostedEnabled,
    );
    let workspaceId: string;
    try {
      const page = await bootstrap.newPage();
      await page.goto(webBaseUrl);
      workspaceId = await workspaceFromPage(page);
    } finally {
      await bootstrap.close();
    }

    const matrix = [
      { label: "320", viewport: { width: 320, height: 720 }, theme: "light" },
      { label: "375", viewport: { width: 375, height: 812 }, theme: "dark" },
      { label: "768", viewport: { width: 768, height: 1024 }, theme: "light" },
      { label: "desktop", viewport: { width: 1280, height: 900 }, theme: "dark" },
    ] as const;

    for (const matrixCase of matrix) {
      const context = await configuredContext(
        browser,
        {
          viewport: matrixCase.viewport,
          isMobile: matrixCase.label === "desktop" ? undefined : true,
          hasTouch: matrixCase.label === "desktop" ? undefined : true,
          extraHTTPHeaders: ownerHeaders,
        },
        browserTestSettings.sandboxSelfhostedEnabled,
      );
      try {
        const page = await context.newPage();
        await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/state`);
        await page
          .getByRole("heading", { level: 1, name: "Agent Knowledge", exact: true })
          .waitFor();
        for (const destination of ["Knowledge", "Files", "Instructions", "Skills"]) {
          await page.getByRole("tab", { name: destination, exact: true }).waitFor();
        }
        await page.getByRole("tree", { name: "Knowledge", exact: true }).waitFor();
        expect(await page.getByRole("button", { name: "Inspect", exact: true }).count()).toBe(0);
        await setTheme(page, matrixCase.theme);
        await expectNoPageOverflow(page);
        await expectNoAxeViolations(
          page,
          "[data-slot='content-page']",
          `agent-knowledge/${matrixCase.label}/${matrixCase.theme}`,
        );

        await resetSurfaceCaptureViewport(page);
        await page.screenshot({
          path: `/tmp/agent-knowledge-${matrixCase.label}-${matrixCase.theme}-overview.png`,
          fullPage: true,
        });
        expect(unexpectedDiagnostics(context)).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 120_000);

  test("browses nested collections in place, opens entries and searches across collapsed folders", async () => {
    const context = await configuredContext(
      browser,
      { viewport: { width: 1280, height: 900 }, extraHTTPHeaders: ownerHeaders },
      browserTestSettings.sandboxSelfhostedEnabled,
    );
    try {
      const page = await context.newPage();
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      await page.evaluate(
        async ({ apiBaseUrl: targetApiBaseUrl, workspaceId: targetWorkspaceId }) => {
          async function save(title: string, kind: "note" | "group", groupIds: string[] = []) {
            const entryId = crypto.randomUUID();
            const response = await fetch(
              `${targetApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/knowledge/entries`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  operationId: crypto.randomUUID(),
                  entryId,
                  expectedVersion: 0,
                  entry: { title, kind, content: `${title} description`, groupIds },
                }),
              },
            );
            if (!response.ok) throw new Error(await response.text());
            return entryId;
          }
          const acme = await save("Acme tree", "group");
          const contracts = await save("Contracts tree", "group", [acme]);
          const billing = await save("Billing tree", "group");
          await save("Nested renewal", "note", [contracts, billing]);
        },
        { apiBaseUrl, workspaceId },
      );
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/state`);
      const tree = page.getByRole("tree", { name: "Knowledge", exact: true });
      await tree.getByRole("button", { name: "Acme tree", exact: true }).waitFor();
      expect(await tree.getByRole("button", { name: "Nested renewal", exact: true }).count()).toBe(
        0,
      );
      await tree.getByRole("treeitem", { name: "Acme tree", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await tree.getByRole("button", { name: "Contracts tree", exact: true }).waitFor();
      await tree.getByRole("button", { name: "Contracts tree", exact: true }).click();
      await tree.getByRole("button", { name: "Nested renewal", exact: true }).waitFor();
      await tree.getByRole("button", { name: "Billing tree", exact: true }).click();
      await tree.getByRole("button", { name: "Nested renewal", exact: true }).nth(1).waitFor();
      expect(await tree.getByRole("button", { name: "Nested renewal", exact: true }).count()).toBe(
        2,
      );
      await tree.getByRole("button", { name: "Nested renewal", exact: true }).first().click();
      await page
        .getByRole("dialog")
        .getByText("Nested renewal description", { exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      await tree.getByRole("button", { name: "Actions for Contracts tree", exact: true }).click();
      await page.getByRole("menuitem", { name: "New collection here", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("textbox", { name: "Title", exact: true })
        .fill("Signed contracts tree");
      await page
        .getByRole("dialog")
        .getByRole("textbox", { name: "Content", exact: true })
        .fill("Final agreements");
      await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await tree.getByRole("button", { name: "Signed contracts tree", exact: true }).waitFor();
      await expectNoAxeViolations(page, "[data-slot='content-page']", "nested-knowledge-tree");
      await expectNoPageOverflow(page);
      await page.setViewportSize({ width: 375, height: 812 });
      await expectNoPageOverflow(page);
      await expectNoAxeViolations(
        page,
        "[data-slot='content-page']",
        "nested-knowledge-tree-mobile",
      );
      await page
        .getByRole("textbox", { name: "Search knowledge", exact: true })
        .fill("Nested renewal");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page
        .getByRole("region", { name: "Search results", exact: true })
        .getByRole("button", { name: "Nested renewal", exact: true })
        .waitFor();
      expect(await page.getByRole("button", { name: "Nested renewal", exact: true }).count()).toBe(
        1,
      );
      expect(unexpectedDiagnostics(context)).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  test("reviews changes directly, orders prerequisites, and returns from evidence without losing the proposal", async () => {
    const expectedMissingKnowledge = new Set<string>();
    const context = await configuredContext(
      browser,
      { viewport: { width: 1280, height: 900 }, extraHTTPHeaders: ownerHeaders },
      false,
      expectedMissingKnowledge,
    );
    try {
      const page = await context.newPage();
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const access = await page.evaluate(
        async (url) => (await fetch(`${url}/v1/access/me`, { credentials: "include" })).json(),
        apiBaseUrl,
      );
      const grant = access.workspaceGrants.find(
        (g: { workspaceId: string }) => g.workspaceId === workspaceId,
      );
      const { accountId, subjectId } = grant;
      const human: KnowledgeContext = {
        accountId,
        workspaceId,
        actor: {
          kind: "human",
          principalKind: "human_session",
          subjectId,
          writeScopes: ["workspace"],
          settingsScopes: ["workspace"],
          review: true,
        },
      };
      async function agentFor(title: string): Promise<KnowledgeContext> {
        const session = await withSessionRlsActorContext({ subjectId }, () =>
          createSession(dbClient.db, {
            accountId,
            workspaceId,
            initialMessage: title,
            memoryScope: "workspace",
            resources: [],
            metadata: {},
            model: "test-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
            createdBy: { kind: "subject", subjectId },
            createdByContext: {},
          }),
        );
        await saveAgentLearningSettings(dbClient.db, human, {
          scope: "workspace",
          source: { kind: "chat", id: session.id },
          operationId: crypto.randomUUID(),
          expectedVersion: 0,
          settings: { knowledge: "review_first" },
        });
        const turnId = crypto.randomUUID(),
          attemptId = crypto.randomUUID();
        await shared.admin.begin(async (tx) => {
          await tx`SELECT set_config('opengeni.session_inference_claim','1',true)`;
          await tx`INSERT INTO session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,status,source,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id) VALUES(${turnId},${accountId},${workspaceId},${session.id},${crypto.randomUUID()},${`review-${turnId}`},'running','user',1,${title},'test-model','medium','none',1,'subject',${subjectId},'{}',${subjectId})`;
          await tx`UPDATE sessions SET active_turn_id=${turnId},status='running',title=${title},title_source='user' WHERE id=${session.id}`;
          await tx`UPDATE session_turns SET active_attempt_id=${attemptId} WHERE id=${turnId}`;
          await tx`INSERT INTO session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies) VALUES(${attemptId},${accountId},${workspaceId},${session.id},${turnId},1,'running',${`review-${turnId}`},${`run-${attemptId}`},${`activity-${attemptId}`},0,'{}')`;
        });
        return {
          accountId,
          workspaceId,
          actor: {
            kind: "agent",
            sessionId: session.id,
            turnId,
            attemptId,
            executionGeneration: 1,
          },
        };
      }
      const agent = await agentFor("Review acceptance Acme");
      const otherAgent = await agentFor("Review acceptance another batch");
      const id = (prefix: string) => prefix + crypto.randomUUID().slice(8);
      const sourceId = id("eeeeeeee"),
        findingId = id("11111111"),
        folderId = id("ffffffff"),
        noteId = id("22222222");
      expectedMissingKnowledge.add(
        `${apiBaseUrl}/v1/workspaces/${workspaceId}/knowledge/entries/${folderId}`,
      );
      const source = await saveKnowledgeEntry(dbClient.db, human, {
        operationId: crypto.randomUUID(),
        entryId: sourceId,
        expectedVersion: 0,
        entry: {
          title: "Review Acme contract",
          kind: "source",
          content: "Annual fee EUR 20,000.",
          source: { kind: "manual", retention: "full_text" },
        },
      });
      const finding = await saveKnowledgeEntry(dbClient.db, human, {
        operationId: crypto.randomUUID(),
        entryId: findingId,
        expectedVersion: 0,
        entry: {
          title: "Review Acme renewal",
          kind: "fact",
          content: "Acme pays EUR 20,000 annually.",
          evidence: [
            {
              entryId: sourceId,
              revisionId: source.revisionId,
              quote: "Annual fee EUR 20,000.",
              location: {},
            },
          ],
        },
      });
      await saveKnowledgeEntry(dbClient.db, agent, {
        operationId: crypto.randomUUID(),
        entryId: folderId,
        expectedVersion: 0,
        entry: { title: "Review Acme collection", kind: "group", content: "Acme contracts" },
      });
      const updatedSource = await saveKnowledgeEntry(dbClient.db, agent, {
        operationId: crypto.randomUUID(),
        entryId: sourceId,
        expectedVersion: source.version,
        entry: {
          title: "Review Acme contract",
          kind: "source",
          content: "Annual fee EUR 21,000.",
          groupIds: [folderId],
          source: { kind: "manual", retention: "full_text" },
        },
      });
      await saveKnowledgeEntry(dbClient.db, agent, {
        operationId: crypto.randomUUID(),
        entryId: findingId,
        expectedVersion: finding.version,
        entry: {
          title: "Review Acme renewal",
          kind: "fact",
          content: "Acme pays EUR 21,000 annually.",
          evidence: [
            {
              entryId: sourceId,
              revisionId: updatedSource.revisionId,
              quote: "Annual fee EUR 21,000.",
              location: {},
            },
          ],
        },
      });
      await saveKnowledgeEntry(dbClient.db, agent, {
        operationId: crypto.randomUUID(),
        entryId: noteId,
        expectedVersion: 0,
        entry: { title: "Review unsupported claim", kind: "note", content: "Reject this claim." },
      });
      await saveKnowledgeEntry(dbClient.db, otherAgent, {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        entry: { title: "Other batch proposal", kind: "note", content: "Another review." },
      });
      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/state`);
      await page.getByRole("tab", { name: "Needs review", exact: true }).click();
      const batches = page.locator('[aria-label="Knowledge review groups"] > div');
      const openBatch = async (title: string) =>
        batches
          .filter({ hasText: title })
          .getByRole("button", { name: /^Review \d+ changes?$/ })
          .click();
      await openBatch("Review acceptance Acme");
      const dialog = page.getByRole("dialog");
      // UUID order begins with the finding; its unpublished collection and source must be reviewed first.
      await dialog.getByRole("heading", { name: "Review Acme collection", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Continue review", exact: true }).click();
      await dialog.getByRole("heading", { name: "Review Acme collection", exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Approve and next", exact: true }).click();
      await dialog.getByRole("heading", { name: "Review Acme contract", exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Approve and next", exact: true }).click();
      await dialog.getByRole("heading", { name: "Review Acme renewal", exact: true }).waitFor();
      await waitFor(
        async () => (await dialog.locator("mark").allTextContents()).join() === "20,000,21,000",
        { timeoutMs: 10_000 },
      );
      expect(await dialog.getByText("Supporting information", { exact: true }).isVisible()).toBe(
        false,
      );
      await dialog
        .locator("summary")
        .filter({ hasText: /^Supporting details$/ })
        .click();
      await dialog.getByRole("button", { name: "Review Acme contract", exact: true }).click();
      await dialog.getByRole("heading", { name: "Review Acme contract", exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Back to review", exact: true }).click();
      await dialog.getByRole("heading", { name: "Review Acme renewal", exact: true }).waitFor();
      await waitFor(
        async () => (await dialog.locator("mark").allTextContents()).join() === "20,000,21,000",
        { timeoutMs: 10_000 },
      );
      await page.screenshot({ path: "/tmp/opengeni-knowledge-review-acceptance.png" });
      // Hold A's response after the server accepts it; opening B must invalidate A's UI completion.
      let release!: () => void, accepted!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const received = new Promise<void>((resolve) => {
        accepted = resolve;
      });
      await page.route(`**/knowledge/entries/${findingId}/review`, async (route) => {
        const response = await route.fetch();
        accepted();
        await held;
        await route.fulfill({ response });
      });
      await dialog.getByRole("button", { name: "Approve and next", exact: true }).click();
      await received;
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Filter knowledge", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Knowledge type", exact: true })
        .selectOption("fact");
      await page.getByRole("textbox", { name: "Search knowledge", exact: true }).fill("Acme");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByRole("button", { name: "All reviews", exact: true }).click();
      await openBatch("Review acceptance another batch");
      await dialog.getByRole("heading", { name: "Other batch proposal", exact: true }).waitFor();
      const completed = page.waitForResponse((response) =>
        response.url().endsWith(`/knowledge/entries/${findingId}/review`),
      );
      release();
      await completed;
      expect(
        await dialog
          .getByRole("heading", { name: "Other batch proposal", exact: true })
          .isVisible(),
      ).toBe(true);
      await dialog.getByRole("button", { name: "Reject and next", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await openBatch("Review acceptance Acme");
      await dialog
        .getByRole("heading", { name: "Review unsupported claim", exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "Reject and next", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const saved = await getKnowledgeEntry(dbClient.db, human, findingId);
      expect(saved?.revision.entry.content).toBe("Acme pays EUR 21,000 annually.");
      expect(await getKnowledgeEntry(dbClient.db, human, noteId)).toBeNull();
      expect(unexpectedDiagnostics(context)).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  async function exerciseTruthfulStates(
    page: Page,
    workspaceId: string,
    fixtures: SeededFixtures,
  ): Promise<void> {
    const pattern = new RegExp(`/v1/workspaces/${workspaceId}/knowledge/entries/search(?:\\?.*)?$`);
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const delayed = async (route: Route) => {
      observed();
      await gate;
      await route.continue();
    };
    await page.route(pattern, delayed);
    await page.goto(surfaceUrl(webBaseUrl, workspaceId, "memory", fixtures));
    await requested;
    await page.getByText("Loading knowledge…", { exact: true }).waitFor();
    release();
    await page.getByRole("button", { name: "Retained entry 19", exact: true }).waitFor();
    await page.unroute(pattern, delayed);
    let failRequests = true;
    const failing = async (route: Route) => {
      if (failRequests)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Intentional knowledge-list failure" }),
        });
      else await route.continue();
    };
    await page.route(pattern, failing);
    await page.reload();
    await page.getByRole("alert").waitFor();
    failRequests = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Retained entry 19", exact: true }).waitFor();
    await page.unroute(pattern, failing);
    await page.getByRole("tab", { name: "Archived", exact: true }).click();
    await page.getByText("No archived knowledge.", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.getByText("Keep your files here", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
    await page.getByRole("button", { name: "Retained entry 19", exact: true }).waitFor();
  }

  async function exerciseKeyboardAndDisclosure(
    page: Page,
    workspaceId: string,
    fixtures: SeededFixtures,
  ): Promise<void> {
    // Historical URLs still open the same persistent Knowledge navigation.
    await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/memory`);
    await page.getByRole("heading", { level: 1, name: "Agent Knowledge", exact: true }).waitFor();
    await page.goto(surfaceUrl(webBaseUrl, workspaceId, "variable-sets", fixtures));
    await page.getByText(longVariableSetName, { exact: true }).waitFor();
    const manage = page.getByRole("button", {
      name: `Manage variables for ${longVariableSetName}`,
    });
    expect((await manage.textContent())?.trim()).toBe("Manage variables");
    await manage.focus();
    await page.keyboard.press("Enter");
    const expandedManage = page.getByRole("button", {
      name: `Hide variables for ${longVariableSetName}`,
    });
    expect(await expandedManage.getAttribute("aria-expanded")).toBe("true");
    await page.getByText(longVariableName, { exact: true }).waitFor();
    await expectContentPageScrollAndFocus(
      page,
      page.getByRole("button", { name: `Rotate variable ${lastVariableName}` }),
    );
    const hiddenValues = page.getByLabel("Value hidden");
    expect(await hiddenValues.count()).toBe(longVariableNames.length);
    expect(await hiddenValues.first().textContent()).toContain("••••••");
    expect(
      await page.evaluate(
        (sentinel) =>
          (document.body.textContent ?? "").includes(sentinel) ||
          [...document.querySelectorAll("input")].some((input) => input.value.includes(sentinel)),
        secretSentinel,
      ),
    ).toBe(false);

    await page.getByRole("button", { name: `Reveal variable ${longVariableName}` }).click();
    const revealed = page.getByLabel(`Revealed value for ${longVariableName}`);
    await revealed.waitFor();
    expect(await revealed.textContent()).toContain(secretSentinel);
    expect(
      await page.getByRole("button", { name: `Copy variable ${longVariableName}` }).count(),
    ).toBe(1);
    await page.getByRole("button", { name: `Hide variable ${longVariableName}` }).click();
    await revealed.waitFor({ state: "hidden" });
    expect(
      await page.evaluate(
        (sentinel) =>
          (document.body.textContent ?? "").includes(sentinel) ||
          [...document.querySelectorAll("input")].some((input) => input.value.includes(sentinel)),
        secretSentinel,
      ),
    ).toBe(false);

    await page.goto(surfaceUrl(webBaseUrl, workspaceId, "memory", fixtures));
    const card = page.getByRole("button", { name: "Retained entry 20", exact: true });
    await card.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await page.getByRole("dialog").getByText(tailKnowledgeText, { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Add knowledge", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Browser-created knowledge");
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Content", exact: true })
      .fill("A useful finding entered by a person.");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Browser-created knowledge", exact: true }).waitFor();
    await expectContentPageScrollAndFocus(page, card);
    await expectNoPageOverflow(page);
  }
});

type SeededFixtures = {
  proposedMemoryId: string;
  tailMemoryId: string;
};

type SeededScheduledTask = {
  id: string;
  name: string;
};

type Surface = "variable-sets" | "documents" | "memory";

type MatrixCase = {
  label: "320" | "375" | "768" | "desktop";
  viewport: { width: number; height: number };
  isMobile?: boolean;
  hasTouch?: boolean;
  screenshotSurface: Surface;
};

const diagnostics = new WeakMap<BrowserContext, string[]>();

async function configuredContext(
  browser: Browser,
  options: BrowserContextOptions,
  sandboxSelfhostedEnabled: boolean,
  expectedMissingKnowledge: ReadonlySet<string> = new Set(),
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  context.setDefaultTimeout(15_000);
  const problems: string[] = [];
  const expectedMachines404Urls = new Set<string>();
  const observedKnowledge404Urls = new Set<string>();
  diagnostics.set(context, problems);
  context.on("page", (page) => {
    page.on("pageerror", (error) => problems.push(`page error: ${String(error)}`));
  });
  context.on("requestfailed", (request) => {
    // Full-page navigation intentionally cancels Vite modules, API reads, and
    // the workspace SSE stream that belonged to the prior document.
    if (request.failure()?.errorText === "net::ERR_ABORTED") return;
    problems.push(
      `request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
    );
  });
  context.on("response", (response) => {
    if (response.status() < 400) return;
    // This one response is the explicit error-state fixture above.
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      problems.push(
        `response ${response.status()}: ${response.request().method()} ${response.url()}`,
      );
      return;
    }
    if (
      response.status() === 503 &&
      /\/(knowledge\/entries\/search|agent-learning\/read)$/.test(url.pathname)
    )
      return;
    if (
      isExpectedDisabledMachinesResponse(
        { status: response.status(), method: response.request().method(), url: response.url() },
        sandboxSelfhostedEnabled,
      )
    ) {
      expectedMachines404Urls.add(response.url());
      return;
    }
    // A pending collection has no published version yet. The review resolver
    // probes that exact identity before reading its proposal; no other 404 is allowed.
    if (
      response.status() === 404 &&
      response.request().method() === "GET" &&
      expectedMissingKnowledge.has(response.url())
    ) {
      observedKnowledge404Urls.add(response.url());
      return;
    }
    problems.push(
      `response ${response.status()}: ${response.request().method()} ${response.url()}`,
    );
  });
  context.on("console", (message) => {
    if (message.type() !== "error") return;
    // HTTP failures are recorded with their URL by the response listener. The
    // only allowed 503 is the explicit error-state fixture above.
    if (
      message.text() ===
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
    ) {
      return;
    }
    const locationUrl = message.location().url;
    if (
      message.text() ===
        "Failed to load resource: the server responded with a status of 404 (Not Found)" &&
      observedKnowledge404Urls.has(locationUrl)
    ) {
      observedKnowledge404Urls.delete(locationUrl);
      return;
    }
    if (
      isExpectedDisabledMachinesConsoleError(
        { text: message.text(), locationUrl },
        sandboxSelfhostedEnabled,
        expectedMachines404Urls,
      )
    ) {
      expectedMachines404Urls.delete(locationUrl);
      return;
    }
    problems.push(`console error: ${message.text()}`);
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
    } catch {
      // The script also runs for the opaque initial document, where storage is
      // unavailable. It runs again and succeeds once the real origin commits.
    }
  });
  return context;
}

function unexpectedDiagnostics(context: BrowserContext): string[] {
  return diagnostics.get(context) ?? ["browser diagnostics were not initialized"];
}

async function workspaceFromPage(page: Page): Promise<string> {
  await waitFor(() => /\/workspaces\/[^/]+\/sessions/.test(page.url()), { timeoutMs: 15_000 });
  return page.url().match(/\/workspaces\/([^/]+)\/sessions/)![1]!;
}

async function seedKnowledgeSurfaces(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
): Promise<SeededFixtures> {
  return await page.evaluate(
    async ({ apiBaseUrl: targetApiBaseUrl, workspaceId: targetWorkspaceId, fixture }) => {
      async function request<T>(path: string, init: RequestInit): Promise<T> {
        const response = await fetch(`${targetApiBaseUrl}${path}`, {
          ...init,
          headers: { "content-type": "application/json" },
        });
        if (!response.ok) {
          throw new Error(
            `${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`,
          );
        }
        return (await response.json()) as T;
      }

      await request(`/v1/workspaces/${targetWorkspaceId}/variable-sets`, {
        method: "POST",
        body: JSON.stringify({
          name: fixture.longVariableSetName,
          description:
            "A deliberately long description that remains fully inspectable on compact viewports without widening the page.",
          variables: fixture.longVariableNames.map((name) => ({
            name,
            value: fixture.secretSentinel,
          })),
        }),
      });
      const memoryIds: string[] = [];
      for (const text of [
        ...fixture.knowledgeTexts,
        fixture.activeKnowledgeText,
        fixture.unbrokenKnowledgeText,
      ]) {
        const id = crypto.randomUUID();
        await request(`/v1/workspaces/${targetWorkspaceId}/knowledge/entries`, {
          method: "POST",
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            entryId: id,
            expectedVersion: 0,
            scope: "workspace",
            entry: {
              kind: "note",
              title: `Retained entry ${String(memoryIds.length + 1).padStart(2, "0")}`,
              content: text,
            },
          }),
        });
        memoryIds.push(id);
      }
      const proposed = { id: memoryIds[0]! };
      return { proposedMemoryId: proposed.id, tailMemoryId: memoryIds[0]! };
    },
    {
      apiBaseUrl,
      workspaceId,
      fixture: {
        secretSentinel,
        longVariableNames,
        longVariableSetName,
        longBaseName,
        activeKnowledgeText,
        unbrokenKnowledgeText,
        proposedKnowledgeText,
        knowledgeTexts,
      },
    },
  );
}

async function seedScheduledTasks(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
): Promise<SeededScheduledTask> {
  return await page.evaluate(
    async ({ apiBaseUrl: targetApiBaseUrl, workspaceId: targetWorkspaceId }) => {
      let tailTask: SeededScheduledTask | null = null;
      for (let index = 0; index < 16; index += 1) {
        const name =
          index === 0
            ? `Tail schedule ${"reachable-without-document-scroll-".repeat(3)}`
            : `Responsive schedule ${String(index + 1).padStart(2, "0")}`;
        const response = await fetch(
          `${targetApiBaseUrl}/v1/workspaces/${targetWorkspaceId}/scheduled-tasks`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              schedule: { type: "interval", everySeconds: 3600 + index },
              agentConfig: { prompt: `Run responsive schedule fixture ${index + 1}` },
            }),
          },
        );
        if (!response.ok) {
          throw new Error(
            `POST scheduled task failed: ${response.status} ${await response.text()}`,
          );
        }
        const created = (await response.json()) as SeededScheduledTask;
        tailTask ??= { id: created.id, name: created.name };
      }
      if (!tailTask) throw new Error("Scheduled task fixture was not created");
      return tailTask;
    },
    { apiBaseUrl, workspaceId },
  );
}

async function expectSchedulesScroll(
  page: Page,
  baseUrl: string,
  workspaceId: string,
  tailTask: SeededScheduledTask,
): Promise<void> {
  await page.goto(`${baseUrl}/workspaces/${workspaceId}/schedules`);
  await page.getByRole("heading", { level: 1, name: "Schedules", exact: true }).waitFor();
  const tailCard = page.locator(`[data-scheduled-task-id="${tailTask.id}"]`);
  await tailCard.getByText(tailTask.name, { exact: true }).waitFor();
  const scrollOwner = page.locator('[data-workspace-scroll-owner="page"]');
  expect(await scrollOwner.count()).toBe(1);
  await expectContentPageScrollAndFocus(
    page,
    tailCard.getByRole("button", { name: `More actions for ${tailTask.name}`, exact: true }),
  );
  await expectNoPageOverflow(page);
  const documentScroll = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }));
  expect(documentScroll.scrollX).toBe(0);
  expect(documentScroll.scrollY).toBe(0);
}

function surfaceUrl(
  baseUrl: string,
  workspaceId: string,
  surface: Surface,
  fixtures: SeededFixtures,
): string {
  void fixtures;
  const suffix =
    surface === "variable-sets"
      ? "variable-sets"
      : surface === "documents"
        ? "state?view=files"
        : "state";
  return `${baseUrl}/workspaces/${workspaceId}/${suffix}`;
}

async function openSurface(
  page: Page,
  baseUrl: string,
  workspaceId: string,
  fixtures: SeededFixtures,
  surface: Surface,
  options: { focusMemory?: boolean } = {},
): Promise<void> {
  const url =
    surface === "memory" && options.focusMemory === false
      ? `${baseUrl}/workspaces/${workspaceId}/memory`
      : surfaceUrl(baseUrl, workspaceId, surface, fixtures);
  await page.goto(url);
  const heading = surface === "variable-sets" ? "Variable sets" : "Agent Knowledge";
  await page.getByRole("heading", { level: 1, name: heading, exact: true }).waitFor();
  if (surface === "variable-sets") {
    await page.getByText(longVariableSetName, { exact: true }).waitFor();
    await ensureVariableSetExpanded(page);
  } else if (surface === "documents") {
    await page.getByText("Keep your files here", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Add text", exact: true }).count()).toBe(0);
  } else {
    await page.getByRole("button", { name: "Retained entry 20", exact: true }).waitFor();
  }
}

async function ensureVariableSetExpanded(page: Page): Promise<void> {
  const expanded = page.getByRole("button", {
    name: `Hide variables for ${longVariableSetName}`,
  });
  if ((await expanded.count()) === 0) {
    await page.getByRole("button", { name: `Manage variables for ${longVariableSetName}` }).click();
  }
  await expanded.waitFor();
  expect(await expanded.getAttribute("aria-expanded")).toBe("true");
  await page.getByText(longVariableName, { exact: true }).waitFor();
  expect(
    await page.getByRole("button", { name: `Rotate variable ${lastVariableName}` }).count(),
  ).toBe(1);
}

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
  // Controls use Tailwind color transitions and the canonical token palette
  // allows motion up to 320ms. A fast CI runner can reach Axe after two paints
  // but before the computed foreground settles, producing a false mid-transition
  // contrast failure. Audit and capture only the final theme state.
  await page.waitForTimeout(400);
}

async function resetSurfaceCaptureViewport(page: Page): Promise<void> {
  const contentPage = page.locator("[data-slot='content-page']");
  await contentPage.evaluate((content) => {
    // Deep-linked memory intentionally calls scrollIntoView on its selected
    // card. The app shell uses overflow-hidden flex ancestors, which are still
    // programmatically scrollable, so reset every ancestor rather than only
    // window before capturing whole-surface visual evidence.
    for (let node: HTMLElement | null = content as HTMLElement; node; node = node.parentElement) {
      node.scrollTop = 0;
      node.scrollLeft = 0;
    }
    window.scrollTo(0, 0);
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(heading).not.toBeNull();
  expect(heading!.y).toBeGreaterThanOrEqual(0);
  expect(heading!.y + heading!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
}

async function expectContentPageScrollAndFocus(page: Page, target: Locator): Promise<void> {
  const contentPage = page.locator("[data-slot='content-page']");
  await target.waitFor();
  const initial = await contentPage.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      overscrollBehaviorY: style.overscrollBehaviorY,
      touchAction: style.touchAction,
    };
  });
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
  expect(initial.overflowX).toBe("hidden");
  expect(initial.overflowY).toBe("auto");
  expect(initial.overscrollBehaviorY).toBe("contain");
  expect(initial.touchAction).not.toBe("none");

  await contentPage.evaluate((element) => {
    element.scrollTop = 0;
  });
  const contentBox = await contentPage.boundingBox();
  expect(contentBox).not.toBeNull();
  await page.mouse.move(
    contentBox!.x + contentBox!.width / 2,
    contentBox!.y + contentBox!.height / 2,
  );
  await page.mouse.wheel(0, Math.max(240, contentBox!.height));
  await waitFor(async () => (await contentPage.evaluate((element) => element.scrollTop)) > 0, {
    timeoutMs: 2_000,
    intervalMs: 50,
    describe: () => "content page wheel scroll",
  });
  expect(await contentPage.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await contentPage.evaluate((element) => {
    element.scrollTop = 0;
  });
  await target.focus();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const focused = await target.evaluate((element) => {
    const owner = element.closest<HTMLElement>("[data-slot='content-page']");
    if (!owner) {
      return null;
    }
    const ownerRect = owner.getBoundingClientRect();
    const targetRect = element.getBoundingClientRect();
    return {
      active: document.activeElement === element,
      scrollTop: owner.scrollTop,
      visible: targetRect.top >= ownerRect.top && targetRect.bottom <= ownerRect.bottom,
    };
  });
  expect(focused).not.toBeNull();
  expect(focused!.active).toBe(true);
  expect(focused!.scrollTop).toBeGreaterThan(0);
  expect(focused!.visible).toBe(true);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const audit = await page.evaluate(() => ({
    viewport: window.innerWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(audit.page).toBeLessThanOrEqual(audit.viewport);
}

async function expectNoAxeViolations(
  page: Page,
  include: string,
  auditLabel: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(include)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      audit: auditLabel,
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        html: node.html,
        failureSummary: node.failureSummary,
      })),
    })),
  ).toEqual([]);
}

async function expectOwnedTouchTargets(page: Page, surface: Surface): Promise<void> {
  const targets =
    surface === "variable-sets"
      ? [
          page.getByRole("button", { name: "New variable set", exact: true }),
          page.getByRole("button", { name: /^(Manage|Hide) variables for / }),
        ]
      : surface === "documents"
        ? [] // This fixture has no object store, so file uploads are correctly unavailable.
        : [page.getByRole("button", { name: "Add knowledge", exact: true })];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.width).toBeGreaterThanOrEqual(40);
  }
}
