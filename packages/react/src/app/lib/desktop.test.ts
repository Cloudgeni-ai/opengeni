import { expect, test } from "bun:test";

import {
  desktopAppVersionFromUserAgent,
  desktopPlatformFromUserAgent,
  desktopPlatformIn,
  OPENED_WINDOW_NAME,
  type DesktopWindowView,
} from "./desktop";

const chrome = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.149";

test("the Opengeni desktop app's user agent names its platform", () => {
  expect(
    desktopPlatformFromUserAgent(
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${chrome.replace("Chrome", "Opengeni/0.1.32 Chrome")} Electron/44.7.2 Safari/537.36`,
    ),
  ).toBe("macos");
  expect(
    desktopPlatformFromUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${chrome.replace("Chrome", "Opengeni/0.1.32 Chrome")} Electron/44.7.2 Safari/537.36`,
    ),
  ).toBe("windows");
  expect(
    desktopPlatformFromUserAgent(
      `Mozilla/5.0 (X11; Linux x86_64) ${chrome.replace("Chrome", "Opengeni/0.1.32 Chrome")} Electron/44.7.2 Safari/537.36`,
    ),
  ).toBe("linux");
});

test("browsers and other Electron apps are not the desktop app", () => {
  for (const userAgent of [
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${chrome} Safari/537.36`,
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${chrome} Safari/537.36 Edg/152.0.0.0`,
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${chrome.replace("Chrome", "Slack/4.47.0 Chrome")} Electron/44.7.2 Safari/537.36`,
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Opengeni/1.4.0",
    "",
  ]) {
    expect(desktopPlatformFromUserAgent(userAgent)).toBeNull();
    expect(desktopAppVersionFromUserAgent(userAgent)).toBeNull();
  }
});

test("the Opengeni desktop app's user agent names its version", () => {
  expect(
    desktopAppVersionFromUserAgent(
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${chrome.replace("Chrome", "Opengeni/0.1.32 Chrome")} Electron/44.7.2 Safari/537.36`,
    ),
  ).toBe("0.1.32");
  expect(
    desktopAppVersionFromUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${chrome.replace("Chrome", "Opengeni/1.2.0-beta.3 Chrome")} Electron/44.7.2 Safari/537.36`,
    ),
  ).toBe("1.2.0-beta.3");
});

test("only the app's own top-level window takes the platform from the user agent", () => {
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${chrome.replace("Chrome", "Opengeni/0.1.32 Chrome")} Electron/44.7.2 Safari/537.36`;
  const view = (overrides: Partial<DesktopWindowView> = {}): DesktopWindowView => {
    const own: DesktopWindowView = { opener: null, top: null, name: "", navigator: { userAgent } };
    own.top = own;
    return Object.assign(own, overrides);
  };
  expect(desktopPlatformIn(null, view())).toBe("macos");
  // A window the page opened: with its opener, or opened by `openBlankTab`,
  // which drops the opener and names the window instead.
  expect(desktopPlatformIn(null, view({ opener: {} }))).toBeNull();
  expect(desktopPlatformIn(null, view({ name: OPENED_WINDOW_NAME }))).toBeNull();
  // A page in a frame.
  expect(desktopPlatformIn(null, view({ top: {} }))).toBeNull();
  // The bridge decides wherever it reaches.
  const bridge = { version: 1, platform: "windows" } as never;
  expect(desktopPlatformIn(bridge, view({ name: OPENED_WINDOW_NAME }))).toBe("windows");
});
