// Browser check for the session header over the real component: every chat's
// header is one row of the same height, whether or not the chat has an
// automation, a Site or a parent chat, from desktop down to a small phone at
// 200% zoom. Nothing wraps: a child chat's way back is a small line above
// its title, and parts with no room move into the "…" menu, where they still
// work. The automation chip sits on the title's row and explains itself on
// hover.
// Run with:
//   bun apps/web/test/session-header-layout.browser.ts
// OPENGENI_SESSION_HEADER_PREVIEW_URL reuses a preview server that is already
// running (bunx vite --config test/session-sidebar-preview.vite.config.ts).
// OPENGENI_SESSION_HEADER_PREVIEW_OUTPUT saves a screenshot of each width there.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, type Page } from "playwright/test";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

const reuse = process.env.OPENGENI_SESSION_HEADER_PREVIEW_URL;
const port = reuse ? 0 : await freePort();
const base = reuse ?? `http://127.0.0.1:${port}`;
const previewPath = "/test/session-schedule-header-preview.html";
const web = reuse
  ? null
  : await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--config",
        "test/session-sidebar-preview.vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        ready: async () => (await fetch(`${base}${previewPath}`).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
const output = process.env.OPENGENI_SESSION_HEADER_PREVIEW_OUTPUT;
if (output) await mkdir(output, { recursive: true });

type HeaderBox = {
  state: string;
  height: number;
  overflow: boolean;
  titleCenter: number | null;
  /** The title's width; the row never squeezes it below a readable width. */
  titleWidth: number;
  /** The title's untruncated width, for short titles. */
  titleNaturalWidth: number;
  /** Whether the title is cut short with an ellipsis. */
  titleCut: boolean;
  /** Header controls that stick out of the header. */
  outsideControls: string[];
  chipCenter: number | null;
  chipWidth: number | null;
  chipText: string | null;
  chipName: string | null;
  crumbCenter: number | null;
  /** The visible parent link's width; a crowded header must never squeeze it to nothing. */
  crumbWidth: number | null;
  /** Whether the menu of earlier sessions is showing. */
  earlierShown: boolean;
  /** Unused width on the title's row. */
  rowFree: number;
};

async function measure(page: Page): Promise<HeaderBox[]> {
  return page.$$eval("section[data-header-state]", (sections) =>
    sections.map((section) => {
      const header = section.querySelector<HTMLElement>("header[data-titlebar]")!;
      const center = (element: Element | null) => {
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return box.height > 0 ? box.top + box.height / 2 : null;
      };
      const chip = header.querySelector<HTMLElement>("[data-automation-wait]");
      const crumb = header.querySelector('nav[aria-label="Session ancestry"] a');
      const visibleCrumb = [
        ...header.querySelectorAll('nav[aria-label="Session ancestry"] a'),
      ].find((link) => link.getBoundingClientRect().height > 0);
      const earlier = header.querySelector<HTMLElement>(
        'nav[aria-label="Session ancestry"] button[aria-label$="earlier sessions"]',
      );
      const headerBox = header.getBoundingClientRect();
      const title = header.querySelector("button[title$='click to rename']");
      return {
        state: section.getAttribute("data-header-state")!,
        height: header.getBoundingClientRect().height,
        overflow: header.scrollWidth > header.clientWidth + 1,
        titleCenter: center(title),
        titleWidth: title?.getBoundingClientRect().width ?? 0,
        titleNaturalWidth: title?.scrollWidth ?? 0,
        titleCut: Boolean(title && title.scrollWidth > title.clientWidth),
        outsideControls: [...header.querySelectorAll<HTMLElement>("button, a[href]")]
          .filter((control) => {
            const box = control.getBoundingClientRect();
            if (box.width === 0) return false;
            return box.left < headerBox.left - 0.5 || box.right > headerBox.right + 0.5;
          })
          .map((control) => control.getAttribute("aria-label") ?? control.innerText.trim()),
        chipCenter: center(chip),
        chipWidth: chip ? chip.getBoundingClientRect().width : null,
        chipText: chip?.innerText.trim() ?? null,
        chipName: chip?.getAttribute("aria-label") ?? null,
        crumbCenter: center(visibleCrumb ?? crumb),
        crumbWidth: visibleCrumb ? visibleCrumb.getBoundingClientRect().width : null,
        earlierShown: Boolean(earlier && earlier.getBoundingClientRect().width > 0),
        rowFree: (() => {
          const row = header.querySelector<HTMLElement>("[data-session-title-row]")!;
          const children = [...row.children].filter(
            (child) => getComputedStyle(child).display !== "none",
          );
          const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
          const used = children.reduce(
            (sum, child) => sum + child.getBoundingClientRect().width,
            gap * Math.max(0, children.length - 1),
          );
          return row.clientWidth - used;
        })(),
      };
    }),
  );
}

// `minTitle` is the narrowest the title may get (or its whole text when shorter).
const widths = [
  { name: "desktop", viewport: { width: 1280, height: 900 }, phone: false, minTitle: 80 },
  { name: "tablet", viewport: { width: 768, height: 900 }, phone: false, minTitle: 80 },
  { name: "phone", viewport: { width: 390, height: 844 }, phone: true, minTitle: 80 },
  // The smallest phones, with the access-key control too, and the same phone
  // at 200% zoom.
  { name: "small-phone", viewport: { width: 320, height: 740 }, phone: true, minTitle: 40 },
  { name: "zoomed-phone", viewport: { width: 160, height: 370 }, phone: true, minTitle: 32 },
] as const;

// Each optional part: how to find it in the row, and in the "…" menu when the
// row has no room for it.
const parts = {
  panel: { row: 'button[aria-label="Open workspace"]', menu: /^Open workspace/, role: "menuitem" },
  access: {
    row: 'section[aria-label="Session access"]',
    menu: /session access\. Manage session access$/,
    role: "button",
  },
  fullAccess: {
    row: "[data-session-admin-access]",
    menu: /^Turn off full access$/,
    role: "menuitem",
  },
  automations: {
    row: "[data-automation-wait]",
    menu: /Open this chat's automations\.$/,
    role: "menuitem",
  },
  site: {
    row: 'a[aria-label^="Created through"]',
    menu: /^Created through Intake portal/,
    role: "menuitem",
  },
  accessKey: {
    row: 'button[aria-label="Clear access key"]',
    menu: /^Clear access key$/,
    role: "menuitem",
  },
} as const;

/** Every part is in the row or in the "…" menu; returns the ones in the menu. */
async function partsInMenu(page: Page, state: string): Promise<string[]> {
  const section = page.locator(`section[data-header-state="${state}"]`);
  const header = section.locator("header[data-titlebar]");
  const expected = ((await section.getAttribute("data-header-parts")) ?? "")
    .split(" ")
    .filter(Boolean) as (keyof typeof parts)[];
  const moved: (keyof typeof parts)[] = [];
  for (const name of expected) {
    if (!(await header.locator(parts[name].row).first().isVisible())) moved.push(name);
  }
  if (moved.length === 0) return [];
  await header.getByRole("button", { name: "More session actions" }).click();
  const menu = page.getByRole("menu");
  for (const name of moved) {
    await expect(
      menu.getByRole(parts[name].role, { name: parts[name].menu }),
      `${state}: ${name} is in the menu`,
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return moved;
}

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(process.env.OPENGENI_TEST_CHROMIUM
    ? { executablePath: process.env.OPENGENI_TEST_CHROMIUM }
    : {}),
});
const errors: string[] = [];
try {
  for (const { name, viewport, phone, minTitle } of widths) {
    const page = await browser.newPage({ viewport, isMobile: phone, hasTouch: phone });
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    const keyAuth = viewport.width <= 320;
    await page.goto(`${base}${previewPath}?theme=light${keyAuth ? "&keyAuth=1" : ""}`);
    await expect(page.getByText("Watch the release checks")).toBeVisible();
    // Measure first: a full-page screenshot briefly changes a phone's
    // emulation (so phones capture only the screen), and the page is still
    // settling for a moment after it.
    const boxes = await measure(page);
    if (output) {
      await page.screenshot({ path: path.join(output, `header-${name}.png`), fullPage: !phone });
      await page
        .locator('section[data-header-state="Deep child, paused by its manager"]')
        .screenshot({ path: path.join(output, `header-deep-${name}.png`) });
    }
    for (const box of boxes) {
      expect(box.overflow, `${name} ${box.state} overflows`).toBe(false);
      expect(box.outsideControls, `${name} ${box.state} controls outside`).toEqual([]);
      expect(box.titleCenter, `${name} ${box.state} title`).not.toBeNull();
      expect(box.titleWidth, `${name} ${box.state} title width`).toBeGreaterThanOrEqual(
        Math.min(minTitle, box.titleNaturalWidth),
      );
    }
    const heights = new Set(boxes.map((box) => Math.round(box.height)));
    // One row of one height for every chat: an automation, a Site or a parent
    // never adds a row, and nothing wraps.
    expect([...heights], `${name} header heights ${JSON.stringify(boxes)}`).toHaveLength(1);
    expect([...heights][0]!, `${name} header height`).toBeLessThanOrEqual(60);
    const moved: Record<string, string[]> = {};
    for (const box of boxes) {
      const inMenu = await partsInMenu(page, box.state);
      if (inMenu.length > 0) {
        moved[box.state] = inMenu;
        // The automation chip's words give way first, so the chip leaves the
        // row only when even its icon would squeeze the title.
        if (inMenu.includes("automations")) {
          expect(
            box.titleCut || box.rowFree < 60,
            `${name} ${box.state}: the automation chip is in the menu with room to spare (${box.rowFree}px)`,
          ).toBe(true);
        }
      }
      if (box.chipCenter !== null) {
        // The chip's words give way before the title loses a letter.
        if (box.titleCut) {
          expect(
            box.chipWidth!,
            `${name} ${box.state}: chip beside a cut title`,
          ).toBeLessThanOrEqual(48);
        }
        expect(
          Math.abs(box.chipCenter - box.titleCenter!),
          `${name} ${box.state}: the chip is on the title's row`,
        ).toBeLessThanOrEqual(2);
        // The chip always names the full wait for assistive technology.
        expect(box.chipName, `${name} ${box.state} chip name`).toMatch(
          /Open this chat's automations\.$/,
        );
      }
      if (box.crumbCenter !== null) {
        // The way back is a small line above the title, not beside it.
        expect(
          box.titleCenter! - box.crumbCenter,
          `${name} ${box.state}: the parent link is above the title`,
        ).toBeGreaterThanOrEqual(8);
      }
    }
    console.log(`${name}: in the "…" menu ${JSON.stringify(moved)}`);
    if (name === "desktop") {
      // Shrinking the window moves parts into the menu; growing it again
      // brings every one of them back.
      await page.setViewportSize({ width: 300, height: viewport.height });
      await expect
        .poll(async () => (await partsInMenu(page, "Deep child, paused by its manager")).length)
        .toBeGreaterThan(0);
      await page.setViewportSize(viewport);
      for (const box of boxes) {
        await expect
          .poll(async () => await partsInMenu(page, box.state), `${box.state} after resizing`)
          .toEqual([]);
      }
    }
    if (name === "small-phone") {
      // What moved into the menu works as it does in the row: the access
      // chip opens its own menu, and full access changes its time limit.
      const header = page
        .locator('section[data-header-state="No automation"]')
        .locator("header[data-titlebar]");
      const more = header.getByRole("button", { name: "More session actions" });
      await more.click();
      await page.getByRole("button", { name: /Manage session access$/ }).click();
      await expect(page.getByText("Workspace session", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await more.click();
      await page.getByRole("menuitem", { name: "Change time limit…" }).click();
      await expect(page.getByRole("dialog", { name: "Change the time limit" })).toBeVisible();
      if (output) await page.screenshot({ path: path.join(output, `header-menu-${name}.png`) });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    const mail = boxes.find((box) => box.state === "Waiting for new mail")!;
    // A deeply nested chat on a crowded row (a paused workstream, long titles)
    // keeps its way back to the parent: the parent's name, with the earlier
    // sessions' menu on wider screens.
    const deep = boxes.find((box) => box.state === "Deep child, paused by its manager")!;
    expect(deep.crumbWidth, `${name} deep parent link`).not.toBeNull();
    expect(deep.crumbWidth!, `${name} deep parent link width`).toBeGreaterThanOrEqual(40);
    if (name === "desktop") {
      expect(deep.earlierShown, "desktop shows the earlier sessions' menu").toBe(true);
    }
    if (mail.chipName !== null) {
      expect(mail.chipName).toBe(
        "Waiting for message.received from Gmail (ada@acme.dev). Open this chat's automations.",
      );
    }
    if (name === "desktop") {
      expect(mail.chipText).toBe("Waiting on Gmail (ada@acme.dev)");
      // Hovering the chip explains each wait on its own line.
      const chip = page
        .locator('section[data-header-state="Waiting for new mail"]')
        .locator("[data-automation-wait]");
      await chip.hover();
      const card = page.locator("[data-automation-wait-details]");
      await expect(card).toBeVisible();
      await expect(card).toContainText("message.received from Gmail (ada@acme.dev)");
      await expect(card).toContainText("This chat's automations");
      await expect(card).toContainText("Click to see or change them");
      if (output) await page.screenshot({ path: path.join(output, `header-hover-${name}.png`) });
      await page.mouse.move(viewport.width - 10, viewport.height - 10);
      const both = page
        .locator('section[data-header-state="Two automations waiting on different apps"]')
        .locator("[data-automation-wait]");
      await both.hover();
      await expect(card).toContainText("app_mention or message from Acme Slack");
      await expect(card).toContainText("message.received from Gmail (ada@acme.dev)");
    }
    if (phone && mail.chipText !== null) {
      // On a phone the chip is its icon alone; its name still says everything.
      expect(mail.chipText).toBe("");
    }
    await page.close();
  }
} finally {
  await browser.close();
  await web?.stop();
}
if (errors.length > 0) throw new Error(errors.join("\n"));
console.log("session header layout: ok");
