// When a page's document is gone while the page itself lives on.

import type { WebContents } from "electron";

/** Chromium's code for a navigation that was cancelled before it replaced the document. */
const ERR_ABORTED = -3;

/**
 * Call `left` whenever the page's main frame leaves its document without the
 * page closing: a committed navigation to another document, a failed one that
 * shows an error page instead (Chromium emits no `did-navigate` for those), or
 * a renderer that crashed or was killed. A navigation that only starts, such as
 * a link the app opens in the browser, a 204 response or a download, leaves the
 * document as it was, so `did-start-navigation` is not a sign of leaving.
 * Closing is the caller's `destroyed` listener.
 */
export function onPageLeft(page: Pick<WebContents, "on">, left: () => void): void {
  // Main-frame cross-document commits only; those within the page are
  // `did-navigate-in-page`.
  page.on("did-navigate", () => left());
  page.on("did-fail-provisional-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== ERR_ABORTED) left();
  });
  page.on("render-process-gone", () => left());
}
