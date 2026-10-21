// Whether an account's web app actually loaded, from the view's main-frame
// events. Pure, so the rules are testable without Electron.

/** Chromium's code for a load the page itself replaced or cancelled. */
const ERR_ABORTED = -3;

export type LoadOutcome = { kind: "failed"; url: string } | { kind: "loaded" };

/**
 * Follows one view's main frame. A network failure (no connection, DNS,
 * refused, timeout) or a server error page from a proxy (5xx) both mean the
 * web app isn't there; anything else is the web app's own to handle.
 */
export class MainFrameLoad {
  private failed = false;
  private status = 0;
  private url = "";

  /** `did-navigate`: a real page committed (Chromium's own error pages don't emit it). */
  navigated(url: string, httpResponseCode: number): void {
    this.failed = false;
    this.status = httpResponseCode;
    this.url = url;
  }

  /** `did-fail-load`. */
  failedToLoad(errorCode: number, url: string, isMainFrame: boolean): LoadOutcome | null {
    if (!isMainFrame || errorCode === ERR_ABORTED) return null;
    this.failed = true;
    return { kind: "failed", url };
  }

  /** `did-finish-load`, which also follows Chromium's error page. */
  finished(): LoadOutcome | null {
    if (this.failed) return null;
    if (this.status >= 500) return { kind: "failed", url: this.url };
    return { kind: "loaded" };
  }
}

const RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 30_000];

/** How long to wait before the next automatic try: quick at first, then every 30 seconds. */
export function retryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index] ?? 30_000;
}
