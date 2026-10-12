import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// The session-header model-account control, rendered with real components
// against a synthetic client: a private chat (the person's own account can be
// chosen) and the current server refusal in a shared chat. Only Automatic or
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
    const page = await browser.newPage({ viewport: { width, height: 560 } });
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

    // A private chat: Automatic, shared accounts, then the person's own account.
    await open("private");
    await assertAccountActionsOnly();
    await page.getByRole("menu").getByTestId("billing-class-icon-claude_subscription").waitFor();
    await page.getByText("team-a@example.test", { exact: true }).waitFor();
    await page.getByText("Max · Organization", { exact: true }).waitFor();
    await page.getByText("Usage unavailable", { exact: true }).waitFor();
    assert((await page.getByRole("progressbar").count()) === 0, "neutral quota fabricated");
    await shot("private-open");

    // Choosing their own account retains the provider mark and shows ownership.
    await page.getByRole("menuitem", { name: /My Claude/ }).click();
    await page.getByText("Selection saved for the next turn.").waitFor();
    await page
      .getByRole("button", { name: "Model account · My Claude", exact: true, includeHidden: true })
      .waitFor();
    await assertAccountActionsOnly();
    await page.getByText("Pro · Your account", { exact: true }).waitFor();
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

    // A shared chat: the person's own account is listed but cannot be chosen.
    await open("shared");
    const mine = page.getByRole("menuitem", { name: /My Claude/ });
    assert((await mine.getAttribute("aria-disabled")) === "true", "personal account choosable");
    await page.getByText("Private chats only").waitFor();
    await assertAccountActionsOnly();
    assert(JSON.stringify(await receipts()) === "[]", "unexpected shared-chat action");
    await shot("shared-open");

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
