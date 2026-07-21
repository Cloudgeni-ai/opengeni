import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright";
import type { AccessContext } from "@opengeni/contracts";
import {
  claimCodexResetRedemption,
  completeCodexResetRedemption,
  createDb,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  fenceCodexResetRedemptionSend,
  recordCodexAccountUsage,
  setInitialActiveCodexCredential,
  upsertCodexSubscriptionCredential,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireSharedTestDatabase,
  freePort,
  MemoryEventBus,
  testSettings,
  waitFor,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../../apps/api/src/app";

const repoRoot = new URL("../..", import.meta.url).pathname;
const RUN_ID = crypto.randomUUID();
const OWNER_USER_ID = `codex-quota-browser-owner-${RUN_ID}`;
const OWNER_COOKIE_VALUE = `codex-quota-browser-cookie-${RUN_ID}`;
const ROTATED_OWNER_COOKIE_VALUE = `codex-quota-browser-cookie-rotated-${RUN_ID}`;
const FINAL_OWNER_COOKIE_VALUE = `codex-quota-browser-cookie-final-${RUN_ID}`;
const OWNER_COOKIE = `better-auth.session_token=${OWNER_COOKIE_VALUE}`;
const EVIDENCE_DIR = process.env.OPENGENI_CODEX_QUOTA_EVIDENCE_DIR ?? "/tmp/codex-quota-evidence";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let browser: Browser;
let edge: ReturnType<typeof Bun.serve>;
let publicPort: number;
let defaultAccountId: string;
let workspaceId: string;
let detailedCredentialId: string;
let priorNonConsumingAttemptId: string;
let priorNonConsumingUpstreamKey: string;
let available = true;

const provider = {
  consumeBodies: [] as Array<{ redeem_request_id: string; credit_id: string }>,
  consumeAttempts: 0,
  overviewCalls: 0,
  activeOverviewCalls: 0,
  maxActiveOverviewCalls: 0,
  async trackOverview<T>(operation: () => Promise<T>): Promise<T> {
    provider.overviewCalls += 1;
    provider.activeOverviewCalls += 1;
    provider.maxActiveOverviewCalls = Math.max(
      provider.maxActiveOverviewCalls,
      provider.activeOverviewCalls,
    );
    try {
      await Bun.sleep(20);
      return await operation();
    } finally {
      provider.activeOverviewCalls -= 1;
    }
  },
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const account = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
    if (url.endsWith("/wham/rate-limit-reset-credits/consume")) {
      const body = JSON.parse(String(init?.body)) as {
        redeem_request_id: string;
        credit_id: string;
      };
      provider.consumeBodies.push(body);
      if (provider.consumeAttempts++ === 0) {
        throw new Error("injected ambiguous provider timeout");
      }
      return json({ code: "already_redeemed", windows_reset: 2 });
    }
    if (url.endsWith("/wham/usage")) {
      return await provider.trackOverview(async () => {
        if (account === "cached" || account === "error") {
          throw new Error(`${account} account is offline`);
        }
        const includeSummary = account !== "unsupported";
        return json({
          plan_type: "pro",
          rate_limit: {
            allowed: true,
            primary_window: {
              used_percent: account === "detailed" ? 81 : 20,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
              limit_window_seconds: 18_000,
            },
            secondary_window: {
              used_percent: 12,
              reset_at: Math.floor(Date.now() / 1000) + 86_400,
              limit_window_seconds: 604_800,
            },
          },
          ...(includeSummary
            ? {
                rate_limit_reset_credits: {
                  available_count:
                    account === "detailed" && provider.consumeAttempts > 0
                      ? 0
                      : account === "capped"
                        ? 2
                        : 1,
                },
              }
            : {}),
        });
      });
    }
    if (url.endsWith("/wham/rate-limit-reset-credits")) {
      return await provider.trackOverview(async () => {
        if (account === "cached" || account === "error") {
          throw new Error(`${account} account is offline`);
        }
        if (account === "count-only") return new Response("", { status: 503 });
        if (account === "unsupported") return new Response("", { status: 404 });
        if (account === "capped") {
          return details(2, [credit("capped-credit", "available", "codex_rate_limits")]);
        }
        if (account === "unknown") {
          return details(1, [credit("unknown-credit", "future_status", "future_scope")]);
        }
        if (account === "detailed" && provider.consumeAttempts > 0) return details(0, []);
        return details(1, [
          credit("detailed-credit", "available", "codex_rate_limits", "Full reset"),
          credit("historical-credit", "redeemed", "codex_rate_limits", "Earlier reset"),
        ]);
      });
    }
    throw new Error(`unexpected provider request ${url}`);
  },
};

function credit(id: string, status: string, resetType: string, title?: string) {
  return {
    id,
    reset_type: resetType,
    status,
    granted_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    title: title ?? null,
    description: "One earned provider reset",
  };
}

function details(availableCount: number, credits: unknown[]): Response {
  return json({ available_count: availableCount, credits });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function completePriorNoCreditAttempt(
  creditId: string,
  browserSessionHash: string,
): Promise<{ attemptId: string; upstreamIdempotencyKey: string }> {
  const attemptId = crypto.randomUUID();
  const claimHolderId = crypto.randomUUID();
  const priorAttempt = await claimCodexResetRedemption(client.db, {
    id: attemptId,
    accountId: defaultAccountId,
    workspaceId,
    credentialId: detailedCredentialId,
    subjectId: `user:${OWNER_USER_ID}`,
    browserSessionHash,
    creditId,
    confirmationExpiresAt: new Date(Date.now() + 5 * 60_000),
    claimHolderId,
  });
  if (priorAttempt.kind !== "claimed") throw new Error("expected prior non-consuming claim");
  const priorFence = await fenceCodexResetRedemptionSend(client.db, {
    accountId: defaultAccountId,
    workspaceId,
    attemptId,
    claimHolderId,
    credentialId: detailedCredentialId,
    subjectId: `user:${OWNER_USER_ID}`,
    browserSessionHash,
  });
  if (priorFence.kind !== "ready") throw new Error("expected prior non-consuming send fence");
  const priorCompletion = await completeCodexResetRedemption(client.db, {
    accountId: defaultAccountId,
    workspaceId,
    attemptId,
    claimHolderId,
    outcome: "noCredit",
  });
  if (priorCompletion.result?.outcome !== "noCredit") {
    throw new Error("expected prior non-consuming completion");
  }
  return { attemptId, upstreamIdempotencyKey: priorAttempt.attempt.upstreamIdempotencyKey };
}

async function expectNoWcagAxeViolations(page: Page, include: string): Promise<void> {
  const report = await new AxeBuilder({ page })
    .include(include)
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

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_CODEX_QUOTA_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_CODEX_QUOTA_POSTGRES_APP_URL;
  if (!adminUrl || !appUrl) return await acquireSharedTestDatabase("codex-overview-e2e");
  await migrate(adminUrl);
  return {
    // Native verification provisions the non-superuser role before migration,
    // so migration GRANT blocks are authoritative. This e2e never needs a
    // superuser query handle after migration.
    admin: null as never,
    adminUrl,
    appUrl,
    release: async () => undefined,
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (!shared) {
    throw new Error("Codex quota browser E2E requires real PostgreSQL; no skip is permitted");
  }
  client = createDb(shared.appUrl, { max: 16 });
  browser = await chromium.launch(
    process.env.OPENGENI_BROWSER_BIN
      ? { executablePath: process.env.OPENGENI_BROWSER_BIN }
      : undefined,
  );
  publicPort = await freePort();
  const publicOrigin = `http://127.0.0.1:${publicPort}`;
  const settings = testSettings({
    productAccessMode: "managed",
    publicBaseUrl: publicOrigin,
    betterAuthSecret: "codex-quota-browser-better-auth-secret-32-bytes",
    environmentsEncryptionKey: Buffer.alloc(32, 91).toString("base64"),
    codexSubscriptionEnabled: true,
  });
  const ownerSession = (suffix: string) => ({
    session: {
      id: `codex-quota-browser-session-${suffix}-${RUN_ID}`,
      userId: OWNER_USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    },
    user: {
      id: OWNER_USER_ID,
      name: "Codex quota Owner",
      email: `codex-quota-owner-${RUN_ID}@example.com`,
    },
  });
  const sessionForHeaders = (headers: Headers) => {
    const cookie = headers.get("cookie") ?? "";
    if (cookie.includes(FINAL_OWNER_COOKIE_VALUE)) return ownerSession("final");
    if (cookie.includes(ROTATED_OWNER_COOKIE_VALUE)) return ownerSession("rotated");
    if (cookie.includes(OWNER_COOKIE_VALUE)) return ownerSession("initial");
    return null;
  };
  const api = createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedAuth: {
      handler: async (request: Request) =>
        new URL(request.url).pathname.endsWith("/get-session")
          ? json(sessionForHeaders(request.headers))
          : new Response("not found", { status: 404 }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) => sessionForHeaders(headers),
      },
    } as any,
    codexFetch: provider.fetch.bind(provider) as typeof fetch,
  });

  const build = Bun.spawn(["bun", "run", "vite", "build"], {
    cwd: `${repoRoot}/apps/web`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      VITE_API_BASE_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const buildExit = await build.exited;
  if (buildExit !== 0) {
    throw new Error(`Codex quota web build failed: ${await new Response(build.stderr).text()}`);
  }
  const webDist = `${repoRoot}/apps/web/dist`;
  edge = Bun.serve({
    hostname: "127.0.0.1",
    port: publicPort,
    idleTimeout: 60,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
        return await api.fetch(request);
      }
      const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const requested = safePath.includes("..") ? null : Bun.file(`${webDist}/${safePath}`);
      const asset =
        requested && (await requested.exists()) ? requested : Bun.file(`${webDist}/index.html`);
      return new Response(asset, { headers: { "content-type": asset.type } });
    },
  });

  const access = await api.request("/v1/access/me", {
    headers: { cookie: OWNER_COOKIE },
  });
  const context = (await access.json()) as AccessContext;
  workspaceId = context.defaultWorkspaceId!;
  const accountId = context.defaultAccountId!;
  defaultAccountId = accountId;
  const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
  for (const [externalId, label] of [
    ["detailed", "Detailed account"],
    ["count-only", "Count-only account"],
    ["capped", "Capped account"],
    ["unknown", "Unknown account"],
    ["unsupported", "Unsupported account"],
    ["error", "Error account"],
    ["cached", "Cached account"],
  ] as const) {
    const connected = await upsertCodexSubscriptionCredential(client.db, {
      accountId,
      workspaceId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({
          access_token: "token",
          refresh_token: "refresh",
          id_token: "id",
        }),
      ),
      chatgptAccountId: externalId,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      lastRefreshAt: new Date(),
      connectedBySubjectId: `user:${OWNER_USER_ID}`,
      label,
    });
    if (externalId === "detailed") detailedCredentialId = connected.id;
    if (externalId === "cached") {
      const old = new Date(Date.now() - 20 * 60_000);
      await recordCodexAccountUsage(client.db, workspaceId, connected.id, {
        primaryUsedPercent: 44,
        primaryResetAt: new Date(Date.now() + 60_000),
        secondaryUsedPercent: 22,
        secondaryResetAt: new Date(Date.now() + 120_000),
        checkedAt: old,
        resetCreditAvailableCount: 2,
        resetCreditsCheckedAt: old,
      });
    }
  }
  await ensureCodexRotationSettings(client.db, accountId, workspaceId);
  await setInitialActiveCodexCredential(client.db, workspaceId, detailedCredentialId);
  const priorAttempt = await completePriorNoCreditAttempt(
    "detailed-credit",
    "prior-browser-session",
  );
  priorNonConsumingAttemptId = priorAttempt.attemptId;
  priorNonConsumingUpstreamKey = priorAttempt.upstreamIdempotencyKey;
  // Provider detail intentionally retains redeemed rows. Their earlier
  // non-consuming outcome is history only and must not invent availability.
  await completePriorNoCreditAttempt("historical-credit", "prior-historical-session");
  await mkdir(EVIDENCE_DIR, { recursive: true });
}, 180_000);

afterAll(async () => {
  edge?.stop(true);
  await browser?.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("Codex quota real browser/API/Postgres reset overview", () => {
  test("renders truthful states, keyboard-safe redemption retry, allocator independence, themes and 375px", async () => {
    if (!available) return;
    provider.consumeBodies = [];
    provider.consumeAttempts = 0;
    provider.overviewCalls = 0;
    provider.activeOverviewCalls = 0;
    provider.maxActiveOverviewCalls = 0;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: OWNER_COOKIE_VALUE,
        url: `http://127.0.0.1:${publicPort}`,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${publicPort}/workspaces/${workspaceId}/settings`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Codex subscriptions" }).waitFor({ timeout: 20_000 });
    const accountCard = (name: string) =>
      page.getByRole("article", { name: `${name} Codex subscription` });
    await accountCard("Detailed account")
      .getByText("Provider detail is complete.")
      .waitFor({ timeout: 20_000 });
    await accountCard("Detailed account")
      .getByText(/resets .+ \(in \d+[mhd]\)/)
      .first()
      .waitFor();
    await accountCard("Detailed account")
      .getByText(/Earlier attempt: The provider found no reset credit to use\..+available again\./)
      .waitFor();
    await accountCard("Detailed account")
      .getByText("Earlier attempt: The provider found no reset credit to use.", { exact: true })
      .waitFor();
    expect(
      await accountCard("Detailed account")
        .getByText(/available again\./)
        .count(),
    ).toBe(1);
    await accountCard("Count-only account")
      .getByText(/individual details are unavailable\. View only\./)
      .waitFor();
    await accountCard("Capped account")
      .getByText("The provider returned fewer details than its count. View only.")
      .waitFor();
    await accountCard("Unknown account")
      .getByText("The provider returned reset data OpenGeni does not recognize. View only.")
      .waitFor();
    await accountCard("Unsupported account")
      .getByText("This subscription does not expose reset-credit details.")
      .waitFor();
    await accountCard("Error account")
      .getByText("Reset-credit inventory is unavailable. Refresh to retry.")
      .waitFor();
    await accountCard("Cached account")
      .getByText(/OpenGeni cache · stale/)
      .waitFor();
    expect(provider.maxActiveOverviewCalls).toBeLessThanOrEqual(4);
    expect(await page.getByRole("button", { name: /^Redeem / }).count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const aria = await accountCard("Detailed account").ariaSnapshot();
    expect(aria).toContain('radio "Use Detailed account as active subscription"');
    expect(aria).toContain('checkbox "Use Detailed account for new automatic turns"');
    expect(aria).toContain('button "Redeem Full reset"');
    await expectNoWcagAxeViolations(page, 'section[aria-labelledby="codex-subscriptions-heading"]');
    await page.screenshot({
      path: `${EVIDENCE_DIR}/codex-quota-desktop-dark.png`,
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.setAttribute("data-og-theme", "light"));
    await page.screenshot({
      path: `${EVIDENCE_DIR}/codex-quota-desktop-light.png`,
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.removeAttribute("data-og-theme"));

    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 740 },
      hasTouch: true,
      isMobile: true,
    });
    await mobileContext.addCookies([
      {
        name: "better-auth.session_token",
        value: OWNER_COOKIE_VALUE,
        url: `http://127.0.0.1:${publicPort}`,
        sameSite: "Lax",
      },
    ]);
    const mobile = await mobileContext.newPage();
    await mobile.goto(`http://127.0.0.1:${publicPort}/workspaces/${workspaceId}/settings`, {
      waitUntil: "domcontentloaded",
    });
    await mobile.getByRole("heading", { name: "Codex subscriptions" }).waitFor({ timeout: 20_000 });
    const mobileDetailed = mobile.getByRole("article", {
      name: "Detailed account Codex subscription",
    });
    await mobileDetailed.getByRole("button", { name: "Redeem Full reset" }).waitFor();
    expect(
      (await mobileDetailed.getByRole("button", { name: "Redeem Full reset" }).boundingBox())
        ?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
    expect(
      (
        await mobileDetailed
          .locator('label:has(input[aria-label="Use Detailed account for new automatic turns"])')
          .boundingBox()
      )?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expectNoWcagAxeViolations(
      mobile,
      'section[aria-labelledby="codex-subscriptions-heading"]',
    );
    await mobile.evaluate(() => document.documentElement.setAttribute("data-og-theme", "light"));
    await mobile.screenshot({
      path: `${EVIDENCE_DIR}/codex-quota-mobile-light.png`,
      fullPage: true,
    });
    await mobile.evaluate(() => document.documentElement.removeAttribute("data-og-theme"));
    await mobile.screenshot({
      path: `${EVIDENCE_DIR}/codex-quota-mobile-dark.png`,
      fullPage: true,
    });
    await mobileDetailed.getByRole("button", { name: "Redeem Full reset" }).tap();
    const mobileDialog = mobile.getByRole("dialog");
    await mobileDialog.waitFor();
    await expectNoWcagAxeViolations(mobile, '[data-slot="dialog-content"]');
    const mobileCancel = mobileDialog.getByRole("button", { name: "Cancel" });
    expect((await mobileCancel.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await mobileCancel.tap();
    await mobileDialog.waitFor({ state: "hidden" });
    expect(provider.consumeBodies).toHaveLength(0);
    await mobileContext.close();

    const callsAfterExplicitLoads = provider.overviewCalls;
    await Bun.sleep(250);
    expect(provider.overviewCalls).toBe(callsAfterExplicitLoads);

    const allocator = page.getByRole("checkbox", {
      name: "Use Detailed account for new automatic turns",
    });
    await allocator.click();
    await waitFor(async () => !(await allocator.isChecked()), {
      timeoutMs: 10_000,
    });
    expect(provider.consumeBodies).toHaveLength(0);

    // Simulate a lost completed noCredit HTTP response from the earlier browser:
    // the server has durable non-consuming history, while sessionStorage still
    // carries its obsolete logical UUID. A new click must discard it and create
    // a fresh provider idempotency key.
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), {
      key: `opengeni.codexResetAttempt:${workspaceId}:${defaultAccountId}:${encodeURIComponent("detailed-credit")}`,
      value: priorNonConsumingAttemptId,
    });

    await page.getByRole("button", { name: "Redeem Full reset" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Cancel");
    const cancelBox = await dialog.getByRole("button", { name: "Cancel" }).boundingBox();
    expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(provider.consumeBodies).toHaveLength(0);

    // Cancel before the first POST clears the browser-local logical attempt;
    // reopening starts a fresh confirmation rather than claiming uncertainty.
    await page.getByRole("button", { name: "Redeem Full reset" }).click();
    await dialog.getByRole("button", { name: "Redeem usage limit reset" }).click();
    await page
      .getByText(/API 503|ambiguous/i)
      .first()
      .waitFor({ timeout: 10_000 });
    expect(provider.consumeBodies).toHaveLength(1);
    expect(provider.consumeBodies[0]?.redeem_request_id).not.toBe(priorNonConsumingUpstreamKey);
    const callsBeforeFreshCacheReload = provider.overviewCalls;
    await context.close();

    // A genuinely separate Better Auth session represents a new device/browser:
    // it has no sessionStorage checkpoint and a different hashed session id.
    // Owner-scoped server recovery must still reveal and adopt the exact attempt.
    const recoveryContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await recoveryContext.addCookies([
      {
        name: "better-auth.session_token",
        value: ROTATED_OWNER_COOKIE_VALUE,
        url: `http://127.0.0.1:${publicPort}`,
        sameSite: "Lax",
      },
    ]);
    const recoveryPage = await recoveryContext.newPage();
    await recoveryPage.goto(`http://127.0.0.1:${publicPort}/workspaces/${workspaceId}/settings`, {
      waitUntil: "domcontentloaded",
    });
    await recoveryPage
      .getByRole("heading", { name: "Codex subscriptions" })
      .waitFor({ timeout: 20_000 });
    // Usage/count caches are still fresh, but detailed rows are never cached as
    // authority. A remount must therefore issue one live overview and restore the
    // durable same-attempt resume affordance rather than rendering no inventory.
    await waitFor(async () => provider.overviewCalls > callsBeforeFreshCacheReload, {
      timeoutMs: 10_000,
    });
    expect(
      await recoveryPage.evaluate(() =>
        Object.keys(sessionStorage).some((key) => key.startsWith("opengeni.codexResetAttempt:")),
      ),
    ).toBe(false);
    // The provider has removed the credit after the ambiguous first call. The
    // browser exposes only the durable same-attempt resume path. With no stale
    // local provider title, the fallback label remains deliberately generic.
    await recoveryPage
      .getByRole("button", {
        name: "Resume uncertain redemption of usage limit reset",
      })
      .click();
    await recoveryPage
      .getByRole("dialog")
      .getByRole("button", { name: "Redeem usage limit reset" })
      .click();
    await recoveryPage.getByText(/earlier redemption succeeded/i).waitFor({ timeout: 20_000 });
    expect(provider.consumeBodies).toHaveLength(2);
    expect(new Set(provider.consumeBodies.map((body) => body.redeem_request_id)).size).toBe(1);
    expect(
      await recoveryPage
        .getByRole("checkbox", {
          name: "Use Detailed account for new automatic turns",
        })
        .isChecked(),
    ).toBe(false);
    expect(
      await recoveryPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expectNoWcagAxeViolations(
      recoveryPage,
      'section[aria-labelledby="codex-subscriptions-heading"]',
    );
    await recoveryContext.close();

    // A third session also starts without local state. Durable completion must
    // render directly from PostgreSQL even though the provider no longer lists
    // the credit; no further consume or uncertain-resume affordance is allowed.
    const completedContext = await browser.newContext({
      viewport: { width: 375, height: 740 },
      hasTouch: true,
      isMobile: true,
    });
    await completedContext.addCookies([
      {
        name: "better-auth.session_token",
        value: FINAL_OWNER_COOKIE_VALUE,
        url: `http://127.0.0.1:${publicPort}`,
        sameSite: "Lax",
      },
    ]);
    const completedPage = await completedContext.newPage();
    await completedPage.goto(`http://127.0.0.1:${publicPort}/workspaces/${workspaceId}/settings`, {
      waitUntil: "domcontentloaded",
    });
    await completedPage
      .getByText("The earlier redemption succeeded; usage was refreshed.")
      .waitFor({ timeout: 20_000 });
    expect(
      await completedPage.getByRole("button", { name: /Resume uncertain redemption/ }).count(),
    ).toBe(0);
    expect(provider.consumeBodies).toHaveLength(2);
    expect(
      await completedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expectNoWcagAxeViolations(
      completedPage,
      'section[aria-labelledby="codex-subscriptions-heading"]',
    );
    await completedContext.close();
  }, 120_000);
});
