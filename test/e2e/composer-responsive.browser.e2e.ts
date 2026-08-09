import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("container-responsive public composer demo", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const sandboxChromium = "/usr/local/bin/chromium";
    const executablePath =
      configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    demo = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "demo",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
        "--force",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/composer-responsive.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 30_000);

  test("a wide viewport follows the child panel across the full width matrix", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/composer-responsive.html?width=320`, {
      waitUntil: "networkidle",
    });

    await page.evaluate(() => {
      (window as typeof window & { __composerRoot?: Element | null }).__composerRoot =
        document.querySelector(".og-composer");
    });

    for (const width of [280, 320, 360, 420, 640, 768]) {
      await page.getByRole("button", { name: `${width}px`, exact: true }).click();
      await page.waitForFunction(
        (expected) =>
          document.querySelector<HTMLElement>("[data-composer-panel]")?.dataset.panelWidth ===
            String(expected) &&
          Math.abs(
            (document.querySelector<HTMLElement>("[data-composer-panel]")?.getBoundingClientRect()
              .width ?? 0) - expected,
          ) <= 1,
        width,
      );
      const bounds = await page.locator("[data-composer-panel]").evaluate((panel) => ({
        panelWidth: panel.getBoundingClientRect().width,
        overflow: panel.scrollWidth - panel.clientWidth,
        rootOverflow:
          (panel.querySelector<HTMLElement>(".og-composer")?.scrollWidth ?? 0) -
          (panel.querySelector<HTMLElement>(".og-composer")?.clientWidth ?? 0),
      }));
      expect(Math.abs(bounds.panelWidth - width)).toBeLessThanOrEqual(1);
      expect(bounds.overflow).toBeLessThanOrEqual(1);
      expect(bounds.rootOverflow).toBeLessThanOrEqual(1);
    }

    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __composerRoot?: Element | null }).__composerRoot ===
          document.querySelector(".og-composer"),
      ),
    ).toBe(true);

    await selectWidth(page, 320);
    const narrow = await responsiveVisibility(page);
    expect(narrow.fullLabel).toBe("none");
    expect(narrow.shortLabel).not.toBe("none");
    expect(narrow.effort).toBe("none");
    expect(narrow.inputFontSize).toBe("16px");
    expect(narrow.modelHeight).toBe(32);
    expect(narrow.realtimePrimarySize).toBe(32);

    await openModelMenu(page);
    await assertPortalBoundToComposer(page, ".og-model-policy-menu");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Choose voice model and options" }).click();
    await page.locator(".og-realtime-menu").waitFor();
    await assertPortalBoundToComposer(page, ".og-realtime-menu");
    await page.keyboard.press("Escape");

    const textarea = page.getByRole("textbox", { name: "Message the agent" });
    await textarea.fill("/");
    await page.getByRole("listbox", { name: "Slash commands" }).waitFor();
    expect(
      await page
        .locator(".og-command-description")
        .first()
        .evaluate((node) => getComputedStyle(node).display),
    ).toBe("none");
    await textarea.fill("A long prompt remains editable while the panel resizes.");
    await page.getByRole("listbox", { name: "Slash commands" }).waitFor({ state: "detached" });

    await page.getByRole("button", { name: /^Paused:/ }).click();
    const pausedLabels = await page
      .locator('[aria-label="Resume this workstream"]')
      .evaluate((button) => ({
        long: getComputedStyle(button.querySelector<HTMLElement>(".og-composer-resume-label-long")!)
          .display,
        short: getComputedStyle(
          button.querySelector<HTMLElement>(".og-composer-resume-label-short")!,
        ).display,
      }));
    expect(pausedLabels.long).toBe("none");
    expect(pausedLabels.short).not.toBe("none");

    await selectWidth(page, 768);
    const wide = await responsiveVisibility(page);
    expect(wide.fullLabel).not.toBe("none");
    expect(wide.shortLabel).toBe("none");
    expect(wide.effort).not.toBe("none");
    // The composer root is the measured container; host panel padding leaves
    // this 768px fixture just below the 48rem input-density threshold.
    expect(wide.inputFontSize).toBe("16px");

    expect(await page.getByRole("listbox", { name: "Slash commands" }).count()).toBe(0);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    await context.close();
  }, 90_000);

  test("density/theme stay orthogonal and coarse pointers retain 44px targets", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(
      `${baseUrl}/composer-responsive.html?width=320&density=compact&theme=light&voice=active`,
      { waitUntil: "networkidle" },
    );

    const audit = await page.locator("[data-composer-panel]").evaluate((panel) => {
      const primary = panel.querySelector<HTMLElement>('[data-testid="realtime-primary-action"]')!;
      const picker = panel.querySelector<HTMLElement>('[aria-label="Model and effort"]')!;
      return {
        density: panel.getAttribute("data-og-density"),
        colorScheme: getComputedStyle(panel).colorScheme,
        overflow: panel.scrollWidth - panel.clientWidth,
        primary: Math.min(
          primary.getBoundingClientRect().width,
          primary.getBoundingClientRect().height,
        ),
        picker: picker.getBoundingClientRect().height,
      };
    });
    expect(audit.density).toBe("compact");
    expect(audit.colorScheme).toBe("light");
    expect(audit.overflow).toBeLessThanOrEqual(1);
    expect(audit.primary).toBeGreaterThanOrEqual(44);
    expect(audit.picker).toBeGreaterThanOrEqual(44);
    await context.close();
  }, 60_000);
});

async function selectWidth(page: Page, width: number): Promise<void> {
  await page.getByRole("button", { name: `${width}px`, exact: true }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector<HTMLElement>("[data-composer-panel]")?.dataset.panelWidth ===
        String(expected) &&
      Math.abs(
        (document.querySelector<HTMLElement>("[data-composer-panel]")?.getBoundingClientRect()
          .width ?? 0) - expected,
      ) <= 1,
    width,
  );
}

async function responsiveVisibility(page: Page) {
  return page.locator(".og-composer").evaluate((root) => {
    const display = (selector: string) =>
      getComputedStyle(root.querySelector<HTMLElement>(selector)!).display;
    const rect = (selector: string) =>
      root.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    return {
      fullLabel: display(".og-model-policy-label-full"),
      shortLabel: display(".og-model-policy-label-short"),
      effort: display(".og-model-policy-effort"),
      inputFontSize: getComputedStyle(root.querySelector(".og-composer-input")!).fontSize,
      modelHeight: rect(".og-model-policy-trigger").height,
      realtimePrimarySize: Math.min(
        rect('[data-testid="realtime-primary-action"]').width,
        rect('[data-testid="realtime-primary-action"]').height,
      ),
    };
  });
}

async function openModelMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Model and effort" }).click();
  await page.locator(".og-model-policy-menu").waitFor();
}

async function assertPortalBoundToComposer(page: Page, selector: string): Promise<void> {
  const audit = await page.locator(selector).evaluate((menu) => {
    const root = document.querySelector<HTMLElement>(".og-composer")!;
    const sourceWidth = Number.parseFloat(
      menu.style.getPropertyValue("--og-portal-source-inline-size"),
    );
    return {
      menuWidth: menu.getBoundingClientRect().width,
      rootWidth: root.getBoundingClientRect().width,
      sourceWidth,
    };
  });
  expect(Math.abs(audit.sourceWidth - audit.rootWidth)).toBeLessThanOrEqual(1);
  expect(audit.menuWidth).toBeLessThanOrEqual(audit.rootWidth - 15);
}
