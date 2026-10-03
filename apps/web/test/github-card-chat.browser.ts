// Browser proof for the GitHub conversation card: every state at 1440px light
// and 390px dark, plus the attach, search, live-update and keyboard flows.
// Serve the production card with sample context first:
//   bun x vite --config test/github-connect-preview.vite.config.ts --port 4177
// No request leaves the page; repository authority is covered server-side.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const base =
  process.env.OPENGENI_GITHUB_PREVIEW_BASE_URL ??
  "http://127.0.0.1:4177/test/fixtures/github-connect-preview/";
const output = process.env.OPENGENI_GITHUB_CARD_SHOTS ?? "/tmp/og-ghcard-shots";
await mkdir(output, { recursive: true });

type Store = { sent: Array<{ text: string; clientEventId: string; resources: unknown[] }> };
type Control = { store(): Store; connectElsewhere(): void; revoke(): void; refreshes: number };

const viewports = [
  { width: 1440, height: 900, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
] as const;

const browser = await chromium.launch({
  ...(process.env.OPENGENI_GITHUB_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_GITHUB_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
let passed = 0;

async function open(
  viewport: (typeof viewports)[number],
  state: string,
  extra = "",
): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`${base}?state=${state}&theme=${viewport.theme}${extra}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("region", { name: "GitHub App setup" }).waitFor();
  return { page, errors };
}

async function shoot(page: Page, errors: string[], name: string, width: number) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `${name} overflows horizontally by ${overflow}px at ${width}px`);
  await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
  assert.deepEqual(errors, [], `${name} at ${width}px logged errors`);
}

async function check(name: string, run: (viewport: (typeof viewports)[number]) => Promise<void>) {
  for (const viewport of viewports) await run(viewport);
  passed += 1;
  console.log(`PASS ${name}`);
}

const card = (page: Page) => page.getByRole("region", { name: "GitHub App setup" });
const control = (page: Page) =>
  page.evaluate(() => {
    const value = (window as unknown as { __githubCard: Control }).__githubCard;
    return { sent: value.store().sent, refreshes: value.refreshes };
  });

try {
  const staticStates: Array<[string, string]> = [
    ["ready", "Connect GitHub App"],
    ["not-configured", "GitHub isn't available on this deployment right now."],
    ["not-configured-operator", "GitHub isn't set up on this deployment yet."],
    ["cannot-connect", "Only workspace admins can connect GitHub."],
    ["no-access", "You don't have access to this workspace's GitHub connection."],
    ["loading", "Connected to this workspace"],
    ["load-failed", "Couldn't load this workspace's repositories."],
    ["connected-zero", "No repositories shared yet"],
    ["connected-one", "Use in this chat"],
    ["connected-many", "Show 7 more"],
    ["attached", "Using acme/api in this chat"],
    ["multi", "Start a new chat to use northwind's."],
    ["revoked", "GitHub no longer shares this repository"],
    ["read-only", "Only people who can message this chat can add a repository to it."],
    ["member", "Ask a workspace admin to share it on GitHub."],
    ["personal", "Connected to your Personal workspace"],
  ];
  for (const [state, text] of staticStates) {
    await check(`state ${state}`, async (viewport) => {
      const { page, errors } = await open(viewport, state);
      await card(page).getByText(text, { exact: false }).first().waitFor();
      if (state === "not-configured" || state === "cannot-connect" || state === "no-access") {
        // An unavailable deployment or principal never sees a button that cannot work.
        assert.equal(await card(page).getByRole("button").count(), 0, `${state} shows a button`);
      }
      await shoot(page, errors, state, viewport.width);
      await page.close();
    });
  }

  await check("connect shows a visible, single in-flight state", async (viewport) => {
    const { page, errors } = await open(viewport, "opening");
    await page.getByRole("button", { name: "Connect GitHub App" }).click();
    const waiting = page.getByRole("button", { name: "Opening GitHub…" });
    await waiting.waitFor();
    assert.equal(await waiting.isDisabled(), true);
    await shoot(page, errors, "opening", viewport.width);
    await page.close();
  });

  await check("connect finished in another tab updates the same card", async (viewport) => {
    const { page, errors } = await open(viewport, "ready");
    const before = (await control(page)).refreshes;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(
      (count) => (window as unknown as { __githubCard: Control }).__githubCard.refreshes > count,
      before,
    );
    await page.evaluate(() =>
      (window as unknown as { __githubCard: Control }).__githubCard.connectElsewhere(),
    );
    await card(page).getByText("Connected to this workspace").waitFor();
    await card(page).getByRole("button", { name: "Use acme/api in this chat" }).waitFor();
    assert.equal(errors.length, 0);
    await page.close();
  });

  await check("one repository attaches through an ordinary human message", async (viewport) => {
    const { page, errors } = await open(viewport, "attach-one");
    await page.getByRole("button", { name: "Use acme/api in this chat" }).click();
    await card(page).getByText("Using acme/api in this chat").waitFor();
    await card(page).getByText("In this chat", { exact: true }).waitFor();
    const { sent } = await control(page);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, "Use acme/api");
    assert.match(sent[0]!.clientEventId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(sent[0]!.resources, [
      {
        kind: "repository",
        uri: "https://github.com/acme/api.git",
        ref: "main",
        provider: "github",
        mountPath: "repos/github.com/acme/api",
        githubRepositoryId: 101,
        githubInstallationId: 42,
      },
    ]);
    assert.equal(await card(page).getByRole("button", { name: /^Use / }).count(), 0);
    await shoot(page, errors, "attached-after-use", viewport.width);
    await page.close();
  });

  await check("attaching is visible and locks every Use action", async (viewport) => {
    const { page, errors } = await open(viewport, "connected-many", "&send=pending");
    await page.getByRole("button", { name: "Use acme/billing in this chat" }).click();
    await page.getByRole("button", { name: "Adding acme/billing" }).waitFor();
    for (const button of await card(page).getByRole("button", { name: /^Use / }).all()) {
      assert.equal(await button.isDisabled(), true);
    }
    await shoot(page, errors, "attaching", viewport.width);
    await page.close();
  });

  await check("a running chat queues the repository like Send", async (viewport) => {
    const { page, errors } = await open(viewport, "connected-many", "&send=queued");
    await page.getByRole("button", { name: "Use acme/cli in this chat" }).click();
    await card(page).getByText("It picks up acme/cli after its current step.").waitFor();
    await shoot(page, errors, "queued", viewport.width);
    await page.close();
  });

  await check("a refused attach explains itself and can be retried", async (viewport) => {
    const { page } = await open(viewport, "connected-many", "&send=fail");
    await page.getByRole("button", { name: "Use acme/api in this chat" }).click();
    await card(page).getByRole("alert").getByText("Couldn't add acme/api to this chat.").waitFor();
    const retry = page.getByRole("button", { name: "Use acme/api in this chat" });
    assert.equal(await retry.isDisabled(), false);
    await retry.click();
    await page.waitForFunction(
      () => (window as unknown as { __githubCard: Control }).__githubCard.store().sent.length === 2,
    );
    const { sent } = await control(page);
    // The retry reuses the idempotency key, so an unknown outcome cannot post twice.
    assert.equal(sent[0]!.clientEventId, sent[1]!.clientEventId);
    // A rejected request logs a console error by design; only page errors fail here.
    await page.screenshot({ path: `${output}/attach-error-${viewport.width}.png`, fullPage: true });
    await page.close();
  });

  await check(
    "search narrows, says when nothing matches, and show more expands",
    async (viewport) => {
      const { page, errors } = await open(viewport, "connected-many");
      const rows = () => card(page).locator('[data-slot="github-repositories"] li');
      assert.equal(await rows().count(), 5);
      await page.getByRole("button", { name: "Show 7 more" }).click();
      assert.equal(await rows().count(), 12);
      await shoot(page, errors, "show-more", viewport.width);
      await page.getByRole("searchbox", { name: "Search repositories" }).fill("bill");
      assert.equal(await rows().count(), 1);
      await card(page).getByText("acme/billing").waitFor();
      await shoot(page, errors, "search", viewport.width);
      await page.getByRole("searchbox", { name: "Search repositories" }).fill("nothing-here");
      await card(page).getByText("No repositories match “nothing-here”.").waitFor();
      await page.close();
    },
  );

  await check("keyboard reaches and activates Use", async (viewport) => {
    const { page } = await open(viewport, "attach-one");
    await page.locator("body").focus();
    let reached = false;
    for (let index = 0; index < 12 && !reached; index += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") === "Use acme/api in this chat",
      );
    }
    assert.ok(reached, "Tab never reached the Use action");
    await page.keyboard.press("Enter");
    await card(page).getByText("Using acme/api in this chat").waitFor();
    // Focus stays in the card, where the status line announces the result.
    assert.ok(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[aria-label="GitHub App setup"]')),
      ),
    );
    await page.close();
  });

  await check("access removed after attaching is shown on the stale card", async (viewport) => {
    const { page } = await open(viewport, "attached");
    await page.evaluate(() =>
      (window as unknown as { __githubCard: Control }).__githubCard.revoke(),
    );
    await card(page)
      .getByText("GitHub no longer shares this repository", { exact: false })
      .waitFor();
    await card(page).getByText("acme/api").first().waitFor();
    await page.close();
  });

  console.log(`${passed} browser checks passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
