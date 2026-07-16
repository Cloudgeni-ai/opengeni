import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { createDb, createSession, grantWorkspaceAccess, removeWorkspaceMember } from "@opengeni/db";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
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
} from "playwright";
import postgres from "postgres";

const repoRoot = new URL("../..", import.meta.url).pathname;
const ownerHeaders = { "x-opengeni-subject": "ope26-owner" };
const otherMemberHeaders = { "x-opengeni-subject": "ope26-other-member" };
const workflowClient: SessionWorkflowClient = {
  signalUserMessage: async () => undefined,
  wakeSessionWorkflow: async () => undefined,
  signalApprovalDecision: async () => undefined,
  signalSessionControl: async () => undefined,
  syncScheduledTask: async () => undefined,
  deleteScheduledTaskSchedule: async () => undefined,
  triggerScheduledTask: async () => undefined,
  startRigVerification: async () => undefined,
};

describe("session pins browser e2e (real API + non-superuser PostgreSQL)", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let apiBaseUrl: string;
  let webBaseUrl: string;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("session-pins-browser");
    if (!acquired) {
      throw new Error("session pin browser E2E requires real PostgreSQL; no skip is allowed");
    }
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    const app = createApp({
      // Exercise the normal configured-principal access path so independent
      // contexts can represent either the same member on another device or a
      // different member in the same bootstrapped workspace. This is not a DB
      // or localStorage identity shortcut; every request still traverses the
      // public access, membership, subject-GUC, and FORCE-RLS boundaries.
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
        ready: async () => (await fetch(webBaseUrl).catch(() => null))?.ok === true,
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

  test("pins through UI, reconciles another device, and stays above newer paged/search rows", async () => {
    const deviceA = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const pageA = await deviceA.newPage();
    await pageA.goto(webBaseUrl);
    const workspaceId = await workspaceFromPage(pageA);
    const longTitle = `Master pin target ${"with a deliberately long title ".repeat(6)}`.slice(
      0,
      200,
    );
    const target = await createSessionThroughApi(pageA, apiBaseUrl, workspaceId, longTitle);
    await Bun.sleep(10);
    await createSessionThroughApi(
      pageA,
      apiBaseUrl,
      workspaceId,
      "Ordinary session before the pin",
    );

    const targetUrl = `${webBaseUrl}/workspaces/${workspaceId}/sessions/${target.id}`;
    await pageA.goto(targetUrl);
    // Pin from the ordinary list-row action, not just the header. The header
    // must reconcile from the same server-authoritative member relation.
    await pageA.getByRole("button", { name: /^Actions for Master pin target/ }).click();
    await pageA.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await pageA.getByRole("button", { name: "Unpin session" }).waitFor();
    const pinnedA = pageA.getByRole("group", { name: "Pinned" });
    await pinnedA.getByRole("button", { name: /^Open Master pin target/ }).waitFor();

    // A genuinely separate browser context represents another device: it owns
    // independent document, cache, BroadcastChannel, and focus state, while the
    // local-mode authenticated principal is intentionally the same human.
    const deviceB = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const pageB = await deviceB.newPage();
    await pageB.goto(targetUrl);
    await pageB.getByRole("button", { name: "Unpin session" }).waitFor();
    await createSessionThroughApi(pageB, apiBaseUrl, workspaceId, "Newer unrelated activity");
    await pageB.reload();
    await pageB.getByRole("button", { name: "Unpin session" }).waitFor();
    const pinnedB = pageB.getByRole("group", { name: "Pinned" });
    await pinnedB.getByRole("button", { name: /^Open Master pin target/ }).waitFor();
    expect(
      await pinnedB
        .getByRole("button", { name: /^Open / })
        .first()
        .getAttribute("aria-label"),
    ).toStartWith("Open Master pin target");

    // A different member in the same workspace must keep their own ordinary
    // ordering and header state. This context uses the same public configured
    // access path but a distinct authenticated subject; owner pins never leak.
    const otherMember = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: otherMemberHeaders,
    });
    const otherPage = await otherMember.newPage();
    await otherPage.goto(targetUrl);
    await otherPage.getByRole("button", { name: "Pin session" }).waitFor();
    expect(await otherPage.getByRole("group", { name: "Pinned" }).count()).toBe(0);

    // Search is server-backed: a matching pin remains in the pin section while
    // unrelated ordinary rows disappear instead of being forced through.
    const search = pageB.getByRole("searchbox", { name: "Search sessions" });
    await search.fill("Master pin target");
    await pageB.getByText("1 matching session.").waitFor();
    await pinnedB.getByRole("button", { name: /^Open Master pin target/ }).waitFor();
    expect(
      await pageB.getByRole("button", { name: /^Open Newer unrelated activity/ }).count(),
    ).toBe(0);
    await search.fill("");
    await pageB
      .getByRole("button", { name: /^Open Newer unrelated activity/ })
      .waitFor({ timeout: 10_000 });

    // Pagination is also exercised through the normal authenticated browser API
    // path. Pins are complete on every page and never consume/duplicate an
    // ordinary cursor slot.
    const firstPage = await listPageFromBrowser(pageB, apiBaseUrl, workspaceId, { limit: 1 });
    expect(firstPage.pinned.map((session) => session.id)).toEqual([target.id]);
    expect(firstPage.sessions.map((session) => session.id)).not.toContain(target.id);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await listPageFromBrowser(pageB, apiBaseUrl, workspaceId, {
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.pinned.map((session) => session.id)).toEqual([target.id]);
    expect(secondPage.sessions.map((session) => session.id)).not.toContain(target.id);
    const filtered = await listPageFromBrowser(pageB, apiBaseUrl, workspaceId, {
      limit: 1,
      search: "Master pin target",
    });
    expect(filtered.pinned.map((session) => session.id)).toEqual([target.id]);
    expect(filtered.sessions).toEqual([]);

    // The rail uses real roving focus. Arrow navigation changes document focus,
    // Home returns to the pin, and Enter activates the currently focused row.
    const targetRow = pinnedB.getByRole("button", { name: /^Open Master pin target/ });
    await targetRow.focus();
    await pageB.keyboard.press("ArrowDown");
    expect(
      await pageB.evaluate(() => document.activeElement?.getAttribute("data-session-focus")),
    ).not.toBeNull();
    expect(
      await pageB.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).not.toStartWith("Open Master pin target");
    await pageB.keyboard.press("Home");
    expect(
      await pageB.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).toStartWith("Open Master pin target");

    // A data refresh must preserve the keyboard user's still-visible roving
    // target rather than jumping focus back to the route-active pinned row.
    await pageB.keyboard.press("ArrowDown");
    const focusedBeforeRefresh = await pageB.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );
    expect(focusedBeforeRefresh).not.toBeNull();
    expect(focusedBeforeRefresh).not.toStartWith("Open Master pin target");
    await createSessionThroughApi(pageB, apiBaseUrl, workspaceId, "Refresh-only activity");
    await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
    await pageB
      .getByRole("button", { name: /^Open Refresh-only activity/ })
      .waitFor({ timeout: 10_000 });
    expect(await pageB.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      focusedBeforeRefresh,
    );

    // Validate semantic/contrast regressions in both desktop themes while the
    // real pinned rail and session header are visible, and retain inspectable
    // visual evidence outside the source tree.
    for (const theme of ["light", "dark"] as const) {
      await setTheme(pageB, theme);
      await expectNoPageOverflow(pageB);
      await expectNoAxeViolations(pageB, [
        "[data-ope26-session-header]",
        "[data-ope26-session-list]",
      ]);
      await pageB.screenshot({
        path: `/tmp/ope26-session-pin-desktop-${theme}.png`,
        fullPage: true,
      });
    }

    // Offline failure rolls the exact optimistic projection back. Retrying
    // online through the same header action succeeds without a second logical
    // pin state or an OCC dead end.
    await deviceB.setOffline(true);
    await pageB.getByRole("button", { name: "Unpin session" }).click();
    await pageB.getByText("Couldn't unpin session", { exact: true }).waitFor();
    await pageB.getByRole("button", { name: "Unpin session" }).waitFor();
    await deviceB.setOffline(false);
    await pageB.getByRole("button", { name: "Unpin session" }).click();
    await pageB.getByRole("button", { name: "Pin session" }).waitFor();

    // Unpin is immediate and reconciles back to the first device on refresh.
    await pageA.reload();
    await pageA.getByRole("button", { name: "Pin session" }).waitFor();
    expect(await pageA.getByRole("group", { name: "Pinned" }).count()).toBe(0);

    // Pin from the header as a fresh OCC revision, then prove both the second
    // owner device and the other member reconcile to their respective truths.
    await pageA.getByRole("button", { name: "Pin session" }).click();
    await pageA.getByRole("button", { name: "Unpin session" }).waitFor();
    await pageB.reload();
    await pageB.getByRole("button", { name: "Unpin session" }).waitFor();
    await otherPage.reload();
    await otherPage.getByRole("button", { name: "Pin session" }).waitFor();
    expect(await otherPage.getByRole("group", { name: "Pinned" }).count()).toBe(0);

    await otherMember.close();
    await deviceB.close();
    await deviceA.close();
  }, 150_000);

  test("renders one truthful queue, goal, and agents stack above the composer", async () => {
    const desktop = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    let mobile: BrowserContext | null = null;
    try {
      const desktopPage = await desktop.newPage();
      await desktopPage.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(desktopPage);
      const manager = await createSessionThroughApi(
        desktopPage,
        apiBaseUrl,
        workspaceId,
        "Inspect the full session-control surface",
        {
          goal: {
            text: "Make queueing, goals, and agent activity completely understandable",
            successCriteria: "The UI has one compact and truthful surface for each concept.",
          },
        },
      );

      // Child lineage is intentionally not caller-forgeable through the public
      // create-session API: only a worker-signed parent grant may create it. This
      // browser fixture seeds that trusted relationship directly, then exercises
      // the ordinary authenticated lineage read and production UI rendering.
      for (const index of [1, 2]) {
        await createSession(dbClient.db, {
          accountId: manager.accountId,
          workspaceId,
          initialMessage: `Trusted child agent ${index}`,
          resources: [],
          metadata: {},
          model: "scripted-model",
          sandboxBackend: "none",
          parentSessionId: manager.id,
        });
      }

      const managerUrl = `${webBaseUrl}/workspaces/${workspaceId}/sessions/${manager.id}`;
      await desktopPage.goto(managerUrl);
      const queue = desktopPage.getByTestId("queue-surface");
      const goal = desktopPage.getByTestId("goal-surface");
      const agents = desktopPage.getByTestId("composer-agents-pill");
      const composer = desktopPage.getByLabel("Message the agent");
      await queue.getByText("1 queued prompt", { exact: true }).waitFor();
      await goal.waitFor();
      await agents.waitFor();
      await composer.waitFor();
      expect(await desktopPage.getByTestId("queue-surface").count()).toBe(1);
      expect(await desktopPage.getByTestId("composer-agents-pill").count()).toBe(1);

      // Enter appends an ordinary human prompt to the one visible queue. The
      // inert workflow client keeps both rows waiting so the browser can inspect
      // the exact server-authoritative order.
      await composer.fill("A second prompt queued from the composer");
      await composer.press("Enter");
      await queue.getByText("2 queued prompts", { exact: true }).waitFor({ timeout: 10_000 });
      await queue.getByRole("button", { name: /2 queued prompts/ }).click();
      await queue.getByRole("list", { name: "Queued prompts" }).waitFor();
      const queuedRows = queue.getByRole("listitem");
      expect(await queuedRows.count()).toBe(2);
      expect(await queuedRows.nth(0).innerText()).toContain(
        "Inspect the full session-control surface",
      );
      expect(await queuedRows.nth(1).innerText()).toContain(
        "A second prompt queued from the composer",
      );
      const timeline = desktopPage.getByTestId("session-timeline");
      expect(await timeline.getByText("Inspect the full session-control surface").count()).toBe(0);
      expect(await timeline.getByText("A second prompt queued from the composer").count()).toBe(0);

      const boxes = await Promise.all([
        queue.boundingBox(),
        goal.boundingBox(),
        agents.boundingBox(),
        composer.boundingBox(),
      ]);
      for (const box of boxes) expect(box).not.toBeNull();
      expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
      expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
      expect(boxes[2]!.y).toBeLessThan(boxes[3]!.y);

      for (const theme of ["light", "dark"] as const) {
        await setTheme(desktopPage, theme);
        await expectNoPageOverflow(desktopPage);
        await expectNoAxeViolations(desktopPage, [
          "[data-testid=queue-surface]",
          "[data-testid=goal-surface]",
          "[data-testid=composer-agents-pill]",
          "textarea[aria-label='Message the agent']",
        ]);
        await desktopPage.screenshot({
          path: `/tmp/opengeni-session-control-stack-desktop-${theme}.png`,
          fullPage: true,
        });
      }

      mobile = await configuredContext(browser, {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        extraHTTPHeaders: ownerHeaders,
      });
      const mobilePage = await mobile.newPage();
      await mobilePage.goto(managerUrl);
      await mobilePage.getByTestId("queue-surface").waitFor();
      await mobilePage.getByTestId("goal-surface").waitFor();
      await mobilePage.getByTestId("composer-agents-pill").waitFor();
      await expectNoPageOverflow(mobilePage);
      await expectTouchTarget(
        mobilePage.getByTestId("queue-surface").getByRole("button", { name: /2 queued prompts/ }),
      );
      await expectTouchTarget(mobilePage.getByTestId("composer-agents-pill"));
      await mobilePage.screenshot({
        path: "/tmp/opengeni-session-control-stack-mobile.png",
        fullPage: true,
      });
    } finally {
      await mobile?.close().catch(() => undefined);
      await desktop.close().catch(() => undefined);
    }
  }, 150_000);

  test("keeps the pin/header/rail usable at 320px in light and dark themes", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 320, height: 740 },
      hasTouch: true,
      isMobile: true,
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    await page.goto(webBaseUrl);
    const workspaceId = await workspaceFromPage(page);
    const target = await createSessionThroughApi(
      page,
      apiBaseUrl,
      workspaceId,
      `Mobile pin ${"long title ".repeat(20)}`.slice(0, 200),
    );
    await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${target.id}`);
    await page.getByRole("button", { name: "Pin session" }).click();
    await page.getByRole("button", { name: "Unpin session" }).waitFor();

    // Stress the compact pinned section with many long rows through the normal
    // browser-authenticated API. No direct DB mutation is used.
    for (let index = 0; index < 7; index += 1) {
      const extra = await createSessionThroughApi(
        page,
        apiBaseUrl,
        workspaceId,
        `Pinned mobile stress ${index + 1} ${"long title ".repeat(14)}`.slice(0, 200),
      );
      await setSessionPinThroughApi(page, apiBaseUrl, workspaceId, extra, true);
    }
    // The stress rows above are test fixtures inserted through raw fetches,
    // intentionally bypassing the application's mutation invalidation. Start
    // the responsive assertion from a fresh server projection instead of
    // racing the rail's 15-second background reconciliation interval.
    await page.reload();
    await page.getByRole("button", { name: "Unpin session" }).waitFor();

    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await expectNoPageOverflow(page);
      const pin = page.getByRole("button", { name: /^(Pin|Unpin) session$/ });
      const inspector = page.getByRole("button", { name: /session panel$/ });
      const hamburger = page.getByRole("button", { name: "Open navigation" });
      for (const control of [pin, inspector, hamburger]) {
        const box = await control.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }

      // Capture the actual opened drawer and pinned section in each theme, not
      // merely the header behind a closed drawer.
      await page.getByRole("button", { name: "Open navigation" }).click();
      const navigation = page.getByRole("navigation", { name: "Primary" });
      await navigation.waitFor();
      expect(await page.getByRole("dialog").getAttribute("aria-label")).toBe("Session navigation");
      const targetRow = navigation.getByRole("button", { name: /^Open Mobile pin/ });
      await targetRow.waitFor();
      // The active route row can render from its point read before the pinned
      // page arrives. Wait for one seeded shortcut so this assertion measures
      // the loaded global pin section rather than that intermediate state.
      await navigation.getByRole("button", { name: /^Open Pinned mobile stress 7/ }).waitFor();
      expect(await navigation.getByRole("group", { name: "Pinned" }).count()).toBe(1);
      expect(
        await navigation.getByRole("button", { name: /^Open Pinned mobile stress/ }).count(),
      ).toBe(7);
      await expectTouchTarget(targetRow);
      await expectTouchTarget(navigation.getByRole("button", { name: /^Actions for Mobile pin/ }));
      await expectTouchTarget(navigation.getByRole("searchbox", { name: "Search sessions" }));
      await expectContainedInViewport(navigation, 320);
      await expectNoPageOverflow(page);
      await expectNoAxeViolations(page, [
        "[data-ope26-session-header]",
        "[data-ope26-session-list]",
      ]);
      await page.screenshot({
        path: `/tmp/ope26-session-pin-mobile-${theme}.png`,
        fullPage: true,
      });

      await page.keyboard.press("Escape");
      await page.getByRole("navigation", { name: "Primary" }).waitFor({ state: "hidden" });
      // Radix restores focus after the drawer's close animation settles. Wait
      // for that observable contract rather than racing the animation frame.
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Open navigation",
      );
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
        "Open navigation",
      );
    }
    await context.close();
  }, 90_000);

  test("keeps token-carried listing alive when removal wins, with personal state cleaned", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    const barrier = postgres(shared.adminUrl, { max: 1 });
    const removalClient = createDb(shared.appUrl, { max: 1 });
    const raceSecret = "ope26-browser-race-secret";
    const raceSubject = "configured:ope26-browser-race";
    const barrierClass = 81326028;
    const removalLock = 1;
    const triggerFunction = "ope26_browser_removal_first_barrier";
    const triggerName = "ope26_browser_removal_first_membership_barrier";
    let removalPromise: Promise<boolean> | null = null;
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const [workspace] = await shared.admin<{ accountId: string }[]>`
        select account_id as "accountId" from workspaces where id = ${workspaceId}`;
      expect(workspace?.accountId).toBeTruthy();
      await grantWorkspaceAccess(dbClient.db, {
        accountId: workspace!.accountId,
        workspaceId,
        subjectId: raceSubject,
        permissions: ["sessions:read"] satisfies Permission[],
      });
      await createSessionThroughApi(page, apiBaseUrl, workspaceId, "API race first");
      await createSessionThroughApi(page, apiBaseUrl, workspaceId, "API race second");

      const raceApp = createApp({
        settings: testSettings({
          databaseUrl: shared.appUrl,
          productAccessMode: "configured",
          delegationSecret: raceSecret,
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient,
      });
      const token = await signDelegatedAccessToken(raceSecret, {
        accountId: workspace!.accountId,
        workspaceId,
        subjectId: raceSubject,
        permissions: ["sessions:read"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${barrierClass}, ${removalLock});
          return old;
        end
        $$;
        create trigger ${triggerName}
          before delete on workspace_memberships
          for each row when (
            old.workspace_id = '${workspaceId}'::uuid
            and old.subject_id = '${raceSubject}'
          ) execute function ${triggerFunction}();
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${removalLock})`;

      removalPromise = removeWorkspaceMember(removalClient.db, workspaceId, raceSubject);
      await waitForAdvisoryWait(barrier, barrierClass, removalLock);

      const listingPromise = raceApp.request(
        `/v1/workspaces/${workspaceId}/sessions?view=page&limit=1`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      await waitForDatabaseQueryWait(barrier, "workspace_memberships");
      await barrier`select pg_advisory_unlock(${barrierClass}, ${removalLock})`;
      expect(await removalPromise).toBe(true);

      // The delegated token carries its own workspace grant — losing the
      // membership row must not revoke listing (that same over-reach 403'd
      // every workspace-scoped api_key principal in production). Membership
      // is personalization for non-user subjects, not authorization: removal
      // cleans their pins, and any snapshot the post-removal listing writes is
      // TTL-bounded, not an unbounded leak.
      const response = await listingPromise;
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        pinned: unknown[];
        sessions: { id: string }[];
      };
      expect(body.pinned).toEqual([]);
      expect(body.sessions.length).toBe(1);

      const [counts] = await shared.admin<{ pins: number; unboundedSnapshots: number }[]>`
        select
          (select count(*)::int from session_pins
            where workspace_id = ${workspaceId} and subject_id = ${raceSubject}) as pins,
          (select count(*)::int from session_list_snapshots
            where workspace_id = ${workspaceId}
              and subject_id = ${raceSubject}
              and expires_at > now() + interval '11 minutes') as "unboundedSnapshots"`;
      expect(counts).toEqual({ pins: 0, unboundedSnapshots: 0 });
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${triggerName} on workspace_memberships;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([removalPromise].filter(Boolean));
      await removalClient.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 60_000);

  test("returns authenticated 403 when removal wins a concurrent pin mutation", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    const barrier = postgres(shared.adminUrl, { max: 1 });
    const removalClient = createDb(shared.appUrl, { max: 1 });
    const raceSecret = "ope26-browser-pin-race-secret";
    const raceSubject = "configured:ope26-browser-pin-race";
    const barrierClass = 81326031;
    const removalLock = 1;
    const triggerFunction = "ope26_browser_pin_removal_first_barrier";
    const triggerName = "ope26_browser_pin_removal_first_membership_barrier";
    let removalPromise: Promise<boolean> | null = null;
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const [workspace] = await shared.admin<{ accountId: string }[]>`
        select account_id as "accountId" from workspaces where id = ${workspaceId}`;
      expect(workspace?.accountId).toBeTruthy();
      await grantWorkspaceAccess(dbClient.db, {
        accountId: workspace!.accountId,
        workspaceId,
        subjectId: raceSubject,
        permissions: ["sessions:read"] satisfies Permission[],
      });
      const target = await createSessionThroughApi(page, apiBaseUrl, workspaceId, "API pin race");

      const raceApp = createApp({
        settings: testSettings({
          databaseUrl: shared.appUrl,
          productAccessMode: "configured",
          delegationSecret: raceSecret,
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient,
      });
      const token = await signDelegatedAccessToken(raceSecret, {
        accountId: workspace!.accountId,
        workspaceId,
        subjectId: raceSubject,
        permissions: ["sessions:read"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      await barrier.unsafe(`
        create function ${triggerFunction}() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${barrierClass}, ${removalLock});
          return old;
        end
        $$;
        create trigger ${triggerName}
          before delete on workspace_memberships
          for each row when (
            old.workspace_id = '${workspaceId}'::uuid
            and old.subject_id = '${raceSubject}'
          ) execute function ${triggerFunction}();
      `);
      await barrier`select pg_advisory_lock(${barrierClass}, ${removalLock})`;

      removalPromise = removeWorkspaceMember(removalClient.db, workspaceId, raceSubject);
      await waitForAdvisoryWait(barrier, barrierClass, removalLock);

      const pinPromise = raceApp.request(
        `/v1/workspaces/${workspaceId}/sessions/${target.id}/pin`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ pinned: true, expectedVersion: 0 }),
        },
      );
      await waitForDatabaseQueryWait(barrier, "workspace_memberships");
      await barrier`select pg_advisory_unlock(${barrierClass}, ${removalLock})`;
      expect(await removalPromise).toBe(true);

      const response = await pinPromise;
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("workspace access denied");

      const [counts] = await shared.admin<{ memberships: number; pins: number; orphans: number }[]>`
        select
          (select count(*)::int from workspace_memberships
            where workspace_id = ${workspaceId} and subject_id = ${raceSubject}) as memberships,
          (select count(*)::int from session_pins
            where workspace_id = ${workspaceId} and subject_id = ${raceSubject}) as pins,
          (select count(*)::int
            from session_pins pin
            left join workspace_memberships membership
              on membership.workspace_id = pin.workspace_id
             and membership.subject_id = pin.subject_id
            where pin.workspace_id = ${workspaceId}
              and membership.id is null) as orphans`;
      expect(counts).toEqual({ memberships: 0, pins: 0, orphans: 0 });
    } finally {
      await barrier`select pg_advisory_unlock_all()`.catch(() => undefined);
      await barrier
        .unsafe(`
        drop trigger if exists ${triggerName} on workspace_memberships;
        drop function if exists ${triggerFunction}();
      `)
        .catch(() => undefined);
      await barrier.end().catch(() => undefined);
      await Promise.allSettled([removalPromise].filter(Boolean));
      await removalClient.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 60_000);
});

type BrowserSession = {
  id: string;
  accountId: string;
  pinned: boolean;
  pinVersion: number;
};
type BrowserSessionPage = {
  pinned: BrowserSession[];
  sessions: BrowserSession[];
  nextCursor: string | null;
};

async function configuredContext(
  browser: Browser,
  options: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  // The console's configured-token panel stores the supplied value under this
  // key. In this test-only configured deployment there is intentionally no
  // delegation secret, so the API uses its supported x-opengeni-subject
  // principal fallback; the placeholder merely satisfies the real console
  // gate and is never treated as a credential or persisted outside context.
  await context.addInitScript(() => {
    localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
  });
  return context;
}

async function workspaceFromPage(page: Page): Promise<string> {
  await waitFor(() => /\/workspaces\/[^/]+\/sessions/.test(page.url()), { timeoutMs: 15_000 });
  return page.url().match(/\/workspaces\/([^/]+)\/sessions/)![1]!;
}

async function createSessionThroughApi(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  initialMessage: string,
  options: {
    goal?: {
      text: string;
      successCriteria?: string;
    };
  } = {},
): Promise<BrowserSession> {
  return await page.evaluate(
    async ({ apiBaseUrl, workspaceId, initialMessage, options }) => {
      const response = await fetch(`${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialMessage,
          model: "scripted-model",
          sandboxBackend: "none",
          ...options,
        }),
      });
      if (!response.ok) {
        throw new Error(`session create failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as BrowserSession;
    },
    { apiBaseUrl, workspaceId, initialMessage, options },
  );
}

async function setSessionPinThroughApi(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  session: BrowserSession,
  pinned: boolean,
): Promise<BrowserSession> {
  return await page.evaluate(
    async ({ apiBaseUrl, workspaceId, session, pinned }) => {
      const response = await fetch(
        `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions/${session.id}/pin`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned, expectedVersion: session.pinVersion ?? 0 }),
        },
      );
      if (!response.ok) {
        throw new Error(`session pin failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as BrowserSession;
    },
    { apiBaseUrl, workspaceId, session, pinned },
  );
}

async function listPageFromBrowser(
  page: Page,
  apiBaseUrl: string,
  workspaceId: string,
  options: { limit: number; cursor?: string; search?: string },
): Promise<BrowserSessionPage> {
  return await page.evaluate(
    async ({ apiBaseUrl, workspaceId, options }) => {
      const query = new URLSearchParams({ view: "page", limit: String(options.limit) });
      if (options.cursor) query.set("cursor", options.cursor);
      if (options.search) query.set("search", options.search);
      const response = await fetch(
        `${apiBaseUrl}/v1/workspaces/${workspaceId}/sessions?${query.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`session page failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as BrowserSessionPage;
    },
    { apiBaseUrl, workspaceId, options },
  );
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        [...document.querySelectorAll("header")].every(
          (header) => header.scrollWidth <= header.clientWidth,
        ),
    ),
  ).toBe(true);
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((nextTheme) => {
    if (nextTheme === "light") {
      document.documentElement.setAttribute("data-og-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-og-theme");
    }
  }, theme);
}

async function expectTouchTarget(locator: ReturnType<Page["getByRole"]>): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

async function expectContainedInViewport(
  locator: ReturnType<Page["getByRole"]>,
  viewportWidth: number,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
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

async function waitForAdvisoryWait(
  connection: postgres.Sql,
  classId: number,
  objectId: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_locks
        where locktype = 'advisory'
          and classid = ${classId}
          and objid = ${objectId}
          and not granted
      ) as waiting`;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for advisory lock ${classId}/${objectId}`);
}

async function waitForDatabaseQueryWait(
  connection: postgres.Sql,
  queryFragment: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query like ${`%${queryFragment}%`}
      ) as waiting`;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for database query containing ${queryFragment}`);
}
