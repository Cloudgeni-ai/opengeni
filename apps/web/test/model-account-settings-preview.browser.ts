import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Sharing subscriptions: the default rules, which of them workspaces
// can change, and one workspace's rules, rendered with real components
// against a synthetic client.
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

    // The organization: its rules, one row per provider, and which of them
    // workspaces can change on its own page.
    await open("view=organization");
    await page.getByText("Sharing subscriptions", { exact: true }).waitFor();
    await page.getByText("Claude Opus 5.5 → Claude Sonnet 5.5 → GPT-6.1 Sol").waitFor();
    await page.getByText("Used by every workspace. Workspaces can’t change it.").first().waitFor();
    await page.getByRole("switch", { name: "Share work between Codex subscriptions" }).waitFor();
    await noOverflow();
    await shot("organization");

    // Keeping rotation the same everywhere clears Research's own rotation.
    await page.getByRole("button", { name: /What workspaces can change/ }).click();
    await page.getByRole("checkbox", { name: "Share work between subscriptions" }).uncheck();
    await noOverflow();
    await shot("organization-locks");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Sharing subscriptions", { exact: true }).waitFor();
    assert(
      (await receipts(page)).includes('"locked":["rotation","personalFallbackAllowed"]'),
      `lock not saved: ${await receipts(page)}`,
    );
    await page.getByText("3 of 5 rules").waitFor();
    await noOverflow();
    await shot("organization-locked-rotation");

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

    // A workspace: its own value with a one-step return, and a locked rule
    // that shows once the rule it depends on is on again.
    await open("view=workspace&workspace=design");
    await page.getByText("Sharing subscriptions", { exact: true }).waitFor();
    const fallback = page.getByRole("switch", { name: "Fall back to personal subscriptions" });
    assert((await fallback.count()) === 0, "dependent rule shown while its rule is off");
    await noOverflow();
    await shot("workspace");
    await page.getByRole("button", { name: /Use the default/ }).click();
    await page.waitForFunction(() =>
      JSON.stringify(
        (window as unknown as { settingsReceipts: unknown[] }).settingsReceipts,
      ).includes('"personalConnectionsAllowed":null'),
    );
    await page.getByRole("button", { name: /Use the default/ }).waitFor({ state: "detached" });
    assert((await fallback.getAttribute("aria-disabled")) === "true", "locked rule is editable");

    // A member reads the rules without changing them.
    await open("view=workspace&workspace=research&readonly=1");
    assert(
      (await page
        .getByRole("switch", { name: "Share work between Codex subscriptions" })
        .getAttribute("aria-checked")) === "false",
      "wrong rotation value",
    );
    await page.getByText("Changed for Research").first().waitFor();
    assert(
      (await page.getByRole("button", { name: /Use the default/ }).count()) === 0,
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
