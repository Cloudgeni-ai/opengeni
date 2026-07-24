import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { createDb } from "@opengeni/db";
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
  type Page,
  type Route,
} from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const ownerHeaders = { "x-opengeni-subject": "knowledge-surfaces-owner" };
const secretSentinel = "KNOWLEDGE-SECRET-MUST-NEVER-RENDER-7d9d5d";
const longVariableName = `KNOWLEDGE_${"RESPONSIVE_INSPECTABLE_VARIABLE_".repeat(5)}`.slice(0, 128);
const longVariableSetName =
  `Responsive production variable set ${"with long context ".repeat(6)}`.slice(0, 120);
const longBaseName = `Long document base ${"inspectable-title-".repeat(7)}`;
const activeMemoryText =
  "Active memory: keep responsive knowledge surfaces compact, deeply inspectable, and keyboard operable. " +
  "This intentionally long record proves ordinary prose wraps without hiding the durable fact. ".repeat(
    4,
  );
const unbrokenMemoryText = `Overflow sentinel ${"unbrokenresponsiveknowledge".repeat(18)}`;
const proposedMemoryText =
  "Proposed memory awaiting a human decision with approve and reject controls.";

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
      throw new Error("Knowledge-surface browser acceptance requires real PostgreSQL; no skip is allowed");
    }
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "configured",
        delegationSecret: undefined,
        environmentsEncryptionKey: Buffer.alloc(32, 15).toString("base64"),
        documentEmbeddingProvider: "deterministic",
      }),
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

  test("ships first-class, responsive, accessible variable sets, documents, and memory", async () => {
    const bootstrap = await configuredContext(browser, {
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: ownerHeaders,
    });
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
      const context = await configuredContext(browser, {
        viewport: matrixCase.viewport,
        isMobile: matrixCase.isMobile,
        hasTouch: matrixCase.hasTouch,
        extraHTTPHeaders: ownerHeaders,
      });
      try {
        const page = await context.newPage();
        for (const theme of ["light", "dark"] as const) {
          for (const surface of ["variable-sets", "documents", "memory"] as const) {
            await openSurface(page, webBaseUrl, workspaceId, fixtures, surface);
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
            if (matrixCase.label === "desktop") {
              const workspaceNav = page.getByRole("navigation", { name: "Workspace" });
              await workspaceNav.getByRole("link", { name: "Memory", exact: true }).waitFor();
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

  async function exerciseTruthfulStates(
    page: Page,
    workspaceId: string,
    fixtures: SeededFixtures,
  ): Promise<void> {
    // Loading is observed while a genuine list request is held, then the same
    // request continues to the real backend and resolves into the empty state.
    const basesPattern = new RegExp(`/v1/workspaces/${workspaceId}/document-bases(?:\\?.*)?$`);
    let releaseBases!: () => void;
    let sawBasesRequest!: () => void;
    const basesGate = new Promise<void>((resolve) => {
      releaseBases = resolve;
    });
    const basesRequest = new Promise<void>((resolve) => {
      sawBasesRequest = resolve;
    });
    const delayedBases = async (route: Route) => {
      sawBasesRequest();
      await basesGate;
      await route.continue();
    };
    await page.route(basesPattern, delayedBases);
    await page.goto(surfaceUrl(webBaseUrl, workspaceId, "documents", fixtures));
    await basesRequest;
    await page.getByText("Loading bases", { exact: true }).waitFor();
    releaseBases();
    await page.getByText("No documents yet", { exact: true }).waitFor();
    await page.unroute(basesPattern, delayedBases);
    expect(await page.getByRole("heading", { name: "Working set" }).count()).toBe(0);

    // A single injected transport failure proves the honest Memory error and
    // retry state. Retry is then allowed through to the same real API data.
    const memoryListPattern = new RegExp(
      `/v1/workspaces/${workspaceId}/knowledge/memories(?:\\?.*)?$`,
    );
    let failMemoryRequests = true;
    const failMemory = async (route: Route) => {
      if (failMemoryRequests && route.request().method() === "GET") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Intentional knowledge-list failure" }),
        });
        return;
      }
      await route.continue();
    };
    await page.route(memoryListPattern, failMemory);
    await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/memory`);
    await page.getByText("Couldn't load memory", { exact: true }).waitFor();
    failMemoryRequests = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText(activeMemoryText, { exact: true }).waitFor();
    await page.unroute(memoryListPattern, failMemory);

    // Archived is deliberately empty; this must not be confused with loading
    // or the failed state above.
    await page.getByRole("combobox", { name: "Memory status" }).selectOption("archived");
    await page.getByText("No archived memory.", { exact: true }).waitFor();
  }

  async function exerciseKeyboardAndDisclosure(
    page: Page,
    workspaceId: string,
    fixtures: SeededFixtures,
  ): Promise<void> {
    // Memory was previously embedded in Documents. Existing copied links and
    // bookmarks must migrate to the first-class surface without losing focus.
    await page.goto(
      `${webBaseUrl}/workspaces/${workspaceId}/documents?memory=${fixtures.proposedMemoryId}`,
    );
    await page.waitForURL(
      `${webBaseUrl}/workspaces/${workspaceId}/memory?memory=${fixtures.proposedMemoryId}`,
    );
    await page.getByRole("heading", { level: 1, name: "Memory", exact: true }).waitFor();
    const focusedMemory = page.locator(
      `[data-memory-id="${fixtures.proposedMemoryId}"][data-highlighted="true"]`,
    );
    await focusedMemory.waitFor();
    expect(await focusedMemory.textContent()).toContain(proposedMemoryText);

    await page.goto(surfaceUrl(webBaseUrl, workspaceId, "variable-sets", fixtures));
    await page.getByText(longVariableSetName, { exact: true }).waitFor();
    const manage = page.getByRole("button", {
      name: `Show variables for ${longVariableSetName}`,
    });
    expect((await manage.textContent())?.trim()).toBe("Show");
    await manage.focus();
    await page.keyboard.press("Enter");
    const expandedManage = page.getByRole("button", {
      name: `Hide variables for ${longVariableSetName}`,
    });
    expect(await expandedManage.getAttribute("aria-expanded")).toBe("true");
    await page.getByText(longVariableName, { exact: true }).waitFor();
    expect(await page.getByLabel("Value is write-only").textContent()).toContain("••••••");
    expect(
      await page.evaluate(
        (sentinel) =>
          (document.body.textContent ?? "").includes(sentinel) ||
          [...document.querySelectorAll("input")].some((input) => input.value.includes(sentinel)),
        secretSentinel,
      ),
    ).toBe(false);

    await page.goto(surfaceUrl(webBaseUrl, workspaceId, "memory", fixtures));
    await page.getByText(proposedMemoryText, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
    await page.getByRole("button", { name: "Reject", exact: true }).waitFor();
    const addMemory = page.getByRole("button", { name: "Add memory", exact: true });
    await addMemory.focus();
    await page.keyboard.press("Enter");
    expect(await addMemory.getAttribute("aria-expanded")).toBe("true");
    const memoryText = page.getByRole("textbox", { name: "Memory text" });
    await memoryText.waitFor();
    expect(await memoryText.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectNoPageOverflow(page);
  }
});

type SeededFixtures = {
  proposedMemoryId: string;
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
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  const problems: string[] = [];
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
    const url = new URL(response.url());
    // This one response is the explicit error-state fixture above.
    if (response.status() === 503 && /\/knowledge\/memories$/.test(url.pathname)) return;
    problems.push(
      `response ${response.status()}: ${response.request().method()} ${response.url()}`,
    );
  });
  context.on("console", (message) => {
    if (message.type() !== "error") return;
    // HTTP failures are recorded with their URL by the response listener. The
    // only allowed 503 is the explicit Memory error-state fixture above.
    if (
      message.text() ===
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
    ) {
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

      await request(`/v1/workspaces/${targetWorkspaceId}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ memoryEnabled: true }),
      });
      await request(`/v1/workspaces/${targetWorkspaceId}/variable-sets`, {
        method: "POST",
        body: JSON.stringify({
          name: fixture.longVariableSetName,
          description:
            "A deliberately long description that remains fully inspectable on compact viewports without widening the page.",
          variables: [{ name: fixture.longVariableName, value: fixture.secretSentinel }],
        }),
      });
      for (const name of [fixture.longBaseName, "Empty document base"]) {
        await request(`/v1/workspaces/${targetWorkspaceId}/document-bases`, {
          method: "POST",
          body: JSON.stringify({ name }),
        });
      }
      for (const text of [fixture.activeMemoryText, fixture.unbrokenMemoryText]) {
        await request(`/v1/workspaces/${targetWorkspaceId}/knowledge/memories`, {
          method: "POST",
          body: JSON.stringify({ status: "active", kind: "semantic", text, confidence: 0.9 }),
        });
      }
      const proposed = await request<{ id: string }>(
        `/v1/workspaces/${targetWorkspaceId}/knowledge/memories`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "proposed",
            kind: "decision",
            text: fixture.proposedMemoryText,
            confidence: 0.75,
          }),
        },
      );
      return { proposedMemoryId: proposed.id };
    },
    {
      apiBaseUrl,
      workspaceId,
      fixture: {
        secretSentinel,
        longVariableName,
        longVariableSetName,
        longBaseName,
        activeMemoryText,
        unbrokenMemoryText,
        proposedMemoryText,
      },
    },
  );
}

function surfaceUrl(
  baseUrl: string,
  workspaceId: string,
  surface: Surface,
  fixtures: SeededFixtures,
): string {
  const search = surface === "memory" ? `?memory=${fixtures.proposedMemoryId}` : "";
  return `${baseUrl}/workspaces/${workspaceId}/${surface}${search}`;
}

async function openSurface(
  page: Page,
  baseUrl: string,
  workspaceId: string,
  fixtures: SeededFixtures,
  surface: Surface,
): Promise<void> {
  await page.goto(surfaceUrl(baseUrl, workspaceId, surface, fixtures));
  const heading =
    surface === "variable-sets"
      ? "Variable sets"
      : surface === "documents"
        ? "Documents"
        : "Memory";
  await page.getByRole("heading", { level: 1, name: heading, exact: true }).waitFor();
  if (surface === "variable-sets") {
    await page.getByText(longVariableSetName, { exact: true }).waitFor();
    const manage = page.getByRole("button", { name: /^Show variables for / });
    await manage.click();
    await page.getByText(longVariableName, { exact: true }).waitFor();
  } else if (surface === "documents") {
    await page.getByText(longBaseName, { exact: true }).waitFor();
    await page.getByText("No documents yet", { exact: true }).waitFor();
    const bases = page.getByRole("complementary", { name: "Bases", exact: true });
    const search = page.getByRole("complementary", { name: "Search", exact: true });
    await bases.waitFor();
    await search.waitFor();
    await search.getByRole("textbox", { name: "ACL tags", exact: true }).waitFor();
    expect(await page.getByRole("heading", { name: "Working set" }).count()).toBe(0);
  } else {
    await page.getByText(proposedMemoryText, { exact: true }).waitFor();
  }
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
          page.getByRole("button", { name: /^(Show|Hide) variables for / }),
        ]
      : surface === "documents"
        ? [
            page.getByRole("button", { name: "Create base", exact: true }),
            page.getByRole("button", { name: longBaseName, exact: true }),
          ]
        : [
            page.getByRole("button", { name: "Add memory", exact: true }),
            page.getByRole("button", { name: "Approve", exact: true }),
            page.getByRole("button", { name: "Reject", exact: true }),
          ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.width).toBeGreaterThanOrEqual(40);
  }
}
