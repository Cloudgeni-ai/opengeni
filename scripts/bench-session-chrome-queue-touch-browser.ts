#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const origin = process.env.QUEUE_TOUCH_WEB_ORIGIN ?? "http://127.0.0.1:3002";
const count = Number(process.env.QUEUE_TOUCH_COUNT ?? "100");
const screenshotPath = process.env.QUEUE_TOUCH_SCREENSHOT;
const pageUrl = `${origin}/dev/composer-chrome?scenario=queued-only&queueCount=${count}&queueOpen=0&queueReadOnly=0&queueDelayMs=1200`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  reducedMotion: "reduce",
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(String(error)));

try {
  await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 60_000 });
  const queueSignal = page.locator('[data-og-session-chrome-signal="queue"]');
  const directScenario = await queueSignal
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!directScenario) {
    // Older current-main controls do not support the query-driven benchmark
    // fixture. Select the same built-in state through its real phone UI.
    await page.getByRole("button", { name: /queued-only/i }).click();
    await queueSignal.waitFor({ state: "visible", timeout: 10_000 });
  }
  if (!(await page.locator('[data-og-session-chrome-panel="queue"]').isVisible())) {
    await queueSignal.tap();
  }
  const firstRow = page.locator("[data-queue-turn-id]").first();
  await firstRow.waitFor({ state: "visible" });
  await firstRow.scrollIntoViewIfNeeded();

  const before = await inspectFirstRow();
  const more = page.getByRole("button", { name: "More actions for queued prompt 1", exact: true });
  const hasMore = (await more.count()) > 0 && (await more.isVisible());
  const moreBox = hasMore ? await more.boundingBox() : null;
  const moreHit = moreBox ? await hitAt(moreBox) : null;
  let disclosed: Awaited<ReturnType<typeof inspectDisclosedActions>> | null = null;
  if (hasMore) {
    await more.tap();
    disclosed = await inspectDisclosedActions();
    await more.tap();
  }

  const steer = page.getByRole("button", { name: "Steer queued prompt 1", exact: true });
  const steerBox = await steer.boundingBox();
  const steerHit = steerBox ? await hitAt(steerBox) : null;
  const steerStartedAt = performance.now();
  await steer.tap();
  const steerTapMs = performance.now() - steerStartedAt;
  const pendingReceiptVisible = await page
    .locator('[data-og-session-chrome-signal="steering"]')
    .isVisible()
    .catch(() => false);

  if (screenshotPath) {
    const resolvedScreenshotPath = resolve(screenshotPath);
    await mkdir(dirname(resolvedScreenshotPath), { recursive: true });
    await page.screenshot({ path: resolvedScreenshotPath, fullPage: false });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        origin,
        requestedCount: count,
        viewport: { width: 390, height: 844, touch: true },
        before,
        steer: { box: steerBox, centerHit: steerHit, tapMs: steerTapMs, pendingReceiptVisible },
        more: { box: moreBox, centerHit: moreHit },
        disclosed,
        errors,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.allSettled([context.close(), browser.close()]);
}

async function inspectFirstRow() {
  return await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("[data-queue-turn-id]");
    if (!row) throw new Error("queue row missing");
    const rowBox = row.getBoundingClientRect();
    const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
    return {
      renderedRows: document.querySelectorAll("[data-queue-turn-id]").length,
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      row: { x: rowBox.x, y: rowBox.y, width: rowBox.width, height: rowBox.height },
      promptText: row.querySelector("p")?.textContent ?? null,
      promptVisibleWidth: row.querySelector("p")?.getBoundingClientRect().width ?? null,
      actions: buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label"),
          text: button.textContent,
          width: box.width,
          height: box.height,
          visible: box.width > 0 && box.height > 0,
        };
      }),
    };
  });
}

async function inspectDisclosedActions() {
  return await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("[data-queue-turn-id]");
    if (!row) throw new Error("queue row missing");
    return [...row.querySelectorAll<HTMLButtonElement>("button")].map((button) => {
      const box = button.getBoundingClientRect();
      return {
        label: button.getAttribute("aria-label"),
        text: button.textContent,
        width: box.width,
        height: box.height,
        inViewport: box.x >= 0 && box.right <= innerWidth,
      };
    });
  });
}

async function hitAt(box: { x: number; y: number; width: number; height: number }) {
  return await page.evaluate(
    ({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      const button = target?.closest<HTMLButtonElement>("button");
      return button ? { label: button.getAttribute("aria-label"), text: button.textContent } : null;
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}
