#!/usr/bin/env bun
/**
 * Screenshots (and axe checks) of every agent-configuration screen and state,
 * at 390x844, 820x1180 and 1440x900, light and dark, against this worktree's
 * seeded local stack:
 *
 *   bun scripts/dev-seed-design-preview.ts --yes
 *   bun scripts/dev-fake-mcp-server.ts &
 *   bun scripts/dev-seed-agent-config.ts --yes
 *   bun scripts/capture-agent-config-screenshots.ts --out .agent/evidence/ui/pass-1 [--only name,...]
 *
 * Signs in each seeded person once through the web app (Better Auth) and caches
 * the browser state under /tmp. Loading, error and deployment-disabled states
 * are produced by intercepting API responses in the browser; nothing on the
 * server changes. Writes <out>/<scenario>/<width>-<theme>.png and
 * <out>/axe.json (serious and critical violations only).
 */
import AxeBuilder from "@axe-core/playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
  }
  return values;
}
const runtime = readEnvFile(resolve(repositoryRoot, ".env.runtime"));
const WEB = `http://127.0.0.1:${runtime.OPENGENI_WEB_PORT ?? "3000"}`;
const API = `http://127.0.0.1:${runtime.OPENGENI_API_PORT ?? "8000"}`;
const OUT = resolve(repositoryRoot, option("--out") ?? ".agent/evidence/ui/latest");
const ONLY = option("--only")?.split(",");
const VIEWPORTS = (option("--viewports") ?? "390x844,820x1180,1440x900")
  .split(",")
  .map((value) => value.split("x").map(Number) as [number, number]);
const THEMES = (option("--themes") ?? "light,dark").split(",") as ("light" | "dark")[];
const credentialsPath =
  option("--credentials") ?? resolve(homedir(), ".config/opengeni-design-preview/credentials");
const credentials = readEnvFile(credentialsPath);

type User = "owner" | "maria" | "jonas" | "aiko";
const EMAILS: Record<User, string> = {
  owner: credentials.OWNER_EMAIL ?? "bendik@acme.dev",
  maria: "maria@acme.dev",
  jonas: "jonas@acme.dev",
  aiko: "aiko@acme.dev",
};

const verifiedStates = new Map<User, string>();
async function stateFor(browser: Browser, user: User): Promise<string> {
  const cached = verifiedStates.get(user);
  if (cached) return cached;
  const path = `/tmp/og-agent-config-shots-${user}.json`;
  if (existsSync(path)) {
    const context = await browser.newContext({ storageState: path });
    const page = await context.newPage();
    await page.goto(WEB);
    const ok = await page
      .evaluate(async (api) => {
        const response = await fetch(`${api}/v1/auth/get-session`, { credentials: "include" });
        return response.ok && Boolean((await response.json())?.user);
      }, API)
      .catch(() => false);
    await context.close();
    if (ok) {
      verifiedStates.set(user, path);
      return path;
    }
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(WEB);
  await page.locator("input[type=email]").first().fill(EMAILS[user]);
  await page
    .locator("input[type=password]")
    .first()
    .fill(user === "owner" ? credentials.OWNER_PASSWORD! : credentials.PEOPLE_PASSWORD!);
  await page.locator("button[type=submit]").first().click();
  await page.waitForURL(/\/workspaces\//, { timeout: 20_000 });
  await context.storageState({ path });
  await context.close();
  verifiedStates.set(user, path);
  return path;
}

type Ids = {
  support: string;
  lab: string;
  sessions: Record<string, string>;
  labSession: string;
  orgWorkspace: string;
  schedule: string | null;
};

async function resolveIds(browser: Browser): Promise<Ids> {
  const context = await browser.newContext({ storageState: await stateFor(browser, "owner") });
  const page = await context.newPage();
  await page.goto(WEB);
  const ids = await page.evaluate(async (api) => {
    const get = async (path: string) =>
      (await fetch(`${api}${path}`, { credentials: "include" })).json();
    const workspaces: any[] = await get("/v1/workspaces");
    const support = workspaces.find((row) => row.name === "Support desk")?.id;
    const lab = workspaces.find((row) => row.name === "Research lab")?.id;
    const sessions: any[] = await get(`/v1/workspaces/${support}/sessions?limit=100`);
    const labSessions: any[] = await get(`/v1/workspaces/${lab}/sessions?limit=100`);
    const tasks: any[] = await get(`/v1/workspaces/${support}/scheduled-tasks`);
    return {
      support,
      lab,
      sessions: Object.fromEntries(sessions.map((row) => [row.title, row.id])),
      labSession: labSessions[0]?.id,
      orgWorkspace: support,
      schedule: tasks.find((row) => row.name === "Morning ticket digest")?.id ?? null,
    };
  }, API);
  await context.close();
  if (!ids.support || !ids.lab) throw new Error("run scripts/dev-seed-agent-config.ts first");
  return ids as Ids;
}

type Scenario = {
  name: string;
  user?: User;
  path: (ids: Ids) => string;
  /** Browser-side API interception for loading, error and unavailable states. */
  intercept?: (context: BrowserContext, ids: Ids) => Promise<void>;
  steps?: (page: Page, ids: Ids, width: number) => Promise<void>;
  /** Scroll the main scroller to the bottom before the shot. */
  scrollEnd?: boolean;
};

const settle = (page: Page, ms = 600) => page.waitForTimeout(ms);

async function openDockTab(page: Page, tab: string) {
  const open = page.locator('[aria-label="Open workspace"]').first();
  if (await open.isVisible().catch(() => false)) await open.click();
  await settle(page);
  await page.getByRole("tab", { name: tab }).first().click();
  await settle(page, 900);
}

/**
 * Open + > Capabilities with "Customize for this chat" in a known state. The
 * new-chat draft is saved on the server, so a previous run's choice comes back.
 */
async function openComposerCapabilities(page: Page, customized = false) {
  await page.locator('button[aria-label="More composer actions"]').first().click();
  await settle(page);
  await page
    .getByRole("menuitem", { name: /Capabilities/ })
    .first()
    .click();
  await settle(page);
  const toggle = page.getByRole("menuitemcheckbox", { name: "Customize for this chat" }).first();
  if (((await toggle.getAttribute("aria-checked")) === "true") !== customized) {
    await toggle.click();
    await settle(page);
  }
}

/** Hold one lazily loaded module so its loading fallback stays on screen. */
async function holdModule(context: BrowserContext, name: string) {
  await context.route(new RegExp(`${name}\\.tsx`), async () => {
    await new Promise(() => {});
  });
}

/** Mark capabilities as not offered by this server in the client config. */
async function unavailableCapabilities(context: BrowserContext, ids: string[]) {
  await context.route(`${API}/v1/config/client**`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (!body?.agentConfig) return route.fulfill({ response });
    body.agentConfig.capabilities = body.agentConfig.capabilities.map((entry: any) =>
      ids.includes(entry.id)
        ? { ...entry, available: false, reason: "turned off on this server" }
        : entry,
    );
    await route.fulfill({ response, json: body });
  });
}

const SCENARIOS: Scenario[] = [
  // 1. Workspace settings > General > New session defaults > Agent
  {
    name: "settings-general-row",
    path: (ids) => `/workspaces/${ids.support}/settings`,
    steps: async (page) => {
      await page.getByText("New session defaults").first().scrollIntoViewIfNeeded();
      await settle(page);
    },
  },
  {
    name: "defaults-customized",
    path: (ids) => `/workspaces/${ids.support}/settings?section=general&view=agent-defaults`,
  },
  {
    name: "defaults-customized-identity",
    path: (ids) => `/workspaces/${ids.support}/settings?section=general&view=agent-defaults`,
    scrollEnd: true,
  },
  {
    name: "defaults-untouched",
    path: (ids) => `/workspaces/${ids.lab}/settings?section=general&view=agent-defaults`,
  },
  {
    name: "defaults-editing-dirty",
    path: (ids) => `/workspaces/${ids.lab}/settings?section=general&view=agent-defaults`,
    steps: async (page) => {
      await page.locator('[data-capability="browser"] input[type=checkbox]').uncheck();
      await page.locator('[data-capability="media"] input[type=checkbox]').uncheck();
      await settle(page);
    },
  },
  {
    name: "defaults-member-readonly",
    user: "jonas",
    path: (ids) => `/workspaces/${ids.support}/settings?section=general&view=agent-defaults`,
  },
  {
    name: "defaults-deployment-disabled",
    path: (ids) => `/workspaces/${ids.lab}/settings?section=general&view=agent-defaults`,
    intercept: (context) => unavailableCapabilities(context, ["webSearch", "browser"]),
  },
  {
    name: "defaults-save-error",
    path: (ids) => `/workspaces/${ids.lab}/settings?section=general&view=agent-defaults`,
    intercept: async (context, ids) => {
      await context.route(`${API}/v1/workspaces/${ids.lab}/settings`, async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "boom" }),
        });
      });
    },
    steps: async (page) => {
      await page.locator('[data-capability="media"] input[type=checkbox]').uncheck();
      await page.getByRole("button", { name: "Save" }).click();
      await settle(page, 1200);
    },
    scrollEnd: true,
  },
  {
    name: "defaults-loading",
    path: (ids) => `/workspaces/${ids.lab}/settings?section=general&view=agent-defaults`,
    intercept: (context) => holdModule(context, "session-defaults-page"),
  },

  // 2. Composer + > Capabilities
  {
    name: "composer-capabilities-default",
    path: (ids) => `/workspaces/${ids.support}/sessions`,
    steps: (page) => openComposerCapabilities(page),
  },
  {
    name: "composer-capabilities-customized",
    path: (ids) => `/workspaces/${ids.support}/sessions`,
    steps: async (page) => {
      await openComposerCapabilities(page, true);
      await page.getByRole("menuitemcheckbox", { name: "Web search" }).first().click();
      await page.getByRole("menuitemcheckbox", { name: "Workspace connectors" }).first().click();
      await settle(page);
    },
  },
  {
    name: "composer-connectors-nested",
    path: (ids) => `/workspaces/${ids.support}/sessions`,
    steps: async (page) => {
      await openComposerCapabilities(page, true);
      await page.getByRole("menuitemcheckbox", { name: "Workspace connectors" }).first().click();
      await settle(page);
      await page.getByRole("menuitem", { name: "Choose connected apps" }).first().click();
      await settle(page, 1200);
    },
  },
  {
    name: "composer-chip",
    path: (ids) => `/workspaces/${ids.support}/sessions`,
    steps: async (page) => {
      await openComposerCapabilities(page, true);
      await page.getByRole("menuitemcheckbox", { name: "Web search" }).first().click();
      await page.keyboard.press("Escape");
      await settle(page, 900);
    },
  },
  {
    name: "composer-no-connectors",
    path: (ids) => `/workspaces/${ids.lab}/sessions`,
    steps: async (page) => {
      await openComposerCapabilities(page, true);
    },
  },
  {
    name: "composer-deployment-disabled",
    path: (ids) => `/workspaces/${ids.lab}/sessions`,
    intercept: (context) => unavailableCapabilities(context, ["webSearch", "media"]),
    steps: (page) => openComposerCapabilities(page),
  },

  // 3. Session dock > Agent
  {
    name: "session-agent-all",
    path: (ids) =>
      `/workspaces/${ids.support}/sessions/${ids.sessions["Everything the workspace offers"]}`,
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-none",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Only its own tools"]}`,
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-custom-identity",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Ticket triage assistant"]}`,
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-technical-details",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Ticket triage assistant"]}`,
    steps: async (page) => {
      await openDockTab(page, "Agent");
      await page
        .getByRole("button", { name: /Technical details/ })
        .first()
        .click();
      await settle(page);
      await page
        .getByRole("button", { name: /Technical details/ })
        .first()
        .scrollIntoViewIfNeeded();
    },
  },
  {
    name: "session-agent-legacy",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Legacy session"]}`,
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-legacy-edit",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Legacy session"]}`,
    steps: async (page) => {
      await openDockTab(page, "Agent");
      await page.getByRole("button", { name: "Edit" }).first().click();
      await settle(page);
    },
  },
  {
    name: "session-agent-edit",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Changed mid-session"]}`,
    steps: async (page) => {
      await openDockTab(page, "Agent");
      await page.getByRole("button", { name: "Edit" }).first().click();
      await settle(page);
      await page.locator('[data-capability="webSearch"] input[type=checkbox]').uncheck();
      await settle(page);
    },
  },
  {
    name: "session-agent-edit-conflict",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Changed mid-session"]}`,
    intercept: async (context) => {
      await context.route(/\/sessions\/[^/]+\/agent$/, async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "TOOL_POLICY_VERSION_CONFLICT", message: "stale" }),
        });
      });
    },
    steps: async (page) => {
      await openDockTab(page, "Agent");
      await page.getByRole("button", { name: "Edit" }).first().click();
      await page.locator('[data-capability="webSearch"] input[type=checkbox]').uncheck();
      await page.getByRole("button", { name: "Save" }).last().click();
      await settle(page, 1500);
    },
  },
  {
    name: "session-agent-viewer",
    user: "aiko",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Ticket triage assistant"]}`,
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-child",
    path: (ids) =>
      `/workspaces/${ids.support}/sessions/${ids.sessions["Research customer sentiment"]}`,
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-markdown-renderer",
    path: (ids) =>
      `/workspaces/${ids.support}/sessions/${ids.sessions["Slack: weekly ticket volume"]}`,
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-no-connectors",
    path: (ids) => `/workspaces/${ids.lab}/sessions/${ids.labSession}`,
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-loading",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Ticket triage assistant"]}`,
    intercept: (context) => holdModule(context, "agent-configuration-panel"),
    steps: (page) => openDockTab(page, "Agent"),
  },
  {
    name: "session-agent-updated-event",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Changed mid-session"]}`,
    steps: (page) => openDockTab(page, "Agent"),
  },

  // 4. Model-context inspector: instruction sections
  {
    name: "inspector-instruction-sections",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Ticket triage assistant"]}`,
    steps: async (page) => {
      await openDockTab(page, "Debug");
      await page.getByRole("tab", { name: "Context" }).first().click();
      await settle(page, 1200);
      await page
        .getByRole("button", { name: /^Instructions/ })
        .first()
        .click();
      await settle(page, 900);
    },
  },
  {
    name: "inspector-module-open",
    path: (ids) => `/workspaces/${ids.support}/sessions/${ids.sessions["Ticket triage assistant"]}`,
    steps: async (page) => {
      await openDockTab(page, "Debug");
      await page.getByRole("tab", { name: "Context" }).first().click();
      await settle(page, 1200);
      await page
        .getByRole("button", { name: /^Instructions/ })
        .first()
        .click();
      await settle(page, 600);
      await page.locator('[data-instruction-section="operational_contract:knowledge"]').click();
      await settle(page, 900);
    },
  },

  // 5. Schedule form
  {
    name: "schedule-new-capabilities",
    path: (ids) => `/workspaces/${ids.support}/schedules/new`,
    steps: async (page) => {
      await page
        .getByRole("button", { name: /What the agent can do/ })
        .first()
        .click();
      await settle(page);
      await page
        .getByRole("button", { name: /What the agent can do/ })
        .first()
        .scrollIntoViewIfNeeded();
    },
  },
  {
    name: "schedule-new-custom",
    path: (ids) => `/workspaces/${ids.support}/schedules/new`,
    steps: async (page) => {
      await page
        .getByRole("button", { name: /What the agent can do/ })
        .first()
        .click();
      await settle(page);
      await page.getByRole("radio", { name: "Choose for this schedule" }).first().click();
      await settle(page);
      await page
        .getByRole("button", { name: /What the agent can do/ })
        .first()
        .scrollIntoViewIfNeeded();
    },
  },
  {
    name: "schedule-edit-saved-agent",
    path: (ids) => `/workspaces/${ids.support}/schedules/${ids.schedule}/edit`,
    steps: async (page) => {
      await page
        .getByRole("button", { name: /What the agent can do/ })
        .first()
        .click();
      await settle(page);
      await page
        .getByRole("button", { name: /What the agent can do/ })
        .first()
        .scrollIntoViewIfNeeded();
    },
  },

  // 6. Knowledge > Instructions
  {
    name: "instructions-identity",
    path: (ids) => `/workspaces/${ids.support}/state?view=instructions`,
  },
  {
    name: "instructions-default-identity",
    path: (ids) => `/workspaces/${ids.lab}/state?view=instructions`,
  },
  {
    name: "instructions-viewer",
    user: "aiko",
    path: (ids) => `/workspaces/${ids.support}/state?view=instructions`,
  },

  // 7. Organization API keys quick start
  {
    name: "org-api-keys-quick-start",
    path: (ids) => `/workspaces/${ids.orgWorkspace}/organization?section=developer`,
    steps: async (page) => {
      await page
        .getByRole("button", { name: /Integration guide/ })
        .first()
        .click();
      await settle(page);
      await page.locator("pre code").first().scrollIntoViewIfNeeded();
    },
  },
];

async function scrollMainToEnd(page: Page) {
  await page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll<HTMLElement>("main, [data-slot=scroll-area-viewport], *"),
    ]
      .filter((element) => element.scrollHeight > element.clientHeight + 40)
      .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowY));
    const target = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0];
    if (target) target.scrollTop = target.scrollHeight;
    else window.scrollTo(0, document.body.scrollHeight);
  });
  await settle(page);
}

const browser = await chromium.launch();
const ids = await resolveIds(browser);
mkdirSync(OUT, { recursive: true });
const axeResults: Record<string, unknown[]> = {};
const failures: string[] = [];
const CONCURRENCY = Number(option("--concurrency") ?? 4);
type Job = { scenario: Scenario; width: number; height: number; theme: "light" | "dark" };
const jobs: Job[] = [];
for (const scenario of SCENARIOS) {
  if (ONLY && !ONLY.includes(scenario.name)) continue;
  await stateFor(browser, scenario.user ?? "owner");
  mkdirSync(resolve(OUT, scenario.name), { recursive: true });
  for (const [width, height] of VIEWPORTS) {
    for (const theme of THEMES) jobs.push({ scenario, width, height, theme });
  }
}

async function runJob({ scenario, width, height, theme }: Job) {
  const storageState = await stateFor(browser, scenario.user ?? "owner");
  const context = await browser.newContext({
    storageState,
    viewport: { width, height },
    colorScheme: theme,
    hasTouch: width < 1024,
    deviceScaleFactor: 1,
  });
  await scenario.intercept?.(context, ids);
  const page = await context.newPage();
  const file = resolve(OUT, scenario.name, `${width}-${theme}.png`);
  try {
    await page.goto(`${WEB}${scenario.path(ids)}`, { waitUntil: "load" });
    // The app keeps event streams open, so wait for content, not network idle.
    await page
      .locator("main, [data-slot=form-body], [role=main]")
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    await settle(page, 1800);
    await scenario.steps?.(page, ids, width);
    if (scenario.scrollEnd) await scrollMainToEnd(page);
    await page.screenshot({ path: file });
    if (theme === "light") {
      // With a menu or dialog open, Radix hides the page behind it from
      // assistive tech; check what is actually reachable.
      const overlay = (await page.locator('[role="menu"], [role="dialog"]').count()) > 0;
      let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
      if (overlay) builder = builder.include('[role="menu"], [role="dialog"]');
      const result = await builder.analyze();
      const serious = result.violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
      if (serious.length) {
        axeResults[`${scenario.name}@${width}`] = serious.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
          why: violation.nodes[0]?.failureSummary?.slice(0, 400),
        }));
      }
    }
    console.log(`ok ${scenario.name} ${width} ${theme}`);
  } catch (error) {
    failures.push(`${scenario.name} ${width} ${theme}: ${(error as Error).message.split("\n")[0]}`);
    await page.screenshot({ path: file }).catch(() => {});
    console.log(`FAIL ${scenario.name} ${width} ${theme}`);
  } finally {
    await context.close();
  }
}

let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) await runJob(jobs[next++]!);
  }),
);
await browser.close();
writeFileSync(resolve(OUT, "axe.json"), `${JSON.stringify(axeResults, null, 2)}\n`);
writeFileSync(resolve(OUT, "failures.txt"), failures.join("\n") + "\n");
console.log(
  `\n${failures.length} failures; axe serious/critical in ${Object.keys(axeResults).length} shots`,
);
console.log(`Screenshots: ${OUT}`);
