import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { freePort, startProcess } from "@opengeni/testing";

test("plugin removal shows truthful impact, preserves focus, and rechecks stale details", async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const web = await startProcess(
    ["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: new URL("../../apps/web", import.meta.url).pathname,
      ready: async () => (await fetch(origin).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  const browser = await chromium
    .launch({
      headless: true,
      ...(existsSync("/usr/local/bin/chromium")
        ? { executablePath: "/usr/local/bin/chromium" }
        : {}),
    })
    .catch(async (error) => {
      await web.stop();
      throw error;
    });
  const evidence = new URL("../../.agent/evidence/plugin-removal/", import.meta.url).pathname;
  await mkdir(evidence, { recursive: true });
  try {
    for (const width of [1440, 390, 320]) {
      for (const scenario of [
        "",
        "simple",
        "dark",
        "long",
        "stale",
        "error",
        "unavailable",
        "empty",
        "refresh-error",
        "delayed-refresh",
        "skill-list-error",
        "plugin-list-error",
        "already-removed-refresh-error",
      ]) {
        const context = await browser.newContext({
          viewport: { width, height: scenario === "long" ? 600 : 900 },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        await page.goto(`${origin}/test/plugin-removal.html?${scenario}`);
        const trigger = page.getByRole("button", { name: "Remove", exact: true });
        await trigger.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        expect(await dialog.getByRole("heading", { name: "Remove Aikido?" }).count()).toBe(1);
        expect(await dialog.getByText("Your connected accounts will stay connected.").count()).toBe(
          1,
        );
        expect(await dialog.textContent()).not.toContain("Plugin owner");
        expect(await dialog.textContent()).not.toContain("0 will remain");
        await page.waitForFunction(() => document.activeElement?.textContent === "Cancel");
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual((scenario === "long" ? 600 : 900) + 1);
        const audit = await new AxeBuilder({ page })
          .include('[role="dialog"]')
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        expect(audit.violations, JSON.stringify(audit.violations)).toEqual([]);
        if (["", "dark", "simple", "long"].includes(scenario))
          await page.screenshot({
            path: `${evidence}${width}-${scenario || "mixed"}.png`,
            fullPage: true,
          });
        if (scenario === "simple") {
          expect(await dialog.getByRole("region", { name: "Will stay", exact: true }).count()).toBe(
            0,
          );
        } else if (scenario !== "empty") {
          expect(
            await dialog.getByText("Customized in this workspace.", { exact: true }).count(),
          ).toBe(1);
          expect(await dialog.getByText("Also included in Code review.").count()).toBe(1);
        }
        if (scenario === "long")
          expect(
            await dialog
              .getByRole("region", { name: "Removal details" })
              .evaluate((node) => node.scrollHeight > node.clientHeight),
          ).toBe(true);
        if (scenario === "unavailable") {
          expect(
            await dialog.getByRole("button", { name: "Remove plugin", exact: true }).isDisabled(),
          ).toBe(true);
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await page.waitForFunction(() => document.activeElement?.textContent === "Remove");
          await context.close();
          continue;
        }
        // Cancel never mutates and restores the initiating control.
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.textContent === "Remove");
        expect(
          await page.evaluate(
            () => (window as unknown as { removalRequests: unknown[] }).removalRequests.length,
          ),
        ).toBe(0);
        await trigger.click();
        await dialog.getByRole("button", { name: "Remove plugin", exact: true }).click();
        await dialog.getByRole("button", { name: "Removing…" }).waitFor();
        expect(await dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(
          true,
        );
        if (scenario === "error") {
          await dialog.getByRole("alert").waitFor();
          expect(await dialog.isVisible()).toBe(true);
          expect(
            await page
              .getByRole("button", { name: "Remove", exact: true, includeHidden: true })
              .count(),
          ).toBe(1);
          await context.close();
          continue;
        }
        if (scenario === "stale") {
          await dialog.getByRole("alert").waitFor();
          expect(await dialog.getByRole("alert").textContent()).toContain(
            "Review the updated details",
          );
          expect(
            await dialog.getByText("Customized in this workspace.", { exact: true }).count(),
          ).toBe(2);
          const first = await page.evaluate(
            () =>
              (window as unknown as { removalRequests: { expectedPreviewToken: string }[] })
                .removalRequests,
          );
          expect(first).toHaveLength(1);
          expect(first[0]!.expectedPreviewToken).toBe("a".repeat(64));
          await dialog.getByRole("button", { name: "Remove plugin", exact: true }).click();
        }
        await dialog.waitFor({ state: "hidden" });
        if (scenario === "delayed-refresh") {
          // Hold both inventory requests until dialog teardown/focus restoration
          // has completed. Confirmed deletion must already remove its opener.
          expect(await trigger.count()).toBe(0);
          await page.waitForFunction(() => document.activeElement?.tagName === "H1");
          expect(await page.getByText("No plugins installed.").count()).toBe(0);
          await page.evaluate(() =>
            (window as unknown as { releaseRemovalRefresh: () => void }).releaseRemovalRefresh(),
          );
        }
        await page.getByText("No plugins installed.").waitFor();
        expect(await trigger.count()).toBe(0);
        const requests = await page.evaluate(
          () =>
            (
              window as unknown as {
                removalRequests: { expectedPreviewToken: string; idempotencyKey: string }[];
              }
            ).removalRequests,
        );
        expect(requests).toHaveLength(scenario === "stale" ? 2 : 1);
        expect(requests.at(-1)!.expectedPreviewToken).toBe(
          (scenario === "stale" ? "b" : "a").repeat(64),
        );
        if (scenario === "stale")
          expect(requests[0]!.idempotencyKey).not.toBe(requests[1]!.idempotencyKey);
        if (
          [
            "refresh-error",
            "skill-list-error",
            "plugin-list-error",
            "already-removed-refresh-error",
          ].includes(scenario)
        )
          await page.getByText("Removed, but the page couldn’t refresh").waitFor();
        else await page.locator("[data-refreshed]").waitFor();
        if (scenario === "already-removed-refresh-error")
          await page.getByText("This plugin is already removed").waitFor();
        expect(await page.getByText("Couldn't remove this Plugin", { exact: true }).count()).toBe(
          0,
        );
        expect(
          await page
            .getByText("Couldn’t refresh the removal details. Close this dialog and try again.")
            .count(),
        ).toBe(0);
        await page.waitForFunction(() => document.activeElement?.tagName === "H1");
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 180_000);
