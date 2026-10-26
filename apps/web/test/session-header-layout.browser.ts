// Browser check for the session header over the real component: every chat's
// header is one row of the same height, whether or not the chat has an
// automation or a parent chat, at desktop, tablet and phone widths. The
// automation chip sits on the title's row and explains itself on hover.
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
  chipCenter: number | null;
  chipText: string | null;
  chipName: string | null;
  crumbCenter: number | null;
  /** The visible parent link's width; a crowded row must never squeeze it to nothing. */
  crumbWidth: number | null;
  /** Whether the menu of earlier sessions is showing. */
  earlierShown: boolean;
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
      return {
        state: section.getAttribute("data-header-state")!,
        height: header.getBoundingClientRect().height,
        overflow: header.scrollWidth > header.clientWidth + 1,
        titleCenter: center(header.querySelector("button[title$='click to rename']")),
        chipCenter: center(chip),
        chipText: chip?.innerText.trim() ?? null,
        chipName: chip?.getAttribute("aria-label") ?? null,
        crumbCenter: center(visibleCrumb ?? crumb),
        crumbWidth: visibleCrumb ? visibleCrumb.getBoundingClientRect().width : null,
        earlierShown: Boolean(earlier && earlier.getBoundingClientRect().width > 0),
      };
    }),
  );
}

const widths = [
  { name: "desktop", viewport: { width: 1280, height: 900 }, phone: false },
  { name: "tablet", viewport: { width: 768, height: 900 }, phone: false },
  { name: "phone", viewport: { width: 390, height: 844 }, phone: true },
] as const;

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(process.env.OPENGENI_TEST_CHROMIUM
    ? { executablePath: process.env.OPENGENI_TEST_CHROMIUM }
    : {}),
});
const errors: string[] = [];
try {
  for (const { name, viewport, phone } of widths) {
    const page = await browser.newPage({ viewport, isMobile: phone, hasTouch: phone });
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    await page.goto(`${base}${previewPath}?theme=light`);
    await expect(page.getByText("Watch the release checks")).toBeVisible();
    if (output) {
      await page.screenshot({ path: path.join(output, `header-${name}.png`), fullPage: true });
      await page
        .locator('section[data-header-state="Deep child, paused by its manager"]')
        .screenshot({ path: path.join(output, `header-deep-${name}.png`) });
    }
    const boxes = await measure(page);
    const heights = new Set(boxes.map((box) => Math.round(box.height)));
    // One height for every chat: an automation or a parent never adds a row.
    expect([...heights], `${name} header heights ${JSON.stringify(boxes)}`).toHaveLength(1);
    for (const box of boxes) {
      expect(box.overflow, `${name} ${box.state} overflows`).toBe(false);
      expect(box.titleCenter, `${name} ${box.state} title`).not.toBeNull();
      if (box.chipCenter !== null) {
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
        expect(
          Math.abs(box.crumbCenter - box.titleCenter!),
          `${name} ${box.state}: the parent link is on the title's row`,
        ).toBeLessThanOrEqual(2);
      }
    }
    const mail = boxes.find((box) => box.state === "Waiting for new mail")!;
    // A deeply nested chat on a crowded row (a paused workstream, long titles)
    // keeps its way back to the parent: the parent's name with the earlier
    // sessions' menu where there is room, else the arrow, never nothing.
    const deep = boxes.find((box) => box.state === "Deep child, paused by its manager")!;
    expect(deep.crumbWidth, `${name} deep parent link`).not.toBeNull();
    expect(deep.crumbWidth!, `${name} deep parent link width`).toBeGreaterThanOrEqual(24);
    if (name === "desktop") {
      expect(deep.earlierShown, "desktop shows the earlier sessions' menu").toBe(true);
      expect(deep.crumbWidth!, "desktop shows the parent's name").toBeGreaterThanOrEqual(40);
    }
    expect(mail.chipName).toBe(
      "Waiting for message.received from Gmail (ada@acme.dev). Open this chat's automations.",
    );
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
    if (phone) {
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
