// Per-task usage limits on the production web and React components:
// new chat, header menu to the Agent tab editor, compare-and-set saves, typed
// failures, coverage states, the reached stop and notice, a refused Send, and
// read-only states; keyboard, focus, 390/1440 px, light/dark and axe.
import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

let browser: Browser;
let page: Page;
let web: StartedProcess;
let url: string;
const screenshots = process.env.OPENGENI_SESSION_USAGE_LIMIT_ARTIFACT_DIR;
const pageErrors: string[] = [];

type Qa = {
  creates: Array<Record<string, unknown>>;
  blockedSends: number;
  saves: Array<{ scenario: string; limitMicros: number | null; expectedVersion: number }>;
  reads: Record<string, number>;
  failNext: Record<string, string>;
  failReads: Record<string, number>;
  saveOps: Array<{ scenario: string; operationId: string }>;
  saveDelayMs: number;
  sends: number;
};

beforeAll(async () => {
  const port = Number(process.env.OPENGENI_SESSION_USAGE_LIMIT_PORT) || (await freePort());
  url = `http://127.0.0.1:${port}/test/session-usage-limit.html`;
  web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--config",
      "test/session-usage-limit.vite.config.ts",
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await load();
  if (screenshots) await mkdir(screenshots, { recursive: true });
}, 90_000);

afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
});

async function load(query = "") {
  await page.goto(`${url}${query}`);
  await page.getByTestId("sample-data").waitFor();
  // Every scenario has read its limit once.
  await page
    .getByTestId("scenario-disabled")
    .locator("[data-usage-limit-state]")
    .waitFor({ timeout: 20_000 });
}

const qa = () => page.evaluate(() => (window as unknown as { usageQa: Qa }).usageQa);
const steer = (patch: Partial<Pick<Qa, "failNext" | "failReads" | "saveDelayMs">>) =>
  page.evaluate((next) => {
    Object.assign((window as unknown as { usageQa: Qa }).usageQa, next);
  }, patch);
/** Someone else changes the server's limit for a task. */
const changeOnServer = (name: string, limitMicros: number | null) =>
  page.evaluate(
    ([target, next]) => {
      (
        window as unknown as {
          usageServers: Record<string, { change: (limit: number | null) => void }>;
        }
      ).usageServers[target as string]!.change(next as number | null);
    },
    [name, limitMicros] as const,
  );
/** The tab regains focus: the live reader reads once. */
const refocus = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));

const scenario = (name: string) => page.getByTestId(`scenario-${name}`);
const editor = (root: Locator) => root.locator("[data-usage-limit-editor]");
const amount = (root: Locator) => root.locator("[data-usage-limit-amount]");
const focusedText = () =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      tag: active?.tagName ?? "",
      text: active?.textContent?.trim() ?? "",
      role: active?.getAttribute("role") ?? "",
      inEditor: Boolean(active?.closest("[data-usage-limit-editor]")),
      scenario: active?.closest("[data-testid^='scenario-']")?.getAttribute("data-testid") ?? "",
    };
  });

async function capture(name: string, target?: Locator) {
  if (!screenshots) return;
  if (target) await target.screenshot({ path: `${screenshots}/${name}.png` });
  else await page.screenshot({ path: `${screenshots}/${name}.png` });
}

// Every axe rule runs on every scan; there is no rule waiver.
async function expectNoAxeViolations(include = "main") {
  const results = await new AxeBuilder({ page }).include(include).analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

async function openNewChatUsageLimit() {
  const newChat = page.getByTestId("new-chat");
  await newChat.getByRole("button", { name: "More composer actions" }).click();
  await page.getByRole("menuitem", { name: /Usage limit/ }).click();
  // A text field can't live in a menu: the setting opens as a dialog.
  const dialog = page.getByRole("dialog", { name: "Usage limit" });
  await dialog.waitFor();
  return dialog.locator("[data-usage-limit-menu]");
}

test("the sample loads with a visible marker and no errors or axe violations", async () => {
  expect(await page.getByTestId("sample-data").innerText()).toBe("Sample data");
  await expectNoAxeViolations();
  expect(pageErrors).toEqual([]);
}, 60_000);

test("a new chat sends the chosen limit, blocks an invalid amount and resets", async () => {
  await load();
  const newChat = page.getByTestId("new-chat");
  await newChat.getByRole("button", { name: "More composer actions" }).click();
  const row = page.getByRole("menuitem", { name: /Usage limit/ });
  expect(await row.innerText()).toContain("No limit");
  await row.click();
  const dialog = page.getByRole("dialog", { name: "Usage limit" });
  await dialog.waitFor();
  // No form control inside a menu: the "+" menu closes and a dialog holds a
  // radio group and the amount field.
  expect(await page.locator("[role='menu']").count()).toBe(0);
  const menu = dialog.locator("[data-usage-limit-menu]");
  expect(await menu.getByRole("radio", { name: /No limit/ }).getAttribute("aria-checked")).toBe(
    "true",
  );
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "radio");
  expect((await focusedText()).text).toContain("No limit");
  await expectNoAxeViolations("[role='dialog']");
  await menu.getByText("Pause at an amount").click();
  const input = menu.getByRole("textbox", { name: "Limit in US dollars" });
  await input.waitFor();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("INPUT");
  expect(await input.getAttribute("inputmode")).toBe("decimal");
  await input.fill("12.345");
  expect(await input.getAttribute("aria-invalid")).toBe("true");
  await menu.getByText("Enter dollars with up to 2 decimals, at most $10,000,000.").waitFor();
  // Every state is checked with no rule waived, including the invalid amount.
  await expectNoAxeViolations("[role='dialog']");
  await input.fill("25");
  expect(await input.getAttribute("aria-invalid")).toBeNull();
  await expectNoAxeViolations("[role='dialog']");
  await capture("new-chat-usage-limit-menu");
  // Ordinary Tab order: Shift+Tab back to the choice, Tab to the amount, then
  // the help, and focus stays in the dialog.
  await page.keyboard.press("Shift+Tab");
  expect(await focusedText()).toMatchObject({ role: "radio", text: "Pause at an amount" });
  await page.keyboard.press("Tab");
  expect((await focusedText()).tag).toBe("INPUT");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")).toBe(
    "About usage limits",
  );
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest("[role='dialog']"))),
  ).toBe(true);
  // Back returns to the "+" menu on the Usage limit row; Escape closes to "+".
  await dialog.getByRole("button", { name: "Back" }).click();
  await page.getByRole("menu").waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-composer-panel") === "usage-limit",
  );
  await page.getByRole("menuitem", { name: /Usage limit/ }).click();
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "More composer actions",
  );
  await newChat.getByRole("button", { name: "More composer actions" }).click();
  expect(await page.getByRole("menuitem", { name: /Usage limit/ }).innerText()).toContain("$25.00");
  await page.keyboard.press("Escape");
  await newChat.getByRole("button", { name: "Send message" }).click();
  await newChat.getByText("Sample chat created · usage limit $25.00").waitFor();
  let state = await qa();
  expect(state.creates).toHaveLength(1);
  expect(state.creates[0]!.usageLimitMicros).toBe(25_000_000);

  // Reset after create; an empty amount blocks Send and says why.
  await newChat.getByRole("textbox").first().fill("Second chat");
  const reopened = await openNewChatUsageLimit();
  expect(await reopened.getByRole("radio", { name: /No limit/ }).getAttribute("aria-checked")).toBe(
    "true",
  );
  await reopened.getByText("Pause at an amount").click();
  await page.keyboard.press("Escape");
  await newChat.getByRole("button", { name: "Send message" }).click();
  state = await qa();
  expect(state.blockedSends).toBe(1);
  expect(state.creates).toHaveLength(1);
  const blocked = await openNewChatUsageLimit();
  await blocked.getByText("Enter an amount in US dollars, like 25.").waitFor();
  await expectNoAxeViolations("[role='dialog']");
  await blocked.getByRole("radio", { name: /No limit/ }).click();
  await page.keyboard.press("Escape");
  await newChat.getByRole("button", { name: "Send message" }).click();
  await newChat.getByText("Sample chat created · usage limit No limit").waitFor();
  state = await qa();
  expect(state.creates).toHaveLength(2);
  expect("usageLimitMicros" in state.creates[1]!).toBe(false);
  expect(pageErrors).toEqual([]);
}, 60_000);

test("the header menu opens the editor and keyboard-only saves return focus", async () => {
  await load();
  const main = scenario("main");
  expect(await amount(main).innerText()).toBe("$12.34 of $50.00");
  await page.getByRole("button", { name: "More session actions" }).click();
  await page.getByRole("menuitem", { name: "Usage limit" }).click();
  await editor(main).waitFor();
  await page.waitForFunction(() =>
    Boolean(document.activeElement?.closest("[data-usage-limit-editor]")),
  );
  let focused = await focusedText();
  expect(focused).toMatchObject({ role: "radio", text: "Pause at", inEditor: true });
  await capture("editor-within-limit", page.getByTestId("open-chat"));

  // Keyboard only: Tab to the amount, replace it, Enter saves.
  await page.keyboard.press("Tab");
  focused = await focusedText();
  expect(focused.tag).toBe("INPUT");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("75");
  await page.keyboard.press("Enter");
  await editor(main).waitFor({ state: "hidden" });
  await page.getByText("Usage limit set to $75.00").waitFor();
  expect(await amount(main).innerText()).toBe("$12.34 of $75.00");
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Change");
  expect((await focusedText()).scenario).toBe("scenario-main");
  expect((await qa()).saves.at(-1)).toEqual({
    scenario: "main",
    limitMicros: 75_000_000,
    expectedVersion: 3,
  });

  // Escape cancels without saving and returns focus to Change.
  const savesBefore = (await qa()).saves.length;
  await page.keyboard.press("Enter");
  await editor(main).waitFor();
  await main.getByRole("textbox", { name: "Limit in US dollars" }).focus();
  await page.keyboard.press("Escape");
  await editor(main).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Change");
  expect((await qa()).saves.length).toBe(savesBefore);
  expect(pageErrors).toEqual([]);
}, 60_000);

test("someone else's change while editing is a conflict: draft kept, theirs shown, retry is deliberate", async () => {
  await load();
  const main = scenario("main");
  await main.getByRole("button", { name: "Change" }).click();
  const input = main.getByRole("textbox", { name: "Limit in US dollars" });
  await input.fill("60");
  // A teammate sets $40 and this tab's live reader picks it up mid-edit.
  await changeOnServer("main", 40_000_000);
  await refocus();
  await main.getByText("$12.34 of $40.00").waitFor();
  expect(await input.inputValue()).toBe("60");
  await main.getByRole("button", { name: "Save" }).click();
  await main
    .getByRole("alert")
    .filter({
      hasText:
        "Someone changed this limit to $40.00 while you were editing. Save again to use your amount instead.",
    })
    .waitFor();
  expect(await input.inputValue()).toBe("60");
  await expectNoAxeViolations("[data-testid='open-chat']");
  await capture("editor-conflict", main);
  await main.getByRole("button", { name: "Save" }).click();
  await editor(main).waitFor({ state: "hidden" });
  expect(await amount(main).innerText()).toBe("$12.34 of $60.00");
  const saves = (await qa()).saves.filter((save) => save.scenario === "main");
  // The edit snapshot (3), refused by the server; then the deliberate retry (4).
  expect(saves.slice(-2)).toEqual([
    { scenario: "main", limitMicros: 60_000_000, expectedVersion: 3 },
    { scenario: "main", limitMicros: 60_000_000, expectedVersion: 4 },
  ]);
  const ops = (await qa()).saveOps.filter((save) => save.scenario === "main");
  expect(ops.at(-1)!.operationId).not.toBe(ops.at(-2)!.operationId);

  // Unavailable: the draft stays and the reason is announced.
  await steer({ failNext: { main: "unavailable" } });
  await main.getByRole("button", { name: "Change" }).click();
  await input.fill("65");
  await main.getByRole("button", { name: "Save" }).click();
  await main
    .getByRole("alert")
    .filter({ hasText: "Couldn't read this chat's usage right now. Try again in a moment." })
    .waitFor();
  expect(await input.inputValue()).toBe("65");

  // Removing the limit.
  await main.getByRole("radio", { name: "No limit" }).click();
  await main.getByRole("button", { name: "Save" }).click();
  await page.getByText("Usage limit removed").waitFor();
  expect(await amount(main).innerText()).toBe("No limit");
  await main.getByText("$12.34 used").waitFor();
  expect(pageErrors).toEqual([]);
}, 60_000);

test("a save whose answer is lost is re-sent as the same operation and applied once", async () => {
  await load();
  const main = scenario("main");
  await steer({ failNext: { main: "lost" } });
  await main.getByRole("button", { name: "Change" }).click();
  await main.getByRole("textbox", { name: "Limit in US dollars" }).fill("70");
  await main.getByRole("button", { name: "Save" }).click();
  await editor(main).waitFor({ state: "hidden" });
  await page.getByText("Usage limit set to $70.00").waitFor();
  expect(await amount(main).innerText()).toBe("$12.34 of $70.00");
  const state = await qa();
  const ops = state.saveOps.filter((save) => save.scenario === "main");
  expect(ops).toHaveLength(2);
  expect(ops[1]!.operationId).toBe(ops[0]!.operationId);
  expect(state.saves.filter((save) => save.scenario === "main")).toEqual([
    { scenario: "main", limitMicros: 70_000_000, expectedVersion: 3 },
    { scenario: "main", limitMicros: 70_000_000, expectedVersion: 3 },
  ]);
  expect(pageErrors).toEqual([]);
}, 60_000);

test("a failed refresh keeps the last amount and reached state, marked possibly out of date", async () => {
  await load();
  const main = scenario("main");
  expect(await amount(main).innerText()).toBe("$12.34 of $50.00");
  await steer({ failReads: { main: 1, reached: 1 } });
  await refocus();
  const staleNote = "Couldn't refresh, so this may be out of date. The limit still applies.";
  await main.getByText(staleNote).waitFor();
  expect(await amount(main).innerText()).toBe("$12.34 of $50.00");
  expect(await main.innerText()).not.toContain("$0");
  // The composer notice keeps reached, with the same note and its one action.
  const chat = page.getByTestId("reached-chat");
  const notice = chat.locator("[data-og-session-usage-limit='reached']");
  await notice.getByText(staleNote, { exact: false }).waitFor();
  expect(await notice.innerText()).toContain("$52.10 of $50.00");
  await chat.getByRole("button", { name: "Change limit" }).waitFor();
  await scenario("reached").getByText(staleNote).waitFor();
  await scenario("reached").getByText("Reached", { exact: true }).waitFor();
  await expectNoAxeViolations();
  await capture("read-failure", main);
  await capture("read-failure-reached", chat.locator(".."));
  await main.getByRole("button", { name: "Try again" }).click();
  await main.getByText(staleNote).waitFor({ state: "detached" });
  expect(pageErrors).toEqual([]);
}, 60_000);

test("coverage states never show unknown usage as $0", async () => {
  await load();
  const partial = scenario("partial");
  expect(await amount(partial).innerText()).toBe("At least $8.20 of $50.00");
  await partial.getByText("Some model usage has no known price, so it isn't counted.").waitFor();
  await partial
    .getByText("This chat started before usage limits, so some earlier usage may be missing.")
    .waitFor();

  const unavailable = scenario("unavailable");
  expect(await amount(unavailable).innerText()).toBe("Pause at $50.00");
  await unavailable.getByText("Usage unavailable").waitFor();
  expect(await unavailable.innerText()).not.toContain("$0");

  const preparing = scenario("preparing");
  expect(await amount(preparing).innerText()).toBe("No limit");
  await preparing.getByText("Preparing usage", { exact: true }).waitFor();
  expect(await preparing.innerText()).not.toContain("$0");
  await preparing.getByRole("button", { name: "Change" }).click();
  await preparing.getByRole("radio", { name: "Pause at" }).click();
  const input = preparing.getByRole("textbox", { name: "Limit in US dollars" });
  await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
  await input.fill("20");
  await preparing.getByRole("button", { name: "Save" }).click();
  await preparing
    .getByRole("alert")
    .filter({ hasText: "Earlier usage is still being counted. Save again in a moment" })
    .waitFor();
  expect(await input.inputValue()).toBe("20");
  await capture("editor-preparing", preparing);
  await preparing.getByRole("button", { name: "Cancel" }).click();
  expect(pageErrors).toEqual([]);
}, 60_000);

test("a task at its limit stops calmly, and raising the limit says Resume is next", async () => {
  await load();
  const chat = page.getByTestId("reached-chat");
  const reached = scenario("reached");
  expect(await amount(reached).innerText()).toBe("$52.10 of $50.00");
  await reached.getByText("Reached", { exact: true }).waitFor();
  const chatText = await chat.innerText();
  // History: one compact line at the stop, no remedy.
  expect(await chat.locator("[data-og-session-usage-limit-stop]").innerText()).toBe(
    "Usage limit reached · $52.10 of $50.00",
  );
  // Now: the composer notice holds the one recovery action.
  const notice = chat.locator("[data-og-session-usage-limit='reached']");
  expect(await notice.innerText()).toContain("$52.10 of $50.00 API-equivalent model usage.");
  expect(await notice.innerText()).toContain("Raise or remove the limit, then resume the goal.");
  expect(chatText.match(/Raise or remove the limit/g)).toHaveLength(1);
  expect(await chat.getByRole("button", { name: "Change limit" }).count()).toBe(1);
  // The Agent tab states the amount and the one explanation, not the remedy.
  expect(await reached.innerText()).not.toContain("Raise or remove");
  expect(chatText).not.toMatch(/credit|buy|purchase|failed|retry|error/i);
  await capture("reached-session", chat.locator(".."));

  await chat.getByRole("button", { name: "Change limit" }).click();
  await editor(reached).waitFor();
  await page.waitForFunction(() =>
    Boolean(document.activeElement?.closest("[data-usage-limit-editor]")),
  );
  expect((await focusedText()).scenario).toBe("scenario-reached");
  await reached.getByRole("textbox", { name: "Limit in US dollars" }).fill("80");
  await reached.getByRole("button", { name: "Save" }).click();
  await page.getByText("Usage limit set to $80.00").waitFor();
  await page.getByText("Resume the goal to continue.").waitFor();
  expect(await amount(reached).innerText()).toBe("$52.10 of $80.00");
  // The composer notice follows the shared read; the stop stays in history.
  await chat.getByRole("button", { name: "Change limit" }).waitFor({ state: "detached" });
  expect(await chat.innerText()).toContain("Usage limit reached");
  expect(pageErrors).toEqual([]);
}, 60_000);

test("a Send refused at the limit keeps the message to restore, without Retry", async () => {
  await load();
  const refused = page.getByTestId("refused-send");
  await refused
    .getByText("This task has used 98% of its usage limit ($49.10 of $50.00).")
    .waitFor();
  const text = "Ship the release notes for 4.2.";
  const box = refused.getByRole("textbox").first();
  await box.fill(text);
  await box.press("Enter");
  // The failed message says what happened; the notice holds the one remedy.
  await refused.getByText("This task's usage limit is reached. Your message is saved.").waitFor();
  await refused.getByText(text).first().waitFor();
  expect(await refused.getByRole("button", { name: /retry/i }).count()).toBe(0);
  await refused.getByText("$50.40 of $50.00 API-equivalent model usage.").waitFor();
  expect((await refused.innerText()).match(/Raise or remove the limit/g)).toHaveLength(1);
  await capture("refused-send", refused);
  expect((await qa()).sends).toBe(1);
  await refused.getByRole("button", { name: "Edit message" }).click();
  expect(await box.inputValue()).toBe(text);
  expect((await qa()).sends).toBe(1);
  expect(pageErrors).toEqual([]);
}, 60_000);

test("inherited, permission-denied and disabled limits are read-only or remove-only", async () => {
  await load();
  const child = scenario("child");
  expect(await amount(child).innerText()).toBe("$21.70 of $50.00");
  expect(await child.getByRole("button", { name: "Change" }).count()).toBe(0);
  expect(await child.getByRole("link", { name: "Open main task" }).getAttribute("href")).toBe(
    "/workspaces/00000000-0000-4000-8000-0000000000aa/sessions/00000000-0000-4000-8000-000000000106",
  );

  const forbidden = scenario("forbidden");
  expect(await forbidden.getByRole("button", { name: "Change" }).count()).toBe(0);
  await forbidden.getByText("Changing it needs permission to run this chat.").waitFor();

  const disabled = scenario("disabled");
  await disabled.getByRole("button", { name: "Change" }).click();
  await editor(disabled).waitFor();
  expect(
    await disabled.getByRole("radio", { name: "Pause at" }).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(await disabled.getByRole("textbox", { name: "Limit in US dollars" }).isDisabled()).toBe(
    true,
  );
  await disabled.getByRole("radio", { name: "No limit" }).click();
  await disabled.getByRole("button", { name: "Save" }).click();
  await editor(disabled).waitFor({ state: "hidden" });
  expect((await qa()).saves.at(-1)).toEqual({
    scenario: "disabled",
    limitMicros: null,
    expectedVersion: 3,
  });
  expect(await amount(disabled).innerText()).toBe("No limit");
  expect(pageErrors).toEqual([]);
}, 60_000);

test("on a touch phone the new-chat setting's controls are at least 44px tall", async () => {
  const touch = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const phone = await touch.newPage();
    await phone.goto(url);
    await phone.getByTestId("sample-data").waitFor();
    const newChat = phone.getByTestId("new-chat");
    await newChat.getByRole("button", { name: "More composer actions" }).tap();
    await phone.getByRole("menuitem", { name: /Usage limit/ }).tap();
    const dialog = phone.getByRole("dialog", { name: "Usage limit" });
    await dialog.getByText("Pause at an amount").tap();
    await dialog.getByRole("textbox", { name: "Limit in US dollars" }).waitFor();
    const heights = await dialog.evaluate((root) =>
      [
        ...root.querySelectorAll<HTMLElement>("input, [role='radio'], button[aria-label='Back']"),
      ].map((node) => ({
        name: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? node.tagName,
        height: Math.round(node.getBoundingClientRect().height),
      })),
    );
    expect(heights.length).toBeGreaterThanOrEqual(4);
    expect(heights.filter((entry) => entry.height < 44)).toEqual([]);
  } finally {
    await touch.close();
  }
}, 60_000);

for (const theme of ["dark", "light"] as const)
  for (const width of [1440, 390] as const)
    test(`${theme} ${width}px: no overflow or axe violations, screenshots`, async () => {
      const variant = `${width === 1440 ? "desktop-1440" : "mobile-390"}-${theme}`;
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await load(theme === "light" ? "?light" : "");
      expect(await page.evaluate(() => document.documentElement.dataset.ogTheme ?? "dark")).toBe(
        theme,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expectNoAxeViolations();

      // New chat: + > Usage limit with an amount.
      const menu = await openNewChatUsageLimit();
      await menu.getByText("Pause at an amount").click();
      await menu.getByRole("textbox", { name: "Limit in US dollars" }).fill("25");
      await expectNoAxeViolations("[role='dialog']");
      await capture(`${variant}-new-chat-setting`);
      await page.keyboard.press("Escape");

      // Editor within the limit, from the header menu.
      await page.getByRole("button", { name: "More session actions" }).click();
      await page.getByRole("menuitem", { name: "Usage limit" }).click();
      await editor(scenario("main")).waitFor();
      await expectNoAxeViolations("[data-testid='open-chat']");
      await capture(`${variant}-editor-within-limit`, page.getByTestId("open-chat"));

      await capture(`${variant}-partial-coverage`, scenario("partial"));

      const preparing = scenario("preparing");
      await preparing.getByRole("button", { name: "Change" }).click();
      await editor(preparing).waitFor();
      await capture(`${variant}-preparing`, preparing);

      const chat = page.getByTestId("reached-chat");
      await chat.getByText("Usage limit reached").first().waitFor();
      await capture(`${variant}-reached-in-session`, chat.locator(".."));
      await capture(`${variant}-child-inherited`, scenario("child"));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    }, 90_000);
