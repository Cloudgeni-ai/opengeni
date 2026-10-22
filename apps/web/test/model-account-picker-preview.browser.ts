import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// The session-header model-account control, rendered with real components
// against a synthetic client: private and shared chats (the person's own
// account can be chosen explicitly for their next send). Only Automatic or
// a specific account can be chosen; fallback preferences are not exposed.
const base = process.env.OPENGENI_PICKER_PREVIEW_URL ?? "http://127.0.0.1:4196";
const output = process.env.OPENGENI_PICKER_PREVIEW_OUTPUT ?? "/tmp/opengeni-picker-preview";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_PICKER_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_PICKER_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 640 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const theme = width === 390 ? "dark" : "light";
    const open = async (session: "private" | "shared", extra = "") => {
      await page.goto(
        `${base}/test/fixtures/model-account-picker-preview/?session=${session}&theme=${theme}${extra}`,
        { waitUntil: "networkidle" },
      );
      await page.getByRole("button", { name: /^(Model account|Switch Codex account)/ }).click();
      await page.getByText("Use for next turn").waitFor();
    };
    const shot = (name: string) => page.screenshot({ path: `${output}/${name}-${width}.png` });
    const assertAccountActionsOnly = async () => {
      assert((await page.getByRole("menuitemcheckbox").count()) === 0, "fallback action offered");
      assert((await page.getByRole("menuitem").count()) === 4, "unexpected menu action");
      assert((await page.getByText(/fall\s?back/i).count()) === 0, "fallback copy offered");
      const menu = await page.getByRole("menu").boundingBox();
      assert(menu && menu.x >= 0 && menu.x + menu.width <= width, "menu outside viewport");
    };
    const receipts = () =>
      page.evaluate(() => (window as unknown as { pickerReceipts: unknown[] }).pickerReceipts);

    await page.goto(
      `${base}/test/fixtures/model-account-picker-preview/?state=failover&theme=${theme}`,
      { waitUntil: "networkidle" },
    );
    await page.locator('main[data-serving-model="claude-sub/opus"]').waitFor();
    assert(
      (await page.locator("main").getAttribute("data-preferred-model")) === "codex/gpt-6-astra",
      "preferred model changed",
    );
    await page.getByText("Switched to a fallback model.", { exact: true }).waitFor();
    await page
      .getByText("Claude Opus 5.5", { exact: true })
      .waitFor({ state: width === 390 ? "attached" : "visible" });
    await shot("failover");

    // A private chat: Automatic, shared accounts, then the person's own account.
    await open("private");
    await assertAccountActionsOnly();
    await page.getByRole("menu").getByTestId("billing-class-icon-claude_subscription").waitFor();
    await page.getByText("team-a@example.test", { exact: true }).waitFor();
    await page.getByText("Max · Organization", { exact: true }).waitFor();
    await page.getByText(/Cached observation/).waitFor();
    assert((await page.getByRole("progressbar").count()) === 2, "stored quota not rendered");
    assert(
      (await page.getByRole("progressbar", { name: "5h used" }).getAttribute("aria-valuenow")) ===
        "36",
      "stored percentage changed",
    );
    await shot("private-open");
    const currentRow = page.getByRole("menuitem", { name: /Acme Claude 1/ });
    const otherRow = page.getByRole("menuitem", { name: /Acme Claude 2/ });
    assert(
      !(await currentRow.textContent())?.includes("36%"),
      "bound usage duplicated below header",
    );
    assert((await otherRow.textContent())?.includes("74% used"), "other account usage missing");

    // Choosing their own account retains the provider mark and shows ownership.
    await page.getByRole("menuitem", { name: /My Claude/ }).click();
    await page.getByText("Selection saved for the next turn.").waitFor();
    await page
      .getByRole("button", { name: "Model account · My Claude", exact: true, includeHidden: true })
      .waitFor();
    await assertAccountActionsOnly();
    await page.getByText("Pro · Your account", { exact: true }).waitFor();
    await page.getByText("No stored usage", { exact: true }).waitFor();
    assert(
      JSON.stringify(await receipts()) === '[{"choose":"mine"}]',
      "unexpected personal action",
    );
    await shot("private-chosen");

    // Returning to Automatic sends only the null account choice, not fallback preferences.
    await page.getByRole("menuitem", { name: "Automatic", exact: true }).click();
    await page.getByText("Chosen account", { exact: true }).waitFor({ state: "hidden" });
    await assertAccountActionsOnly();
    assert(
      JSON.stringify(await receipts()) === '[{"choose":"mine"},{"choose":null}]',
      "unexpected automatic action",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.waitForFunction(() =>
      document.activeElement?.getAttribute("aria-label")?.startsWith("Model account ·"),
    );

    // A shared chat: only the person's own explicit choice is available.
    await open("shared");
    const mine = page.getByRole("menuitem", { name: /My Claude/ });
    assert((await mine.getAttribute("aria-disabled")) !== "true", "own explicit account refused");
    await assertAccountActionsOnly();
    assert(JSON.stringify(await receipts()) === "[]", "unexpected shared-chat action");
    await shot("shared-open");

    // A live server refusal still disables the personal choice.
    await open("shared", "&state=personal-unavailable");
    assert(
      (await page.getByRole("menuitem", { name: /My Claude/ }).getAttribute("aria-disabled")) ===
        "true",
      "refused account enabled",
    );
    await page.getByText("Not available for this chat").waitFor();

    // Status is not flattened into a generic refusal; plan and identity remain.
    await open("private", "&state=statuses");
    await page.getByText("Max · Organization · Needs reconnect", { exact: true }).waitFor();
    const reconnect = page.getByRole("menuitem", { name: /Acme Claude 1/ });
    const failed = page.getByRole("menuitem", { name: /Acme Claude 2/ });
    assert((await reconnect.getAttribute("aria-disabled")) === "true", "reconnect account enabled");
    assert((await failed.getAttribute("aria-disabled")) === "true", "failed account enabled");
    await assertAccountActionsOnly();
    assert((await page.getByRole("progressbar").count()) === 0, "neutral quota fabricated");
    await shot("account-statuses");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.activeElement?.textContent?.includes("My Claude"));
    await page.keyboard.press("Enter");
    await page.getByText("Pro · Your account", { exact: true }).waitFor();
    assert(
      JSON.stringify(await receipts()) === '[{"choose":"mine"}]',
      "keyboard selection did not skip refused accounts",
    );

    // Nullable/partial/stale data stays historical and unknown, without
    // fabricated 0% utilization, 100% replenishment or an aggregate capacity.
    await open("private", "&usage=partial");
    await page.getByText("Unknown", { exact: true }).waitFor();
    assert((await page.getByRole("progressbar").count()) === 1, "unknown percent given a bar");
    assert(
      (await page
        .getByRole("progressbar", { name: "Overage used" })
        .getAttribute("aria-valuetext")) === "125% used",
      "overage value truncated",
    );
    await assertAccountActionsOnly();
    await shot("partial-unknown");
    await open("private", "&usage=stale");
    await page.getByText(/Reset time passed; current usage unknown/).waitFor();
    assert(
      (await page.getByRole("progressbar", { name: "5h used" }).getAttribute("aria-valuenow")) ===
        "100",
      "past reset invented replenishment",
    );
    await shot("stale-snapshot");
    await open("private", "&usage=missing");
    await page.getByText("Usage not reported", { exact: true }).waitFor();
    assert(
      (await page.getByRole("progressbar").count()) === 0,
      "missing projection manufactured usage",
    );
    await shot("omitted-usage");
    await open("private", "&state=redacted");
    await page.getByText("Account usage hidden", { exact: true }).waitFor();
    assert((await page.getByRole("progressbar").count()) === 0, "redacted account borrowed usage");
    await shot("redacted-binding");
    await open("private", "&provider=xai");
    await page.getByRole("menu").getByTestId("billing-class-icon-supergrok_subscription").waitFor();
    assert(
      (await page
        .getByRole("progressbar", { name: "Billing used" })
        .getAttribute("aria-valuenow")) === "42",
      "xai billing reading changed",
    );
    await shot("xai-account");

    // The actual Codex component uses the same extracted view with its real
    // adapter's usage/freshness path (synthetic readings, not production quotas).
    await open("private", "&provider=codex");
    await page.getByRole("progressbar", { name: "Week remaining" }).waitFor();
    assert((await page.getByRole("progressbar").count()) === 2, "Codex usage lost");
    assert(
      (await page
        .getByRole("progressbar", { name: "Week remaining" })
        .getAttribute("aria-valuenow")) === "38",
      "Codex quota changed",
    );
    await page.getByText("relogin", { exact: true }).waitFor();
    await assertAccountActionsOnly();
    await shot("codex-reference");

    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
