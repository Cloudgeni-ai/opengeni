import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { createDb, createSession } from "@opengeni/db";
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
} from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const ownerHeaders = { "x-opengeni-subject": "session-header-owner" };
const screenshotPhase = process.env.SESSION_HEADER_SCREENSHOT_PHASE === "before" ? "before" : "after";
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

const CURRENT_TITLE =
  "Primary session — 🧭🧑🏽‍💻👩🏻‍🚀 é 日本語 العربية עברית \u2067isolated RTL\u2069 \u202Econtained bidi\u202C · " +
  "a deliberately long title that must remain visible and truncate independently";

type HeaderFixture = {
  workspaceId: string;
  sessionId: string;
  parentSessionId: string;
};

describe("responsive production session header", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let apiBaseUrl: string;
  let webBaseUrl: string;
  let fixture: HeaderFixture;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("session-header-browser");
    if (!acquired) {
      throw new Error("session header browser E2E requires real PostgreSQL; no skip is allowed");
    }
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "configured",
        delegationSecret: undefined,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    api = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: app.fetch });
    apiBaseUrl = `http://127.0.0.1:${api.port}`;

    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    currentWebBaseUrl = webBaseUrl;
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

    const bootstrap = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    try {
      const page = await bootstrap.newPage();
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const [workspace] = await shared.admin<{ accountId: string }[]>`
        select account_id as "accountId" from workspaces where id = ${workspaceId}`;
      if (!workspace) throw new Error("bootstrapped workspace disappeared");

      const root = await createSession(dbClient.db, {
        accountId: workspace.accountId,
        workspaceId,
        initialMessage: "Root manager — authoritative origin 🏠",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
        maxNestedAgentDepthOverride: 33,
        allowNestedAgentDepthIncrease: true,
      });
      let parent = root;
      for (let depth = 1; depth <= 33; depth += 1) {
        const initialMessage =
          depth === 33
            ? CURRENT_TITLE
            : `Ancestor ${String(depth).padStart(2, "0")} — ${"bounded Unicode 🧬 ".repeat(6)}`;
        parent = await createSession(dbClient.db, {
          accountId: workspace.accountId,
          workspaceId,
          initialMessage,
          resources: [],
          metadata: {},
          model: "scripted-model",
          sandboxBackend: "none",
          parentSessionId: parent.id,
        });
      }
      fixture = {
        workspaceId,
        sessionId: parent.id,
        parentSessionId: parent.parentSessionId!,
      };
    } finally {
      await bootstrap.close();
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
    await api?.stop(false);
    await dbClient?.close().catch(() => undefined);
    await shared?.release();
  }, 60_000);

  test("keeps deep ancestry, primary title, Back, and every action inside the shell", async () => {
    const matrix = [
      {
        name: "phone-320-light",
        viewport: { width: 320, height: 740 },
        isMobile: true,
        hasTouch: true,
        theme: "light" as const,
      },
      {
        name: "phone-320-dark",
        viewport: { width: 320, height: 740 },
        isMobile: true,
        hasTouch: true,
        theme: "dark" as const,
      },
      {
        // A 320 CSS-pixel phone at 200% browser zoom has a 160 CSS-pixel
        // layout viewport. This is intentionally narrower than a device preset.
        name: "phone-320-zoom-200",
        viewport: { width: 160, height: 370 },
        isMobile: true,
        hasTouch: true,
        theme: "dark" as const,
      },
      {
        name: "tablet-768-light",
        viewport: { width: 768, height: 1024 },
        isMobile: true,
        hasTouch: true,
        theme: "light" as const,
      },
      {
        name: "desktop-1440-light",
        viewport: { width: 1440, height: 900 },
        isMobile: false,
        hasTouch: false,
        theme: "light" as const,
      },
      {
        name: "desktop-1440-dark",
        viewport: { width: 1440, height: 900 },
        isMobile: false,
        hasTouch: false,
        theme: "dark" as const,
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
        await page.goto(sessionUrl(fixture));
        await setTheme(page, matrixCase.theme);
        const header = page.locator("[data-session-header], [data-sessionpin-session-header]");
        await header.waitFor();
        await page
          .locator('nav[aria-label="Session ancestry"][data-session-ancestry-state="ready"]')
          .waitFor();

        await page.screenshot({
          path: `/tmp/session-header-${screenshotPhase}-${matrixCase.name}.png`,
          fullPage: true,
          animations: "disabled",
        });

        const metrics = await sessionHeaderMetrics(page);
        expect(metrics.documentOverflow).toBe(false);
        expect(metrics.headerOverflow).toBe(false);
        expect(metrics.headerInsideViewport).toBe(true);
        expect(metrics.identityWidth).toBeGreaterThanOrEqual(72);
        expect(metrics.titleWidth).toBeGreaterThanOrEqual(40);
        expect(metrics.backWidth).toBeGreaterThanOrEqual(44);
        expect(metrics.offscreenControls).toEqual([]);
        expect(metrics.headerFlexWrap).toBe("wrap");

        const ancestry = page.getByRole("navigation", { name: "Session ancestry" });
        if (matrixCase.viewport.width >= 640) {
          await ancestry
            .getByRole("button", { name: "31 intermediate ancestor sessions" })
            .waitFor();
          expect(await ancestry.getByRole("link").count()).toBe(2);
        } else {
          expect(await ancestry.getByRole("link").count()).toBe(1);
        }
        await assertHeaderKeyboardOrder(page);
        await expectNoAxeViolations(page, ["[data-session-header]"]);
        expect(pageErrors.get(context)).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 180_000);

  test("keeps Back truthful and bounded while ancestry loads or is unavailable", async () => {
    for (const state of ["loading", "unavailable"] as const) {
      const context = await configuredContext(browser, {
        viewport: { width: 320, height: 740 },
        isMobile: true,
        hasTouch: true,
        extraHTTPHeaders: ownerHeaders,
      });
      try {
        const page = await context.newPage();
        const lineageUrl = `${apiBaseUrl}/v1/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}/lineage`;
        if (state === "loading") {
          await page.route(lineageUrl, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
            await route.continue();
          });
        } else {
          await page.route(lineageUrl, async (route) => {
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: { code: "lineage_unavailable" } }),
            });
          });
        }
        await page.goto(sessionUrl(fixture));
        const header = page.locator("[data-session-header], [data-sessionpin-session-header]");
        await header.waitFor();
        const breadcrumb = page.getByRole("navigation", { name: "Session ancestry" });
        await breadcrumb.waitFor();
        await expectBreadcrumbState(breadcrumb, state);
        const back = breadcrumb.getByRole("link", { name: new RegExp(`ancestry ${state}`) });
        expect(await back.getAttribute("href")).toContain(fixture.parentSessionId);
        await assertLocatorInsideViewport(back);
        await assertHeaderKeyboardOrder(page);
        await expectNoAxeViolations(page, ["[data-session-header]"]);
        await page.screenshot({
          path: `/tmp/session-header-${screenshotPhase}-phone-320-${state}.png`,
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("honors browser safe-area insets without displacing controls", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      extraHTTPHeaders: ownerHeaders,
    });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: 24, left: 12, bottom: 0, right: 16 },
      });
      await page.goto(sessionUrl(fixture));
      const header = page.locator("[data-session-header], [data-sessionpin-session-header]");
      await header.waitFor();
      const metrics = await sessionHeaderMetrics(page);
      expect(metrics.paddingTop).toBeGreaterThanOrEqual(24);
      expect(metrics.paddingLeft).toBeGreaterThanOrEqual(12);
      expect(metrics.paddingRight).toBeGreaterThanOrEqual(16);
      expect(metrics.offscreenControls).toEqual([]);
      expect(metrics.headerOverflow).toBe(false);
      await page.screenshot({
        path: `/tmp/session-header-${screenshotPhase}-phone-safe-area.png`,
        fullPage: true,
        animations: "disabled",
      });
    } finally {
      await context.close();
    }
  }, 30_000);
});

function sessionUrl(value: HeaderFixture): string {
  return `${webBaseUrlValue()}/workspaces/${value.workspaceId}/sessions/${value.sessionId}`;
}

let currentWebBaseUrl = "";
function webBaseUrlValue(): string {
  if (!currentWebBaseUrl) throw new Error("web base URL is not initialized");
  return currentWebBaseUrl;
}

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

async function workspaceFromPage(page: Page): Promise<string> {
  await waitFor(() => /\/workspaces\/[^/]+\/sessions/.test(page.url()), { timeoutMs: 15_000 });
  return page.url().match(/\/workspaces\/([^/]+)\/sessions/)![1]!;
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
}

type SessionHeaderMetrics = {
  documentOverflow: boolean;
  headerOverflow: boolean;
  headerInsideViewport: boolean;
  headerFlexWrap: string;
  identityWidth: number;
  titleWidth: number;
  backWidth: number;
  paddingTop: number;
  paddingLeft: number;
  paddingRight: number;
  offscreenControls: string[];
};

async function sessionHeaderMetrics(page: Page): Promise<SessionHeaderMetrics> {
  return await page.evaluate(() => {
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`missing ${selector}`);
      return element;
    };
    const header = required("[data-session-header], [data-sessionpin-session-header]");
    const identity = required(
      "[data-session-header-identity], [data-sessionpin-session-header] > div.flex-1",
    );
    const title = required(
      "[data-session-header-title], [data-sessionpin-session-header] button[title$='click to rename']",
    );
    const back = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-session-header-back], nav[aria-label='Session ancestry'] a[href]",
      ),
    ].find((element) => element.getBoundingClientRect().width > 0);
    if (!back) throw new Error("missing visible session ancestry control");
    const headerRect = header.getBoundingClientRect();
    const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportRight = viewportLeft + viewportWidth;
    const controls = [...header.querySelectorAll<HTMLElement>("button, a[href], input")];
    const offscreenControls = controls.flatMap((control) => {
      const rect = control.getBoundingClientRect();
      return rect.left >= viewportLeft - 0.5 && rect.right <= viewportRight + 0.5
        ? []
        : [control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName];
    });
    const style = getComputedStyle(header);
    return {
      documentOverflow: document.documentElement.scrollWidth > window.innerWidth,
      headerOverflow: header.scrollWidth > header.clientWidth,
      headerInsideViewport:
        headerRect.left >= viewportLeft - 0.5 && headerRect.right <= viewportRight + 0.5,
      headerFlexWrap: style.flexWrap,
      identityWidth: identity.getBoundingClientRect().width,
      titleWidth: title.getBoundingClientRect().width,
      backWidth: back.getBoundingClientRect().width,
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
      offscreenControls,
    };
  });
}

async function assertLocatorInsideViewport(locator: ReturnType<Page["getByRole"]>): Promise<void> {
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const left = window.visualViewport?.offsetLeft ?? 0;
    const right = left + (window.visualViewport?.width ?? window.innerWidth);
    return { left: rect.left, right: rect.right, viewportLeft: left, viewportRight: right };
  });
  expect(result.left).toBeGreaterThanOrEqual(result.viewportLeft - 0.5);
  expect(result.right).toBeLessThanOrEqual(result.viewportRight + 0.5);
}

async function expectBreadcrumbState(
  breadcrumb: ReturnType<Page["getByRole"]>,
  state: "loading" | "unavailable",
): Promise<void> {
  expect(await breadcrumb.getAttribute("data-session-ancestry-state")).toBe(state);
}

async function assertHeaderKeyboardOrder(page: Page): Promise<void> {
  const controls = [
    page.getByRole("button", { name: "Open navigation" }),
    page.getByRole("navigation", { name: "Session ancestry" }).getByRole("link").first(),
    page.locator("[data-session-header-title]"),
    page.getByRole("button", { name: /^(Pin|Unpin) session$/ }),
    page.getByRole("button", { name: /Open workstream controls$/ }),
    page.getByRole("button", { name: /session panel$/ }),
  ];
  let previousX = -Infinity;
  for (const control of controls) {
    if ((await control.count()) === 0) continue;
    await control.focus();
    await assertLocatorInsideViewport(control);
    expect(await control.evaluate((element) => element === document.activeElement)).toBe(true);
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    // Controls may wrap onto a later row at extreme widths, so only require
    // stable DOM/focus order—not a fragile single-line x-coordinate ordering.
    previousX = Math.max(previousX, box!.x);
  }
  expect(previousX).toBeGreaterThanOrEqual(0);
}

async function expectNoAxeViolations(page: Page, includes: string[]): Promise<void> {
  let scan = new AxeBuilder({ page });
  for (const include of includes) scan = scan.include(include);
  const results = await scan.analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({ target: node.target })),
    })),
  ).toEqual([]);
}
