import {
  createBrowserConnectNavigation,
  reserveBrowserConnectNavigation,
  type ConnectBrowserWindow,
  type ConnectNavigation,
} from "@opengeni/connect";

/**
 * Where a connect card opens the provider's sign-in. A browser reserves its
 * popup inside the person's click; a phone opens the system sign-in browser.
 * The card never treats the window as proof: it follows the attempt's durable
 * state, so the window only has to say when it has closed.
 */
export type ConnectWindowHost = {
  /**
   * Called synchronously from the person's tap, before any network work. The
   * caller closes the reservation if setup ends before navigating.
   */
  reserve(): { navigation: ConnectNavigation; close(): void };
  /** A sign-in window for an attempt that already waits for authorization. */
  open(): ConnectNavigation;
  /**
   * Where a card remembers its unfinished attempt, so it can pick the attempt
   * up again after the page reloads or the app restarts. Defaults to the
   * browser's session storage.
   */
  hints?: ConnectAttemptHints | undefined;
};

/**
 * An opaque recovery hint per card: the attempt ID only, never a credential.
 * The server rechecks the signed-in owner when the attempt is recovered.
 */
export type ConnectAttemptHints = {
  read(key: string): string | null;
  remember(key: string, attemptId: string): void;
  forget(key: string): void;
};

/** The browser's popup windows (`window` from the host page). */
export function browserConnectWindowHost(browser: ConnectBrowserWindow): ConnectWindowHost {
  return {
    reserve: () => reserveBrowserConnectNavigation(browser),
    open: () => createBrowserConnectNavigation(browser),
  };
}

/** An opaque recovery hint after a reload or full-page redirect; the server
 * rechecks the authenticated owner on recover. Storage may be disabled. */
export const attemptHint: ConnectAttemptHints = {
  read(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  remember(key: string, attemptId: string): void {
    try {
      sessionStorage.setItem(key, attemptId);
    } catch {
      /* Recovery hint only. */
    }
  },
  forget(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Recovery hint only. */
    }
  },
};
