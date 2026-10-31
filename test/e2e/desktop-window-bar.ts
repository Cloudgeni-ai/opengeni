import { expect } from "bun:test";
import type { BrowserContext, Page } from "playwright";
import { DESKTOP_MAC_TRAFFIC_LIGHT_SIZE } from "@opengeni/sdk/desktop-bridge";

import { MAC_TRAFFIC_LIGHT_POSITION } from "../../packages/desktop/src/main/window-bar";

/**
 * The desktop window bar: on macOS and Windows a strip across the top of the
 * window holds the window controls (the macOS traffic lights or the wider
 * sharing badge, the Windows caption buttons) and the page starts below it.
 */
export const WINDOW_BAR_HEIGHT = 44;

/**
 * Where the macOS app's own bar controls (the sidebar toggle) start: right of
 * the traffic lights and of the wider badge macOS swaps in for them while the
 * window is shared or recorded.
 */
export const MACOS_BAR_CONTROLS_LEFT = 84;

/**
 * Where a chat's header may start when it is the macOS window bar's row: past
 * the sidebar toggle (84px + 32px) with a small gap.
 */
export const MACOS_BAR_ROW_LEFT = 120;

/** Where the macOS app puts the traffic lights, in window points. */
export { MAC_TRAFFIC_LIGHT_POSITION };

/**
 * Where macOS shells that don't report their window bar's height (the
 * desktop app 0.1.33 and older) put the traffic lights.
 */
export const LEGACY_MAC_TRAFFIC_LIGHT_POSITION = { x: 18, y: 21 };

/** The traffic lights' vertical centre, in window points. */
export function trafficLightCentre(position: { y: number }): number {
  return position.y + DESKTOP_MAC_TRAFFIC_LIGHT_SIZE / 2;
}

/**
 * A plain browser has no Windows window controls overlay, so stand in for the
 * 44px title bar area the desktop shell asks for. Call before the page loads.
 */
export async function simulateWindowsTitleBar(target: Page | BrowserContext) {
  await target.addInitScript((height) => {
    // Init scripts can run before the parser creates <html>.
    const apply = () => {
      document.documentElement?.style.setProperty("--og-window-bar-height", `${height}px`);
      return document.documentElement != null;
    };
    if (!apply()) {
      new MutationObserver((_, observer) => {
        if (apply()) observer.disconnect();
      }).observe(document, { childList: true });
    }
  }, WINDOW_BAR_HEIGHT);
}

/**
 * What the page draws in the window's top `WINDOW_BAR_HEIGHT` pixels, under
 * the window controls, with the bar itself hidden: hit-tests a grid across the
 * strip and lists every element found there other than the page's own
 * background (html, body) and the controls placed in the bar on purpose
 * (`[data-window-bar-controls]`, checked by `windowBarControls`, and with
 * `barRow` a chat's header that is the bar's row, checked by `windowBarRow`).
 * Empty when the page starts below the bar.
 */
export async function contentUnderWindowBar(
  page: Page,
  { barRow = false }: { barRow?: boolean } = {},
): Promise<string[]> {
  return page.evaluate(
    ({ height, skipRow }) => {
      const hide = document.createElement("style");
      hide.textContent = "html::before { display: none !important; }";
      document.head.append(hide);
      try {
        const found = new Set<string>();
        for (let x = 1; x < innerWidth; x += 4) {
          for (const y of [1, height / 2, height - 1]) {
            const element = document.elementFromPoint(x, y);
            if (!element || element === document.documentElement || element === document.body) {
              continue;
            }
            if (element.closest("[data-window-bar-controls]")) continue;
            if (skipRow && element.closest("[data-window-bar-row] > [data-titlebar]")) continue;
            // A modal dialog's ::backdrop hit-tests as the dialog itself: only
            // count what is drawn at the point by the element's own box.
            const box = element.getBoundingClientRect();
            if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) continue;
            const label = (element.getAttribute("aria-label") ?? element.textContent ?? "")
              .trim()
              .slice(0, 40);
            found.add(
              `${element.tagName.toLowerCase()} "${label}" at ${Math.round(x)},${Math.round(y)}`,
            );
            if (found.size >= 12) return [...found];
          }
        }
        return [...found];
      } finally {
        hide.remove();
      }
    },
    { height: WINDOW_BAR_HEIGHT, skipRow: barRow },
  );
}

/**
 * A chat's header when it is the macOS window bar's row, or null: its box,
 * drag behaviour, and each shown button with its drag behaviour and whether
 * a click at its centre reaches it (nothing, the bar included, is on top).
 */
export async function windowBarRow(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>("[data-window-bar-row] > [data-titlebar]");
    if (!header) return null;
    const box = header.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      bottom: box.bottom,
      drag: getComputedStyle(header).getPropertyValue("-webkit-app-region"),
      // While a full-window layer is open the row must step aside.
      layerOpen: document.documentElement.hasAttribute("data-window-layer-open"),
      shown: header.getClientRects().length > 0,
      buttons: [...header.querySelectorAll<HTMLElement>("button")]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return {
            label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
            left: rect.left,
            top: rect.top,
            bottom: rect.bottom,
            clickable: hit != null && button.contains(hit),
            drag: getComputedStyle(button).getPropertyValue("-webkit-app-region"),
          };
        }),
    };
  });
}

/**
 * The controls the page places in the window bar, with their boxes, drag
 * behaviour and whether they are shown (a full-window layer hides them).
 */
export async function windowBarControls(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-window-bar-controls]")].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        visible: element.getClientRects().length > 0,
        left: box.left,
        top: box.top,
        bottom: box.bottom,
        drag: getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        buttons: [...element.querySelectorAll("button")].map(
          (button) => button.getAttribute("aria-label") ?? "",
        ),
      };
    }),
  );
}

/** The window bar's height, colour and drag behaviour, or null when there is none. */
export async function windowBar(page: Page) {
  return page.evaluate(() => {
    const bar = getComputedStyle(document.documentElement, "::before");
    if (bar.content === "none" || bar.display === "none") return null;
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--og-color-bg)";
    document.body.append(probe);
    const appBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      top: parseFloat(bar.top),
      height: parseFloat(bar.height),
      position: bar.position,
      drag: bar.getPropertyValue("-webkit-app-region"),
      background: bar.backgroundColor,
      appBackground,
      rootTop: document.getElementById("root")?.getBoundingClientRect().top ?? null,
    };
  });
}

/**
 * Asserts the platform's top edge: on macOS and Windows a draggable bar holds
 * the window controls and nothing of the page sits under it; elsewhere there
 * is no bar and the page starts at the top of the window. Only the macOS app
 * puts controls of its own in the bar (the sidebar toggle, and on a chat the
 * chat's header as the bar's row), right of the traffic lights; its buttons
 * are not draggable and take clicks, and the header's empty space drags.
 */
export async function expectWindowTop(page: Page, platform: string) {
  const bar = await windowBar(page);
  const controls = await windowBarControls(page);
  const row = platform === "macos" ? await windowBarRow(page) : null;
  if (platform === "macos" || platform === "windows") {
    expect(bar).toMatchObject({
      top: 0,
      height: WINDOW_BAR_HEIGHT,
      position: "fixed",
      drag: "drag",
    });
    expect(await contentUnderWindowBar(page, { barRow: row != null })).toEqual([]);
  } else {
    expect(bar).toBeNull();
  }
  if (platform === "macos") {
    for (const control of controls.filter((each) => each.visible)) {
      expect(control.left).toBeGreaterThanOrEqual(MACOS_BAR_CONTROLS_LEFT);
      expect(control.top).toBeGreaterThanOrEqual(0);
      expect(control.bottom).toBeLessThanOrEqual(WINDOW_BAR_HEIGHT);
      expect(control.drag).toBe("no-drag");
    }
    if (row?.layerOpen) {
      // Under a full-window layer the header is not drawn, so none of its
      // buttons can be clicked or focused.
      expect(row.shown).toBe(false);
      expect(row.buttons).toEqual([]);
    } else if (row) {
      expect(row.shown).toBe(true);
      expect(row.left).toBeGreaterThanOrEqual(
        controls.some((control) => control.visible) ? MACOS_BAR_ROW_LEFT : MACOS_BAR_CONTROLS_LEFT,
      );
      expect(row.top).toBe(0);
      expect(row.drag).toBe("drag");
      expect(row.buttons.length).toBeGreaterThan(0);
      for (const button of row.buttons) {
        expect(button.drag).toBe("no-drag");
        expect({ label: button.label, clickable: button.clickable }).toEqual({
          label: button.label,
          clickable: true,
        });
        expect(button.top).toBeGreaterThanOrEqual(0);
        expect(button.bottom).toBeLessThanOrEqual(WINDOW_BAR_HEIGHT);
      }
    }
  } else {
    expect(controls).toEqual([]);
  }
}
