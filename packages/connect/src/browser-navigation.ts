import type { ConnectNavigation } from "./authorization";

/** Structural browser surface so importing Connect never reads DOM globals. */
export type ConnectBrowserWindow = {
  open(
    url: string,
    target: string,
    features: string,
  ): {
    opener: unknown;
    readonly closed?: boolean;
    location: { replace(url: string): void };
    close(): void;
  } | null;
  location: { assign(url: string): void };
};

function validateDestination(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Connect authorization requires an HTTPS destination without credentials");
}

function closeIsolatedPopup(popup: NonNullable<ReturnType<ConnectBrowserWindow["open"]>>): void {
  try {
    if (popup.closed) return;
    // After opener isolation, browsers cannot close a foreign-origin window.
    // Check access first to avoid a futile close and its browser warning.
    Reflect.get(popup.location, "href");
    popup.close();
  } catch {
    /* The human closes foreign-origin or detached provider windows. */
  }
}

/** Reserve the isolated window during the human's click, before asynchronous
 * discovery. The caller must close it if setup fails before navigation. */
export function reserveBrowserConnectNavigation(browser: ConnectBrowserWindow): {
  navigation: ConnectNavigation;
  close(): void;
} {
  const popup = browser.open("about:blank", "_blank", "popup,width=520,height=720");
  if (!popup) throw new Error("Allow popups to connect your account, then try again.");
  try {
    popup.opener = null;
    if (popup.opener !== null) throw new Error("Connect popup isolation failed");
  } catch {
    closeIsolatedPopup(popup);
    throw new Error("Connect popup could not open safely. Please try again.");
  }
  const close = () => closeIsolatedPopup(popup);
  return {
    close,
    navigation: {
      openPopup(url) {
        validateDestination(url);
        popup.location.replace(url);
        return {
          close,
          // Browser COOP can sever this WindowProxy and report closed while
          // the provider window is still open. Keep polling durable completion;
          // the host's Stop control and bounded timeout end observation.
        };
      },
      redirect(url) {
        validateDestination(url);
        close();
        browser.location.assign(url);
      },
    },
  };
}

/** Pass window from the host's browser entry point. Opens a fresh blank window
 * synchronously and severs its opener BEFORE any provider content can load.
 * Never uses a reusable named target or relies on provider window messages.
 * The caller retains only best-effort close capability for polling cleanup;
 * the human closes provider windows that remain on a foreign origin. */
export function createBrowserConnectNavigation(browser: ConnectBrowserWindow): ConnectNavigation {
  return {
    openPopup(url) {
      validateDestination(url);
      const popup = browser.open("about:blank", "_blank", "popup,width=520,height=720");
      if (!popup) return null;
      try {
        popup.opener = null;
        if (popup.opener !== null) throw new Error("Connect popup isolation failed");
        popup.location.replace(url);
      } catch {
        closeIsolatedPopup(popup);
        throw new Error("Connect popup could not navigate safely; retry with redirect mode");
      }
      return {
        close: () => closeIsolatedPopup(popup),
        // WindowProxy.closed is not a reliable user-cancellation signal after
        // a provider moves the popup into a different browsing context group.
      };
    },
    redirect(url) {
      validateDestination(url);
      browser.location.assign(url);
    },
  };
}
