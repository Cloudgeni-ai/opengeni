import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const longTitle =
  "Now I am testing your workspace rail and this title should use every available pixel";

describe("Session rail row metadata in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/test/session-rail-row-metadata.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${baseUrl}/test/session-rail-row-metadata.html`, { waitUntil: "networkidle" });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("shows scheduled work and overdue rechecks, then clears waiting on completion", async () => {
    const preview = page.getByTestId("wait-preview");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await page.reload({ waitUntil: "networkidle" });
      expect(await preview.innerText()).toContain("Continues automatically");
      expect(await page.getByTestId("waiting-row").innerText()).toContain("Waiting · ");
      expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/opengeni-wait-status-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Recheck due", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="wait-preview"]')
          ?.textContent?.includes("The scheduled recheck is due"),
      );
      expect(await page.getByTestId("waiting-row").innerText()).toContain("Recheck due");
      await page.getByRole("button", { name: "Complete work", exact: true }).click();
      expect(await preview.innerText()).not.toContain("Waiting ·");
      expect(await preview.innerText()).not.toContain("Continues automatically");
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("contains every production-width row and keeps titles clear of real metadata", async () => {
    const rail = page.getByTestId("production-session-rail");
    expect((await rail.boundingBox())?.width).toBe(244);
    expect(await rail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    for (const id of [
      "time-only",
      "status-time",
      "schedule-date",
      "no-metadata",
      "selected-child",
      "unselected-child",
    ]) {
      const row = page.locator(`[data-row-case="${id}"]`);
      const link = row.locator("a");
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await link.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await link.getAttribute("aria-label")).toContain(
        "Now I am testing your workspace rail",
      );

      const metadata = row.locator("[data-session-row-metadata]");
      if ((await metadata.count()) === 0) continue;
      const titleBox = await row.locator("[data-session-row-title]").boundingBox();
      const metadataBox = await metadata.boundingBox();
      expect(titleBox).not.toBeNull();
      expect(metadataBox).not.toBeNull();
      expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(metadataBox!.x + 0.5);
    }
  });

  test("uses extra title width when metadata shrinks beyond the minimum action slots", async () => {
    const width = async (id: string) =>
      (await page.locator(`[data-row-case="${id}"] [data-session-row-title]`).boundingBox())!.width;

    expect(await width("time-only")).toBeGreaterThan(await width("status-time"));
    expect(await width("no-metadata")).toBe(await width("time-only"));
    expect(await width("unselected-child")).toBeLessThan(await width("selected-child"));
    expect(await page.locator('[data-row-case="selected-child"]').getAttribute("class")).toContain(
      "bg-surface-3",
    );
  });

  test("opens useful session context promptly without a delayed native tooltip", async () => {
    const row = page.locator('[data-row-case="time-only"]');
    const link = row.locator("a");
    expect(await row.getAttribute("title")).toBeNull();
    expect(await link.getAttribute("title")).toBeNull();
    expect(await row.locator("[data-creator-monogram]").getAttribute("title")).toBeNull();

    const hoveredAt = Date.now();
    await link.hover();
    const hoverCard = page.locator('[data-slot="hover-card-content"]');
    await hoverCard.waitFor({ state: "visible", timeout: 600 });
    expect(Date.now() - hoveredAt).toBeLessThan(600);

    const text = await hoverCard.innerText();
    expect(text).toContain(longTitle);
    expect(text).toContain("Created by Bendik Nyheim");
    expect(text).toContain("3 sub-agents");
    expect(text).not.toContain("Idle");
    expect(text).not.toContain("Read");

    const rowBox = await row.boundingBox();
    const cardBox = await hoverCard.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.x).toBeGreaterThan(rowBox!.x + rowBox!.width);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(1280);
  });

  test("contains long hover titles, creator names, and age within the card", async () => {
    await page.mouse.move(1000, 700);
    await page.locator('[data-row-case="overflow"] a').hover();
    const card = page.locator('[data-slot="hover-card-content"]');
    await card.waitFor({ state: "visible" });
    await card.getByText("Long_unbroken_session_title_".repeat(8), { exact: true }).waitFor();
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const cardBox = (await card.boundingBox())!;
    const contents = card.locator("[data-session-row-hover-details], p, [aria-label], span");
    for (const element of await contents.all()) {
      const box = (await element.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    }
    expect(await card.locator("p").innerText()).toBe("Long_unbroken_session_title_".repeat(8));
    await page.screenshot({ path: "/tmp/opengeni-session-hover-overflow.png", fullPage: true });
  });

  test("swaps only trailing slots without moving titles or remaining metadata", async () => {
    for (const id of [
      "time-only",
      "status-time",
      "schedule-date",
      "no-metadata",
      "selected-child",
      "unselected-child",
    ]) {
      const row = page.locator(`[data-row-case="${id}"]`);
      await page.locator("main").click({ position: { x: 900, y: 600 } });
      const titleBefore = await row.locator("[data-session-row-title]").boundingBox();
      const slots = row.locator("[data-session-row-slot]");
      const before = await Promise.all((await slots.all()).map((slot) => slot.boundingBox()));
      const actionCount = await row.locator("[data-session-quick-actions] button").count();
      for (const interaction of ["hover", "focus"] as const) {
        await page.mouse.move(1000, 700);
        if (interaction === "hover") await row.hover();
        else await row.getByRole("button", { name: "Pin session", exact: true }).focus();
        await page.waitForFunction((rowId) => {
          const actions = document.querySelector(
            `[data-row-case="${rowId}"] [data-session-quick-actions]`,
          );
          return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "1";
        }, id);
        const actions = (await row.locator("[data-session-quick-actions]").boundingBox())!;
        const rowBox = (await row.boundingBox())!;
        expect(actions.width).toBeGreaterThan(0);
        expect(await row.locator("[data-session-row-title]").boundingBox()).toEqual(titleBefore);
        for (let index = 0; index < before.length; index++) {
          const slot = slots.nth(index);
          expect(await slot.boundingBox()).toEqual(before[index]);
          expect(await slot.evaluate((element) => getComputedStyle(element).visibility)).toBe(
            index >= before.length - actionCount ? "hidden" : "visible",
          );
          if (index < before.length - actionCount) {
            expect(before[index]!.x + before[index]!.width).toBeLessThanOrEqual(actions.x);
          }
        }
        expect(actions.x + actions.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
        await page.locator("main").click({ position: { x: 900, y: 600 } });
      }
    }
  });

  test("reveals direct pin and archive controls on hover and keyboard focus", async () => {
    const row = page.locator('[data-row-case="time-only"]');
    const link = row.locator("a");
    const quickActions = row.locator('[data-session-quick-actions="quick-actions"]');

    await page.mouse.move(1000, 700);
    await page.waitForFunction(() => {
      const actions = document.querySelector('[data-session-quick-actions="quick-actions"]');
      return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "0";
    });
    expect(await quickActions.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");

    await link.hover();
    await page.waitForFunction(() => {
      const actions = document.querySelector('[data-session-quick-actions="quick-actions"]');
      return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "1";
    });
    await row.getByRole("button", { name: "Pin session", exact: true }).waitFor();
    await row.getByRole("button", { name: "Archive session", exact: true }).waitFor();
    await page.screenshot({
      path: "/tmp/opengeni-session-row-quick-actions.png",
      fullPage: true,
    });

    await page.mouse.move(1000, 700);
    await page.waitForFunction(() => {
      const actions = document.querySelector('[data-session-quick-actions="quick-actions"]');
      return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "0";
    });
    const pinButton = row.getByRole("button", { name: "Pin session", exact: true });
    await pinButton.focus();
    await page.waitForFunction(() => {
      const actions = document.querySelector('[data-session-quick-actions="quick-actions"]');
      return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "1";
    });
    await pinButton.press("Enter");
    await row.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
    await row.getByRole("button", { name: "Archive session", exact: true }).click();
    await row.getByRole("button", { name: "Restore session", exact: true }).waitFor();
    expect(await row.getByRole("button", { name: "Pin session" }).count()).toBe(0);
    const titleBefore = await row.locator("[data-session-row-title]").boundingBox();
    await page.locator("main").click({ position: { x: 900, y: 600 } });
    expect(await row.locator("[data-session-row-title]").boundingBox()).toEqual(titleBefore);
    await row.getByRole("button", { name: "Restore session", exact: true }).focus();
    expect(await row.locator("[data-session-row-title]").boundingBox()).toEqual(titleBefore);
    expect(
      await row
        .locator("[data-session-row-slot]")
        .last()
        .evaluate((element) => getComputedStyle(element).visibility),
    ).toBe("hidden");
  });

  test("coarse pointers retain metadata instead of showing desktop quick actions", async () => {
    const touch = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1280, height: 800 },
    });
    try {
      const touchPage = await touch.newPage();
      await touchPage.goto(`${baseUrl}/test/session-rail-row-metadata.html`, {
        waitUntil: "networkidle",
      });
      const row = touchPage.locator('[data-row-case="status-time"]');
      await row.locator("a").focus();
      expect(await row.locator("[data-session-quick-actions]").isVisible()).toBe(false);
      for (const slot of await row.locator("[data-session-row-slot]").all()) {
        expect(await slot.evaluate((element) => getComputedStyle(element).visibility)).toBe(
          "visible",
        );
      }
    } finally {
      await touch.close();
    }
  });
});
