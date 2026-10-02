import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import type { SessionSidebarEvidence } from "../../apps/web/test/session-sidebar-context";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const redesignId = "00000000-0000-4000-8000-000000000001";
const bugfixesId = "00000000-0000-4000-8000-000000000002";
const screenshots = process.env.OPENGENI_SESSION_SIDEBAR_ARTIFACT_DIR;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let web: StartedProcess;
let url: string;
let pageErrors: string[];
let consoleErrors: string[];

beforeAll(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}/test/session-sidebar-preview.html`;
  web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--config",
      "test/session-sidebar-preview.vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
      ready: async () => (await fetch(url).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  if (screenshots) await mkdir(screenshots, { recursive: true });
}, 60_000);

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1160, height: 1100 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  pageErrors = [];
  consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
});

afterEach(async () => {
  await context?.close();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
});

const group = (name: string) => page.getByRole("group", { name, exact: true });
const rows = (folder: Locator) => folder.locator("a[data-session-row]");
const showMore = (name: string, count = 4) =>
  group(name).getByRole("button", { name: `Show ${count} more sessions in ${name}`, exact: true });

async function waitForRows(name: string, count: number) {
  await page.waitForFunction(
    ({ name: groupName, count: expectedCount }) =>
      [...document.querySelectorAll('[role="group"]')].some(
        (folder) =>
          folder.getAttribute("aria-label") === groupName &&
          folder.querySelectorAll("a[data-session-row]").length === expectedCount,
      ),
    { name, count },
  );
  expect(await rows(group(name)).count()).toBe(count);
}

async function openActive(query = "") {
  await page.goto(`${url}${query}`);
  await waitForRows("Default", 4);
  await waitForRows("Website redesign", 4);
  if (!query.includes("fail=")) await waitForRows("Bugfixes", 4);
}

async function capture(name: string) {
  if (!screenshots) return;
  await page.mouse.move((page.viewportSize()?.width ?? 1160) - 10, 10);
  await page.screenshot({
    path: `${screenshots}/${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  if (name === "all-archived" || name === "creator") {
    await page.getByRole("complementary", { name: "Workspace sidebar" }).screenshot({
      path: `${screenshots}/${name}-sidebar.png`,
      animations: "disabled",
    });
  }
}

async function selectView(label: "Status" | "Group by" | "Sort by", value: string) {
  await page.getByRole("button", { name: /^Session view/ }).click();
  const submenu = page.getByRole("menuitem", { name: new RegExp(`^${label}`) });
  await submenu.press("ArrowRight");
  // Keyboard selection also exercises the real submenu when a narrow viewport
  // flips its Popper placement; no mock control or direct preference mutation.
  await page.getByRole("menuitemradio", { name: value, exact: true }).press("Enter");
}

async function listCalls(): Promise<SessionSidebarEvidence["listCalls"]> {
  return page.evaluate(() => window.sessionSidebarQa.listCalls);
}

test("projects start at four roots; disclosure is independent and keeps fifty-row cache pages", async () => {
  await openActive();
  expect(await group("Archived").count()).toBe(0);
  expect(await page.getByText(/^Archived /).count()).toBe(0);
  const initial = await listCalls();
  expect(initial).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        options: expect.objectContaining({ channelId: redesignId, limit: 50 }),
      }),
      expect.objectContaining({
        options: expect.objectContaining({ channelId: bugfixesId, limit: 50 }),
      }),
      expect.objectContaining({ options: expect.objectContaining({ channelId: null, limit: 50 }) }),
    ]),
  );
  await capture("active-projects");

  await showMore("Website redesign").click();
  await waitForRows("Website redesign", 8);
  expect(await showMore("Website redesign").count()).toBe(0);
  expect(await rows(group("Bugfixes")).count()).toBe(4);
  expect(await rows(group("Default")).count()).toBe(4);
  // All eight were cached by the first fifty-row page; disclosure performs no read.
  expect((await listCalls()).filter((call) => call.options.channelId === redesignId).length).toBe(
    initial.filter((call) => call.options.channelId === redesignId).length,
  );

  await showMore("Bugfixes").click();
  await waitForRows("Bugfixes", 8);
  expect(await rows(group("Website redesign")).count()).toBe(8);
  expect(await rows(group("Default")).count()).toBe(4);
  await capture("expanded");
}, 30_000);

test("disclosure fills across a fifty-row server cursor in one bounded step", async () => {
  await openActive();
  for (let count = 8; count <= 48; count += 4) {
    await showMore("Default").click();
    await waitForRows("Default", count);
  }
  expect(
    (await listCalls()).filter((call) => call.options.channelId === null && call.options.cursor)
      .length,
  ).toBe(0);
  await showMore("Default").click();
  await waitForRows("Default", 51);
  expect(await showMore("Default").count()).toBe(0);
  expect(await rows(group("Website redesign")).count()).toBe(4);
  expect(await rows(group("Bugfixes")).count()).toBe(4);
  expect(await listCalls()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        options: expect.objectContaining({ channelId: null, cursor: "50", limit: 50 }),
        returnedIds: ["00000000-0000-4000-9000-000000000350"],
        nextCursor: null,
      }),
    ]),
  );
}, 30_000);

test("keyboard navigation follows only rendered rows and exhaustion restores folder focus", async () => {
  await openActive();
  const defaultRows = rows(group("Default"));
  const designRows = rows(group("Website redesign"));
  const bugfixRows = rows(group("Bugfixes"));
  await designRows.last().focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-session-row") ===
      "00000000-0000-4000-9000-000000000201",
  );
  expect(await bugfixRows.first().evaluate((row) => row === document.activeElement)).toBe(true);
  await bugfixRows.last().focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-session-row") ===
      "00000000-0000-4000-9000-000000000001",
  );
  expect(await defaultRows.first().evaluate((row) => row === document.activeElement)).toBe(true);
  const indices = await page
    .locator("a[data-session-row]")
    .evaluateAll((links) => links.map((link) => Number(link.getAttribute("data-session-index"))));
  expect(indices).toEqual(Array.from({ length: indices.length }, (_, index) => index));

  await showMore("Website redesign").focus();
  await page.keyboard.press("Enter");
  await waitForRows("Website redesign", 8);
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes("Website redesign"),
  );
  expect(
    await group("Website redesign")
      .getByRole("button", { name: "Website redesign", exact: true })
      .evaluate((heading) => heading === document.activeElement),
  ).toBe(true);
  const expandedIndices = await page
    .locator("a[data-session-row]")
    .evaluateAll((links) => links.map((link) => Number(link.getAttribute("data-session-index"))));
  expect(expandedIndices).toEqual(
    Array.from({ length: expandedIndices.length }, (_, index) => index),
  );
}, 30_000);

test("All isolates archives in the last collapsed folder and uses archive filing order", async () => {
  await openActive();
  await selectView("Status", "All");
  const archived = group("Archived");
  const heading = archived.getByRole("button", { name: "Archived", exact: true });
  await heading.waitFor();
  expect(await heading.getAttribute("aria-expanded")).toBe("false");
  expect(await rows(archived).count()).toBe(0);
  await waitForRows("Website redesign", 4);
  await waitForRows("Bugfixes", 4);
  expect(
    await page
      .getByRole("region", { name: "Sessions", exact: true })
      .locator(':scope > [role="group"]')
      .last()
      .getAttribute("aria-label"),
  ).toBe("Archived");
  for (const name of ["Default", "Website redesign", "Bugfixes"])
    expect(
      await group(name)
        .getByText(/^Archived /)
        .count(),
    ).toBe(0);
  expect(await archived.getByRole("link", { name: "New chat in Archived" }).count()).toBe(0);
  await heading.click();
  await waitForRows("Archived", 4);
  expect(
    await rows(archived).evaluateAll((links) => links.map((link) => link.textContent)),
  ).toEqual([
    expect.stringContaining("Archived design kickoff"),
    expect.stringContaining("Archived bugfix review"),
    expect.stringContaining("Archived workspace notes"),
    expect.stringContaining("Archived design handoff"),
  ]);
  await capture("all-archived");
  await showMore("Archived", 2).click();
  await waitForRows("Archived", 6);
  expect(await showMore("Archived").count()).toBe(0);
  const archiveCall = (await listCalls()).find((call) => call.options.archivedOnly);
  expect(archiveCall?.options).toMatchObject({
    archiveStatus: "archived",
    parentSessionId: null,
    limit: 50,
  });
  expect(archiveCall?.options.channelId).toBeUndefined();
  expect(archiveCall?.options.sortBy).toBeUndefined();
}, 30_000);

test("Archived filter opens only the archive folder; restore retains the original project", async () => {
  await openActive();
  await selectView("Status", "Archived");
  await waitForRows("Archived", 4);
  const archived = group("Archived");
  expect(
    await archived
      .getByRole("button", { name: "Archived", exact: true })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(await group("Default").count()).toBe(0);
  expect(await group("Website redesign").count()).toBe(0);
  expect(await group("Bugfixes").count()).toBe(0);
  await rows(archived).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await page.waitForFunction(() => window.sessionSidebarQa.archiveCalls.length === 1);
  expect(await page.evaluate(() => window.sessionSidebarQa.archiveCalls)).toEqual([
    {
      workspaceId,
      sessionId: "00000000-0000-4000-9000-000000000401",
      archived: false,
      expectedVersion: 1,
      previousChannelId: redesignId,
      returnedChannelId: redesignId,
    },
  ]);
  await selectView("Status", "Active");
  await group("Website redesign").getByText("Archived design kickoff", { exact: true }).waitFor();
  expect(await group("Archived").count()).toBe(0);
  expect(await group("Default").getByText("Archived design kickoff", { exact: true }).count()).toBe(
    0,
  );
}, 30_000);

test("a discovered creator auto-hydrates to four before disclosure and expands independently to eight", async () => {
  await openActive();
  await selectView("Group by", "Creator");
  await waitForRows("Jamie Chen", 4);
  await waitForRows("Alex Morgan", 4);
  const calls = await listCalls();
  const discovery = calls.find(
    (call) =>
      !call.options.pinsOnly &&
      call.options.channelId === undefined &&
      !call.options.createdBy &&
      call.options.archiveStatus === "active",
  );
  expect(
    discovery?.returnedIds.filter((id) => id.startsWith("00000000-0000-4000-9000-0000000003")),
  ).toHaveLength(1);
  const creatorCall = calls.find((call) => call.options.createdBy?.subjectId === "jamie-preview");
  expect(creatorCall?.returnedIds).toHaveLength(50);
  expect(creatorCall?.options).toMatchObject({
    limit: 50,
    parentSessionId: null,
    archiveStatus: "active",
    createdBy: { kind: "subject", subjectId: "jamie-preview" },
  });
  await capture("creator");
  await showMore("Jamie Chen").click();
  await waitForRows("Jamie Chen", 8);
  expect(await rows(group("Alex Morgan")).count()).toBe(4);
  expect(
    (await listCalls()).filter((call) => call.options.createdBy?.subjectId === "jamie-preview")
      .length,
  ).toBe(calls.filter((call) => call.options.createdBy?.subjectId === "jamie-preview").length);
}, 30_000);

test("an off-page project's first-read error exposes retry and recovers only four rows", async () => {
  await openActive("?scenario=retry&fail=bugfixes");
  const bugfixes = group("Bugfixes");
  const retry = bugfixes.getByRole("button", { name: "Retry sessions in Bugfixes", exact: true });
  await retry.waitFor();
  expect(await rows(bugfixes).count()).toBe(0);
  await bugfixes.getByText("Older sessions in this group didn't load.", { exact: true }).waitFor();
  await retry.click();
  await waitForRows("Bugfixes", 4);
  expect(await retry.count()).toBe(0);
  expect(await rows(group("Website redesign")).count()).toBe(4);
  await showMore("Bugfixes").click();
  await waitForRows("Bugfixes", 8);
  const calls = (await listCalls()).filter((call) => call.options.channelId === bugfixesId);
  expect(calls.map((call) => call.outcome)).toEqual(["error", "success"]);
  expect(calls.every((call) => call.options.limit === 50 && !call.options.cursor)).toBe(true);
}, 30_000);

test("mobile width preserves four-row disclosure and the actual view menu without overflow", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openActive();
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  expect(Math.round((await sidebar.boundingBox())!.width)).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await capture("mobile");
  await showMore("Bugfixes").click();
  await waitForRows("Bugfixes", 8);
  expect(await rows(group("Website redesign")).count()).toBe(4);
  await selectView("Status", "All");
  const heading = group("Archived").getByRole("button", { name: "Archived", exact: true });
  await heading.waitFor();
  expect(await heading.getAttribute("aria-expanded")).toBe("false");
  await heading.click();
  await waitForRows("Archived", 4);
  await heading.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}, 30_000);

test("a cold archived root loads its archived child on expansion and includes it in keyboard order", async () => {
  await openActive("?scenario=archived-child");
  await selectView("Status", "Archived");
  await waitForRows("Archived", 4);
  const archived = group("Archived");
  const rootId = "00000000-0000-4000-9000-000000000401";
  const childId = "00000000-0000-4000-9000-000000000801";
  expect(await archived.getByText("Archived design investigation", { exact: true }).count()).toBe(
    0,
  );
  expect((await listCalls()).some((call) => call.options.parentSessionId === rootId)).toBe(false);

  await archived.getByRole("button", { name: "Expand spawned sessions", exact: true }).click();
  await archived.getByText("Archived design investigation", { exact: true }).waitFor();
  await waitForRows("Archived", 5);
  const childCalls = (await listCalls()).filter((call) => call.options.parentSessionId === rootId);
  expect(childCalls).toHaveLength(1);
  expect(childCalls[0]).toMatchObject({
    options: { parentSessionId: rootId, limit: 50, archiveStatus: "archived" },
    returnedIds: [childId],
    nextCursor: null,
  });
  await archived.locator(`a[data-session-row="${rootId}"]`).focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-session-row") === id,
    childId,
  );
  await archived.getByRole("button", { name: "Collapse spawned sessions", exact: true }).click();
  await waitForRows("Archived", 4);
  await archived.getByRole("button", { name: "Expand spawned sessions", exact: true }).click();
  await waitForRows("Archived", 5);
  expect(
    (await listCalls()).filter((call) => call.options.parentSessionId === rootId),
  ).toHaveLength(1);
}, 30_000);

test("one Active disclosure traverses overlapping and sparse fifty-row pages to fill four new roots", async () => {
  await page.goto(`${url}?scenario=sparse-active`);
  await selectView("Group by", "Last activity");
  await waitForRows("Active", 4);
  const peers = async () =>
    page
      .getByRole("region", { name: "Sessions", exact: true })
      .locator(':scope > [role="group"]')
      .evaluateAll((groups) =>
        groups
          .filter((folder) => folder.getAttribute("aria-label") !== "Active")
          .map((folder) => ({
            label: folder.getAttribute("aria-label"),
            ids: [...folder.querySelectorAll("a[data-session-row]")].map((row) =>
              row.getAttribute("data-session-row"),
            ),
          })),
      );
  const beforePeers = await peers();
  const beforeCalls = (await listCalls()).length;
  await showMore("Active").click();
  await waitForRows("Active", 8);
  expect(await showMore("Active").count()).toBe(0);
  expect(await peers()).toEqual(beforePeers);
  expect(
    await rows(group("Active")).evaluateAll((links) => links.map((link) => link.textContent)),
  ).toEqual([
    expect.stringContaining("Sparse workstream 1"),
    expect.stringContaining("Sparse workstream 11"),
    expect.stringContaining("Sparse workstream 21"),
    expect.stringContaining("Sparse workstream 31"),
    expect.stringContaining("Sparse workstream 111"),
    expect.stringContaining("Sparse workstream 186"),
    expect.stringContaining("Sparse workstream 202"),
    expect.stringContaining("Sparse workstream 210"),
  ]);
  const calls = (await listCalls()).slice(beforeCalls);
  expect(calls.map((call) => call.options.cursor ?? null)).toEqual([
    null,
    "50",
    "100",
    "150",
    "200",
  ]);
  expect(
    calls.every(
      (call) =>
        call.options.limit === 50 &&
        call.options.archiveStatus === "active" &&
        call.options.parentSessionId === null &&
        call.options.channelId === undefined,
    ),
  ).toBe(true);
  expect(calls.map((call) => call.returnedIds.length)).toEqual([50, 50, 50, 50, 10]);
}, 30_000);

async function openKeyboardFocus(visibleCount: number) {
  // Keep all 106 recent fixtures in Today, including when CI runs at midnight.
  // Fix only the wall clock; loading and keyboard timers still run normally.
  const noon = await page.evaluate(() => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    return date.getTime();
  });
  await page.clock.setFixedTime(noon);
  await page.goto(`${url}?scenario=keyboard-focus`);
  await waitForRows("Today", 4);
  for (let count = 8; count <= visibleCount; count += 4) {
    await showMore("Today").click();
    await waitForRows("Today", count);
  }
}

async function holdTodayPage(cursor: string, fail = false) {
  await page.evaluate(
    ({ cursor: nextCursor, fail: shouldFail }) => {
      window.sessionSidebarQa.holdTodayCursor = nextCursor;
      window.sessionSidebarQa.heldPageStarted = false;
      window.sessionSidebarQa.failTodayCursor = shouldFail ? nextCursor : null;
    },
    { cursor, fail },
  );
}

async function waitForHeldTodayPage() {
  await page.waitForFunction(() => window.sessionSidebarQa.heldPageStarted);
  expect(
    await group("Today")
      .getByRole("button", { name: "Loading sessions in Today", exact: true })
      .isDisabled(),
  ).toBe(true);
}

async function releaseTodayPage() {
  await page.evaluate(() => window.sessionSidebarQa.releaseHeldPage());
}

test("keyboard retry keeps its visible window and recovers disclosure focus before final four-plus-two exhaustion", async () => {
  await openKeyboardFocus(100);
  const todayCalls = (await listCalls()).filter((call) => call.options.updatedFrom);
  expect(todayCalls.map((call) => call.options.cursor ?? null)).toEqual([null, "50"]);
  expect(todayCalls.map((call) => call.returnedIds.length)).toEqual([50, 50]);
  expect(todayCalls.every((call) => call.options.limit === 50)).toBe(true);

  await holdTodayPage("100", true);
  await showMore("Today").focus();
  await page.keyboard.press("Enter");
  await waitForHeldTodayPage();
  await releaseTodayPage();
  const retry = group("Today").getByRole("button", {
    name: "Retry sessions in Today",
    exact: true,
  });
  await retry.waitFor();
  expect(await rows(group("Today")).count()).toBe(100);
  const retryElement = await retry.elementHandle();

  await holdTodayPage("100");
  await retry.focus();
  await page.keyboard.press("Enter");
  await waitForHeldTodayPage();
  await releaseTodayPage();
  const reveal = showMore("Today");
  await reveal.waitFor();
  expect(await rows(group("Today")).count()).toBe(100);
  const finalPageCalls = (await listCalls()).filter(
    (call) => call.options.updatedFrom && call.options.cursor === "100",
  );
  expect(finalPageCalls.map((call) => call.outcome)).toEqual(["error", "success"]);
  expect(finalPageCalls[1]).toMatchObject({
    options: { limit: 50 },
    nextCursor: null,
  });
  expect(finalPageCalls[1]!.returnedIds).toHaveLength(6);
  await reveal.and(page.locator(":focus")).waitFor();
  expect(await retryElement!.evaluate((element) => element === document.activeElement)).toBe(true);
  if (screenshots) {
    await reveal.scrollIntoViewIfNeeded();
    await page.mouse.move((page.viewportSize()?.width ?? 1160) - 10, 10);
    await page.getByText("Created by Alex Morgan", { exact: true }).waitFor({ state: "hidden" });
  }
  await capture("retry-focus");

  await page.keyboard.press("Enter");
  await waitForRows("Today", 104);
  const lastTwo = showMore("Today", 2);
  await lastTwo.and(page.locator(":focus")).waitFor();
  await page.keyboard.press("Enter");
  await waitForRows("Today", 106);
  expect(await lastTwo.count()).toBe(0);
  await page.waitForFunction(() => document.activeElement?.id === "session-group-today");
  expect((await listCalls()).filter((call) => call.options.updatedFrom).length).toBe(
    todayCalls.length + 2,
  );
}, 30_000);

test("keyboard page failure recovers the surviving Retry control without disclosing rows", async () => {
  await openKeyboardFocus(48);
  await holdTodayPage("50", true);
  await showMore("Today").focus();
  await page.keyboard.press("Enter");
  await waitForHeldTodayPage();
  await releaseTodayPage();
  await group("Today")
    .getByRole("button", { name: "Retry sessions in Today", exact: true })
    .and(page.locator(":focus"))
    .waitFor();
  expect(await rows(group("Today")).count()).toBe(48);
}, 30_000);

for (const blurMovedFocus of [false, true]) {
  test(`pending continuation does not steal moved focus${blurMovedFocus ? " even after it returns to BODY" : ""}`, async () => {
    await openKeyboardFocus(48);
    await holdTodayPage("50");
    await showMore("Today").focus();
    await page.keyboard.press("Enter");
    await waitForHeldTodayPage();
    const view = page.getByRole("button", { name: /^Session view/ });
    await view.focus();
    if (blurMovedFocus) await view.evaluate((element) => element.blur());
    await releaseTodayPage();
    await waitForRows("Today", 52);
    // Observe the focus-restoration frame, not only the row commit before it.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    if (blurMovedFocus)
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    else expect(await view.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await showMore("Today").count()).toBe(1);
  }, 30_000);
}

test("stale pagination completion does not restore focus or grow a new browse generation", async () => {
  await openKeyboardFocus(48);
  await holdTodayPage("50");
  await showMore("Today").focus();
  await page.keyboard.press("Enter");
  await waitForHeldTodayPage();
  await selectView("Status", "All");
  await waitForRows("Today", 4);
  const view = page.getByRole("button", { name: /^Session view/ });
  // Finish the menu's deferred focus handoff before testing stale pagination.
  await view.and(page.locator(":focus")).waitFor();
  await view.evaluate((element) => element.blur());
  await releaseTodayPage();
  await page.waitForFunction(() =>
    window.sessionSidebarQa.listCalls.some(
      (call) =>
        call.options.updatedFrom && call.options.cursor === "50" && call.returnedIds.length === 50,
    ),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await rows(group("Today")).count()).toBe(4);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
}, 30_000);
