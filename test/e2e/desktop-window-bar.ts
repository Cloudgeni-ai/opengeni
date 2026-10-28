import { expect } from "bun:test";
import type { BrowserContext, Page } from "playwright";

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
 * (`[data-window-bar-controls]`, checked by `windowBarControls`). Empty when
 * the page starts below the bar.
 */
export async function contentUnderWindowBar(page: Page): Promise<string[]> {
  return page.evaluate((height) => {
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
  }, WINDOW_BAR_HEIGHT);
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
 * puts controls of its own in the bar, right of the traffic lights and not
 * draggable, so they stay clickable.
 */
export async function expectWindowTop(page: Page, platform: string) {
  const bar = await windowBar(page);
  const controls = await windowBarControls(page);
  if (platform === "macos" || platform === "windows") {
    expect(bar).toMatchObject({
      top: 0,
      height: WINDOW_BAR_HEIGHT,
      position: "fixed",
      drag: "drag",
    });
    expect(await contentUnderWindowBar(page)).toEqual([]);
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
  } else {
    expect(controls).toEqual([]);
  }
}
