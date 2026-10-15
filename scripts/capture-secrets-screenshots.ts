#!/usr/bin/env bun
/**
 * Screenshots plus machine checks of every Secrets screen and state (design
 * §13A.2 S1–S16, §13A.3, §13A.5) at every viewport and theme, for the five UI
 * review passes.
 *
 *   bun --no-env-file scripts/capture-secrets-screenshots.ts --stack sv-w7 \
 *     --out .agent/evidence/UI/pass-<n> [--base http://127.0.0.1:47200] [--api <url>] \
 *     [--viewports 390x844,820x1180,1440x900] [--themes light,dark] [--states 'S1-*,S3-*'] \
 *     [--user owner] [--concurrency 3] [--list] [--mock]
 *
 * - Login reuses the localstack `login.ts` storage states (run/auth-<stack>-<user>.json);
 *   other seeded people (for example tom@acme.dev) sign in through the form with the
 *   seed password from localstack/seed-credentials.
 * - State control: real seeded data first (§13B.1); Playwright `route` only for
 *   transient states (loading delay, injected 500/503, rate limit); `page.clock`
 *   pinned at 2026-10-12T12:00:10Z for TOTP and relative times.
 * - A state whose product surface is not present yet (no vault API or no Secrets
 *   route) is recorded as `pending` with the reason instead of a misleading shot;
 *   anchor states on today's screens (composer, schedule form, capabilities,
 *   variable sets) are captured now so the script itself is exercised.
 * - Output: <screen>-<state>-<vw>x<vh>-<theme>.png and index.json with the state
 *   description, axe (serious/critical), overflow, hit-target, primary-button and
 *   H1 checks per shot.
 * - `--mock` (W3): the web app's DEV-only secrets mock answers the vault routes
 *   in the page (localStorage og-dev-secrets-mock=1, plus a role and scenario per
 *   state), ids come from its fixtures, and transient states use mock scenarios
 *   instead of Playwright routes. Needs a Vite dev server, not a production build.
 */
import AxeBuilder from "@axe-core/playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";

const LS = process.env.F598_LS ?? "/workspace/sessions/f5980f29/localstack";
const API_CONTRACT = "2026-09-plugins-and-skills-v1";

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^['"]|['"]$/gu, "");
  }
  return values;
}

const { values: flags } = parseArgs({
  options: {
    stack: { type: "string" },
    base: { type: "string" },
    api: { type: "string" },
    out: { type: "string", default: ".agent/evidence/UI/latest" },
    viewports: { type: "string", default: "390x844,820x1180,1440x900" },
    themes: { type: "string", default: "light,dark" },
    states: { type: "string", default: "*" },
    user: { type: "string", default: "owner" },
    concurrency: { type: "string", default: "3" },
    list: { type: "boolean", default: false },
    mock: { type: "boolean", default: false },
  },
});
// Mock fixtures are dated around this fixed instant; real seeded rows are
// dated around the stack's start, so real captures pin the clock to now.
const CLOCK = flags.mock
  ? new Date("2026-10-12T12:00:10Z")
  : new Date(Math.floor(Date.now() / 60_000) * 60_000 + 10_000);

const stackEnv = flags.stack ? readEnvFile(join(LS, "run", `stack-${flags.stack}.env`)) : {};
const WEB = flags.base ?? stackEnv.F598_WEB ?? "http://127.0.0.1:3000";
const API =
  flags.api ?? stackEnv.F598_API ?? WEB.replace(/:(\d+)$/u, (_m, port) => `:${Number(port) + 1}`);
const OUT = resolve(flags.out!);
const VIEWPORTS = flags
  .viewports!.split(",")
  .map((value) => value.split("x").map(Number) as [number, number]);
const THEMES = flags.themes!.split(",") as ("light" | "dark")[];
const CONCURRENCY = Math.max(1, Math.min(6, Number(flags.concurrency)));

// --- people -------------------------------------------------------------------

const ROLE_EMAIL: Record<string, string> = {
  owner: "bendik@acme.dev",
  admin: "maria@acme.dev",
  member: "jonas@acme.dev",
  viewer: "aiko@acme.dev",
  tom: "tom@acme.dev",
  priya: "priya@acme.dev",
};
const seedCredentials = readEnvFile(join(LS, "seed-credentials"));
const states = new Map<string, string>();

async function storageStateFor(browser: Browser, user: string): Promise<string> {
  const cached = states.get(user);
  if (cached) return cached;
  const harnessState = flags.stack ? join(LS, "run", `auth-${flags.stack}-${user}.json`) : "";
  if (harnessState && existsSync(harnessState)) {
    states.set(user, harnessState);
    return harnessState;
  }
  const email = ROLE_EMAIL[user] ?? user;
  const password =
    email === (seedCredentials.OWNER_EMAIL ?? "bendik@acme.dev")
      ? seedCredentials.OWNER_PASSWORD
      : seedCredentials.PEOPLE_PASSWORD;
  if (!password) throw new Error(`no seed password for ${email} (localstack/seed-credentials)`);
  const path = join(OUT, ".auth", `${user.replace(/[^a-z0-9]/giu, "_")}.json`);
  mkdirSync(join(OUT, ".auth"), { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(WEB);
  await page.locator("input[type=email]").first().fill(email);
  await page.locator("input[type=password]").first().fill(password);
  await page.locator("button[type=submit]").first().click();
  await page.waitForURL(/\/workspaces\//u, { timeout: 30_000 });
  await context.storageState({ path });
  await context.close();
  states.set(user, path);
  return path;
}

// --- seeded ids -----------------------------------------------------------------

type Ids = {
  workspaces: Record<string, string>;
  ws: string;
  vaultsApi: boolean;
  secretsRoute: boolean;
  vaults: Record<string, string>;
  items: Record<string, { vault: string; item: string }>;
  sessions: Record<string, string>;
  schedules: Record<string, string>;
  variableSets: Record<string, string>;
  /** Mock connections by provider (1Password: the workspace one). */
  connections: Record<string, string>;
};

// Mock roles: the in-page mock decides what each person may do.
const MOCK_ROLE: Record<string, string> = {
  owner: "owner",
  admin: "admin",
  member: "member",
  viewer: "viewer",
  tom: "viewer",
};

async function mockInit(context: BrowserContext, role: string, scenario: string) {
  await context.addInitScript(
    ([mockRole, mockScenario]) => {
      window.localStorage.setItem("og-dev-secrets-mock", "1");
      window.localStorage.setItem("og-dev-secrets-mock-role", mockRole!);
      window.localStorage.setItem("og-dev-secrets-mock-scenario", mockScenario!);
    },
    [role, scenario],
  );
}

async function resolveIds(browser: Browser): Promise<Ids> {
  const context = await browser.newContext({
    storageState: await storageStateFor(browser, "owner"),
  });
  if (flags.mock) await mockInit(context, "owner", "");
  const page = await context.newPage();
  await page.goto(WEB);
  const ids = await page.evaluate(
    async ({ api, contract }) => {
      const get = async (path: string) => {
        const response = await fetch(`${api}${path}`, {
          credentials: "include",
          headers: { "x-opengeni-api-contract": contract },
        });
        return { status: response.status, body: response.ok ? await response.json() : null };
      };
      const workspaces: any[] = (await get("/v1/workspaces")).body ?? [];
      const byName = Object.fromEntries(workspaces.map((row) => [row.name, row.id]));
      const ws = byName["Platform engineering"] ?? workspaces[0]?.id;
      const vaults = await get(`/v1/workspaces/${ws}/vaults`);
      const vaultRows: any[] = vaults.body?.vaults ?? [];
      const items: Record<string, { vault: string; item: string }> = {};
      for (const vault of vaultRows.slice(0, 20)) {
        const listed = await get(`/v1/workspaces/${ws}/vaults/${vault.id}/items?limit=200`);
        for (const item of (listed.body?.items ?? []) as any[]) {
          items[`${vault.name}/${item.name}`] = { vault: vault.id, item: item.id };
        }
      }
      const sessionsBody = (await get(`/v1/workspaces/${ws}/sessions?limit=200`)).body;
      const sessions: any[] = Array.isArray(sessionsBody)
        ? sessionsBody
        : (sessionsBody?.sessions ?? []);
      const schedulesBody = (await get(`/v1/workspaces/${ws}/scheduled-tasks`)).body;
      const schedules: any[] = Array.isArray(schedulesBody)
        ? schedulesBody
        : (schedulesBody?.tasks ?? []);
      const setsBody = (await get(`/v1/workspaces/${ws}/variable-sets`)).body;
      const sets: any[] = Array.isArray(setsBody)
        ? setsBody
        : (setsBody?.variableSets ?? setsBody?.items ?? []);
      return {
        workspaces: byName,
        ws,
        vaultsApi: vaults.status === 200,
        vaults: Object.fromEntries(vaultRows.map((row) => [row.name, row.id])),
        items,
        sessions: Object.fromEntries(sessions.map((row) => [row.title ?? row.id, row.id])),
        schedules: Object.fromEntries(schedules.map((row) => [row.name, row.id])),
        variableSets: Object.fromEntries(sets.map((row) => [row.name, row.id])),
      };
    },
    { api: API, contract: API_CONTRACT },
  );
  // The Secrets route exists when its page renders the Secrets heading.
  await page.goto(`${WEB}/workspaces/${ids.ws}/secrets`);
  const secretsRoute = await page
    .getByRole("heading", { level: 1, name: "Secrets" })
    .waitFor({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  await context.close();
  if (!flags.mock) return { ...ids, secretsRoute } as Ids;
  const fixtures = await import(
    resolve(import.meta.dir, "../apps/web/src/dev/secrets-mock/fixtures.ts")
  );
  const mock = fixtures.buildMockState(ids.ws);
  const vaultName = new Map<string, string>(
    mock.vaults.map((row: { id: string; name: string }) => [row.id, row.name]),
  );
  const anySession = Object.values(ids.sessions)[0];
  return {
    ...ids,
    secretsRoute,
    vaultsApi: true,
    vaults: Object.fromEntries(
      mock.vaults.map((row: { id: string; name: string }) => [row.name, row.id]),
    ),
    items: Object.fromEntries(
      mock.items.map((row: { id: string; vaultId: string; name: string }) => [
        `${vaultName.get(row.vaultId)}/${row.name}`,
        { vault: row.vaultId, item: row.id },
      ]),
    ),
    connections: Object.fromEntries(
      [...mock.connections]
        .reverse()
        .map((row: { id: string; provider: string }) => [row.provider, row.id]),
    ),
    // The panel's data is mocked per session, so any real session hosts it.
    sessions: anySession
      ? {
          ...ids.sessions,
          "Seeded task session": anySession,
          "Narrowed session": anySession,
          "Seeded ask card": ids.sessions["Seeded ask card"] ?? "",
        }
      : ids.sessions,
  } as Ids;
}

// --- state registry (§13A.2) -------------------------------------------------

type Requirement = "vaults" | "none";

type CaptureState = {
  screen: string;
  state: string;
  description: string;
  user?: string;
  workspace?: string;
  requires: Requirement;
  path: (ids: Ids, theme: "light" | "dark") => string | null;
  intercept?: (context: BrowserContext, ids: Ids) => Promise<void>;
  steps?: (page: Page, ids: Ids) => Promise<void>;
  /** `--mock`: role and scenario for the in-page mock; replaces `intercept`. */
  mock?: { role?: string; scenario?: string };
  /** Extra state-specific assertion recorded in index.json. */
  expect?: (page: Page, ids: Ids) => Promise<{ ok: boolean; detail: string }>;
};

const ws = (ids: Ids, name?: string) => (name ? ids.workspaces[name] : ids.ws) ?? ids.ws;
const secrets = (ids: Ids, suffix = "", name?: string) =>
  `/workspaces/${ws(ids, name)}/secrets${suffix}`;
const vault = (ids: Ids, name: string) =>
  ids.vaults[name] ? secrets(ids, `/${ids.vaults[name]}`) : null;
const item = (ids: Ids, key: string) => {
  const found = ids.items[key];
  return found ? secrets(ids, `/${found.vault}/${found.item}`) : null;
};
const click = (name: string | RegExp) => async (page: Page) => {
  await page.getByRole("button", { name }).first().click();
  await page.waitForTimeout(500);
};
/** A button on the page, or else an item in the page's ⋯ menu. */
const action = (name: string | RegExp) => async (page: Page) => {
  const button = page.getByRole("button", { name }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
  } else {
    await page
      .getByRole("button", { name: /^More /u })
      .first()
      .click();
    await page.getByRole("menuitem", { name }).first().click();
  }
  await page.waitForTimeout(500);
};
/** The composer's "+" menu, then its Secrets row (the session Secrets panel). */
const openComposerSecrets = async (page: Page) => {
  await page.getByRole("button", { name: "More composer actions" }).first().click();
  await page
    .getByRole("menuitem", { name: /^Secrets/u })
    .first()
    .click();
  await page.waitForTimeout(600);
};
const delayApi = (pattern: RegExp) => async (context: BrowserContext) => {
  await context.route(pattern, async () => {
    await new Promise(() => {});
  });
};
const failApi =
  (pattern: RegExp, status: number, body: Record<string, unknown>) =>
  async (context: BrowserContext) => {
    await context.route(pattern, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
        : route.fallback(),
    );
  };
const VAULTS_LIST = /\/v1\/workspaces\/[^/]+\/vaults(\?|$)/u;
const VAULT_ITEMS = /\/v1\/workspaces\/[^/]+\/vaults\/[^/]+\/items(\?|$)/u;

function s(
  screen: string,
  state: string,
  description: string,
  path: CaptureState["path"],
  extra: Partial<CaptureState> = {},
): CaptureState {
  return { screen, state, description, requires: "vaults", path, ...extra };
}

// --- other password managers (S17-S24, external vaults first wave) ---------------

/** A row of a list (rows are buttons named by their title). */
const openRow = (name: RegExp) => async (page: Page) => {
  await page.getByRole("button", { name }).first().click();
  await page.waitForTimeout(600);
};
const connection = (ids: Ids, provider: string, view?: string) =>
  ids.connections?.[provider]
    ? secrets(ids, `?connection=${ids.connections[provider]}${view ? `&view=${view}` : ""}`)
    : null;
const connectPage = (provider: string) => (ids: Ids) => secrets(ids, `?view=connect-${provider}`);
/** Fills a credential field by its form name: secret, endpoint or label. */
const fill = (name: "secret" | "endpoint" | "label", value: string) => async (page: Page) => {
  await page.locator(`input[name="${name}"]`).first().fill(value);
};
/** Sets one chooser row's access: "Read-only" or "Read & write". */
const access = (vaultName: string, mode: RegExp) => async (page: Page) => {
  await page
    .getByRole("combobox", { name: `Access to ${vaultName}` })
    .or(page.getByRole("button", { name: `Access to ${vaultName}` }))
    .first()
    .click();
  await page.getByRole("option", { name: mode }).first().click();
  await page.waitForTimeout(300);
};
const submit = (name: RegExp) => async (page: Page) => {
  await page.getByRole("button", { name }).last().click();
  await page.waitForTimeout(900);
};
const steps =
  (...each: ((page: Page) => Promise<void>)[]) =>
  async (page: Page) => {
    for (const step of each) await step(page);
  };
/** Presses keys in order, as a person would. */
const keys =
  (...pressed: string[]) =>
  async (page: Page) => {
    for (const key of pressed) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(300);
  };
const wait = (ms: number) => async (page: Page) => {
  await page.waitForTimeout(ms);
};
/**
 * Focuses a control the way a keyboard does (Tab away and back), so the
 * screenshot shows its focus-visible ring.
 */
const focusRole = (role: "button" | "combobox" | "link", name: RegExp) => async (page: Page) => {
  await page.getByRole(role, { name }).first().focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(250);
};
const SECRET_32 = "f598-mock-signing-secret-0123456789abcdef";
/** The item page's ⋯ menu, then one of its entries. */
const itemMenu = (entry?: RegExp) => async (page: Page) => {
  await page
    .getByRole("button", { name: /^More actions for /u })
    .first()
    .click();
  await page.waitForTimeout(400);
  if (entry) {
    await page.getByRole("menuitem", { name: entry }).first().click();
    await page.waitForTimeout(600);
  }
};

const PROVIDER_STATES: CaptureState[] = [
  // S17 the picker
  s("S17", "picker", "Connect a password manager: five providers", (ids) =>
    secrets(ids, "?view=connect"),
  ),
  s("S17", "picker-from-list", "Vault list header action opens the picker", (ids) => secrets(ids), {
    steps: action(/Connect password manager/u),
  }),
  s(
    "S17",
    "picker-unavailable",
    "Keeper not enabled on this server: row disabled with reason",
    (ids) => secrets(ids, "?view=connect"),
    { mock: { scenario: "adapter-unavailable" } },
  ),
  s(
    "S17",
    "picker-fresh-server",
    "Fresh server, no connections yet: its catalog disables Proton Pass and Keeper",
    (ids) => secrets(ids, "?view=connect"),
    { mock: { scenario: "fresh-server" } },
  ),
  s(
    "S17",
    "picker-old-server",
    "Older server without a catalog: every provider offered, Keeper hint from its connection",
    (ids) => secrets(ids, "?view=connect"),
    { mock: { scenario: "no-catalog,adapter-unavailable" } },
  ),
  s(
    "S17",
    "setup-link-disabled",
    "A setup link for a provider this server can't connect opens the picker",
    connectPage("protonpass"),
    { mock: { scenario: "fresh-server" } },
  ),
  s(
    "S17",
    "list-fresh-server",
    "Fresh server vault list: no connections, Connect password manager",
    (ids) => secrets(ids),
    { mock: { scenario: "empty,fresh-server" } },
  ),
  // S18 setup forms
  s(
    "S18",
    "proton-empty",
    "Connect Proton Pass: owner + personal access token",
    connectPage("protonpass"),
  ),
  s("S18", "proton-validation", "Proton Pass submitted empty", connectPage("protonpass"), {
    steps: submit(/^Connect$/u),
  }),
  s(
    "S18",
    "proton-invalid",
    "Proton Pass rejects the token (field error)",
    connectPage("protonpass"),
    {
      steps: steps(fill("secret", "pst_invalid_0123456789"), submit(/^Connect$/u)),
    },
  ),
  s("S18", "proton-expired", "Proton Pass token expired (field error)", connectPage("protonpass"), {
    steps: steps(fill("secret", "pst_expired_0123456789"), submit(/^Connect$/u)),
  }),
  s(
    "S18",
    "keeper-empty",
    "Connect Keeper: one-time token, region, IP-lock note",
    connectPage("keeper"),
  ),
  s("S18", "keeper-used", "Keeper one-time token already used", connectPage("keeper"), {
    steps: steps(fill("secret", "US:used-0123456789"), submit(/^Connect$/u)),
  }),
  s(
    "S18",
    "keeper-member",
    "Connect Keeper as a member: no Organization owner",
    connectPage("keeper"),
    {
      user: "member",
    },
  ),
  s(
    "S18",
    "bitwarden-empty",
    "Connect Bitwarden: bridge address + signing secret, no master password",
    connectPage("bitwarden"),
  ),
  s(
    "S18",
    "bitwarden-validation",
    "Bitwarden bridge: bad address and short secret",
    connectPage("bitwarden"),
    {
      steps: steps(fill("endpoint", "bridge.local"), fill("secret", "short"), submit(/^Connect$/u)),
    },
  ),
  s(
    "S18",
    "bitwarden-offline",
    "Bitwarden bridge unreachable (address error)",
    connectPage("bitwarden"),
    {
      steps: steps(
        fill("endpoint", "https://offline.bridge.example"),
        fill("secret", SECRET_32),
        submit(/^Connect$/u),
      ),
    },
  ),
  s(
    "S18",
    "bitwarden-locked",
    "Bitwarden locked on the bridge (form error)",
    connectPage("bitwarden"),
    {
      steps: steps(
        fill("endpoint", "https://bridge.example"),
        fill("secret", `locked-${SECRET_32}`),
        submit(/^Connect$/u),
      ),
    },
  ),
  s(
    "S18",
    "external-empty",
    "Connect your vault service: name, address, signing secret",
    connectPage("external"),
  ),
  // S19 choose what to link, after connecting
  s(
    "S19",
    "proton-chooser",
    "Proton Pass connected: one writable vault, one read-only",
    connectPage("protonpass"),
    {
      steps: steps(fill("secret", "pst_ok_0123456789"), submit(/^Connect$/u)),
    },
  ),
  s(
    "S19",
    "keeper-chooser",
    "Keeper connected: shared folders with unknown edit rights",
    connectPage("keeper"),
    {
      steps: steps(fill("secret", "US:ok-0123456789"), submit(/^Connect$/u)),
    },
  ),
  s(
    "S19",
    "keeper-partial",
    "Keeper: one folder links, one fails (partial failure)",
    connectPage("keeper"),
    {
      steps: steps(
        fill("secret", "US:ok-0123456789"),
        submit(/^Connect$/u),
        access("Production", /^Read-only/u),
        access("Staging", /^Read-only/u),
        submit(/^(Done|Link \d)/u),
      ),
    },
  ),
  s("S19", "bitwarden-done", "Bitwarden connected and a vault linked", connectPage("bitwarden"), {
    steps: steps(
      fill("endpoint", "https://bridge.example"),
      fill("secret", SECRET_32),
      submit(/^Connect$/u),
      access("Operations", /^Read & write/u),
      submit(/^(Done|Link \d)/u),
    ),
  }),
  // S20 connections
  s(
    "S19",
    "keeper-access-menu",
    "Keeper chooser access menu: edit rights checked by Keeper when agents save",
    connectPage("keeper"),
    {
      steps: steps(fill("secret", "US:ok-0123456789"), submit(/^Connect$/u), async (page) => {
        await page
          .getByRole("combobox", { name: "Access to Production" })
          .or(page.getByRole("button", { name: "Access to Production" }))
          .first()
          .click();
        await page.waitForTimeout(400);
      }),
    },
  ),
  s(
    "S19",
    "keeper-pending",
    "Keeper accepted the one-time token but listing failed: Finish connecting, no token again",
    connectPage("keeper"),
    { steps: steps(fill("secret", "US:pending-0123456789"), submit(/^Connect$/u)) },
  ),
  s(
    "S19",
    "keeper-pending-retry-fails",
    "Finish connecting fails again: safe message, action stays",
    connectPage("keeper"),
    {
      mock: { scenario: "verify-fails" },
      steps: steps(
        fill("secret", "US:pending-0123456789"),
        submit(/^Connect$/u),
        submit(/^Finish connecting$/u),
      ),
    },
  ),
  s(
    "S19",
    "keeper-pending-finished",
    "Finish connecting succeeds: on to choosing shared folders",
    connectPage("keeper"),
    {
      steps: steps(
        fill("secret", "US:pending-0123456789"),
        submit(/^Connect$/u),
        submit(/^Finish connecting$/u),
      ),
    },
  ),
  s(
    "S20",
    "list-pending",
    "Connections list with a Keeper connection not finished",
    (ids) => secrets(ids),
    {
      mock: { scenario: "keeper-pending" },
      steps: async (page) => {
        await page
          .getByRole("heading", { name: /^Connections/u })
          .first()
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await page.waitForTimeout(300);
      },
    },
  ),
  s(
    "S20",
    "keeper-pending",
    "Keeper connection not finished: one Finish connecting action",
    (ids) => secrets(ids),
    {
      mock: { scenario: "keeper-pending" },
      steps: openRow(/^Staging agents/u),
    },
  ),
  s(
    "S20",
    "keeper-pending-refused",
    "Saved Keeper device refused: Reconnect instead",
    (ids) => secrets(ids),
    {
      mock: { scenario: "keeper-pending,verify-refused" },
      steps: steps(openRow(/^Staging agents/u), submit(/^Finish connecting$/u)),
    },
  ),
  s(
    "S20",
    "keeper-pending-viewer",
    "Keeper connection not finished, as a viewer",
    (ids) => secrets(ids),
    {
      user: "tom",
      mock: { scenario: "keeper-pending" },
      steps: openRow(/^Staging agents/u),
    },
  ),
  s(
    "S20",
    "list-attention",
    "Connections list: locked, token expired and offline rows",
    (ids) => secrets(ids),
    {
      mock: { scenario: "provider-locked,provider-expired,provider-offline" },
      steps: async (page) => {
        await page
          .getByRole("heading", { name: /^Connections/u })
          .first()
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await page.waitForTimeout(300);
      },
    },
  ),
  s("S20", "onepassword", "1Password connection page (unchanged baseline)", (ids) =>
    connection(ids, "onepassword"),
  ),
  s("S20", "protonpass", "Proton Pass connection page", (ids) => connection(ids, "protonpass")),
  s("S20", "keeper", "Keeper connection page (organization)", (ids) => connection(ids, "keeper")),
  s("S20", "bitwarden", "Bitwarden bridge connection page (Only me, label)", (ids) =>
    connection(ids, "bitwarden"),
  ),
  s("S20", "external", "Your vault service connection page", (ids) => connection(ids, "external")),
  s(
    "S20",
    "proton-expired",
    "Proton Pass token expired: renew action",
    (ids) => connection(ids, "protonpass"),
    {
      mock: { scenario: "provider-expired" },
    },
  ),
  s(
    "S20",
    "bitwarden-locked",
    "Bitwarden locked on the bridge",
    (ids) => connection(ids, "bitwarden"),
    {
      mock: { scenario: "provider-locked" },
    },
  ),
  s("S20", "external-offline", "Your vault service offline", (ids) => connection(ids, "external"), {
    mock: { scenario: "provider-offline" },
  }),
  s(
    "S20",
    "keeper-unavailable-here",
    "Keeper not enabled on this server",
    (ids) => connection(ids, "keeper"),
    {
      mock: { scenario: "adapter-unavailable" },
    },
  ),
  s(
    "S20",
    "keeper-viewer",
    "Keeper connection as a viewer (no manage actions)",
    (ids) => connection(ids, "keeper"),
    {
      user: "tom",
    },
  ),
  s("S20", "keeper-long", "Keeper connection with long names", (ids) => connection(ids, "keeper"), {
    mock: { scenario: "long-names" },
  }),
  s("S20", "proton-renew", "Replace the Proton Pass token", (ids) =>
    connection(ids, "protonpass", "replace-token"),
  ),
  s("S20", "keeper-renew", "Reconnect Keeper with a new one-time token", (ids) =>
    connection(ids, "keeper", "replace-token"),
  ),
  s("S20", "bitwarden-renew", "Update the Bitwarden bridge", (ids) =>
    connection(ids, "bitwarden", "replace-token"),
  ),
  s("S20", "keeper-choose", "Keeper: choose shared folders for an existing connection", (ids) =>
    connection(ids, "keeper", "choose-vaults"),
  ),
  s("S20", "keeper-disconnect", "Disconnect Keeper confirm", (ids) => connection(ids, "keeper"), {
    steps: itemMenu(/^Disconnect/u),
  }),
  // S21 provider vault states
  s("S21", "proton-healthy", "Proton Ops: new items yes, edits in Proton Pass", (ids) =>
    vault(ids, "Proton Ops"),
  ),
  s("S21", "proton-expired", "Proton Ops: token expired", (ids) => vault(ids, "Proton Ops"), {
    mock: { scenario: "provider-expired" },
  }),
  s(
    "S21",
    "proton-incomplete",
    "Proton Ops: listing incomplete",
    (ids) => vault(ids, "Proton Ops"),
    {
      mock: { scenario: "incomplete" },
    },
  ),
  s("S21", "proton-syncing", "Proton Ops: syncing", (ids) => vault(ids, "Proton Ops"), {
    mock: { scenario: "syncing" },
  }),
  s("S21", "keeper-healthy", "Keeper Production (organization, editable)", (ids) =>
    vault(ids, "Keeper Production"),
  ),
  s(
    "S21",
    "keeper-stale",
    "Keeper Production: last checked 3 hours ago",
    (ids) => vault(ids, "Keeper Production"),
    {
      mock: { scenario: "stale" },
    },
  ),
  s(
    "S21",
    "keeper-never-synced",
    "Keeper Production: never listed and unreachable (not empty)",
    (ids) => vault(ids, "Keeper Production"),
    {
      mock: { scenario: "never-synced" },
    },
  ),
  s(
    "S21",
    "keeper-rate-limited",
    "Keeper Production: rate limited until hh:mm",
    (ids) => vault(ids, "Keeper Production"),
    {
      mock: { scenario: "provider-rate-limited" },
    },
  ),
  s("S21", "bitwarden-healthy", "Bitwarden Personal: bridge cache synced time", (ids) =>
    vault(ids, "Bitwarden Personal"),
  ),
  s(
    "S21",
    "bitwarden-locked",
    "Bitwarden Personal: locked, showing last sync",
    (ids) => vault(ids, "Bitwarden Personal"),
    {
      mock: { scenario: "provider-locked" },
    },
  ),
  s(
    "S21",
    "bitwarden-offline",
    "Bitwarden Personal: bridge offline",
    (ids) => vault(ids, "Bitwarden Personal"),
    {
      mock: { scenario: "provider-offline" },
    },
  ),
  s("S21", "external-read-only", "Service credentials: read-only from your service", (ids) =>
    vault(ids, "Service credentials"),
  ),
  s(
    "S21",
    "keeper-member",
    "Keeper Production as a member (organization vault, can't add)",
    (ids) => vault(ids, "Keeper Production"),
    {
      user: "member",
    },
  ),
  s(
    "S21",
    "keeper-unlink",
    "Unlink Keeper Production confirm",
    (ids) => vault(ids, "Keeper Production"),
    {
      steps: itemMenu(/^Unlink/u),
    },
  ),
  // S22 provider items
  s("S22", "proton-item", "Grafana in Proton Pass: no Edit, reason visible", (ids) =>
    item(ids, "Proton Ops/Grafana"),
  ),
  s(
    "S22",
    "proton-item-menu",
    "Grafana menu: Copy reference, Move or copy, Move to trash in Proton Pass",
    (ids) => item(ids, "Proton Ops/Grafana"),
    {
      steps: itemMenu(),
    },
  ),
  s(
    "S22",
    "proton-trash-confirm",
    "Move Grafana to trash in Proton Pass? (no Undo)",
    (ids) => item(ids, "Proton Ops/Grafana"),
    {
      steps: itemMenu(/trash/iu),
    },
  ),
  s(
    "S22",
    "proton-copy",
    "Copy or move dialog from Proton Pass (targets that accept a TOTP login)",
    (ids) => item(ids, "Proton Ops/Grafana"),
    {
      steps: itemMenu(/^(Move or copy|Copy to another)/u),
    },
  ),
  s(
    "S22",
    "proton-new-item",
    "New item in Proton Ops: Login and Note only",
    (ids) => vault(ids, "Proton Ops"),
    {
      steps: click("New item"),
    },
  ),
  s("S22", "keeper-item", "Signing certificate in Keeper: editable, no archive", (ids) =>
    item(ids, "Keeper Production/Signing certificate"),
  ),
  s(
    "S22",
    "keeper-item-menu",
    "Keeper item menu: no archive entry",
    (ids) => item(ids, "Keeper Production/Signing certificate"),
    {
      steps: itemMenu(),
    },
  ),
  s(
    "S22",
    "keeper-edit",
    "Edit Signing certificate: file field changes in Keeper",
    (ids) => item(ids, "Keeper Production/Signing certificate"),
    {
      steps: click("Edit"),
    },
  ),
  s(
    "S22",
    "keeper-copy-only",
    "Copy Postgres primary from Keeper (copy only)",
    (ids) => item(ids, "Keeper Production/Postgres primary"),
    {
      steps: itemMenu(/^(Move or copy|Copy to another)/u),
    },
  ),
  s(
    "S22",
    "onepassword-archive-confirm",
    "Archive Figma in 1Password? (confirm, no Undo)",
    (ids) => item(ids, "1P Shared/Figma"),
    {
      steps: itemMenu(/^Archive/u),
    },
  ),
  s("S22", "external-item", "Billing API from your read-only service", (ids) =>
    item(ids, "Service credentials/Billing API"),
  ),
  s(
    "S22",
    "proton-item-viewer",
    "Proton Pass item as a viewer: no values, no actions",
    (ids) => item(ids, "Proton Ops/Grafana"),
    {
      user: "tom",
    },
  ),
  // S23 the vault list with every provider
  s(
    "S23",
    "list-all-providers",
    "Vault list with every provider and the Connections section",
    (ids) => secrets(ids),
    {
      steps: async (page) => {
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(400);
      },
    },
  ),
  s("S23", "list-long-names", "Vault list with long provider names", (ids) => secrets(ids), {
    mock: { scenario: "long-names" },
  }),
  // S24 keyboard: every flow above works without a pointer, with a visible focus ring
  s(
    "S24",
    "picker-tab",
    "Picker by keyboard: Tab moves between provider rows",
    (ids) => secrets(ids, "?view=connect"),
    {
      steps: steps(focusRole("button", /^Proton Pass/u), keys("Tab")),
    },
  ),
  s(
    "S24",
    "picker-enter",
    "Picker by keyboard: Enter on Proton Pass opens its setup",
    (ids) => secrets(ids, "?view=connect"),
    {
      steps: steps(focusRole("button", /^Proton Pass/u), keys("Enter")),
    },
  ),
  s(
    "S24",
    "proton-form-errors",
    "Proton Pass submitted empty by Enter: focus moves to the first error",
    connectPage("protonpass"),
    {
      steps: steps(focusRole("button", /^Connect$/u), keys("Enter"), wait(500)),
    },
  ),
  s(
    "S24",
    "chooser-access-keys",
    "Keeper chooser: access menu opened and moved by arrow keys",
    connectPage("keeper"),
    {
      steps: steps(
        fill("secret", "US:ok-0123456789"),
        submit(/^Connect$/u),
        focusRole("combobox", /^Access to Production/u),
        keys("Enter", "ArrowDown"),
      ),
    },
  ),
  s(
    "S24",
    "connection-menu-keys",
    "Keeper connection: More menu opened by keyboard",
    (ids) => connection(ids, "keeper"),
    {
      steps: steps(focusRole("button", /^More actions for /u), keys("Enter")),
    },
  ),
  s(
    "S24",
    "disconnect-escape",
    "Disconnect confirm closed by Escape: focus returns to the menu button",
    (ids) => connection(ids, "keeper"),
    {
      steps: steps(itemMenu(/^Disconnect/u), keys("Escape"), wait(400)),
    },
  ),
  s(
    "S24",
    "trash-confirm-focus",
    "Move to trash in Proton Pass by keyboard: confirm dialog focus starts on Cancel",
    (ids) => item(ids, "Proton Ops/Grafana"),
    {
      steps: steps(focusRole("button", /^More actions for /u), keys("Enter"), keys("End", "Enter")),
    },
  ),
  s(
    "S24",
    "pending-finish-focus",
    "Keeper not finished: Finish connecting reached by Tab",
    (ids) => secrets(ids),
    {
      mock: { scenario: "keeper-pending" },
      steps: steps(openRow(/^Staging agents/u), focusRole("button", /^Finish connecting$/u)),
    },
  ),
  s(
    "S24",
    "stale-sync-focus",
    "Keeper stale: Sync now focused from the notice",
    (ids) => vault(ids, "Keeper Production"),
    {
      mock: { scenario: "stale" },
      steps: focusRole("button", /^Sync now$/u),
    },
  ),
];

export const CAPTURE_STATES: CaptureState[] = [
  // S1 Settings › Secrets
  s("S1", "populated", "Vault list as bendik: Only me, This workspace, Password managers", (ids) =>
    secrets(ids),
  ),
  s("S1", "member", "Vault list as jonas (member)", (ids) => secrets(ids), { user: "member" }),
  s("S1", "viewer", "Vault list as aiko (viewer, no New vault)", (ids) => secrets(ids), {
    user: "tom",
  }),
  s("S1", "loading", "Skeleton while vaults load", (ids) => secrets(ids), {
    intercept: delayApi(VAULTS_LIST),
    mock: { scenario: "slow" },
  }),
  s("S1", "api-error", "Vault list request fails (500)", (ids) => secrets(ids), {
    intercept: failApi(VAULTS_LIST, 500, {
      error: { code: "internal_error", message: "Something went wrong" },
    }),
    mock: { scenario: "error" },
  }),
  s("S1", "missing-key", "Encryption key missing (503 banner)", (ids) => secrets(ids), {
    intercept: failApi(VAULTS_LIST, 503, {
      error: { code: "encryption_key_missing", message: "Encryption key missing" },
    }),
    mock: { scenario: "missing-key" },
  }),
  s(
    "S1",
    "capability-off",
    "Design preview workspace with secrets off",
    (ids) => secrets(ids, "", flags.mock ? undefined : "Design preview"),
    { mock: { scenario: "capability-off" } },
  ),
  s("S1", "sync-error-row", "1P Shared row shows Sync failed", (ids) => secrets(ids)),
  s(
    "S1",
    "empty-org",
    "Workspace without vaults (Finance ops)",
    (ids) => secrets(ids, "", flags.mock ? undefined : "Finance ops"),
    { mock: { scenario: "empty" } },
  ),
  // S2 Vault page
  s("S2", "populated", "Shared vault", (ids) => vault(ids, "Shared")),
  s("S2", "dense", "Dense vault (140 items, virtualized)", (ids) => vault(ids, "Dense")),
  s("S2", "empty", "Empty vault", (ids) => vault(ids, "Empty")),
  s("S2", "no-results", "Search with no matches", (ids) => vault(ids, "Shared"), {
    steps: async (page) => {
      await page.getByRole("searchbox").first().fill("zzz-no-such-item");
      await page.waitForTimeout(600);
    },
  }),
  s("S2", "read-only-1password", "1P Engineering (Read-only, no New item)", (ids) =>
    vault(ids, "1P Engineering"),
  ),
  s("S2", "sync-error", "1P Shared with Sync failed and Retry", (ids) => vault(ids, "1P Shared")),
  s(
    "S2",
    "rate-limited",
    "Provider rate limited until hh:mm",
    (ids) => vault(ids, "1P Engineering"),
    {
      intercept: failApi(VAULT_ITEMS, 429, {
        error: { code: "provider_rate_limited", retryAt: "2026-10-12T12:15:00Z" },
      }),
      mock: { scenario: "rate-limited" },
    },
  ),
  s("S2", "viewer", "Shared vault as aiko (viewer)", (ids) => vault(ids, "Shared"), {
    user: "tom",
  }),
  s("S2", "task-vault", "This task vault of the seeded task session", (ids) => vault(ids, "Task")),
  // S3 Item page
  s("S3", "login-totp", "GitHub login with TOTP ring", (ids) => item(ids, "Private/GitHub")),
  s("S3", "api-key", "OpenAI API key", (ids) => item(ids, "Private/OpenAI API")),
  s("S3", "note", "Recovery codes note", (ids) => item(ids, "Private/Recovery codes")),
  s("S3", "file", "Service account file", (ids) => item(ids, "Private/Service account")),
  s("S3", "passkey", "Fake Login Passkey card", (ids) => item(ids, "Private/Fake Login Passkey")),
  s("S3", "revealed", "Password revealed", (ids) => item(ids, "Private/GitHub"), {
    steps: click("Reveal"),
  }),
  s("S3", "copied-toast", "Copied toast after Copy", (ids) => item(ids, "Private/GitHub"), {
    steps: click(/^Copy (password|value)$/u),
  }),
  s("S3", "history-open", "Deploy key history expanded", (ids) => item(ids, "Shared/Deploy key"), {
    steps: click(/history/iu),
  }),
  s("S3", "alias", "Staging DB with Also resolves as", (ids) => item(ids, "Shared/Staging DB")),
  s("S3", "expired", "Expired cert", (ids) => item(ids, "Shared/Expired cert")),
  s("S3", "expiring-soon", "Rotating soon (3 days)", (ids) => item(ids, "Shared/Rotating soon")),
  s(
    "S3",
    "viewer",
    "GitHub-like shared item as aiko, viewer (no Reveal, no Copy)",
    (ids) => item(ids, "Shared/Deploy key"),
    {
      user: "tom",
    },
  ),
  // S4 Item create and edit
  s("S4", "blank-create", "New item, type picker", (ids) => vault(ids, "Private"), {
    steps: click("New item"),
  }),
  s("S4", "generator-open", "Password generator popover", (ids) => vault(ids, "Private"), {
    steps: async (page) => {
      await click("New item")(page);
      await click("Generate")(page);
    },
  }),
  // S5 / S6 / S7
  s("S5", "member", "New vault dialog as member (two owner options)", (ids) => secrets(ids), {
    user: "member",
    steps: click("New vault"),
  }),
  s(
    "S5",
    "admin",
    "New vault as an organization admin (bendik: three owner options)",
    (ids) => secrets(ids),
    {
      user: "owner",
      steps: click("New vault"),
    },
  ),
  s("S6", "selected", "Available in editor (Org tooling)", (ids) => vault(ids, "Org tooling"), {
    // Organization vault availability is an organization-admin action (bendik).
    user: flags.mock ? "admin" : "owner",
    steps: async (page) => {
      await action(/Available in/u)(page);
      await page
        .getByRole("radio", { name: /Selected workspaces/u })
        .first()
        .click();
      await page.waitForTimeout(400);
    },
  }),
  s(
    "S7",
    "step-1-empty",
    "Connect 1Password through the picker, token step",
    (ids) => secrets(ids),
    {
      steps: async (page) => {
        await action(/Connect password manager/u)(page);
        await openRow(/^1Password/u)(page);
      },
    },
  ),
  ...PROVIDER_STATES,
  // S8 provider status: covered by S1 sync-error-row and S2 sync-error / rate-limited.
  // S9 ask card: needs a seeded pending secret question (W2/W3 seed).
  s("S9", "current-password", "Ask card secret field (current-password)", (ids) =>
    ids.sessions["Seeded ask card"]
      ? `/workspaces/${ids.ws}/sessions/${ids.sessions["Seeded ask card"]}`
      : null,
  ),
  // Until the ask card is seeded: the same component and its states in the UI kit.
  s(
    "S9",
    "kit",
    "Ask card secret field states in the UI kit",
    (_ids, theme) => `/dev/ui-kit?section=secret-ask-card&theme=${theme}&chrome=0`,
    { requires: "none" },
  ),
  // S10 / S11 session Secrets panel (the composer's "+" menu > Secrets), composer
  s(
    "S10",
    "task-items",
    "Session Secrets panel with This task items",
    (ids) =>
      ids.sessions["Seeded task session"]
        ? `/workspaces/${ids.ws}/sessions/${ids.sessions["Seeded task session"]}`
        : null,
    { steps: openComposerSecrets },
  ),
  s(
    "S10",
    "narrowed",
    "Narrowed session Secrets panel (2 vaults)",
    (ids) =>
      ids.sessions["Narrowed session"]
        ? `/workspaces/${ids.ws}/sessions/${ids.sessions["Narrowed session"]}`
        : null,
    { mock: { scenario: "narrowed" }, steps: openComposerSecrets },
  ),
  // Anchors that exist today (captured now; they gain the Secrets UI as W3 lands).
  s(
    "S11",
    "default",
    "New-session composer, its + menu with the Secrets row",
    (ids) => `/workspaces/${ids.ws}`,
    {
      requires: "none",
      steps: async (page) => {
        await page.getByRole("button", { name: "More composer actions" }).first().click();
        await page.waitForTimeout(500);
      },
      expect: async (page) => {
        const row = await page.getByRole("menuitem", { name: /^Secrets/u }).count();
        return {
          ok: row > 0,
          detail: row > 0 ? "Secrets row present" : "Secrets row missing from the + menu",
        };
      },
    },
  ),
  s(
    "S12",
    "form",
    "New schedule form (Secrets row)",
    (ids) => `/workspaces/${ids.ws}/schedules/new`,
    {
      requires: "none",
      steps: async (page) => {
        await page
          .getByRole("button", { name: /^Advanced/u })
          .first()
          .click();
        await page
          .getByText(/^Secrets$/u)
          .first()
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await page.waitForTimeout(400);
      },
      expect: async (page) => {
        const row = await page.getByText(/^Secrets$/u).count();
        return {
          ok: row > 0,
          detail: row > 0 ? "Secrets row present" : "Secrets row not present yet (W3)",
        };
      },
    },
  ),
  s(
    "S13",
    "capabilities",
    "Agent defaults capability list (Secrets toggle)",
    (ids) => `/workspaces/${ids.ws}/settings?section=general&view=agent-defaults`,
    {
      requires: "none",
      steps: async (page) => {
        await page
          .getByText(/^Secrets$/u)
          .last()
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await page.waitForTimeout(300);
      },
      expect: async (page) => {
        const toggle = await page.getByRole("checkbox", { name: /^Secrets/u }).count();
        return {
          ok: toggle > 0,
          detail: toggle > 0 ? "Secrets toggle present" : "Secrets toggle missing",
        };
      },
    },
  ),
  s(
    "S15",
    "variable-sets-redirect",
    "/variable-sets redirects to Secrets",
    (ids) => `/workspaces/${ids.ws}/variable-sets`,
    {
      requires: "none",
      expect: async (page) => {
        const url = page.url();
        return {
          ok: /\/secrets(\/|$)/u.test(new URL(url).pathname),
          detail: `landed on ${new URL(url).pathname}`,
        };
      },
    },
  ),
  s(
    "S15",
    "variable-set-detail-redirect",
    "/variable-sets/<id> redirects to Secrets",
    (ids) => {
      const first = Object.values(ids.variableSets)[0];
      return `/workspaces/${ids.ws}/variable-sets/${first ?? "00000000-0000-0000-0000-000000000000"}`;
    },
    {
      requires: "none",
      expect: async (page) => ({
        ok: /\/secrets(\/|$)/u.test(new URL(page.url()).pathname),
        detail: `landed on ${new URL(page.url()).pathname}`,
      }),
    },
  ),
  // S16 mobile ask card (React Native) is covered by MB-2, not this script.
];

function globToRegExp(glob: string): RegExp {
  return new RegExp(
    `^(${glob
      .split(",")
      .map((part) =>
        part
          .trim()
          .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
          .replaceAll("*", ".*"),
      )
      .join("|")})$`,
    "u",
  );
}

// --- capture -----------------------------------------------------------------

type ShotRecord = {
  file: string;
  screen: string;
  state: string;
  description: string;
  user: string;
  viewport: string;
  theme: string;
  status: "captured" | "pending" | "failed";
  reason?: string;
  url?: string;
  checks?: {
    overflowPx: number;
    smallTargets: string[];
    primaryButtons: number;
    h1Count: number;
    axe: { id: string; impact: string | null | undefined; help: string; nodes: string[] }[];
    expect?: { ok: boolean; detail: string };
  };
};

const SIGNED_OUT = "signed out (stale session)";
class SignedOutError extends Error {}
/** The stack's sign-in page instead of the app: a session revoked by a concurrent refresh. */
async function signedOut(page: Page): Promise<boolean> {
  return (
    (await page.locator("input[type=email]").count()) > 0 &&
    (await page.getByText(/^Create an account$/u).count()) > 0
  );
}

/** Captures once more with a fresh sign-in when the saved session was revoked. */
async function captureWithRetry(
  browser: Browser,
  ids: Ids,
  state: CaptureState,
  width: number,
  height: number,
  theme: "light" | "dark",
): Promise<ShotRecord> {
  const record = await capture(browser, ids, state, width, height, theme);
  if (record.reason !== SIGNED_OUT) return record;
  const user = state.user ?? flags.user!;
  states.delete(user === "tom" ? "viewer" : user);
  return capture(browser, ids, state, width, height, theme);
}

async function capture(
  browser: Browser,
  ids: Ids,
  state: CaptureState,
  width: number,
  height: number,
  theme: "light" | "dark",
): Promise<ShotRecord> {
  const user = state.user ?? flags.user!;
  const name = `${state.screen}-${state.state}-${width}x${height}-${theme}.png`;
  const base: ShotRecord = {
    file: name,
    screen: state.screen,
    state: state.state,
    description: state.description,
    user,
    viewport: `${width}x${height}`,
    theme,
    status: "pending",
  };
  if (state.requires === "vaults" && !ids.vaultsApi)
    return { ...base, reason: "pending F2/W3: vault API not present (GET /vaults 404)" };
  if (state.requires === "vaults" && !ids.secretsRoute)
    return { ...base, reason: "pending W3: Secrets route not present" };
  const path = state.path(ids, theme);
  if (!path)
    return { ...base, reason: "pending seed (W6): the seeded record for this state was not found" };
  const context = await browser.newContext({
    storageState: await storageStateFor(browser, user === "tom" ? "viewer" : user),
    viewport: { width, height },
    colorScheme: theme,
    deviceScaleFactor: 1,
    hasTouch: width < 1024,
    isMobile: width < 600,
  });
  if (flags.mock)
    await mockInit(
      context,
      state.mock?.role ?? MOCK_ROLE[user] ?? "owner",
      state.mock?.scenario ?? "",
    );
  const page = await context.newPage();
  try {
    await page.clock.install({ time: CLOCK });
    if (!(flags.mock && state.mock)) await state.intercept?.(context, ids);
    await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    await page
      .waitForFunction(
        () =>
          document.querySelector("nav, main, [role=main]") !== null &&
          !/^\s*Loading/u.test(document.body.innerText),
        undefined,
        {
          timeout: 45_000,
        },
      )
      .catch(() => {});
    await page.waitForTimeout(1_500);
    if (await signedOut(page)) throw new SignedOutError();
    await state.steps?.(page, ids);
    const file = join(OUT, name);
    await page.screenshot({ path: file });
    const minTarget = width < 600 ? 44 : 40;
    const layout = await page.evaluate((min) => {
      const overflowPx = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      const small: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(
        'main button, main a[href], main input:not([type=hidden]), main [role="button"], main [role="tab"], [role="dialog"] button, [role="dialog"] input, [role="menu"] [role^="menuitem"]',
      )) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const target = (element.closest("label") ?? element).getBoundingClientRect();
        const after = getComputedStyle(element, "::after");
        const enlarged = after.content !== "none" && after.position === "absolute";
        if (!enlarged && (target.width < min - 0.5 || target.height < min - 0.5)) {
          small.push(
            `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(target.width)}x${Math.round(target.height)}`,
          );
        }
      }
      const scope = document.querySelector('[role="dialog"]') ?? document;
      const primaryButtons = [
        ...scope.querySelectorAll<HTMLElement>('[data-slot="button"][data-variant="default"]'),
      ].filter((element) => element.getBoundingClientRect().width > 0).length;
      return {
        overflowPx,
        smallTargets: [...new Set(small)].slice(0, 80),
        primaryButtons,
        h1Count: document.querySelectorAll("h1").length,
      };
    }, minTarget);
    const overlay = (await page.locator('[role="menu"], [role="dialog"]').count()) > 0;
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
    if (overlay) builder = builder.include('[role="menu"], [role="dialog"]');
    const axe = (await builder.analyze()).violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
      }));
    const expectation = state.expect ? await state.expect(page, ids) : undefined;
    return {
      ...base,
      status: "captured",
      url: page.url(),
      checks: { ...layout, axe, ...(expectation ? { expect: expectation } : {}) },
    };
  } catch (error) {
    if (error instanceof SignedOutError) return { ...base, status: "failed", reason: SIGNED_OUT };
    await page.screenshot({ path: join(OUT, name) }).catch(() => {});
    return { ...base, status: "failed", reason: (error as Error).message.split("\n")[0] };
  } finally {
    await context.close();
  }
}

const pattern = globToRegExp(flags.states!);
const selected = CAPTURE_STATES.filter((state) => pattern.test(`${state.screen}-${state.state}`));
if (flags.list) {
  for (const state of selected)
    console.log(`${state.screen}-${state.state}\t${state.requires}\t${state.description}`);
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const records: ShotRecord[] = [];
try {
  const ids = await resolveIds(browser);
  console.log(
    `stack ${WEB}: vault API ${ids.vaultsApi ? "present" : "missing"}, Secrets route ${ids.secretsRoute ? "present" : "missing"}`,
  );
  const jobs: (() => Promise<void>)[] = [];
  for (const state of selected) {
    for (const [width, height] of VIEWPORTS) {
      for (const theme of THEMES) {
        jobs.push(async () => {
          const record = await captureWithRetry(browser, ids, state, width, height, theme);
          records.push(record);
          const issues = record.checks
            ? [
                record.checks.overflowPx ? `overflow ${record.checks.overflowPx}px` : "",
                record.checks.smallTargets.length
                  ? `${record.checks.smallTargets.length} small targets`
                  : "",
                record.checks.primaryButtons > 1
                  ? `${record.checks.primaryButtons} primary buttons`
                  : "",
                record.checks.axe.length ? `${record.checks.axe.length} axe` : "",
                record.checks.expect && !record.checks.expect.ok ? record.checks.expect.detail : "",
              ].filter(Boolean)
            : [];
          console.log(
            `${record.status} ${record.file}${record.reason ? ` - ${record.reason}` : ""}${issues.length ? ` [${issues.join("; ")}]` : ""}`,
          );
        });
      }
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }),
  );
} finally {
  await browser.close();
}
records.sort((a, b) => a.file.localeCompare(b.file));
const summary = {
  at: new Date().toISOString(),
  web: WEB,
  clock: CLOCK.toISOString(),
  viewports: flags.viewports,
  themes: flags.themes,
  counts: {
    captured: records.filter((row) => row.status === "captured").length,
    pending: records.filter((row) => row.status === "pending").length,
    failed: records.filter((row) => row.status === "failed").length,
  },
  shots: records,
};
writeFileSync(join(OUT, "index.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `captured ${summary.counts.captured}, pending ${summary.counts.pending}, failed ${summary.counts.failed}; index ${join(OUT, "index.json")}`,
);
process.exit(summary.counts.failed > 0 ? 1 : 0);
