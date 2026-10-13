import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Account rules: the organization's rules with locks, every workspace's
// effective rules with their source, and one workspace's rules, rendered with
// real components against a synthetic client.
const base = process.env.OPENGENI_SETTINGS_PREVIEW_URL ?? "http://127.0.0.1:4195";
const output = process.env.OPENGENI_SETTINGS_PREVIEW_OUTPUT ?? "/tmp/opengeni-settings-preview";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_SETTINGS_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_SETTINGS_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const receipts = async (page: Page) =>
  JSON.stringify(
    await page.evaluate(
      () => (window as unknown as { settingsReceipts: unknown[] }).settingsReceipts,
    ),
  );

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 1800 : 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const open = async (query: string) =>
      await page.goto(
        `${base}/test/fixtures/model-account-settings-preview/?${query}&theme=${width === 390 ? "dark" : "light"}`,
        { waitUntil: "networkidle" },
      );
    const shot = async (name: string) => {
      const viewport = page.viewportSize()!;
      const height = await page.evaluate(async () => {
        await document.fonts.ready;
        return Math.max(
          document.documentElement.scrollHeight,
          document.querySelector("main")?.scrollHeight ?? 0,
        );
      });
      await page.setViewportSize({ width, height: Math.max(height, viewport.height) });
      await page.evaluate(async () => {
        for (const element of document.querySelectorAll("*"))
          if (element.scrollTop) element.scrollTop = 0;
        window.scrollTo({ top: 0, behavior: "instant" });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      await page.screenshot({
        path: `${output}/${name}-${width}.png`,
        animations: "disabled",
      });
      await page.setViewportSize(viewport);
    };
    const noOverflow = async () =>
      assert(
        !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
        "horizontal overflow",
      );

    // The organization: its rules with locks, then the workspaces that changed one.
    await open("view=organization");
    await page.getByText("Workspaces with their own rules").waitFor();
    await page.getByText("Claude Opus 5.5 → Claude Sonnet 5.5 → GPT-6.1 Sol").waitFor();
    const lock = (rule: string) =>
      page.getByRole("button", { name: `Lock for every workspace: ${rule}`, exact: true });
    assert(
      (await lock("Fall back to personal accounts").getAttribute("aria-pressed")) === "true",
      "locked rule shows unlocked",
    );
    await page.getByRole("button", { name: "Show more workspaces" }).click();
    await page.getByText("Research").waitFor();
    await noOverflow();
    await shot("organization");

    // Locking sharing work clears Research's own setting.
    await lock("Share work between accounts").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Lock for every workspace: Share work between accounts"]')
          ?.getAttribute("aria-pressed") === "true",
    );
    assert(
      (await receipts(page)).includes('"locked":["personalFallbackAllowed","rotation"]'),
      `lock not saved: ${await receipts(page)}`,
    );
    await noOverflow();
    await shot("organization-locked-rotation");

    // Sharing work is one switch for every provider.
    await page.getByRole("switch", { name: "Share work between accounts" }).click();
    await page.waitForFunction(() =>
      JSON.stringify(
        (window as unknown as { settingsReceipts: unknown[] }).settingsReceipts,
      ).includes(
        '"rotation":{"codex":{"mode":"primary_first"},"claude":{"mode":"primary_first"},"xai":{"mode":"primary_first"}}',
      ),
    );

    await page.getByRole("button", { name: "Edit order", exact: true }).click();
    await page.getByRole("button", { name: "Move GPT-6.1 Sol up", exact: true }).click();
    await page.getByRole("button", { name: "Save order", exact: true }).click();
    await page.waitForFunction(() =>
      JSON.stringify(
        (window as unknown as { settingsReceipts: unknown[] }).settingsReceipts,
      ).includes('"fallbackOrder":{"claude-sub/opus":["codex/sol","claude-sub/sonnet"]}'),
    );
    await noOverflow();
    await shot("organization-edit-order");

    // A workspace: its own value with a one-step return, and a locked rule.
    await open("view=workspace&workspace=design");
    await page.getByText("This workspace follows Acme unless you change a rule here.").waitFor();
    const fallback = page.getByRole("switch", { name: "Fall back to personal accounts" });
    assert((await fallback.getAttribute("aria-disabled")) === "true", "locked rule is editable");
    await noOverflow();
    await shot("workspace");
    await page.getByRole("button", { name: "Use Acme’s setting" }).click();
    await page.waitForFunction(() =>
      JSON.stringify(
        (window as unknown as { settingsReceipts: unknown[] }).settingsReceipts,
      ).includes('"personalConnectionsAllowed":null'),
    );
    await page.getByRole("button", { name: "Use Acme’s setting" }).waitFor({ state: "detached" });

    // A member reads the rules without changing them.
    await open("view=workspace&workspace=research&readonly=1");
    const sharing = page.getByRole("switch", { name: "Share work between accounts" });
    assert((await sharing.getAttribute("aria-checked")) === "false", "wrong sharing value");
    assert((await sharing.getAttribute("aria-disabled")) === "true", "member can share work");
    await page.getByText("Off for Codex, on for Claude, on for SuperGrok.").waitFor();
    await page.getByText("Set for this workspace.").first().waitFor();
    assert(
      (await page.getByRole("button", { name: "Use Acme’s setting" }).count()) === 0,
      "member can reset",
    );
    await noOverflow();
    await shot("workspace-member");

    await open("view=workspace&workspace=platform&personal=allowed");
    const ownFallback = page.getByRole("switch", { name: "Fall back to my account", exact: true });
    await ownFallback.waitFor();
    assert(
      (await ownFallback.getAttribute("aria-checked")) === "false",
      "permission opted the person in",
    );
    await ownFallback.click();
    await page.waitForFunction(() =>
      JSON.stringify(
        (window as unknown as { settingsReceipts: unknown[] }).settingsReceipts,
      ).includes('"personalFallbackOptIn":true'),
    );
    await noOverflow();
    await shot("workspace-personal-opt-in");

    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
