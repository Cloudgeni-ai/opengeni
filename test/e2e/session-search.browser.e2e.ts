import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import {
  appendSessionEventsAndUpdateSession,
  createDb,
  createSession,
  updateSessionTitle,
} from "@opengeni/db";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import type { SessionMessageSearchResponse } from "../../packages/sdk/src/session-message-search";
import { acquireSearchTestDatabase } from "../../packages/db/test/session-message-search-fixture";
import {
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
  type Locator,
  type Page,
} from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const ownerHeaders = { "x-opengeni-subject": "sessionsearch-owner" };
const OWNER_SUBJECT = "sessionsearch-owner";
// Durable visual QA output for the shared parent sandbox; the parent
// publishes these. Override when running outside that layout.
const artifactDir = process.env.OPENGENI_SESSION_SEARCH_ARTIFACT_DIR ?? "/workspace/artifacts";
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

describe("session search browser e2e (real API + non-superuser PostgreSQL)", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let api: ReturnType<typeof Bun.serve>;
  let web: StartedProcess;
  let browser: Browser;
  let apiBaseUrl: string;
  let webBaseUrl: string;

  beforeAll(async () => {
    // Build before acquiring/migrating the real database and starting the API,
    // exactly like the session-pins gate: the production bundle is the
    // memory-heavy part of this acceptance run.
    const apiPort = await freePort();
    apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const webPort = await freePort();
    webBaseUrl = `http://127.0.0.1:${webPort}`;
    const webEnv = {
      NODE_ENV: "production",
      VITE_API_BASE_URL: apiBaseUrl,
    };
    const build = await runCommand(["bun", "run", "build"], {
      cwd: `${repoRoot}/apps/web`,
      env: webEnv,
      timeoutMs: 240_000,
    });
    if (build.exitCode !== 0) {
      throw new Error(
        `Production web build failed (exit ${build.exitCode}, timedOut=${String(build.timedOut)}):\n${build.stderr}\n${build.stdout}`,
      );
    }

    shared = await acquireSearchTestDatabase("session-search-browser");
    const appRole = decodeURIComponent(new URL(shared.appUrl).username);
    const [posture] = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = ${appRole}`;
    expect(posture).toEqual({ rolsuper: false, rolbypassrls: false });
    dbClient = createDb(shared.appUrl);
    sharedRef = shared;
    dbRef = dbClient.db;
    await mkdir(artifactDir, { recursive: true });
    const app = createApp({
      // Same configured-principal access path as the session-pins gate: every
      // request traverses the public access, membership, subject-GUC, and
      // FORCE-RLS boundaries.
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "configured",
        delegationSecret: undefined,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: apiPort,
      idleTimeout: 120,
      fetch: app.fetch,
    });
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
          (
            await fetch(webBaseUrl, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
    // Close the browser before stopping the API and draining the pool so
    // in-flight polling does not turn teardown into CONNECTION_ENDED noise.
    await api?.stop(false);
    await dbClient?.close().catch(() => undefined);
    await shared?.release();
  }, 60_000);

  test("desktop expanded header keeps icon-only search inline and opens its dialog by mouse and keyboard", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      await workspaceFromPage(page);
      const search = page.getByRole("button", { name: "Search sessions", exact: true });
      await search.waitFor();
      expect(await search.count()).toBe(1);
      expect(await search.innerText()).toBe("");
      expect(await search.getAttribute("aria-haspopup")).toBe("dialog");
      expect(await search.locator('svg[aria-hidden="true"]').count()).toBe(1);

      const header = search.locator("..");
      // The default view is not a customized/filtered view.
      const title = header.getByText("Sessions", { exact: true });
      const project = header.getByRole("button", { name: "New project", exact: true });
      const filter = header.getByRole("button", { name: "Session view", exact: true });
      await project.waitFor();
      const searchBox = (await search.boundingBox())!;
      for (const control of [title, project, filter]) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(
          Math.abs(box!.y + box!.height / 2 - (searchBox.y + searchBox.height / 2)),
        ).toBeLessThan(2);
      }
      expect(searchBox.width).toBeLessThanOrEqual(32);
      expect(searchBox.height).toBeLessThanOrEqual(32);
      // The heading is immediately followed by the list, not a second search row.
      expect(
        await header.evaluate((element) => element.nextElementSibling?.getAttribute("role")),
      ).toBe("region");
      await page.screenshot({ path: `${artifactDir}/session-search-compact-header-desktop.png` });

      const dialog = await openSearchDialog(page);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      for (const key of ["Enter", "Space"]) {
        await search.press(key);
        await dialog
          .getByRole("searchbox", { name: "Search session titles and messages", exact: true })
          .waitFor();
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
      }

      await filter.click();
      await page.getByRole("menuitem", { name: "Status Active" }).click();
      await page.getByRole("menuitemradio", { name: "Archived", exact: true }).press("Enter");
      const customized = header.getByRole("button", {
        name: "Session view, customized",
        exact: true,
      });
      await customized.waitFor();
      await page.mouse.move(1000, 700);
      await customized.blur();
      expect(await customized.locator(".bg-brand").count()).toBe(1);
      await waitFor(
        async () =>
          (await customized.evaluate((element) => getComputedStyle(element).backgroundColor)) ===
          "rgba(0, 0, 0, 0)",
      );
      await page.screenshot({
        path: `${artifactDir}/session-search-compact-header-filter-desktop.png`,
      });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("finds titles, user messages, and completed assistant messages, then opens the exact occurrence", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    const searchResponses: Array<Record<string, unknown>> = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.endsWith("/session-message-search")) return;
      void response
        .json()
        .then((body: SessionMessageSearchResponse) => {
          searchResponses.push({
            status: response.status(),
            sessionId: url.searchParams.get("sessionId"),
            groupBy: url.searchParams.get("groupBy"),
            cursorPresent: url.searchParams.has("cursor"),
            hasMore: body.hasMore,
            nextCursorPresent: !!body.nextCursor,
            scannedMessages: body.scannedMessages,
            matchedOccurrenceCount: body.matchedOccurrenceCount,
            matches: body.matches?.map((match) => ({
              sessionId: match.sessionId,
              title: match.sessionTitle,
              sequence: match.sequence,
              role: match.role,
              offset: match.messageMatchOffset,
            })),
          });
        })
        .catch(() => undefined);
    });
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const accountId = await accountIdForWorkspace(workspaceId);

      // Title-only match: the needle appears in the title/opening message
      // but in no user/assistant message body.
      // Deterministic UUID order forces grouped search to cross the long
      // assistant session before reaching the later user-message match. This
      // catches false exhaustion after skipping a full identity scan batch.
      const titleMatch = await seedSession(
        workspaceId,
        accountId,
        "Quartzpine release checklist",
        "10000000-0000-4000-8000-000000000001",
      );
      await seedConversation(workspaceId, titleMatch.id, [
        { user: "Please prepare the release notes for Friday." },
        { assistant: "The release notes are ready for review." },
      ]);
      // User-message match.
      const userMatch = await seedSession(
        workspaceId,
        accountId,
        "Vendor comparison",
        "30000000-0000-4000-8000-000000000001",
      );
      await seedConversation(workspaceId, userMatch.id, [
        { user: "Can you rank the quartzpine vendors by price?" },
        { assistant: "Ranked by price in the comparison table." },
      ]);
      // Assistant-message match that is old history by the time anyone
      // opens the session: sixty filler turns push it out of the rendered
      // window. `ledger-north` uniquely identifies this exact occurrence.
      const assistantMatch = await seedSession(
        workspaceId,
        accountId,
        "Proposal review",
        "20000000-0000-4000-8000-000000000001",
      );
      const needleEvents = await seedConversation(workspaceId, assistantMatch.id, [
        { user: "Where did the proposal end up?" },
        { assistant: "The quartzpine proposal is filed under ledger-north." },
        ...fillerTurns(60),
      ]);
      const needleEvent = needleEvents.find(
        (event) =>
          event.type === "agent.message.completed" &&
          String((event.payload as { text?: unknown }).text).includes("ledger-north"),
      );
      expect(needleEvent).toBeTruthy();
      // Decoys: the needle in a non-`text` payload field of a user message,
      // and in `payload.text` of a type outside the searched set. Neither
      // may produce a match or a snippet.
      const decoyField = await seedSession(workspaceId, accountId, "Decoy note field");
      await appendSessionEventsAndUpdateSession(
        dbClient.db,
        workspaceId,
        decoyField.id,
        [
          {
            type: "user.message",
            payload: { text: "Nothing relevant in this chat.", internalNote: "quartzpine" },
            clientEventId: crypto.randomUUID(),
          },
        ],
        { status: "idle" },
      );
      const decoyDelta = await seedSession(workspaceId, accountId, "Decoy stream fragment");
      await appendSessionEventsAndUpdateSession(
        dbClient.db,
        workspaceId,
        decoyDelta.id,
        [
          {
            type: "agent.message.delta",
            payload: { text: "quartzpine partial streaming token" },
          },
        ],
        { status: "idle" },
      );

      const dialog = await openSearchDialog(page);
      const input = dialog.getByRole("searchbox", {
        name: "Search session titles and messages",
        exact: true,
      });
      await expectFocused(input);
      expect(await dialog.getByText("Search sessions", { exact: true }).count()).toBe(1);

      await input.fill("quartzpine");
      const results = dialog.locator("[data-search-result]");
      let observedResults: string[] = [];
      await waitFor(
        async () => {
          observedResults = await results.allTextContents();
          return observedResults.length === 3;
        },
        {
          timeoutMs: 15_000,
          intervalMs: 150,
          describe: () =>
            `three quartzpine search results; observed ${JSON.stringify(observedResults)}; wire ${JSON.stringify(searchResponses)}; diagnostics ${(browserDiagnostics.get(context) ?? []).slice(-10).join("; ")}`,
        },
      );

      // Decoys never surface.
      expect(await dialog.getByText("Decoy note field", { exact: true }).count()).toBe(0);
      expect(await dialog.getByText("Decoy stream fragment", { exact: true }).count()).toBe(0);
      expect(await dialog.getByText("Nothing relevant in this chat.").count()).toBe(0);
      expect(await dialog.getByText(/partial streaming token/).count()).toBe(0);

      const titleRow = results.filter({ hasText: "Quartzpine release checklist" });
      expect(await titleRow.count()).toBe(1);
      // Title hits render as a literal <mark> highlight, never raw HTML.
      expect(await titleRow.first().locator("mark").allTextContents()).toContain("Quartzpine");
      await expectContainsText(titleRow.first(), "Title or opening message match");

      const userRow = results.filter({ hasText: "Vendor comparison" });
      expect(await userRow.count()).toBe(1);
      await expectContainsText(userRow.first(), "Message match");
      await expectContainsText(userRow.first(), "rank the quartzpine vendors by price");

      const assistantRow = results.filter({ hasText: "Proposal review" });
      expect(await assistantRow.count()).toBe(1);
      await expectContainsText(assistantRow.first(), "filed under ledger-north");

      // Selecting a row opens the in-dialog preview: the matched passage
      // with its surrounding user/assistant context from payload.text only.
      await assistantRow.first().click();
      const preview = dialog.getByRole("region", { name: "Conversation preview", exact: true });
      await preview.getByText(/ledger-north/).waitFor({ timeout: 15_000 });
      await expectContainsText(preview, "Matching passage");
      await preview.getByText(/Where did the proposal end up/).waitFor();
      expect((await preview.locator("mark").allTextContents()).length).toBeGreaterThan(0);

      // Title-only preview states the honest empty case.
      await titleRow.first().click();
      await preview
        .getByText("This session title matches. No matching message was found.", { exact: true })
        .waitFor();
      await preview.getByRole("button", { name: "Open session", exact: true }).waitFor();

      // Desktop visual + accessibility evidence of the loaded dialog.
      await expectNoAxeViolations(page, ['[role="dialog"]']);
      await page.screenshot({ path: `${artifactDir}/session-search-desktop.png` });

      // Back on the message match, "Open here" must land on the exact old
      // occurrence: same session route, literal query, and the recorded
      // event sequence.
      await assistantRow.first().click();
      await preview.getByText(/ledger-north/).waitFor({ timeout: 15_000 });
      await page.screenshot({ path: `${artifactDir}/session-search-desktop-preview.png` });
      await preview.getByRole("button", { name: "Open here", exact: true }).click();
      await page.waitForURL(`**/workspaces/${workspaceId}/sessions/${assistantMatch.id}**`);
      const landed = new URL(page.url());
      expect(landed.searchParams.get("find")).toBe("quartzpine");
      expect(landed.searchParams.get("matchSequence")).toBe(String(needleEvent!.sequence));
      const matchOffset = landed.searchParams.get("matchOffset");
      expect(matchOffset).not.toBeNull();
      expect(Number(matchOffset)).toBeGreaterThanOrEqual(0);
      await expectHidden(dialog);

      // The conversation find strip opens with the carried query and loads
      // the old occurrence into view.
      const find = conversationFind(page);
      await find.waitFor();
      await expectValue(
        find.getByRole("searchbox", { name: "Find in conversation" }),
        "quartzpine",
      );
      await expectTextInTimelineView(page, /ledger-north/);
    } finally {
      await writeFile(
        `${artifactDir}/session-search-wire.json`,
        JSON.stringify(searchResponses, null, 2),
      );
      await page.screenshot({ path: `${artifactDir}/session-search-desktop-last.png` });
      await context.close();
    }
  }, 120_000);

  test("Open here targets raw Markdown offsets, adjacent repeats, Unicode, and a long assistant message", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const accountId = await accountIdForWorkspace(workspaceId);
      const cases = [
        { name: "markdown-bold", text: "**bold** needle", query: "needle" },
        { name: "markdown-repeat", text: "**a**testtest", query: "test", nextOffset: 9 },
        {
          name: "markdown-unicode",
          text: "😀 **bold** [reference](https://example.invalid/path)\n\nA `code` line.\n\n🚀signal exact passage.",
          query: "🚀signal",
        },
        {
          name: "markdown-long",
          text: `${"A paragraph of **formatted** background without the target.\n\n".repeat(2_000)}farneedle final passage.`,
          query: "farneedle",
        },
      ];
      for (const fixture of cases) {
        const title = `Raw offset ${fixture.name}`;
        const session = await seedSession(workspaceId, accountId, title);
        const events = await seedConversation(workspaceId, session.id, [
          { user: "Please inspect this saved document." },
          { assistant: fixture.text },
          ...fillerTurns(60),
        ]);
        const target = events.find((event) => event.type === "agent.message.completed");
        expect(target).toBeTruthy();
        const offset = fixture.text.indexOf(fixture.query);
        const dialog = await openSearchDialog(page);
        await dialog
          .getByRole("searchbox", { name: "Search session titles and messages" })
          .fill(fixture.query);
        const row = dialog.locator("[data-search-result]").filter({ hasText: title });
        await row.waitFor({ timeout: 15_000 });
        await row.click();
        const preview = dialog.getByRole("region", { name: "Conversation preview", exact: true });
        await preview.getByRole("button", { name: "Open here", exact: true }).click();
        await page.waitForURL(`**/sessions/${session.id}**`);
        const landed = new URL(page.url());
        expect(landed.searchParams.get("matchSequence")).toBe(String(target!.sequence));
        expect(landed.searchParams.get("matchOffset")).toBe(String(offset));
        await expectExactSearchHighlight(page, fixture.query, target!.sequence, offset);
        await page.screenshot({ path: `${artifactDir}/session-search-${fixture.name}.png` });
        if (fixture.nextOffset !== undefined) {
          await conversationFind(page)
            .getByRole("button", { name: "Next match", exact: true })
            .click();
          await expectExactSearchHighlight(
            page,
            fixture.query,
            target!.sequence,
            fixture.nextOffset,
          );
        }
        if (fixture.name === "markdown-long") {
          const find = conversationFind(page);
          const scroller = page.locator("[data-og-timeline-scroller]");
          const beforeClose = await scroller.evaluate((node) => node.scrollTop);
          await find
            .getByRole("button", { name: "Close conversation search", exact: true })
            .click();
          await find.waitFor({ state: "detached" });
          try {
            // Closing Find retains the bounded source excerpt. Verify both
            // scroll position and the reading point, not only scrollTop.
            await expectTextInTimelineView(page, /farneedle final passage/);
            expect(
              Math.abs((await scroller.evaluate((node) => node.scrollTop)) - beforeClose),
            ).toBeLessThanOrEqual(2);
            expect(
              await page.evaluate(() => {
                const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> })
                  .highlights;
                return [...registry.keys()].some((name) => name.startsWith("og-search-"));
              }),
            ).toBe(false);
            const showFormatted = scroller.getByRole("button", {
              name: "Show formatted message",
              exact: true,
            });
            await showFormatted.waitFor();
            expect(await scroller.locator("mark[data-og-search-offset]").count()).toBe(0);
            await page.screenshot({
              path: `${artifactDir}/session-search-markdown-long-closed.png`,
            });
            // A layout change is now an explicit user choice, separate from
            // closing Find. Confirm the original rich body can be restored.
            await showFormatted.click();
            await scroller
              .getByText("farneedle final passage.", { exact: true })
              .waitFor({ state: "attached" });
            expect(await scroller.locator("strong").filter({ hasText: "formatted" }).count()).toBe(
              2_000,
            );
          } finally {
            await page.screenshot({
              path: `${artifactDir}/session-search-markdown-long-formatted.png`,
            });
          }
        }
      }
    } finally {
      await context.close();
    }
  }, 180_000);

  test("Ctrl/Cmd+F walks repeated occurrences through full saved history and closes without scrolling", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const accountId = await accountIdForWorkspace(workspaceId);
      const session = await seedSession(workspaceId, accountId, "Find walkthrough");
      // Four `lumen` occurrences: one old user message, two offsets inside
      // one old assistant message, and one recent user message after the
      // filler — so next/prev must cross both history and in-message
      // repeated occurrences.
      await seedConversation(workspaceId, session.id, [
        { user: "lumen first-ember" },
        { assistant: "lumen second-ember plus lumen again" },
        ...fillerTurns(40),
        { user: "lumen third-ember" },
      ]);

      await page.goto(`${webBaseUrl}/workspaces/${workspaceId}/sessions/${session.id}`);
      const scroller = page.locator("[data-og-timeline-scroller]");
      await scroller.getByText(/third-ember/).waitFor({ timeout: 30_000 });

      // Keyboard entry point: Ctrl+F (Cmd+F on macOS) opens the strip.
      await page.keyboard.press("Control+f");
      const find = conversationFind(page);
      await find.waitFor();
      const findInput = find.getByRole("searchbox", { name: "Find in conversation" });
      await expectFocused(findInput);
      await expectContainsText(find, "All saved user and completed assistant messages");

      await findInput.fill("lumen");
      const counter = find.locator('span[role="status"]');
      let observedCounter = "";
      await waitFor(
        async () => {
          observedCounter = (await counter.innerText()).trim();
          // Session search stops after the first nonempty bounded scan page.
          // The final recent occurrence need not be counted until Next scans
          // through the intervening history; '+' truthfully marks that bound.
          return /^1\s*\/\s*(?:3\+|4\+?)$/.test(observedCounter);
        },
        {
          timeoutMs: 20_000,
          intervalMs: 150,
          describe: () =>
            `initial lumen scan page counted; observed ${JSON.stringify(observedCounter)}`,
        },
      );
      const readOrdinal = async () =>
        Number((await counter.innerText()).trim().match(/^(\d+)\s*\/\s*(\d+)/)?.[1]);
      const previousButton = find.getByRole("button", { name: "Previous match", exact: true });
      const nextButton = find.getByRole("button", { name: "Next match", exact: true });

      // Traversal order is sequence-ascending, so the strip lands on the
      // oldest occurrence first: first-ember sits outside the initially
      // rendered window and only a real full-history jump brings it into
      // view. There is no earlier match, so Previous stays disabled.
      await expectTextInTimelineView(page, /first-ember/);
      expect(await readOrdinal()).toBe(1);
      expect(await previousButton.isDisabled()).toBe(true);

      // Next walks the repeated occurrences: second-ember and the second
      // offset inside the same assistant message, then the recent one.
      await nextButton.click();
      await waitFor(async () => (await readOrdinal()) === 2, { timeoutMs: 10_000 });
      await expectTextInTimelineView(page, /second-ember/);
      await nextButton.click();
      await waitFor(async () => (await readOrdinal()) === 3, { timeoutMs: 10_000 });
      // Keyboard: Enter advances to the recent occurrence, Shift+Enter
      // retreats again.
      await findInput.press("Enter");
      await waitFor(async () => (await readOrdinal()) === 4, { timeoutMs: 10_000 });
      await expectContainsText(counter, "4 / 4");
      await expectTextInTimelineView(page, /third-ember/);
      // No wrap-around past the exhausted history: Next disables instead.
      expect(await nextButton.isDisabled()).toBe(true);
      await findInput.press("Shift+Enter");
      await waitFor(async () => (await readOrdinal()) === 3, { timeoutMs: 10_000 });
      await previousButton.click();
      await waitFor(async () => (await readOrdinal()) === 2, { timeoutMs: 10_000 });

      // Closing the strip must not move the conversation: no scroll, and
      // focus returns to the chat Find button.
      const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
      await find.getByRole("button", { name: "Close conversation search", exact: true }).click();
      await find.waitFor({ state: "detached" });
      const scrollAfter = await scroller.evaluate((node) => node.scrollTop);
      expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(2);
      await expectFocused(page.getByRole("button", { name: "Find in conversation", exact: true }));

      // A closed strip leaves no stale target: reopening starts clean.
      await page.keyboard.press("Control+f");
      await find.waitFor();
      await expectFocused(find.getByRole("searchbox", { name: "Find in conversation" }));
    } finally {
      await page.screenshot({ path: `${artifactDir}/session-search-find.png` });
      await context.close();
    }
  }, 120_000);

  test("returning to session search preserves the query, selection, and scroll position", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const accountId = await accountIdForWorkspace(workspaceId);
      // Enough title matches that the result list genuinely scrolls.
      for (let index = 1; index <= 25; index += 1) {
        await seedSession(workspaceId, accountId, `harborlight dock ${index}`);
      }

      const dialog = await openSearchDialog(page);
      const input = dialog.getByRole("searchbox", {
        name: "Search session titles and messages",
        exact: true,
      });
      await input.fill("harborlight");
      const results = dialog.locator("[data-search-result]");
      await waitFor(async () => (await results.count()) >= 20, {
        timeoutMs: 15_000,
        intervalMs: 150,
        describe: () => "first page of harborlight title results",
      });

      // Scroll the list and select a mid-list result.
      const list = dialog.locator('div[aria-label="Matching sessions"]');
      const scanningBeforeScroll = (await dialog.innerText()).includes("Searching saved history");
      await results.nth(14).scrollIntoViewIfNeeded();
      let initialScroll = { top: 0, height: 0, contentHeight: 0 };
      await waitFor(
        async () => {
          initialScroll = await list.evaluate((node) => ({
            top: node.scrollTop,
            height: node.clientHeight,
            contentHeight: node.scrollHeight,
          }));
          return initialScroll.top > 0;
        },
        {
          timeoutMs: 5_000,
          describe: () =>
            `initial result-list scroll ${JSON.stringify(initialScroll)}; scan active=${scanningBeforeScroll}`,
        },
      );
      const selectedRow = results.nth(10);
      const selectedTitle = (await selectedRow.locator("div").first().innerText()).trim();
      await selectedRow.click();
      const preview = dialog.getByRole("region", { name: "Conversation preview", exact: true });
      await preview
        .getByRole("button", { name: "Open session", exact: true })
        .waitFor({ timeout: 15_000 });
      // Clicking the selected row can itself scroll the list. Preserve the
      // position at departure, not the earlier scroll-to-fixture position.
      const recordedScroll = await list.evaluate((node) => node.scrollTop);
      const scanningAtDeparture = (await dialog.innerText()).includes("Searching saved history");

      // A draft typo/undo must not replace the committed query, selected row,
      // preview, or exact scroll position, nor issue requests for the typo.
      const typoRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("harborlightx")) typoRequests.push(request.url());
      });
      await input.fill("harborlightx");
      expect(await preview.locator("h3").innerText()).toBe(selectedTitle);
      await input.fill("harborlight");
      await page.waitForTimeout(350);
      expect(typoRequests).toHaveLength(0);
      expect(await preview.locator("h3").innerText()).toBe(selectedTitle);
      expect(
        Math.abs((await list.evaluate((node) => node.scrollTop)) - recordedScroll),
      ).toBeLessThanOrEqual(4);

      // Open here → conversation with the find strip carrying the query…
      await preview.getByRole("button", { name: "Open session", exact: true }).click();
      const find = conversationFind(page);
      await find.waitFor();
      await expectValue(
        find.getByRole("searchbox", { name: "Find in conversation" }),
        "harborlight",
      );

      // …and the strip's explicit return path reopens the same search.
      await find.getByRole("button", { name: "Back to session search", exact: true }).click();
      await dialog.getByRole("searchbox", { name: "Search session titles and messages" }).waitFor();
      await expectValue(input, "harborlight");
      await waitFor(async () => (await results.count()) >= 20, {
        timeoutMs: 15_000,
        intervalMs: 150,
        describe: () => "restored harborlight results",
      });
      const restoredRow = results.filter({ hasText: selectedTitle }).first();
      await waitFor(async () => (await restoredRow.getAttribute("aria-pressed")) === "true", {
        timeoutMs: 10_000,
      });
      let restoredScroll = 0;
      await waitFor(
        async () => {
          restoredScroll = await list.evaluate((node) => node.scrollTop);
          return Math.abs(restoredScroll - recordedScroll) <= 4;
        },
        {
          timeoutMs: 15_000,
          describe: () =>
            `restored list scroll ${recordedScroll}; observed ${restoredScroll}; scanning before scroll=${scanningBeforeScroll}, at departure=${scanningAtDeparture}`,
        },
      );

      await waitFor(async () => !(await dialog.innerText()).includes("Searching saved history"), {
        timeoutMs: 15_000,
        describe: () => "restored search finishes revalidation without losing scroll",
      });
      expect(
        Math.abs((await list.evaluate((node) => node.scrollTop)) - recordedScroll),
      ).toBeLessThanOrEqual(4);
      // Escape closes the dialog without disturbing the conversation.
      await page.screenshot({ path: `${artifactDir}/session-search-return-restored.png` });
      await page.keyboard.press("Escape");
      await expectHidden(dialog);
    } finally {
      await page.screenshot({ path: `${artifactDir}/session-search-return.png` });
      await context.close();
    }
  }, 120_000);

  test("narrow viewport keeps the dialog contained, navigable, and accessible", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const accountId = await accountIdForWorkspace(workspaceId);
      const alpha = await seedSession(workspaceId, accountId, "narrowpine alpha");
      const narrowEvents = await seedConversation(workspaceId, alpha.id, [
        { user: "A narrowpine question from the phone." },
        { assistant: "The narrowpine answer, in full." },
      ]);
      await seedSession(workspaceId, accountId, "narrowpine beta");

      // The rail is a drawer at this width; open it to reach the search button.
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      const dialog = await openSearchDialog(page);
      const input = dialog.getByRole("searchbox", {
        name: "Search session titles and messages",
        exact: true,
      });
      await input.fill("narrowpine");
      const results = dialog.locator("[data-search-result]");
      await waitFor(async () => (await results.count()) === 2, {
        timeoutMs: 15_000,
        intervalMs: 150,
        describe: () => "two narrowpine results",
      });
      await expectNoPageOverflow(page);
      await waitFor(async () => !(await dialog.innerText()).includes("Searching saved history"), {
        timeoutMs: 15_000,
        describe: () => "narrow search results finish loading before visual inspection",
      });
      await expectNoAxeViolations(page, ['[role="dialog"]']);
      await page.screenshot({ path: `${artifactDir}/session-search-narrow-list.png` });

      // Selecting a result swaps the list for the preview on narrow screens…
      await results.filter({ hasText: "narrowpine alpha" }).first().click();
      const preview = dialog.getByRole("region", { name: "Conversation preview", exact: true });
      await preview.getByText(/narrowpine answer, in full/).waitFor({ timeout: 15_000 });
      await preview.getByRole("button", { name: "Back to search results", exact: true }).waitFor();
      await preview.getByRole("button", { name: "Open here", exact: true }).waitFor();
      await expectNoPageOverflow(page);
      await page.screenshot({ path: `${artifactDir}/session-search-narrow.png` });

      // …and the explicit back control returns to the preserved list.
      await preview.getByRole("button", { name: "Back to search results", exact: true }).click();
      await waitFor(async () => (await results.count()) === 2, { timeoutMs: 10_000 });
      await expectValue(input, "narrowpine");

      await results.filter({ hasText: "narrowpine alpha" }).first().click();
      await preview.getByRole("button", { name: "Open here", exact: true }).click();
      await page.waitForURL(`**/sessions/${alpha.id}**`);
      const find = conversationFind(page);
      await find.waitFor();
      await expectValue(
        find.getByRole("searchbox", { name: "Find in conversation" }),
        "narrowpine",
      );
      const userMatch = narrowEvents.find((event) => event.type === "user.message")!;
      const assistantMatch = narrowEvents.find(
        (event) => event.type === "agent.message.completed",
      )!;
      await expectExactSearchHighlight(page, "narrowpine", userMatch.sequence, 2);
      await find.getByRole("button", { name: "Next match", exact: true }).click();
      await expectExactSearchHighlight(page, "narrowpine", assistantMatch.sequence, 4);
      await find.getByRole("button", { name: "Previous match", exact: true }).click();
      await expectExactSearchHighlight(page, "narrowpine", userMatch.sequence, 2);
      await expectNoPageOverflow(page);
      await page.screenshot({ path: `${artifactDir}/session-search-narrow-open.png` });
      const scroller = page.locator("[data-og-timeline-scroller]");
      const beforeClose = await scroller.evaluate((node) => node.scrollTop);
      await find.getByRole("button", { name: "Close conversation search", exact: true }).click();
      await find.waitFor({ state: "detached" });
      expect(
        Math.abs((await scroller.evaluate((node) => node.scrollTop)) - beforeClose),
      ).toBeLessThanOrEqual(2);
      await page.getByRole("button", { name: "Find in conversation", exact: true }).click();
      await find.waitFor();
      await find.getByRole("button", { name: "Back to session search", exact: true }).click();
      await expectValue(input, "narrowpine");
      await preview.getByRole("button", { name: "Back to search results", exact: true }).click();
      await waitFor(async () => (await results.count()) === 2, { timeoutMs: 10_000 });
      expect(
        await results.filter({ hasText: "narrowpine alpha" }).first().getAttribute("aria-pressed"),
      ).toBe("true");
    } finally {
      await context.close();
    }
  }, 120_000);

  test("message failures preserve title hits, retry only messages, and denial clears every pane", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const accountId = await accountIdForWorkspace(workspaceId);
      await seedSession(workspaceId, accountId, "resiliencequartz title");
      let status = 503;
      let messageReads = 0;
      let titleReads = 0;
      await page.route("**/session-message-search?**", async (route) => {
        messageReads++;
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "injected failure" } }),
        });
      });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          url.pathname.endsWith("/sessions") &&
          url.searchParams.get("search") === "resiliencequartz"
        )
          titleReads++;
      });
      const dialog = await openSearchDialog(page);
      await dialog
        .getByRole("searchbox", { name: "Search session titles and messages" })
        .fill("resiliencequartz");
      const row = dialog
        .locator("[data-search-result]")
        .filter({ hasText: "resiliencequartz title" });
      await row.waitFor({ timeout: 15_000 });
      const retry = dialog.getByRole("button", { name: "Retry search", exact: true });
      await retry.waitFor();
      expect(await row.count()).toBe(1);
      await page.screenshot({ path: `${artifactDir}/session-search-transient-warning.png` });
      const beforeTitles = titleReads;
      const beforeMessages = messageReads;
      await retry.click();
      await waitFor(() => messageReads > beforeMessages, { timeoutMs: 5_000 });
      await retry.waitFor();
      expect(titleReads).toBe(beforeTitles);
      expect(await row.count()).toBe(1);
      status = 403;
      await retry.click();
      await waitFor(async () => (await dialog.locator("[data-search-result]").count()) === 0, {
        timeoutMs: 5_000,
      });
      expect(
        await dialog.getByRole("region", { name: "Conversation preview", exact: true }).count(),
      ).toBe(0);
      expect(await dialog.innerText()).not.toContain("resiliencequartz title");
      expect(await dialog.innerText()).not.toContain("injected failure");
      await page.screenshot({ path: `${artifactDir}/session-search-access-denied.png` });
    } finally {
      await context.close();
    }
  }, 120_000);

  test("a changed query replaces prior results and never leaks across workspaces", async () => {
    const context = await configuredContext(browser, {
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: ownerHeaders,
    });
    const page = await context.newPage();
    try {
      await page.goto(webBaseUrl);
      const workspaceId = await workspaceFromPage(page);
      const accountId = await accountIdForWorkspace(workspaceId);
      const amberjack = await seedSession(workspaceId, accountId, "amberjack report");
      await seedConversation(workspaceId, amberjack.id, [
        { user: "File the amberjack numbers." },
        { assistant: "The amberjack numbers are filed." },
      ]);
      await seedSession(workspaceId, accountId, "cobaltine memo");

      const dialog = await openSearchDialog(page);
      const results = dialog.locator("[data-search-result]");
      const input = dialog.getByRole("searchbox", {
        name: "Search session titles and messages",
        exact: true,
      });
      await input.fill("amberjack");
      await results.filter({ hasText: "amberjack report" }).first().waitFor({ timeout: 15_000 });

      // Once the draft commits, replacing the query must drop previous rows,
      // not merge or leave them beside the new results.
      await input.fill("cobaltine");
      await waitFor(
        async () => (await results.filter({ hasText: "amberjack report" }).count()) === 0,
        {
          timeoutMs: 5_000,
          intervalMs: 50,
          describe: () => "stale amberjack rows cleared after the query changed",
        },
      );
      await results.filter({ hasText: "cobaltine memo" }).first().waitFor({ timeout: 15_000 });
      expect(await results.filter({ hasText: "amberjack report" }).count()).toBe(0);

      // A second workspace gets its own dialog state: no query leaks in, and
      // results stay scoped to that workspace.
      const second = await createWorkspaceThroughApi(page, apiBaseUrl, "Second workspace");
      await seedSession(second.id, accountId, "amberjack satellite");
      await page.goto(`${webBaseUrl}/workspaces/${second.id}/sessions`);
      const secondDialog = await openSearchDialog(page);
      const secondInput = secondDialog.getByRole("searchbox", {
        name: "Search session titles and messages",
        exact: true,
      });
      await expectValue(secondInput, "");
      await secondInput.fill("amberjack");
      const secondResults = secondDialog.locator("[data-search-result]");
      await secondResults
        .filter({ hasText: "amberjack satellite" })
        .first()
        .waitFor({ timeout: 15_000 });
      expect(await secondResults.filter({ hasText: "amberjack report" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 120_000);
});

const browserDiagnostics = new WeakMap<BrowserContext, string[]>();

async function configuredContext(
  browser: Browser,
  options: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  const diagnostics: string[] = [];
  browserDiagnostics.set(context, diagnostics);
  context.on("requestfailed", (request) => {
    diagnostics.push(
      `request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
    );
  });
  context.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.push(
        `response ${response.status()}: ${response.request().method()} ${response.url()}`,
      );
    }
  });
  context.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  // Same test-only configured-token placeholder as the session-pins gate: it
  // satisfies the console gate and is never treated as a credential.
  await context.addInitScript(() => {
    if (window.location.origin === "null") {
      return;
    }
    localStorage.setItem("opengeni.accessKey", "configured-test-placeholder");
  });
  return context;
}

async function workspaceFromPage(page: Page): Promise<string> {
  try {
    await waitFor(() => /\/workspaces\/[^/]+\/sessions/.test(page.url()), {
      timeoutMs: 15_000,
    });
  } catch (error) {
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "<body unavailable>");
    throw new Error(
      `Workspace route did not load at ${page.url()}: ${String(error)}\n${body.slice(0, 2_000)}\n${(browserDiagnostics.get(page.context()) ?? []).slice(-20).join("\n")}`,
      { cause: error },
    );
  }
  return page.url().match(/\/workspaces\/([^/]+)\/sessions/)![1]!;
}

async function accountIdForWorkspace(workspaceId: string): Promise<string> {
  const [workspace] = await sharedRef!.admin<{ accountId: string }[]>`
    select account_id as "accountId" from workspaces where id = ${workspaceId}`;
  if (!workspace?.accountId) {
    throw new Error(`workspace ${workspaceId} has no account row`);
  }
  return workspace.accountId;
}

// The describe-scoped shared handle, mirrored for module helpers.
let sharedRef: SharedTestDatabase | null = null;

async function seedSession(
  workspaceId: string,
  accountId: string,
  title: string,
  requestedSessionId?: string,
): Promise<{ id: string }> {
  const session = await createSession(dbRef!, {
    ...(requestedSessionId ? { requestedSessionId } : {}),
    accountId,
    workspaceId,
    initialMessage: title,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: OWNER_SUBJECT },
  });
  const renamed = await updateSessionTitle(dbRef!, {
    workspaceId,
    sessionId: session.id,
    title,
    source: "user",
  });
  if (!renamed.updated || renamed.title !== title) {
    throw new Error(`failed to assign explicit fixture title to session ${session.id}`);
  }
  return session;
}

type SeededTurn = { user?: string; assistant?: string };

async function seedConversation(workspaceId: string, sessionId: string, turns: SeededTurn[]) {
  const inputs = turns.flatMap((turn) => {
    const events = [];
    if (turn.user !== undefined) {
      events.push({
        type: "user.message",
        payload: { text: turn.user },
        clientEventId: crypto.randomUUID(),
      });
    }
    if (turn.assistant !== undefined) {
      const turnId = crypto.randomUUID();
      events.push(
        { type: "turn.started", payload: { turnId }, turnId },
        { type: "agent.message.completed", payload: { text: turn.assistant }, turnId },
        { type: "turn.completed", payload: {}, turnId },
      );
    }
    return events;
  });
  if (inputs.length === 0) {
    return [];
  }
  return await appendSessionEventsAndUpdateSession(dbRef!, workspaceId, sessionId, inputs, {
    status: "idle",
  });
}

function fillerTurns(count: number): SeededTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    user: `filler question ${index + 1}`,
    assistant: `filler answer ${index + 1}`,
  }));
}

let dbRef: ReturnType<typeof createDb>["db"] | null = null;

async function openSearchDialog(page: Page): Promise<Locator> {
  const button = page.getByRole("button", { name: "Search sessions", exact: true }).first();
  await button.waitFor({ timeout: 15_000 });
  await button.click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("searchbox", { name: "Search session titles and messages", exact: true })
    .waitFor({ timeout: 15_000 });
  return dialog;
}

function conversationFind(page: Page): Locator {
  return page.getByRole("region", { name: "Find in conversation", exact: true });
}

async function createWorkspaceThroughApi(
  page: Page,
  apiBaseUrl: string,
  name: string,
): Promise<{ id: string }> {
  return await page.evaluate(
    async ({ apiBaseUrl: baseUrl, name: workspaceName }) => {
      const response = await fetch(`${baseUrl}/v1/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: workspaceName }),
      });
      if (!response.ok) {
        throw new Error(`workspace create failed: ${response.status} ${await response.text()}`);
      }
      const created = (await response.json()) as { id?: string; workspace?: { id: string } };
      const id = created.id ?? created.workspace?.id;
      if (!id) {
        throw new Error(`workspace create returned no id: ${JSON.stringify(created)}`);
      }
      return { id };
    },
    { apiBaseUrl, name },
  );
}

async function isTextInTimelineView(page: Page, text: RegExp): Promise<boolean> {
  const scroller = page.locator("[data-og-timeline-scroller]");
  const marker = scroller.getByText(text).first();
  if ((await marker.count()) === 0 || !(await marker.isVisible().catch(() => false))) {
    return false;
  }
  const box = await marker.boundingBox();
  const scrollerBox = await scroller.boundingBox();
  return (
    !!box &&
    !!scrollerBox &&
    box.y >= scrollerBox.y - 1 &&
    box.y + box.height <= scrollerBox.y + scrollerBox.height + 1
  );
}

async function expectTextInTimelineView(page: Page, text: RegExp): Promise<void> {
  try {
    await waitFor(() => isTextInTimelineView(page, text), {
      timeoutMs: 30_000,
      intervalMs: 200,
    });
  } catch (error) {
    throw new Error(
      `${String(text)} never became visible inside the timeline viewport: ${String(error)}\n${(browserDiagnostics.get(page.context()) ?? []).slice(-20).join("\n")}`,
      { cause: error },
    );
  }
}

async function expectExactSearchHighlight(
  page: Page,
  query: string,
  sequence: number,
  offset: number,
): Promise<void> {
  await page.waitForFunction(
    (expectedTarget) => {
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
      const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights;
      if (!scroller || !registry) return false;
      const viewport = scroller.getBoundingClientRect();
      const ranges = [...registry.entries()]
        .filter(([name]) => name.startsWith("og-search-"))
        .flatMap(([, highlightRanges]) => [...highlightRanges]);
      return ranges.some((range) => {
        const marker = range.startContainer.parentElement?.closest<HTMLElement>(
          "[data-og-search-occurrence]",
        );
        const rect = range.getBoundingClientRect();
        return (
          range.toString() === expectedTarget.query &&
          marker?.dataset.ogSearchSequence === String(expectedTarget.sequence) &&
          marker.dataset.ogSearchOffset === String(expectedTarget.offset) &&
          marker.dataset.ogSearchQuery === expectedTarget.query &&
          rect.height > 0 &&
          rect.top >= viewport.top - 1 &&
          rect.bottom <= viewport.bottom + 1
        );
      });
    },
    { query, sequence, offset },
    { timeout: 30_000 },
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

async function expectFocused(locator: Locator): Promise<void> {
  await locator.and(locator.page().locator(":focus")).waitFor({ timeout: 10_000 });
}

async function expectValue(locator: Locator, value: string): Promise<void> {
  await waitFor(async () => (await locator.inputValue()) === value, {
    timeoutMs: 10_000,
    describe: () => `input value ${JSON.stringify(value)}`,
  });
}

async function expectContainsText(locator: Locator, text: string): Promise<void> {
  await waitFor(async () => (await locator.innerText()).includes(text), {
    timeoutMs: 15_000,
    describe: () => `text ${JSON.stringify(text)}`,
  });
}

async function expectHidden(locator: Locator): Promise<void> {
  await locator.waitFor({ state: "hidden", timeout: 10_000 });
}

async function expectNoAxeViolations(page: Page, includes: string[]): Promise<void> {
  let scan = new AxeBuilder({ page });
  for (const include of includes) scan = scan.include(include);
  const results = await scan.analyze();

  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary,
        checks: node.any.map((check) => ({ message: check.message, data: check.data })),
      })),
    })),
  ).toEqual([]);
}
